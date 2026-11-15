import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetLedger } from '../src/budget.mjs';
import { DeepSeekTransport } from '../src/deepseek-transport.mjs';
import { MessagesReceipt, messagesUsage } from '../src/deepseek-receipt.mjs';
import { DomainError } from '../src/store.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const model = 'deepseek-v4-pro', provider = 'metered-fixture';
const policy = { contextWindow: 1048576, maxOutputTokens: 16384, prices: { input: 9, output: 27, cachedInput: 0.3 },
  priceVersion: 'fixture-fixed', reasoningEfforts: ['off', 'high'] };
const usage = { input_tokens: 80, output_tokens: 3, cache_read_input_tokens: 20, cache_creation_input_tokens: 0 };
const options = id => ({ provider, model, reasoningEffort: 'off', maxTokens: 100,
  sessionId: 'native-fixture', messages: [{ role: 'user', content: [{ type: 'text', text: id }] }] });
const wire = (overrides = {}) => JSON.stringify({ model, max_tokens: 100, stream: true,
  thinking: { type: 'disabled' }, messages: [{ role: 'user', content: [{ type: 'text', text: '本地文件文本' }] }], ...overrides });
const init = (body = wire()) => ({ method: 'POST', redirect: 'error', body,
  headers: { 'x-api-key': 'fake-secret-never-use-real', 'content-type': 'application/json' } });
const event = (type, rest = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`;
function sse(finalUsage = usage, { terminal = true, responseModel = model } = {}) {
  return Buffer.from(event('message_start', { message: { id: 'native-provider-receipt', model: responseModel,
    usage: { ...usage, output_tokens: 0, input_tokens: 999 } } }) +
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
    event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '你好' } }) +
    event('content_block_stop', { index: 0 }) +
    event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: finalUsage }) +
    (terminal ? event('message_stop') : ''));
}
async function setup(t, handler, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'arcfold-messages-fixture-'));
  let calls = 0;
  const server = http.createServer((req, res) => { calls++; handler(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/anthropic/v1/messages`;
  const ledger = new BudgetLedger(join(directory, 'budget.sqlite'), { create: true, ceilingCny: 150, authorizationRef: 'fixture-150' });
  const config = { ledger, artifactDirectory: join(directory, 'evidence'), provider, modelPolicies: { [model]: policy },
    endpoint, allowLocalTestEndpoint: true, timeoutMs: 2000,
    requestIdentity: input => ({ requestId: input.messages[0].content[0].text, metadata: { sessionId: input.sessionId, step: 1 } }), ...extra };
  const transport = new DeepSeekTransport(config);
  t.after(async () => {
    await transport.close(); ledger.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true });
  });
  return { directory, endpoint, ledger, transport, config, calls: () => calls };
}
const respond = payload => (req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(payload); }); };

test('final synchronous guard sees frozen native messages and releases only its unsent reservation after the persistence wait', async t => {
  let revoked = false, entered, release, guardCalls = 0;
  const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const controller = new AbortController();
  const f = await setup(t, respond(sse()), { beforeDispatch: captured => {
    guardCalls++; assert.equal(captured.messages[0].content[0].text, 'late-source');
    assert.equal(captured.signal, controller.signal);
    assert.equal(Object.isFrozen(captured.messages[0].content[0]), true);
    if (revoked) throw new DomainError('source_withdrawn', 'Source was withdrawn before send.');
  } });
  f.ledger.reserve({ requestId: 'historical-unknown', bodyHash: 'historical-body', model,
    maxOutputTokens: 1, inputTokenCeiling: 1, prices: policy.prices });
  f.ledger.markDispatched('historical-unknown'); f.ledger.markUnknown('historical-unknown', 'old interruption');
  const old = f.ledger.get('historical-unknown'), persist = f.transport.persistJson.bind(f.transport);
  f.transport.persistJson = async (path, value) => {
    await persist(path, value);
    if (path.endsWith('/request.json')) { entered(); await gate; }
  };
  const input = { ...options('late-source'), signal: controller.signal };
  const sending = f.transport.createTransport(input).send(f.endpoint, init()); void sending.catch(() => {});
  try {
    await Promise.race([ready, sending.then(() => { throw new Error('Expected the request persistence gate'); })]);
    assert.equal(f.ledger.get('late-source').status, 'reserved'); assert.equal(guardCalls, 0);
    input.messages[0].content[0].text = 'changed after serialization'; revoked = true;
  } finally { release(); }
  await assert.rejects(sending, { code: 'source_withdrawn' });
  assert.equal(guardCalls, 1); assert.equal(f.calls(), 0);
  assert.equal(f.ledger.get('late-source').status, 'released');
  assert.equal(f.ledger.get('late-source').reservedMicroCny, 0);
  assert.equal(f.ledger.get('late-source').dispatchedAt, null);
  assert.deepEqual(f.ledger.get('historical-unknown'), old);
});

for (const [kind, beforeDispatch] of [['async function', async () => {}], ['thenable', () => ({ then(resolve) { resolve(); } })]])
  test(`final ${kind} guard cannot be mistaken for permission to send`, async t => {
    const f = await setup(t, respond(sse()), { beforeDispatch });
    await assert.rejects(f.transport.createTransport(options('async-final-check')).send(f.endpoint, init()), { code: 'async_before_dispatch' });
    assert.equal(f.calls(), 0); assert.equal(f.ledger.get('async-final-check').status, 'released');
    assert.equal(f.ledger.get('async-final-check').reservedMicroCny, 0);
  });

test('a native owner change during request persistence rejects dispatch with no retry', async t => {
  let current = 'initial-step', entered, release;
  const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const f = await setup(t, respond(sse()), { requestIdentity: () => ({ requestId: current, metadata: {} }) });
  const persist = f.transport.persistJson.bind(f.transport);
  f.transport.persistJson = async (path, value) => { await persist(path, value); if (path.endsWith('/request.json')) { entered(); await gate; } };
  const transport = f.transport.createTransport(options('unused')), sending = transport.send(f.endpoint, init()); void sending.catch(() => {});
  try {
    await Promise.race([ready, sending.then(() => { throw new Error('Expected the request persistence gate'); })]);
    current = 'later-step';
  } finally { release(); }
  await assert.rejects(sending, { code: 'native_request_changed' });
  assert.equal(f.ledger.get('initial-step').status, 'released'); assert.equal(f.ledger.get('later-step'), null);
  await assert.rejects(transport.send(f.endpoint, init()), { code: 'request_already_dispatched' });
  assert.equal(f.calls(), 0);
});

test('fragmented original Messages bytes settle once using final uncached/cache usage', async t => {
  const payload = sse(), cut = payload.indexOf(Buffer.from('你好')) + 1;
  let actualBody = '';
  const f = await setup(t, (req, res) => {
    req.on('data', chunk => { actualBody += chunk; }); req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'receipt-1' });
      res.write(payload.subarray(0, cut)); setImmediate(() => res.end(payload.subarray(cut)));
    });
  });
  const local = f.transport.createTransport(options('native-step-1'));
  const response = await local.send(f.endpoint, init());
  assert.equal(await response.text(), payload.toString()); assert.equal(actualBody, wire());
  assert.equal(f.calls(), 1); assert.equal(f.ledger.get('native-step-1').spentMicroCny, 807);
  assert.deepEqual(f.ledger.get('native-step-1').usage, { promptTokens: 100, completionTokens: 3, cachedTokens: 20 });
  const path = join(f.config.artifactDirectory, digest('native-step-1'));
  assert.deepEqual(await readFile(join(path, 'response-body.bin')), payload);
  const receipt = JSON.parse(await readFile(join(path, 'receipt.json'), 'utf8'));
  assert.equal(receipt.responseHash, digest(payload)); assert.deepEqual(receipt.rawUsage, usage);
  for (const name of await readdir(path)) {
    assert.equal((await readFile(join(path, name), 'utf8')).includes('fake-secret-never-use-real'), false);
  }
  await assert.rejects(local.send(f.endpoint, init()), { code: 'request_already_dispatched' });
  assert.equal(f.calls(), 1);
});

test('HTTP errors and redirects are preserved without any second POST', async t => {
  let status = 421;
  const f = await setup(t, (req, res) => { req.resume(); req.on('end', () => {
    res.writeHead(status, { 'content-type': 'text/plain', location: '/do-not-follow' }); res.end(`original-${status}`);
  }); });
  for (status of [421, 307, 308, 429, 500]) {
    const id = `http-${status}`, before = f.calls();
    const response = await f.transport.createTransport(options(id)).send(f.endpoint, init());
    assert.equal(response.status, status); assert.equal(await response.text(), `original-${status}`);
    assert.equal(f.calls(), before + 1); assert.equal(f.ledger.get(id).status, 'unknown');
    assert.equal(f.ledger.get(id).reservedMicroCny, 9879552);
    assert.equal(await readFile(join(f.config.artifactDirectory, digest(id), 'response-body.bin'), 'utf8'), `original-${status}`);
  }
});

test('both native input and final serialized body reject unsupported uploads and server tools', async t => {
  const f = await setup(t, respond(sse()));
  for (const type of ['image', 'file', 'document']) {
    const input = options(`unsupported-${type}`); input.messages[0].content = [{ type, attachment: { attachmentId: 'no-upload' } }];
    assert.throws(() => f.transport.validateInput(input), { code: 'unsupported_model_content' });
    assert.throws(() => f.transport.createTransport(input), { code: 'unsupported_model_content' });
  }
  const toolImage = options('tool-result-image'); toolImage.messages = [{ role: 'tool', content: [{ type: 'image', attachment: {} }] }];
  assert.throws(() => f.transport.validateInput(toolImage), { code: 'unsupported_model_content' });
  await assert.rejects(f.transport.createTransport(options('server-tool')).send(f.endpoint,
    init(wire({ tools: [{ type: 'web_search_20250305', name: 'web_search' }] }))), { code: 'unsupported_model_content' });
  await assert.rejects(f.transport.createTransport(options('wire-image')).send(f.endpoint,
    init(wire({ messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'file', file_id: 'x' } }] }] }))), { code: 'unsupported_model_content' });
  assert.equal(f.calls(), 0); assert.equal(f.ledger.list().length, 0);
  const ordinary = options('image-and-file-are-ordinary-words');
  assert.equal(f.transport.validateInput(ordinary), true);
});

test('wire configuration changes and pre-send cancellation incur no reservation or HTTP call', async t => {
  const f = await setup(t, respond(sse()));
  await assert.rejects(f.transport.createTransport(options('changed')).send(f.endpoint, init(wire({ max_tokens: 101 }))), { code: 'wire_configuration_changed' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.transport.createTransport({ ...options('cancelled'), signal: controller.signal }).send(f.endpoint, init()));
  assert.equal(f.calls(), 0); assert.equal(f.ledger.list().length, 0);
});

test('visible response without terminal receipt stays unknown and cold recovery never resends', async t => {
  const f = await setup(t, respond(sse(usage, { terminal: false })));
  const response = await f.transport.createTransport(options('incomplete')).send(f.endpoint, init());
  await assert.rejects(response.text());
  const previous = f.ledger.get('incomplete'); assert.equal(previous.status, 'unknown');
  await f.transport.close();
  const reopened = new DeepSeekTransport(f.config);
  try {
    assert.deepEqual((await reopened.recover({ exclusive: true })).unchanged, ['incomplete']);
    assert.deepEqual(f.ledger.get('incomplete'), previous); assert.equal(f.calls(), 1);
    await assert.rejects(reopened.createTransport(options('incomplete')).send(f.endpoint, init()));
    assert.equal(f.calls(), 1);
  } finally { await reopened.close(); }
});

test('complete durable receipt recovers settlement after the accounting write failed', async t => {
  const f = await setup(t, respond(sse()));
  const originalSettle = f.ledger.settle.bind(f.ledger);
  f.ledger.settle = () => { throw new Error('simulated settlement storage failure'); };
  const response = await f.transport.createTransport(options('recover-complete')).send(f.endpoint, init());
  await assert.rejects(response.text()); assert.equal(f.ledger.get('recover-complete').status, 'unknown');
  f.ledger.settle = originalSettle; await f.transport.close();
  const recovered = new DeepSeekTransport(f.config);
  try {
    assert.deepEqual((await recovered.recover({ exclusive: true })).settled, ['recover-complete']);
    assert.equal(f.ledger.get('recover-complete').spentMicroCny, 807); assert.equal(f.calls(), 1);
    const before = f.ledger.get('recover-complete'); await recovered.recover({ exclusive: true });
    assert.deepEqual(f.ledger.get('recover-complete'), before);
  } finally { await recovered.close(); }
});

test('closing an unread response classifies it and does not wait indefinitely for consumption', { timeout: 5000 }, async t => {
  const f = await setup(t, (req, res) => { req.resume(); req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(event('message_start', { message: { id: 'pending', model } }));
  }); });
  await f.transport.createTransport(options('unread')).send(f.endpoint, init());
  await f.transport.close(); await f.transport.close();
  assert.equal(f.ledger.get('unread').status, 'unknown'); assert.equal(f.calls(), 1);
});

test('usage parser rejects missing cache fields, nonzero cache creation and duplicate terminal frames', () => {
  for (const invalid of [{ input_tokens: 1, output_tokens: 1 }, { ...usage, cache_creation_input_tokens: 1 },
    { ...usage, output_tokens: -1 }, { ...usage, input_tokens: 0.5 }]) {
    assert.throws(() => messagesUsage(invalid), { code: 'invalid_provider_receipt' });
  }
  const parser = new MessagesReceipt(); parser.push(sse());
  assert.throws(() => parser.push(Buffer.from(event('message_stop'))), { code: 'invalid_provider_receipt' });
});

test('tampered raw receipt is refused during recovery and does not change settled money', async t => {
  const f = await setup(t, respond(sse()));
  await (await f.transport.createTransport(options('tamper')).send(f.endpoint, init())).text();
  await f.transport.close();
  const before = f.ledger.get('tamper');
  await writeFile(join(f.config.artifactDirectory, digest('tamper'), 'response-body.bin'), sse({ ...usage, output_tokens: 4 }));
  const reopened = new DeepSeekTransport(f.config);
  try {
    await assert.rejects(reopened.recover({ exclusive: true }), { code: 'receipt_identity_conflict' });
    assert.deepEqual(f.ledger.get('tamper'), before); assert.equal(f.calls(), 1);
  } finally { await reopened.close(); }
});

test('truncated terminal or non-whitespace after message_stop cannot settle', async t => {
  let payload;
  const f = await setup(t, (req, res) => {
    req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(payload); });
  });
  const bad = [
    sse().subarray(0, -1),
    Buffer.concat([sse(), Buffer.from('event: message_delta\n')]),
    Buffer.concat([sse(), Buffer.from('data: {"type":')]),
    Buffer.concat([sse(), Buffer.from(event('message_stop'))]),
    Buffer.concat([sse(), Buffer.from(': trailing comment\n')]),
  ];
  for (const [index, bytes] of bad.entries()) {
    payload = bytes; const id = `truncated-${index}`;
    const response = await f.transport.createTransport(options(id)).send(f.endpoint, init());
    await assert.rejects(response.text());
    assert.equal(f.ledger.get(id).status, 'unknown');
    assert.equal(f.ledger.get(id).reservedMicroCny, 9879552);
    assert.deepEqual(await readFile(join(f.config.artifactDirectory, digest(id), 'response-body.bin')), bytes);
  }
  assert.equal(f.calls(), bad.length);
});

test('complete CRLF framing split across chunks and terminal whitespace remain valid', () => {
  const bytes = Buffer.from(sse().toString().replaceAll('\n', '\r\n') + '\r\n \t');
  const parser = new MessagesReceipt();
  for (const byte of bytes) parser.push(Buffer.from([byte]));
  assert.deepEqual(parser.finish().usage, { promptTokens: 100, completionTokens: 3, cachedTokens: 20 });
});

test('a different response model keeps the reservation instead of using request prices', async t => {
  const payload = sse(usage, { responseModel: 'deepseek-v4-bad' });
  const f = await setup(t, respond(payload));
  const response = await f.transport.createTransport(options('wrong-model')).send(f.endpoint, init());
  await assert.rejects(response.text(), { code: 'provider_model_mismatch' });
  assert.equal(f.ledger.get('wrong-model').status, 'unknown');
  assert.equal(f.ledger.get('wrong-model').spentMicroCny, 0);
  assert.equal(f.ledger.get('wrong-model').reservedMicroCny, 9879552);
  assert.deepEqual(await readFile(join(f.config.artifactDirectory, digest('wrong-model'), 'response-body.bin')), payload);
  assert.equal(f.calls(), 1);
});

test('cold recovery enforces the model match even when raw bytes and receipt hashes agree', async t => {
  const f = await setup(t, respond(sse()));
  await (await f.transport.createTransport(options('cold-model')).send(f.endpoint, init())).text();
  await f.transport.close();
  const before = f.ledger.get('cold-model'), directory = join(f.config.artifactDirectory, digest('cold-model'));
  const payload = sse(usage, { responseModel: 'deepseek-v4-bad' });
  const receipt = JSON.parse(await readFile(join(directory, 'receipt.json'), 'utf8'));
  assert.equal(receipt.bytes, payload.length); // same-length model substitution preserves chunk boundaries
  receipt.model = 'deepseek-v4-bad'; receipt.responseHash = digest(payload);
  await writeFile(join(directory, 'response-body.bin'), payload);
  await writeFile(join(directory, 'receipt.json'), JSON.stringify(receipt));
  const reopened = new DeepSeekTransport(f.config);
  try {
    await assert.rejects(reopened.recover({ exclusive: true }), { code: 'provider_model_mismatch' });
    assert.deepEqual(f.ledger.get('cold-model'), before); assert.equal(f.calls(), 1);
  } finally { await reopened.close(); }
});

test('consumer cancellation and close wait for an in-progress receipt write before releasing ownership', { timeout: 5000 }, async t => {
  const f = await setup(t, respond(sse()));
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const persist = f.transport.persistJson.bind(f.transport);
  f.transport.persistJson = async (path, value) => {
    if (path.endsWith('/receipt.json')) { enter(); await gate; }
    return persist(path, value);
  };
  const response = await f.transport.createTransport(options('cancel-during-receipt')).send(f.endpoint, init());
  const reader = response.body.getReader(), reading = reader.read();
  await entered;
  let cancellationFinished = false, closeFinished = false;
  const cancelling = reader.cancel().then(() => { cancellationFinished = true; });
  const closing = f.transport.close().then(() => { closeFinished = true; });
  // A scheduling boundary is enough: completion must depend on the I/O gate,
  // never on an assumed elapsed delay.
  try {
    await new Promise(setImmediate);
    assert.equal(cancellationFinished, false); assert.equal(closeFinished, false);
    assert.equal(f.transport.inflight.size, 1);
    assert.equal(f.ledger.get('cancel-during-receipt').status, 'dispatched');
  } finally { release(); }
  await Promise.all([reading, cancelling, closing]);
  assert.equal(f.transport.inflight.size, 0);
  assert.equal(f.ledger.get('cancel-during-receipt').status, 'settled');
  assert.equal(f.ledger.get('cancel-during-receipt').spentMicroCny, 807);
  assert.equal(f.calls(), 1);
});
