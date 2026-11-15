// Execute only in an explicitly staged private copy, outside the engineering
// runner's own OS fence (macOS cannot nest these profiles). No real model/key.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootstrapFixture } from './bootstrap.mjs';
import { emptyLearning, emptyVerification } from '../tree-learning/helpers.mjs';
import { ItemService } from '../../../src/tree/items.mjs';
import { method } from '../tree-domain/helpers.mjs';
import { digest } from '../../../src/tree/contracts.mjs';

assert.equal(process.platform, 'darwin');
assert.equal(process.env.ARCFOLD_B7_SYNTHETIC_OS_CHAIN, '1');
const afters = [], t = { after: fn => afters.push(fn), diagnostic: message => console.log(message) };
const args = { input: 'tasks.json', output: 'tasks.md' }, usage = '--input <JSON文件> [--dry-run]';
const generated = `import { readFileSync, writeFileSync } from 'node:fs';
const args = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--input') + 1], 'utf8'));
const tasks = JSON.parse(readFileSync(args.input, 'utf8'));
const result = '# 今日任务\\n\\n' + tasks.map(t => '- [' + (t.done ? 'x' : ' ') + '] ' + t.title).join('\\n') + '\\n';
if (!process.argv.includes('--dry-run')) writeFileSync(args.output, result);
console.log(result);
`;
const argSchema = { type: 'object', properties: { input: { type: 'string', maxLength: 128 }, output: { type: 'string', maxLength: 128 } }, required: ['input', 'output'], additionalProperties: false };
const writerCalls = [
  { name: 'writer_read', args: { relativePath: 'tasks.json' } },
  { name: 'writer_put', args: { relativePath: 'tasks.mjs', content: generated } },
  { name: 'writer_probe', args: { entry: 'tasks.mjs', args } },
  { name: 'writer_finish', args: { manifest: { entry: 'tasks.mjs', files: ['tasks.mjs'], argSchema, dryRunSupport: true, usage, writePaths: ['tasks.md'] }, verified: ['只读试运行'], notVerified: ['真实写入待用户授权执行'] } },
];
let phase = 'create', mainStep = 0, writerStep = 0, target;
const f = await bootstrapFixture(t, row => {
  if (row.role === 'attribution') return { actions: [{ action: 'continue', nodeId: row.input.scope.nodeIds[0] }], statusChanges: [] };
  if (row.role === 'learning') return emptyLearning();
  if (row.role === 'verification') return emptyVerification();
  if (row.role === 'script_writer') {
    const call = writerCalls[writerStep++];
    return call ? { tool: { ...call, id: 'writer-' + writerStep } } : { files: [{ name: 'tasks.mjs', purpose: '整理合成任务' }], usage, stepsText: '读 JSON，再生成 Markdown。', verified: ['只读试运行'], notVerified: ['真实写入尚未由作者试验'], problems: '' };
  }
  if (row.role !== 'main') throw new Error('Unexpected role ' + row.role);
  mainStep++;
  if (phase === 'create' && mainStep === 1) {
    const authority = row.body.messages.flatMap(m => m.content ?? []).flatMap(b => { try { return b.type === 'text' ? [JSON.parse(b.text)] : []; } catch { return []; } }).findLast(v => v.logicalTurnId);
    assert.ok(authority?.evidence.length, 'Evidence must be supplied in the actual request');
    return { tool: { id: 'request-new-script', name: 'arcfold_request_script', args: { purpose: '读取 tasks.json，新写一个以后可重复使用的同步 Markdown 脚本。', evidenceIds: [authority.evidence[0].id], fileRefs: [] } } };
  }
  if (phase === 'run' && mainStep === 1) return { tool: { id: 'read-method', name: 'arcfold_read_method', args: { methodId: target.methodId, expectedVersion: 2 } } };
  if (phase === 'run' && mainStep === 2 || phase === 'blocked' && mainStep === 1) return { tool: { id: phase + '-script', name: 'arcfold_run_method_script', args: target } };
  return '本轮合成任务已按实际工具回执结束。';
}, { nativeHost: true });
let failure;
try {
  writeFileSync(join(f.workspace, 'tasks.json'), JSON.stringify([{ title: '核对证据', done: true }, { title: '整理结果', done: false }]));
  const original = '原始手写清单\n'; writeFileSync(join(f.workspace, 'tasks.md'), original);
  writeFileSync(join(f.privateRoot, 'secret'), 'B7_SYNTHETIC_PRIVATE_CANARY');
  const agent = await f.main('b7-os-main');
  const creation = await f.turn(agent, '只写一个脚本，把 tasks.json 同步成 tasks.md；现在先做只读试运行。');
  assert.equal(creation.status, 'settled', JSON.stringify(f.repo.meta().runtimeDiagnostics));
  const job = f.repo.list('tree_jobs', j => j.role === 'script_writer')[0];
  assert.equal(job?.status, 'committed', JSON.stringify(job));
  const item = f.repo.get('tree_items', job.input.binding.methodId), artifact = f.repo.get('tree_script_artifacts', job.resultRef.artifactId);
  assert.equal(item.lifecycle, 'active'); assert.equal(item.activeVersion, 2);
  assert.deepEqual(artifact.writePaths, ['tasks.md']); assert.equal(readFileSync(join(f.workspace, 'tasks.md'), 'utf8'), original);
  assert.equal(f.repo.list('tree_turns').length, 1, 'Writer completion cannot create a human turn');
  target = { methodId: item.id, expectedVersion: 2, scriptId: artifact.scriptId, args };
  phase = 'run'; mainStep = 0;
  const executed = await f.turn(agent, '现在用刚才的脚本实际更新这个合成工作区的 tasks.md。');
  assert.equal(executed.status, 'settled');
  const run = f.repo.list('tree_script_runs')[0]; assert.equal(run?.state, 'succeeded', JSON.stringify({ run, diagnostics: f.repo.meta().runtimeDiagnostics }));
  assert.equal(readFileSync(join(f.workspace, 'tasks.md'), 'utf8'), '# 今日任务\n\n- [x] 核对证据\n- [ ] 整理结果\n');
  const privateTarget = await f.ctx.fs.resolve(join(f.privateRoot, 'secret')).catch(() => null);
  if (privateTarget) await assert.rejects(f.ctx.fs.readText(privateTarget));
  const scriptTarget = await f.ctx.fs.resolve(artifact.files[0].sourcePath).catch(() => null);
  if (scriptTarget) await assert.rejects(f.ctx.fs.readText(scriptTarget));
  const items = new ItemService({ repository: f.repo, resolveSource: f.runtime.resolveSource, context: () => ({ actor: { kind: 'program', id: 'synthetic-hook' } }) });
  items.commitProposal({ requestId: 'deny-second-script', expected: {}, input: { nodeId: executed.nodeIds[0], understandings: [], supplements: [], methods: [{ ...method(executed.userSourceRefs), hooks: [{ moment: 'before_tool', conditions: [{ field: 'toolName', op: 'equals', value: 'arcfold_run_method_script' }], action: 'block', message: '合成验收：禁止第二次执行' }] }] } });
  phase = 'blocked'; mainStep = 0; await f.turn(agent, '尝试被钩子禁止的第二次执行。');
  assert.equal(f.repo.list('tree_script_runs').length, 1, 'Denied tool body must not enter the broker');
  const context = { actor: { kind: 'user', id: f.repo.userId }, sessionId: agent.session.id, signal: new AbortController().signal };
  const preview = await f.runtime.ui.dispatch('snapshots.preview', { requestId: 'os-preview', snapshotId: run.snapshotId, paths: ['tasks.md'] }, context);
  const restored = await f.runtime.ui.dispatch('snapshots.restore', { requestId: 'os-restore', previewId: preview.value.id, expectedHashes: preview.value.expectedCurrentHashes }, context);
  assert.equal(restored.state, 'success'); assert.equal(readFileSync(join(f.workspace, 'tasks.md'), 'utf8'), original);
  writeFileSync(join(f.root, 'os-chain-result.json'), JSON.stringify({ passed: true, source: 'full production composition, actual macOS restriction, synthetic loopback provider', generatedHash: digest(generated), creation, executed, writerJobId: job.id, artifact, run, preview, restored, requestCount: f.requests.length, humanTurns: f.repo.list('tree_turns').length, actualExternalSpentCny: 0 }, null, 2));
  console.log('B7 actual OS chain passed: ' + f.root);
} catch (error) {
  failure = error; writeFileSync(join(f.root, 'os-chain-failure.json'), JSON.stringify({ error: { code: error.code, message: error.message, stack: error.stack }, jobs: f.repo.list('tree_jobs'), diagnostics: f.repo.meta().runtimeDiagnostics }, null, 2));
} finally { for (const close of afters.reverse()) await close(); }
if (failure) throw failure;
