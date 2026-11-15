import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const fixtureKey = process.env.ARCFOLD_FIXTURE_KEY;
assert.match(fixtureKey, /^[0-9a-f]{48}$/u);
const goal = '核对 Arcfold 更新是否保留测试目标';
const answer = '这是本机合成回复。我们会更新 Arcfold 后再核对这段会话和目标。';
const emptyLearning = { understandings: [], revisions: [], methods: [], supplements: [], categories: [] };
const event = (type, fields = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
let callCount = 0;
function stream(body, output, ordinal) {
  const usage = { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  return event('message_start', { message: { id: 'local-rehearsal-' + ordinal, model: body.model, role: 'assistant', content: [], usage: { input_tokens: 100, output_tokens: 0 } } }) +
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
    event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: output } }) +
    event('content_block_stop', { index: 0 }) + event('message_delta', { delta: { stop_reason: 'end_turn' }, usage }) +
    event('message_stop');
}
const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{}');
  }
  if (req.method !== 'POST' || req.url !== '/anthropic/v1/messages' || req.headers['x-api-key'] !== fixtureKey) {
    res.writeHead(403);
    return res.end();
  }
  try {
    const parts = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      assert.ok(bytes <= 2 * 1024 * 1024);
      parts.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(parts));
    assert.ok(['deepseek-v4-pro', 'deepseek-flash'].includes(body.model));
    let input;
    for (const message of body.messages ?? []) for (const block of message.content ?? []) {
      if (block.type !== 'text') continue;
      try {
        const row = JSON.parse(block.text);
        if (row.jobId && row.role) input = row;
      } catch {}
    }
    const role = input?.role ?? 'main';
    const ordinal = ++callCount;
    const output = role === 'attribution'
      ? JSON.stringify({ actions: [{ action: 'create_child', parentId: input.scope.nodeIds[0], name: goal }], statusChanges: [] })
      : role === 'learning' ? JSON.stringify(emptyLearning) : answer;
    assert.ok(['attribution', 'learning', 'main'].includes(role), 'Unexpected synthetic stage: ' + role);
    console.log(JSON.stringify({ component: 'loopback-model', ordinal, role, model: body.model }));
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'synthetic-desktop-rehearsal-' + ordinal });
    res.end(stream(body, output, ordinal));
  } catch (error) {
    console.error('Local model fixture: ' + error.message);
    res.writeHead(400);
    res.end();
  }
});
server.listen(48620, '127.0.0.1', () => console.log('Synthetic model is listening on loopback.'));
