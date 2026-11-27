import test from 'node:test';
import assert from 'node:assert/strict';
import { integratedFixture } from './fixtures/tree-integration/native.mjs';
import { emptyLearning, emptyVerification } from './fixtures/tree-learning/helpers.mjs';

// Since 092 goals are adjusted before the answer by attribution, and main has
// no goal tool. These run the real native loop with a synthetic model.
const OPEN_DAY = '办好社区开放日', GUIDE = '完成开放日导览图';
const text = body => body.messages.flatMap(m => m.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
const currentNodes = body => body.messages.flatMap(m => m.content ?? []).flatMap(b => {
  if (b.type !== 'text') return [];
  try { const value = JSON.parse(b.text); return value.logicalTurnId && value.nodes ? [value.nodes] : []; } catch { return []; }
}).at(-1);

async function conversation(t, attribution) {
  let turnNo = 0;
  const ids = {}, mains = [];
  const f = await integratedFixture(t, (row, { repo }) => {
    if (row.role === 'attribution') return { actions: attribution(turnNo, ids, repo, row), statusChanges: [] };
    if (row.role === 'learning') return emptyLearning();
    if (row.role === 'verification') return emptyVerification();
    if (row.role === 'main') mains.push({ turnNo, body: row.body });
    return '合成答复。';
  });
  f.runtime.attribution.timers = { setTimeout: fn => setTimeout(fn, 30000), clearTimeout };
  const agent = await f.main('goal-attribution-native');
  const turn = async (n, message) => { turnNo = n; return f.turn(agent, message); };
  return { f, ids, mains, turn };
}

test('attribution moves the guide under the open day before the answer; main gets the new path in the same turn', async t => {
  const { f, ids, mains, turn } = await conversation(t, (n, ids, repo, row) => {
    if (n === 1) return [{ action: 'create', name: OPEN_DAY }];
    if (n === 2) return [{ action: 'create', name: GUIDE }];
    if (n === 3) return [{ action: 'move', nodeId: ids.article, parentId: ids.app, reason: '用户确认导览图属于开放日筹备' }, { action: 'continue', nodeId: ids.article }];
    return [{ action: 'continue', nodeId: row.input.scope.nodeIds[0] }];
  });
  ids.app = (await turn(1, '下周要办好社区开放日。')).nodeIds[0];
  ids.article = (await turn(2, '开始准备导览图。')).nodeIds[0];
  assert.equal(f.repo.get('tree_nodes', ids.article).parentId, f.repo.rootId());
  const third = await turn(3, '导览图是给开放日访客用的。');
  assert.equal(f.repo.get('tree_nodes', ids.article).parentId, ids.app);
  assert.equal(f.repo.get('tree_nodes', ids.article).name, GUIDE);
  assert.deepEqual(third.nodeIds, [ids.article], 'the turn stays on the same goal');
  const table = currentNodes(mains.find(m => m.turnNo === 3).body);
  assert.deepEqual(table[0].path.map(n => n.id), [f.repo.rootId(), ids.app, ids.article], 'the first main request of this turn already carries the new path');
  const row = f.repo.get('tree_turns', third.id);
  assert.deepEqual(row.goalChanges.map(c => [c.op, c.nodeId, c.parentId]), [['move', ids.article, ids.app]]);
  assert.equal(row.status, 'settled');
});

test('attribution renames a goal and adds a parent before the answer; the turn and its learning sit on the new parent', async t => {
  const { f, ids, mains, turn } = await conversation(t, (n, ids, repo, row) => {
    if (n === 1) return [{ action: 'create', name: '把计划拆成每日待办' }];
    if (n === 2) return [{ action: 'rename', nodeId: ids.plan, name: '从两条主线推导计划', reason: '用户把计划概括成两条主线' },
      { action: 'add_parent', nodeId: ids.plan, name: OPEN_DAY, reason: '用户说出了更上层的目的' }];
    return [{ action: 'continue', nodeId: row.input.scope.nodeIds[0] }];
  });
  ids.plan = (await turn(1, '先把计划拆成每日待办。')).nodeIds[0];
  const second = await turn(2, '整个计划是为了办好社区开放日，分两条线。');
  const parent = second.nodeIds[0];
  assert.notEqual(parent, ids.plan);
  assert.equal(f.repo.get('tree_nodes', parent).name, OPEN_DAY);
  assert.equal(f.repo.get('tree_nodes', ids.plan).parentId, parent);
  assert.equal(f.repo.get('tree_nodes', ids.plan).name, '从两条主线推导计划');
  const table = currentNodes(mains.find(m => m.turnNo === 2).body);
  assert.deepEqual(table.map(n => n.id), [parent]); assert.equal(table[0].name, OPEN_DAY);
  const learning = f.repo.list('tree_jobs', job => job.kind === 'learning' && (job.input.turnId === second.id || job.trigger?.turnId === second.id));
  assert.ok(learning.length > 0, 'the turn scheduled learning');
  assert.ok(learning.every(job => job.nodeIds.includes(parent)), "this turn's learning lands on the new parent");
});

test('a move that cannot apply falls back to the previous goal; the tree is unchanged and main still answers', async t => {
  const { f, ids, turn } = await conversation(t, (n, ids, repo, row) => {
    if (n === 1) return [{ action: 'create', name: OPEN_DAY }];
    if (n === 2) return [{ action: 'create_child', parentId: ids.app, name: GUIDE }];
    if (n === 3) return [{ action: 'move', nodeId: ids.app, parentId: ids.article, reason: '合成：挪到自己的下级下面' }, { action: 'continue', nodeId: ids.app }];
    return [{ action: 'continue', nodeId: row.input.scope.nodeIds[0] }];
  });
  ids.app = (await turn(1, '下周要办好社区开放日。')).nodeIds[0];
  ids.article = (await turn(2, '开始准备导览图。')).nodeIds[0];
  const third = await turn(3, '合成：继续。');
  assert.ok(third.fallback); assert.equal(third.fallback.code, 'TREE_CYCLE');
  assert.equal(f.repo.get('tree_nodes', ids.app).parentId, f.repo.rootId());
  assert.equal(f.repo.get('tree_nodes', ids.article).parentId, ids.app);
  assert.deepEqual(third.nodeIds, [ids.article], 'the turn falls back to the previous goal');
  assert.equal(f.repo.get('tree_turns', third.id).status, 'settled');
});

test('main has no goal tool and is not told to revise goals', async t => {
  const { mains, turn } = await conversation(t, () => [{ action: 'create', name: OPEN_DAY }]);
  await turn(1, '下周要办好社区开放日。');
  const body = mains[0].body;
  assert.equal(body.tools.some(tool => tool.name === 'arcfold_revise_goal'), false);
  assert.doesNotMatch(text(body), /arcfold_revise_goal/);
  assert.match(text(body), /你不修改目标/);
});
