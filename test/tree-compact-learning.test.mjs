import test from 'node:test';
import assert from 'node:assert/strict';
import { learningFixture } from './fixtures/tree-learning/helpers.mjs';
import { integratedFixture } from './fixtures/tree-integration/native.mjs';

test('compact learning records at most one explicit correction and independent categories', async t => {
  const f = learningFixture(t, { outputProtocol: 'correction-v1' });
  const node = f.create('合成目标');
  const turn = await f.turn(node, '你理解错了，我的意思是先确认范围。');
  const job = f.learning.enqueue(turn.id, node);
  const source = job.input.sources.find(s => s.role === 'user' && job.input.currentTurn.sourceIds.includes(s.id));
  assert.equal(job.input.outputProtocol, 'correction-v1');
  assert.equal(job.input.observationContext, undefined);
  const result = f.complete(job, {
    categories: [{ category: 'unknown', note: '无效类别', sourceId: source.id, subjectIds: [] },
      { category: 'misread', note: '指出理解错误', sourceId: source.id, subjectIds: [] }],
    correction: { kind: 'understanding', content: '先确认范围', quote: { sourceId: source.id, text: '你理解错了，我的意思是先确认范围。' }, target: null, expectedEffect: null },
  });
  assert.equal(result.status, 'committed');
  assert.equal(result.rejectedItems.length, 1);
  assert.equal(result.resultRef.understandings.itemIds.length, 1);
  assert.equal(f.repo.list('tree_signals').length, 1);
});

test('a bad correction does not discard a valid category', async t => {
  const f = learningFixture(t, { outputProtocol: 'correction-v1' });
  const node = f.create('合成目标');
  const turn = await f.turn(node, '这一版可以。');
  const job = f.learning.enqueue(turn.id, node);
  const source = job.input.sources.find(s => s.role === 'user' && job.input.currentTurn.sourceIds.includes(s.id));
  const result = f.complete(job, {
    categories: [{ category: 'approved', note: '用户认可', sourceId: source.id, subjectIds: [] }],
    correction: { kind: 'understanding', content: '编造', quote: { sourceId: source.id, text: '不存在的原话' }, target: null, expectedEffect: null },
  });
  assert.equal(result.status, 'committed');
  assert.equal(result.rejectedItems.length, 1);
  assert.equal(f.repo.list('tree_items').length, 0);
  assert.equal(f.repo.list('tree_signals').length, 1);
});

test('a compact method correction preserves its stated scope and creates no executable component', async t => {
  const f = learningFixture(t, { outputProtocol: 'correction-v1' });
  const node = f.create('合成目标');
  const turn = await f.turn(node, '你这次漏做了，以后这项目先核对来源。');
  const job = f.learning.enqueue(turn.id, node);
  const source = job.input.sources.find(s => s.role === 'user' && job.input.currentTurn.sourceIds.includes(s.id));
  const result = f.complete(job, { categories: [], correction: {
    kind: 'method', content: '这个项目先核对来源', quote: { sourceId: source.id, text: source.text }, target: null,
    expectedEffect: { category: 'omitted', change: 'less', text: '减少漏核来源' },
  } });
  assert.equal(result.status, 'committed');
  assert.equal(result.resultRef.methods.itemIds.length, 1);
  assert.deepEqual(result.resultRef.writerJobs, []);
});

test('native conversation sends the compact contract and commits the returned correction', async t => {
  let seen = false;
  const f = await integratedFixture(t, ({ role, input }) => {
    if (role === 'attribution') return { actions: [{ action: 'continue', nodeId: input.scope.nodeIds[0] }], statusChanges: [] };
    if (role === 'learning') {
      seen = true;
      assert.equal(input.outputProtocol, 'correction-v1');
      const source = input.sources.find(s => s.role === 'user' && input.currentTurn.sourceIds.includes(s.id));
      return { categories: [], correction: { kind: 'understanding', content: '先确认范围', quote: { sourceId: source.id, text: source.text }, target: null, expectedEffect: null } };
    }
    return '合成答复。';
  }, { learningProtocol: 'correction-v1' });
  const agent = await f.main('compact-learning-native');
  await f.turn(agent, '你理解错了，我的意思是先确认范围。');
  assert.equal(seen, true);
  assert.equal(f.repo.list('tree_items', item => item.kind === 'understanding').length, 1);
});
