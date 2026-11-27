import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './fixtures/tree-context/helpers.mjs';
import { TREE_TOOLS } from '../src/tree/tools.mjs';
import { promptOutputSchema } from '../src/tree/prompts.mjs';

// Goals are adjusted before the answer by attribution (092): moves, renames and
// new parents change the background main is given, so they are applied before
// this turn's context is built.
const OPEN_DAY = '办好社区开放日', GUIDE = '完成开放日导览图';
const judged = (f, actions) => { f.owner.output = () => ({ actions, statusChanges: [] }); };

test('attribution moves a misplaced goal under another one before the answer; the goal keeps its id, name and items', async t => {
  const f = setup(t), app = f.create(OPEN_DAY), article = f.create(GUIDE);
  judged(f, [{ action: 'move', nodeId: article, parentId: app, reason: '用户确认导览图属于开放日筹备' }, { action: 'continue', nodeId: article }]);
  const turn = await f.attributed(f.begin('main', 1, '导览图是给开放日访客用的。'));
  assert.equal(turn.fallback, null);
  assert.deepEqual(turn.nodeIds, [article], 'the turn stays on the same goal');
  const node = f.repo.get('tree_nodes', article);
  assert.equal(node.parentId, app); assert.equal(node.name, GUIDE);
  assert.deepEqual(f.builder.build(turn.nodeIds, 'main').ancestorPaths[0], [f.repo.rootId(), app, article], 'this turn\'s background is built on the new parent');
  assert.deepEqual(turn.goalChanges, [{ op: 'move', nodeId: article, name: GUIDE, fromParentId: f.repo.rootId(), parentId: app, reason: '用户确认导览图属于开放日筹备' }]);
});

test('attribution renames a goal and adds a parent above it; the turn moves to the new parent', async t => {
  const f = setup(t), goal = f.create('把计划拆成每日待办');
  judged(f, [{ action: 'rename', nodeId: goal, name: '从两条主线推导计划', reason: '用户把计划概括成两条主线' },
    { action: 'add_parent', nodeId: goal, name: OPEN_DAY, reason: '用户说出了更上层的目的' }]);
  const turn = await f.attributed(f.begin('main', 1, '整个计划是为了办好社区开放日，分两条线。'));
  assert.equal(turn.fallback, null);
  const parent = turn.nodeIds[0], node = f.repo.get('tree_nodes', goal);
  assert.equal(f.repo.get('tree_nodes', parent).name, OPEN_DAY); assert.equal(f.repo.get('tree_nodes', parent).parentId, f.repo.rootId());
  assert.equal(node.parentId, parent); assert.equal(node.name, '从两条主线推导计划'); assert.equal(node.summaryNameStale, true);
  assert.deepEqual(turn.createdNodeIds, [parent]);
  assert.deepEqual(turn.goalChanges.map(c => [c.op, c.name]), [['rename', '从两条主线推导计划'], ['add_parent', OPEN_DAY]]);
  assert.equal(turn.goalChanges[0].previousName, '把计划拆成每日待办');
});

test('a structural change that cannot apply falls back to the previous goal and leaves the tree as it was', async t => {
  const cases = {
    cycle: (f, ids) => [{ action: 'move', nodeId: ids.app, parentId: ids.child, reason: '合成' }, { action: 'continue', nodeId: ids.app }],
    root: f => [{ action: 'move', nodeId: f.repo.rootId(), parentId: f.repo.rootId(), reason: '合成' }, { action: 'continue', nodeId: f.repo.rootId() }],
    paused: (f, ids) => [{ action: 'move', nodeId: ids.article, parentId: ids.paused, reason: '合成' }, { action: 'continue', nodeId: ids.article }],
    already: (f, ids) => [{ action: 'move', nodeId: ids.child, parentId: ids.app, reason: '合成' }, { action: 'continue', nodeId: ids.child }],
    protected: (f, ids) => [{ action: 'rename', nodeId: ids.article, name: '新名字', reason: '合成' }, { action: 'continue', nodeId: ids.article }],
    noTarget: (f, ids) => [{ action: 'move', nodeId: ids.article, parentId: ids.app, reason: '合成' }],
    noReason: (f, ids) => [{ action: 'move', nodeId: ids.article, parentId: ids.app }, { action: 'continue', nodeId: ids.article }],
  };
  for (const [name, actions] of Object.entries(cases)) {
    const f = setup(t), ids = { app: f.create(OPEN_DAY), article: f.create(GUIDE), paused: f.create('先放放的事') };
    ids.child = f.create('盘点已有依据', ids.app);
    f.tree.setStatus(f.cmd({ nodeId: ids.paused, status: 'paused', sourceRefs: [] }, f.expected('tree_nodes', ids.paused)));
    const article = f.repo.get('tree_nodes', ids.article);
    f.repo.transaction(() => f.repo.save('tree_nodes', { ...article, nameUserProtected: true }, article.revision));
    const before = f.repo.list('tree_nodes').map(({ id, parentId, name }) => ({ id, parentId, name }));
    judged(f, actions(f, ids));
    const turn = await f.attributed(f.begin('main', 1, '合成用户委托'));
    assert.ok(turn.fallback, `${name} falls back`);
    assert.deepEqual(f.repo.list('tree_nodes').map(({ id, parentId, name }) => ({ id, parentId, name })), before, `${name} leaves the tree unchanged`);
    assert.equal(turn.goalChanges, undefined, `${name} records no change`);
  }
});

test('a move rejects a newer version of either goal even when the candidate display is unchanged', t => {
  for (const touchedGoal of ['article', 'application']) {
    const f = setup(t), goals = { article: f.create(GUIDE), application: f.create(OPEN_DAY) };
    const input = f.begin(), frozen = f.attribution.freeze(input.sessionId, input.nativeTurn, [input.message]);
    const changed = f.repo.get('tree_nodes', goals[touchedGoal]);
    f.repo.transaction(() => f.repo.save('tree_nodes', { ...changed, lastOwnTurnAt: f.repo.now() }, changed.revision));
    const result = { actions: [{ action: 'move', nodeId: goals.article, parentId: goals.application, reason: '合成' }, { action: 'continue', nodeId: goals.article }], statusChanges: [] };
    assert.throws(() => f.attribution.applyResult(result, { job: { input: frozen.input, inputRevisionSet: frozen.revisions }, requestId: `stale-${touchedGoal}` }), { code: 'JOB_STALE' });
    assert.equal(f.repo.get('tree_nodes', goals.article).parentId, f.repo.rootId());
    assert.equal(f.attribution.existing(input.sessionId, input.nativeTurn), null);
  }
});

test('main has no goal tool; attribution may output move, rename and add_parent, each with a reason', () => {
  assert.equal(Object.hasOwn(TREE_TOOLS, 'arcfold_revise_goal'), false);
  const actions = JSON.stringify(promptOutputSchema('attribution'));
  for (const op of ['move', 'rename', 'add_parent']) assert.match(actions, new RegExp(`"const":"${op}"`));
});
