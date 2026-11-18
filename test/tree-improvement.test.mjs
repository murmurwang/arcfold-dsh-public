import test from 'node:test';
import assert from 'node:assert/strict';
import { improvementFixture, noChange, personal, universal } from './fixtures/tree-improvement/helpers.mjs';
import { digest } from '../src/tree/contracts.mjs';
import { compilePrompt } from '../src/tree/prompts.mjs';

test('two distinct repairs aggregate across nodes, but changed and unresolved do not count', t => {
  const f = improvementFixture(t), a = f.create('我处理甲'), b = f.create('我处理乙');
  f.repair(a, { type: 'mark_changed' }); f.repair(b, { countsAsError: false, attribution: 'unresolved' }); assert.equal(f.improvement.enqueue('learning'), null);
  f.repair(a); assert.equal(f.improvement.enqueue('learning'), null); f.repair(b);
  const job = f.improvement.enqueue('learning'); assert.equal(job.input.repairs.length, 2); assert.ok(job.input.relatedNodeIds.includes(a) && job.input.relatedNodeIds.includes(b));
  assert.equal(f.improvement.enqueue('learning').id, job.id); assert.equal(job.input.fixedProducerSpecification.text, compilePrompt('learning').text);
});

test('diagnosis freezes program parameter behavior alongside the producer prompt and actual user settings', t => {
  const f = improvementFixture(t), node = f.create('我隔一段时间再回来');
  f.asUser(); f.tree.setParameter(f.cmd({ name: 'retentionDays', scopeNodeId: node, value: 14, sourceRefs: [] }));
  f.repair(node, { producerRole: 'attribution' }); f.repair(node, { producerRole: 'attribution' });
  const job = f.improvement.enqueue('attribution'), fixed = job.input.fixedProducerRuntime;
  assert.equal(fixed.role, 'attribution');
  assert.equal(fixed.parameters.retentionDays.default, f.tree.parameter('retentionDays', f.repo.rootId()));
  assert.equal(fixed.parameters.leaveTimeoutHours.default, f.tree.parameter('leaveTimeoutHours', node));
  assert.equal(job.input.parameters.find(p => p.name === 'retentionDays').value, 14);
  assert.deepEqual(job.trigger.explicitParameters, [{ name: 'retentionDays', scopeNodeId: node }]);
  assert.match(fixed.parameters.retentionDays.appliedAt, /调用前/);
  assert.match(fixed.parameters.retentionDays.appliedAt, /进行中、暂停和固定目标始终保留/);
});

test('different causes commit no changes and only new repairs form the next candidate', t => {
  const f = improvementFixture(t), node = f.create('我判断原因'); f.repair(node); f.repair(node);
  const job = f.improvement.enqueue('learning'); assert.equal(f.completeImprovement(job, noChange()).status, 'committed'); assert.equal(f.repo.list('tree_items').length, 0);
  assert.equal(f.improvement.enqueue('learning'), null); f.repair(node); assert.equal(f.improvement.enqueue('learning'), null); f.repair(node);
  assert.equal(f.improvement.enqueue('learning').input.repairs.length, 2);
});

test('personal improvement writes one finite supplement with real source and producer provenance', t => {
  const f = improvementFixture(t), node = f.create('我说明表达习惯'); f.repair(node); f.repair(node);
  const job = f.improvement.enqueue('learning'), done = f.completeImprovement(job, personal(job)); assert.equal(done.status, 'committed');
  const item = f.repo.get('tree_items', done.resultRef.supplements[0]), bundle = f.repo.get('tree_supplements', digest(['supplement', item.id, 1]));
  assert.equal(item.nodeId, f.repo.rootId()); assert.equal(item.producerRole, 'improvement'); assert.equal(bundle.universalStopgap, false); assert.equal(bundle.traitEvidence.length, 1);
  assert.equal(f.repo.list('tree_reports').length, 0);
});

test('universal issue links local report and stopgap; installed fix retires only matching unprotected stopgap', t => {
  const f = improvementFixture(t), node = f.create('我修正通用问题'); f.repair(node); f.repair(node);
  const job = f.improvement.enqueue('learning'), done = f.completeImprovement(job, universal(job)); assert.equal(done.status, 'committed');
  const report = f.repo.get('tree_reports', done.resultRef.reportId); assert.deepEqual(report.stopgapIds, done.resultRef.supplements); assert.equal(report.status, 'unhandled');
  assert.equal(f.reports.resolved({ fingerprints: ['unrelated'], releaseId: 'fixture-release', requestId: 'unrelated-fix' }).result.withdrawn.length, 0);
  const result = f.reports.resolved({ fingerprints: [report.fingerprint], releaseId: 'fixture-release', requestId: 'matching-fix' });
  assert.equal(result.result.withdrawn.length, 1); assert.equal(f.repo.get('tree_items', report.stopgapIds[0]).lifecycle, 'withdrawn');
});

test('recurring universal issue revises a known stopgap instead of hiding it from the next job', t => {
  const f = improvementFixture(t), node = f.create('我再查同一问题'); f.repair(node); f.repair(node);
  const first = f.improvement.enqueue('learning'), done = f.completeImprovement(first, universal(first)), id = done.resultRef.supplements[0];
  f.repair(node); f.repair(node); const second = f.improvement.enqueue('learning');
  assert.ok(second.input.knownItems.some(i => i.id === id)); assert.equal(second.input.existingReports.length, 1);
  const output = universal(second); output.supplements[0] = { ...output.supplements[0], op: 'revise', targetId: id, targetVersion: 1 };
  assert.equal(f.completeImprovement(second, output).status, 'committed'); assert.equal(f.repo.get('tree_items', id).activeVersion, 2); assert.equal(f.repo.list('tree_items').length, 1);
});

test('same universal report cannot accumulate a second active duplicate stopgap', t => {
  const f = improvementFixture(t), node = f.create('我避免重复规则'); f.repair(node); f.repair(node);
  const first = f.improvement.enqueue('learning'); f.completeImprovement(first, universal(first)); f.repair(node); f.repair(node);
  const job = f.improvement.enqueue('learning'); assert.throws(() => f.completeImprovement(job, universal(job)), { code: 'DUPLICATE_STOPGAP' }); assert.equal(f.repo.list('tree_items').length, 1);
});

test('checker problems can only report and may not change other producer rules or parameters', t => {
  const f = improvementFixture(t), node = f.create('我检验检验器'); f.repair(node, { producerRole: 'verification' }); f.repair(node, { producerRole: 'verification' });
  const job = f.improvement.enqueue('verification'), output = universal(job); output.supplements = [];
  assert.equal(f.completeImprovement(job, output).status, 'committed'); assert.equal(f.repo.list('tree_items').length, 0); assert.equal(f.repo.list('tree_reports').length, 1);
  f.repair(node, { producerRole: 'verification' }); f.repair(node, { producerRole: 'verification' }); const next = f.improvement.enqueue('verification'), invalid = universal(next);
  const refused = f.completeImprovement(next, invalid); assert.equal(refused.status, 'committed');
  assert.ok(refused.rejectedItems.length && refused.rejectedItems.every(r => r.item.startsWith('supplements[') && r.code === 'OUTPUT_CHECKER')); assert.equal(f.repo.list('tree_items').length, 0);
});

test('explicit user parameters and protected supplements survive automatic improvement', t => {
  const f = improvementFixture(t), node = f.create('我自己定参数'); f.asUser(); f.tree.setParameter(f.cmd({ name: 'retentionDays', scopeNodeId: f.repo.rootId(), value: 14, sourceRefs: [] }));
  f.repair(node); f.repair(node); const job = f.improvement.enqueue('learning'), output = personal(job); output.supplements = []; output.parameters = [{ name: 'retentionDays', scopeNodeId: f.repo.rootId(), value: 30, reason: '合成建议', sourceIds: [job.input.sources[0].id] }];
  const refused = f.completeImprovement(job, output); assert.equal(refused.status, 'committed');
  assert.deepEqual(refused.rejectedItems.map(r => [r.item, r.code]), [['parameters[0]', 'OUTPUT_PROTECTED']]); assert.equal(f.tree.parameter('retentionDays', node), 14);
});

test('same checker material with no diagnosed issue commits once without changing rules, reports or parameters', t => {
  for (const producerRole of ['verification', 'improvement']) {
    const f = improvementFixture(t), node = f.create('我分析相似材料');
    f.repair(node, { producerRole }); f.repair(node, { producerRole });
    const job = f.improvement.enqueue(producerRole);
    const output = { ...noChange(), same: true, diagnosis: '两处材料相似，但未证明发生共同错误；不改' };
    const done = f.completeImprovement(job, output);
    assert.equal(done.status, 'committed'); assert.equal(done.resultRef.kind, 'none');
    assert.deepEqual(done.resultRef.supplements, []); assert.deepEqual(done.resultRef.parameters, []);
    assert.equal(done.resultRef.reportId, null);
    for (const kind of ['tree_items', 'tree_supplements', 'tree_parameters', 'tree_reports']) assert.equal(f.repo.list(kind).length, 0);
    assert.equal(f.improvement.enqueue(producerRole), null);
  }
});

test('new user setting after freeze rejects the entire proposed parameter update', t => {
  const f = improvementFixture(t), node = f.create('我并发改参数'); f.repair(node); f.repair(node); const job = f.improvement.enqueue('learning');
  const output = personal(job); output.supplements = []; output.parameters = [{ name: 'leaveTimeoutHours', scopeNodeId: f.repo.rootId(), value: 6, reason: '合成建议', sourceIds: [job.input.sources[0].id] }];
  f.asUser(); f.tree.setParameter(f.cmd({ name: 'leaveTimeoutHours', scopeNodeId: f.repo.rootId(), value: 12, sourceRefs: [] }));
  assert.throws(() => f.completeImprovement(job, output), { code: 'USER_PROTECTED' }); assert.equal(f.tree.parameter('leaveTimeoutHours', node), 12);
});

test('report export is explicit, local, redacted by default and idempotent', t => {
  const f = improvementFixture(t), node = f.create('我检查导出'); f.repair(node); f.repair(node); const job = f.improvement.enqueue('learning'), output = universal(job);
  output.report.problem = '错误引用 /private/fixture/file 和 “合成原话”'; output.report.whyUniversal = '用户的合成秘密内容';
  const done = f.completeImprovement(job, output), reportId = done.resultRef.reportId, actor = { kind: 'user', id: 'fixture-owner' };
  const preview = f.reports.preview(reportId, { actor }); assert.ok(!JSON.stringify(preview).includes('/private/fixture')); assert.ok(!JSON.stringify(preview).includes('合成秘密内容'));
  const command = f.cmd({ reportIds: [reportId], includeEvidence: false }, f.expected('tree_reports', reportId)), receipt = f.reports.export(command, actor);
  assert.equal(receipt.result.sent, false); assert.equal(receipt.result.includesEvidence, false); assert.equal(f.reports.export(command, actor).id, receipt.id); assert.equal(f.repo.get('tree_reports', reportId).exportAudit.length, 1);
  const detailed = f.reports.export(f.cmd({ reportIds: [reportId], includeEvidence: true }, f.expected('tree_reports', reportId)), actor); assert.ok(detailed.result.content.includes('合成秘密内容'));
  assert.throws(() => f.reports.export(command, { kind: 'model', id: 'untrusted' }), { code: 'FORBIDDEN' });
});

test('unknown diagnosis request remains the only owner and does not get resent under a fresh key', t => {
  const f = improvementFixture(t), node = f.create('我保留未知结果'); f.repair(node); f.repair(node); const job = f.improvement.enqueue('learning'); f.jobs.prepare(job.id); f.jobs.submit(job.id); f.jobs.transition(job.id, 'unknown', { reason: 'fixture lost response' });
  f.repair(node); assert.equal(f.improvement.enqueue('learning').id, job.id); assert.equal(f.repo.list('tree_jobs', j => j.role === 'improvement').length, 1);
});

test('an installed fix keeps an explicitly user-protected stopgap and scope movement invalidates diagnosis', t => {
  const f = improvementFixture(t), a = f.create('我确认临时规则'), b = f.create('我调整适用位置'); f.repair(a); f.repair(a);
  const job = f.improvement.enqueue('learning'), done = f.completeImprovement(job, universal(job)), itemId = done.resultRef.supplements[0], report = f.repo.get('tree_reports', done.resultRef.reportId);
  f.asUser(); f.items.confirm(f.cmd({ itemId, version: 1 }, f.expected('tree_items', itemId)));
  const fixed = f.reports.resolved({ fingerprints: [report.fingerprint], releaseId: 'fixture-fix', requestId: 'protected-installed' }).result;
  assert.deepEqual(fixed.protectedIds, [itemId]); assert.equal(f.repo.get('tree_items', itemId).lifecycle, 'active');
  f.repair(a); f.repair(a); const next = f.improvement.enqueue('learning'); f.tree.moveNode(f.cmd({ nodeId: a, parentId: b, sourceRefs: [] }, f.expected('tree_nodes', a)));
  assert.throws(() => f.completeImprovement(next, noChange()), { code: 'JOB_STALE' });
});

test('a rejected diagnosis remains observable without rebuilding or resending its repair group', t => {
  const f = improvementFixture(t), node = f.create('我保留失败记录');
  f.repair(node); f.repair(node);
  const job = f.improvement.enqueue('learning');
  f.jobs.prepare(job.id); f.jobs.submit(job.id);
  f.jobs.receive(job.id, { message: { role: 'assistant', content: [{ type: 'text', text: 'not json' }] }, nativeLogRef: 'invalid#1', eventsHash: 'fixture-events' });
  assert.equal(f.jobs.validate(job.id).status, 'invalid_output');
  f.create('另一个目标');
  assert.equal(f.improvement.enqueue('learning').id, job.id);
  assert.equal(f.repo.list('tree_jobs', value => value.role === 'improvement').length, 1);
});
