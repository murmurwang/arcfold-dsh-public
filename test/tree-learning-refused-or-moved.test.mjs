import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { integratedFixture } from './fixtures/tree-integration/native.mjs';
import { emptyLearning } from './fixtures/tree-learning/helpers.mjs';
import { movedLearning, preDispatchLearning } from '../src/tree/jobs.mjs';
import { TreeService } from '../src/tree/tree.mjs';

const answer = ({ role, input }) => role === 'attribution'
  ? { actions: [{ action: 'continue', nodeId: input.scope.nodeIds[0] }], statusChanges: [] }
  : role === 'learning' ? emptyLearning() : '合成答复。';
const learningOf = (repo, turn) => repo.list('tree_jobs', j => j.role === 'learning' && j.trigger.turnId === turn.id);
const intentsOf = (repo, turn) => repo.list('tree_jobs', j => !j.role && j.kind === 'learning' && j.input.turnId === turn.id);
const diagnostics = (repo, kind) => Object.values(repo.meta().runtimeDiagnostics ?? {}).filter(d => d.kind === kind);

// Remove one native session's log, as when a goal's learning log is missing
// while the tree still holds the request positions used in it.
function dropLog(root, sessionId) {
  const base = join(root, 'sessions');
  const walk = dir => readdirSync(dir, { withFileTypes: true }).forEach(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name === sessionId) rmSync(path, { recursive: true, force: true }); else walk(path); }
  });
  walk(base);
}

// Two settled turns; the first is learned, then the node's learning log is lost.
async function refusedSecondTurn(t, learn = answer) {
  const first = await integratedFixture(t, learn, { evidenceName: 'before-loss.json' });
  first.runtime.scanOne = async () => false;
  const agent = await first.main('refused-learning');
  const one = await first.turn(agent, '第一轮。'), two = await first.turn(agent, '第二轮。');
  const learned = await first.owner.run(first.runtime.learning.enqueue(one.id, one.nodeIds[0]).id);
  assert.equal(learned.status, 'committed');
  await first.shutdown();
  dropLog(first.root, learned.nativeSessionId);
  const restarted = await integratedFixture(t, learn, { root: first.root, evidenceName: 'after-loss.json' });
  await restarted.transport.recover({ exclusive: true });
  await restarted.runtime.recover(); await restarted.runtime.idle();
  return { first, restarted, one, two, learned };
}

test('a learning refused before dispatch is learned once more in a new native session', async t => {
  const { restarted, two, learned } = await refusedSecondTurn(t);
  const { repo } = restarted, jobs = learningOf(repo, two);
  const refused = jobs.find(j => j.status === 'failed'), retried = jobs.find(j => j.status === 'committed');
  assert.ok(refused, JSON.stringify(jobs.map(j => [j.status, j.error])));
  assert.equal(refused.error.code, 'NATIVE_PRE_DISPATCH'); assert.equal(refused.invocationIds.length, 0);
  assert.match(refused.error.message, /already owns/);
  assert.ok(retried, JSON.stringify(jobs.map(j => [j.status, j.error])));
  assert.equal(retried.trigger.retriesPreDispatch, true);
  assert.notEqual(retried.nativeSessionId, learned.nativeSessionId);
  // Only the retried request reached the provider after the restart.
  assert.equal(restarted.requests.filter(r => r.role === 'learning').length, 1);
  const session = repo.list('tree_learning_sessions', s => s.nodeId === two.nodeIds[0])[0];
  assert.equal(session.contextEpoch, 2); assert.equal(session.summaryId, null);
  assert.deepEqual(session.previousSessions.map(s => s.sessionId), [learned.nativeSessionId]);
  // Without a summary the new session starts from the latest learning jobs, with this turn's own sources.
  assert.equal(retried.input.epochSeed.summary, null);
  assert.deepEqual(retried.input.epochSeed.recent.map(r => r.jobId), [learned.id]);
  assert.ok(retried.input.currentTurn.sourceIds.length > 0);
  const recorded = diagnostics(repo, 'learning_pre_dispatch');
  assert.deepEqual(recorded.map(d => [d.code, d.jobId, d.nodeId, d.retried]), [['NATIVE_PRE_DISPATCH', refused.id, two.nodeIds[0], false]]);
  assert.deepEqual(intentsOf(repo, two).map(i => i.status), ['committed']);
  // Recovering again neither restarts the epoch nor sends anything.
  await restarted.runtime.recover(); await restarted.runtime.idle();
  assert.equal(restarted.requests.filter(r => r.role === 'learning').length, 1);
  assert.equal(repo.list('tree_learning_sessions', s => s.nodeId === two.nodeIds[0])[0].contextEpoch, 2);
});

test('a retry refused again stays failed with a diagnostic and is not tried a third time', async t => {
  const { restarted, two } = await refusedSecondTurn(t);
  const { repo } = restarted, retried = learningOf(repo, two).find(j => j.trigger.retriesPreDispatch);
  // Treat the committed retry as refused, to check that a second refusal ends the turn.
  repo.save('tree_jobs', { ...retried, status: 'failed', error: { code: 'NATIVE_PRE_DISPATCH', message: 'synthetic second refusal' }, notSent: true, invocationIds: [] }, retried.revision);
  assert.equal(preDispatchLearning(repo.get('tree_jobs', retried.id)), false);
  const [intent] = intentsOf(repo, two);
  repo.save('tree_jobs', { ...intent, status: 'queued' }, intent.revision);
  const sent = restarted.requests.length;
  await restarted.runtime.idle();
  assert.equal(restarted.requests.length, sent);
  assert.equal(learningOf(repo, two).length, 2);
  assert.deepEqual(intentsOf(repo, two).map(i => i.status), ['failed']);
});

test('a learning that was sent is never retried in a new session', async t => {
  const f = await integratedFixture(t, answer);
  f.runtime.scanOne = async () => false;
  const agent = await f.main('sent-learning'), turn = await f.turn(agent, '第一轮。');
  const job = await f.owner.run(f.runtime.learning.enqueue(turn.id, turn.nodeIds[0]).id);
  assert.equal(job.invocationIds.length, 1);
  for (const [code, extra] of [['NATIVE_PRE_DISPATCH', {}], ['RESULT_LOST', { notSent: false }]])
    assert.equal(preDispatchLearning({ ...job, status: 'failed', error: { code }, notSent: true, ...extra }), false);
});

// Turn text names the goal it belongs to; attribution creates it once, then continues it.
const byName = ({ role, input }) => {
  if (role !== 'attribution') return role === 'learning' ? emptyLearning() : '合成答复。';
  const text = JSON.stringify(input), name = text.includes('上级') && !text.includes('目标轮') ? '合成上级' : '合成目标';
  const found = input.candidates.find(c => c.name === name);
  return { actions: [found ? { action: 'continue', nodeId: found.id } : { action: 'create', name }], statusChanges: [] };
};

test('moving a goal keeps unfrozen learning queued and lets a frozen unsent one be frozen again', async t => {
  const f = await integratedFixture(t, byName);
  f.runtime.scanOne = async () => false;
  const agent = await f.main('moved-learning');
  const upper = await f.turn(agent, '上级。'), one = await f.turn(agent, '目标轮一。'), two = await f.turn(agent, '目标轮二。');
  const node = one.nodeIds[0], target = upper.nodeIds[0], root = f.repo.rootId();
  assert.notEqual(node, root); assert.notEqual(target, root); assert.notEqual(node, target);
  assert.equal(two.nodeIds[0], node);
  // Learn the upper goal's turn so only the moved goal's turns are pending.
  await f.owner.run(f.runtime.learning.enqueue(upper.id, target).id);
  const frozen = f.runtime.learning.enqueue(one.id, node);
  const tree = new TreeService({ repository: f.repo, resolveSource: () => null, context: () => ({ actor: { kind: 'user', id: f.repo.userId } }) });
  tree.moveNode({ requestId: 'move-synthetic', input: { nodeId: node, parentId: target, sourceRefs: [] }, expected: { ['tree_nodes:' + node]: f.repo.get('tree_nodes', node).revision } });
  const stale = f.jobs.get(frozen.id);
  assert.equal(stale.status, 'stale'); assert.equal(movedLearning(stale), true);
  assert.deepEqual(intentsOf(f.repo, two).map(i => i.status), ['queued']);
  delete f.runtime.scanOne;
  await f.runtime.idle();
  const again = learningOf(f.repo, one).find(j => j.id !== frozen.id);
  assert.equal(again?.status, 'committed', JSON.stringify(learningOf(f.repo, one).map(j => [j.status, j.error])));
  assert.equal(again.trigger.refreezesMove, true);
  assert.deepEqual(again.input.scope.ancestorPaths[0], [root, target, node]);
  const [later] = learningOf(f.repo, two);
  assert.equal(later.status, 'committed'); assert.deepEqual(later.input.scope.ancestorPaths[0], [root, target, node]);
});
