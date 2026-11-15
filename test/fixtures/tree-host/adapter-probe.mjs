import assert from 'node:assert/strict';
import { load } from './support.mjs';

export async function probeAdapter(t) {
  const { DeepSeekAdapter, resolveAdapterOptions } = await load('@deepseek-ai/dsh-llm-deepseek');
  const { createUserMessage } = await load('@deepseek-ai/dsh-llm');
  const serialized = [];
  // No HTTP server, socket or credential resolver is used. This boundary
  // captures the real serializer's fetch input and returns synthetic SSE.
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://b0.invalid/anthropic/v1/messages');
    const body = JSON.parse(init.body); serialized.push(body);
    const event = (type, rest) => `event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`;
    return new Response(event('message_start', { message: { id: 'synthetic-b0', model: 'deepseek-flash', role: 'assistant', content: [], usage: { input_tokens: 4, output_tokens: 0 } } }) +
      event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '{"ok":true}' } }) +
      event('content_block_stop', { index: 0 }) +
      event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 4, output_tokens: 3 } }) +
      event('message_stop', {}), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  try {
    const adapter = new DeepSeekAdapter({ options: () => resolveAdapterOptions({ baseURL: 'https://b0.invalid/anthropic', maxTokens: 128 }),
      resolveAuth: async () => ({ headers: {} }), resolveUserId: () => 'b0-synthetic',
      prepareExtensions: async () => ({ fields: {}, accept() {} }) });
    const model = await adapter.resolveModel('deepseek', 'deepseek-flash');
    assert.equal(model.id, 'deepseek-flash');
    const outputs = [];
    for (const effort of ['off', 'low', 'high', 'max']) {
      const output = [];
      for await (const chunk of adapter.stream({ provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: effort,
        maxTokens: 128, temperature: 0.2, messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'synthetic JSON only' }] })] })) output.push(chunk);
      const body = serialized.at(-1);
      assert.equal(body.model, 'deepseek-flash'); assert.equal(body.max_tokens, 128); assert.equal(body.temperature, 0.2);
      assert.deepEqual(body.thinking, { type: effort === 'off' ? 'disabled' : 'enabled' });
      assert.equal(body.output_config?.effort, effort === 'off' ? undefined : effort);
      assert.ok(output.some(c => c.type === 'finish')); outputs.push({ effort, output });
    }
    let rejected = false;
    try { for await (const _ of adapter.stream({ provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'unsupported', maxTokens: 128,
      messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'synthetic' }] })] })) {} }
    catch (error) { rejected = /UNSUPPORTED_REASONING_EFFORT|does not support reasoning effort/.test(JSON.stringify(error) + error.message); }
    assert.ok(rejected); assert.equal(serialized.length, 4);
    return { result: 'offline-adapter-pass', model, serialized, outputs,
      liveProviderReceipt: null, externalHttpRequests: 0, spentCny: 0,
      limitations: ['Synthetic SSE is not a real provider receipt.', 'Native Messages serializer has no response_format field; prompt JSON is not guaranteed JSON mode.',
        'G4 new-role owners and G5 real receipt remain unimplemented/unverified; no production authority was bypassed.'] };
  } finally { t.mock.restoreAll(); }
}
