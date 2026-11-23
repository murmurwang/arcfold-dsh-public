import test from 'node:test';
import assert from 'node:assert/strict';
import { learningFixture } from './fixtures/tree-learning/helpers.mjs';
import { OTHER_GOALS_LIMIT } from '../src/tree/learning.mjs';
import { modelView } from '../src/tree/model-view.mjs';

const empty = () => ({ categories: [], understandings: [], changes: [], method: null });
const current = job => job.input.sources.find(s => s.role === 'user' && job.input.currentTurn.sourceIds.includes(s.id));
const nodeContext = (f, node) => JSON.parse(f.builder.build([node], 'main').segments.find(s => s.key === `node:${node}`).text);
const method = (sourceId, extra = {}) => ({ kind: 'collaboration', situation: '遇到自有工具的限制时', action: '先比较调整工具和沿用流程的投入', basis: '合成依据', notApplicable: '',
  expectedEffect: { category: 'omitted', change: 'less', text: '减少提醒重新考虑工具' }, sourceIds: [sourceId], ...extra });

// A turn on one goal (choosing material) that also says something about another (development work).
async function twoGoals(t) {
  const f = learningFixture(t, { outputProtocol: 'experience-v1' });
  const a = f.create('合成选材'), b = f.create('合成开发协作');
  const turn = await f.turn(a, '顺带说一句：工具是我们自己的，限制住了就先改工具。'), job = f.learning.enqueue(turn.id, a);
  return { f, a, b, turn, job, source: current(job) };
}

test('learning lists the other goals and places an item about one of them on that goal', async t => {
  const { f, a, b, turn, job, source } = await twoGoals(t), root = f.repo.rootId();
  const listed = job.input.otherGoals.map(g => g.id);
  assert.ok(listed.includes(b)); assert.ok(!listed.includes(a)); assert.ok(!listed.includes(root));
  const done = f.complete(job, { ...empty(), understandings: [
    { content: '自有开发工具的限制可以改，不必绕道走重流程', source: 'user_expressed', sourceIds: [source.id], goalId: b, goalReason: '讲的是开发协作本身' },
    { content: '选材时顺带记下的开发经历可作为素材', source: 'assistant_inferred', sourceIds: [source.id] }] });
  assert.equal(done.status, 'committed'); assert.deepEqual(done.rejectedItems, []);
  const [placedId] = done.resultRef.placed.find(p => p.goalId === b).understandings.itemIds, placed = f.repo.get('tree_items', placedId);
  assert.equal(placed.nodeId, b); assert.equal(placed.placedFromNodeId, a); assert.equal(placed.placementReason, '讲的是开发协作本身'); assert.equal(placed.sourceTurnId, turn.id);
  assert.equal(done.resultRef.understandings.itemIds.length, 1, 'only the unplaced understanding stays on the turn goal');
  assert.deepEqual(nodeContext(f, b).understandings.map(u => u.content), ['自有开发工具的限制可以改，不必绕道走重流程']);
  assert.deepEqual(nodeContext(f, a).understandings.map(u => u.content), ['选材时顺带记下的开发经历可作为素材']);
});

test('a placed method lands on the other goal', async t => {
  const { f, a, b, job, source } = await twoGoals(t);
  const done = f.complete(job, { ...empty(), method: method(source.id, { goalId: b, goalReason: '开发协作的做法' }) });
  assert.equal(done.status, 'committed');
  const [id] = done.resultRef.placed[0].methods.itemIds;
  assert.equal(f.repo.get('tree_items', id).nodeId, b); assert.deepEqual(done.resultRef.methods.itemIds ?? [], []);
  assert.equal(f.repo.list('tree_items', i => i.kind === 'method' && i.nodeId === a).length, 0);
});

test('an unlisted or ancestor goal keeps the item on the turn goal and reports it', async t => {
  const { f, a, job, source } = await twoGoals(t), root = f.repo.rootId();
  const done = f.complete(job, { ...empty(), understandings: [
    { content: '合成认识一', source: 'user_expressed', sourceIds: [source.id], goalId: root, goalReason: '上级' },
    { content: '合成认识二', source: 'user_expressed', sourceIds: [source.id], goalId: 'missing-goal', goalReason: '不存在' }] });
  assert.equal(done.status, 'committed');
  assert.deepEqual(done.rejectedItems.map(r => r.code), ['PLACEMENT_GOAL', 'PLACEMENT_GOAL']);
  assert.equal(done.resultRef.placed, undefined);
  assert.deepEqual(done.resultRef.understandings.itemIds.map(id => f.repo.get('tree_items', id).nodeId), [a, a]);
});

test('a goal completed after the input was frozen keeps the item here with a diagnostic', async t => {
  const { f, a, b, job, source } = await twoGoals(t);
  f.asUser(); f.tree.setStatus(f.cmd({ nodeId: b, status: 'completed', sourceRefs: [] }, f.expected('tree_nodes', b)));
  const done = f.complete(job, { ...empty(), understandings: [{ content: '合成认识', source: 'user_expressed', sourceIds: [source.id], goalId: b, goalReason: '属于开发协作' }] });
  assert.equal(done.status, 'committed', JSON.stringify(done.error));
  assert.equal(f.repo.get('tree_items', done.resultRef.understandings.itemIds[0]).nodeId, a);
  const diagnostics = Object.values(f.repo.meta().runtimeDiagnostics ?? {}).filter(d => d.kind === 'learning_placement');
  assert.deepEqual(diagnostics.map(d => [d.code, d.goalId, d.jobId, d.nodeId]), [['PLACEMENT_GOAL_CLOSED', b, job.id, a]]);
});

test('at most two items go elsewhere in one turn; the third stays', async t => {
  const { f, a, b, job, source } = await twoGoals(t);
  const done = f.complete(job, { ...empty(), understandings: ['一', '二', '三'].map(n => ({ content: `合成认识${n}`, source: 'user_expressed', sourceIds: [source.id], goalId: b, goalReason: '属于开发协作' })) });
  assert.equal(done.status, 'committed');
  assert.deepEqual(done.rejectedItems.map(r => r.code), ['PLACEMENT_LIMIT']);
  assert.equal(done.resultRef.placed[0].understandings.itemIds.length, 2);
  assert.deepEqual(done.resultRef.understandings.itemIds.map(id => f.repo.get('tree_items', id).nodeId), [a]);
});

test('a tree with more than the limit of other goals gets no list, and placements do not apply', async t => {
  const f = learningFixture(t, { outputProtocol: 'experience-v1' });
  const a = f.create('合成选材'); let b;
  for (let i = 0; i <= OTHER_GOALS_LIMIT; i++) b = f.create(`合成目标${i}`);
  const turn = await f.turn(a, '合成反馈'), job = f.learning.enqueue(turn.id, a), source = current(job);
  assert.deepEqual(job.input.otherGoals, []);
  const done = f.complete(job, { ...empty(), understandings: [{ content: '合成认识', source: 'user_expressed', sourceIds: [source.id], goalId: b, goalReason: '属于别处' }] });
  assert.deepEqual(done.rejectedItems.map(r => r.code), ['PLACEMENT_GOAL']);
  assert.equal(f.repo.get('tree_items', done.resultRef.understandings.itemIds[0]).nodeId, a);
});

test('learning input length with fifty other goals', async t => {
  const f = learningFixture(t, { outputProtocol: 'experience-v1' }), a = f.create('合成选材');
  const size = async () => { const turn = await f.turn(a, '合成反馈'); return JSON.stringify(modelView(f.learning.enqueue(turn.id, a).input)).length; };
  const before = await size(); f.complete(f.repo.list('tree_jobs', j => j.role === 'learning').at(-1), empty());
  for (let i = 0; i < 50; i++) f.create(`合成目标${i}，名字长度接近真实目标的写法`);
  const after = await size();
  t.diagnostic(`learning input chars: ${before} without other goals, ${after} with 50 (+${after - before})`);
  assert.ok(after > before);
});
