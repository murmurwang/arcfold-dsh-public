import test from 'node:test';
import assert from 'node:assert/strict';
import { integratedFixture } from './fixtures/tree-integration/native.mjs';
import { emptyLearning, emptyVerification } from './fixtures/tree-learning/helpers.mjs';

const RENAMED = '从两条主线推导计划并接上每日安排', CHILD = '讨论对产品和对用户本人的认知';
const text = body => body.messages.flatMap(m => m.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');

// Synthetic replay of the 0.6.0 shape: a planning goal, then a turn in which the
// conversation names its real direction and goes one layer deeper.
async function planningConversation(t, { announce = true } = {}) {
  let phase = 'open', step = 0, goal;
  const seen = [];
  const f = await integratedFixture(t, (row, { repo }) => {
    if (row.role === 'attribution') return phase === 'open'
      ? { actions: [{ action: 'create', name: '把计划拆成每日待办' }], statusChanges: [] }
      : { actions: [{ action: 'continue', nodeId: row.input.scope.nodeIds[0] }], statusChanges: [] };
    if (row.role === 'learning') return emptyLearning();
    if (row.role === 'verification') return emptyVerification();
    if (row.role !== 'main' || phase !== 'deepen') return '合成答复。';
    seen.push(text(row.body)); step++;
    if (step === 1) return { tool: { id: 'rename-goal', name: 'arcfold_revise_goal', args: { op: 'rename', nodeId: goal, expectedRevision: repo.get('tree_nodes', goal).revision, name: RENAMED, reason: '用户把整个计划概括成两条主线' } } };
    if (step === 2) return { tool: { id: 'child-goal', name: 'arcfold_revise_goal', args: { op: 'create_child', nodeId: goal, expectedRevision: repo.get('tree_nodes', goal).revision, name: CHILD, reason: '讨论进到两条主线的具体内容' } } };
    return announce ? `我把目标改成了「${RENAMED}」，并在下面新建「${CHILD}」，这一轮记在它下面。` : '好的，继续讨论。';
  });
  f.runtime.attribution.timers = { setTimeout: fn => setTimeout(fn, 30000), clearTimeout };
  const agent = await f.main('goal-revision-native');
  const first = await f.turn(agent, '先把计划拆成每日待办。');
  goal = first.nodeIds[0];
  phase = 'deepen';
  const second = await f.turn(agent, '整个计划其实是两条线，我们先讨论这两条线的具体内容。');
  phase = 'after';
  return { f, agent, goal, second, seen };
}

test('main revises its goal in the turn: a rename is visible on the next step, a child takes the turn at its end', async t => {
  const { f, agent, goal, second, seen } = await planningConversation(t);
  assert.equal(f.repo.get('tree_nodes', goal).name, RENAMED);
  assert.ok(seen[1].includes(RENAMED), 'the step after the rename already carries the new goal name');
  const turn = f.repo.get('tree_turns', second.id), child = turn.goalRevisions.find(r => r.op === 'create_child').createdNodeId;
  assert.equal(f.repo.get('tree_nodes', child).parentId, goal);
  assert.deepEqual(turn.nodeIds, [child]);
  assert.equal(turn.status, 'settled');
  assert.deepEqual(turn.goalRevisions.map(r => [r.op, r.state, r.announced]), [['rename', 'applied', true], ['create_child', 'applied', true]]);
  assert.ok(f.repo.list('tree_jobs', j => j.kind === 'learning' && j.input.turnId === second.id).every(j => j.nodeIds.includes(child)), "this turn's learning lands on the revised goal");
  const next = await f.turn(agent, '继续。');
  assert.deepEqual(next.nodeIds, [child], 'the next attribution starts from the revised goal');
  assert.equal(f.runtime.diagnostics?.filter?.(d => d.kind === 'goal_revision_apply').length ?? 0, 0);
});

test('a revision the reply never mentions is recorded as unannounced', async t => {
  const { f, second } = await planningConversation(t, { announce: false });
  const turn = f.repo.get('tree_turns', second.id);
  assert.deepEqual(turn.goalRevisions.map(r => r.announced), [false, false]);
});
