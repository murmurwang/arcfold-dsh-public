import test from 'node:test';
import assert from 'node:assert/strict';
import { learningFixture, emptyVerification } from './fixtures/tree-learning/helpers.mjs';
import { method } from './fixtures/tree-domain/helpers.mjs';
import { VerificationService, ConsolidationReflection } from '../src/tree/verification.mjs';
import { digest } from '../src/tree/contracts.mjs';
import { ItemService } from '../src/tree/items.mjs';
import { compilePrompt } from '../src/tree/prompts.mjs';

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

test('assignment source recheck preserves independent evidence and whole bundles, without claiming effectiveness', async t => {
  for (const kind of ['method', 'supplement']) await t.test(kind, async t => {
    const f = await correctionFixture(t, kind);
    assert.deepEqual(f.job.input.sources.map(s => s.ref), f.retained.userSourceRefs);
    assert.equal(f.builder.activeItems([f.a], kind === 'supplement' ? 'learning' : 'main').length, 0);
    if (kind === 'method') f.repo.command('fixtureDisabledHook', f.cmd({}), { kind: 'program', id: 'fixture' }, () => {
      const hook = f.repo.list('tree_hooks', h => h.methodId === f.itemId)[0]; f.repo.save('tree_hooks', { ...hook, enabled: false, manuallyDisabled: true }, hook.revision); return {};
    });
    const done = completeCorrection(f, sourceDisposition(f)); assert.equal(done.status, 'committed');
    const item = f.repo.get('tree_items', f.itemId), current = f.repo.get('tree_item_versions', digest(['item_version', item.id, 2]));
    assert.equal(item.stale, false); assert.equal(item.validation, 'unverified'); assert.deepEqual(current.sourceRefs, f.retained.userSourceRefs);
    assert.deepEqual(f.repo.get('tree_item_versions', f.old.id), f.old);
    assert.equal(f.builder.activeItems([f.a], kind === 'supplement' ? 'learning' : 'main').length, 1);
    if (kind === 'method') {
      assert.deepEqual(current.content.sourceRefs, f.retained.userSourceRefs);
      const hooks = f.repo.list('tree_hooks', h => h.methodId === f.itemId && h.version === 2);
      assert.equal(hooks.find(h => h.manuallyDisabled).enabled, false);
      assert.ok(f.repo.list('tree_hooks', h => h.methodId === f.itemId && h.version === 1).every(h => !h.enabled));
    } else assert.deepEqual(f.repo.get('tree_supplements', digest(['supplement', f.itemId, 2])).traitEvidence, f.retained.userSourceRefs);
    assert.equal(f.repo.list('tree_repairs').length, 0); assert.equal(f.v.enqueueCorrection(f.intent).id, f.job.id);
  });
});

test('assignment source recheck refuses empty, effect, protected-change and wrong-kind results', async t => {
  const variants = ['empty', 'protected', 'wrong_kind', 'removed_evidence'];
  for (const variant of variants) await t.test(variant, async t => {
    const f = await correctionFixture(t, 'understanding', variant === 'protected'); let output = sourceDisposition(f);
    if (variant === 'empty') output = emptyVerification();
    if (variant === 'effect') output.missed = [{ what: '冒称模型漏做', evidence: output.operations[0].evidence }];
    if (variant === 'wrong_kind') { const replacement = method([]); delete replacement.sourceRefs; replacement.sourceIds = output.operations[0].evidence; output.operations[0] = { ...output.operations[0], op: 'rewrite', detail: { replacement } }; }
    if (variant === 'removed_evidence') output.operations[0].evidence = [f.resolveSource(f.removed.userSourceRefs[0]).id];
    assert.equal(completeCorrection(f, output).status, 'invalid_output'); assert.equal(f.repo.get('tree_items', f.itemId).stale, true);
    assert.equal(f.v.enqueueCorrection(f.intent).id, f.job.id, 'Rejected output cannot create a paid retry');
    assert.equal(f.repo.list('tree_exposures', e => e.kind === 'source_recheck').length, 0);
  });
  await t.test('effect claims are dropped and only the one disposition applies', async t => {
    const f = await correctionFixture(t, 'understanding', false), output = sourceDisposition(f);
    output.missed = [{ what: '冒称模型漏做', evidence: output.operations[0].evidence }];
    assert.equal(completeCorrection(f, output).status, 'committed');
    assert.equal(f.repo.list('tree_repairs', r => r.type === 'missed').length, 0);
    assert.equal(f.repo.list('tree_exposures', e => e.kind === 'source_recheck').length, 1);
  });
});

test('protected source recheck records a pending question, keeps content inactive and never fabricates main exposure', async t => {
  const f = await correctionFixture(t, 'understanding', true), output = { ...emptyVerification(), probes: [{ itemId: f.itemId, itemVersion: f.old.version, what: '剩余依据不足，需用户核对范围。', evidence: f.job.input.sources.map(s => s.id) }] };
  assert.equal(completeCorrection(f, output).status, 'committed');
  const item = f.repo.get('tree_items', f.itemId); assert.equal(item.stale, true); assert.equal(item.sourceReview.status, 'needs_evidence');
  assert.equal(item.activeVersion, f.old.version); assert.deepEqual(f.repo.get('tree_item_versions', f.old.id), f.old);
  assert.equal(f.builder.activeItems([f.a]).length, 0); assert.equal(f.repo.list('tree_exposures', e => e.role === 'main').length, 0);
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
  assert.equal(unexposed.status, 'committed'); assert.deepEqual(unexposed.rejectedItems.map(r => r.code), ['METHOD_NOT_EXPOSED']);
  await observe(f, a); const next = v.enqueue(a, { reason: 'cluster' });
  const result = complete(f, v, next, { ...emptyVerification(), verifications: [evaluation(next, id, 'met', 0)] });
  assert.equal(result.status, 'committed'); assert.deepEqual(result.rejectedItems.map(r => r.code), ['OUTPUT_OPPORTUNITY']); assert.equal(f.repo.get('tree_items', id).validation, 'unverified');
});

test('local method support records opportunity and source; not_met without repair is refused', async t => {
  const f = learningFixture(t), a = f.create('我验证局部做法'), [id] = propose(f, a); await observe(f, a); const v = verifier(f), job = v.enqueue(a);
  const result = complete(f, v, job, { ...emptyVerification(), verifications: [evaluation(job, id)] }); assert.equal(result.status, 'committed');
  assert.equal(f.repo.get('tree_items', id).validation, 'supported'); assert.equal(f.repo.get('tree_items', id).evaluations[0].opportunityCount, 1);
  await observe(f, a); const next = v.enqueue(a);
  const rejected = complete(f, v, next, { ...emptyVerification(), verifications: [evaluation(next, id, 'not_met')] });
  assert.equal(rejected.status, 'committed'); assert.deepEqual(rejected.rejectedItems.map(r => r.code), ['REPAIR_REQUIRED']);
  assert.equal(f.repo.get('tree_items', id).validation, 'supported');
});

test('same-window two repairs use the one verified native exposure and preserve historical versions', async t => {
  const f = learningFixture(t), a = f.create('我修正两个做法'), [x, y] = propose(f, a, 2); const observed = await observe(f, a), v = verifier(f), job = v.enqueue(a);
  const result = complete(f, v, job, { ...emptyVerification(), operations: [operation(job, x, 'withdraw'), operation(job, y, 'withdraw')] });
  assert.equal(result.status, 'committed'); assert.equal(f.repo.get('tree_items', x).lifecycle, 'withdrawn'); assert.equal(f.repo.get('tree_items', y).lifecycle, 'withdrawn');
  assert.ok(f.repo.get('tree_item_versions', digest(['item_version', x, 1]))); assert.equal(f.repo.get('tree_exposures', observed.exposure.id).revoked, true); assert.equal(f.repo.list('tree_repairs').length, 2);
});

test('user-protected version rejects model rewrite and concurrent user withdrawal rejects the whole batch', async t => {
  const f = learningFixture(t), a = f.create('我保护决定'), [x, y] = propose(f, a, 2); f.asUser(); f.items.confirm(f.cmd({ itemId: x, version: 1 }, f.expected('tree_items', x)));
  await observe(f, a); const v = verifier(f), job = v.enqueue(a), op = { ...operation(job, x, 'withdraw'), targetVersion: 2 };
  const refused = complete(f, v, job, { ...emptyVerification(), operations: [op] });
  assert.equal(refused.status, 'committed'); assert.deepEqual(refused.rejectedItems.map(r => r.code), ['OUTPUT_PROTECTED']); assert.equal(f.repo.get('tree_items', x).lifecycle, 'active');
  const next = v.enqueue(a, { reason: 'cluster' }); f.jobs.prepare(next.id); f.jobs.submit(next.id); f.asUser(); f.items.withdraw(f.cmd({ itemId: y, version: 1, reason: '用户撤回' }, f.expected('tree_items', y)));
  f.jobs.receive(next.id, { message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(emptyVerification()) }] }, nativeLogRef: 'fixture#2', eventsHash: digest('withdrawal') });
  assert.equal(f.jobs.validate(next.id).status, 'stale'); assert.equal(f.repo.get('tree_items', x).lifecycle, 'active');
});

test('attaching a rebuttal to protected understanding cannot silently confirm it', async t => {
  const f = learningFixture(t), node = f.create('我保护用户原意'); f.asModel('learning', [node]);
  const id = f.propose(node, { understandings: [{ content: '用户只选择本地学校', source: 'assistant_inferred', sourceRefs: [f.ref] }] }).understandings.itemIds[0];
  f.asUser(); f.items.confirm(f.cmd({ itemId: id, version: 1 }, f.expected('tree_items', id)));
  const before = f.repo.get('tree_items', id); await observe(f, node, '我不同意这条理解，但不要自动改动保护内容');
  const v = verifier(f), job = v.enqueue(node), op = { ...operation(job, id, 'support'), targetVersion: before.activeVersion, reason: '只附上反对证据，不确认或改写保护内容' };
  assert.equal(complete(f, v, job, { ...emptyVerification(), operations: [op] }).status, 'committed');
  const after = f.repo.get('tree_items', id); assert.equal(after.activeVersion, before.activeVersion); assert.equal(after.validation, before.validation);
  assert.equal(after.evaluations.at(-1).result, 'unclear'); assert.equal(after.reviews.at(-1).result, 'unclear');
});

test('three distinct consolidation windows with no opportunity withdraw at origin; duplicate and cluster windows do not count', async t => {
  const f = learningFixture(t), a = f.create('我等待适用情境'), [id] = propose(f, a); await observe(f, a); const v = verifier(f);
  for (let i = 0; i < 3; i++) {
    if (i) await observe(f, a);
    const job = v.enqueue(a, { summaryId: summary(f, a) }), evidence = job.input.effects[0].answer[0].id;
    const output = { ...emptyVerification(), verifications: [{ ...evaluation(job, id, 'unclear', 0), evidence: [evidence] }] };
    const done = complete(f, v, job, output); assert.equal(done.status, 'committed');
    assert.equal(f.jobs.commit(job.id).id, job.id); if (i < 2) assert.equal(f.repo.get('tree_items', id).lifecycle, 'active');
  }
  assert.equal(f.repo.get('tree_items', id).lifecycle, 'withdrawn'); assert.equal(f.repo.get('tree_items', id).evaluations.length, 3);
});

test('ancestor support needs two independent nodes and cannot be rewritten by one child', async t => {
  const f = learningFixture(t), a = f.create('我写甲'), b = f.create('我写乙'), [id] = propose(f, f.repo.rootId()), v = verifier(f);
  await observe(f, a); const first = v.enqueue(a); complete(f, v, first, { ...emptyVerification(), verifications: [evaluation(first, id)] }); assert.equal(f.repo.get('tree_items', id).validation, 'unverified');
  await observe(f, b); const second = v.enqueue(b); complete(f, v, second, { ...emptyVerification(), verifications: [evaluation(second, id)] }); assert.equal(f.repo.get('tree_items', id).validation, 'supported');
  const third = v.enqueue(a, { reason: 'cluster' }), rejected = complete(f, v, third, { ...emptyVerification(), operations: [operation(third, id, 'withdraw')] });
  assert.equal(rejected.status, 'committed'); assert.deepEqual(rejected.rejectedItems.map(r => r.code), ['ANCESTOR_EVIDENCE_ONLY']);
  assert.equal(f.repo.get('tree_items', id).lifecycle, 'active');
});

test('harden adds a finite hook in a new bundle; changed is a normal evolution, not a producer error', async t => {
  const f = learningFixture(t), a = f.create('我改进检查'), [id] = propose(f, a); await observe(f, a); const v = verifier(f), job = v.enqueue(a);
  const conditions = [{ field: 'toolsCalled', op: 'not_contains', value: 'read' }];
  const reminder = { moment: 'turn_end', conditions, action: 'remind_user', message: '说明实际检查结果' };
  const continuation = { moment: 'turn_end', conditions, action: 'continue', message: '读取材料后继续' };
  const op = operation(job, id, 'harden', { hooks: [reminder, continuation], scriptRequests: [] }, 'use');
  const reviewed = complete(f, v, job, { ...emptyVerification(), operations: [op], verifications: [evaluation(job, id, 'not_met')] });
  assert.equal(f.repo.get('tree_items', id).activeVersion, 2);
  const before = f.repo.get('tree_item_versions', digest(['item_version', id, 1])).content.hooks;
  const after = f.repo.get('tree_item_versions', digest(['item_version', id, 2])).content.hooks;
  assert.deepEqual(before, method([f.ref]).hooks, 'existing reminder is preserved');
  assert.deepEqual(after, [...before, { moment: 'user_message', conditions: [], action: 'add_context', message: reminder.message }, continuation]);
  assert.deepEqual(reviewed.resultRef.diagnostics, [{ code: 'HARDEN_REMINDER_TO_CONTEXT', itemId: id, itemVersion: 1, hookIndex: 0 }]);
  await observe(f, a); const next = v.enqueue(a), change = { ...operation(next, id, 'mark_changed'), targetVersion: 2 };
  complete(f, v, next, { ...emptyVerification(), operations: [change] }); assert.equal(f.repo.get('tree_items', id).lifecycle, 'changed'); assert.equal(f.repo.list('tree_repairs').length, 1);
});

test('verification shows a user-message context hook as the harden example', () => {
  const prompt = compilePrompt('verification');
  assert.equal(prompt.version, 'arcfold.tree.verification/5.0.1');
  assert.match(prompt.text, /harden为\{"hooks":\[\{"moment":"user_message","conditions":\[\],"action":"add_context"/u);
  assert.doesNotMatch(prompt.text, /"moment":"turn_end","conditions":\[\],"action":"remind_user"/u);
});

test('routine reflection rejects two proposals and exposes a valid probe next entry', async t => {
  const f = learningFixture(t), a = f.create('我探索新思路'), [id] = propose(f, a); await observe(f, a); const v = verifier(f), job = v.enqueue(a), u = { content: '合成推断', source: 'assistant_inferred', sourceIds: [source(job)], origin: 'routine' };
  const rejected = complete(f, v, job, { ...emptyVerification(), proposals: { understandings: [u, u], methods: [] } });
  assert.equal(rejected.status, 'committed'); assert.deepEqual(rejected.rejectedItems.map(r => [r.item, r.code]), [['proposals.understandings[1]', 'ROUTINE_LIMIT']]);
  assert.equal(f.repo.list('tree_items', i => i.kind === 'understanding' && i.producerRole === 'verification').length, 1);
  const next = v.enqueue(a, { reason: 'cluster' }); complete(f, v, next, { ...emptyVerification(), probes: [{ itemId: id, itemVersion: 1, what: '确认这个做法的适用范围', evidence: [source(next)] }] });
  assert.ok(JSON.stringify(f.builder.build([a])).includes('确认这个做法的适用范围'));
});

test('consolidation promotes an eligible own item by moving it, never copying or carrying local support', async t => {
  const f = learningFixture(t), a = f.create('我整理方法'), [id] = propose(f, a); await observe(f, a);
  const v = verifier(f), review = v.enqueue(a); complete(f, v, review, { ...emptyVerification(), verifications: [evaluation(review, id)] });
  assert.equal(f.repo.get('tree_items', id).validation, 'supported');
  const plan = f.consolidation.plan(a, 'leave_timeout'), frozen = f.consolidation.freeze(plan), inputSource = frozen.input.sources.find(s => s.role === 'user');
  const job = f.jobs.enqueue({ role: 'consolidation', key: 'broaden-fixture', nodeIds: [a], input: frozen.input, revisionSet: frozen.revisions, config: f.config(), trigger: { kind: 'leave_timeout', reason: 'leave_timeout', producerRole: 'program' } });
  const service = new ConsolidationReflection({ repository: f.repo, consolidation: f.consolidation, resolveSource: f.resolveSource });
  const output = { summary: { oneLine: '已核对', status: '有合成结果', outputs: [], decisions: [], next: '', pending: [] }, broaden: [{ kind: 'method', id, version: 1, toNodeId: f.repo.rootId(), reason: '可用于其它同类任务', sourceIds: [inputSource.id] }], retrospect: { understandings: [], methods: [] } };
  const result = complete(f, service, job, output); assert.equal(result.status, 'committed'); assert.equal(f.repo.list('tree_items').length, 1); assert.equal(f.repo.get('tree_items', id).nodeId, f.repo.rootId()); assert.equal(f.repo.get('tree_items', id).originNodeId, a);
  assert.ok(result.resultRef.summaryId); assert.deepEqual(result.resultRef.moved, [id]);
  assert.equal(f.repo.get('tree_items', id).validation, 'unverified');
});

test('format repairs preserve summary versions, correct name, and cannot invent a user decision', async t => {
  const f = learningFixture(t), a = f.create('我写初稿'); await observe(f, a); const sid = summary(f, a), v = verifier(f), job = v.enqueue(a, { summaryId: sid });
  const old = f.repo.get('tree_summaries', sid), fixed = { oneLine: '保留先前产出', status: '已形成初稿', outputs: [], decisions: [], next: '', pending: ['未核实的事项'] };
  const output = { ...emptyVerification(), formatFixes: [{ target: 'summary', id: a, version: old.version, fixed, reason: '补回遗漏的待核实项', sourceIds: [source(job)] }, { target: 'name', id: a, version: f.repo.get('tree_nodes', a).revision, fixed: '我完成可核验的初稿', reason: '写明结果', sourceIds: [source(job)] }] };
  assert.equal(complete(f, v, job, output).status, 'committed'); assert.deepEqual(f.repo.get('tree_summaries', sid), old);
  assert.equal(f.repo.get('tree_nodes', a).name, '我完成可核验的初稿'); const nextSummary = f.repo.get('tree_summaries', f.repo.get('tree_nodes', a).currentSummaryId); assert.equal(nextSummary.previousVersion, old.version);
  const next = v.enqueue(a, { summaryId: nextSummary.id }), assistantId = next.input.effects[0].answer[0].id;
  const bad = { ...emptyVerification(), formatFixes: [{ target: 'summary', id: a, version: nextSummary.version, fixed: { ...fixed, decisions: [{ what: '未经用户确认的建议', by: 'user', when: '本轮', sourceIds: [assistantId] }] }, reason: '伪造', sourceIds: [assistantId] }] };
  const refused = complete(f, v, next, bad); assert.equal(refused.status, 'committed'); assert.deepEqual(refused.rejectedItems.map(r => r.code), ['USER_SOURCE_REQUIRED']);
  assert.equal(f.repo.get('tree_nodes', a).currentSummaryId, nextSummary.id);
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

test('an unrelated user request can be evidence for zero applicable opportunities', async t => {
  const f = learningFixture(t), a = f.create('我做另一种任务'), [id] = propose(f, a); await observe(f, a, '这次只讨论方向，不改文件'); const v = verifier(f), job = v.enqueue(a);
  const result = complete(f, v, job, { ...emptyVerification(), verifications: [evaluation(job, id, 'unclear', 0)] });
  assert.equal(result.status, 'committed'); assert.equal(f.repo.get('tree_items', id).validation, 'unverified'); assert.equal(f.repo.get('tree_items', id).evaluations[0].opportunityCount, 0);
});

test('cross-node cluster review receives only bound episodes and their actual method exposures', async t => {
  const f = learningFixture(t), a = f.create('我讨论甲'), b = f.create('我讨论乙'), hidden = f.create('我讨论不相干的私事'), [id] = propose(f, a);
  await observe(f, a, '甲的反馈');
  const first = f.repo.list('tree_turns', t => t.status === 'settled').at(-1), firstJob = f.learning.enqueue(first.id, a), firstSource = firstJob.input.sources.find(s => s.role === 'user');
  f.complete(firstJob, { understandings: [], revisions: [], methods: [], supplements: [], categories: [{ category: 'not_understood', note: '甲', sourceId: firstSource.id, subjectIds: [id] }] });
  await f.feedback(b, 'not_understood', '乙的反馈'); await f.feedback(a, 'not_understood', '再一次甲的反馈'); await f.feedback(hidden, 'proceeded', '不应出现在其它簇里的私人内容');
  const cluster = f.clusters.candidate('not_understood', 'negative'), v = verifier(f), job = v.enqueue(f.repo.rootId(), { reason: 'cluster', clusterIds: [cluster.id] });
  assert.ok(job.input.knownItems.some(i => i.id === id)); assert.ok(job.input.effects.some(e => e.itemVersions.some(i => i.itemId === id)));
  assert.ok(!JSON.stringify(job.input).includes('不应出现在其它簇里的私人内容'));
  const evidence = job.input.clusters[0].episodes.map(e => e.sources.find(s => s.role === 'user').id);
  const done = complete(f, v, job, { ...emptyVerification(), clusters: [{ clusterId: cluster.id, clusterVersion: cluster.revision, verdict: 'none', commonality: '', evidence }] });
  assert.equal(done.status, 'committed'); assert.equal(f.repo.get('tree_clusters', cluster.id).status, 'reviewed_none');
});

test('ancestor negative evidence requires independent nodes; protected content remains active', async t => {
  const f = learningFixture(t), a = f.create('我检验甲'), b = f.create('我检验乙'), [id] = propose(f, f.repo.rootId()), v = verifier(f);
  f.asUser(); f.items.confirm(f.cmd({ itemId: id, version: 1 }, f.expected('tree_items', id)));
  for (const [index, node] of [a, b].entries()) {
    await observe(f, node); const job = v.enqueue(node);
    const result = complete(f, v, job, { ...emptyVerification(), verifications: [{ ...evaluation(job, id, 'not_met'), methodVersion: 2 }] });
    assert.equal(result.status, 'committed'); assert.equal(f.repo.get('tree_items', id).lifecycle, 'active');
    assert.equal(f.repo.get('tree_items', id).validation, index ? 'refuted' : 'supported');
  }
});

test('merge and rewrite preserve original versions while retiring prior validation', async t => {
  const f = learningFixture(t), a = f.create('我合并重复做法'), [x, y] = propose(f, a, 2), v = verifier(f); await observe(f, a);
  const first = v.enqueue(a); complete(f, v, first, { ...emptyVerification(), verifications: [evaluation(first, x)] });
  const job = v.enqueue(a, { reason: 'cluster' });
  assert.equal(complete(f, v, job, { ...emptyVerification(), operations: [operation(job, y, 'merge', { targetId: x, targetVersion: 1 })] }).status, 'committed');
  assert.equal(f.repo.get('tree_items', y).lifecycle, 'withdrawn'); assert.equal(f.repo.get('tree_items', x).activeVersion, 2); assert.equal(f.repo.get('tree_items', x).validation, 'unverified');
  assert.ok(f.repo.get('tree_item_versions', digest(['item_version', y, 1]))); assert.ok(f.repo.get('tree_item_versions', digest(['item_version', x, 1])));
  await observe(f, a); const next = v.enqueue(a), original = f.repo.get('tree_item_versions', digest(['item_version', x, 2])).content;
  const { sourceRefs, ...replacement } = original; replacement.sourceIds = [source(next)]; replacement.short = { ...replacement.short, action: '先保留已确认内容，再核对新改动。' };
  const op = { ...operation(next, x, 'rewrite', { replacement }), targetVersion: 2 };
  assert.equal(complete(f, v, next, { ...emptyVerification(), operations: [op] }).status, 'committed'); assert.equal(f.repo.get('tree_items', x).activeVersion, 3);
});

test('move is restricted to observed target scope and relocates attached hooks', async t => {
  const f = learningFixture(t), a = f.create('我明确归属甲'), b = f.create('我明确归属乙'), [id] = propose(f, a), v = verifier(f);
  await observe(f, a, '这项做法实际服务乙', [b]); const job = v.enqueue(a);
  assert.equal(complete(f, v, job, { ...emptyVerification(), operations: [operation(job, id, 'move', { toNodeId: b })] }).status, 'committed');
  assert.equal(f.repo.get('tree_items', id).nodeId, b); assert.equal(f.repo.get('tree_items', id).originNodeId, a);
  assert.ok(f.repo.list('tree_hooks', h => h.methodId === id && h.enabled).every(h => h.scopeNodeId === b));
});

test('missed learning is attributable only to a committed producer and new proposals retain checker provenance', async t => {
  const f = learningFixture(t), a = f.create('我检查遗漏'); const observed = await observe(f, a), learned = f.learning.enqueue(observed.turn.id, a);
  f.complete(learned, { understandings: [], revisions: [], methods: [], supplements: [], categories: [] });
  const v = verifier(f), job = v.enqueue(a), evidence = [source(job)];
  const result = complete(f, v, job, { ...emptyVerification(), missed: [{ what: '这次明确纠正没有留下理解', evidence }], proposals: { understandings: [{ content: '后续需保留确认过的内容', source: 'assistant_inferred', sourceIds: evidence, origin: 'missed' }], methods: [] } });
  assert.equal(result.status, 'committed'); const repair = f.repo.list('tree_repairs')[0]; assert.equal(repair.producerJobId, learned.id); assert.equal(repair.countsAsError, true);
  const item = f.repo.list('tree_items')[0]; assert.equal(item.producerRole, 'verification'); assert.equal(item.producerJobId, job.id);
});

test('missed evidence becomes unverified understanding once per exact node and text', async t => {
  const f = learningFixture(t), node = f.create('合成范围');
  await observe(f, node);
  const v = verifier(f), job = v.enqueue(node);
  const user = job.input.effects[0].input[0], assistant = job.input.effects[0].answer[0];
  const output = { ...emptyVerification(), missed: [
    { what: '保留原始格式', evidence: [assistant.id, user.id] },
    { what: '这是一项推断', evidence: [assistant.id] },
    { what: '保留原始格式', evidence: [user.id] },
    { what: '已记录的要求', evidence: [user.id] },
  ], proposals: { understandings: [{ content: '已记录的要求', source: 'user_expressed', sourceIds: [user.id], origin: 'routine' }], methods: [] } };
  const done = complete(f, v, job, output);
  assert.equal(done.status, 'committed');
  const rows = f.builder.activeItems([node]);
  assert.equal(rows.length, 3);
  for (const [content, sourceKind, refs] of [
    ['保留原始格式', 'user_expressed', [assistant.ref, user.ref]],
    ['这是一项推断', 'assistant_inferred', [assistant.ref]],
  ]) {
    const { item, version } = rows.find(row => row.version.content === content);
    assert.equal(item.validation, 'unverified');
    assert.equal(item.producerJobId, job.id);
    assert.equal(item.producerRole, 'verification');
    assert.equal(version.sourceKind, sourceKind);
    assert.deepEqual(version.sourceRefs, refs);
    assert.ok(done.resultRef.proposals.some(p => p.origin === 'missed' && p.result.understandings.itemIds.includes(item.id)));
  }
  const repairs = f.repo.list('tree_repairs');
  assert.equal(repairs.length, 4);
  assert.ok(repairs.every(r => !r.countsAsError && r.type === 'missed'));
  assert.equal(f.jobs.commit(job.id).id, job.id);
  assert.equal(f.repo.list('tree_item_versions').length, 3);
});

test('missed findings follow the cited episode owners inside a cross-node review', async t => {
  const f = learningFixture(t), a = f.create('合成甲'), b = f.create('合成乙');
  const first = await f.feedback(a, 'not_understood', '甲的要求');
  const second = await f.feedback(b, 'not_understood', '乙的要求');
  await f.feedback(a, 'not_understood', '甲再次反馈');
  const root = f.repo.rootId(), cluster = f.clusters.candidate('not_understood', 'negative');
  const v = verifier(f), job = v.enqueue(root, { reason: 'cluster', clusterIds: [cluster.id] });
  const done = complete(f, v, job, { ...emptyVerification(), missed: [
    { what: '乙的特定要求', evidence: [second.source.id] },
    { what: '两处都适用', evidence: [first.source.id, second.source.id] },
  ] });
  assert.equal(done.status, 'committed');
  const contents = id => f.builder.activeItems([id]).map(r => r.version.content).sort();
  assert.deepEqual(contents(root), []);
  assert.deepEqual(contents(a), ['两处都适用']);
  assert.deepEqual(contents(b), ['乙的特定要求', '两处都适用'].sort());
});

test('a frozen control source owned outside the review falls back to its review node', async t => {
  const f = learningFixture(t), node = f.create('合成检验'), other = f.create('合成对照');
  await f.turn(node);
  const external = await f.turn(other, '合成对照证据');
  const v = verifier(f), { input, revisions } = v.freeze(node);
  const control = f.sources.resolve(external.userSourceRefs[0]);
  input.sources.push(control);
  const job = f.jobs.enqueue({ role: 'verification', key: 'synthetic-control', nodeIds: [node], input, revisionSet: revisions, config: f.config(), trigger: { kind: 'window', producerRole: 'program' } });
  assert.equal(complete(f, v, job, { ...emptyVerification(), missed: [{ what: '对照中发现的问题', evidence: [control.id] }] }).status, 'committed');
  assert.deepEqual(f.builder.activeItems([node]).map(r => r.version.sourceRefs), [[control.ref]]);
  assert.deepEqual(f.builder.activeItems([other]), []);
});

test('oversized and unresolvable missed findings keep their repairs and diagnostics while valid siblings apply', async t => {
  const f = learningFixture(t), node = f.create('合成写入失败');
  await observe(f, node);
  const v = verifier(f), job = v.enqueue(node);
  const user = job.input.effects[0].input[0], assistant = job.input.effects[0].answer[0];
  // The item writer rechecks immutable evidence separately from the frozen job admission.
  v.resolveSource = ref => digest(ref) === digest(assistant.ref) ? null : f.resolveSource(ref);
  const tooLong = '长'.repeat(2001);
  const output = { ...emptyVerification(), missed: [
    { what: tooLong, evidence: [user.id] },
    { what: '此条的一个来源不可读', evidence: [user.id, assistant.id] },
    { what: '正常的遗漏', evidence: [user.id] },
  ], proposals: { understandings: [{ content: '正常的常规提议', source: 'user_expressed', sourceIds: [user.id], origin: 'routine' }], methods: [] } };
  const done = complete(f, v, job, output);
  assert.equal(done.status, 'committed');
  assert.deepEqual(f.repo.list('tree_repairs').map(r => r.reason).sort(), output.missed.map(r => r.what).sort());
  assert.deepEqual(f.builder.activeItems([node]).map(r => r.version.content).sort(), ['正常的遗漏', '正常的常规提议'].sort());
  assert.equal(f.repo.list('tree_item_versions').length, 2);
  const diagnostics = Object.values(f.repo.meta().runtimeDiagnostics).filter(d => d.kind === 'missed_understanding');
  assert.deepEqual(diagnostics.map(d => [d.jobId, d.index, d.code]).sort((a, b) => a[1] - b[1]), [[job.id, 0, 'INVALID_FIELD'], [job.id, 1, 'SOURCE_CHANGED']]);
});

test('a source failure on the second goal rolls back all new copies of that finding', async t => {
  const f = learningFixture(t), a = f.create('合成范围甲'), b = f.create('合成范围乙');
  const first = await f.feedback(a, 'not_understood', '甲的依据');
  const second = await f.feedback(b, 'not_understood', '乙的依据');
  await f.feedback(a, 'not_understood', '再次观察');
  const cluster = f.clusters.candidate('not_understood', 'negative');
  const v = verifier(f), job = v.enqueue(f.repo.rootId(), { reason: 'cluster', clusterIds: [cluster.id] });
  let reads = 0;
  v.resolveSource = ref => digest(ref) === digest(first.source.ref) && ++reads === 2 ? null : f.resolveSource(ref);
  const done = complete(f, v, job, { ...emptyVerification(), missed: [{ what: '跨节点但写入失败', evidence: [first.source.id, second.source.id] }] });
  assert.equal(done.status, 'committed');
  assert.equal(reads, 2);
  assert.equal(done.resultRef.proposals.length, 0);
  assert.equal(f.repo.list('tree_repairs', r => r.type === 'missed').length, 1);
  assert.equal(f.repo.list('tree_items').length, 0);
  assert.equal(f.repo.list('tree_item_versions').length, 0);
  assert.ok(Object.values(f.repo.meta().runtimeDiagnostics).some(d => d.jobId === job.id && d.code === 'SOURCE_CHANGED'));
});
