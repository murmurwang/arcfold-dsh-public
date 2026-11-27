import test from 'node:test';
import assert from 'node:assert/strict';
import { learningFixture, emptyLearning } from './fixtures/tree-learning/helpers.mjs';
import { TreeRuntime } from '../src/tree/runtime.mjs';
import { fail } from '../src/tree/contracts.mjs';

// 054 (F46): in the 0.7.0 replay one goal whose original source was missing
// made the idle-timeout summary plan throw, the whole worker scan stopped
// before starting queued jobs, and every later learning job stayed queued.
// These tests run the runtime's own scan methods against a real tree and
// consolidation service; only the worker plumbing around them is stubbed.
function scanner(t) {
  const f = learningFixture(t), diagnostics = [], enqueued = [], started = [];
  const runtime = Object.assign(Object.create(TreeRuntime.prototype), {
    closed: false, repo: f.repo, consolidation: f.consolidation, workers: new Map(),
    learning: { enqueue() {} }, verification: { enqueueCorrection() {} }, improvement: { enqueue() {} },
    jobs: { queued: () => [], prepare() {}, transition() {} },
    diagnostic: (kind, error, extra = {}) => diagnostics.push({ kind, code: error.code, ...extra }),
    enqueueSummary: plan => { enqueued.push([plan.nodeId, plan.reason]); return plan; },
    runWorker: async id => { started.push(id); }, kick() {},
  });
  const stale = nodeId => { const node = f.repo.get('tree_nodes', nodeId); f.repo.transaction(() => f.repo.save('tree_nodes', { ...node, lastOwnTurnAt: '2026-01-01T00:00:00.000Z' }, node.revision)); };
  const learned = async (node, text, session) => { const turn = await f.turn(node, text, session); f.complete(f.learning.enqueue(turn.id, node), emptyLearning()); return turn; };
  const revoke = (...nodeIds) => { const plan = f.consolidation.plan.bind(f.consolidation); f.consolidation.plan = (nodeId, reason) => nodeIds.includes(nodeId) ? fail('SUMMARY_SOURCE_REVOKED', 'Do not silently summarize missing original evidence') : plan(nodeId, reason); };
  return { f, runtime, diagnostics, enqueued, started, stale, learned, revoke };
}

test('a goal whose source is missing is reported and skipped; the other idle goals are still planned', async t => {
  const { f, runtime, diagnostics, enqueued, stale, learned, revoke } = scanner(t);
  const broken = f.seedGoal('原文缺失的目标'), healthy = f.seedGoal('正常的目标');
  await learned(broken, '会被撤回的原话'); await learned(healthy, '正常的原话');
  stale(broken); stale(healthy); revoke(broken);
  runtime.planScan();
  assert.deepEqual(enqueued, [[healthy, 'leave_timeout']]);
  // The broken goal was also left (a later turn went to the healthy one), so
  // both the leave and the idle-timeout path report it; neither stops the scan.
  assert.deepEqual(diagnostics.map(d => [d.kind, d.code, d.nodeId, d.reason]), [['summary_plan', 'SUMMARY_SOURCE_REVOKED', broken, 'node_leave'], ['summary_plan', 'SUMMARY_SOURCE_REVOKED', broken, 'leave_timeout']]);
  assert.equal(f.repo.get('tree_nodes', broken).currentSummaryId, undefined, 'no summary is written from a partial source');
});

test('a completed goal that cannot be planned does not stop the others either', async t => {
  const { f, runtime, diagnostics, enqueued, learned, revoke } = scanner(t);
  const broken = f.create('完成但原文缺失'), done = f.create('正常完成');
  await learned(broken, '做完了'); await learned(done, '也做完了');
  f.asUser();
  for (const id of [broken, done]) f.tree.setStatus(f.cmd({ nodeId: id, status: 'completed', sourceRefs: [] }, f.expected('tree_nodes', id)));
  revoke(broken);
  runtime.planScan();
  assert.deepEqual(enqueued, [[done, 'node_complete']]);
  assert.deepEqual(diagnostics.map(d => [d.kind, d.code, d.nodeId, d.reason]), [['summary_plan', 'SUMMARY_SOURCE_REVOKED', broken, 'node_complete']]);
});

test('queued jobs are started even when planning fails unexpectedly', async t => {
  const { runtime, diagnostics, started } = scanner(t);
  runtime.planScan = () => { throw Object.assign(new Error('unexpected planning failure'), { code: 'SYNTHETIC' }); };
  runtime.jobs.queued = () => [{ id: 'queued-learning', role: 'learning' }];
  const progress = await runtime.scanOne();
  await Promise.all(runtime.workers.values());
  assert.equal(progress, true);
  assert.deepEqual(started, ['queued-learning']);
  assert.deepEqual(diagnostics.map(d => [d.kind, d.code]), [['scan_planning', 'SYNTHETIC']]);
});

test('a goal left while its source is missing is reported once per scan and does not block the leave of another goal', async t => {
  const { f, runtime, diagnostics, enqueued, learned, revoke } = scanner(t);
  const broken = f.seedGoal('原文缺失'), other = f.seedGoal('另一个目标'), current = f.seedGoal('现在的目标');
  await learned(broken, '一'); await learned(other, '二'); await learned(current, '三');
  revoke(broken);
  runtime.planScan();
  assert.deepEqual(enqueued, [[other, 'node_leave']]);
  assert.deepEqual(diagnostics.map(d => [d.kind, d.code, d.nodeId, d.reason]), [['summary_plan', 'SUMMARY_SOURCE_REVOKED', broken, 'node_leave']]);
});

for (const timeoutFirst of [false, true]) test(`a cross-session departure shares one batch with the idle timeout (${timeoutFirst ? 'timeout already queued' : 'same scan'})`, async t => {
  const { f, runtime, diagnostics, stale, learned } = scanner(t);
  delete runtime.enqueueSummary;
  runtime.jobs = f.jobs;
  runtime.backgroundModelConfig = f.config;
  const former = f.seedGoal('合成旧目标'), current = f.seedGoal('合成当前目标');
  await learned(former, '合成旧对话', 'former-session');
  stale(former);
  if (timeoutFirst) runtime.planScan();
  await learned(current, '合成新对话', 'current-session');
  runtime.planScan();
  runtime.planScan();
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(f.repo.list('tree_jobs', j => j.role === 'consolidation').map(job => [job.nodeIds[0], job.input.summaryPlan.reason]),
    [[former, timeoutFirst ? 'leave_timeout' : 'node_leave']]);
});
