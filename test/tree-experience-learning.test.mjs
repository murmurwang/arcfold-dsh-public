import test from 'node:test';
import assert from 'node:assert/strict';
import { learningFixture } from './fixtures/tree-learning/helpers.mjs';
import { integratedFixture } from './fixtures/tree-integration/native.mjs';
import { compilePrompt, OUTPUT_SCHEMAS } from '../src/tree/prompts.mjs';
import { digest } from '../src/tree/contracts.mjs';

const empty = () => ({ categories: [], understandings: [], changes: [], method: null });
const current = (job, role = 'user') => job.input.sources.find(s => s.role === role && job.input.currentTurn.sourceIds.includes(s.id));
const version = (f, id) => { const item = f.repo.get('tree_items', id); return f.repo.get('tree_item_versions', digest(['item_version', id, item.activeVersion])); };
const nodeContext = (f, node) => JSON.parse(f.builder.build([node], 'main').segments.find(s => s.key === `node:${node}`).text);

test('experience-v1 is the default learning contract with four wire fields and current-turn bindings', async t => {
  const f = learningFixture(t, { outputProtocol: undefined }), node = f.create('合成目标');
  const turn = await f.turn(node, '我更看重准确，慢一点没关系。'), job = f.learning.enqueue(turn.id, node), source = current(job);
  assert.equal(job.input.outputProtocol, 'experience-v1');
  assert.equal(job.input.observationContext, undefined);
  assert.deepEqual(Object.keys(OUTPUT_SCHEMAS.learning.properties), ['categories', 'understandings', 'changes', 'method']);
  const prompt = compilePrompt('learning');
  assert.equal(prompt.version, 'arcfold.tree.learning/6.0.0'); assert.ok(prompt.text.length < 3000); assert.equal(job.prompt.hash, prompt.hash);
  assert.deepEqual(job.input.outputBindings.limits, { understandings: 3, changes: 2, method: 1 });
  assert.ok(job.input.outputBindings.currentUserSourceIds.includes(source.id));
});

test('an ordinary statement becomes a user-expressed understanding that the next main context carries', async t => {
  const f = learningFixture(t, { outputProtocol: 'experience-v1' }), node = f.create('合成目标');
  const turn = await f.turn(node, '我更看重准确，慢一点没关系。'), job = f.learning.enqueue(turn.id, node), source = current(job);
  const done = f.complete(job, { ...empty(), understandings: [{ content: '用户把准确看得比速度重要', source: 'user_expressed', sourceIds: [source.id] }] });
  assert.equal(done.status, 'committed'); assert.deepEqual(done.rejectedItems, []);
  const [id] = done.resultRef.understandings.itemIds, item = f.repo.get('tree_items', id);
  assert.equal(version(f, id).sourceKind, 'user_expressed'); assert.equal(item.sourceTurnId, turn.id); assert.equal(item.producerRole, 'learning'); assert.equal(item.nodeId, node);
  assert.deepEqual(nodeContext(f, node).understandings.map(u => [u.content, u.source]), [['用户把准确看得比速度重要', 'user_expressed']]);
});

test('an inference keeps its label and an open question stays unknown', async t => {
  const f = learningFixture(t, { outputProtocol: 'experience-v1' }), node = f.create('合成目标');
  const turn = await f.turn(node, '这份材料下周要给评审看。'), job = f.learning.enqueue(turn.id, node), source = current(job);
  const done = f.complete(job, { ...empty(), understandings: [
    { content: '用户可能需要能直接拿给评审的成稿', source: 'assistant_inferred', sourceIds: [source.id] },
    { content: '评审更看重结论还是过程，尚不清楚', source: 'unknown', sourceIds: [source.id] }] });
  assert.equal(done.status, 'committed'); assert.equal(done.resultRef.understandings.itemIds.length, 2);
  assert.deepEqual(nodeContext(f, node).understandings.map(u => u.source).sort(), ['assistant_inferred', 'unknown']);
});

test('an old correction field from an earlier session is dropped without losing the rest', async t => {
  const f = learningFixture(t, { outputProtocol: 'experience-v1' }), node = f.create('合成目标');
  const turn = await f.turn(node, '我更看重准确。'), job = f.learning.enqueue(turn.id, node), source = current(job);
  const done = f.complete(job, { ...empty(), correction: null, understandings: [{ content: '用户更看重准确', source: 'user_expressed', sourceIds: [source.id] }] });
  assert.equal(done.status, 'committed'); assert.deepEqual(done.rejectedItems.map(r => [r.item, r.code]), [['correction', 'UNKNOWN_FIELD']]);
  assert.equal(done.resultRef.understandings.itemIds.length, 1);
});

test('the release rehearsal’s empty legacy-shaped answer still commits without an error', async t => {
  const f = learningFixture(t, { outputProtocol: 'experience-v1' }), node = f.create('合成目标');
  const turn = await f.turn(node, '请继续。'), job = f.learning.enqueue(turn.id, node);
  const done = f.complete(job, { understandings: [], revisions: [], methods: [], supplements: [], categories: [] });
  assert.equal(done.status, 'committed'); assert.equal(done.error ?? null, null);
  assert.deepEqual(done.rejectedItems.map(r => [r.item, r.code]), [['revisions', 'UNKNOWN_FIELD'], ['methods', 'UNKNOWN_FIELD'], ['supplements', 'UNKNOWN_FIELD']]);
  assert.equal(f.repo.list('tree_items').length, 0);
});

test('limits, duplicates and previous-turn-only sources reject only the offending items', async t => {
  const f = learningFixture(t, { outputProtocol: 'experience-v1' }), node = f.create('合成目标');
  const first = await f.turn(node, '我更看重准确。'), firstJob = f.learning.enqueue(first.id, node);
  f.complete(firstJob, { ...empty(), understandings: [{ content: '用户更看重准确', source: 'user_expressed', sourceIds: [current(firstJob).id] }] });
  const second = await f.turn(node, '另外我习惯晚上处理这类事，周末不看消息，团队只有我一个人。'), job = f.learning.enqueue(second.id, node), source = current(job);
  const previous = job.input.sources.find(s => s.role === 'user' && !job.input.currentTurn.sourceIds.includes(s.id));
  assert.ok(previous);
  const done = f.complete(job, { ...empty(), understandings: [
    { content: ' 用户更看重准确 ', source: 'user_expressed', sourceIds: [source.id] },
    { content: '用户习惯晚上处理这类事', source: 'user_expressed', sourceIds: [source.id] },
    { content: '只引用上一轮的内容', source: 'user_expressed', sourceIds: [previous.id] },
    { content: '用户周末不看消息', source: 'user_expressed', sourceIds: [source.id] },
    { content: '团队只有用户一个人', source: 'user_expressed', sourceIds: [source.id] },
    { content: '超出本轮上限的一条', source: 'user_expressed', sourceIds: [source.id] }] });
  assert.equal(done.status, 'committed');
  assert.deepEqual(done.rejectedItems.map(r => [r.item, r.code]), [['understandings[0]', 'LEARNING_DUPLICATE'], ['understandings[2]', 'OUTPUT_CURRENT_SOURCE'], ['understandings[5]', 'LEARNING_LIMIT']]);
  assert.equal(done.resultRef.understandings.itemIds.length, 3);
  assert.equal(f.repo.list('tree_items', i => i.kind === 'understanding' && i.lifecycle === 'active').length, 4);
});

test('a stated way of working becomes a short rule in the next context; an assistant-only method is refused', async t => {
  const f = learningFixture(t, { outputProtocol: 'experience-v1' }), node = f.create('合成目标');
  const turn = await f.turn(node, '以后给我汇报时先说结论，再展开。'), job = f.learning.enqueue(turn.id, node), source = current(job);
  const method = { kind: 'collaboration', situation: '向用户汇报结果时', action: '先给结论，再展开细节', basis: '用户本轮明确要求', notApplicable: '用户要求先看过程时',
    expectedEffect: { category: 'restart', change: 'less', text: '减少要求重新梳理' }, sourceIds: [source.id] };
  const done = f.complete(job, { ...empty(), method });
  assert.equal(done.status, 'committed'); assert.equal(done.resultRef.methods.itemIds.length, 1); assert.deepEqual(done.resultRef.writerJobs, []);
  const id = done.resultRef.methods.itemIds[0];
  assert.equal(f.repo.get('tree_items', id).lifecycle, 'active');
  const context = nodeContext(f, node);
  assert.deepEqual(context.rules.map(r => r.text.action), ['先给结论，再展开细节']); assert.deepEqual(context.methods, []);

  const next = await f.turn(node, '好的，继续。'), nextJob = f.learning.enqueue(next.id, node), answer = current(nextJob, 'assistant');
  assert.ok(answer);
  const refused = f.complete(nextJob, { ...empty(), method: { ...method, action: '助手自己决定的新做法', sourceIds: [answer.id] } });
  assert.equal(refused.status, 'committed'); assert.deepEqual(refused.rejectedItems.map(r => [r.item, r.code]), [['method', 'OUTPUT_METHOD_SOURCE']]);
  assert.equal(f.repo.list('tree_items', i => i.kind === 'method').length, 1);
});

test('a quoted change replaces an understanding, while user-protected content is left alone', async t => {
  const f = learningFixture(t, { outputProtocol: 'experience-v1' }), node = f.create('合成目标');
  const first = await f.turn(node, '我想要详细的表格。'), firstJob = f.learning.enqueue(first.id, node), firstSource = current(firstJob);
  const saved = f.complete(firstJob, { ...empty(), understandings: [
    { content: '用户想要详细的表格', source: 'user_expressed', sourceIds: [firstSource.id] },
    { content: '用户可能要把表格转给同事', source: 'assistant_inferred', sourceIds: [firstSource.id] }] });
  const [table, guess] = saved.resultRef.understandings.itemIds;
  f.asUser(); f.items.confirm(f.cmd({ itemId: guess, version: 1 }, f.expected('tree_items', guess)));
  assert.equal(f.repo.get('tree_items', guess).userProtected, true);

  const text = '我改主意了，现在只要一句话结论。';
  const second = await f.turn(node, text), job = f.learning.enqueue(second.id, node), source = current(job);
  assert.deepEqual(job.input.outputBindings.revisableUnderstandings.map(i => i.id), [table]);
  const done = f.complete(job, { ...empty(), changes: [
    { targetId: table, targetVersion: 1, mark: 'changed', scope: 'local', content: '用户现在只要一句话结论', quote: { sourceId: source.id, text } },
    { targetId: guess, targetVersion: 2, mark: 'invalid', scope: 'local', content: '用户不转给同事', quote: { sourceId: source.id, text } }] });
  assert.equal(done.status, 'committed');
  assert.deepEqual(done.rejectedItems.map(r => [r.item, r.code]), [['changes[1]', 'OUTPUT_PROTECTED']]);
  const old = f.repo.get('tree_items', table), [replacement] = done.resultRef.understandings.itemIds;
  assert.equal(old.lifecycle, 'changed'); assert.equal(old.replacedBy, replacement);
  assert.equal(f.repo.get('tree_items', guess).lifecycle, 'active');
  assert.deepEqual(nodeContext(f, node).understandings.map(u => u.content).sort(), ['用户可能要把表格转给同事', '用户现在只要一句话结论'].sort());
});

test('native conversation learns an ordinary statement and the next main request carries it', async t => {
  let learned = 0;
  const f = await integratedFixture(t, ({ role, input }) => {
    if (role === 'attribution') return { actions: [{ action: 'continue', nodeId: input.scope.nodeIds[0] }], statusChanges: [] };
    if (role === 'learning') {
      assert.equal(input.outputProtocol, 'experience-v1');
      const source = input.sources.find(s => s.role === 'user' && input.currentTurn.sourceIds.includes(s.id));
      if (learned++) return { categories: [], understandings: [], changes: [], method: null };
      return { categories: [], understandings: [{ content: '用户把准确看得比速度重要', source: 'user_expressed', sourceIds: [source.id] }], changes: [], method: null };
    }
    return '合成答复。';
  }, { learningProtocol: 'experience-v1' });
  const agent = await f.main('experience-learning-native');
  await f.turn(agent, '我更看重准确，慢一点没关系。');
  const [item] = f.repo.list('tree_items', i => i.kind === 'understanding');
  assert.ok(item);
  await f.turn(agent, '继续下一步。');
  assert.ok(f.repo.list('tree_exposures', e => e.role === 'main').some(e => e.visibleItemVersions.some(v => v.itemId === item.id && v.version === item.activeVersion)));
});
