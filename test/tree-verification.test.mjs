import test from 'node:test';
import assert from 'node:assert/strict';
import { learningFixture, emptyVerification } from './fixtures/tree-learning/helpers.mjs';
import { method } from './fixtures/tree-domain/helpers.mjs';
import { VerificationService, ConsolidationReflection } from '../src/tree/verification.mjs';
import { digest } from '../src/tree/contracts.mjs';
import { ItemService } from '../src/tree/items.mjs';

function verifier(f) { return new VerificationService({ repository: f.repo, experience: f.experience, contextBuilder: f.builder, jobs: f.jobs, modelConfig: f.config, clusters: f.clusters }); }
function propose(f, node, count = 1) { f.asModel('learning', [node]); return f.propose(node, { methods: Array.from({ length: count }, () => method([f.ref])) }).methods.itemIds; }
async function observe(f, node, text = '请继续这项工作', extraNodes = []) {
  const turn = await f.turn(node, text, 'native-main', extraNodes); await f.builder.activate(turn.sessionId, turn.id, { cancelPrevious: () => {} });
  const id = digest(['synthetic-main-invocation', turn.id]);
  f.repo.command('fixtureMainInvocation', f.cmd({ turnId: turn.id }), { kind: 'program', id: 'fixture' }, () => {
    f.repo.save('tree_invocations', { id, jobId: 'fixture-main', role: 'main', nativeSessionId: turn.sessionId, nativeTurn: turn.nativeTurn, nativeStep: 1, ordinal: 1, modelConfigHash: digest('fixture'), promptHash: digest('fixture'), inputHash: digest('fixture'), allowedTools: [], state: 'result_received' }); return {};
  });
  const exposure = f.builder.expose(turn.sessionId, id, 1, f.builder.capture(turn.sessionId));
  return { turn, exposure };
}
function summary(f, nodeId) {
  const node = f.repo.get('tree_nodes', nodeId), old = node.currentSummaryId && f.repo.get('tree_summaries', node.currentSummaryId), version = (old?.version ?? 0) + 1, id = digest(['summary', nodeId, version]);
  f.repo.command('fixtureSummary', f.cmd({ nodeId, version }), { kind: 'program', id: 'fixture' }, () => {
    const turns = f.experience.turns(nodeId); f.repo.save('tree_summaries', { id, nodeId, version, oneLine: '合成进度', body: { status: '进行中', outputs: [], decisions: [], next: '', pending: [] }, throughTurnIds: turns.map(t => t.id), assignmentVersions: Object.fromEntries(turns.map(t => [t.id, t.assignmentRevision])), sourceRefs: turns.flatMap(t => t.userSourceRefs), previousVersion: old?.version ?? null });
    f.repo.save('tree_nodes', { ...node, currentSummaryId: id }, node.revision); return {};
  }); return id;
}
function complete(f, service, job, output) {
  if (job.status === 'committed') return job;
  f.jobs.prepare(job.id); f.jobs.submit(job.id); f.jobs.receive(job.id, { message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(output) }] }, nativeLogRef: 'synthetic-verification#1', eventsHash: digest(output) });
  const validated = f.jobs.validate(job.id); if (validated.status !== 'validated') return validated;
  return f.jobs.commit(job.id, (result, ctx) => service.applyResult(result, ctx));
}
const source = job => job.input.effects.at(-1).input[0].id;
const evaluation = (job, id, result = 'met', count = 1) => ({ methodId: id, methodVersion: 1, result, observed: '合成观察，非真实模型效果', opportunityCount: count, evidence: [source(job)] });
const operation = (job, id, op, detail = {}, stage = 'generate') => ({ op, targetId: id, targetVersion: 1, stage, reason: '合成修正理由', evidence: [source(job)], detail });

async function correctionFixture(t, kind = 'understanding', protectedItem = false) {
  const f = learningFixture(t), a = f.create('原目标'), b = f.create('独立目标');
  const removed = await f.turn(a, '待移走的原话'), retained = await f.turn(a, '仍在此目标的独立依据');
  const service = new ItemService({ repository: f.repo, resolveSource: f.resolveSource, context: () => f.context });
  f.asModel('learning', [a]); const refs = [...removed.userSourceRefs, ...retained.userSourceRefs];
  const proposals = { understandings: [], methods: [], supplements: [] };
  if (kind === 'understanding') proposals.understandings.push({ content: '合成待复核认识', source: 'assistant_inferred', sourceRefs: refs });
  if (kind === 'method') proposals.methods.push(method(refs));
  if (kind === 'supplement') proposals.supplements.push({ target: 'learning', text: { situation: '合成情境', action: '合成做法', basis: '剩余原话', notApplicable: '' }, sourceRefs: refs, traitEvidence: refs, universalStopgap: false });
  const result = service.commitProposal(f.cmd({ nodeId: a, ...proposals })).result;
  const id = Object.values(result).flatMap(r => r.itemIds ?? [])[0]; assert.ok(id);
  f.asUser(); if (protectedItem) service.confirm(f.cmd({ itemId: id, version: 1 }, f.expected('tree_items', id)));
  const version = f.repo.get('tree_items', id).activeVersion, old = f.repo.get('tree_item_versions', digest(['item_version', id, version]));
  f.tree.correctAssignment(f.cmd({ turnId: removed.id, nodeIds: [b], sourceRefs: [] }, f.expected('tree_turns', removed.id)));
  const intent = f.repo.list('tree_jobs', j => !j.role && j.kind === 'verification' && j.input.itemId === id)[0];
  const v = verifier(f), job = v.enqueueCorrection(intent);
  return { ...f, a, b, removed, retained, itemId: id, old, intent, v, job };
}
function completeCorrection(f, output) {
  f.jobs.prepare(f.job.id); f.jobs.submit(f.job.id);
  const invocation = f.jobs.admitInvocation(f.job.id, { turn: 1, step: 1, stepStartSeq: 1, requestHash: digest(['synthetic-source-review', f.job.inputHash]), allowedTools: [] });
  f.jobs.invocationResult(invocation.id, { state: 'result_received', resultHash: digest(output) });
  f.jobs.receive(f.job.id, { message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(output) }] }, nativeLogRef: 'synthetic-source-review#1', eventsHash: digest(output) });
  const validated = f.jobs.validate(f.job.id);
  return validated.status === 'validated' ? f.jobs.commit(f.job.id, (result, ctx) => f.v.applyResult(result, ctx)) : validated;
}
function sourceDisposition(f, op = 'support') { return { ...emptyVerification(), operations: [{ op, targetId: f.itemId, targetVersion: f.old.version, stage: 'none', reason: '合成：剩余依据足够支持原内容', evidence: f.job.input.sources.map(s => s.id), detail: {} }] }; }

test('assignment source recheck reports its assessment and keeps the old item inactive', async t => {
  for (const kind of ['method', 'supplement']) await t.test(kind, async t => {
    const f = await correctionFixture(t, kind);
    assert.deepEqual(f.job.input.sources.map(s => s.ref), f.retained.userSourceRefs);
    const before = f.repo.get('tree_items', f.itemId), output = sourceDisposition(f);
    const done = completeCorrection(f, output); assert.equal(done.status, 'committed');
    assert.deepEqual(f.repo.get('tree_items', f.itemId), before);
    assert.deepEqual(f.repo.get('tree_item_versions', f.old.id), f.old);
    assert.equal(f.builder.activeItems([f.a], kind === 'supplement' ? 'learning' : 'main').length, 0);
    assert.deepEqual(f.repo.get('tree_reports', done.resultRef.reportId).reviewOutput, output);
    assert.equal(f.repo.list('tree_repairs').length, 0); assert.equal(f.v.enqueueCorrection(f.intent).id, f.job.id);
  });
});

test('assignment source recheck refuses empty, effect, protected-change and wrong-kind results', async t => {
  const variants = ['empty', 'effect', 'protected', 'wrong_kind', 'removed_evidence'];
  for (const variant of variants) await t.test(variant, async t => {
    const f = await correctionFixture(t, 'understanding', variant === 'protected'); let output = sourceDisposition(f);
    if (variant === 'empty') output = emptyVerification();
    if (variant === 'effect') output.missed = [{ what: '冒称模型漏做', evidence: output.operations[0].evidence }];
    if (variant === 'wrong_kind') { const replacement = method([]); delete replacement.sourceRefs; replacement.sourceIds = output.operations[0].evidence; output.operations[0] = { ...output.operations[0], op: 'rewrite', detail: { replacement } }; }
    if (variant === 'removed_evidence') output.operations[0].evidence = [f.resolveSource(f.removed.userSourceRefs[0]).id];
    const result = completeCorrection(f, output);
    assert.equal(result.status, variant === 'effect' ? 'committed' : 'invalid_output');
    if (variant === 'effect') assert.ok(result.rejectedItems.length);
    assert.equal(f.repo.get('tree_items', f.itemId).stale, true);
    assert.equal(f.v.enqueueCorrection(f.intent).id, f.job.id, 'Rejected output cannot create a paid retry');
    assert.equal(f.repo.list('tree_exposures', e => e.kind === 'source_recheck').length, 0);
  });
});

test('protected source recheck reports a question and leaves content inactive', async t => {
  const f = await correctionFixture(t, 'understanding', true), before = f.repo.get('tree_items', f.itemId);
  const output = { ...emptyVerification(), probes: [{ itemId: f.itemId, itemVersion: f.old.version, what: '剩余依据不足，需用户核对范围。', evidence: f.job.input.sources.map(s => s.id) }] };
  const done = completeCorrection(f, output); assert.equal(done.status, 'committed');
  assert.deepEqual(f.repo.get('tree_items', f.itemId), before); assert.deepEqual(f.repo.get('tree_item_versions', f.old.id), f.old);
  assert.equal(f.builder.activeItems([f.a]).length, 0); assert.equal(f.repo.list('tree_exposures', e => e.role === 'main').length, 0);
  assert.deepEqual(f.repo.get('tree_reports', done.resultRef.reportId).reviewOutput, output);
});

test('unknown source review stays owned without resending; a concurrent assignment rejects late adoption', async t => {
  const f = await correctionFixture(t); f.jobs.prepare(f.job.id); f.jobs.submit(f.job.id); f.jobs.transition(f.job.id, 'unknown');
  assert.equal(f.v.enqueueCorrection(f.intent).status, 'unknown');
  f.asUser(); f.tree.correctAssignment(f.cmd({ turnId: f.retained.id, nodeIds: [f.b], sourceRefs: [] }, f.expected('tree_turns', f.retained.id)));
  f.jobs.receive(f.job.id, { message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(sourceDisposition(f)) }] }, nativeLogRef: 'synthetic-late#1', eventsHash: digest('late') });
  assert.equal(f.jobs.validate(f.job.id).status, 'stale'); assert.deepEqual(f.repo.get('tree_item_versions', f.old.id), f.old);
});

test('effect view binds exposed versions to answers and next human feedback, omitting tools', async t => {
  const f = learningFixture(t), a = f.create('我完成写作'), [id] = propose(f, a); const observed = await observe(f, a);
  await f.turn(a, '这个结果可以继续'); const v = verifier(f), job = v.enqueue(a, { reason: 'window' });
  assert.ok(job.input.effects[0].itemVersions.some(i => i.itemId === id)); assert.equal(job.input.effects[0].turnId, observed.turn.id);
  assert.ok(job.input.effects[0].feedback.some(s => s.text.includes('可以继续'))); assert.ok(!JSON.stringify(job.input).includes('合成工具结果'));
  assert.ok(job.input.sources.every(s => s.role !== 'tool' && s.origin !== 'tool-call'));
});

test('unexposed or zero-opportunity methods cannot be met; outcome requires exact method-specific evidence', async t => {
  const f = learningFixture(t), a = f.create('我核验方法'), [id] = propose(f, a); await f.turn(a); const v = verifier(f), job = v.enqueue(a);
  const unexposed = complete(f, v, job, { ...emptyVerification(), verifications: [evaluation(job, id, 'unclear', 0)] });
  assert.equal(unexposed.status, 'committed'); assert.equal(unexposed.rejectedItems[0].code, 'METHOD_NOT_EXPOSED');
  await observe(f, a); const next = v.enqueue(a, { reason: 'cluster' });
  const result = complete(f, v, next, { ...emptyVerification(), verifications: [evaluation(next, id, 'met', 0)] });
  assert.equal(result.status, 'committed'); assert.equal(result.rejectedItems[0].code, 'OUTPUT_OPPORTUNITY'); assert.equal(f.repo.get('tree_items', id).validation, 'unverified');
});

test('method evaluation is reported without changing its version or validation', async t => {
  const f = learningFixture(t), a = f.create('我验证局部做法'), [id] = propose(f, a); await observe(f, a);
  const v = verifier(f), job = v.enqueue(a), before = f.repo.get('tree_items', id);
  const output = { ...emptyVerification(), verifications: [evaluation(job, id, 'not_met')] };
  const done = complete(f, v, job, output); assert.equal(done.status, 'committed');
  assert.deepEqual(f.repo.get('tree_items', id), before); assert.deepEqual(f.repo.get('tree_reports', done.resultRef.reportId).reviewOutput, output);
});

test('two proposed repairs stay in a report and preserve exposed versions', async t => {
  const f = learningFixture(t), a = f.create('我修正两个做法'), [x, y] = propose(f, a, 2);
  const observed = await observe(f, a), v = verifier(f), job = v.enqueue(a);
  const before = [f.repo.get('tree_items', x), f.repo.get('tree_items', y)];
  const output = { ...emptyVerification(), operations: [operation(job, x, 'withdraw'), operation(job, y, 'withdraw')] };
  const done = complete(f, v, job, output); assert.equal(done.status, 'committed');
  assert.deepEqual([f.repo.get('tree_items', x), f.repo.get('tree_items', y)], before);
  assert.notEqual(f.repo.get('tree_exposures', observed.exposure.id).revoked, true);
  assert.equal(f.repo.list('tree_repairs').length, 0); assert.deepEqual(f.repo.get('tree_reports', done.resultRef.reportId).reviewOutput, output);
});

test('user-protected version rejects model rewrite and concurrent user withdrawal rejects the whole batch', async t => {
  const f = learningFixture(t), a = f.create('我保护决定'), [x, y] = propose(f, a, 2); f.asUser(); f.items.confirm(f.cmd({ itemId: x, version: 1 }, f.expected('tree_items', x)));
  await observe(f, a); const v = verifier(f), job = v.enqueue(a), op = { ...operation(job, x, 'withdraw'), targetVersion: 2 };
  const protectedResult = complete(f, v, job, { ...emptyVerification(), operations: [op] });
  assert.equal(protectedResult.status, 'committed'); assert.equal(protectedResult.rejectedItems[0].code, 'OUTPUT_PROTECTED');
  const next = v.enqueue(a, { reason: 'cluster' }); f.jobs.prepare(next.id); f.jobs.submit(next.id); f.asUser(); f.items.withdraw(f.cmd({ itemId: y, version: 1, reason: '用户撤回' }, f.expected('tree_items', y)));
  f.jobs.receive(next.id, { message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(emptyVerification()) }] }, nativeLogRef: 'fixture#2', eventsHash: digest('withdrawal') });
  assert.equal(f.jobs.validate(next.id).status, 'stale'); assert.equal(f.repo.get('tree_items', x).lifecycle, 'active');
});

test('reporting a rebuttal cannot change protected understanding or confirmation', async t => {
  const f = learningFixture(t), node = f.create('我保护用户原意'); f.asModel('learning', [node]);
  const id = f.propose(node, { understandings: [{ content: '用户只选择本地学校', source: 'assistant_inferred', sourceRefs: [f.ref] }] }).understandings.itemIds[0];
  f.asUser(); f.items.confirm(f.cmd({ itemId: id, version: 1 }, f.expected('tree_items', id)));
  const before = f.repo.get('tree_items', id); await observe(f, node, '我不同意这条理解，但不要自动改动保护内容');
  const v = verifier(f), job = v.enqueue(node), op = { ...operation(job, id, 'support'), targetVersion: before.activeVersion, reason: '只报告反对证据' };
  const done = complete(f, v, job, { ...emptyVerification(), operations: [op] });
  assert.equal(done.status, 'committed'); assert.deepEqual(f.repo.get('tree_items', id), before);
  assert.ok(f.repo.get('tree_reports', done.resultRef.reportId));
});

test('three windows with no opportunity do not automatically withdraw a method', async t => {
  const f = learningFixture(t), a = f.create('我等待适用情境'), [id] = propose(f, a); await observe(f, a); const v = verifier(f);
  const before = f.repo.get('tree_items', id);
  for (let i = 0; i < 3; i++) {
    if (i) await observe(f, a);
    const job = v.enqueue(a, { summaryId: summary(f, a) }), evidence = job.input.effects[0].answer[0].id;
    const done = complete(f, v, job, { ...emptyVerification(), verifications: [{ ...evaluation(job, id, 'unclear', 0), evidence: [evidence] }] });
    assert.equal(done.status, 'committed'); assert.deepEqual(f.repo.get('tree_items', id), before);
  }
  assert.equal(f.repo.list('tree_reports').length, 3);
});

test('child reports do not alter ancestor learning and invalid ancestor changes remain rejected', async t => {
  const f = learningFixture(t), a = f.create('我写甲'), b = f.create('我写乙'), [id] = propose(f, f.repo.rootId()), v = verifier(f);
  const before = f.repo.get('tree_items', id);
  for (const node of [a, b]) { await observe(f, node); const job = v.enqueue(node); assert.equal(complete(f, v, job, { ...emptyVerification(), verifications: [evaluation(job, id)] }).status, 'committed'); }
  assert.deepEqual(f.repo.get('tree_items', id), before);
  const third = v.enqueue(a, { reason: 'cluster' }), rejected = complete(f, v, third, { ...emptyVerification(), operations: [operation(third, id, 'withdraw')] });
  assert.equal(rejected.status, 'committed'); assert.equal(rejected.rejectedItems[0].code, 'ANCESTOR_EVIDENCE_ONLY');
  assert.deepEqual(f.repo.get('tree_items', id), before);
});

test('harden suggestion is recorded without adding executable components', async t => {
  const f = learningFixture(t), a = f.create('我改进检查'), [id] = propose(f, a); await observe(f, a); const v = verifier(f), job = v.enqueue(a);
  const before = f.repo.get('tree_items', id), hooks = f.repo.list('tree_hooks');
  const op = operation(job, id, 'harden', { hooks: [{ moment: 'turn_end', conditions: [], action: 'remind_user', message: '说明实际检查结果' }], scriptRequests: [] }, 'use');
  const output = { ...emptyVerification(), operations: [op], verifications: [evaluation(job, id, 'not_met')] };
  const done = complete(f, v, job, output); assert.equal(done.status, 'committed');
  assert.deepEqual(f.repo.get('tree_items', id), before); assert.deepEqual(f.repo.list('tree_hooks'), hooks);
  assert.equal(f.repo.list('tree_repairs').length, 0);
});

test('duplicate routine proposals are rejected and valid probes remain in the report', async t => {
  const f = learningFixture(t), a = f.create('我探索新思路'), [id] = propose(f, a); await observe(f, a); const v = verifier(f), job = v.enqueue(a);
  const u = { content: '合成推断', source: 'assistant_inferred', sourceIds: [source(job)], origin: 'routine' };
  const rejected = complete(f, v, job, { ...emptyVerification(), proposals: { understandings: [u, u], methods: [] } });
  assert.equal(rejected.status, 'committed'); assert.equal(rejected.rejectedItems[0].code, 'ROUTINE_LIMIT');
  const next = v.enqueue(a, { reason: 'cluster' }), before = f.repo.get('tree_items', id);
  const done = complete(f, v, next, { ...emptyVerification(), probes: [{ itemId: id, itemVersion: 1, what: '确认这个做法的适用范围', evidence: [source(next)] }] });
  assert.deepEqual(f.repo.get('tree_items', id), before); assert.ok(JSON.stringify(f.repo.get('tree_reports', done.resultRef.reportId)).includes('确认这个做法的适用范围'));
});

test('consolidation updates summary but does not promote learned items automatically', async t => {
  const f = learningFixture(t), a = f.create('我整理方法'), [id] = propose(f, a); await observe(f, a);
  const before = f.repo.get('tree_items', id), plan = f.consolidation.plan(a, 'leave_timeout'), frozen = f.consolidation.freeze(plan);
  const sourceId = frozen.input.sources.find(s => s.role === 'user').id;
  const job = f.jobs.enqueue({ role: 'consolidation', key: 'broaden-fixture', nodeIds: [a], input: frozen.input, revisionSet: frozen.revisions, config: f.config(), trigger: { kind: 'leave_timeout', reason: 'leave_timeout', producerRole: 'program' } });
  const service = new ConsolidationReflection({ repository: f.repo, consolidation: f.consolidation, resolveSource: f.resolveSource });
  const output = { summary: { oneLine: '已核对', status: '有合成结果', outputs: [], decisions: [], next: '', pending: [] }, broaden: [{ kind: 'method', id, version: 1, toNodeId: f.repo.rootId(), reason: '可用于其它同类任务', sourceIds: [sourceId] }], retrospect: { understandings: [], methods: [] } };
  const done = complete(f, service, job, output); assert.equal(done.status, 'committed'); assert.ok(done.resultRef.summaryId);
  assert.deepEqual(done.resultRef.moved, []); assert.deepEqual(f.repo.get('tree_items', id), before);
});

test('format suggestions stay in report and cannot invent a user decision', async t => {
  const f = learningFixture(t), a = f.create('我写初稿'); await observe(f, a); const sid = summary(f, a), v = verifier(f), job = v.enqueue(a, { summaryId: sid });
  const old = f.repo.get('tree_summaries', sid), node = f.repo.get('tree_nodes', a);
  const fixed = { oneLine: '保留先前产出', status: '已形成初稿', outputs: [], decisions: [], next: '', pending: ['未核实'] };
  const output = { ...emptyVerification(), formatFixes: [{ target: 'summary', id: a, version: old.version, fixed, reason: '补回待核项', sourceIds: [source(job)] }, { target: 'name', id: a, version: node.revision, fixed: '我完成可核验的初稿', reason: '写明结果', sourceIds: [source(job)] }] };
  const done = complete(f, v, job, output); assert.equal(done.status, 'committed'); assert.deepEqual(f.repo.get('tree_nodes', a), node); assert.deepEqual(f.repo.get('tree_summaries', sid), old);
  const next = v.enqueue(a, { summaryId: sid, reason: 'cluster' }), assistantId = next.input.effects[0].answer[0].id;
  const bad = { ...emptyVerification(), formatFixes: [{ target: 'summary', id: a, version: old.version, fixed: { ...fixed, decisions: [{ what: '未经用户确认', by: 'user', when: '本轮', sourceIds: [assistantId] }] }, reason: '伪造', sourceIds: [assistantId] }] };
  const rejected = complete(f, v, next, bad); assert.equal(rejected.status, 'committed'); assert.equal(rejected.rejectedItems[0].code, 'USER_SOURCE_REQUIRED');
  assert.equal(f.repo.get('tree_nodes', a).currentSummaryId, sid);
});

test('two no-opportunity reviews of one summary still count as one consolidation window', async t => {
  const f = learningFixture(t), a = f.create('我等待一次机会'), [id] = propose(f, a), v = verifier(f); await observe(f, a); const sid = summary(f, a);
  for (let i = 0; i < 2; i++) {
    if (i) await observe(f, a);
    const job = v.enqueue(a, { summaryId: sid }); complete(f, v, job, { ...emptyVerification(), verifications: [{ ...evaluation(job, id, 'unclear', 0), evidence: [job.input.effects[0].answer[0].id] }] });
  }
  const third = v.enqueue(a, { summaryId: summary(f, a) }); complete(f, v, third, { ...emptyVerification(), verifications: [{ ...evaluation(third, id, 'unclear', 0), evidence: [third.input.effects[0].answer[0].id] }] });
  assert.equal(f.repo.get('tree_items', id).lifecycle, 'active');
});

test('zero-opportunity evidence stays in a report without changing the method', async t => {
  const f = learningFixture(t), a = f.create('我做另一种任务'), [id] = propose(f, a); await observe(f, a, '这次只讨论方向，不改文件');
  const v = verifier(f), job = v.enqueue(a), before = f.repo.get('tree_items', id);
  const output = { ...emptyVerification(), verifications: [evaluation(job, id, 'unclear', 0)] };
  const result = complete(f, v, job, output); assert.equal(result.status, 'committed');
  assert.deepEqual(f.repo.get('tree_items', id), before); assert.equal(f.repo.get('tree_reports', result.resultRef.reportId).reviewOutput.verifications[0].opportunityCount, 0);
});

test('cross-node cluster report uses bound episodes without changing the cluster', async t => {
  const f = learningFixture(t), a = f.create('我讨论甲'), b = f.create('我讨论乙'), hidden = f.create('我讨论不相干的私事'), [id] = propose(f, a);
  await observe(f, a, '甲的反馈'); const first = f.repo.list('tree_turns', t => t.status === 'settled').at(-1), firstJob = f.learning.enqueue(first.id, a), firstSource = firstJob.input.sources.find(s => s.role === 'user');
  f.complete(firstJob, { understandings: [], revisions: [], methods: [], supplements: [], categories: [{ category: 'not_understood', note: '甲', sourceId: firstSource.id, subjectIds: [id] }] });
  await f.feedback(b, 'not_understood', '乙的反馈'); await f.feedback(a, 'not_understood', '再一次甲的反馈'); await f.feedback(hidden, 'proceeded', '不应出现在其它簇里的私人内容');
  const cluster = f.clusters.candidate('not_understood', 'negative'), v = verifier(f), job = v.enqueue(f.repo.rootId(), { reason: 'cluster', clusterIds: [cluster.id] });
  assert.ok(job.input.knownItems.some(i => i.id === id)); assert.ok(!JSON.stringify(job.input).includes('不应出现在其它簇里的私人内容'));
  const evidence = job.input.clusters[0].episodes.map(e => e.sources.find(s => s.role === 'user').id);
  const done = complete(f, v, job, { ...emptyVerification(), clusters: [{ clusterId: cluster.id, clusterVersion: cluster.revision, verdict: 'none', commonality: '', evidence }] });
  assert.equal(done.status, 'committed'); assert.equal(f.repo.get('tree_clusters', cluster.id).status, cluster.status);
});

test('negative evidence from independent nodes does not alter protected content', async t => {
  const f = learningFixture(t), a = f.create('我检验甲'), b = f.create('我检验乙'), [id] = propose(f, f.repo.rootId()), v = verifier(f);
  f.asUser(); f.items.confirm(f.cmd({ itemId: id, version: 1 }, f.expected('tree_items', id))); const before = f.repo.get('tree_items', id);
  for (const node of [a, b]) { await observe(f, node); const job = v.enqueue(node);
    const result = complete(f, v, job, { ...emptyVerification(), verifications: [{ ...evaluation(job, id, 'not_met'), methodVersion: 2 }] });
    assert.equal(result.status, 'committed'); assert.deepEqual(f.repo.get('tree_items', id), before);
  }
});

test('proposed merge is retained in report without changing either item', async t => {
  const f = learningFixture(t), a = f.create('我合并重复做法'), [x, y] = propose(f, a, 2), v = verifier(f); await observe(f, a);
  const before = [f.repo.get('tree_items', x), f.repo.get('tree_items', y)], job = v.enqueue(a);
  const output = { ...emptyVerification(), operations: [operation(job, y, 'merge', { targetId: x, targetVersion: 1 })] };
  const done = complete(f, v, job, output); assert.equal(done.status, 'committed');
  assert.deepEqual([f.repo.get('tree_items', x), f.repo.get('tree_items', y)], before);
  assert.ok(f.repo.get('tree_item_versions', digest(['item_version', y, 1]))); assert.ok(f.repo.get('tree_item_versions', digest(['item_version', x, 1])));
});

test('proposed move does not relocate the method or its hooks', async t => {
  const f = learningFixture(t), a = f.create('我明确归属甲'), b = f.create('我明确归属乙'), [id] = propose(f, a), v = verifier(f);
  await observe(f, a, '这项做法实际服务乙', [b]); const job = v.enqueue(a), before = f.repo.get('tree_items', id), hooks = f.repo.list('tree_hooks');
  const done = complete(f, v, job, { ...emptyVerification(), operations: [operation(job, id, 'move', { toNodeId: b })] });
  assert.equal(done.status, 'committed'); assert.deepEqual(f.repo.get('tree_items', id), before); assert.deepEqual(f.repo.list('tree_hooks'), hooks);
});

test('possible missed learning and new proposals stay in the report', async t => {
  const f = learningFixture(t), a = f.create('我检查遗漏'); const observed = await observe(f, a), learned = f.learning.enqueue(observed.turn.id, a);
  f.complete(learned, { understandings: [], revisions: [], methods: [], supplements: [], categories: [] });
  const v = verifier(f), job = v.enqueue(a), evidence = [source(job)];
  const output = { ...emptyVerification(), missed: [{ what: '这次明确纠正没有留下理解', evidence }], proposals: { understandings: [{ content: '后续需保留确认过的内容', source: 'assistant_inferred', sourceIds: evidence, origin: 'missed' }], methods: [] } };
  const done = complete(f, v, job, output); assert.equal(done.status, 'committed');
  assert.equal(f.repo.list('tree_repairs').length, 0); assert.equal(f.repo.list('tree_items').length, 0);
  assert.deepEqual(f.repo.get('tree_reports', done.resultRef.reportId).reviewOutput, output);
});
