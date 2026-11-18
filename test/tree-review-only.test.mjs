import test from 'node:test';
import assert from 'node:assert/strict';
import { learningFixture, emptyLearning } from './fixtures/tree-learning/helpers.mjs';
import { VerificationService, ConsolidationReflection } from '../src/tree/verification.mjs';
import { improvementFixture, personal } from './fixtures/tree-improvement/helpers.mjs';
import { method } from './fixtures/tree-domain/helpers.mjs';
import { emptyVerification } from './fixtures/tree-learning/helpers.mjs';
import { digest } from '../src/tree/contracts.mjs';

test('the legacy protocol still saves only one quoted correction from ordinary statements', async t => {
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

test('an empty verification result changes nothing and writes no report', async t => {
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
  assert.equal(done.resultRef.reportOnly, undefined);
  assert.deepEqual(f.repo.list('tree_items'), before);
  assert.deepEqual(f.repo.list('tree_reports'), []);
});

test('one invalid finding does not discard a separate source-bound finding', async t => {
  // A valid missed finding becomes a learning repair; the invalid one is listed as rejected.
  const f = learningFixture(t), node = f.create('合成检验'); await f.turn(node, '请检查这个结果');
  const verification = new VerificationService({ repository: f.repo, experience: f.experience, contextBuilder: f.builder, jobs: f.jobs, modelConfig: f.config, clusters: f.clusters });
  const job = verification.enqueue(node, { reason: 'stagnation' }), source = job.input.sources.find(s => s.role === 'user');
  const output = { ...emptyVerification(), missed: [{ what: '无效引用', evidence: ['invented'] }, { what: '需要复核', evidence: [source.id] }] };
  f.jobs.prepare(job.id); f.jobs.submit(job.id);
  f.jobs.receive(job.id, { message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(output) }] }, nativeLogRef: 'synthetic-review#2', eventsHash: digest(output) });
  assert.equal(f.jobs.validate(job.id).status, 'validated');
  const done = f.jobs.commit(job.id, (result, context) => verification.applyResult(result, context));
  assert.equal(done.status, 'committed'); assert.equal(done.rejectedItems.length, 1);
  assert.deepEqual(done.resultRef.missed, [{ what: '需要复核', evidence: [source.id] }]);
  assert.equal(f.repo.list('tree_repairs', r => r.type === 'missed').length, 1);
});

// Jobs queued before the upgrade carry the report-only prompt they were frozen with.
function frozenAsBefore(f, job, version) {
  const text = version + '\n升级前冻结的提示词', current = f.jobs.get(job.id);
  f.repo.command('fixtureFreezeOldPrompt', f.cmd({ jobId: job.id, version }), { kind: 'program', id: 'fixture' }, () => {
    f.repo.save('tree_jobs', { ...current, prompt: { ...current.prompt, version, text, hash: digest(text) }, promptHash: digest(text) }, current.revision); return {};
  });
  return f.jobs.get(job.id);
}
function finish(f, job, output, apply) {
  f.jobs.prepare(job.id); f.jobs.submit(job.id);
  f.jobs.receive(job.id, { message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(output) }] }, nativeLogRef: 'synthetic-transition#1', eventsHash: digest(output) });
  assert.equal(f.jobs.validate(job.id).status, 'validated');
  return f.jobs.commit(job.id, apply);
}

test('a verification job frozen before the upgrade still only reports', async t => {
  const f = learningFixture(t), node = f.create('合成检验'); f.asModel('learning', [node]);
  const [id] = f.propose(node, { methods: [method([f.ref])] }).methods.itemIds; await f.turn(node, '请检查这个结果');
  const verification = new VerificationService({ repository: f.repo, experience: f.experience, contextBuilder: f.builder, jobs: f.jobs, modelConfig: f.config, clusters: f.clusters });
  const job = frozenAsBefore(f, verification.enqueue(node, { reason: 'stagnation' }), 'arcfold.tree.verification/4.0.0'), source = job.input.sources.find(s => s.role === 'user');
  const output = { ...emptyVerification(), operations: [{ op: 'withdraw', targetId: id, targetVersion: 1, stage: 'use', reason: '合成理由', evidence: [source.id], detail: {} }] };
  const done = finish(f, job, output, (result, context) => verification.applyResult(result, context));
  assert.equal(done.status, 'committed'); assert.equal(done.resultRef.reportOnly, true);
  assert.equal(f.repo.get('tree_items', id).lifecycle, 'active'); assert.ok(f.repo.get('tree_reports', done.resultRef.reportId));
});

test('a consolidation job frozen before the upgrade only updates the summary', async t => {
  const f = learningFixture(t), parent = f.create('合成上级'), node = f.create('合成整理', parent); await f.turn(node, '请继续');
  f.asModel('learning', [node]); const [id] = f.propose(node, { methods: [method([f.ref])] }).methods.itemIds;
  const plan = f.consolidation.plan(node, 'leave_timeout'), frozen = f.consolidation.freeze(plan);
  const enqueued = f.jobs.enqueue({ role: 'consolidation', key: 'transition-summary', nodeIds: [node], input: frozen.input, revisionSet: frozen.revisions, config: f.config(), trigger: { kind: 'leave_timeout', modelSourceTurnId: plan.throughTurnIds.at(-1) } });
  const job = frozenAsBefore(f, enqueued, 'arcfold.tree.consolidation/4.0.0'), source = job.input.sources.find(s => s.role === 'user');
  const reflection = new ConsolidationReflection({ repository: f.repo, consolidation: f.consolidation, resolveSource: f.resolveSource });
  const output = { summary: { oneLine: '合成概况', status: '合成进展', outputs: [], decisions: [], next: '', pending: [] }, broaden: [{ kind: 'method', id, version: 1, toNodeId: parent, reason: '合成理由', sourceIds: [source.id] }], retrospect: { understandings: [], methods: [] } };
  const done = finish(f, job, output, (result, context) => reflection.applyResult(result, context));
  assert.equal(done.status, 'committed'); assert.deepEqual(done.resultRef.moved, []); assert.equal(f.repo.get('tree_items', id).nodeId, node);
  assert.ok(f.repo.get('tree_nodes', node).currentSummaryId);
});

test('an improvement job frozen before the upgrade only reports', t => {
  const f = improvementFixture(t), node = f.create('合成测试'); f.repair(node); f.repair(node);
  const job = frozenAsBefore(f, f.improvement.enqueue('learning'), 'arcfold.tree.improvement/4.0.0');
  const done = f.completeImprovement(job, personal(job));
  assert.equal(done.status, 'committed'); assert.equal(done.resultRef.reportOnly, true); assert.deepEqual(done.resultRef.supplements, []);
  assert.equal(f.repo.list('tree_items').length, 0); assert.equal(f.repo.list('tree_parameters').length, 0);
});
