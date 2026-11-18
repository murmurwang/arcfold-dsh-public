import test from 'node:test';
import assert from 'node:assert/strict';
import { learningFixture } from './fixtures/tree-learning/helpers.mjs';
import { method } from './fixtures/tree-domain/helpers.mjs';
import { ConsolidationReflection } from '../src/tree/verification.mjs';
import { validateOutput } from '../src/tree/prompts.mjs';
import { envelope, full } from './fixtures/tree-model/contracts.mjs';
import { digest } from '../src/tree/contracts.mjs';

// Consolidation jobs are enqueued exactly as TreeRuntime.enqueueSummary does:
// the job trigger carries the reason as kind, without a reason field.
function enqueueLikeRuntime(f, plan) {
  const frozen = f.consolidation.freeze(plan), key = digest([plan.nodeId, plan.sourceWatermark, plan.reason]);
  return f.jobs.enqueue({ role: 'consolidation', key, nodeIds: [plan.nodeId], input: frozen.input, revisionSet: frozen.revisions, config: f.config(),
    trigger: { kind: plan.reason === 'node_leave' ? 'leave_timeout' : plan.reason, modelSourceTurnId: plan.throughTurnIds.at(-1) } });
}
function run(f, job, output) {
  const reflection = new ConsolidationReflection({ repository: f.repo, consolidation: f.consolidation, resolveSource: f.resolveSource });
  f.jobs.prepare(job.id); f.jobs.submit(job.id);
  f.jobs.receive(job.id, { message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(output) }] }, nativeLogRef: 'synthetic-consolidation#1', eventsHash: digest(output) });
  const validated = f.jobs.validate(job.id); if (validated.status !== 'validated') return validated;
  return f.jobs.commit(job.id, (result, context) => reflection.applyResult(result, context));
}
const summary = { oneLine: '合成概况', status: '合成进展', outputs: [], decisions: [], next: '', pending: [] };
const userSource = job => job.input.sources.find(s => s.role === 'user').id;
const nodeContext = (f, node) => JSON.parse(f.builder.build([node], 'main').segments.find(s => s.key === `node:${node}`).text);

test('completion retrospect from a runtime-shaped job is kept on the parent, where sibling work reads it', async t => {
  const f = learningFixture(t), parent = f.create('我准备申请材料'), done = f.create('我写好推荐信', parent), sibling = f.create('我写个人陈述', parent);
  await f.turn(done, '推荐信写好了，按我说的先列事实再写评价，这样很好。');
  f.asUser(); f.tree.setStatus(f.cmd({ nodeId: done, status: 'completed', sourceRefs: [] }, f.expected('tree_nodes', done)));
  const job = enqueueLikeRuntime(f, f.consolidation.plan(done, 'node_complete'));
  assert.equal(job.trigger.reason, undefined); assert.equal(job.input.summaryPlan.reason, 'node_complete');
  assert.deepEqual(job.input.outputBindings.retrospectTarget, { nodeId: parent, isRoot: false }); assert.equal(job.input.outputBindings.reason, 'node_complete');
  const lesson = { content: '用户认可先列事实再写评价的写法', source: 'user_expressed', sourceIds: [userSource(job)] };
  const result = run(f, job, { summary, broaden: [], retrospect: { understandings: [lesson], methods: [] } });
  assert.equal(result.status, 'committed'); assert.deepEqual(result.rejectedItems, []);
  const [id] = result.resultRef.retrospect.understandings.itemIds, item = f.repo.get('tree_items', id);
  assert.equal(item.nodeId, parent); assert.equal(item.producerRole, 'consolidation');
  assert.ok(nodeContext(f, parent).understandings.some(u => u.id === id));
  assert.ok(f.builder.build([sibling], 'main').segments.some(s => s.key === `node:${parent}` && s.text.includes('先列事实再写评价')));
});

test('the consolidation reason is read from the frozen plan when the job trigger only has kind', () => {
  const input = envelope('consolidation'); delete input.trigger.reason;
  const lifted = { ...full.consolidation, retrospect: { understandings: [], methods: [] } };
  input.trigger.kind = 'threshold'; assert.throws(() => validateOutput('consolidation', lifted, input), { code: 'OUTPUT_THRESHOLD' });
  input.trigger.kind = 'leave_timeout'; assert.deepEqual(validateOutput('consolidation', lifted, input), lifted);
  assert.throws(() => validateOutput('consolidation', full.consolidation, input), { code: 'OUTPUT_REFLECTION_TRIGGER' });
  input.summaryPlan = { reason: 'node_complete' }; assert.deepEqual(validateOutput('consolidation', full.consolidation, input), full.consolidation);
});

test('leaving a node lifts an own item to an ancestor without copying it', async t => {
  const f = learningFixture(t), parent = f.create('我准备申请材料'), a = f.create('我写推荐信', parent);
  await f.turn(a, '请继续写推荐信');
  f.asModel('learning', [a]); const [id] = f.propose(a, { methods: [method([f.ref])] }).methods.itemIds;
  const lift = job => ({ summary, broaden: [{ kind: 'method', id, version: 1, toNodeId: parent, reason: '别的申请材料也要这样写', sourceIds: [userSource(job)] }], retrospect: { understandings: [], methods: [] } });
  const leave = enqueueLikeRuntime(f, f.consolidation.plan(a, 'leave_timeout'));
  const moved = run(f, leave, lift(leave));
  assert.equal(moved.status, 'committed'); assert.deepEqual(moved.resultRef.moved, [id]);
  const item = f.repo.get('tree_items', id);
  assert.equal(item.nodeId, parent); assert.equal(item.originNodeId, a); assert.deepEqual(item.originChain, [a, parent]); assert.equal(item.validation, 'unverified');
  assert.equal(f.repo.list('tree_items').length, 1);
});

test('a completed top-level goal is told that its retrospect goes to the shared root', async t => {
  const f = learningFixture(t), goal = f.create('我写好推荐信');
  await f.turn(goal, '推荐信写好了。');
  f.asUser(); f.tree.setStatus(f.cmd({ nodeId: goal, status: 'completed', sourceRefs: [] }, f.expected('tree_nodes', goal)));
  const job = enqueueLikeRuntime(f, f.consolidation.plan(goal, 'node_complete'));
  assert.deepEqual(job.input.outputBindings.retrospectTarget, { nodeId: f.repo.rootId(), isRoot: true });
  assert.deepEqual(job.input.outputBindings.broadenTargets, [f.repo.rootId()]);
});

test('leaving a node cannot add retrospect items, and one bad lift does not cost the summary', async t => {
  const f = learningFixture(t), parent = f.create('我准备申请材料'), a = f.create('我写推荐信', parent);
  await f.turn(a, '请继续写推荐信');
  f.asModel('learning', [a]); const [id] = f.propose(a, { methods: [method([f.ref])] }).methods.itemIds;
  const job = enqueueLikeRuntime(f, f.consolidation.plan(a, 'leave_timeout')), source = userSource(job);
  const result = run(f, job, { summary, broaden: [{ kind: 'method', id, version: 1, toNodeId: 'not-an-ancestor', reason: '编造的节点', sourceIds: [source] }],
    retrospect: { understandings: [{ content: '离开时不该新增的理解', source: 'assistant_inferred', sourceIds: [source] }], methods: [] } });
  assert.equal(result.status, 'committed');
  assert.deepEqual(result.rejectedItems.map(r => [r.item, r.code]), [['broaden[0]', 'OUTPUT_REFERENCE'], ['retrospect.understandings[0]', 'OUTPUT_REFLECTION_TRIGGER']]);
  assert.equal(f.repo.get('tree_items', id).nodeId, a); assert.equal(f.repo.list('tree_items', i => i.kind === 'understanding').length, 0);
  assert.equal(f.repo.get('tree_summaries', f.repo.get('tree_nodes', a).currentSummaryId).oneLine, '合成概况');
});
