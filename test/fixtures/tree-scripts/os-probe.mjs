// Run only as an outer Mac probe against an immutable isolated source copy.
// No API keys or external provider calls: the native model transport is loopback.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { nativeFixture } from '../tree-model/native.mjs';
import { method } from '../tree-domain/helpers.mjs';
import { ItemService } from '../../../src/tree/items.mjs';
import { SnapshotService, ConfinedWorkspaceIO } from '../../../src/tree/snapshots.mjs';
import { ScriptArtifacts, ConfinedScriptRunner, MethodScriptBroker, mountMethodScriptTool } from '../../../src/tree/scripts.mjs';
import { ScriptWriter } from '../../../src/tree/script-writer.mjs';
import { contentHash, processPolicy, confinedArgv, spawnConfined } from '../../../src/tree/host-process.mjs';
import { digest } from '../../../src/tree/contracts.mjs';

assert.equal(process.platform, 'darwin', 'Linux is deferred and must remain fail-closed');
const sourceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const sourceFiles = ['scripts.mjs', 'script-writer.mjs', 'snapshots.mjs', 'hooks.mjs', 'host-context.mjs', 'host-process.mjs'];
const sourceHashes = () => Object.fromEntries(sourceFiles.map(name => [name, contentHash(readFileSync(join(sourceRoot, 'src/tree', name)))]));
const before = sourceHashes(), afters = [], cases = [], t = { after: f => afters.push(f), diagnostic: message => console.log(message) };
const schema = { type: 'object', properties: { input: { type: 'string', maxLength: 128 }, output: { type: 'string', maxLength: 128 } }, required: ['input', 'output'], additionalProperties: false };
const args = { input: 'tasks.json', output: 'tasks.md' }, usage = '从任务 JSON 生成 Markdown；--dry-run 只显示预览。';
// New bytes arrive in a genuine native writer tool call, then execute through
// the broker. This is mechanism evidence, not a claim about real model quality.
const generated = `import { readFileSync, writeFileSync } from 'node:fs';\nconst args = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--input') + 1], 'utf8'));\nconst tasks = JSON.parse(readFileSync(args.input, 'utf8'));\nconst result = '# 今日任务\\n\\n' + tasks.map(t => '- [' + (t.done ? 'x' : ' ') + '] ' + t.title).join('\\n') + '\\n';\nif (!process.argv.includes('--dry-run')) writeFileSync(args.output, result);\nconsole.log(result);\n`;
const final = { files: [{ name: 'tasks.mjs', purpose: '转换任务清单' }], usage, stepsText: '读取任务，生成 Markdown，写入指定文件。', verified: ['只读试运行显示了任务清单'], notVerified: ['真实写入由后续工程验收验证'], problems: '' };
const calls = [
  { name: 'writer_read', args: { relativePath: 'tasks.json' } },
  { name: 'writer_put', args: { relativePath: 'tasks.mjs', content: generated } },
  { name: 'writer_probe', args: { entry: 'tasks.mjs', args } },
  { name: 'writer_finish', args: { manifest: { entry: 'tasks.mjs', files: ['tasks.mjs'], argSchema: schema, dryRunSupport: true, usage }, verified: final.verified, notVerified: final.notVerified } },
];
let mainScriptInput = null, mainToolIssued = false;
const f = await nativeFixture(t, ({ role, ordinal }) => {
  if (role === 'main') { if (mainScriptInput && !mainToolIssued) { mainToolIssued = true; return { tool: { name: 'arcfold_run_method_script', args: mainScriptInput, id: 'actual-new-script-call' } }; } return '其它会话仍正常回答。'; }
  return ordinal <= calls.length ? { tool: { ...calls[ordinal - 1], id: 'writer-call-' + ordinal } } : final;
});
const workspace = join(f.root, 'workspace'), storageRoot = join(workspace, 'private'), runtimeRoot = join(f.root, 'runtime');
for (const path of [workspace, storageRoot, runtimeRoot]) mkdirSync(path, { recursive: true, mode: 0o700 });
const protectedRoots = [storageRoot, f.repo.filename], context = { actor: { kind: 'model', role: 'learning', id: 'fixture' }, nodeIds: [f.repo.rootId()], sessionPolicy: { mode: 'danger-full-access', workspaceRoot: workspace, additionalWritableRoots: ['/'] } };
const ref = { sessionId: 'synthetic-user', seq: 0, sha256: contentHash('synthetic request') };
const resolveSource = value => digest(value) === digest(ref) ? { role: 'user', origin: 'user', text: '把任务整理成 Markdown', sha256: ref.sha256 } : null;
const items = new ItemService({ repository: f.repo, context: () => context, resolveSource });
const methodId = items.commitProposal({ requestId: 'synthetic-method-request', expected: {}, input: { nodeId: f.repo.rootId(), understandings: [], supplements: [], methods: [{ ...method([ref]), scriptRequests: [{ purpose: '任务清单生成', evidence: ['synthetic-request'], files: ['tasks.json', 'tasks.md'] }] }] } }).result.methods.itemIds[0];
const artifacts = new ScriptArtifacts({ repository: f.repo, directory: join(storageRoot, 'artifacts'), resolveSource });
const io = new ConfinedWorkspaceIO({ workspace, runtimeRoot, protectedRoots }), runner = new ConfinedScriptRunner();
const snapshots = new SnapshotService({ repository: f.repo, workspace, storageRoot, runtimeRoot, protectedRoots, context: () => context, io });
writeFileSync(join(workspace, 'tasks.json'), JSON.stringify([{ title: '核对工程证据', done: true }, { title: '整理验收说明', done: false }]));
writeFileSync(join(workspace, 'tasks.md'), '原始手写清单\n'); writeFileSync(join(storageRoot, 'secret'), 'SYNTHETIC_SECRET_CANARY'); writeFileSync(join(workspace, '.env'), 'SYNTHETIC_WORKSPACE_SECRET'); symlinkSync(storageRoot, join(workspace, 'escape'));
const git = argv => execFileSync('/usr/bin/git', ['-C', workspace, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', ...argv], { encoding: 'utf8' }).trim();
git(['init', '-q']); git(['add', 'tasks.json', 'tasks.md']); git(['commit', '-qm', 'Synthetic user history']); const gitHead = git(['rev-parse', 'HEAD']), gitIndex = contentHash(readFileSync(join(workspace, '.git/index')));
const job = f.enqueue('script_writer');
const writer = new ScriptWriter({ repository: f.repo, artifacts, workspaceIO: io, binding: { jobId: job.id, methodId, draftVersion: 1, requestIndex: 0, scriptId: 'new-tasks-script' },
  assertJob: id => { const current = f.jobs.get(id); f.jobs.assertCurrent(current); return ['prepared', 'submitted', 'result_received', 'validated'].includes(current.status); }, runtimeRoot, protectedRoots, runner });
f.owner.mountWriterTools = agent => writer.mount(agent, defineTool); f.owner.applyResult = (result, { job }) => job.role === 'script_writer' ? writer.verifyFinal(result) : {};
const scope = { phase: 'active', epoch: 1, token: 'scope-one', nodeIds: [f.repo.rootId()], logicalTurnId: 'turn-one' };
const broker = new MethodScriptBroker({ repository: f.repo, artifacts, snapshots, context: () => context, readScope: () => scope, resolveSource, authorizeWrites: () => ({ paths: ['tasks.md'], authorizationRef: 'explicit-synthetic-fixture-write' }), runtimeRoot, protectedRoots, runner });
const attach = f.owner.attachMain.bind(f.owner);
f.owner.attachMain = agentContext => { attach(agentContext); mountMethodScriptTool(agentContext, { host: f.ctx, defineTool, isMain: id => f.owner.jobFor(id).role === 'main', resolveBroker: native => {
  Object.assign(context, { actor: { kind: 'model', role: 'main', id: native.agent.id }, sessionId: native.sessionId, nativeToolCallId: native.callId }); return broker;
} }); };
async function nativeMain(sessionId) {
  const job = f.enqueue('main', { trigger: { nativeSessionId: sessionId } }); f.jobs.prepare(job.id); f.jobs.submit(job.id);
  const config = job.modelConfig, handle = await f.ctx.agents.create({ sessionId, agentOptions: { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort, maxTokens: config.maxTokens }, setup: agentContext => f.owner.attachMain(agentContext) }); f.handles.push(handle);
  handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '执行已授权的合成文件任务。' }] })); await handle.agent.whenIdle(); assert.equal(await f.ctx.sessions.flush(handle.agent.session), true);
  return f.owner.consume(job.id, await f.owner.readEvents(sessionId, handle));
}
const tcp = createServer(socket => socket.end()); await new Promise(resolve => tcp.listen(0, '127.0.0.1', resolve));
const reportPath = join(f.root, 'B4-os-evidence.json');
let failure;
try {
  const result = await f.owner.run(job.id); assert.equal(result.status, 'committed', JSON.stringify(result));
  const artifact = f.repo.list('tree_script_artifacts')[0]; assert.ok(artifact); assert.equal(readFileSync(join(workspace, 'tasks.md'), 'utf8'), '原始手写清单\n');
  assert.equal(f.requests.filter(r => r.role === 'script_writer').length, 5); assert.deepEqual(new Set(f.requests[0].body.tools.map(t => t.name)), new Set(['writer_read', 'writer_list', 'writer_search', 'writer_put', 'writer_probe', 'writer_finish']));
  artifacts.activate({ methodId, draftVersion: 1, artifactIds: [artifact.id], requestId: 'activate-real-artifact' });
  mainScriptInput = { methodId, expectedVersion: 2, scriptId: artifact.scriptId, args }; const mainJob = await nativeMain('script-main-session'); assert.equal(mainJob.status, 'committed');
  const run = f.repo.list('tree_script_runs')[0]; assert.ok(run, 'Actual native main tool did not enter broker');
  assert.equal(run.state, 'succeeded', JSON.stringify(run)); assert.equal(readFileSync(join(workspace, 'tasks.md'), 'utf8'), '# 今日任务\n\n- [x] 核对工程证据\n- [ ] 整理验收说明\n');
  cases.push({ label: 'native-writer-new-artifact-real-write', jobId: job.id, artifact, run, probe: writer.draft().probes });
  context.actor = { kind: 'user', id: 'fixture-user' };
  const preview = await snapshots.preview({ snapshotId: run.snapshotId, requestId: 'user-preview', paths: ['tasks.md'] });
  const restored = await snapshots.apply({ previewId: preview.id, expectedCurrentHashes: preview.expectedCurrentHashes, requestId: 'user-restore' });
  assert.equal(restored.state, 'completed', JSON.stringify(restored)); assert.equal(readFileSync(join(workspace, 'tasks.md'), 'utf8'), '原始手写清单\n'); assert.equal(git(['rev-parse', 'HEAD']), gitHead); assert.equal(contentHash(readFileSync(join(workspace, '.git/index'))), gitIndex);
  cases.push({ label: 'real-confined-snapshot-preview-restore', preview, restored, gitHead, gitIndex });
  const policy = processPolicy({ workspace, runtimeRoot, protectedRoots, sessionPolicy: context.sessionPolicy, authorizedWriteRoots: [workspace] });
  function makeArtifact(source) { const file = { path: 'attack.mjs', ...artifacts.put(source) }; return { language: 'node-esm', entry: file.path, files: [file], argSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } }; }
  const attack = makeArtifact(readFileSync(new URL('../tree-host/os-body.mjs', import.meta.url), 'utf8'));
  for (const [label, input, readOnly] of [
    ['private-canary-read', { op: 'read', path: join(storageRoot, 'secret') }], ['workspace-credential-read', { op: 'read', path: join(workspace, '.env') }],
    ['private-symlink-read', { op: 'read', path: join(workspace, 'escape/secret') }], ['protected-write', { op: 'write', path: join(storageRoot, 'illegal') }],
    ['network-denied', { op: 'network', port: tcp.address().port }], ['host-signal-denied', { op: 'signal', pid: process.pid }], ['child-process-denied', { op: 'child-write', path: join(workspace, 'child-file') }],
    ['malicious-dry-run-denied', { op: 'write', path: join(workspace, 'dry-file') }, true],
  ]) {
    const value = await runner.run({ artifact: attack, args: input, artifacts, policy, readPaths: ['tasks.json', 'tasks.md'], readOnly, timeoutMs: 4000, assertCurrent: () => {} });
    assert.ok(value.stdout.includes('body-entered'), JSON.stringify(value)); assert.ok(value.stdout.includes('effect-denied'), JSON.stringify(value)); assert.equal(value.code, 13); cases.push({ label, ...value });
  }
  const privatePath = artifacts.sourcePath(artifact.files[0].sha256);
  const bypass = await spawnConfined(confinedArgv({ policy, kind: 'main', argv: [process.execPath, '-e', 'require("node:fs").readFileSync(process.argv[1])', privatePath] }), { cwd: workspace, runDirectory: workspace });
  assert.notEqual(bypass.code, 0); cases.push({ label: 'ordinary-tool-private-artifact-denied', ...bypass });
  writeFileSync(join(workspace, 'external.mjs'), 'console.log("DEPENDENCY_RAN")');
  const dependency = await runner.run({ artifact: makeArtifact('await import(process.cwd() + "/external.mjs")'), args: {}, artifacts, policy, readPaths: ['external.mjs'], assertCurrent: () => {} });
  cases.push({ label: 'external-module-resolution-denied', ...dependency }); assert.notEqual(dependency.code, 0); assert.ok(dependency.stderr.includes('SCRIPT_DEPENDENCY_DENIED'), JSON.stringify(dependency));
  const looping = makeArtifact('console.log(JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);');
  for (const cancelled of [false, true]) {
    const abort = new AbortController(), timer = cancelled ? setTimeout(() => abort.abort(), 200) : null;
    const value = await runner.run({ artifact: looping, args: {}, artifacts, policy, readPaths: [], timeoutMs: cancelled ? 5000 : 200, signal: abort.signal, assertCurrent: () => {} }); if (timer) clearTimeout(timer);
    assert.equal(value.reason, cancelled ? 'cancelled' : 'timeout'); const pid = JSON.parse(value.stdout.trim()).pid; assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }); cases.push({ label: cancelled ? 'owned-cancellation-cleanup' : 'owned-timeout-cleanup', ...value });
  }
  const overflow = await runner.run({ artifact: makeArtifact('for(;;)if(!process.stdout.write("x".repeat(65536)))await new Promise(resolve=>process.stdout.once("drain",resolve));'), args: {}, artifacts, policy, readPaths: [], assertCurrent: () => {} });
  cases.push({ label: 'output-bounded', ...overflow, stdout: '[bounded synthetic output omitted]', capturedBytes: Buffer.byteLength(overflow.stdout) + Buffer.byteLength(overflow.stderr) });
  assert.equal(overflow.reason, 'output-limit', JSON.stringify({ ...overflow, stdout: '[omitted]' })); assert.equal(overflow.truncated, true); assert.equal(Buffer.byteLength(overflow.stdout) + Buffer.byteLength(overflow.stderr), 1048576);
  const other = await nativeMain('other-unaffected-session'); assert.equal(other.status, 'committed'); cases.push({ label: 'other-native-session-survives', jobId: other.id, status: other.status });
  assert.throws(() => confinedArgv({ policy, runDirectory: runtimeRoot, argv: [process.execPath], platform: 'linux' }), { code: 'SANDBOX_UNAVAILABLE' });
  context.actor = { kind: 'user', id: 'fixture-user' }; const item = f.repo.get('tree_items', methodId);
  items.withdraw({ requestId: 'withdraw-artifact', expected: { ['tree_items:' + methodId]: item.revision }, input: { itemId: methodId, version: 2, reason: 'fixture finished' } });
  Object.assign(context, { actor: { kind: 'model', role: 'main', id: 'actual-main-tool-fixture' }, nativeToolCallId: 'withdrawn-call' });
  await assert.rejects(broker.run({ methodId, expectedVersion: 2, scriptId: artifact.scriptId, args }), { code: 'METHOD_STALE' }); assert.equal(f.repo.get('tree_script_runs', run.id).result.stdout, run.result.stdout);
  cases.push({ label: 'withdrawal-refuses-future-run-retains-history', runId: run.id });
} catch (error) { failure = { message: error.message, stack: error.stack, code: error.code }; process.exitCode = 1; }
finally {
  assert.deepEqual(sourceHashes(), before, 'Frozen source changed during OS probe');
  writeFileSync(reportPath, JSON.stringify({ kind: 'actual-macos-confinement-native-writer-loopback-model', sourceRoot, sourceHashes: before, node: process.version, platform: process.platform, cases, failure: failure ?? null, realCost: { currency: 'CNY', spent: 0, reserved: 0, unknown: 0 }, syntheticLedger: f.ledger.summary(), linux: 'deferred-by-user-fail-closed' }, null, 2));
  tcp.closeAllConnections?.(); await new Promise(resolve => tcp.close(resolve));
  for (const close of afters.reverse()) await close();
  console.log(JSON.stringify({ reportPath, passed: !failure, cases: cases.length, failure }));
}
