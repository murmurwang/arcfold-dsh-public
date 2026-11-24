import test from 'node:test';
import assert from 'node:assert/strict';
import { learningFixture } from './fixtures/tree-learning/helpers.mjs';
import { compilePrompt } from '../src/tree/prompts.mjs';
import { digest } from '../src/tree/contracts.mjs';

const empty = () => ({ categories: [], understandings: [], changes: [], method: null });
const long = { name: '五步追踪表', description: '复盘一个案例成败、或写成功案例时用', whenToUse: '复盘案例', steps: '此前对齐了什么 → 系统留下了什么 → 当时实际拿到了什么 → 有没有影响选择 → 后来发生了什么', pitfalls: '不补写未发生的效果', verify: '各步回查原件' };
const short = { situation: '复盘案例', action: '用五步追踪表', basis: '用户要求沿用', notApplicable: '' };
const current = job => job.input.sources.find(s => s.role === 'user' && job.input.currentTurn.sourceIds.includes(s.id));
async function setup(t) {
  const f = learningFixture(t, { outputProtocol: 'experience-v1' }), node = f.create('复盘案例');
  const input = f.begin('native-main', 1, '请给出追踪模板'); f.owner.targetNodeId = node;
  const first = await f.attributed(input); f.finish(input, { answer: long.steps }); f.settle(first.id);
  f.complete(f.learning.enqueue(first.id, node), empty());
  const second = f.begin('native-main', 2, '这个模板以后都可以按这个来');
  const turn = await f.attributed(second); f.finish(second); f.settle(turn.id);
  const job = f.learning.enqueue(turn.id, node);
  const procedure = job.input.sources.find(s => s.role === 'assistant' && !job.input.currentTurn.sourceIds.includes(s.id) && s.text.includes(long.steps));
  assert.ok(procedure);
  const method = { kind: 'technique', short: null, long, expectedEffect: { category: 'omitted', change: 'less', text: '复盘少漏环节' }, sourceIds: [current(job).id, procedure.id] };
  return { f, node, job, method };
}
for (const both of [false, true]) test(`learned long method persists with ${both ? 'both texts' : 'no short text'} and enters the directory`, async t => {
  const { f, node, job, method } = await setup(t);
  const done = f.complete(job, { ...empty(), method: { ...method, short: both ? short : null } });
  assert.equal(done.status, 'committed'); assert.deepEqual(done.rejectedItems, []);
  const [id] = done.resultRef.methods.itemIds, bundle = f.repo.get('tree_methods', digest(['method', id, 1]));
  assert.deepEqual(bundle.long, long); assert.deepEqual(bundle.short, both ? short : null);
  const content = f.repo.get('tree_item_versions', digest(['item_version', id, 1]));
  assert.equal(content.sourceRefs.length, 2);
  const context = JSON.parse(f.builder.build([node], 'main').segments.find(s => s.key === `node:${node}`).text);
  assert.equal(context.methods[0].name, long.name); assert.equal(context.methods[0].description, long.description);
  assert.equal(JSON.stringify(context.methods).includes(long.steps), false);
});
for (const problem of ['empty', 'too-long', 'no-user']) test(`invalid long method (${problem}) preserves independent understandings`, async t => {
  const { f, job, method } = await setup(t), source = current(job);
  if (problem === 'empty') method.long = null;
  if (problem === 'too-long') method.long = { ...long, steps: '字'.repeat(2001) };
  if (problem === 'no-user') method.sourceIds = method.sourceIds.slice(1);
  const done = f.complete(job, { ...empty(), understandings: [{ content: '复盘需有原件依据', source: 'user_expressed', sourceIds: [source.id] }], method });
  assert.equal(done.status, 'committed'); assert.equal(done.resultRef.understandings.itemIds.length, 1);
  assert.equal(done.rejectedItems[0].item, 'method'); assert.equal(f.repo.list('tree_methods').length, 0);
  assert.equal(done.rejectedItems[0].code, problem === 'empty' ? 'OUTPUT_METHOD_TEXT' : problem === 'no-user' ? 'OUTPUT_METHOD_SOURCE' : 'INVALID_OUTPUT');
});
test('learning guidance preserves source and one-off boundaries and explains long fields', () => {
  const text = compilePrompt('learning').text;
  for (const part of ['不补步骤、不改顺序', '上一轮助手给出五步追踪表', '仅要求这一次', '回查不到就不写', '四项合计 2000 字内', '至少一个非 null']) assert.ok(text.includes(part));
});

test('native learning retains the previous procedure and main reads the exact full method', async t => {
  const { integratedFixture } = await import('./fixtures/tree-integration/native.mjs');
  let mainStep = 0, learned = 0, methodId;
  const f = await integratedFixture(t, ({ role, input }) => {
    if (role === 'attribution') return { actions: [{ action: 'continue', nodeId: input.scope.nodeIds[0] }], statusChanges: [] };
    if (role === 'learning') {
      if (++learned !== 2) return empty();
      const user = input.sources.find(s => s.role === 'user' && input.currentTurn.sourceIds.includes(s.id));
      const previous = input.sources.find(s => s.role === 'assistant' && s.text.includes(long.steps));
      assert.ok(previous);
      return { ...empty(), method: { kind: 'technique', short: null, long, expectedEffect: { category: 'omitted', change: 'less', text: '少漏步骤' }, sourceIds: [user.id, previous.id] } };
    }
    if (role === 'main') {
      mainStep++;
      if (mainStep === 1) return long.steps;
      if (mainStep === 3) return { tool: { id: 'read-long', name: 'arcfold_read_method', args: { methodId, expectedVersion: 1 } } };
    }
    return '合成回复';
  }, { learningProtocol: 'experience-v1' });
  const agent = await f.main('long-method-native');
  await f.turn(agent, '给我追踪模板'); await f.turn(agent, '以后都可以按这个来');
  methodId = f.repo.list('tree_items', i => i.kind === 'method')[0]?.id; assert.ok(methodId);
  await f.turn(agent, '按模板复盘');
  const events = agent.session.snapshotEvents();
  const result = events.find(e => e.type === 'tool/result' && e.data.callId === 'read-long');
  const texts = JSON.stringify(result ?? events.filter(e => e.type === 'tool/result'));
  assert.ok(texts.includes(long.steps), texts);
  assert.ok(f.repo.list('tree_exposures', e => e.methodReadVersions?.some(v => v.itemId === methodId)).length);
});
