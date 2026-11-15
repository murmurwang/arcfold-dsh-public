import test from 'node:test';
import assert from 'node:assert/strict';
import { BusinessStore, eventId } from '../src/business.mjs';
import { GoalService } from '../src/goals.mjs';
import { goalContextMessage } from '../src/goal-context.mjs';

const code = expected => error => error.code === expected;
const native = { sessionId: 'goal-main', turn: 1, startSeq: 0 };
const content = text => [{ type: 'text', text }];
const refs = source => [{ kind: 'events', id: source.id, revision: source.revision }];

function fixture(t, patch = {}) {
  const business = new BusinessStore({ filename: ':memory:' });
  t.after(() => business.close());
  const store = business.storage, goals = new GoalService({ business });
  const source = store.save('events', { id: 'goal-source', role: 'user', content: '我想让发布结果可以回查依据。',
    occurredAt: '2026-11-06T00:00:00.000Z', conversationId: 'original-discussion', provenance: { kind: 'fixture' } });
  const goal = store.save('goals', { id: 'goal-one', conversationId: 'original-discussion', scope: {},
    title: '可回查的发布', outcome: '每次发布有可复核的依据', definitionVersion: 1, status: 'tracking',
    sourceIds: [source.id], dependencies: refs(source), userControl: null, claimType: 'inference',
    progress: { content: '', sourceIds: [], dependencies: [] }, relations: [], ...patch });
  store.save('host_bindings', { id: native.sessionId, sessionId: native.sessionId, role: 'main' });
  return { business, store, goals, source, goal };
}
function shown(f, inputMessageIds = [], pos = native) {
  const cutoffSequence = f.store.currentSequence();
  const entries = f.goals.catalog({ sessionId: pos.sessionId, cutoffSequence, inputMessageIds });
  const id = 'goal-snapshot:' + pos.sessionId + ':' + pos.turn;
  const old = f.store.get('context_snapshots', id);
  f.store.save('context_snapshots', { id, sessionId: pos.sessionId, turn: pos.turn,
    contextMessageId: 'message:' + id, material: { ...pos, cutoffSequence, inputMessageIds, goals: entries } },
  { expectedRevision: old?.revision ?? null });
  return { ...pos, contextSnapshotId: id, contextMessageId: 'message:' + id };
}
function selection(f, entry) {
  entry ||= f.goals.catalog({ sessionId: native.sessionId })[0];
  return { id: entry.id, revision: entry.revision, definitionVersion: entry.definitionVersion,
    contentHash: entry.contentHash, reason: '本次检查表为后续发布留下可复核依据。', sourceIds: [...entry.sourceIds] };
}
function acquire(f, changes = {}) {
  return f.goals.link({ ...native, contextSnapshotId: 'goal-snapshot:goal-main:1',
    contextMessageId: 'message:goal-snapshot:goal-main:1', callId: 'goal-call-1',
    selection: Object.hasOwn(changes, 'selection') ? changes.selection : selection(f), ...changes });
}
function bind(f, mode = 'discuss', patch = {}) {
  const goal = f.store.get('goals', f.goal.id);
  return f.goals.bindDiscussion({ sessionId: native.sessionId, requestId: 'goal-prompt-1',
    content: content('先重新讨论这个结果，不开始执行。'), goalId: goal.id, expectedRevision: goal.revision,
    definitionVersion: goal.definitionVersion, mode, userIdentity: 'browser:owner', ...patch });
}
function original(f, request, source = { kind: 'user', rpcId: request.requestId }, messageId = 'native-user-1') {
  const previous = f.store.listAll('dsh_events', { where: { sessionId: native.sessionId } });
  const seq = previous.length;
  const events = [{ seq, time: Date.parse('2026-11-07T08:00:00.000Z') + seq, type: 'user/message',
    data: { id: messageId, role: 'user', source, content: request.content }, surfaceOp: 'append' }];
  f.business.ingestSession({ sessionId: native.sessionId, events });
  return { messageId, sourceId: eventId(native.sessionId, seq) };
}

test('a global goal links one native turn without creating work or changing the goal; exact repeats keep the core immutable', t => {
  const f = fixture(t); shown(f);
  const before = f.store.get('goals', f.goal.id), first = acquire(f);
  const core = f.store.get('goal_links', first.receipt.linkId), sequence = f.store.currentSequence();
  const second = acquire(f, { callId: 'second-original-call' });
  assert.deepEqual(first, second); assert.equal(f.store.currentSequence(), sequence);
  assert.deepEqual(f.store.get('goal_links', core.id), core); assert.equal(core.callId, 'goal-call-1');
  assert.deepEqual(f.store.get('goals', f.goal.id), before);
  assert.equal(first.bundle.links[0].goal.outcome, before.outcome);
  assert.equal(first.bundle.links[0].sources[0].content, f.source.content);
  assert.equal(JSON.stringify(first.receipt).includes(before.outcome), false);
  for (const kind of ['jobs', 'learning_pending', 'method_adoptions']) assert.equal(f.store.listAll(kind).length, 0);
  assert.throws(() => acquire(f, { selection: { ...selection(f), reason: '改换原选择' } }), code('goal_link_conflict'));
});

test('hidden, stale, foreign-scope and invented selections fail before an association is saved', t => {
  const f = fixture(t); shown(f);
  assert.throws(() => acquire(f, { sessionId: 'helper' }), code('goal_context_mismatch'));
  assert.throws(() => acquire(f, { contextMessageId: 'invented' }), code('goal_context_mismatch'));
  assert.throws(() => acquire(f, { selection: { ...selection(f), revision: 99 } }), code('goal_selection_changed'));
  assert.throws(() => acquire(f, { selection: { ...selection(f), sourceIds: ['not-displayed'] } }), code('invalid_goal_selection'));
  const row = f.store.get('context_snapshots', 'goal-snapshot:goal-main:1');
  f.store.save('context_snapshots', { ...row, material: { ...row.material, goals: [] } }, { expectedRevision: row.revision });
  assert.throws(() => acquire(f), code('goal_context_mismatch'));
  assert.equal(f.store.listAll('goal_links').length, 0);
  const scoped = fixture(t, { scope: { conversationId: 'different-discussion' } });
  assert.equal(scoped.goals.catalog({ sessionId: native.sessionId }).length, 0);
  assert.throws(() => bind(scoped), code('goal_scope_denied'));
});

test('full wrapped goal context capacity is checked transactionally, including the explanatory prefix', t => {
  const measure = fixture(t); shown(measure);
  const length = goalContextMessage(acquire(measure).bundle).content[0].text.length;
  const f = fixture(t); shown(f);
  const sequence = f.store.currentSequence();
  assert.throws(() => acquire(f, { maxCharacters: length - 1 }), code('goal_capacity'));
  assert.equal(f.store.currentSequence(), sequence); assert.equal(f.store.listAll('goal_links').length, 0);
  assert.equal(goalContextMessage(acquire(f, { maxCharacters: length }).bundle).content[0].text.length, length);
});

test('catalog and final current checks are read-only; withdrawn sources remove the frozen body without new writes', t => {
  const f = fixture(t); shown(f); const acquired = acquire(f);
  f.store.save('source_controls', { id: f.source.id, withdrawn: true });
  const sequence = f.store.currentSequence();
  assert.deepEqual(f.goals.catalog({ sessionId: native.sessionId }), []);
  assert.deepEqual(f.goals.currentBundle(native).links, []);
  assert.throws(() => f.goals.recordInput({ ...native, linkIds: [acquired.receipt.linkId], step: 2,
    requestIdentity: 'request-2', inputHash: 'a'.repeat(64) }), code('goal_unavailable'));
  assert.equal(f.store.currentSequence(), sequence);
  assert.equal(f.goals.details(f.goal.id).repairAllowed, true);
});

test('a browser discussion binds exact rpcId, original content and current input, never a session next message', t => {
  const f = fixture(t, { status: 'paused', userControl: { action: 'pause' } });
  const binding = bind(f);
  assert.equal(binding.created, true); assert.deepEqual(f.goals.catalog({ sessionId: native.sessionId }), []);
  const program = original(f, binding.binding.request, { kind: 'runtime-context', rpcId: 'goal-prompt-1' }, 'program');
  assert.deepEqual(f.goals.catalog({ sessionId: native.sessionId, inputMessageIds: [program.messageId] }), []);
  const wrong = original(f, { ...binding.binding.request, content: content('另一句话') }, undefined, 'wrong');
  assert.deepEqual(f.goals.catalog({ sessionId: native.sessionId, inputMessageIds: [wrong.messageId] }), []);
  const nonOwner = original(f, binding.binding.request, { kind: 'user', rpcId: binding.binding.requestId,
    principal: { kind: 'share-viewer', shareId: 'another-share', actor: { id: 'other-user' } } }, 'non-owner');
  assert.deepEqual(f.goals.catalog({ sessionId: native.sessionId, inputMessageIds: [nonOwner.messageId] }), []);
  const user = original(f, binding.binding.request);
  assert.deepEqual(f.goals.catalog({ sessionId: native.sessionId, inputMessageIds: ['later-message'] }), []);
  const entries = f.goals.catalog({ sessionId: native.sessionId, inputMessageIds: [user.messageId] });
  assert.equal(entries.length, 1); assert.equal(entries[0].explicitDiscussion, true);
  shown(f, [user.messageId]); const acquired = acquire(f, { selection: selection(f, entries[0]) });
  assert.equal(acquired.bundle.links[0].goal.status, 'paused');
  assert.equal(f.store.get('goals', f.goal.id).status, 'paused');
});

test('unknown prompt admission is preserved without resending, duplicate input identity cannot change text or intent', t => {
  const f = fixture(t); const first = bind(f);
  const unknown = f.goals.recordDiscussionAdmission({ bindingId: first.binding.id, state: 'unknown' });
  assert.equal(unknown.admission.state, 'unknown');
  assert.equal(bind(f).created, false);
  assert.throws(() => bind(f, 'discuss', { content: content('改成另一句话') }), code('discussion_identity_conflict'));
  assert.throws(() => f.goals.recordDiscussionAdmission({ bindingId: first.binding.id, state: 'accepted' }), code('discussion_admission_conflict'));
  assert.equal(f.store.listAll('events').length, 1);
  assert.equal(f.goals.details(f.goal.id).discussions[0].admission.state, 'unknown');
});

test('program-invalid goals expose only metadata and new user originals for explicit repair', t => {
  const f = fixture(t, { status: 'paused', title: '秘密旧标题', outcome: '秘密旧结果', useProhibited: true,
    sourceInvalidation: { kind: 'source_dependency', reason: 'source_changed' } });
  const detail = f.goals.details(f.goal.id);
  assert.equal(detail.repairAllowed, true); assert.equal(JSON.stringify(detail).includes('秘密旧'), false);
  assert.deepEqual(f.goals.catalog({ sessionId: native.sessionId }), []);
  const chosen = bind(f, 'repair'), user = original(f, chosen.binding.request);
  const entries = f.goals.catalog({ sessionId: native.sessionId, inputMessageIds: [user.messageId] });
  assert.equal(entries[0].repairOnly, true); assert.deepEqual(entries[0].sourceIds, [user.sourceId]);
  assert.equal(JSON.stringify(entries).includes('秘密旧'), false);
  shown(f, [user.messageId]); const acquired = acquire(f, { selection: selection(f, entries[0]) });
  assert.equal(JSON.stringify(acquired.bundle).includes('秘密旧'), false);
  assert.deepEqual(acquired.bundle.links[0].sources.map(row => row.id), [user.sourceId]);
  assert.equal(f.store.get('goals', f.goal.id).useProhibited, true);
  for (const patch of [{ withdrawn: true }, { deleted: true }, { sourceInvalidation: { kind: 'other' } }]) {
    const other = fixture(t, { useProhibited: true, sourceInvalidation: { kind: 'source_dependency' }, ...patch });
    assert.equal(other.goals.details(other.goal.id).repairAllowed, false);
    assert.throws(() => bind(other, 'repair'), code('goal_discussion_unavailable'));
  }
});

test('progress and relationship loss does not erase a valid definition; endpoint definition changes need review', t => {
  const f = fixture(t);
  const extra = f.store.save('events', { id: 'progress-source', role: 'assistant', content: '已有一份草稿',
    occurredAt: '2026-11-06T01:00:00.000Z' });
  const outer = f.store.save('goals', { ...f.goal, id: 'goal-outer', title: '长期结果' });
  const updated = f.store.save('goals', { ...f.goal, progress: { content: '已有草稿', sourceIds: [extra.id], dependencies: refs(extra) },
    relations: [{ type: 'supports', targetId: outer.id, sourceDefinitionVersion: 1, targetDefinitionVersion: 1,
      reason: '待确认的支持关系', sourceIds: [f.source.id], dependencies: refs(f.source) }] }, { expectedRevision: f.goal.revision });
  f.store.save('source_controls', { id: extra.id, useProhibited: true });
  const detail = f.goals.details(f.goal.id);
  assert.equal(detail.availability.allowed, true); assert.equal(detail.goal.progress, null);
  assert.equal(detail.goal.relations[0].state, 'current');
  f.store.save('goals', { ...outer, outcome: '新的外层定义', definitionVersion: 2 }, { expectedRevision: outer.revision });
  assert.equal(f.goals.details(updated.id).goal.relations[0].state, 'needs_review');
  assert.equal(f.goals.details(updated.id).goal.outcome, f.goal.outcome);
});

test('user decisions bind both versions, are idempotent and never create or cancel native work', t => {
  const f = fixture(t), request = { goalId: f.goal.id, expectedRevision: 1, definitionVersion: 1,
    action: 'pause', requestId: 'decision-one', userIdentity: 'browser:owner' };
  const paused = f.goals.decide(request);
  assert.equal(paused.goal.status, 'paused'); assert.equal(paused.decision.actor, 'user');
  assert.deepEqual(f.goals.decide(request), paused);
  assert.throws(() => f.goals.decide({ ...request, action: 'resume' }), code('decision_identity_conflict'));
  assert.throws(() => f.goals.decide({ ...request, requestId: 'stale' }), code('revision_conflict'));
  const closed = f.goals.decide({ ...request, requestId: 'close', expectedRevision: paused.goal.revision, action: 'close' });
  assert.equal(closed.goal.status, 'closed'); assert.match(closed.decision.meaning, /not-proof-of-achievement/);
  assert.equal(f.store.listAll('jobs').length, 0); assert.equal(f.store.listAll('learning_pending').length, 0);
  assert.equal(f.store.listAll('audit')[0].actor, 'trusted_user_goal_decision');
});

test('native outcome has its own record after delivery; replay does not revise the frozen contribution or goal', t => {
  const f = fixture(t);
  const understanding = f.store.save('understandings', { id: 'goal-basis', content: '可复核是当前需要', status: 'active',
    sourceIds: [f.source.id], dependencies: refs(f.source) });
  f.store.save('goals', { ...f.goal, dependencies: [...refs(f.source),
    { kind: 'understandings', id: understanding.id, revision: understanding.revision }] }, { expectedRevision: f.goal.revision });
  shown(f); const linked = acquire(f), core = f.store.get('goal_links', linked.receipt.linkId);
  f.goals.recordInput({ ...native, linkIds: [core.id], step: 2, requestIdentity: 'request-two', inputHash: 'b'.repeat(64) });
  const delivery = f.store.save('deliveries', { id: 'delivery-native', sessionId: native.sessionId,
    turn: native.turn, startSeq: native.startSeq, endEventId: 'end-original', kind: 'formal_reply' });
  const first = f.goals.settleTurn({ ...native, outcome: 'completed', deliveryId: delivery.id });
  assert.ok(first[0].createdSequence > delivery.createdSequence);
  assert.deepEqual(f.store.get('goal_links', core.id), core);
  assert.equal(f.store.get('goals', f.goal.id).status, 'tracking');
  assert.deepEqual(f.goals.settleTurn({ ...native, outcome: 'completed', deliveryId: delivery.id }), first);
  assert.throws(() => f.goals.settleTurn({ ...native, outcome: 'failed' }), code('goal_outcome_conflict'));
  assert.deepEqual(f.goals.currentBundle(native).links, []);
  const contribution = f.goals.details(f.goal.id).links[0].contribution;
  assert.equal(contribution.available, true); assert.equal(contribution.reason, core.selection.reason);
  assert.equal(contribution.definitionVersion, core.definitionVersion); assert.equal(contribution.claimType, 'inference');
  const current = f.store.get('goals', f.goal.id);
  f.goals.decide({ goalId: current.id, expectedRevision: current.revision, definitionVersion: current.definitionVersion,
    action: 'pause', requestId: 'pause-after-delivery', userIdentity: 'browser:owner' });
  assert.equal(f.goals.details(f.goal.id).links[0].contribution.available, true);
  const paused = f.store.get('goals', f.goal.id);
  f.store.save('goals', { ...paused, outcome: '后来重新定义的结果', definitionVersion: 2,
    dependencies: refs(f.source) }, { expectedRevision: paused.revision });
  assert.equal(f.goals.details(f.goal.id).links[0].contribution.definitionVersion, 1);
  f.store.save('understandings', { ...understanding, status: 'withdrawn' }, { expectedRevision: understanding.revision });
  const unavailable = f.goals.details(f.goal.id).links[0].contribution;
  assert.equal(unavailable.available, false); assert.equal(Object.hasOwn(unavailable, 'reason'), false);
  assert.equal(f.store.get('events', f.source.id).content, f.source.content);
  assert.deepEqual(f.store.get('goal_links', core.id), core);
});
