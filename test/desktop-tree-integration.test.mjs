import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapFixture } from './fixtures/tree-integration/bootstrap.mjs';
import { emptyLearning } from './fixtures/tree-learning/helpers.mjs';
import { digest } from '../src/tree/contracts.mjs';

test('Desktop adapter completes an accounted tree turn through a synthetic model endpoint', async t => {
  const answer = ({ role, input }) => role === 'attribution'
    ? { actions: [{ action: 'continue', nodeId: input.scope.nodeIds[0] }], statusChanges: [] }
    : role === 'learning' ? emptyLearning() : '合成回复';
  const fixture = await bootstrapFixture(t, answer, { webOnly: true, desktop: true });
  // These tests verify model provenance, not the production 12-second deadline;
  // full-suite resource contention can delay the synthetic endpoint.
  fixture.runtime.attribution.timers = { setTimeout: fn => setTimeout(fn, 60000), clearTimeout };
  const agent = await fixture.main('synthetic-desktop');
  const turn = await fixture.turn(agent, '这是一条合成消息。');
  assert.equal(turn.status, 'settled');
  assert.deepEqual(fixture.requests.map(request => request.role), ['attribution', 'main', 'learning']);
  assert.ok(fixture.repo.list('tree_jobs').filter(job => job.role).every(job => job.status === 'committed'));
  for (const request of fixture.requests)
    assert.ok([...fixture.runtime.tokenCounter.cache.values()].some(reading => reading.wireHash === digest(request.body)), 'The exact sent body was counted offline');
  const summary = fixture.ctx.arcfoldDeepSeekTransport.summary();
  assert.equal(summary.scope, 'web-unlimited');
  assert.equal(summary.reservedMicroCny, 0);
});


test('Desktop background work follows each originating conversation model, even after a later selection', async t => {
  let agent, changed = false;
  const answer = ({ role, input }) => {
    if (role === 'main' && !changed) {
      changed = true;
      agent.model.select({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off' });
    }
    return role === 'attribution' ? { actions: [{ action: 'continue', nodeId: input.scope.nodeIds[0] }], statusChanges: [] }
      : role === 'learning' ? emptyLearning() : '合成回复';
  };
  const fixture = await bootstrapFixture(t, answer, { webOnly: true, desktop: true, webMainModel: 'deepseek-v4-pro' });
  // These tests verify model provenance, not the production 12-second deadline;
  // full-suite resource contention can delay the synthetic endpoint.
  fixture.runtime.attribution.timers = { setTimeout: fn => setTimeout(fn, 60000), clearTimeout };
  agent = await fixture.main('desktop-model-follow');
  assert.equal((await fixture.turn(agent, '第一轮选用 Pro。')).status, 'settled');
  assert.equal((await fixture.turn(agent, '第二轮选用 Flash。')).status, 'settled');
  assert.deepEqual(fixture.requests.map(request => [request.role, request.body.model]), [
    ['attribution', 'deepseek-v4-pro'], ['main', 'deepseek-v4-pro'], ['learning', 'deepseek-v4-pro'],
    ['attribution', 'deepseek-flash'], ['main', 'deepseek-flash'], ['learning', 'deepseek-flash'],
  ]);
  const jobs = fixture.repo.list('tree_jobs').filter(job => job.role);
  assert.ok(jobs.every(job => job.status === 'committed'));
  const main = jobs.filter(job => job.role === 'main');
  const pro = main.find(job => job.modelConfig.model === 'deepseek-v4-pro');
  const flash = main.find(job => job.modelConfig.model === 'deepseek-flash');
  assert.equal(fixture.runtime.backgroundModelConfig('learning', { turnId: pro.trigger.turnId }).model, 'deepseek-v4-pro');
  assert.equal(fixture.runtime.backgroundModelConfig('learning', { turnId: flash.trigger.turnId }).model, 'deepseek-flash');
  assert.throws(() => fixture.runtime.backgroundModelConfig('learning', { turnId: 'missing-turn' }), /originating conversation model job/);
  assert.throws(() => fixture.runtime.backgroundModelConfig('verification', { parentJobId: 'missing-job' }), /originating background model job/);
});

test('two conversations do not exchange their background model choices', async t => {
  const answer = ({ role, input }) => role === 'attribution'
    ? { actions: [{ action: 'continue', nodeId: input.scope.nodeIds[0] }], statusChanges: [] }
    : role === 'learning' ? emptyLearning() : '合成回复';
  const fixture = await bootstrapFixture(t, answer, { webOnly: true, desktop: true, webMainModel: 'deepseek-v4-pro' });
  // These tests verify model provenance, not the production 12-second deadline;
  // full-suite resource contention can delay the synthetic endpoint.
  fixture.runtime.attribution.timers = { setTimeout: fn => setTimeout(fn, 60000), clearTimeout };
  const pro = await fixture.main('desktop-pro-session'), flash = await fixture.main('desktop-flash-session');
  flash.model.select({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off' });
  const [turnPro, turnFlash] = await Promise.all([
    fixture.turn(pro, 'Pro 会话的合成原话。'), fixture.turn(flash, 'Flash 会话的合成原话。'),
  ]);
  assert.equal(turnPro.status, 'settled'); assert.equal(turnFlash.status, 'settled');
  const jobs = fixture.repo.list('tree_jobs');
  for (const [turn, model] of [[turnPro, 'deepseek-v4-pro'], [turnFlash, 'deepseek-flash']]) {
    const main = jobs.find(job => job.role === 'main' && job.trigger.turnId === turn.id);
    const learning = jobs.find(job => job.role === 'learning' && job.trigger.turnId === turn.id);
    const attribution = jobs.find(job => job.role === 'attribution' && job.trigger.nativeSessionId === turn.sessionId && job.trigger.nativeTurn === turn.nativeTurn);
    assert.equal(main?.modelConfig.model, model); assert.equal(learning?.modelConfig.model, model); assert.equal(attribution?.modelConfig.model, model);
    assert.equal(learning?.status, 'committed');
  }
});
