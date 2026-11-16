import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapFixture } from './fixtures/tree-integration/bootstrap.mjs';
import { emptyLearning } from './fixtures/tree-learning/helpers.mjs';
import { defineTool } from '@deepseek-ai/dsh-tools';

const first = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off' };
const second = { provider: 'synthetic-other', model: 'synthetic-other-model' };
const reply = ({ role, input }) => role === 'attribution'
  ? { actions: [{ action: 'continue', nodeId: input.scope.nodeIds[0] }], statusChanges: [] }
  : role === 'learning' ? emptyLearning() : '合成回复';

test('native DeepSeek and pi-ai routes complete attribution, main and learning with their originating selection', async t => {
  let agent, changed = false;
  const f = await bootstrapFixture(t, row => {
    if (row.role === 'main' && !changed) { changed = true; agent.model.select(second); }
    return reply(row);
  }, { nativeModels: true });
  agent = await f.main('native-model-switch');
  assert.equal((await f.turn(agent, '第一轮。')).status, 'settled');
  assert.equal((await f.turn(agent, '第二轮。')).status, 'settled');
  assert.deepEqual(f.requests.map(r => [r.role, r.body.model]), [
    ['attribution', first.model], ['main', first.model], ['learning', first.model],
    ['attribution', second.model], ['main', second.model], ['learning', second.model],
  ]);
  const jobs = f.repo.list('tree_jobs').filter(j => j.role);
  assert.ok(jobs.every(j => j.status === 'committed'), JSON.stringify(jobs.map(j => [j.role, j.status, j.error])));
  for (const main of jobs.filter(j => j.role === 'main')) {
    for (const role of ['learning', 'consolidation', 'verification', 'improvement', 'script_writer']) {
      const config = f.runtime.backgroundModelConfig(role, { parentJobId: main.id });
      assert.equal(config.provider, main.modelConfig.provider);
      assert.equal(config.model, main.modelConfig.model);
      assert.equal(config.reasoningEffort, main.modelConfig.reasoningEffort);
    }
  }
  const summary = f.ctx.arcfoldNativeModelRecords.summary();
  assert.equal(summary.requests, 6); assert.equal(summary.complete, 6);
  assert.equal(summary.cost, null); assert.equal(summary.priceStatus, 'unknown');
  assert.equal(f.ctx.get('arcfoldDeepSeekTransport'), undefined);
});

test('concurrent native conversations retain their own provider and reasoning settings', async t => {
  const f = await bootstrapFixture(t, reply, { nativeModels: true });
  const a = await f.main('native-first'), b = await f.main('native-second');
  b.model.select(second);
  const turns = await Promise.all([f.turn(a, '第一会话。'), f.turn(b, '第二会话。')]);
  for (const [i, turn] of turns.entries()) {
    assert.equal(turn.status, 'settled');
    const expected = i ? second : first;
    const jobs = f.repo.list('tree_jobs', j => j.trigger?.turnId === turn.id);
    assert.ok(jobs.length >= 2);
    assert.ok(jobs.every(j => j.modelConfig.provider === expected.provider && j.modelConfig.model === expected.model));
  }
});

test('a native tool continuation keeps the current model and persists the next choice', async t => {
  let agent, mainSteps = 0;
  const f = await bootstrapFixture(t, row => {
    if (row.role === 'main' && ++mainSteps === 1) {
      agent.model.select(second);
      return { tool: { name: 'synthetic_observe' } };
    }
    return reply(row);
  }, { nativeModels: true });
  agent = await f.main('native-tool-switch', ctx => {
    ctx.tools.register(defineTool({ name: 'synthetic_observe', description: 'Synthetic read without side effects', parameters: {},
      output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: 'synthetic result' }] }, execute: async () => ({ ok: true }) }));
  });
  assert.equal((await f.turn(agent, '调用一次合成工具。')).status, 'settled');
  assert.deepEqual(f.requests.filter(r => r.role === 'main').map(r => r.body.model), [first.model, first.model]);
  assert.equal(agent.model.current().provider, second.provider);
  assert.equal((await f.turn(agent, '现在使用下一轮模型。')).status, 'settled');
  assert.equal(f.requests.filter(r => r.role === 'main').at(-1).body.model, second.model);
});
