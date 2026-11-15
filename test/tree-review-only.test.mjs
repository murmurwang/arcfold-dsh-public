import test from 'node:test';
import assert from 'node:assert/strict';
import { learningFixture, emptyLearning } from './fixtures/tree-learning/helpers.mjs';
import { improvementFixture, personal } from './fixtures/tree-improvement/helpers.mjs';
import { VerificationService } from '../src/tree/verification.mjs';
import { emptyVerification } from './fixtures/tree-learning/helpers.mjs';
import { digest } from '../src/tree/contracts.mjs';

test('ordinary user statements are not saved as new learning, while one quoted correction is', async t => {
  const f = learningFixture(t), node = f.create('合成测试');
  const first = await f.turn(node, '我想先整理材料'), job = f.learning.enqueue(first.id, node);
  const source = job.input.sources.find(s => s.role === 'user' && job.input.currentTurn.sourceIds.includes(s.id));
  const output = { ...emptyLearning(), understandings: [{ content: '先整理材料', source: 'user_expressed', sourceIds: [source.id] }] };
  const firstResult = f.complete(job, output);
  assert.equal(firstResult.status, 'committed');
  assert.deepEqual(firstResult.resultRef.understandings.itemIds, []);

  const second = await f.turn(node, '我不是说马上整理，我是要先确认范围');
  const correction = f.learning.enqueue(second.id, node);
  const correctedSource = correction.input.sources.find(s => s.role === 'user' && correction.input.currentTurn.sourceIds.includes(s.id));
  const corrected = f.complete(correction, { ...emptyLearning(), correctionClaim: { kind: 'understanding', quote: { sourceId: correctedSource.id, text: '我不是说马上整理，我是要先确认范围' } },
    understandings: [{ content: '先确认范围', source: 'user_expressed', sourceIds: [correctedSource.id] }, { content: '多余的第二条', source: 'user_expressed', sourceIds: [correctedSource.id] }] });
  assert.equal(corrected.status, 'committed');
  assert.equal(corrected.resultRef.understandings.itemIds.length, 1);
  assert.equal(f.repo.list('tree_items').length, 1);
});

test('an invalid category does not discard a separate valid category', async t => {
  const f = learningFixture(t), node = f.create('合成分类');
  const turn = await f.turn(node, '这次解释清楚了'), job = f.learning.enqueue(turn.id, node);
  const source = job.input.sources.find(s => s.role === 'user' && job.input.currentTurn.sourceIds.includes(s.id));
  const output = { ...emptyLearning(), categories: [
    { category: 'not_a_category', note: '无效', sourceId: source.id, subjectIds: [] },
    { category: 'approved', note: '明确认可', sourceId: source.id, subjectIds: [] },
  ] };
  const done = f.complete(job, output);
  assert.equal(done.status, 'committed');
  assert.equal(done.rejectedItems.length, 1);
  assert.equal(f.repo.list('tree_signals').length, 1);
  assert.equal(f.repo.list('tree_signals')[0].category, 'approved');
});

test('a correction claim without a supported item is recorded as rejected without losing a valid category', async t => {
  const f = learningFixture(t), node = f.create('合成纠正');
  const turn = await f.turn(node, '我不是这个意思，这次解释清楚了'), job = f.learning.enqueue(turn.id, node);
  const source = job.input.sources.find(s => s.role === 'user' && job.input.currentTurn.sourceIds.includes(s.id));
  const done = f.complete(job, { ...emptyLearning(),
    correctionClaim: { kind: 'understanding', quote: { sourceId: source.id, text: '我不是这个意思' } },
    categories: [{ category: 'approved', note: '明确认可', sourceId: source.id, subjectIds: [] }],
  });
  assert.equal(done.status, 'committed');
  assert.equal(done.rejectedItems.length, 1);
  assert.equal(f.repo.list('tree_items').length, 0);
  assert.equal(f.repo.list('tree_signals')[0].category, 'approved');
});

test('verification records a report without changing existing learning', async t => {
  const f = learningFixture(t), node = f.create('合成检验');
  await f.turn(node, '请检查这个结果');
  const verification = new VerificationService({ repository: f.repo, experience: f.experience, contextBuilder: f.builder, jobs: f.jobs, modelConfig: f.config, clusters: f.clusters });
  const job = verification.enqueue(node, { reason: 'stagnation' });
  const output = emptyVerification();
  const before = f.repo.list('tree_items');
  f.jobs.prepare(job.id); f.jobs.submit(job.id);
  f.jobs.receive(job.id, { message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(output) }] }, nativeLogRef: 'synthetic-review#1', eventsHash: digest(output) });
  assert.equal(f.jobs.validate(job.id).status, 'validated');
  const done = f.jobs.commit(job.id, (result, context) => verification.applyResult(result, context));
  assert.equal(done.status, 'committed');
  assert.equal(done.resultRef.reportOnly, true);
  assert.deepEqual(f.repo.list('tree_items'), before);
  assert.deepEqual(f.repo.get('tree_reports', done.resultRef.reportId).reviewOutput, output);
});

test('one invalid finding does not discard a separate source-bound finding', async t => {
  const f = learningFixture(t), node = f.create('合成检验'); await f.turn(node, '请检查这个结果');
  const verification = new VerificationService({ repository: f.repo, experience: f.experience, contextBuilder: f.builder, jobs: f.jobs, modelConfig: f.config, clusters: f.clusters });
  const job = verification.enqueue(node, { reason: 'stagnation' }), source = job.input.sources.find(s => s.role === 'user');
  const output = { ...emptyVerification(), missed: [{ what: '无效引用', evidence: ['invented'] }, { what: '需要复核', evidence: [source.id] }] };
  f.jobs.prepare(job.id); f.jobs.submit(job.id);
  f.jobs.receive(job.id, { message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(output) }] }, nativeLogRef: 'synthetic-review#2', eventsHash: digest(output) });
  assert.equal(f.jobs.validate(job.id).status, 'validated');
  const done = f.jobs.commit(job.id, (result, context) => verification.applyResult(result, context));
  assert.equal(done.status, 'committed'); assert.equal(done.rejectedItems.length, 1);
  const findings = f.repo.get('tree_reports', done.resultRef.reportId).reviewOutput.missed;
  assert.deepEqual(findings, [{ what: '需要复核', evidence: [source.id] }]);
});

test('personal improvement is a local report and does not change items or parameters', t => {
  const f = improvementFixture(t), node = f.create('合成测试');
  f.repair(node); f.repair(node);
  const job = f.improvement.enqueue('learning');
  const done = f.completeImprovement(job, personal(job));
  assert.equal(done.status, 'committed');
  assert.equal(done.resultRef.reportOnly, true);
  assert.deepEqual(done.resultRef.supplements, []);
  assert.deepEqual(done.resultRef.parameters, []);
  assert.equal(f.repo.list('tree_items').length, 0);
  assert.equal(f.repo.list('tree_parameters').length, 0);
  const report = f.repo.get('tree_reports', done.resultRef.reportId);
  assert.equal(report.reviewJobId, job.id);
  assert.ok(report.reviewOutput.supplements.length);
});
