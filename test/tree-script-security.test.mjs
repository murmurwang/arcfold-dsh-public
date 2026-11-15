import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync, readFileSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { snapshotFixture } from './fixtures/tree-scripts/helpers.mjs';
import { method } from './fixtures/tree-domain/helpers.mjs';
import { ScriptArtifacts, MethodScriptBroker, validateArgSchema, normalizeArgs } from '../src/tree/scripts.mjs';
import { ScriptWriter } from '../src/tree/script-writer.mjs';
import { digest } from '../src/tree/contracts.mjs';
import { spawnConfined } from '../src/tree/host-process.mjs';

const schema = { type: 'object', properties: { target: { type: 'string', maxLength: 128 } }, required: ['target'], additionalProperties: false };
const args = { target: 'output.md' };
const source = 'console.log("algorithm fixture; actual OS execution is tested separately")';
test('bounded output preserves split UTF-8 characters and never expands invalid bytes beyond the shared cap', async t => {
  const f = snapshotFixture(t);
  const execute = (source, outputLimit) => spawnConfined({ enforcement: 'full', argv: [process.execPath, '-e', source] }, { cwd: f.workspace, runDirectory: f.runtimeRoot, outputLimit });
  // This tests the collector inside the engineering guard, not kernel policy.
  const split = await execute('const b=Buffer.from("你好");process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),30)', 100);
  assert.equal(split.stdout, '你好'); assert.equal(split.truncated, false);
  const invalid = await execute('process.stdout.write(Buffer.alloc(100,255));process.stderr.write("x".repeat(100))', 100);
  assert.equal(invalid.truncated, true); assert.equal(invalid.reason, 'output-limit'); assert.ok(Buffer.byteLength(invalid.stdout) + Buffer.byteLength(invalid.stderr) <= 100);
  const large = await execute('for(;;)if(!process.stdout.write("中文".repeat(65536)))await new Promise(resolve=>process.stdout.once("drain",resolve))', 131072);
  assert.equal(large.reason, 'output-limit'); assert.equal(large.truncated, true); assert.ok(Buffer.byteLength(large.stdout) <= 131072); assert.ok(!large.stdout.includes('\uFFFD'));
});
function fixture(t, { requests = 1 } = {}) {
  const f = snapshotFixture(t); f.asModel('learning');
  const methodId = f.propose(f.repo.rootId(), { methods: [{ ...method([f.ref]), scriptRequests: Array.from({ length: requests }, () => ({ purpose: '生成文件', evidence: ['fixture'], files: ['output.md'] })) }] }).methods.itemIds[0];
  const artifacts = new ScriptArtifacts({ repository: f.repo, directory: join(f.storageRoot, 'artifacts'), resolveSource: ref => digest(ref) === digest(f.ref), assertBuild: () => true /* synthetic control-only builder */ });
  let current = true, calls = 0; const scope = { phase: 'active', nodeIds: [f.repo.rootId()], epoch: 1, token: 'fixture', logicalTurnId: 'turn' };
  const runner = { enforcement: 'fixture-control-only', async run(options) { calls++; await options.assertCurrent(); await options.beforeSpawn?.({ profileHash: 'synthetic-control-only', readPaths: options.readPaths }); return { code: 0, stdout: 'synthetic control receipt', stderr: '', truncated: false, reason: null }; } };
  const writerOptions = index => ({ repository: f.repo, artifacts, workspaceIO: f.io, binding: { jobId: 'writer-' + index, methodId, draftVersion: 1, requestIndex: index, scriptId: 'script-' + index }, assertJob: () => current, runtimeRoot: f.runtimeRoot, protectedRoots: [f.storageRoot, f.repo.filename], runner, allowUnconfinedFixture: true });
  const writer = new ScriptWriter(writerOptions(0));
  function main() { f.asModel('main'); Object.assign(f.context, { sessionId: 'main-session', nativeToolCallId: 'call-1' }); }
  const brokerOptions = { repository: f.repo, artifacts, snapshots: f.snapshots, context: () => f.context, readScope: () => scope, resolveSource: artifacts.resolveSource,
    authorizeWrites: () => ({ paths: ['output.md'], authorizationRef: 'trusted-fixture-write' }), runtimeRoot: f.runtimeRoot, protectedRoots: [f.storageRoot, f.repo.filename], runner, allowUnconfinedFixture: true };
  const broker = new MethodScriptBroker(brokerOptions);
  const finishInput = { manifest: { entry: 'entry.mjs', files: ['entry.mjs'], argSchema: schema, dryRunSupport: true, usage: '将输入整理为 Markdown' }, verified: ['synthetic probe'], notVerified: ['真实写入尚未验证'] };
  async function finish(w = writer) { w.put({ relativePath: 'entry.mjs', content: source }); await w.probe({ entry: 'entry.mjs', args }); return w.finish(finishInput); }
  async function activate() { const artifact = await finish(); artifacts.activate({ methodId, draftVersion: 1, artifactIds: [artifact.id], requestId: 'activate' }); main(); return artifact; }
  return { ...f, methodId, artifacts, runner, writer, writerOptions, brokerOptions, broker, scope, main, finishInput, finish, activate, input: { methodId, expectedVersion: 2, scriptId: 'script-0', args }, stale: () => { current = false; }, get calls() { return calls; } };
}

test('closed argument schema has finite bounds, no references/coercion/regex or surplus authority fields', () => {
  assert.deepEqual(normalizeArgs(schema, args), args);
  for (const input of [{ ...args, cwd: '/' }, { target: 1 }, {}]) assert.throws(() => normalizeArgs(schema, input), { code: 'ARGS_INVALID' });
  for (const bad of [{ type: 'string', pattern: '.*' }, { $ref: 'file:///secret' }, { type: 'object', properties: {}, required: [], additionalProperties: true }, { type: 'array', items: schema, maxItems: 999 }]) assert.throws(() => validateArgSchema(bad));
});
test('writer has exactly six actual native tool definitions and no shell/edit; read/list/search honor content exclusions', async t => {
  const f = fixture(t), tools = []; f.writer.mount({ tools: { register: definition => tools.push(definition) } }, defineTool);
  assert.deepEqual(tools.map(t => t.name).sort(), ['writer_read', 'writer_list', 'writer_search', 'writer_put', 'writer_probe', 'writer_finish'].sort());
  writeFileSync(join(f.workspace, 'note.txt'), '你好\n方案已确认'); writeFileSync(join(f.workspace, '.env'), 'never reveal synthetic secret'); symlinkSync(f.storageRoot, join(f.workspace, 'escape'));
  assert.equal((await f.writer.read({ relativePath: 'note.txt', offset: 0, limit: 2 })).content, '你好');
  assert.deepEqual((await f.writer.list()).files.map(f => f.path), ['note.txt']); assert.equal((await f.writer.search({ query: '已确认' })).matches[0].line, 2);
  await assert.rejects(f.writer.read({ relativePath: '.env' }), { code: 'WRITER_READ_DENIED' }); await assert.rejects(f.writer.read({ relativePath: '../tree.sqlite' }), { code: 'SNAPSHOT_PATH' });
});
test('artifact drafts enforce CAS, bounded UTF-8 .mjs files, 16-file/256-KiB caps and immutable bytes', t => {
  const f = fixture(t), first = f.writer.put({ relativePath: 'entry.mjs', content: source });
  assert.throws(() => f.writer.put({ relativePath: 'entry.mjs', content: 'replacement' }), { code: 'ARTIFACT_CONFLICT' });
  f.writer.put({ relativePath: 'entry.mjs', content: 'new source', expectedHash: first.sha256 });
  for (const path of ['../escape.mjs', '/tmp/escape.mjs', 'bad.js', '.arcfold-loader.mjs']) assert.throws(() => f.writer.put({ relativePath: path, content: source }));
  assert.throws(() => f.writer.put({ relativePath: 'binary.mjs', content: '\0' }), { code: 'ARTIFACT_CONTENT' });
  assert.throws(() => f.writer.put({ relativePath: 'large.mjs', content: 'a'.repeat(262145) }), { code: 'ARTIFACT_LIMIT' });
  for (let n = 1; n < 16; n++) f.writer.put({ relativePath: `part${n}.mjs`, content: source });
  assert.throws(() => f.writer.put({ relativePath: 'too-many.mjs', content: source }), { code: 'ARTIFACT_LIMIT' });
  const file = f.writer.draft().files[0]; rmSync(f.artifacts.sourcePath(file.sha256)); symlinkSync(join(f.workspace, 'other.mjs'), f.artifacts.sourcePath(file.sha256)); assert.throws(() => f.artifacts.read(file));
});
test('finish requires a successful probe of exact current files and valid args; generated claims never prove writes', async t => {
  const f = fixture(t); const file = f.writer.put({ relativePath: 'entry.mjs', content: source });
  assert.throws(() => f.writer.finish(f.finishInput), { code: 'PROBE_REQUIRED' }); await f.writer.probe({ entry: 'entry.mjs', args });
  f.writer.put({ relativePath: 'entry.mjs', content: source + ';', expectedHash: file.sha256 }); assert.throws(() => f.writer.finish(f.finishInput), { code: 'PROBE_REQUIRED' });
  await f.writer.probe({ entry: 'entry.mjs', args }); const artifact = f.writer.finish(f.finishInput); assert.ok(artifact.notVerified.some(v => v.includes('Real write'))); assert.equal(f.writer.finish(f.finishInput).id, artifact.id);
  assert.throws(() => f.writer.put({ relativePath: 'another.mjs', content: source }), { code: 'WRITER_FINISHED' }); assert.throws(() => f.writer.verifyFinal({ files: [{ name: 'wrong.mjs' }], usage: artifact.usage }), { code: 'WRITER_FINAL_MISMATCH' });
  const final = f.writer.completionTemplate();
  assert.equal(f.writer.verifyFinal(final).artifactId, artifact.id);
  assert.throws(() => f.writer.verifyFinal({ ...final, usage: final.usage + ' (paraphrased)' }), { code: 'WRITER_FINAL_MISMATCH' });
  assert.deepEqual(final.verified, artifact.verified); assert.ok(final.notVerified.some(v => v.includes('Real write')));
});
test('a writer cannot seal more limitations than its final report can retain', async t => {
  const f = fixture(t); f.writer.put({ relativePath: 'entry.mjs', content: source }); await f.writer.probe({ entry: 'entry.mjs', args });
  const notes = Array.from({ length: 20 }, (_, index) => `尚未检验的不同条件${index}`);
  assert.throws(() => f.writer.finish({ ...f.finishInput, notVerified: notes }), { code: 'WRITER_MANIFEST' });
  assert.equal(f.writer.draft().state, 'open'); assert.equal(f.repo.list('tree_script_artifacts').length, 0);
  // The author explicitly combines two conditions; the host drops none.
  const combined = [...notes.slice(0, 18), notes.slice(18).join('；')];
  f.writer.finish({ ...f.finishInput, notVerified: combined });
  const report = f.writer.completionTemplate(); assert.equal(report.notVerified.length, 20);
  assert.ok(report.notVerified.some(text => text.includes(notes[18]) && text.includes(notes[19])));
});
test('writer finish explains bounded schemas and can correct a rejected manifest without another probe', async t => {
  const f = fixture(t), tools = []; f.writer.mount({ tools: { register: definition => tools.push(definition) } }, defineTool);
  const finishTool = tools.find(tool => tool.name === 'writer_finish');
  assert.match(finishTool.description, /maxLength/); assert.match(finishTool.description, /additionalProperties/);
  f.writer.put({ relativePath: 'entry.mjs', content: source }); await f.writer.probe({ entry: 'entry.mjs', args });
  const input = structuredClone(f.finishInput); delete input.manifest.argSchema.properties.target.maxLength;
  assert.throws(() => f.writer.finish(input), error => error.code === 'ARG_SCHEMA' && /requires integer maxLength/.test(error.message));
  input.manifest.argSchema.properties.target = { type: 'string', maxLength: 128, minLength: 1 };
  assert.throws(() => f.writer.finish(input), error => error.code === 'ARG_SCHEMA' && /allowed:/.test(error.message));
  assert.ok(f.writer.finish(f.finishInput).id); assert.equal(f.calls, 1);
});
test('all script requests activate atomically; one missing/mutated artifact leaves method draft', async t => {
  const f = fixture(t, { requests: 2 }), a = await f.finish();
  assert.throws(() => f.artifacts.activate({ methodId: f.methodId, draftVersion: 1, artifactIds: [a.id], requestId: 'incomplete' }), { code: 'BUNDLE_INCOMPLETE' });
  const writer2 = new ScriptWriter(f.writerOptions(1)), b = await f.finish(writer2); f.artifacts.activate({ methodId: f.methodId, draftVersion: 1, artifactIds: [a.id, b.id], requestId: 'complete' });
  assert.equal(f.repo.get('tree_items', f.methodId).activeVersion, 2); assert.equal(f.repo.get('tree_methods', digest(['method', f.methodId, 2])).scripts.length, 2);
});
test('unfinished native build and concurrent draft edits cannot be silently accepted', async t => {
  const f = fixture(t), other = new ScriptWriter(f.writerOptions(0)), put = f.artifacts.put.bind(f.artifacts); let interleaved = false;
  f.artifacts.put = content => { const result = put(content); if (!interleaved) { interleaved = true; other.put({ relativePath: 'concurrent.mjs', content: source }); } return result; };
  assert.throws(() => f.writer.put({ relativePath: 'stale.mjs', content: source }), { code: 'ARTIFACT_CONFLICT' }); assert.deepEqual(f.writer.draft().files.map(f => f.path), ['concurrent.mjs']);
  const g = fixture(t), artifact = await g.finish(); g.artifacts.assertBuild = () => false;
  assert.throws(() => g.artifacts.activate({ methodId: g.methodId, draftVersion: 1, artifactIds: [artifact.id], requestId: 'unfinished-job' }), { code: 'ARTIFACT_BUILD_REQUIRED' }); assert.equal(g.repo.get('tree_items', g.methodId).lifecycle, 'draft');
});
test('broker snapshots exact writes, persists intent before body, deduplicates native tool calls and retains revoked history', async t => {
  const f = fixture(t); await f.activate(); writeFileSync(join(f.workspace, 'output.md'), 'before'); const calls = f.calls;
  f.runner.run = async options => { await options.assertCurrent(); await options.beforeSpawn({ profileHash: 'synthetic', readPaths: options.readPaths }); const row = f.repo.list('tree_script_runs')[0]; assert.equal(row.state, 'spawn_intent'); assert.ok(f.repo.get('tree_snapshots', row.snapshotId)); return { code: 0, reason: null, stdout: 'body receipt', stderr: '', truncated: false }; };
  const run = await f.broker.run(f.input); assert.equal(run.state, 'succeeded'); assert.equal(run.result.stdout, 'body receipt'); assert.equal((await f.broker.run(f.input)).id, run.id); assert.equal(f.repo.list('tree_script_runs').length, 1);
  f.asUser(); f.items.withdraw(f.cmd({ itemId: f.methodId, version: 2, reason: '不再采用' }, f.expected('tree_items', f.methodId))); f.main(); f.context.nativeToolCallId = 'call-2';
  await assert.rejects(f.broker.run(f.input), { code: 'METHOD_STALE' }); assert.equal(f.repo.get('tree_script_runs', run.id).result.stdout, 'body receipt');
});
test('main identity, scope, schema and read-only policy reject before body; unsafe targets reject before run intent', async t => {
  const f = fixture(t); await f.activate();
  f.asModel('learning'); await assert.rejects(f.broker.run(f.input), { code: 'MAIN_REQUIRED' }); f.main();
  await assert.rejects(f.broker.run({ ...f.input, cwd: '/' }), { code: 'INVALID_SHAPE' });
  f.context.sessionPolicy.mode = 'read-only'; await assert.rejects(f.broker.run(f.input), { code: 'SCRIPT_POLICY' }); f.context.sessionPolicy.mode = 'workspace-write';
  f.scope.phase = 'leaving'; await assert.rejects(f.broker.run(f.input), { code: 'SCOPE_STALE' }); f.scope.phase = 'active';
  f.broker.authorizeWrites = () => ({ paths: ['.env'], authorizationRef: 'invalid-target' }); writeFileSync(join(f.workspace, '.env'), 'private');
  await assert.rejects(f.broker.run(f.input), { code: 'SNAPSHOT_UNCOVERED' }); assert.equal(f.repo.list('tree_script_runs').length, 0);
});
test('scope changes during capture leave body zero; spawn uncertainty is retained and never re-executed', async t => {
  const f = fixture(t); await f.activate(); const capture = f.snapshots.captureLocked.bind(f.snapshots), calls = f.calls;
  f.snapshots.captureLocked = async command => { const value = await capture(command); f.scope.epoch++; return value; };
  await assert.rejects(f.broker.run(f.input), { code: 'SCRIPT_STALE' }); assert.equal(f.calls, calls); assert.equal(f.repo.list('tree_script_runs').length, 0);
  f.snapshots.captureLocked = capture; f.context.nativeToolCallId = 'unknown-call'; let bodies = 0;
  f.runner.run = async options => { await options.beforeSpawn({ profileHash: 'synthetic' }); bodies++; throw new Error('Synthetic unobserved process result'); };
  const run = await f.broker.run(f.input); assert.equal(run.state, 'unknown'); assert.equal(f.broker.recover(run.id).state, 'unknown'); await f.broker.run(f.input); assert.equal(bodies, 1);
  f.context.nativeToolCallId = 'must-not-race-unknown'; await assert.rejects(f.broker.run(f.input), { code: 'SCRIPT_PENDING' });
  f.asUser(); await assert.rejects(f.snapshots.preview({ snapshotId: run.snapshotId, requestId: 'unsafe-preview' }), { code: 'SCRIPT_PENDING' });
});
test('withdrawal cancels the owned active process signal and preserves its result', async t => {
  const f = fixture(t); await f.activate(); let body = 0;
  f.runner.run = async options => { await options.beforeSpawn({ profileHash: 'synthetic' }); body++; f.asUser(); f.items.withdraw(f.cmd({ itemId: f.methodId, version: 2, reason: '停止' }, f.expected('tree_items', f.methodId))); f.main(); f.broker.invalidate(); assert.equal(options.signal.aborted, true); return { code: null, reason: 'cancelled', stdout: 'partial result', stderr: '', truncated: false }; };
  const run = await f.broker.run(f.input); assert.equal(body, 1); assert.equal(run.state, 'revoked'); assert.equal(run.result.stdout, 'partial result');
});
