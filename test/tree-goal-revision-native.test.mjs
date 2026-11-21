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

// Synthetic shape of F34 (0.6.0 + 035, turn 29): the turn is filed under a
// daily-plan goal while the conversation moves to another piece of work under
// the application goal above it.
test('main sees the current goal and its path every turn, and creates a child on an ancestor in one call', async t => {
  const APP = '月底前完成申请', DAILY = '把路线图拆成每日待办', OTHER = '整理冥想体验', NEXT = '把核心纲领往下拆成要实现和证明的结果';
  let turnNo = 0, step = 0;
  const ids = {}, seen = [], raw = [];
  const f = await integratedFixture(t, (row, { repo }) => {
    if (row.role === 'attribution') {
      if (turnNo === 1) return { actions: [{ action: 'create', name: APP }], statusChanges: [] };
      if (turnNo === 2) return { actions: [{ action: 'create', name: OTHER }], statusChanges: [] };
      if (turnNo === 3) return { actions: [{ action: 'create_child', name: DAILY, parentId: ids.app }], statusChanges: [] };
      return { actions: [{ action: 'continue', nodeId: row.input.scope.nodeIds[0] }], statusChanges: [] };
    }
    if (row.role === 'learning') return emptyLearning();
    if (row.role === 'verification') return emptyVerification();
    if (row.role !== 'main' || turnNo !== 4) return '合成答复。';
    seen.push(text(row.body)); raw.push(JSON.stringify(row.body)); step++;
    const call = (id, nodeId, name) => ({ tool: { id, name: 'arcfold_revise_goal', args: { op: 'create_child', nodeId, expectedRevision: repo.get('tree_nodes', nodeId).revision, name, reason: '用户要求定稿这一层并往下拆' } } });
    if (step === 1) return call('outside-path', ids.other, '不该建在这里');
    if (step === 2) return call('on-ancestor', ids.app, NEXT);
    return `这一轮转到「${APP}」下新建的「${NEXT}」。`;
  });
  f.runtime.attribution.timers = { setTimeout: fn => setTimeout(fn, 30000), clearTimeout };
  const agent = await f.main('goal-revision-ancestor-native');
  turnNo = 1; ids.app = (await f.turn(agent, '月底前要完成申请。')).nodeIds[0];
  turnNo = 2; ids.other = (await f.turn(agent, '另外聊聊今天的冥想。')).nodeIds[0];
  turnNo = 3; ids.daily = (await f.turn(agent, '回到申请，先把路线图拆成每日待办。')).nodeIds[0];
  assert.equal(f.repo.get('tree_nodes', ids.daily).parentId, ids.app);
  turnNo = 4; const fourth = await f.turn(agent, '这一层先定稿，接着往下推导要做的事。');
  assert.match(seen[0], new RegExp(`"name":"${DAILY}","path":\\[[^\\]]*"name":"${APP}"[^\\]]*"name":"${DAILY}"`), 'the turn table names the current goal and its path');
  assert.match(raw[1], /OUT_OF_SCOPE|a goal on its path/, 'a goal off the current path is refused and main sees why');
  const turn = f.repo.get('tree_turns', fourth.id);
  assert.equal(turn.goalRevisions.filter(r => r.nodeId === ids.other).length, 0);
  const created = turn.goalRevisions.find(r => r.op === 'create_child' && r.state === 'applied').createdNodeId;
  assert.equal(f.repo.get('tree_nodes', created).parentId, ids.app);
  assert.equal(f.repo.get('tree_nodes', created).name, NEXT);
  assert.deepEqual(turn.nodeIds, [created]);
  assert.equal(f.repo.list('tree_nodes', n => n.parentId === ids.other && !n.deleted).length, 0);
});

test('a revision the reply never mentions is recorded as unannounced', async t => {
  const { f, second } = await planningConversation(t, { announce: false });
  const turn = f.repo.get('tree_turns', second.id);
  assert.deepEqual(turn.goalRevisions.map(r => r.announced), [false, false]);
});

// Shape of 042-F1 (0.7.0, gpt-6.1-sol): switching to an existing goal, the
// model always filled `name` — first with the goal's own name, then with "".
async function switchConversation(t, names) {
  const A = '盘点申请所需的结果、已有证据与缺口', B = '把方向稿定下来';
  let turnNo = 0, step = 0;
  const ids = {}, raw = [];
  const f = await integratedFixture(t, (row, { repo }) => {
    if (row.role === 'attribution') {
      if (turnNo === 1) return { actions: [{ action: 'create', name: A }], statusChanges: [] };
      if (turnNo === 2) return { actions: [{ action: 'create', name: B }], statusChanges: [] };
      return { actions: [{ action: 'continue', nodeId: row.input.scope.nodeIds[0] }], statusChanges: [] };
    }
    if (row.role === 'learning') return emptyLearning();
    if (row.role === 'verification') return emptyVerification();
    if (row.role !== 'main' || turnNo !== 3) return '合成答复。';
    raw.push(JSON.stringify(row.body)); step++;
    if (step <= names.length) {
      const args = { op: 'switch', nodeId: ids.a, expectedRevision: repo.get('tree_nodes', ids.a).revision, reason: '用户要求改一下目标' };
      if (names[step - 1] !== undefined) args.name = names[step - 1];
      return { tool: { id: 'switch-' + step, name: 'arcfold_revise_goal', args } };
    }
    return `这一轮切换到已有目标「${A}」。`;
  });
  f.runtime.attribution.timers = { setTimeout: fn => setTimeout(fn, 30000), clearTimeout };
  const agent = await f.main('goal-switch-name-native');
  turnNo = 1; ids.a = (await f.turn(agent, '先盘点申请需要的结果。')).nodeIds[0];
  turnNo = 2; ids.b = (await f.turn(agent, '换个话题，先把方向稿定下来。')).nodeIds[0];
  turnNo = 3; const third = await f.turn(agent, '改一下目标');
  return { f, ids, raw, A, turn: f.repo.get('tree_turns', third.id) };
}

for (const [label, name] of [['its own name with spaces', '  盘点申请所需的结果、已有证据与缺口 '], ['an empty name', '']]) {
  test(`switch to an existing goal succeeds when main also passes ${label}`, async t => {
    const { f, ids, A, turn } = await switchConversation(t, [name]);
    assert.deepEqual(turn.goalRevisions.map(r => [r.op, r.state, r.nodeId]), [['switch', 'applied', ids.a]]);
    assert.equal(turn.goalRevisions[0].name, undefined, 'an accepted name on switch is not stored as a rename');
    assert.deepEqual(turn.nodeIds, [ids.a]);
    assert.equal(f.repo.get('tree_nodes', ids.a).name, A);
  });
}

test('switch with a different name is refused with a hint, and the retry without it succeeds', async t => {
  const { f, ids, raw, A, turn } = await switchConversation(t, ['另起一个名字', undefined]);
  assert.match(raw[1], /omit name|rename/, 'main is told to omit name or rename after switching');
  assert.deepEqual(turn.goalRevisions.map(r => [r.op, r.state]), [['switch', 'applied']]);
  assert.deepEqual(turn.nodeIds, [ids.a]);
  assert.equal(f.repo.get('tree_nodes', ids.a).name, A);
});

// Shape of F46 (0.7.0 replay, turn 32): the article goal sits at the root while
// the application goal it belongs to is a sibling. Main sees each goal's parent
// in the overview and moves the article, with its history, under the application.
test('main sees where each goal sits and moves the current goal under another one', async t => {
  const APP = '月底前完成申请', ARTICLE = '写出第一篇文章，讲清面对的问题';
  let turnNo = 0, step = 0;
  const ids = {}, raw = [];
  const f = await integratedFixture(t, (row, { repo }) => {
    if (row.role === 'attribution') {
      if (turnNo === 1) return { actions: [{ action: 'create', name: APP }], statusChanges: [] };
      if (turnNo === 2) return { actions: [{ action: 'create', name: ARTICLE }], statusChanges: [] };
      return { actions: [{ action: 'continue', nodeId: row.input.scope.nodeIds[0] }], statusChanges: [] };
    }
    if (row.role === 'learning') return emptyLearning();
    if (row.role === 'verification') return emptyVerification();
    if (row.role !== 'main' || turnNo !== 3) return '合成答复。';
    raw.push(JSON.stringify(row.body)); step++;
    const move = (id, parentId) => ({ tool: { id, name: 'arcfold_revise_goal', args: { op: 'move', nodeId: ids.article, expectedRevision: repo.get('tree_nodes', ids.article).revision, parentId, reason: '用户说这几篇文章用于投递' } } });
    if (step === 1) return move('move-self', ids.article);
    if (step === 2) return move('move-app', ids.app);
    return `把这个目标挪到「${APP}」下面。`;
  });
  f.runtime.attribution.timers = { setTimeout: fn => setTimeout(fn, 30000), clearTimeout };
  const agent = await f.main('goal-move-native');
  turnNo = 1; ids.app = (await f.turn(agent, '月底前要完成申请。')).nodeIds[0];
  turnNo = 2; ids.article = (await f.turn(agent, '开始准备第一篇文章。')).nodeIds[0];
  assert.equal(f.repo.get('tree_nodes', ids.article).parentId, f.repo.rootId());
  turnNo = 3; const third = await f.turn(agent, '这几篇文章就是申请要交的。');
  assert.match(raw[0], new RegExp(`"id":"${ids.article}","name":"${ARTICLE}","oneLine":"","parentId":"${f.repo.rootId()}"|"parentId":"${f.repo.rootId()}"`), 'the overview tells main where each goal sits');
  assert.match(raw[1], /TREE_CYCLE|below itself/, 'moving a goal under itself is refused and main sees why');
  const turn = f.repo.get('tree_turns', third.id);
  assert.deepEqual(turn.goalRevisions.map(r => [r.op, r.state, r.announced]), [['move', 'applied', true]]);
  assert.equal(f.repo.get('tree_nodes', ids.article).parentId, ids.app);
  assert.equal(f.repo.get('tree_nodes', ids.article).name, ARTICLE);
  assert.deepEqual(turn.nodeIds, [ids.article], 'the turn stays on the same goal');
  turnNo = 4; step = 0; raw.length = 0;
  const fourth = await f.turn(agent, '继续。');
  assert.deepEqual(fourth.nodeIds, [ids.article]);
});

test('the goal wording given to main is about the result to achieve, not the current step', async t => {
  const { seen } = await planningConversation(t);
  assert.ok(!seen[0].includes('此刻在做的事'), 'the old "what is being done right now" wording is gone');
  assert.match(seen[0], /要做成的结果/);
  assert.match(seen[0], /换步骤不算/);
});
