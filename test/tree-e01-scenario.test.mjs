import test from 'node:test';
import assert from 'node:assert/strict';
import { e01Scenario } from '../scripts/tree-experiment/e01-scenario.mjs';
import { compactE01Session, exerciseE01 } from '../scripts/tree-experiment/e01-exercise.mjs';

test('E01 freezes three distinct, interleaved preparation goals before actions', () => {
  const scenario = e01Scenario();
  assert.equal(scenario.independentHeldout, false);
  assert.equal(scenario.turns.length, 30);
  assert.deepEqual(scenario.turns.map(t => t.ordinal), Array.from({ length: 30 }, (_, i) => i + 1));
  for (let goal = 0; goal < 3; goal++) {
    assert.equal(scenario.turns.filter(t => t.goal === goal).length, 10);
  }
  assert.ok(scenario.uiActions.renameAfterTurns > 12, 'The title changes follow the new conditions');
  assert.ok(scenario.uiActions.compactAfterTurns < 30, 'The episode continues after compaction');
  assert.equal(scenario.uiActions.completePreparationAfterTurns, 30);
});

test('a known failed compaction is recorded once while an unknown outcome stops', async () => {
  for (const status of ['invalid_output', 'unknown']) {
    let calls = 0;
    const agent = { session: { id: 'synthetic-session' } }, evidence = { compactions: [] };
    const f = { ctx: { compaction: { async compactNow() { calls++; throw Object.assign(new Error('summary unavailable'), { code: 'summary' }); } } },
      repo: { list() { return [{ id: 'job', status, trigger: { nativeCompaction: true }, input: { nativeCompaction: { sessionId: agent.session.id } } }]; } } };
    if (status === 'unknown') await assert.rejects(compactE01Session(f, agent, evidence), { code: 'summary' });
    else { await compactE01Session(f, agent, evidence); assert.equal(evidence.compactions[0].status, 'failed'); }
    assert.equal(calls, 1);
  }
});

test('a new E01 phase creates new session identities before any turn is sent', async () => {
  const ids = [], stop = new Error('stop before any turn');
  const fixture = { async main(id) { ids.push(id); if (ids.length === 2) throw stop; return {}; } };
  await assert.rejects(exerciseE01(fixture, e01Scenario(), () => {}, { sessionPrefix: 'system-e01-followup-v2' }), error => error === stop);
  assert.deepEqual(ids, ['system-e01-followup-v2-one', 'system-e01-followup-v2-two']);
  assert.ok(ids.every(id => !['e01-native-one', 'e01-native-two'].includes(id)));
});
