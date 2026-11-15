import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyDeepSeekPatch, inspectDeepSeekPatch, patchSpec } from '../scripts/patch-deepseek-transport.mjs';

// Deliberately no fallback to the old host or a globally installed package.
const configuredInstallation = process.env.ARCFOLD_PATCH_TEST_INSTALLATION;
assert.ok(configuredInstallation, 'Set ARCFOLD_PATCH_TEST_INSTALLATION to the NEW isolated npm installation; this test cannot be silently skipped');
const installation = realpathSync(resolve(configuredInstallation));
const sourcePackage = join(installation, 'node_modules/@deepseek-ai/dsh-llm-deepseek');
inspectDeepSeekPatch(sourcePackage);
const evidence = mkdtempSync(join(realpathSync(tmpdir()), 'provider-patch-test-'));
// Each copied target package below wins normal Node resolution in its own
// node_modules. Other imports climb to this read-only dependency resource.
// Never write through this link or copy evidence into the source installation.
symlinkSync(join(installation, 'node_modules'), join(evidence, 'node_modules'), 'dir');
const hash = value => createHash('sha256').update(value).digest('hex');
const MODEL = 'deepseek-v4-pro';
const collect = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; };
const causes = error => { const result = []; for (let current = error; current; current = current.cause) result.push(current); return result; };
const user = text => ({ id: `user-${text}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });
const request = (sessionId = 'seam-one') => ({ provider: 'seam-test', model: MODEL, sessionId, reasoningEffort: 'off', maxTokens: 32,
  messages: [user(sessionId)], tools: [] });

function freshPackage(label, patched = true) {
  const root = mkdtempSync(join(evidence, `${label}-`));
  const packageDir = join(root, 'node_modules/@deepseek-ai/dsh-llm-deepseek');
  mkdirSync(join(root, 'node_modules/@deepseek-ai'), { recursive: true });
  cpSync(sourcePackage, packageDir, { recursive: true, dereference: false, errorOnExist: true, force: false });
  // The selected isolated install may already carry the patch. Only this new
  // test copy is restored, using exact after hashes and the frozen inverse.
  for (const file of patchSpec.files) {
    const path = join(packageDir, file.path); let bytes = readFileSync(path);
    if (hash(bytes) === file.afterSha256) {
      let text = bytes.toString('utf8');
      for (const edit of [...file.edits].reverse()) { assert.equal(text.split(edit.after).length, 2); text = text.replace(edit.after, edit.before); }
      assert.equal(hash(text), file.beforeSha256); writeFileSync(path, text); bytes = readFileSync(path);
    }
    assert.equal(hash(bytes), file.beforeSha256);
  }
  if (patched) applyDeepSeekPatch({ packageDir, receiptDir: join(root, 'patch-receipt') });
  return { root, packageDir, load: () => import(pathToFileURL(join(packageDir, 'lib/index.js')).href) };
}

const events = [
  { type: 'message_start', message: { id: 'fixture-message', model: MODEL,
    usage: { input_tokens: 3, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'local seam response' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' },
    usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  { type: 'message_stop' },
];
async function endpoint(t) {
  const requests = [];
  const server = createServer((req, res) => {
    void (async () => {
      const parts = []; for await (const part of req) parts.push(part);
      requests.push({ path: req.url, method: req.method, headers: req.headers, body: Buffer.concat(parts).toString() });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    })().catch(error => res.destroy(error));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { const closed = new Promise((done, reject) => server.close(error => error ? reject(error) : done())); server.closeAllConnections(); await closed; });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { requests, origin, url: `${origin}/anthropic`, send: (url, init) => {
    assert.equal(new URL(url).origin, origin, 'Test forbids all non-fixture network destinations'); return fetch(url, init);
  } };
}
function adapter(api, endpointURL, additions = {}) {
  const connection = api.resolveAdapterOptions({ baseURL: endpointURL, thinking: 'disabled', maxTokens: 32,
    models: [{ id: MODEL, contextWindow: 1024, maxTokens: 32 }], streamIdleTimeoutMs: 2000 });
  return new api.DeepSeekAdapter({ options: () => connection,
    resolveAuth: async () => ({ headers: { 'x-api-key': 'test-only-not-a-secret' } }), resolveUserId: () => 'fixture-anonymous-id',
    prepareExtensions: async () => ({ fields: {}, accept: async () => {} }), ...additions });
}

test('exact dist patch backs up originals, is idempotent, rejects foreign/mixed bytes and preserves existing receipts', t => {
  t.diagnostic(`Retained isolated evidence: ${evidence}`);
  const fixture = freshPackage('install', false);
  const receiptDir = join(fixture.root, 'apply');
  const result = applyDeepSeekPatch({ packageDir: fixture.packageDir, receiptDir });
  assert.equal(result.applied, true); assert.deepEqual(result.changedFiles, patchSpec.files.map(file => file.path));
  for (const file of patchSpec.files) assert.equal(hash(readFileSync(join(receiptDir, 'original', file.path))), file.beforeSha256);
  assert.equal(inspectDeepSeekPatch(fixture.packageDir).state, 'patched');
  assert.equal(applyDeepSeekPatch({ packageDir: fixture.packageDir, receiptDir: join(fixture.root, 'repeat') }).applied, false);
  assert.throws(() => applyDeepSeekPatch({ packageDir: fixture.packageDir, receiptDir }), /EEXIST/);
  const first = patchSpec.files[0];
  writeFileSync(join(fixture.packageDir, first.path), readFileSync(join(receiptDir, 'original', first.path)));
  assert.throws(() => inspectDeepSeekPatch(fixture.packageDir), /Mixed\/partial/);
  writeFileSync(join(fixture.packageDir, first.path), 'unexpected upstream version');
  assert.throws(() => inspectDeepSeekPatch(fixture.packageDir), /Unrecognized package bytes/);
  const other = freshPackage('version', false), metadataPath = join(other.packageDir, 'package.json');
  const metadata = JSON.parse(readFileSync(metadataPath)); metadata.version = 'unapproved'; writeFileSync(metadataPath, JSON.stringify(metadata));
  assert.throws(() => inspectDeepSeekPatch(other.packageDir));
});

test('patching disk does not grant transport capability to an already imported original function', async () => {
  const fixture = freshPackage('loaded-module-cache', false);
  const original = await fixture.load();
  assert.equal(original.registerDeepSeekProvider.transportSeam, undefined);
  applyDeepSeekPatch({ packageDir: fixture.packageDir, receiptDir: join(fixture.root, 'after-import-receipt') });
  assert.equal(inspectDeepSeekPatch(fixture.packageDir).state, 'patched');
  const stillCached = await fixture.load();
  assert.equal(stillCached.registerDeepSeekProvider, original.registerDeepSeekProvider);
  assert.notEqual(stillCached.registerDeepSeekProvider.transportSeam, patchSpec.runtimeCapability.value,
    'A metered plugin must reject this old loaded function despite patched disk hashes');
  const loaded = await import(pathToFileURL(join(fixture.packageDir, 'lib/index.js')).href + '?transport-seam-after-patch');
  assert.notEqual(loaded.registerDeepSeekProvider, original.registerDeepSeekProvider);
  assert.deepEqual(Object.getOwnPropertyDescriptor(loaded.registerDeepSeekProvider, 'transportSeam'), {
    value: patchSpec.runtimeCapability.value, writable: false, enumerable: true, configurable: false,
  });
  assert.throws(() => { loaded.registerDeepSeekProvider.transportSeam = 'different'; }, TypeError);
});

test('without callback, patched and original npm adapters send the same bytes and translate the same response', async t => {
  const http = await endpoint(t), original = await freshPackage('default-original', false).load(), patched = await freshPackage('default-patched').load();
  const input = request();
  const a = await collect(adapter(original, http.url).stream(input));
  const b = await collect(adapter(patched, http.url).stream(input));
  assert.deepEqual(b, a); assert.equal(http.requests.length, 2);
  assert.deepEqual(http.requests[1], http.requests[0]);
  assert.equal(http.requests[0].path, '/anthropic/v1/messages');
  assert.equal(JSON.parse(http.requests[0].body).model, MODEL);
  assert.equal(b.find(chunk => chunk.type === 'text-delta').text, 'local seam response');
  assert.equal(b.at(-1).reason.kind, 'stop');
});

test('callback rejects before any attachment, auth or network work; invalid callback results never fall back', async t => {
  const http = await endpoint(t), api = await freshPackage('refusal').load();
  let attachments = 0, auth = 0, factories = 0;
  const refusal = new Error('fixture blocks unsupported input before preparation');
  for (const invalid of ['throw', undefined, null, {}, Promise.resolve({ send: http.send })]) {
    const input = request('image-refusal'); input.messages[0].content = [{ type: 'image', ref: { attachmentId: 'never-read' } }];
    const instance = adapter(api, http.url, {
      createTransport: options => { factories++; assert.equal(options, input); if (invalid === 'throw') throw refusal; return invalid; },
      resolveAttachments: () => { attachments++; throw new Error('attachment preparation must not run'); },
      resolveAuth: async () => { auth++; throw new Error('auth must not run'); },
    });
    await assert.rejects(collect(instance.stream(input)), error => causes(error).some(cause =>
      invalid === 'throw' ? cause === refusal : /createTransport must return/.test(cause.message)));
  }
  assert.equal(factories, 5); assert.equal(attachments, 0); assert.equal(auth, 0); assert.equal(http.requests.length, 0);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(collect(adapter(api, http.url, { createTransport() { throw new Error('pre-aborted input invoked factory'); } })
    .stream({ ...request(), signal: cancelled.signal })), error => error.code === 'ABORTED');
  assert.equal(http.requests.length, 0);
});

test('prepared and direct concurrent streams each receive one local sender with final wire body and native signal', async t => {
  const http = await endpoint(t), api = await freshPackage('concurrent').load(), transports = [];
  let auth = 0;
  const instance = adapter(api, http.url, {
    createTransport: options => { const transport = { sessionId: options.sessionId, calls: 0,
      async send(url, init) { this.calls++; assert.equal(this.calls, 1); assert.ok(init.signal instanceof AbortSignal);
        assert.equal(init.redirect, 'error'); assert.equal(init.headers['x-api-key'], 'test-only-not-a-secret');
        const wire = JSON.parse(init.body); assert.equal(wire.arcfold_seam_fixture, true); assert.equal(wire.max_tokens, 32);
        assert.equal(wire.messages[0].content[0].text, this.sessionId); return http.send(url, init); } };
      transports.push(transport); return transport; },
    resolveAuth: async () => { auth++; return { headers: { 'x-api-key': 'test-only-not-a-secret' } }; },
    prepareExtensions: async () => ({ fields: { arcfold_seam_fixture: true }, accept: async () => {} }),
  });
  const prepared = await instance.prepareCall('seam-test', MODEL); assert.equal(transports.length, 0);
  const outputs = await Promise.all([collect(prepared.stream(request('prepared'))), collect(instance.stream(request('direct')))]);
  assert.equal(auth, 2); assert.equal(transports.length, 2); assert.notEqual(transports[0], transports[1]);
  assert.deepEqual(transports.map(item => item.sessionId).sort(), ['direct', 'prepared']);
  assert.ok(transports.every(item => item.calls === 1)); assert.equal(http.requests.length, 2);
  assert.ok(outputs.every(output => output.at(-1).reason.kind === 'stop'));
});

test('public Cordis registerDeepSeekProvider forwards the transport to the real installed adapter', async t => {
  const http = await endpoint(t), fixture = freshPackage('registration');
  const oldHome = process.env.DSH_HOME, oldAgentsHome = process.env.DSH_AGENTS_HOME;
  process.env.DSH_HOME = join(fixture.root, 'dsh-home'); process.env.DSH_AGENTS_HOME = join(fixture.root, 'agents-home');
  t.after(() => { if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    if (oldAgentsHome === undefined) delete process.env.DSH_AGENTS_HOME; else process.env.DSH_AGENTS_HOME = oldAgentsHome; });
  const api = await fixture.load(), requireInstalled = createRequire(join(installation, 'package.json'));
  const { Context } = await import(pathToFileURL(requireInstalled.resolve('@deepseek-ai/cordis')).href);
  const { default: LlmRuntime } = await import(pathToFileURL(requireInstalled.resolve('@deepseek-ai/dsh-llm')).href);
  const ctx = new Context(); t.after(() => ctx.fiber.dispose()); await ctx.plugin(LlmRuntime);
  let factories = 0, sends = 0;
  const connection = api.resolveAdapterOptions({ baseURL: http.url, thinking: 'disabled', maxTokens: 32,
    models: [{ id: MODEL, contextWindow: 1024, maxTokens: 32 }] });
  await ctx.plugin({ name: 'fixture-metered-route', inject: ['llm'], apply(child) {
    api.registerDeepSeekProvider(child, 'seam-test', { options: () => connection,
      resolveAuth: async () => ({ headers: { 'x-api-key': 'fixture-credential' } }),
      createTransport: options => { factories++; assert.equal(options.sessionId, 'registered');
        return { send(url, init) { sends++; return http.send(url, init); } }; },
    });
  } });
  const prepared = await ctx.llm.prepareCall({ provider: 'seam-test', model: MODEL, reasoningEffort: 'off', maxTokens: 32 });
  const output = await collect(prepared.stream({ ...request('registered'), ...prepared.config }));
  assert.equal(factories, 1); assert.equal(sends, 1); assert.equal(http.requests.length, 1);
  assert.equal(output.at(-1).reason.kind, 'stop');
});
