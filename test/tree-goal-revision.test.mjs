import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/tree-domain/helpers.mjs';

// A planning goal that the conversation outgrows: the shape of the 0.6.0 case
// where twelve turns stayed on the opening wording of one goal.
function planningTurn(t) {
  const f = fixture(t), plan = f.create('把计划拆成每日待办'), other = f.create('整理第一篇的核心问题');
  const turn = f.tree.applyAttribution(f.attribution([{ action: 'continue', nodeId: plan }])).result.turnId;
  const asMain = () => f.asModel('main', f.repo.get('tree_turns', turn).nodeIds);
  const record = (op, nodeId, extra = {}) => {
    asMain(); const row = f.repo.get('tree_turns', turn);
    return f.tree.recordGoalRevision(f.cmd({ turnId: turn, revision: { id: `${op}-${nodeId}`, op, nodeId, reason: '用户把讨论推进到新的一层', callId: `call-${op}`, state: op === 'rename' ? 'applied' : 'pending', ...extra } }, f.expected('tree_turns', row.id)));
  };
  const apply = (mainCommitted = true) => { asMain(); return f.tree.applyGoalRevisions(f.cmd({ turnId: turn, mainCommitted }, f.expected('tree_turns', turn))).result; };
  return { f, plan, other, turn, asMain, record, apply };
}

test('main renames its current goal in place without changing the turn assignment', t => {
  const { f, plan, turn, asMain } = planningTurn(t), before = f.repo.get('tree_turns', turn);
  asMain();
  const result = f.tree.renameGoal(f.cmd({ nodeId: plan, name: '从两条主线推导计划并接上每日安排', sourceRefs: [f.ref] }, f.expected('tree_nodes', plan))).result;
  assert.equal(result.previousName, '把计划拆成每日待办');
  assert.equal(f.repo.get('tree_nodes', plan).name, '从两条主线推导计划并接上每日安排');
  assert.equal(f.repo.get('tree_nodes', plan).nameOrigin, 'model');
  const after = f.repo.get('tree_turns', turn);
  assert.deepEqual(after.nodeIds, before.nodeIds); assert.equal(after.assignmentRevision, before.assignmentRevision);
  assert.equal(f.repo.list('tree_exposures', e => e.revoked).length, 0);
});

test('rename is refused outside the turn, on the root, on a user-named goal and on a stale revision', t => {
  const { f, plan, other, asMain } = planningTurn(t);
  asMain();
  assert.throws(() => f.tree.renameGoal(f.cmd({ nodeId: other, name: '别的', sourceRefs: [] }, f.expected('tree_nodes', other))), { code: 'OUT_OF_SCOPE' });
  f.context.nodeIds = [f.repo.rootId()];
  assert.throws(() => f.tree.renameGoal(f.cmd({ nodeId: f.repo.rootId(), name: '别的', sourceRefs: [] }, f.expected('tree_nodes', f.repo.rootId()))), { code: 'ROOT_INVARIANT' });
  asMain();
  const stale = f.expected('tree_nodes', plan);
  f.tree.renameGoal(f.cmd({ nodeId: plan, name: '第一次改名', sourceRefs: [] }, stale));
  assert.throws(() => f.tree.renameGoal(f.cmd({ nodeId: plan, name: '第二次改名', sourceRefs: [] }, stale)), { code: 'REVISION_CONFLICT' });
  const node = f.repo.get('tree_nodes', plan);
  f.repo.transaction(() => f.repo.save('tree_nodes', { ...node, nameUserProtected: true }, node.revision));
  assert.throws(() => f.tree.renameGoal(f.cmd({ nodeId: plan, name: '第三次改名', sourceRefs: [] }, f.expected('tree_nodes', plan))), { code: 'USER_PROTECTED' });
  f.asModel('learning', [plan]);
  assert.throws(() => f.tree.renameGoal(f.cmd({ nodeId: plan, name: '学习环节不能改名', sourceRefs: [] }, f.expected('tree_nodes', plan))), { code: 'FORBIDDEN' });
});

test('create_child waits for the turn end, then moves this turn onto the new child', t => {
  const { f, plan, turn, record, apply } = planningTurn(t);
  record('create_child', plan, { name: '讨论对产品和对用户本人的认知' });
  assert.deepEqual(f.repo.get('tree_turns', turn).nodeIds, [plan], 'still the original goal while the turn runs');
  const result = apply(), child = result.revisions[0].createdNodeId, row = f.repo.get('tree_turns', turn);
  assert.equal(result.revisions[0].state, 'applied');
  assert.equal(f.repo.get('tree_nodes', child).parentId, plan);
  assert.equal(f.repo.get('tree_nodes', child).name, '讨论对产品和对用户本人的认知');
  assert.deepEqual(row.nodeIds, [child]); assert.equal(row.assignmentRevision, 2); assert.ok(row.createdNodeIds.includes(child));
  assert.deepEqual(f.repo.list('tree_links', l => l.turnId === turn && l.active).map(l => l.nodeId), [child]);
  assert.equal(f.repo.list('tree_jobs', j => j.kind === 'learning').length, 0, 'settlement, not the revision, queues learning');
});

// F34: after add_parent the conversation is about the higher goal. Keeping the
// turn on the old child let the next turns continue under it.
test('add_parent inserts a higher goal above the current one and moves the turn onto it', t => {
  const { f, plan, turn, record, apply } = planningTurn(t), root = f.repo.rootId();
  record('add_parent', plan, { name: '让对方认识用户本人和产品' });
  const result = apply(), parent = result.revisions[0].createdNodeId;
  assert.equal(f.repo.get('tree_nodes', parent).parentId, root);
  assert.equal(f.repo.get('tree_nodes', plan).parentId, parent);
  const row = f.repo.get('tree_turns', turn); assert.deepEqual(row.nodeIds, [parent]); assert.equal(row.assignmentRevision, 2);
  assert.deepEqual(f.repo.list('tree_links', l => l.turnId === turn && l.active).map(l => l.nodeId), [parent]);
  f.repo.assertTree();
});

test('the owner correction after add_parent returns the turn to the original goal and keeps the new parent', t => {
  const { f, plan, turn, record, apply } = planningTurn(t);
  record('add_parent', plan, { name: '让对方认识用户本人和产品' });
  const parent = apply().revisions[0].createdNodeId;
  f.asUser();
  f.tree.correctAssignment(f.cmd({ turnId: turn, nodeIds: [plan], sourceRefs: [], undoCreate: true }, f.expected('tree_turns', turn)));
  assert.deepEqual(f.repo.get('tree_turns', turn).nodeIds, [plan]);
  assert.notEqual(f.repo.get('tree_nodes', parent).deleted, true, 'the parent still holds the original goal');
  assert.equal(f.repo.get('tree_nodes', plan).parentId, parent);
});

// F34 turn 29: the turn sits on a daily-plan goal while the conversation moves
// to another piece of work under the application goal above it.
test('create_child on an ancestor creates the goal there and moves the turn from the current goal', t => {
  const f = fixture(t), application = f.create('月底前完成申请'), daily = f.create('把路线图拆成每日待办', application);
  const turn = f.tree.applyAttribution(f.attribution([{ action: 'continue', nodeId: daily }])).result.turnId;
  f.asModel('main', [daily]);
  f.tree.recordGoalRevision(f.cmd({ turnId: turn, revision: { id: 'r1', op: 'create_child', nodeId: application, name: '把核心纲领往下拆成要实现和证明的结果', reason: '用户要求定稿这一层并往下拆', callId: 'c1', state: 'pending' } }, f.expected('tree_turns', turn)));
  const result = f.tree.applyGoalRevisions(f.cmd({ turnId: turn, mainCommitted: true }, f.expected('tree_turns', turn))).result, child = result.revisions[0].createdNodeId;
  assert.equal(f.repo.get('tree_nodes', child).parentId, application);
  assert.equal(f.repo.get('tree_nodes', daily).parentId, application, 'the daily goal stays where it was');
  assert.deepEqual(f.repo.get('tree_turns', turn).nodeIds, [child]);
  f.repo.assertTree();
});

test('switch moves this turn to an existing goal', t => {
  const { f, other, turn, record, apply } = planningTurn(t);
  record('switch', other);
  apply();
  const row = f.repo.get('tree_turns', turn); assert.deepEqual(row.nodeIds, [other]); assert.equal(row.assignmentRevision, 2);
});

test('revisions are dropped when the main turn did not commit, and nothing in the tree changes', t => {
  const { f, plan, turn, record, apply } = planningTurn(t), nodes = f.repo.list('tree_nodes').length;
  record('create_child', plan, { name: '不会生效的子目标' });
  const result = apply(false);
  assert.equal(result.revisions[0].state, 'dropped'); assert.equal(result.revisions[0].reason, 'main_not_committed');
  assert.equal(f.repo.list('tree_nodes').length, nodes); assert.deepEqual(f.repo.get('tree_turns', turn).nodeIds, [plan]);
});

test('the same call is recorded once and a turn accepts at most eight revisions', t => {
  const { f, plan, turn, record } = planningTurn(t);
  record('create_child', plan, { name: '子目标' });
  assert.equal(record('create_child', plan, { name: '子目标' }).result.duplicate, true);
  for (let i = 1; i < 8; i++) record('create_child', plan, { name: `子目标${i}`, callId: `c${i}`, id: `r${i}` });
  assert.equal(f.repo.get('tree_turns', turn).goalRevisions.length, 8);
  assert.throws(() => record('create_child', plan, { name: '第九个', id: 'r9' }), { code: 'GOAL_REVISION_LIMIT' });
});

test('the existing owner correction undoes a revision made by main', t => {
  const { f, plan, turn, record, apply } = planningTurn(t);
  record('create_child', plan, { name: '误拆的子目标' });
  const child = apply().revisions[0].createdNodeId;
  f.asUser();
  const receipt = f.tree.correctAssignment(f.cmd({ turnId: turn, nodeIds: [plan], sourceRefs: [], undoCreate: true }, f.expected('tree_turns', turn))).result;
  assert.deepEqual(receipt.removed, [child]);
  assert.deepEqual(f.repo.get('tree_turns', turn).nodeIds, [plan]);
  assert.equal(f.repo.get('tree_nodes', child).deleted, true, 'a child with no other experience is removed with the undo');
  assert.equal(f.repo.list('tree_jobs', j => j.kind === 'learning' && j.nodeIds.includes(plan)).length, 1, 'learning is queued again for the original goal');
});

// F46 (0.7.0 replay, turn 32): the first-article goal sat at the root while the
// application it belongs to was a sibling. move puts the same goal, with its
// history, under the right parent.
function misplacedArticle(t) {
  const f = fixture(t), application = f.create('月底前完成申请'), inventory = f.create('盘点申请论述的依据', application), article = f.create('写出第一篇文章');
  const turn = f.tree.applyAttribution(f.attribution([{ action: 'continue', nodeId: article }])).result.turnId;
  const record = (parentId, extra = {}) => {
    f.asModel('main', [article]);
    return f.tree.recordGoalRevision(f.cmd({ turnId: turn, revision: { id: extra.id ?? 'move-1', op: 'move', nodeId: article, parentId, reason: '用户说四篇文章用于投递', callId: extra.id ?? 'c-move', state: 'pending', ...extra.revision } }, f.expected('tree_turns', turn)));
  };
  const apply = () => { f.asModel('main', [article]); return f.tree.applyGoalRevisions(f.cmd({ turnId: turn, mainCommitted: true }, f.expected('tree_turns', turn))).result; };
  return { f, application, inventory, article, turn, record, apply };
}

test('move waits for the turn end, then puts the same goal under the new parent and keeps the turn on it', t => {
  const { f, application, article, turn, record, apply } = misplacedArticle(t), root = f.repo.rootId(), before = f.repo.get('tree_turns', turn);
  record(application);
  assert.equal(f.repo.get('tree_nodes', article).parentId, root, 'still at the root while the turn runs');
  const result = apply(), row = f.repo.get('tree_turns', turn), node = f.repo.get('tree_nodes', article);
  assert.deepEqual(result.revisions.map(r => [r.op, r.state]), [['move', 'applied']]);
  assert.equal(node.parentId, application); assert.equal(node.name, '写出第一篇文章');
  assert.deepEqual(row.nodeIds, [article]); assert.equal(row.assignmentRevision, before.assignmentRevision, 'the turn assignment does not change');
  assert.equal(row.goalRevisions[0].fromParentId, root);
  assert.equal(f.repo.list('tree_nodes', n => !n.deleted).length, 4, 'no goal is created');
  f.repo.assertTree();
  f.asUser();
  f.tree.moveNode(f.cmd({ nodeId: article, parentId: root, sourceRefs: [] }, f.expected('tree_nodes', article)));
  assert.equal(f.repo.get('tree_nodes', article).parentId, root, 'the owner moves it back with the existing move');
});

test('move is dropped when the parent is gone, below the goal itself, or already its parent', t => {
  const { f, application, article, record, apply } = misplacedArticle(t), child = f.create('第一篇的开篇现场', article);
  const done = f.repo.get('tree_nodes', application);
  f.repo.transaction(() => f.repo.save('tree_nodes', { ...done, status: 'completed' }, done.revision));
  record(application, { id: 'm1' }); record(child, { id: 'm2' }); record(f.repo.rootId(), { id: 'm3' });
  assert.deepEqual(apply().revisions.map(r => [r.id, r.state, r.reason]), [['m1', 'dropped', 'parent_unavailable'], ['m2', 'dropped', 'tree_cycle'], ['m3', 'dropped', 'already_there']]);
  assert.equal(f.repo.get('tree_nodes', article).parentId, f.repo.rootId());
});

test('a move revision carries a parent and no name; other ops carry no parent', t => {
  const { f, application, article, turn, record } = misplacedArticle(t);
  assert.throws(() => record(application, { id: 'm-name', revision: { name: '改个名' } }), { code: 'INVALID_FIELD' });
  f.asModel('main', [article]);
  assert.throws(() => f.tree.recordGoalRevision(f.cmd({ turnId: turn, revision: { id: 'r-parent', op: 'create_child', nodeId: article, name: '子目标', parentId: application, reason: 'x', callId: 'c', state: 'pending' } }, f.expected('tree_turns', turn))), { code: 'INVALID_FIELD' });
});
