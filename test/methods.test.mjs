import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BusinessStore } from '../src/business.mjs';
import { MethodService, methodContentHash, usageForVersion, pauseMethod } from '../src/methods.mjs';
import { invalidateDependents } from '../src/learning-goals.mjs';
import { methodContextMessage } from '../src/method-context.mjs';

const hasCode = code => error => error.code === code;
const native = { sessionId: 'main-session', turn: 1, startSeq: 10 };
function fixture(t, patch = {}, filename = ':memory:') {
  const business = new BusinessStore({ filename });
  t.after(() => business.close());
  const store = business.storage, methods = new MethodService({ business });
  const source = store.save('events', { id: 'human-source', role: 'user', content: '解释前先核查原文。',
    occurredAt: '2026-11-06T00:00:00.000Z', conversationId: native.sessionId,
    provenance: { kind: 'fixture' } });
  const method = store.save('methods', { id: 'method-one', title: '先核查再解释',
    guidance: '完整指导只应在选中后提供：先找原文，区分原话与推断。', appliesTo: '解释已有项目时',
    doesNotApplyTo: '没有原件的一般讨论', status: 'trial', version: 1, maxTrialUses: 3,
    sourceIds: [source.id], dependencies: [{ kind: 'events', id: source.id, revision: source.revision }],
    validated: false, ...patch });
  const f = { business, store, methods, source, method };
  show(f);
  return f;
}
function show(f, turn = native, shownIds = null) {
  if (!f.store.get('host_bindings', turn.sessionId)) f.store.save('host_bindings', {
    id: turn.sessionId, sessionId: turn.sessionId, role: 'main' });
  const entries = f.methods.catalog({ sessionId: turn.sessionId });
  const snapshotId = `snapshot:${turn.sessionId}:${turn.startSeq}`, messageId = `message:${snapshotId}`;
  const old = f.store.get('context_snapshots', snapshotId);
  f.store.save('context_snapshots', { id: snapshotId, sessionId: turn.sessionId, turn: turn.turn,
    contextMessageId: messageId, material: { sessionId: turn.sessionId, turn: turn.turn,
      cutoffSequence: f.store.currentSequence(), methods: shownIds ? entries.filter(row => shownIds.includes(row.id)) : entries } },
    { expectedRevision: old?.revision ?? null });
  return { ...turn, contextSnapshotId: snapshotId, contextMessageId: messageId };
}
function selection(f, id = 'method-one') {
  const method = f.store.get('methods', id);
  return { id, revision: method.revision, contentHash: methodContentHash(method),
    reason: '当前任务需要解释原项目，适用条件成立。', sourceIds: [...method.sourceIds] };
}
function reserve(f, patch = {}) {
  return f.methods.reserve({ ...native, contextSnapshotId: `snapshot:${native.sessionId}:${native.startSeq}`,
    contextMessageId: `message:snapshot:${native.sessionId}:${native.startSeq}`, callId: 'tool-call-one',
    selections: [selection(f)], ...patch });
}

test('only actually shown candidates can be acquired; catalog and receipt never contain guidance', t => {
  const f = fixture(t);
  const catalog = f.methods.catalog({ sessionId: native.sessionId });
  assert.equal(JSON.stringify(catalog).includes(f.method.guidance), false);
  const hidden = show(f, native, []);
  assert.throws(() => reserve(f, hidden), hasCode('method_selection_changed'));
  assert.equal(f.store.listAll('method_adoptions').length, 0);
  show(f);
  const result = reserve(f);
  assert.equal(JSON.stringify(result.receipt).includes(f.method.guidance), false);
  assert.equal(result.bundle.methods[0].method.guidance, f.method.guidance);
  assert.equal(result.bundle.methods[0].sources[0].content, f.source.content);
  assert.equal(result.bundle.methods[0].selection.claimType, 'inference');
});

test('snapshot identity, main binding, source citations and stale content fail before reserving', t => {
  const f = fixture(t);
  assert.throws(() => reserve(f, { contextMessageId: 'invented-message' }), hasCode('method_context_mismatch'));
  assert.throws(() => reserve(f, { sessionId: 'unbound-helper' }), hasCode('method_context_mismatch'));
  assert.throws(() => reserve(f, { selections: [{ ...selection(f), sourceIds: ['unshown-source'] }] }), hasCode('invalid_method_selection'));
  assert.throws(() => reserve(f, { selections: [{ ...selection(f), revision: 0 }] }), hasCode('method_selection_changed'));
  f.store.save('methods', { ...f.method, guidance: '外部修订' }, { expectedRevision: f.method.revision });
  assert.throws(() => reserve(f), hasCode('method_selection_changed'));
  assert.equal(f.store.listAll('method_adoptions').length, 0);
});

test('same native turn and version count once across repeated tool calls without revising method content', t => {
  const f = fixture(t), before = f.store.get('methods', f.method.id);
  const first = reserve(f), second = reserve(f, { callId: 'another-call' });
  assert.deepEqual(second.receipt, first.receipt);
  assert.equal(f.store.listAll('method_adoptions').length, 1);
  assert.deepEqual(f.store.listAll('method_adoptions')[0].callIds, ['tool-call-one', 'another-call']);
  assert.deepEqual(f.store.get('methods', f.method.id), before);
  assert.equal(usageForVersion(f.store, before).trialUses, 1);
  const at = f.store.currentSequence(); reserve(f, { callId: 'another-call' });
  assert.equal(f.store.currentSequence(), at);
});

test('two connections with stale catalogs cannot both acquire the final trial; winner can complete', t => {
  const directory = mkdtempSync(join(tmpdir(), 'arcfold-methods-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = fixture(t, { maxTrialUses: 1 }, join(directory, 'business.sqlite'));
  const secondBusiness = new BusinessStore({ filename: f.store.filename }); t.after(() => secondBusiness.close());
  const other = { sessionId: 'second-main', turn: 1, startSeq: 20 };
  const second = { ...f, business: secondBusiness, store: secondBusiness.storage, methods: new MethodService({ business: secondBusiness }) };
  const secondContext = show(second, other);
  const won = reserve(f), adoptionId = won.receipt.adoptionIds[0];
  assert.throws(() => reserve(second, { ...secondContext, callId: 'other-call' }), hasCode('method_trial_exhausted'));
  assert.equal(f.store.listAll('method_adoptions').length, 1);
  assert.equal(f.methods.assertCurrent({ adoptionId, ...native }).bundle.method.guidance, f.method.guidance);
  assert.equal(f.store.get('methods', f.method.id).status, 'trial');
  assert.equal(f.methods.details(f.method.id).needsDecision, true);
  f.methods.settleTurn({ ...native, outcome: 'completed' });
  assert.equal(f.store.get('methods', f.method.id).status, 'paused');
  assert.equal(f.methods.notifications().items[0].reason, 'trial_limit');
  assert.throws(() => f.methods.assertCurrent({ adoptionId, ...native }), hasCode('method_adoption_closed'));
});

test('whole selection and material capacity are atomic; no partial charge survives an invalid second item', t => {
  const f = fixture(t);
  assert.throws(() => reserve(f, { selections: [selection(f), { ...selection(f), id: 'unshown' }] }), hasCode('method_selection_changed'));
  assert.equal(f.store.listAll('method_adoptions').length, 0);
  assert.throws(() => reserve(f, { maxCharacters: 10 }), hasCode('method_capacity'));
  assert.equal(f.store.listAll('method_adoptions').length, 0);
});

test('separate acquisitions share one turn capacity; overflow preserves earlier adoption without charging the new one', t => {
  const f = fixture(t, { guidance: '第一条完整指导。'.repeat(150) });
  const secondMethod = f.store.save('methods', { ...f.method, id: 'method-two', title: '第二条方法',
    guidance: '第二条完整指导。'.repeat(150) });
  show(f);
  const first = reserve(f), firstLength = methodContextMessage(first.bundle).content[0].text.length;
  // Independently bound the second entry at the same native identity. No adoption
  // is added by this projection, so the following rejection remains the first try.
  const secondEntry = { adoptionId: first.receipt.adoptionIds[0],
    method: { ...first.bundle.methods[0].method, id: secondMethod.id, title: secondMethod.title, guidance: secondMethod.guidance },
    sources: first.bundle.methods[0].sources, selection: first.bundle.methods[0].selection };
  const secondLength = methodContextMessage({ ...first.bundle, methods: [secondEntry] }).content[0].text.length;
  const cap = Math.max(firstLength, secondLength) + 100;
  assert.ok(firstLength < cap && secondLength < cap);
  const before = f.store.currentSequence(), oldAdoption = f.store.get('method_adoptions', first.receipt.adoptionIds[0]);
  assert.throws(() => reserve(f, { callId: 'second-call', selections: [selection(f, secondMethod.id)], maxCharacters: cap }),
    hasCode('method_capacity'));
  assert.equal(f.store.currentSequence(), before);
  assert.deepEqual(f.store.get('method_adoptions', oldAdoption.id), oldAdoption);
  assert.equal(usageForVersion(f.store, secondMethod).trialUses, 0);
  assert.deepEqual(f.methods.currentBundle(native), first.bundle);
  const added = reserve(f, { callId: 'second-call', selections: [selection(f, secondMethod.id)] });
  assert.equal(added.receipt.adoptionIds.length, 1);
  assert.equal(f.methods.currentBundle(native).methods.length, 2);
  // Revocation changes the projection, never the historical charge.
  f.store.save('source_controls', { id: f.source.id, withdrawn: true });
  assert.equal(f.methods.currentBundle(native).methods.length, 0);
  assert.equal(usageForVersion(f.store, f.method).trialUses, 1);
  assert.equal(usageForVersion(f.store, secondMethod).trialUses, 1);
});

test('method capacity includes the complete message introduction as well as the serialized bundle', t => {
  const example = fixture(t), bundle = reserve(example).bundle;
  const jsonLength = JSON.stringify(bundle).length, messageLength = methodContextMessage(bundle).content[0].text.length;
  assert.ok(messageLength > jsonLength);
  const f = fixture(t);
  assert.throws(() => reserve(f, { maxCharacters: jsonLength }), hasCode('method_capacity'));
  assert.equal(f.store.listAll('method_adoptions').length, 0);
  assert.equal(methodContextMessage(reserve(f, { maxCharacters: messageLength }).bundle).content[0].text.length, messageLength);
});

test('withdrawal after selection prevents exposure, preserves count, and creates one durable pause notification', t => {
  const f = fixture(t), adopted = reserve(f), adoptionId = adopted.receipt.adoptionIds[0];
  f.store.save('source_controls', { id: f.source.id, withdrawn: true });
  assert.throws(() => f.methods.assertCurrent({ adoptionId, ...native }), hasCode('method_unavailable'));
  assert.equal(usageForVersion(f.store, f.store.get('methods', f.method.id)).trialUses, 1);
  assert.equal(f.methods.notifications().total, 1);
  const revision = f.store.get('methods', f.method.id).revision;
  f.methods.reconcile(); f.methods.reconcile();
  assert.equal(f.store.get('methods', f.method.id).revision, revision);
  assert.equal(f.methods.notifications().total, 1);
  assert.equal(f.methods.details(f.method.id).activation.code, 'method_source_invalid');
});

test('validated host input is hash-bound and idempotent without claiming actual dispatch or extra trial counts', t => {
  const f = fixture(t), adopted = reserve(f);
  const args = { ...native, adoptionIds: adopted.receipt.adoptionIds, step: 2, requestIdentity: 'native-request-2', inputHash: 'a'.repeat(64) };
  const first = f.methods.recordInput(args), second = f.methods.recordInput(args);
  assert.deepEqual(second, first);
  assert.equal(f.store.listAll('method_inputs').length, 1);
  assert.equal(first[0].evidence, 'validated-input-handed-to-host-provider; actual-send-requires-native-request-evidence');
  assert.equal(first[0].inputHash, args.inputHash);
  assert.equal(usageForVersion(f.store, f.method).trialUses, 1);
  assert.throws(() => f.methods.recordInput({ ...args, inputHash: null }), hasCode('invalid_method_input'));
  assert.throws(() => f.methods.recordInput({ ...args, inputHash: 'b'.repeat(64) }), hasCode('method_input_conflict'));
  assert.throws(() => f.methods.recordInput({ ...args, step: 3 }), hasCode('method_input_conflict'));
  assert.throws(() => f.methods.recordInput({ ...args, turn: 2 }), hasCode('method_adoption_closed'));
  assert.equal(f.store.get('methods', f.method.id).validated, false);
});

test('cancelled or unknown exposure never refunds the trial and terminal replay cannot change its outcome', t => {
  const f = fixture(t, { maxTrialUses: 1 }), adopted = reserve(f);
  f.methods.settleTurn({ ...native, outcome: 'unknown' });
  const seq = f.store.currentSequence(); f.methods.settleTurn({ ...native, outcome: 'unknown' });
  assert.equal(f.store.currentSequence(), seq);
  assert.equal(f.store.get('method_adoptions', adopted.receipt.adoptionIds[0]).effectiveness, 'not_assessed');
  assert.equal(usageForVersion(f.store, f.store.get('methods', f.method.id)).trialUses, 1);
  assert.throws(() => f.methods.settleTurn({ ...native, outcome: 'completed' }), hasCode('method_outcome_conflict'));
});

test('legacy usage stays a frozen basis and positive feedback alone never grants ongoing authorization', t => {
  const f = fixture(t, { trialUses: 2, maxTrialUses: 3, evidence: [{ kind: 'positive_feedback' }] });
  reserve(f);
  assert.equal(f.store.get('methods', f.method.id).trialUses, 2);
  assert.equal(usageForVersion(f.store, f.method).trialUses, 3);
  f.methods.settleTurn({ ...native, outcome: 'completed' });
  assert.equal(f.store.get('methods', f.method.id).status, 'paused');
  assert.equal(f.methods.listDecisions().total, 1);
});

test('final trial allocation survives reopen without a native outcome and never pauses or refunds in-flight work', t => {
  const directory = mkdtempSync(join(tmpdir(), 'arcfold-method-pending-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = fixture(t, {}, join(directory, 'business.sqlite'));
  reserve(f); f.methods.settleTurn({ ...native, outcome: 'completed' });
  const second = { ...native, turn: 2, startSeq: 30 };
  reserve(f, { ...show(f, second), callId: 'second-use' }); f.methods.settleTurn({ ...second, outcome: 'completed' });
  const third = { ...native, turn: 3, startSeq: 50 }, context = show(f, third);
  const adopted = reserve(f, { ...context, callId: 'last-use' }), adoptionId = adopted.receipt.adoptionIds[0];
  const notice = f.methods.notifications().items[0], methodBefore = f.store.get('methods', f.method.id);
  assert.equal(notice.kind, 'method_trial_allocated');
  assert.equal(notice.pendingAdoptionCount, 1);
  assert.deepEqual(notice.pendingAdoptions, [{ id: adoptionId, ...third, callIds: ['last-use'], state: 'reserved' }]);
  assert.equal(methodBefore.status, 'trial'); assert.equal(methodBefore.revision, f.method.revision);
  assert.equal(f.methods.currentBundle(third).methods.length, 1);
  const database = f.store.filename; f.business.close();
  const reopened = new BusinessStore({ filename: database }); t.after(() => reopened.close());
  const methods = new MethodService({ business: reopened }), store = reopened.storage;
  const detail = methods.details(f.method.id), decision = methods.listDecisions().items[0];
  assert.equal(detail.usage.trialUses, 3); assert.equal(detail.pendingAdoptionCount, 1);
  assert.deepEqual(decision.pendingAdoptions, notice.pendingAdoptions);
  assert.deepEqual(methods.notifications().items, [notice]);
  const state = store.get('method_adoptions', adoptionId);
  methods.acknowledgeNotification(notice.id); const seq = store.currentSequence();
  for (let i = 0; i < 3; i++) {
    methods.catalog({ sessionId: third.sessionId }); methods.details(f.method.id);
    methods.listDecisions(); methods.notifications(); methods.reconcile();
  }
  assert.equal(store.currentSequence(), seq);
  assert.deepEqual(store.get('method_adoptions', adoptionId), state);
  assert.deepEqual(store.get('methods', f.method.id), methodBefore);
  assert.equal(methods.notifications().unreadCount, 0);
  assert.equal(methods.assertCurrent({ adoptionId, ...third }).bundle.method.guidance, f.method.guidance);
  const duplicate = { ...f, business: reopened, store, methods };
  reserve(duplicate, { ...context, callId: 'last-use' }); reserve(duplicate, { ...context, callId: 'last-use-again' });
  assert.equal(methods.notifications().total, 1); assert.equal(methods.notifications().unreadCount, 0);
  assert.equal(usageForVersion(store, methodBefore).trialUses, 3);
  methods.settleTurn({ ...third, outcome: 'completed' });
  assert.equal(methods.details(f.method.id).pendingAdoptionCount, 0);
  assert.equal(store.get('methods', f.method.id).status, 'paused');
  assert.deepEqual(methods.notifications().items.map(row => row.kind), ['method_paused', 'method_trial_allocated']);
  assert.equal(store.get('notifications', notice.id).status, 'read');
  assert.deepEqual(store.get('notifications', notice.id).pendingAdoptions, notice.pendingAdoptions);
});

test('method cards group all notices before paging and preserve each identity and history', t => {
  const f = fixture(t, { maxTrialUses: 1 }); reserve(f); f.methods.settleTurn({ ...native, outcome: 'completed' });
  // Two lifecycle notices plus enough history to exceed a page still form one card.
  for (let i = 0; i < 23; i++) f.store.save('notifications', { id: `older-notice-${i}`, kind: 'method_paused',
    methodId: f.method.id, methodVersion: 1, status: 'unread', title: '曾暂停', message: `原始提醒 ${i}`, reason: 'trial_limit' });
  const other = f.store.save('methods', { ...f.method, id: 'different-same-title', status: 'paused', pauseReason: 'trial_limit' });
  f.store.save('notifications', { id: 'orphan-notice', kind: 'method_paused', methodId: 'missing-method',
    methodVersion: 7, status: 'unread', title: '记录缺失但提醒仍保留', message: '历史原文', reason: 'trial_limit' });
  const before = JSON.stringify(f.store.listAll('notifications'));
  const first = f.methods.listCards({ limit: 1 }), second = f.methods.listCards({ offset: 1, limit: 1 }),
    third = f.methods.listCards({ offset: 2, limit: 1 });
  assert.equal(first.total, 3); assert.equal(first.decisionCount, 2); assert.equal(first.unreadCount, 26);
  assert.deepEqual(new Set([...first.items, ...second.items, ...third.items].map(row => row.method.id)),
    new Set([f.method.id, other.id, 'missing-method']));
  const firstHistory = f.methods.cardDetails(f.method.id), rest = f.methods.cardDetails(f.method.id, { offset: 20 });
  assert.equal(firstHistory.notifications.total, 25); assert.equal(firstHistory.notifications.nextOffset, 20);
  assert.equal(rest.notifications.items.length, 5); assert.equal(rest.notifications.nextOffset, null);
  const all = [...firstHistory.notifications.items, ...rest.notifications.items];
  assert.equal(new Set(all.map(row => row.id)).size, 25);
  assert.ok(all.every(row => row.methodId === f.method.id));
  assert.equal(f.methods.cardDetails('missing-method').activation.allowed, false);
  assert.equal(third.items[0].method.status, 'unavailable');
  assert.equal(JSON.stringify(f.store.listAll('notifications')), before);
  assert.throws(() => f.methods.cardDetails('never-existed'), hasCode('method_not_found'));
  assert.throws(() => f.methods.cardDetails(f.method.id, { offset: -1 }), hasCode('invalid_pagination'));
});

test('card current state wins over historical pauses and explicit keep-paused resolves the decision', t => {
  const f = fixture(t, { maxTrialUses: 1 }); reserve(f); f.methods.settleTurn({ ...native, outcome: 'completed' });
  const decide = (action, requestId) => {
    const detail = f.methods.cardDetails(f.method.id);
    return f.methods.decide({ methodId: f.method.id, expectedRevision: detail.method.revision,
      contentHash: detail.contentHash, action, requestId, userIdentity: 'browser:test' });
  };
  assert.equal(f.methods.listCards().items[0].needsDecision, true);
  decide('pause', 'keep-paused');
  assert.equal(f.methods.listCards().decisionCount, 0);
  assert.equal(f.methods.listCards().items[0].method.status, 'paused');
  decide('continue', 'continue-explicitly');
  const card = f.methods.listCards().items[0];
  assert.equal(card.method.status, 'active'); assert.equal(card.needsDecision, false);
  assert.equal(card.unreadCount, 3); assert.match(card.reason, /已明确确认/);
  const history = f.methods.cardDetails(f.method.id).notifications;
  for (const row of history.items) f.methods.acknowledgeNotification(row.id);
  assert.equal(f.methods.listCards().items[0].method.status, 'active');
  assert.equal(f.methods.listCards().unreadCount, 0);
  assert.equal(f.methods.cardDetails(f.method.id).notifications.total, 3);
  assert.equal(f.store.listAll('method_decisions').length, 2);
});

test('the last allocation rolls back if its durable notice cannot be saved', t => {
  const f = fixture(t, { maxTrialUses: 1 }), save = f.store.save.bind(f.store), sequence = f.store.currentSequence();
  f.store.save = (kind, record, options) => {
    if (kind === 'notifications' && record.kind === 'method_trial_allocated') throw new Error('notification-write-failed');
    return save(kind, record, options);
  };
  assert.throws(() => reserve(f), /notification-write-failed/); f.store.save = save;
  assert.equal(f.store.currentSequence(), sequence);
  assert.equal(f.store.listAll('method_adoptions').length, 0);
  assert.equal(f.store.listAll('notifications').length, 0);
  assert.deepEqual(f.store.get('methods', f.method.id), f.method);
});

test('reconciliation backfills only a missing allocation notice without inventing an outcome', t => {
  const f = fixture(t, { maxTrialUses: 1 });
  f.store.save('method_adoptions', { id: 'older-unsettled-adoption', ...native,
    methodId: f.method.id, methodVersion: 1, contentHash: methodContentHash(f.method), countedTrial: true,
    state: 'reserved', callIds: ['older-call'] });
  const before = f.store.get('method_adoptions', 'older-unsettled-adoption');
  f.methods.reconcile();
  const notice = f.methods.notifications().items[0];
  assert.equal(notice.kind, 'method_trial_allocated'); assert.equal(notice.pendingAdoptions[0].id, before.id);
  assert.deepEqual(f.store.get('method_adoptions', before.id), before);
  assert.deepEqual(f.store.get('methods', f.method.id), f.method);
  f.methods.acknowledgeNotification(notice.id); const seq = f.store.currentSequence();
  f.methods.reconcile(); assert.equal(f.store.currentSequence(), seq);
  assert.equal(f.methods.notifications().unreadCount, 0);
});

test('reading notification does not resume; explicit current user decision is idempotent and remains unvalidated', t => {
  const f = fixture(t, { maxTrialUses: 1 }); reserve(f); f.methods.settleTurn({ ...native, outcome: 'completed' });
  const notification = f.methods.notifications().items[0];
  f.methods.acknowledgeNotification(notification.id);
  assert.equal(f.store.get('methods', f.method.id).status, 'paused');
  assert.equal(f.methods.listDecisions().total, 1);
  const detail = f.methods.details(f.method.id);
  const request = { methodId: f.method.id, expectedRevision: detail.method.revision, contentHash: detail.contentHash,
    action: 'continue', requestId: 'human-action-one', userIdentity: 'browser:trusted-connection' };
  assert.throws(() => f.methods.decide({ ...request, expectedRevision: 1 }), hasCode('revision_conflict'));
  const result = f.methods.decide(request), seq = f.store.currentSequence();
  assert.equal(result.method.status, 'active'); assert.equal(result.method.validated, false);
  assert.equal(result.decision.provenance.kind, 'trusted_user_method_decision');
  assert.deepEqual(f.methods.decide(request), result); assert.equal(f.store.currentSequence(), seq);
  assert.throws(() => f.methods.decide({ ...request, action: 'pause' }), hasCode('decision_identity_conflict'));
  assert.equal(f.methods.listDecisions().total, 0);
  const next = { ...native, turn: 2, startSeq: 30 }, ctx = show(f, next);
  const again = reserve(f, ctx);
  assert.equal(f.store.get('method_adoptions', again.receipt.adoptionIds[0]).countedTrial, false);
  assert.equal(usageForVersion(f.store, result.method).trialUses, 1);
});

test('user continuation cannot revive revoked evidence or an older superseded version', t => {
  const f = fixture(t);
  pauseMethod(f.store, f.method, { reason: 'negative_feedback' });
  f.store.save('source_controls', { id: f.source.id, useProhibited: true });
  let detail = f.methods.details(f.method.id);
  const decision = () => ({ methodId: f.method.id, expectedRevision: detail.method.revision,
    contentHash: detail.contentHash, action: 'continue', requestId: 'continue', userIdentity: 'browser:one' });
  assert.throws(() => f.methods.decide(decision()), hasCode('method_source_invalid'));
  const control = f.store.get('source_controls', f.source.id);
  f.store.save('source_controls', { ...control, useProhibited: false }, { expectedRevision: control.revision });
  f.store.save('methods', { ...f.method, id: 'method-new', previousId: f.method.id, version: 2,
    guidance: '更准确的新指导', status: 'trial' });
  detail = f.methods.details(f.method.id);
  assert.equal(detail.successors[0].id, 'method-new');
  assert.throws(() => f.methods.decide(decision()), hasCode('method_superseded'));
  assert.equal(f.store.listAll('method_decisions').length, 0);
});

test('dependency invalidation shares the same atomic pause and durable notification path', t => {
  const f = fixture(t);
  invalidateDependents(f.store, { ids: [f.source.id], pendingId: 'learn-fixture', reason: 'understanding_withdraw_by_learning' });
  const paused = f.store.get('methods', f.method.id);
  assert.equal(paused.status, 'paused');
  const notification = f.methods.notifications().items[0];
  assert.equal(notification.methodRevision, paused.revision);
  assert.equal(notification.pendingId, 'learn-fixture');
  assert.equal(notification.reason, 'understanding_withdraw_by_learning');
  const before = f.store.currentSequence();
  assert.throws(() => f.store.transaction(() => {
    pauseMethod(f.store, paused, { reason: 'negative_feedback' }); throw new Error('rollback');
  }), /rollback/);
  assert.equal(f.store.currentSequence(), before);
  assert.equal(f.methods.notifications().total, 1);
});


test('old import withdrawal notices have a read-only explanation independent of the current method',t=>{
  const f=fixture(t,{status:'paused',pauseReason:'user_request',title:'现在的新标题'});
  const originals=['unread','read'].map(status=>f.store.save('notifications',{
    id:'old-import-'+status,kind:'method_paused',status,methodId:f.method.id,methodRevision:1,methodVersion:1,
    pendingId:'retained-import-batch',reason:'import_batch_withdrawn',title:'协作方法已暂停',
    message:'“原来的标题”：学习提出暂停：import_batch_withdrawn'}));
  const unrelated=f.store.save('notifications',{id:'other-notice',kind:'method_paused',status:'unread',methodId:f.method.id,
    methodRevision:1,methodVersion:1,reason:'unrecognized_old_reason',message:'“其他原因”：学习提出暂停：import_batch_withdrawn'});
  const otherKind=f.store.save('notifications',{id:'allocation-notice',kind:'method_trial_allocated',status:'read',methodId:f.method.id,
    reason:'import_batch_withdrawn',message:'“不是暂停通知”：学习提出暂停：import_batch_withdrawn'});
  const correct=f.store.save('notifications',{id:'new-correct',kind:'method_paused',status:'read',methodId:f.method.id,
    reason:'import_batch_withdrawn',message:'“正确生成时的标题”：你已撤销这批导入；方法依赖的来源已停止作为依据，因此暂停。原记录保留。'});
  const arbitrary=f.store.save('notifications',{id:'other-import-text',kind:'method_paused',status:'read',methodId:f.method.id,
    reason:'import_batch_withdrawn',message:'“另一条历史标题”：保留它当时自己的解释'});
  const nonSuffix=f.store.save('notifications',{id:'not-exact-suffix',kind:'method_paused',status:'read',methodId:f.method.id,
    reason:'import_batch_withdrawn',message:'“标题”：学习提出暂停：import_batch_withdrawn；另有后文'});
  const originalBytes=JSON.stringify(f.store.listAll('notifications')),sequence=f.store.currentSequence();
  const response=f.methods.notifications();
  for(const original of originals){
    const shown=response.items.find(row=>row.id===original.id);
    assert.equal(shown.displayMessage,'“原来的标题”：你已撤销这批导入；方法依赖的来源已停止作为依据，因此暂停。原记录保留。');
    assert.equal(shown.message,original.message);assert.equal(shown.revision,original.revision);assert.equal(shown.status,original.status);
    assert.equal(shown.displayMessage.includes('现在的新标题'),false);assert.equal(shown.displayMessage.includes('学习提出'),false);
  }
  for(const original of [unrelated,otherKind,correct,arbitrary,nonSuffix])assert.deepEqual(response.items.find(row=>row.id===original.id),original);
  assert.equal(JSON.stringify(f.store.listAll('notifications')),originalBytes);assert.equal(f.store.currentSequence(),sequence);
  assert.equal(f.methods.notifications({unread:true}).unreadCount,2);
  const paused=pauseMethod(f.store,f.store.get('methods',f.method.id),{reason:'保留未经归因的暂停理由'});
  assert.equal(f.methods.details(paused.id).reason,'暂停原因：保留未经归因的暂停理由');
});
