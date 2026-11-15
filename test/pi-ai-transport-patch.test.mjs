import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyPiAiPatch, inspectPiAiPatch, patchSpec } from '../scripts/patch-pi-ai-transport.mjs';

// This suite requires the managed, frozen dependency resource. No old host,
// credentials file, ambient login, live API, or globally patched fetch is used.
assert.ok(process.env.ARCFOLD_PATCH_TEST_INSTALLATION, 'ARCFOLD_PATCH_TEST_INSTALLATION is required; never silently skip this suite');
const installation = realpathSync(resolve(process.env.ARCFOLD_PATCH_TEST_INSTALLATION));
const sourcePackage = join(installation, 'node_modules/@deepseek-ai/dsh-llm-pi-ai');
const sourceState = inspectPiAiPatch(sourcePackage);
const hash = value => createHash('sha256').update(value).digest('hex');
const unchangedDependencies = [
  'node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js',
  'node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js',
  'node_modules/openai/client.mjs',
].map(path => ({ path, sha256: hash(readFileSync(join(installation, path))) }));
const evidence = mkdtempSync(join(realpathSync(tmpdir()), 'pi-ai-transport-test-'));
symlinkSync(join(installation, 'node_modules'), join(evidence, 'node_modules'), 'dir');
const installed = createRequire(join(installation, 'package.json'));
const loadInstalled = name => import(pathToFileURL(installed.resolve(name)).href);
// This synthetic value belongs only to this short-lived managed test process.
process.env.ARCFOLD_PI_SEAM_FIXTURE_KEY = 'sk-fixture-only-not-real';
const { Context } = await loadInstalled('@deepseek-ai/cordis');
const { default: LlmRuntime, BlockAssembler, createToolResultMessage } = await loadInstalled('@deepseek-ai/dsh-llm');
// pi-ai exports this public entry only under the ESM import condition.
const { builtinProviders, getBuiltinModel } = await import(pathToFileURL(join(installation, 'node_modules/@earendil-works/pi-ai/dist/providers/all.js')).href);
const MODEL = 'gpt-6-astra';
const user = text => ({ id: `user-${text}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });
const request = (sessionId = 'fixture-one') => ({ provider: 'openai', model: MODEL, sessionId, purpose: 'fixture-main',
  reasoningEffort: 'high', maxTokens: 32, messages: [user(sessionId)], tools: [] });
const collect = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; };
const normalize = chunks => JSON.parse(JSON.stringify(chunks));

function freshPackage(label, patched = true) {
  const root = mkdtempSync(join(evidence, `${label}-`));
  const packageDir = join(root, 'node_modules/@deepseek-ai/dsh-llm-pi-ai');
  mkdirSync(join(root, 'node_modules/@deepseek-ai'), { recursive: true });
  cpSync(sourcePackage, packageDir, { recursive: true, dereference: false, errorOnExist: true, force: false });
  for (const file of patchSpec.files) {
    const path = join(packageDir, file.path); let text = readFileSync(path, 'utf8');
    if (hash(text) === file.afterSha256) {
      for (const edit of [...file.edits].reverse()) { assert.equal(text.split(edit.after).length, 2); text = text.replace(edit.after, edit.before); }
      assert.equal(hash(text), file.beforeSha256); writeFileSync(path, text);
    }
    assert.equal(hash(readFileSync(path)), file.beforeSha256);
  }
  if (patched) applyPiAiPatch({ packageDir, receiptDir: join(root, 'patch-receipt') });
  return { root, packageDir, load: () => import(pathToFileURL(join(packageDir, 'lib/index.js')).href) };
}

const reasoningItem = { type: 'reasoning', id: 'rs_fixture', encrypted_content: 'fixture-encrypted-reasoning',
  summary: [{ type: 'summary_text', text: 'fixture reasoning' }] };
const textItem = { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text: 'fixture response', annotations: [] }] };
const toolItem = { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: 'lookup', arguments: '{"key":7}', status: 'completed' };
const tool = { name: 'lookup', description: 'Read a fixture value', parameters: { type: 'object', properties: { key: { type: 'number' } }, required: ['key'] } };
function responseEvents(withTools = false) {
  const items = withTools ? [reasoningItem, textItem, toolItem] : [textItem];
  return [
    { type: 'response.created', response: { id: 'resp_fixture' } },
    ...items.flatMap((item, output_index) => [
      { type: 'response.output_item.added', output_index, item },
      { type: 'response.output_item.done', output_index, item },
    ]),
    { type: 'response.completed', response: { id: 'resp_fixture', model: MODEL, status: 'completed', output: items,
      usage: { input_tokens: 11, output_tokens: 5, total_tokens: 16,
        input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 2 } } } },
  ];
}
async function endpoint(t, { withTools = false, hold = false, status = 200 } = {}) {
  const observationDir = mkdtempSync(join(evidence, 'http-observations-'));
  const requests = []; let onRequest;
  const received = new Promise(resolve => { onRequest = resolve; });
  const server = createServer((req, res) => {
    void (async () => {
      const parts = []; for await (const part of req) parts.push(part);
      requests.push({ path: req.url, method: req.method, headers: req.headers, body: Buffer.concat(parts).toString() });
      onRequest();
      if (hold) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders(); return; }
      if (status !== 200) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'fixture refusal', type: 'server_error' } })); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(responseEvents(withTools).map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    })().catch(error => res.destroy(error));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    const closed = new Promise((done, reject) => server.close(error => error ? reject(error) : done())); server.closeAllConnections(); await closed;
    // Only this suite's synthetic bodies and non-auth transport metadata.
    writeFileSync(join(observationDir, 'received.json'), JSON.stringify(requests.map(({ path, method, headers, body }) => ({
      path, method, body: JSON.parse(body), headers: Object.fromEntries(Object.entries(headers).filter(([name]) => !['authorization', 'cookie'].includes(name))),
    })), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, url: `${origin}/v1`, requests, received, fetch(url, init) {
    assert.equal(new URL(url).origin, origin, 'The fixture transport rejects every non-loopback-fixture destination');
    return fetch(url, init);
  } };
}

function memoryAuth() {
  return { credentials: { read: async () => undefined, list: async () => [], modify: async () => { throw new Error('fixture forbids auth writes'); }, delete: async () => {} },
    authContext: { env: async () => undefined, fileExists: async () => false } };
}
function adapter(api, baseURL, additions = {}) {
  // Public pi-ai catalog/protocol objects, with only this fixture's endpoint
  // changed. Native-plugin tests below also exercise DSH's own profile resolver.
  const model = { ...getBuiltinModel('openai', MODEL), baseUrl: baseURL };
  const builtin = builtinProviders().find(provider => provider.id === 'openai');
  const piProvider = { ...builtin, baseUrl: baseURL, getModels: () => [model] };
  const profiles = new Map([['openai', { provider: 'openai', displayName: 'Fixture', piProvider,
    modelErrors: new Map(), configuredMaxTokens: new Map(), streamIdleTimeoutMs: 2000, transport: 'sse' }]]);
  return new api.PiAiAdapter({ profiles: () => profiles, auth: memoryAuth(),
    resolveApiKey: async () => 'sk-fixture-only-not-real', ...additions });
}
async function native(t, api, http, handler) {
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  await ctx.plugin(LlmRuntime);
  if (handler) ctx.on('llm-pi-ai/request-transport', handler);
  await ctx.plugin(api, { providers: { openai: { apiKeyEnv: 'ARCFOLD_PI_SEAM_FIXTURE_KEY', baseURL: http.url,
    transport: 'sse', models: [{ id: MODEL }], streamIdleTimeoutMs: 2000 } } });
  return ctx;
}
function assembled(chunks) {
  const assembler = new BlockAssembler(); for (const chunk of chunks) assembler.push(chunk);
  return { message: assembler.message({ provider: 'openai', model: MODEL, replayState: assembler.replayState }), usage: assembler.usage, finish: assembler.finish };
}
function wireBody(http, index = 0) { return JSON.parse(http.requests[index].body); }

test('exact package patch is idempotent, backs up bytes, and refuses partial, foreign and symlink inputs', t => {
  t.diagnostic(`Retained isolated evidence: ${evidence}`);
  const fixture = freshPackage('exact', false), receiptDir = join(fixture.root, 'apply');
  assert.equal(applyPiAiPatch({ packageDir: fixture.packageDir, receiptDir }).applied, true);
  for (const file of patchSpec.files) assert.equal(hash(readFileSync(join(receiptDir, 'original', file.path))), file.beforeSha256);
  assert.equal(inspectPiAiPatch(fixture.packageDir).state, 'patched');
  assert.equal(applyPiAiPatch({ packageDir: fixture.packageDir, receiptDir: join(fixture.root, 'repeat') }).applied, false);
  assert.throws(() => applyPiAiPatch({ packageDir: fixture.packageDir, receiptDir }), /EEXIST/);
  const first = patchSpec.files[0]; writeFileSync(join(fixture.packageDir, first.path), readFileSync(join(receiptDir, 'original', first.path)));
  assert.throws(() => inspectPiAiPatch(fixture.packageDir), /Mixed\/partial/);
  writeFileSync(join(fixture.packageDir, first.path), 'unexpected upstream bytes');
  assert.throws(() => inspectPiAiPatch(fixture.packageDir), /Unrecognized package bytes/);
  const foreign = freshPackage('foreign', false), metadataPath = join(foreign.packageDir, 'package.json');
  const metadata = JSON.parse(readFileSync(metadataPath)); metadata.version = 'unapproved'; writeFileSync(metadataPath, JSON.stringify(metadata));
  assert.throws(() => inspectPiAiPatch(foreign.packageDir));
  const link = join(fixture.root, 'package-link'); symlinkSync(fixture.packageDir, link);
  assert.throws(() => inspectPiAiPatch(link), /symlink/);
  const receiptFixture = freshPackage('receipt-link', false), receiptLink = join(receiptFixture.root, 'receipt-parent-link');
  symlinkSync(receiptFixture.packageDir, receiptLink);
  assert.throws(() => applyPiAiPatch({ packageDir: receiptFixture.packageDir, receiptDir: join(receiptLink, 'forbidden') }), /symlink/);
  assert.equal(inspectPiAiPatch(receiptFixture.packageDir).state, 'original');
});

test('a partial write preserves originals and failure receipt, then refuses automatic recovery', () => {
  const fixture = freshPackage('interrupted', false), receiptDir = join(fixture.root, 'interrupted-receipt');
  const protectedDirectory = join(fixture.packageDir, 'lib/types'), mode = lstatSync(protectedDirectory).mode & 0o777;
  chmodSync(protectedDirectory, 0o500);
  try { assert.throws(() => applyPiAiPatch({ packageDir: fixture.packageDir, receiptDir }), /EACCES|EPERM/); }
  finally { chmodSync(protectedDirectory, mode); }
  const failure = JSON.parse(readFileSync(join(receiptDir, 'failure.json')));
  assert.equal(failure.completed, false); assert.deepEqual(failure.changedFiles, ['lib/index.js']);
  for (const file of patchSpec.files) assert.equal(hash(readFileSync(join(receiptDir, 'original', file.path))), file.beforeSha256);
  assert.throws(() => applyPiAiPatch({ packageDir: fixture.packageDir, receiptDir: join(fixture.root, 'retry') }), /Mixed\/partial/);
});

test('a disk patch does not upgrade a previously loaded class; capability is immutable', async () => {
  const fixture = freshPackage('loaded', false), original = await fixture.load();
  assert.equal(original.PiAiAdapter.transportSeam, undefined);
  applyPiAiPatch({ packageDir: fixture.packageDir, receiptDir: join(fixture.root, 'after-import') });
  assert.equal(inspectPiAiPatch(fixture.packageDir).state, 'patched');
  assert.equal((await fixture.load()).PiAiAdapter, original.PiAiAdapter);
  assert.equal(original.PiAiAdapter.transportSeam, undefined);
  const next = await import(pathToFileURL(join(fixture.packageDir, 'lib/index.js')).href + '?fresh');
  assert.deepEqual(Object.getOwnPropertyDescriptor(next.PiAiAdapter, 'transportSeam'), {
    value: patchSpec.runtimeCapability.value, writable: false, enumerable: true, configurable: false,
  });
  assert.throws(() => { next.PiAiAdapter.transportSeam = 'different'; }, TypeError);
});

test('absent factory and explicit undefined preserve official request bytes, response translation and usage', async t => {
  const http = await endpoint(t), original = await freshPackage('default-original', false).load(), patched = await freshPackage('default-patched').load();
  const input = request(), a = await collect(adapter(original, http.url).stream(input));
  const b = await collect(adapter(patched, http.url).stream(input));
  const c = await collect(adapter(patched, http.url, { createTransport: () => undefined }).stream(input));
  assert.deepEqual(normalize(b), normalize(a)); assert.deepEqual(normalize(c), normalize(a));
  assert.equal(http.requests.length, 3); assert.equal(http.requests[1].body, http.requests[0].body); assert.equal(http.requests[2].body, http.requests[0].body);
  assert.equal(http.requests[0].path, '/v1/responses'); assert.equal(wireBody(http).model, MODEL);
  assert.equal(assembled(b).finish.kind, 'stop'); assert.equal(assembled(b).usage.inputTokens, 8); assert.equal(assembled(b).usage.outputTokens, 5);
});

test('invalid or throwing factory fails before credentials, attachments or inference; undefined alone opts out', async t => {
  const http = await endpoint(t), api = await freshPackage('invalid').load();
  let auth = 0, attachments = 0, factories = 0;
  const refusal = new Error('fixture declines before async preparation');
  for (const invalid of ['throw', null, {}, { fetch: 1 }, true, () => {}, Promise.resolve({ fetch: http.fetch }), { fetch: http.fetch, then() {} }]) {
    const input = request(); input.messages[0].content = [{ type: 'image', ref: { attachmentId: 'never-read' } }];
    const instance = adapter(api, http.url, {
      createTransport(options) { factories++; assert.equal(options, input); if (invalid === 'throw') throw refusal; return invalid; },
      resolveApiKey: async () => { auth++; throw new Error('unexpected auth'); },
      resolveAttachments: () => { attachments++; throw new Error('unexpected attachments'); },
    });
    await assert.rejects(collect(instance.stream(input)), error => invalid === 'throw' ? error === refusal : /createTransport must return/.test(error.message));
  }
  assert.equal(factories, 8); assert.equal(auth, 0); assert.equal(attachments, 0); assert.equal(http.requests.length, 0);
});

test('rejected asynchronous factories fail the call without unhandled rejection or waiting on custom thenables', async t => {
  const http = await endpoint(t), fixture = freshPackage('async-rejection'), observations = [];
  for (const mode of ['rejected', 'async-throw', 'rejected-throwing-then-getter', 'throwing-then-getter', 'never-settling-thenable']) {
    const code = `
      import assert from 'node:assert/strict';
      const api = await import(${JSON.stringify(pathToFileURL(join(fixture.packageDir, 'lib/index.js')).href)});
      const { builtinProviders, getBuiltinModel } = await import(${JSON.stringify(pathToFileURL(join(installation, 'node_modules/@earendil-works/pi-ai/dist/providers/all.js')).href)});
      const MODEL = ${JSON.stringify(MODEL)}, mode = ${JSON.stringify(mode)};
      const memoryAuth = ${memoryAuth.toString()};
      const adapter = ${adapter.toString()};
      let auth = 0, attachments = 0, factories = 0, unhandled = 0, thenReads = 0, thenCalls = 0, failure;
      process.on('unhandledRejection', () => { unhandled++; });
      const instance = adapter(api, ${JSON.stringify(http.url)}, {
        createTransport() {
          factories++;
          if (mode === 'async-throw') return (async () => { throw new Error('fixture async rejection'); })();
          if (mode === 'rejected') return Promise.reject(new Error('fixture rejected return'));
          if (mode === 'rejected-throwing-then-getter') {
            const result = Promise.reject(new Error('fixture rejected getter return'));
            Object.defineProperty(result, 'then', { get() { thenReads++; throw new Error('fixture then getter'); } });
            return result;
          }
          if (mode === 'throwing-then-getter') return { get then() { thenReads++; throw new Error('fixture then getter'); } };
          return { get then() { thenReads++; return () => { thenCalls++; return new Promise(() => {}); }; } };
        },
        resolveApiKey: async () => { auth++; return 'sk-fixture-only-not-real'; },
        resolveAttachments: () => { attachments++; return undefined; },
      });
      try { for await (const chunk of instance.stream({ provider: 'openai', model: MODEL, messages: [
        { role: 'user', content: [{ type: 'image', ref: { attachmentId: 'never-read' } }] }
      ] })) { throw new Error('invalid factory produced a stream chunk'); } }
      catch (error) { failure = { name: error.name, message: error.message }; }
      console.log(JSON.stringify({ phase: 'call-failed', failure, auth, attachments, factories }));
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.ok(failure);
      if (mode !== 'throwing-then-getter') { assert.equal(failure.name, 'TypeError'); assert.match(failure.message, /createTransport must return/); }
      assert.equal(auth, 0); assert.equal(attachments, 0); assert.equal(factories, 1); assert.equal(unhandled, 0); assert.equal(thenCalls, 0);
      if (mode === 'rejected-throwing-then-getter') assert.equal(thenReads, 0);
      console.log(JSON.stringify({ phase: 'host-survived', failure, auth, attachments, factories, unhandled, thenReads, thenCalls }));
    `;
    const result = await new Promise(resolve => {
      const child = spawn(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', code], {
        cwd: fixture.root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', part => { stdout += part; }); child.stderr.on('data', part => { stderr += part; });
      child.on('error', error => { stderr += String(error); });
      child.on('close', (exitCode, signal) => resolve({ mode, exitCode, signal, stdout, stderr }));
    });
    observations.push(result);
    writeFileSync(join(fixture.root, `${mode}.json`), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  // Inspect all child outcomes, including failures, only after preserving them.
  for (const result of observations) {
    assert.equal(result.exitCode, 0, `${result.mode}: ${result.stderr}`); assert.equal(result.signal, null);
    const final = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(final.phase, 'host-survived'); assert.equal(final.unhandled, 0);
  }
  assert.equal(http.requests.length, 0);
});

test('concurrent prepared and direct streams capture distinct senders before auth await and retain final body/header/signal', async t => {
  const http = await endpoint(t), api = await freshPackage('concurrent').load(), transports = [], order = [];
  let release; const gate = new Promise(resolve => { release = resolve; });
  const inputs = [request('prepared'), request('direct')];
  const instance = adapter(api, http.url, {
    createTransport(options) {
      assert.ok(inputs.includes(options)); order.push(`factory:${options.sessionId}`);
      const record = { options, calls: 0, signals: [] };
      const transport = { fetch(url, init) {
        record.calls++; record.signals.push(init.signal);
        assert.ok(init.signal instanceof AbortSignal); assert.equal(new Headers(init.headers).get('authorization'), 'Bearer sk-fixture-only-not-real');
        assert.equal(new Headers(init.headers).get('x-fixture-session'), options.sessionId);
        const body = JSON.parse(init.body); assert.equal(body.input.find(item => item.role === 'user').content[0].text, options.sessionId);
        assert.equal(body.max_output_tokens, 32); return http.fetch(url, init);
      } };
      record.transport = transport; transports.push(record); return transport;
    },
    resolveApiKey: async () => { order.push('auth'); await gate; return 'sk-fixture-only-not-real'; },
    prepareHeaders(options, headers) { headers.set('x-fixture-session', options.sessionId); return headers; },
  });
  const prepared = await instance.prepareCall('openai', MODEL); assert.equal(transports.length, 0);
  const pending = [collect(prepared.stream(inputs[0])), collect(instance.stream(inputs[1]))];
  assert.deepEqual(order, ['factory:prepared', 'auth', 'factory:direct', 'auth']);
  // Capturing the function before auth prevents later mutation of this object
  // from redirecting an in-flight request to another transport.
  for (const record of transports) record.transport.fetch = () => { throw new Error('late mutation reached in-flight call'); };
  release(); const outputs = await Promise.all(pending);
  assert.equal(http.requests.length, 2); assert.equal(transports.length, 2); assert.notEqual(transports[0].transport, transports[1].transport);
  assert.ok(transports.every(record => record.calls === 1)); assert.notEqual(transports[0].signals[0], transports[1].signals[0]);
  assert.ok(outputs.every(output => assembled(output).finish.kind === 'stop'));
});

test('caller cancellation reaches the supplied SDK signal and the actual loopback request', async t => {
  const http = await endpoint(t, { hold: true }), api = await freshPackage('cancel').load(), controller = new AbortController();
  let wireSignal, calls = 0;
  const output = collect(adapter(api, http.url, { createTransport: () => ({ fetch(url, init) {
    calls++; wireSignal = init.signal; return http.fetch(url, init);
  } }) }).stream({ ...request('cancel'), signal: controller.signal }));
  await http.received; assert.ok(wireSignal instanceof AbortSignal); assert.notEqual(wireSignal, controller.signal);
  controller.abort(new Error('fixture cancellation'));
  const chunks = await output;
  assert.equal(chunks.at(-1).reason.kind, 'aborted'); assert.equal(chunks.at(-1).reason.failure.code, 'ABORTED');
  assert.equal(wireSignal.aborted, true); assert.equal(calls, 1); assert.equal(http.requests.length, 1);
});

test('a 500 fixture has one observed send with frozen retry defaults; hook does not promise redirect safety', async t => {
  const http = await endpoint(t, { status: 500 }), api = await freshPackage('retry').load(); let calls = 0;
  const chunks = await collect(adapter(api, http.url, { createTransport: () => ({ fetch(url, init) { calls++; return http.fetch(url, init); } }) }).stream(request()));
  assert.equal(chunks.at(-1).reason.kind, 'error'); assert.match(chunks.at(-1).reason.failure.message, /fixture refusal/);
  assert.equal(calls, 1); assert.equal(http.requests.length, 1);
});

test('native plugin without a transport listener retains the original default path', async t => {
  const http = await endpoint(t), original = await freshPackage('native-original', false).load(), patched = await freshPackage('native-default').load();
  const first = await native(t, original, http), second = await native(t, patched, http);
  const input = request('native-default'); const a = await collect(first.llm.stream(input)), b = await collect(second.llm.stream(input));
  assert.equal(http.requests.length, 2); assert.equal(http.requests[0].body, http.requests[1].body); assert.deepEqual(normalize(b), normalize(a));
});

test('native event sees the exact frozen prepared call and forwards its transport; invalid listener fails before send', async t => {
  const http = await endpoint(t), api = await freshPackage('native-hook').load(); let optionsSeen, sends = 0;
  const ctx = await native(t, api, http, (options, next) => {
    assert.equal(next(), undefined); optionsSeen = options;
    return { fetch(url, init) { sends++; return http.fetch(url, init); } };
  });
  const prepared = await ctx.llm.prepareCall({ provider: 'openai', model: MODEL, reasoningEffort: 'high', maxTokens: 32 });
  const input = Object.freeze({ ...request('native-frozen'), ...prepared.config });
  await collect(prepared.stream(input));
  assert.equal(optionsSeen, input); assert.equal(Object.isFrozen(optionsSeen), true); assert.equal(optionsSeen.purpose, 'fixture-main');
  assert.equal(sends, 1); assert.equal(http.requests.length, 1);
  const invalid = await native(t, api, http, () => ({}));
  const failed = await collect(invalid.llm.stream(request('invalid-native')));
  assert.equal(failed.at(-1).reason.kind, 'error'); assert.match(failed.at(-1).reason.failure.message, /createTransport must return/);
  assert.equal(http.requests.length, 1);
});

test('official native conversion retains high reasoning, encrypted reasoning, tool IDs/results and usage through local replay', async t => {
  const http = await endpoint(t, { withTools: true }), api = await freshPackage('native-replay').load(); let sends = 0;
  const ctx = await native(t, api, http, () => ({ fetch(url, init) { sends++; return http.fetch(url, init); } }));
  const firstInput = { ...request('replay'), tools: [tool] };
  const first = assembled(await collect(ctx.llm.stream(firstInput)));
  const before = JSON.stringify(first.message); const call = first.message.content.find(block => block.type === 'tool-call');
  assert.ok(first.message.source.replayState); assert.ok(call); assert.equal(call.id, 'call_fixture|fc_fixture');
  const result = createToolResultMessage({ callId: call.id, isError: false, content: [{ type: 'text', text: 'fixture tool result' }] });
  const second = await collect(ctx.llm.stream({ ...firstInput, messages: [...firstInput.messages, first.message, result] }));
  assert.equal(second.at(-1).reason.kind, 'tool-calls', JSON.stringify(second.at(-1)));
  assert.equal(JSON.stringify(first.message), before); assert.equal(sends, 2); assert.equal(http.requests.length, 2);
  const firstWire = wireBody(http), replay = wireBody(http, 1);
  assert.equal(firstWire.store, false); assert.ok(firstWire.include.includes('reasoning.encrypted_content'));
  assert.equal(firstWire.reasoning.effort, 'medium');
  assert.equal(firstWire.input.at(-1).type, 'configuration_update'); assert.equal(firstWire.input.at(-1).reasoning.effort, 'high');
  const reasoning = replay.input.find(item => item.type === 'reasoning'); assert.equal(reasoning.id, reasoningItem.id); assert.equal(reasoning.encrypted_content, reasoningItem.encrypted_content);
  const wireCall = replay.input.find(item => item.type === 'function_call'); assert.equal(wireCall.id, toolItem.id); assert.equal(wireCall.call_id, toolItem.call_id); assert.deepEqual(JSON.parse(wireCall.arguments), { key: 7 });
  const wireResult = replay.input.find(item => item.type === 'function_call_output'); assert.equal(wireResult.call_id, toolItem.call_id); assert.match(wireResult.output, /fixture tool result/);
  assert.equal(first.usage.outputTokens, 5); assert.equal(first.usage.inputTokens, 8);
  const original = await freshPackage('native-replay-original', false).load(), old = await native(t, original, http);
  const oldFirst = assembled(await collect(old.llm.stream(firstInput)));
  const oldCall = oldFirst.message.content.find(block => block.type === 'tool-call');
  const oldResult = createToolResultMessage({ callId: oldCall.id, isError: false, content: [{ type: 'text', text: 'fixture tool result' }] });
  const oldSecond = await collect(old.llm.stream({ ...firstInput, messages: [...firstInput.messages, oldFirst.message, oldResult] }));
  assert.equal(oldSecond.at(-1).reason.kind, 'tool-calls'); assert.equal(http.requests.length, 4);
  assert.deepEqual(wireBody(http, 2), firstWire); assert.deepEqual(wireBody(http, 3), replay);
  assert.deepEqual(oldFirst.usage, first.usage); assert.deepEqual(oldFirst.message.source.replayState, first.message.source.replayState);
});

test('original package and lower-level pi-ai/OpenAI files remain byte-identical after all fixture work', () => {
  assert.deepEqual(inspectPiAiPatch(sourcePackage), sourceState);
  for (const file of unchangedDependencies) assert.equal(hash(readFileSync(join(installation, file.path))), file.sha256);
});
