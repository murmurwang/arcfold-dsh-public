import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment';
import { loadDesktopDeepSeekAdapter } from '../src/desktop/adapter.mjs';
import * as DesktopProvider from '../src/desktop/provider.mjs';

const model = 'deepseek-v4-pro';
const policy = { contextWindow: 1024, maxOutputTokens: 32, requestMaxTokens: 32,
  prices: { input: 9, output: 27, cachedInput: 0.3 }, priceVersion: 'synthetic', reasoningEfforts: ['off'] };
const event = (type, value) => `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
const response = event('message_start', { message: { id: 'synthetic', model, usage: { input_tokens: 3, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }) +
  event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
  event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'fixture' } }) +
  event('content_block_stop', { index: 0 }) +
  event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) + event('message_stop', {});
const collect = async stream => { const out = []; for await (const item of stream) out.push(item); return out; };

test('private Desktop adapter is the exact audited transport and exposes its seam', async () => {
  const adapter = await loadDesktopDeepSeekAdapter();
  assert.equal(adapter.registerDeepSeekProvider.transportSeam, 'deepseek-messages-create-transport-v1');
  assert.equal(typeof adapter.DeepSeekAdapter, 'function');
});

test('Desktop provider sends only through the provided metered sender and resolves the native credential', async t => {
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  let factories = 0, sends = 0, reads = 0;
  await ctx.plugin({ name: 'desktop-fixture-services', apply(child) {
    child.provide('credentials', { async resolve(ref) { reads++; assert.equal(ref, 'FIXTURE_KEY'); return { value: 'synthetic-fixture-key' }; } });
    child.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]));
    child.provide('arcfoldDeepSeekTransport', { configuration: { provider: 'deepseek-official', endpoint: 'https://api.deepseek.com/anthropic/v1/messages', modelPolicies: { [model]: policy } },
      createTransport(options) { factories++; assert.equal(options.sessionId, 'fixture-session'); return { async send(url, init) {
        sends++; assert.equal(new URL(url).hostname, 'api.deepseek.com'); assert.equal(JSON.parse(init.body).model, model);
        assert.equal(init.headers['x-api-key'], 'synthetic-fixture-key');
        return new Response(response, { status: 200, headers: { 'content-type': 'text/event-stream', 'x-request-id': 'synthetic' } });
      } }; } });
  } });
  await ctx.plugin(LlmRuntime);
  const fiber = await ctx.plugin(DesktopProvider, { apiKeyRef: 'FIXTURE_KEY', maxTokens: 32, reasoningEffort: 'off' });
  await fiber.await();
  assert.equal(fiber.state, 2);
  const call = await ctx.llm.prepareCall({ provider: 'deepseek-official', model, reasoningEffort: 'off', maxTokens: 32 });
  const chunks = await collect(call.stream({ ...call.config, sessionId: 'fixture-session', messages: [{ id: 'message-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'synthetic input' }] }], tools: [] }));
  assert.equal(factories, 1); assert.equal(sends, 1); assert.equal(reads, 1);
  assert.equal(chunks.at(-1).reason.kind, 'stop');
});

test('Desktop provider refuses absent accounting service and unsupported policy', async t => {
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  await ctx.plugin(LlmRuntime);
  await ctx.plugin({ name: 'desktop-fixture-empty', apply(child) {
    child.provide('credentials', { resolve: async () => null });
    child.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]));
    child.provide('arcfoldDeepSeekTransport', { configuration: { provider: 'other', modelPolicies: {} } });
  } });
  await assert.rejects(() => DesktopProvider.apply(ctx, { apiKeyRef: 'FIXTURE_KEY', maxTokens: 32, reasoningEffort: 'off' }), /explicit metered DeepSeek/);
});
