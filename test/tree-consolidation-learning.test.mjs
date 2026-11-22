import test from 'node:test';
import assert from 'node:assert/strict';
import { learningFixture, emptyLearning } from './fixtures/tree-learning/helpers.mjs';
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
  // 053: leaving a goal may also look back; a threshold summary still may not.
  assert.deepEqual(validateOutput('consolidation', full.consolidation, input), full.consolidation);
  input.summaryPlan = { reason: 'threshold' }; assert.throws(() => validateOutput('consolidation', { ...full.consolidation, broaden: [] }, input), { code: 'OUTPUT_THRESHOLD' });
  input.summaryPlan = { reason: 'node_complete' }; assert.deepEqual(validateOutput('consolidation', full.consolidation, input), full.consolidation);
});

test('only leaving a goal may mark it as possibly put down', () => {
  const input = envelope('consolidation'), source = full.consolidation.summary.decisions[0]?.sourceIds?.[0] ?? input.sources[0].id;
  const marked = { ...full.consolidation, retrospect: { understandings: [], methods: [] }, setDown: { reason: '对话已转去别的目标，也没有约定的下一步', sourceIds: [source] } };
  for (const reason of ['node_leave', 'leave_timeout']) { input.summaryPlan = { reason }; assert.deepEqual(validateOutput('consolidation', marked, input), marked); }
  for (const reason of ['node_complete', 'threshold']) { input.summaryPlan = { reason }; assert.throws(() => validateOutput('consolidation', { ...marked, broaden: [] }, input), { code: 'OUTPUT_SET_DOWN_TRIGGER' }); }
  input.summaryPlan = { reason: 'node_leave' }; const plain = { ...marked, setDown: null }; assert.deepEqual(validateOutput('consolidation', plain, input), plain);
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

// 053: a goal that was left (not completed) keeps what looking back taught it,
// since the conversation may come back to it; one bad lift still costs nothing.
test('leaving a node keeps its retrospect on the node itself, and one bad lift does not cost the summary', async t => {
  const f = learningFixture(t), parent = f.create('我准备申请材料'), a = f.create('我写推荐信', parent);
  await f.turn(a, '请继续写推荐信');
  f.asModel('learning', [a]); const [id] = f.propose(a, { methods: [method([f.ref])] }).methods.itemIds;
  const job = enqueueLikeRuntime(f, f.consolidation.plan(a, 'leave_timeout')), source = userSource(job);
  assert.deepEqual(job.input.outputBindings.retrospectTarget, { nodeId: a, isRoot: false });
  const result = run(f, job, { summary, broaden: [{ kind: 'method', id, version: 1, toNodeId: 'not-an-ancestor', reason: '编造的节点', sourceIds: [source] }],
    retrospect: { understandings: [{ content: '推荐信先列事实再写评价', source: 'assistant_inferred', sourceIds: [source] }], methods: [] } });
  assert.equal(result.status, 'committed');
  assert.deepEqual(result.rejectedItems.map(r => [r.item, r.code]), [['broaden[0]', 'OUTPUT_REFERENCE']]);
  assert.equal(f.repo.get('tree_items', id).nodeId, a);
  assert.deepEqual(f.repo.list('tree_items', i => i.kind === 'understanding').map(i => i.nodeId), [a], 'the new understanding stays on the goal that was left');
  assert.equal(f.repo.get('tree_summaries', f.repo.get('tree_nodes', a).currentSummaryId).oneLine, '合成概况');
});

test('a completed goal still keeps its retrospect one level up', async t => {
  const f = learningFixture(t), parent = f.create('我准备申请材料'), a = f.create('我写推荐信', parent);
  await f.turn(a, '推荐信写好了。');
  f.asUser(); f.tree.setStatus(f.cmd({ nodeId: a, status: 'completed', sourceRefs: [] }, f.expected('tree_nodes', a)));
  const job = enqueueLikeRuntime(f, f.consolidation.plan(a, 'node_complete'));
  assert.deepEqual(job.input.outputBindings.retrospectTarget, { nodeId: parent, isRoot: false });
});

// 053 (F46): a goal the conversation moves away from is consolidated when it is
// left, not only after a day of silence; the same turns are not done twice.
// Each turn's own learning is run to the end, as the runtime does after a turn.
const learnedTurn = async (f, node, text) => { const turn = await f.turn(node, text); f.complete(f.learning.enqueue(turn.id, node), emptyLearning()); return turn; };

test('leaving a goal plans one consolidation for it once its learning has settled', async t => {
  const f = learningFixture(t), a = f.create('我写推荐信'), b = f.create('我改简历'), empty = { understandings: [], methods: [] };
  await learnedTurn(f, a, '先写推荐信'); const last = await f.turn(a, '继续写推荐信');
  assert.deepEqual(f.consolidation.departed(), [], 'still on the same goal');
  await learnedTurn(f, b, '换个事，先改简历');
  assert.deepEqual(f.consolidation.departed(), [], 'the goal that was left waits for its own learning');
  f.complete(f.learning.enqueue(last.id, a), emptyLearning());
  const plans = f.consolidation.departed();
  assert.deepEqual(plans.map(p => [p.nodeId, p.reason]), [[a, 'node_leave']]);
  const job = enqueueLikeRuntime(f, plans[0]);
  assert.equal(run(f, job, { summary, broaden: [], retrospect: empty }).status, 'committed');
  assert.deepEqual(f.consolidation.departed(), [], 'the same turns are not consolidated twice');
  await learnedTurn(f, b, '继续改简历');
  assert.deepEqual(f.consolidation.departed(), []);
  await learnedTurn(f, a, '回到推荐信');
  assert.deepEqual(f.consolidation.departed().map(p => p.nodeId), [b], 'the goal just left is planned; the current one is not');
  await learnedTurn(f, b, '再改简历');
  assert.deepEqual(f.consolidation.departed().map(p => p.nodeId), [a], 'a goal left again after new turns is planned again');
});

test('a goal main renamed hides its old one line until its summary is refreshed', async t => {
  const f = learningFixture(t), a = f.create('打磨第一篇的核心问题'), empty = { understandings: [], methods: [] };
  await learnedTurn(f, a, '先打磨核心问题');
  assert.equal(run(f, enqueueLikeRuntime(f, f.consolidation.plan(a, 'leave_timeout')), { summary, broaden: [], retrospect: empty }).status, 'committed');
  assert.equal(f.builder.glance(f.repo.get('tree_nodes', a)).oneLine, '合成概况');
  await learnedTurn(f, a, '可以从第一篇开始写了');
  f.asModel('main', [a]); f.tree.renameGoal(f.cmd({ nodeId: a, name: 'Murphy 写出第一篇文章，讲清面对的问题', sourceRefs: [] }, f.expected('tree_nodes', a)));
  assert.equal(f.builder.glance(f.repo.get('tree_nodes', a)).oneLine, '', 'the summary written under the old name is not shown');
  const overview = JSON.parse(f.builder.build([a], 'main').segments.find(s => s.key === 'global-overview').text).globalOverview;
  assert.equal(overview.find(n => n.id === a).oneLine, '');
  const plans = f.consolidation.departed();
  assert.deepEqual(plans.map(p => [p.nodeId, p.reason]), [[a, 'node_leave']], 'a rename refreshes the summary even while the conversation stays');
  assert.equal(run(f, enqueueLikeRuntime(f, plans[0]), { summary: { ...summary, oneLine: '新概况' }, broaden: [], retrospect: empty }).status, 'committed');
  assert.equal(f.repo.get('tree_nodes', a).summaryNameStale, false);
  assert.equal(f.builder.glance(f.repo.get('tree_nodes', a)).oneLine, '新概况');
});

test('a goal that was left may be marked as possibly put down; the mark never changes its status and goes away when the goal is resumed', async t => {
  const f = learningFixture(t), a = f.create('把申请路线图拆成每日待办'), b = f.create('盘点申请论述的依据'), empty = { understandings: [], methods: [] };
  await learnedTurn(f, a, '每天按这个节奏推进'); await learnedTurn(f, b, '先盘点依据');
  const job = enqueueLikeRuntime(f, f.consolidation.departed()[0]);
  const setDown = { reason: '对话已转去盘点依据，每日待办没有约定的下一步', sourceIds: [userSource(job)] };
  assert.equal(run(f, job, { summary, broaden: [], retrospect: empty, setDown }).status, 'committed');
  assert.equal(f.repo.get('tree_nodes', a).status, 'active', 'the program does not put the goal down');
  assert.deepEqual(f.builder.glance(f.repo.get('tree_nodes', a)), { oneLine: '合成概况', possiblySetDown: true });
  const overview = JSON.parse(f.builder.build([b], 'main').segments.find(s => s.key === 'global-overview').text).globalOverview;
  assert.equal(overview.find(n => n.id === a).possiblySetDown, true);
  assert.equal(overview.find(n => n.id === b).possiblySetDown, undefined);
  await learnedTurn(f, a, '回到每日待办');
  assert.equal(f.builder.glance(f.repo.get('tree_nodes', a)).possiblySetDown, undefined, 'coming back to the goal clears the mark');
});

// The compact consolidation prompt carries no output schema, so it must state
// the oneLine limit that the schema enforces on the whole summary.
test('the compact consolidation prompt states the 60-character oneLine limit its schema enforces', async () => {
  const { compilePrompt } = await import('../src/tree/prompts.mjs'), prompt = compilePrompt('consolidation');
  assert.equal(prompt.version, 'arcfold.tree.consolidation/5.0.1');
  assert.match(prompt.text, /summary\.oneLine是60字以内的一句话/);
  assert.match(prompt.text, /"oneLine":"一句概况，60字以内"/);
  assert.equal(compilePrompt('improvement').version, 'arcfold.tree.improvement/5.0.0');
  const e = envelope('consolidation'), output = oneLine => ({ ...full.consolidation, broaden: [], retrospect: { understandings: [], methods: [] }, summary: { ...full.consolidation.summary, oneLine } });
  assert.equal(validateOutput('consolidation', output('概'.repeat(60)), e).summary.oneLine.length, 60);
  assert.throws(() => validateOutput('consolidation', output('概'.repeat(61)), e), { code: 'INVALID_OUTPUT' });
});

test('consolidation keeps long tool output by reference and carries only what each covered learning saw and produced', async t => {
  const { LEARNING_TOOL_SOURCE_CHARS, compactLearningSource } = await import('../src/tree/experience.mjs');
  const f = learningFixture(t), node = f.create('合成整理');
  const { job: learned } = await f.feedback(node, 'approved', '合成用户反馈');
  assert.equal(learned.status, 'committed');
  const plan = f.consolidation.plan(node, 'leave_timeout'), size = LEARNING_TOOL_SOURCE_CHARS + 1;
  const tool = (id, text) => ({ id, role: 'tool', origin: 'tool', ref: { sessionId: 'synthetic', seq: 900, sha256: id.padEnd(64, '0') }, sha256: id.padEnd(64, '0'), text, content: [{ type: 'text', text }], nativeType: 'tool/result', toolCallId: 'c-' + id, isError: false });
  const long = tool('aa', 'x'.repeat(size)), short = tool('bb', '测试通过');
  const material = plan.material.map((m, i) => i === 0 ? { ...m, sources: [...m.sources, long, short] } : m);
  const input = f.consolidation.freeze({ ...plan, material }).input, byId = id => input.sources.find(s => s.id === id);
  assert.equal(byId('aa').text, `[工具输出 ${size} 字符；原文按引用保留，未放入本次输入]`);
  assert.deepEqual(byId('aa').content, [{ type: 'text', text: byId('aa').text }]);
  assert.deepEqual(byId('aa').ref, long.ref); assert.deepEqual(byId('aa').elided, { chars: size, sha256: long.sha256 });
  assert.deepEqual(byId('bb'), short);
  const user = input.sources.find(s => s.role === 'user'), original = plan.material.flatMap(m => m.sources).find(s => s.id === user.id);
  assert.deepEqual(user, original);
  // A summary may cite the elided output; its frozen ref stays the original one.
  const output = { summary: { oneLine: '合成概况', status: '合成进展', outputs: ['合成产出'], decisions: [], next: '', pending: [] }, broaden: [], retrospect: { understandings: [], methods: [] }, setDown: { reason: '合成理由', sourceIds: ['aa'] } };
  assert.deepEqual(validateOutput('consolidation', output, input).setDown.sourceIds, ['aa']);
  // Learning wording is unchanged.
  assert.equal(compactLearningSource(long).text, `[工具输出 ${size} 字符；原文按引用保留，未放入学习输入]`);
  // Each covered learning carries only its turn, source ids, output and receipt.
  assert.equal(input.learningHistory.length, 1);
  const [record] = input.learningHistory;
  assert.deepEqual(Object.keys(record).sort(), ['input', 'invalidated', 'jobId', 'output', 'receipt']);
  assert.deepEqual(Object.keys(record.input).sort(), ['currentTurn', 'sourceIds']);
  assert.equal(record.jobId, learned.id); assert.deepEqual(record.input.currentTurn, learned.input.currentTurn);
  assert.deepEqual(record.input.sourceIds, learned.input.sources.map(s => s.id));
  assert.deepEqual(record.output, learned.validatedResult); assert.deepEqual(record.receipt, learned.resultRef);
  const invalid = f.consolidation.freeze({ ...plan, learningRecords: [{ jobId: 'j-old', invalidated: true, reason: '合成作废原因', inputHash: 'h1', resultHash: 'h2' }] }).input.learningHistory;
  assert.deepEqual(invalid, [{ jobId: 'j-old', invalidated: true, reason: '合成作废原因' }]);
});
