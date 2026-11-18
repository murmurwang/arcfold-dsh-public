import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeFixture } from './fixtures/tree-model/native.mjs';
import { minimal } from './fixtures/tree-model/contracts.mjs';
import { bootstrapFixture } from './fixtures/tree-integration/bootstrap.mjs';
import { emptyLearning } from './fixtures/tree-learning/helpers.mjs';
import { deferredLearning } from '../src/tree/jobs.mjs';
import { compactLearningSource, LEARNING_TOOL_SOURCE_CHARS } from '../src/tree/experience.mjs';
import { digest } from '../src/tree/contracts.mjs';

// The provider's actual wording when the learning input exceeded the window.
const refusal = { httpError: { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'context_length_exceeded: Your input exceeds the context window of this model. Please adjust your input and try again.' } } } };
const otherError = { httpError: { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'Unsupported synthetic parameter' } } } };

test('a learning request refused for context size is a known failure and recovery does not resend it', async t => {
  const f = await nativeFixture(t, ({ role }) => role === 'learning' ? refusal : minimal[role], { nativeModels: true });
  const job = await f.owner.run(f.enqueue('learning').id);
  assert.equal(job.status, 'failed', JSON.stringify(job.error)); assert.equal(job.error.code, 'CONTEXT_WINDOW_EXCEEDED'); assert.equal(job.providerRejected, true);
  assert.match(job.error.message, /context_length_exceeded/); assert.ok(job.nativeLogRef); assert.ok(job.eventsHash);
  assert.equal(deferredLearning(job), true);
  const record = f.nativeRecords.get(f.repo.get('tree_invocations', job.invocationIds[0]).ledgerRequestId);
  assert.equal(record.status, 'failed'); assert.equal(record.finish, 'error');
  const sent = f.requests.length;
  await f.owner.recover(); await f.owner.run(job.id);
  assert.equal(f.requests.length, sent); assert.equal(f.jobs.get(job.id).status, 'failed');
  const next = f.jobs.prepare(f.enqueue('learning').id);
  assert.equal(next.status, 'prepared');
});

test('a refusal previously left unknown is recognized from its durable records on recovery', async t => {
  const f = await nativeFixture(t, ({ role }) => role === 'learning' ? refusal : minimal[role], { nativeModels: true });
  const record = f.jobs.failRejected.bind(f.jobs);
  f.jobs.failRejected = () => { throw Object.assign(new Error('Synthetic interruption before recording the refusal'), { code: 'RESULT_UNKNOWN' }); };
  const uncertain = await f.owner.run(f.enqueue('learning').id);
  assert.equal(uncertain.status, 'unknown');
  assert.throws(() => f.jobs.prepare(f.enqueue('learning').id), { code: 'LEARNING_UNKNOWN' });
  f.jobs.failRejected = record; const sent = f.requests.length;
  const resolved = (await f.owner.recover()).find(r => r.id === uncertain.id);
  assert.equal(resolved.status, 'failed'); assert.equal(resolved.providerRejected, true); assert.equal(f.requests.length, sent);
});

test('other provider errors keep the existing unknown protection', async t => {
  const f = await nativeFixture(t, ({ role }) => role === 'learning' ? otherError : minimal[role], { nativeModels: true });
  const job = await f.owner.run(f.enqueue('learning').id);
  assert.equal(job.status, 'unknown'); assert.equal(job.providerRejected, undefined); assert.equal(deferredLearning(job), false);
  assert.throws(() => f.jobs.prepare(f.enqueue('learning').id), { code: 'LEARNING_UNKNOWN' });
});

test('long tool output is kept by reference in learning input; wording and short output stay original', () => {
  const ref = { sessionId: 'synthetic', seq: 1, sha256: 'a'.repeat(64) };
  const long = { id: 't1', role: 'tool', origin: 'tool', ref, sha256: 'b'.repeat(64), text: 'x'.repeat(LEARNING_TOOL_SOURCE_CHARS + 1), content: [{ type: 'text', text: 'x'.repeat(LEARNING_TOOL_SOURCE_CHARS + 1) }] };
  const compact = compactLearningSource(long);
  assert.deepEqual(compact.elided, { chars: LEARNING_TOOL_SOURCE_CHARS + 1, sha256: long.sha256 }); assert.deepEqual(compact.ref, ref); assert.equal(compact.id, 't1');
  assert.ok(compact.text.length < 100); assert.deepEqual(compact.content, [{ type: 'text', text: compact.text }]);
  const short = { ...long, text: 'ok', content: [{ type: 'text', text: 'ok' }] }, user = { ...long, role: 'user', origin: 'user' };
  assert.equal(compactLearningSource(short), short); assert.equal(compactLearningSource(user), user);
});

async function startSecondLearningEpoch(f) {
  const agent = await f.main('overflow-epoch');
  for (let n = 0; n < 4; n++) assert.equal((await f.turn(agent, `第${n + 1}轮。`)).status, 'settled');
  const { runtime, repo } = f, nodeId = repo.rootId();
  assert.equal(repo.list('tree_jobs', j => j.role === 'learning' && j.status === 'committed').length, 4);
  // Establish epoch 2 exactly as a successful threshold summary would.
  const plan = runtime.consolidation.plan(nodeId, 'threshold');
  let summary; repo.transaction(() => { summary = repo.save('tree_summaries', { id: 'overflow-summary', nodeId, version: 1, oneLine: '合成摘要', body: {}, throughTurnIds: plan.throughTurnIds, assignmentVersions: plan.assignmentVersions, sourceRefs: [], previousVersion: null, sourceWatermark: plan.sourceWatermark, coveredJobIds: plan.coveredJobIds }); });
  const second = runtime.jobs.replaceEpoch(nodeId, { summaryId: summary.id, summaryHash: digest(summary), sourceWatermark: plan.sourceWatermark, recentJobIds: plan.recentJobIds });
  assert.equal(second.contextEpoch, 2);
  return { agent, runtime, repo, plan, summary, second };
}

test('a refusal on the first append of a new epoch moves the turn to a fresh session and learning continues', async t => {
  let refusals = 0;
  const f = await bootstrapFixture(t, ({ role, input }) => role === 'attribution'
    ? { actions: [{ action: 'continue', nodeId: input.scope.nodeIds[0] }], statusChanges: [] }
    : role === 'learning' ? (refusals > 0 && refusals-- ? refusal : emptyLearning()) : '合成回复', { nativeModels: true });
  const { agent, runtime, repo, plan, summary, second } = await startSecondLearningEpoch(f);
  refusals = 1;
  const turn = await f.turn(agent, '第五轮。'); assert.equal(turn.status, 'settled');
  const refused = repo.list('tree_jobs', j => j.role === 'learning' && j.trigger.turnId === turn.id && j.providerRejected)[0];
  assert.ok(refused, JSON.stringify(repo.list('tree_jobs', j => j.role === 'learning').map(j => [j.status, j.error, j.contextEpoch])));
  assert.equal(refused.contextEpoch, 2); assert.equal(refused.nativeSessionId, second.sessionId);
  await runtime.idle();
  const session = repo.list('tree_learning_sessions')[0];
  assert.equal(session.contextEpoch, 3); assert.equal(session.paused, false); assert.notEqual(session.sessionId, second.sessionId);
  assert.equal(session.summaryId, summary.id); assert.deepEqual(session.recentJobIds, plan.recentJobIds);
  const resumed = repo.list('tree_jobs', j => j.role === 'learning' && j.trigger.turnId === turn.id && j.status === 'committed');
  assert.equal(resumed.length, 1); assert.equal(resumed[0].contextEpoch, 3); assert.equal(resumed[0].nativeSessionId, session.sessionId);
  assert.ok(resumed[0].input.epochSeed); assert.equal(repo.list('tree_jobs', j => j.role === 'consolidation').length, 0);
  assert.equal((await f.turn(agent, '第六轮。')).status, 'settled');
  assert.equal(repo.list('tree_jobs', j => j.role === 'learning' && j.status === 'committed').length, 6);
});

test('another refusal after rotation preserves the queue without repeatedly retrying the same learning turn', async t => {
  let refuse = false;
  const f = await bootstrapFixture(t, ({ role, input }) => role === 'attribution'
    ? { actions: [{ action: 'continue', nodeId: input.scope.nodeIds[0] }], statusChanges: [] }
    : role === 'learning' ? (refuse ? refusal : emptyLearning()) : '合成回复', { nativeModels: true });
  const { agent, runtime, repo } = await startSecondLearningEpoch(f);
  refuse = true;
  const turn = await f.turn(agent, '第五轮。');
  await runtime.idle();
  const attempts = repo.list('tree_jobs', j => j.role === 'learning' && j.trigger.turnId === turn.id);
  assert.deepEqual(attempts.map(j => j.contextEpoch).sort(), [2, 3]);
  assert.ok(attempts.every(j => j.status === 'failed' && j.providerRejected));
  assert.equal(repo.list('tree_learning_sessions')[0].paused, true);
  assert.equal(repo.list('tree_jobs', j => !j.role && j.kind === 'learning' && j.input.turnId === turn.id)[0].status, 'queued');
});
