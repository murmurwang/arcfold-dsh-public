import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeFixture } from './fixtures/tree-model/native.mjs';
import { minimal } from './fixtures/tree-model/contracts.mjs';
import { integratedFixture } from './fixtures/tree-integration/native.mjs';
import { emptyLearning } from './fixtures/tree-learning/helpers.mjs';
import { deferredLearning, interruptedLearning } from '../src/tree/jobs.mjs';

const quit = () => Object.assign(new Error('session "synthetic": flush on a closed handle'), { code: 'HOST_ERROR' });

// The host stops after a learning job's result is in memory but before the
// result is durable; durable reports whether the native log still holds it.
async function stopAfterRequest(f, durable) {
  const id = f.enqueue('learning').id, flush = f.ctx.sessions.flush.bind(f.ctx.sessions);
  f.ctx.sessions.flush = async session => {
    const answered = f.jobs.get(id).status === 'submitted' && f.requests.length > 0;
    const ok = !answered || durable ? await flush(session) : true; return answered ? false : ok;
  };
  const job = await f.owner.run(id);
  f.ctx.sessions.flush = flush;
  return job;
}

test('a learning stopped before its request was released is resolved as not sent on recovery', async t => {
  const f = await nativeFixture(t, ({ role }) => minimal[role], { nativeModels: true });
  const job = f.enqueue('learning'); f.jobs.prepare(job.id); f.jobs.submit(job.id);
  f.jobs.transition(job.id, 'unknown', { error: { code: 'HOST_ERROR', message: quit().message } });
  const next = f.enqueue('learning');
  // While the host is running an uncertain learning still blocks its node.
  assert.throws(() => f.jobs.prepare(next.id), { code: 'LEARNING_UNKNOWN' });
  const sent = f.requests.length;
  const resolved = (await f.owner.recover()).find(r => r.id === job.id);
  assert.equal(resolved.status, 'failed'); assert.equal(resolved.interrupted.code, 'LEARNING_INTERRUPTED'); assert.equal(resolved.nodeId, f.repo.rootId());
  const after = f.jobs.get(job.id);
  assert.equal(after.notSent, true); assert.equal(interruptedLearning(after), true); assert.equal(deferredLearning(after), false);
  assert.equal(f.requests.length, sent);
  assert.equal(f.jobs.prepare(next.id).status, 'prepared');
});

test('a learning whose request was released but left no durable result is lost and never resent', async t => {
  const f = await nativeFixture(t, ({ role }) => minimal[role], { nativeModels: true });
  const job = await stopAfterRequest(f, false);
  assert.equal(job.status, 'unknown'); assert.equal(job.invocationIds.length, 1);
  const sent = f.requests.length;
  f.owner.readEvents = async () => [];
  const resolved = (await f.owner.recover()).find(r => r.id === job.id);
  assert.equal(resolved.status, 'failed'); assert.equal(resolved.interrupted.code, 'RESULT_LOST');
  const after = f.jobs.get(job.id);
  assert.equal(after.resultLost, true); assert.equal(interruptedLearning(after), false); assert.equal(deferredLearning(after), false);
  await f.owner.run(job.id);
  assert.equal(f.requests.length, sent);
  assert.equal(f.jobs.prepare(f.enqueue('learning').id).status, 'prepared');
});

test('an uncertain learning whose input reached the native session keeps the unknown protection', async t => {
  const f = await nativeFixture(t, ({ role }) => minimal[role], { nativeModels: true });
  const job = await stopAfterRequest(f, false);
  const own = { type: 'user/message', seq: 1, data: { source: { kind: 'arcfold/tree-job', jobId: job.id } } };
  f.owner.readEvents = async () => [own];
  const resolved = (await f.owner.recover()).find(r => r.id === job.id);
  assert.equal(resolved.status, 'unknown'); assert.equal(resolved.interrupted, undefined);
});

const answer = ({ role, input }) => role === 'attribution'
  ? { actions: [{ action: 'continue', nodeId: input.scope.nodeIds[0] }], statusChanges: [] }
  : role === 'learning' ? emptyLearning() : '合成答复。';
const learningOf = (repo, turn) => repo.list('tree_jobs', j => j.role === 'learning' && j.trigger.turnId === turn.id);

test('after a stop mid-learning, a restart learns the interrupted turn once and the node keeps learning', async t => {
  const first = await integratedFixture(t, answer, { evidenceName: 'before-stop.json' });
  // Keep the scheduler from appending on its own; the test places the stop.
  first.runtime.scanOne = async () => false;
  const agent = await first.main('interrupted-learning');
  const stopped = await first.turn(agent, '第一轮。'), later = await first.turn(agent, '第二轮。');
  const job = first.runtime.learning.enqueue(stopped.id, stopped.nodeIds[0]);
  // The host stops right after submission: the learning session log exists,
  // but this job's input never reached it and no request was released.
  const submit = first.jobs.submit.bind(first.jobs);
  first.jobs.submit = id => { const submitted = submit(id); if (id === job.id) throw quit(); return submitted; };
  const uncertain = await first.owner.run(job.id); first.jobs.submit = submit;
  assert.equal(uncertain.status, 'unknown'); assert.equal(uncertain.invocationIds.length, 0);
  const log = await first.owner.readEvents(uncertain.nativeSessionId);
  assert.ok(Array.isArray(log)); assert.equal(log.some(e => e.type === 'user/message'), false);
  assert.equal(first.requests.filter(r => r.role === 'learning').length, 0);
  await first.shutdown();
  const restarted = await integratedFixture(t, answer, { root: first.root, evidenceName: 'after-restart.json' });
  await restarted.transport.recover({ exclusive: true });
  await restarted.runtime.recover(); await restarted.runtime.idle();
  const { repo } = restarted, state = restarted.jobs.get(job.id);
  assert.equal(state.status, 'failed'); assert.equal(state.error.code, 'LEARNING_INTERRUPTED'); assert.equal(interruptedLearning(state), true);
  const [retried] = learningOf(repo, stopped).filter(j => j.id !== job.id);
  assert.equal(retried.status, 'committed'); assert.equal(retried.nativeSessionId, uncertain.nativeSessionId);
  assert.deepEqual(learningOf(repo, later).map(j => j.status), ['committed']);
  assert.equal(restarted.requests.filter(r => r.role === 'learning').length, 2);
  const diagnostics = Object.values(repo.meta().runtimeDiagnostics ?? {}).filter(d => d.kind === 'learning_interrupted');
  assert.deepEqual(diagnostics.map(d => [d.code, d.jobId, d.nodeId]), [['LEARNING_INTERRUPTED', job.id, stopped.nodeIds[0]]]);
  // Recovering again neither resends nor records another interruption.
  await restarted.runtime.recover(); await restarted.runtime.idle();
  assert.equal(restarted.requests.filter(r => r.role === 'learning').length, 2);
});

test('an uncertain learning whose result is durable is still accepted after a restart', async t => {
  const first = await integratedFixture(t, answer, { evidenceName: 'before-stop.json' });
  first.runtime.scanOne = async () => false;
  const agent = await first.main('durable-learning'), turn = await first.turn(agent, '第一轮。');
  const job = first.runtime.learning.enqueue(turn.id, turn.nodeIds[0]);
  const sessions = first.ctx.sessions, flush = sessions.flush.bind(sessions);
  // The result reaches the native log, but the host reports the final flush
  // as failed, as when it stops right after the answer.
  sessions.flush = async session => { const ok = await flush(session); return first.jobs.get(job.id).status === 'submitted' && first.requests.some(r => r.role === 'learning') ? false : ok; };
  assert.equal((await first.owner.run(job.id)).status, 'unknown');
  sessions.flush = flush;
  await first.shutdown();
  const restarted = await integratedFixture(t, answer, { root: first.root, evidenceName: 'after-restart.json' });
  await restarted.transport.recover({ exclusive: true });
  await restarted.runtime.recover(); await restarted.runtime.idle();
  assert.equal(restarted.jobs.get(job.id).status, 'committed');
  assert.equal(restarted.requests.filter(r => r.role === 'learning').length, 0);
  assert.equal(Object.values(restarted.repo.meta().runtimeDiagnostics ?? {}).filter(d => d.kind === 'learning_interrupted').length, 0);
});
