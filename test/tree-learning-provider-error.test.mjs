import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeFixture } from './fixtures/tree-model/native.mjs';
import { minimal } from './fixtures/tree-model/contracts.mjs';
import { bootstrapFixture } from './fixtures/tree-integration/bootstrap.mjs';
import { learningFixture } from './fixtures/tree-learning/helpers.mjs';
import { TreeRuntime } from '../src/tree/runtime.mjs';
import { LEARNING_PROVIDER_ERROR, LEARNING_BACKLOG_SKIPPED } from '../src/tree/jobs.mjs';

const providerError = { httpError: { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'Synthetic provider failure' } } } };
const empty = () => ({ categories: [], understandings: [], changes: [], method: null });
function knownFailure(f, job) {
  f.jobs.prepare(job.id); f.jobs.submit(job.id);
  f.jobs.admitInvocation(job.id, { turn: 1, step: 1, stepStartSeq: 1, requestHash: 'd'.repeat(64), allowedTools: [] });
  return f.jobs.failProviderError(job.id, { nativeLogRef: 'synthetic#1', eventsHash: 'a'.repeat(64), code: 'TIMEOUT', message: 'timeout' });
}


for (const code of ['TIMEOUT', 'TRANSPORT']) test(`${code}: durable error recovery preserves usage and needs every failed receipt`, async t => {
  const f = await nativeFixture(t, () => providerError, { nativeModels: true });
  const fail = f.jobs.failProviderError.bind(f.jobs);
  f.jobs.failProviderError = () => { throw Object.assign(new Error('stop before recording'), { code: 'RESULT_UNKNOWN' }); };
  const job = await f.owner.run(f.enqueue('learning').id); assert.equal(job.status, 'unknown');
  const events = structuredClone(await f.owner.readEvents(job.nativeSessionId));
  const end = events.findLast(e => e.type === 'turn/end'); end.data.reason.error = { code, message: `Synthetic ${code}` };
  const recordId = f.repo.get('tree_invocations', job.invocationIds[0]).ledgerRequestId;
  const before = structuredClone(f.nativeRecords.get(recordId)), lookup = f.owner.ledgerLookup;
  f.jobs.failProviderError = fail;
  f.owner.ledgerLookup = () => ({ ...before, status: 'submitted' });
  assert.throws(() => f.owner.consume(job.id, events), { code: 'RESULT_UNKNOWN' });
  f.owner.ledgerLookup = lookup;
  const noEnd = events.filter(e => e !== end);
  assert.throws(() => f.owner.consume(job.id, noEnd), { code: 'RESULT_UNKNOWN' });
  const answer = { seq: end.seq - 0.5, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '{}' }] } } };
  assert.throws(() => f.owner.consume(job.id, [...events, answer]), { code: 'RESULT_UNKNOWN' });
  const resolved = f.owner.consume(job.id, events);
  assert.equal(resolved.status, 'failed'); assert.equal(resolved.error.code, LEARNING_PROVIDER_ERROR); assert.equal(resolved.error.nativeCode, code);
  assert.deepEqual(f.nativeRecords.get(recordId), before); assert.equal(f.requests.length, 1);
});

for (const failTwice of [false, true]) test(`runtime retries provider failure once in the same session (${failTwice ? 'failure' : 'success'}) and continues`, async t => {
  let calls = 0;
  const f = await bootstrapFixture(t, ({ role, input }) => {
    if (role === 'attribution') return { actions: [{ action: 'continue', nodeId: input.scope.nodeIds[0] }], statusChanges: [] };
    if (role === 'learning') return ++calls <= (failTwice ? 2 : 1) ? providerError : empty();
    return '合成回复';
  }, { nativeModels: true });
  f.runtime.learning.outputProtocol = 'experience-v1';
  const agent = await f.main('provider-retry');
  const turn = await f.turn(agent, '继续合成目标');
  const attempts = f.repo.list('tree_jobs', j => j.role === 'learning' && j.trigger.turnId === turn.id);
  assert.equal(attempts.length, 2, JSON.stringify(attempts.map(j => [j.status, j.error])));
  assert.equal(attempts[0].nativeSessionId, attempts[1].nativeSessionId);
  assert.equal(attempts.filter(j => j.trigger.retriesProviderError).length, 1);
  assert.ok(attempts.some(j => j.status === (failTwice ? 'failed' : 'committed')));
  for (let n = 0; n < 3; n++) { await f.runtime.recover(); await f.runtime.idle(); }
  assert.equal(calls, 2);
  const diagnostics = Object.values(f.repo.meta().runtimeDiagnostics).filter(d => d.kind === 'learning_provider_error');
  assert.equal(diagnostics.length, failTwice ? 2 : 1);
  assert.equal((await f.turn(agent, '后面的新轮次')).status, 'settled'); assert.equal(calls, 3);
});

test('retry marker survives unsent refreezing, sent result loss and service recreation', async t => {
  const f = learningFixture(t, { outputProtocol: 'experience-v1' }), node = f.create('合成目标');
  const turn = await f.turn(node, '合成内容'), first = f.learning.enqueue(turn.id, node);
  knownFailure(f, first);
  const retry = f.learning.enqueue(turn.id, node); assert.equal(retry.trigger.retriesProviderError, true);
  f.jobs.prepare(retry.id); f.jobs.submit(retry.id); f.jobs.transition(retry.id, 'unknown');
  f.jobs.failInterrupted(retry.id, { eventsHash: 'a'.repeat(64) });
  const refrozen = f.learning.enqueue(turn.id, node); assert.equal(refrozen.trigger.retriesProviderError, true);
  f.jobs.prepare(refrozen.id); f.jobs.submit(refrozen.id);
  f.jobs.admitInvocation(refrozen.id, { turn: 2, step: 1, stepStartSeq: 4, requestHash: 'b'.repeat(64), allowedTools: [] });
  f.jobs.transition(refrozen.id, 'unknown'); f.jobs.failInterrupted(refrozen.id, { eventsHash: 'c'.repeat(64) });
  assert.equal(f.learning.enqueue(turn.id, node).id, refrozen.id);
  const LearningService = f.learning.constructor;
  const fresh = new LearningService({ repository: f.repo, experience: f.experience, contextBuilder: f.builder, consolidation: f.consolidation, jobs: f.jobs, modelConfig: f.config, signals: f.signals });
  assert.equal(fresh.enqueue(turn.id, node).id, refrozen.id);
});

async function backlog(t, nodeCount, turnsPerNode) {
  const f = learningFixture(t, { outputProtocol: 'experience-v1' }), resolved = [];
  for (let n = 0; n < nodeCount; n++) {
    const node = f.create(`目标${n}`);
    for (let k = 0; k < turnsPerNode; k++) {
      const turn = await f.turn(node, `合成轮次${k}`, `main-${n}`);
      if (k === 0) {
        const job = f.learning.enqueue(turn.id, node);
        resolved.push(knownFailure(f, job));
      }
    }
  }
  const runtime = Object.assign(Object.create(TreeRuntime.prototype), { repo: f.repo, jobs: f.jobs });
  const intents = f.repo.list('tree_jobs', j => !j.role && j.kind === 'learning' && j.status === 'queued');
  runtime.limitRecoveredLearning(resolved, intents); return { f, runtime, intents };
}
for (const [nodes, turns, allowed] of [[1, 18, 15], [2, 13, 20]]) test(`historical queue keeps earliest ${allowed} and closes surplus permanently`, async t => {
  const { f, runtime, intents } = await backlog(t, nodes, turns);
  const skipped = f.repo.list('tree_jobs', j => j.error?.code === LEARNING_BACKLOG_SKIPPED);
  assert.equal(skipped.length, nodes * turns - allowed);
  assert.equal(runtime.recoveredLearning.keys.size, allowed);
  for (const intent of skipped) assert.equal(f.learning.enqueue(intent.input.turnId, intent.nodeIds[0]).id, intent.id);
  const kept = intents.filter(i => !skipped.some(s => s.id === i.id));
  // Each retry also consumes the startup limit, never a third paid request.
  for (const [index, intent] of kept.entries()) {
    const job = { id: `synthetic-${index}`, role: 'learning', nodeIds: intent.nodeIds, trigger: { turnId: intent.input.turnId } };
    assert.equal(runtime.admitRecoveredLearning(job), true);
  }
  const last = kept.at(-1);
  assert.equal(runtime.admitRecoveredLearning({ id: 'extra-retry', role: 'learning', nodeIds: last.nodeIds, trigger: { turnId: last.input.turnId } }), false);
  assert.ok(Object.values(f.repo.meta().runtimeDiagnostics).some(d => d.code === LEARNING_BACKLOG_SKIPPED));
  const nodeId = kept[0].nodeIds[0];
  for (const turn of f.experience.turns(nodeId)) {
    const job = f.learning.enqueue(turn.id, nodeId);
    if (job.role && job.status === 'queued') assert.equal(f.complete(job, empty()).status, 'committed');
  }
  const next = await f.turn(nodeId, '升级后新的轮次', 'fresh-main');
  assert.equal(f.complete(f.learning.enqueue(next.id, nodeId), empty()).status, 'committed');
});

test('startup resolves an old unknown, drains its queued turns, then runs departed consolidation', async t => {
  let nodeId, leave = false, resume = false;
  const f = await bootstrapFixture(t, ({ role, input }, runtime) => {
    if (role === 'attribution') return { actions: [!nodeId ? { action: 'create', name: '合成旧目标' } : { action: 'switch', nodeId: leave ? runtime.repo.rootId() : nodeId }], statusChanges: [] };
    if (role === 'learning') return !resume && input.scope.nodeIds[0] === nodeId ? providerError : empty();
    if (role === 'consolidation') return { summary: { oneLine: '积压已处理', status: '已离开', outputs: [], decisions: [], next: '', pending: [] }, broaden: [], kept: [], retrospect: { understandings: [], methods: [] }, setDown: null };
    if (role === 'verification') return minimal.verification;
    if (role === 'improvement') return minimal.improvement;
    return '合成回复';
  }, { nativeModels: true });
  f.runtime.learning.outputProtocol = 'experience-v1';
  const fail = f.runtime.jobs.failProviderError.bind(f.runtime.jobs);
  f.runtime.jobs.failProviderError = () => { throw Object.assign(new Error('old code did not recognize failure'), { code: 'RESULT_UNKNOWN' }); };
  const agent = await f.main('old-queue');
  const first = await f.turn(agent, '开始旧目标'); nodeId = first.nodeIds[0];
  // First turn is already unknown: nodeId is assigned after attribution but
  // before background learning reaches the loopback provider.
  if (!f.repo.list('tree_jobs', j => j.role === 'learning' && j.status === 'unknown').length) {
    await f.turn(agent, '触发超时');
  }
  await f.turn(agent, '排队第一轮'); await f.turn(agent, '排队第二轮');
  leave = true; await f.turn(agent, '转去别的目标');
  assert.ok(f.repo.list('tree_jobs', j => j.role === 'learning' && j.status === 'unknown' && j.nodeIds[0] === nodeId).length);
  assert.equal(f.repo.list('tree_jobs', j => j.role === 'consolidation' && j.nodeIds[0] === nodeId).length, 0);
  resume = true; f.runtime.jobs.failProviderError = fail;
  await f.runtime.recover(); await f.runtime.idle();
  assert.equal(f.repo.list('tree_jobs', j => j.role === 'learning' && j.status === 'unknown' && j.nodeIds[0] === nodeId).length, 0);
  assert.equal(f.repo.list('tree_jobs', j => !j.role && j.kind === 'learning' && j.status === 'queued' && j.nodeIds[0] === nodeId).length, 0);
  assert.ok(f.repo.list('tree_jobs', j => j.role === 'consolidation' && j.nodeIds[0] === nodeId && j.status === 'committed').length, JSON.stringify(f.repo.list('tree_jobs', j => j.role === 'consolidation')));
});
