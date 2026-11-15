import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BusinessStore } from '../src/business.mjs';
import { UnderstandingService } from '../src/understandings.mjs';
import { collectContext } from '../src/context-material.mjs';

const code = value => error => error.code === value;
const sessionId = 'understanding-main';
const userIdentity = 'browser:fixture-owner';
const text = '  我只需要核对原文。\n不要把你的推测写成我的结论。  ';
const refs = source => [{ kind: 'events', id: source.id, revision: source.revision }];
function fixture(t, filename = ':memory:') {
  const business = new BusinessStore({ filename }); t.after(() => business.close());
  const store = business.storage, service = new UnderstandingService({ business });
  const source = store.save('events', { id: 'original-source', role: 'user', author: 'user',
    content: '原话需要保留，但未要求所有事情都先核对原文。', occurredAt: '2026-11-07T00:00:00Z',
    provenance: { kind: 'fixture-original', sourceRef: { sessionId: 'original-session', seq: 1 } } });
  const understanding = store.save('understandings', { id: 'understanding-previous', status: 'active',
    content: '每件事都要先核对原文。', claimType: 'inference', version: 1, previousId: null,
    scope: { conversationId: sessionId, topics: ['原文'] }, sourceIds: [source.id], dependencies: refs(source) });
  store.save('host_bindings', { id: sessionId, sessionId, role: 'main' });
  return { business, store, service, source, understanding };
}
function request(f, patch = {}) { return { sessionId, requestId: 'correct-one', understandingId: f.understanding.id,
  expectedRevision: f.understanding.revision, text, userIdentity, ...patch }; }
function decision(f, patch = {}) { return { sessionId, requestId: 'stop-one', understandingId: f.understanding.id,
  expectedRevision: f.understanding.revision, action: 'stop-understanding', userIdentity, ...patch }; }
function claim(f, patch = {}, messagesPatch) {
  const message = { id: 'native-correction', role: 'user', source: { kind: 'user', rpcId: 'correct-one' },
    content: [{ type: 'text', text }], ...patch };
  const events = [{ seq: 0, type: 'agent/inbox/spliced', time: 1794000000000,
    data: { target: 'next-step', start: 0, inserted: messagesPatch ?? [message] } },
    { seq: 1, type: 'turn/start', time: 1794000000001, data: { turn: 1 } }];
  const claims = f.business.ingestClaimedInputs({ sessionId, events, messages: messagesPatch ?? [message] });
  return { sessionId, events, claims, message };
}
function withdraw(f, patch = {}) { return decision(f, { requestId: 'withdraw-source', action: 'withdraw-source',
  sourceRef: { id: f.source.id, revision: f.source.revision, expectedControlRevision: null }, ...patch }); }

test('bounded owner-main views preserve original provenance, versions and visible scope without writes', t => {
  const f = fixture(t), before = f.store.currentSequence();
  const detail = f.service.details({ sessionId, understandingId: f.understanding.id });
  assert.deepEqual(detail.sources[0].provenance, f.source.provenance);
  assert.equal(detail.sources[0].content, f.source.content); assert.equal(detail.sources[0].expectedControlRevision, null);
  assert.equal(detail.understanding.claimType, 'inference'); assert.equal(detail.availability.allowed, true);
  assert.equal(f.service.list({ sessionId, limit: 1 }).total, 1); assert.equal(f.store.currentSequence(), before);
  assert.throws(() => f.service.list({ sessionId, limit: 101 }), code('invalid_pagination'));
  assert.throws(() => f.service.details({ sessionId: 'unbound', understandingId: f.understanding.id }), code('understanding_not_found'));
  f.store.save('host_bindings', { id: 'other-main', role: 'main' });
  assert.equal(f.service.list({ sessionId: 'other-main' }).total, 0);
  assert.throws(() => f.service.details({ sessionId: 'other-main', understandingId: f.understanding.id }), code('understanding_not_found'));
});

test('stop-understanding is versioned, immutable-original preserving and request-idempotent', t => {
  const f = fixture(t), before = f.store.get('events', f.source.id);
  const first = f.service.decide(decision(f));
  assert.equal(first.created, true); assert.equal(first.command.result.state, 'applied');
  assert.equal(first.command.result.before.status, 'active'); assert.equal(first.command.result.after.status, 'withdrawn');
  const seq = f.store.currentSequence();
  const repeat = f.service.decide(decision(f)); assert.equal(repeat.created, false);
  assert.deepEqual(repeat.command, first.command); assert.equal(f.store.currentSequence(), seq);
  assert.deepEqual(f.store.get('events', f.source.id), before); assert.equal(f.store.listAll('source_controls').length, 0);
  assert.throws(() => f.service.decide(decision(f, { expectedRevision: 2 })), code('understanding_identity_conflict'));
  assert.throws(() => f.service.decide(decision(f, { requestId: 'stale-new' })), code('revision_conflict'));
  assert.throws(() => f.service.decide({ ...decision(f), actor: 'system' }), code('invalid_understanding_request'));
});

test('withdraw-source invalidates dependents and notifies paused methods; goal local evidence and tracking remain distinct', t => {
  const f = fixture(t), second = f.store.save('events', { id: 'independent-source', role: 'user', content: '继续跟踪研究目标。' });
  const uref = { kind: 'understandings', id: f.understanding.id, revision: 1 };
  const dependent = f.store.save('understandings', { id: 'derived', status: 'active', content: '推导', version: 1,
    sourceIds: [second.id], dependencies: [...refs(second), uref] });
  f.store.save('methods', { id: 'method-one', title: '核对方法', status: 'trial', version: 1,
    sourceIds: [second.id], dependencies: [{ kind: 'understandings', id: dependent.id, revision: 1 }, ...refs(second)] });
  f.store.save('opportunities', { id: 'opportunity-one', status: 'proposed', sourceIds: [f.source.id], dependencies: refs(f.source) });
  const goal = id => ({ id, definitionVersion: 1, status: 'paused', userControl: { action: 'pause', actor: 'user' },
    title: id, outcome: '结果', sourceIds: [second.id], dependencies: refs(second),
    progress: { content: '', sourceIds: [], dependencies: [] }, relations: [] });
  f.store.save('goals', { ...goal('definition-goal'), dependencies: [...refs(second), uref] });
  f.store.save('goals', { ...goal('progress-goal'), progress: { content: '先前进展', sourceIds: [f.source.id], dependencies: refs(f.source) } });
  const target = f.store.save('goals', goal('target-goal'));
  f.store.save('goals', { ...goal('relation-goal'), relations: [{ type: 'supports', targetId: target.id,
    sourceDefinitionVersion: 1, targetDefinitionVersion: 1, sourceIds: [f.source.id], dependencies: refs(f.source) }] });
  const original = f.store.get('events', f.source.id), first = f.service.decide(withdraw(f));
  const result = first.command.result;
  assert.equal(result.control.useProhibited, true); assert.deepEqual(f.store.get('events', f.source.id), original);
  assert.equal(f.store.get('understandings', dependent.id).status, 'withdrawn');
  assert.equal(f.store.get('methods', 'method-one').status, 'paused');
  assert.equal(f.store.listAll('notifications').length, 1); assert.equal(f.store.listAll('notifications')[0].kind, 'method_paused');
  assert.equal(f.store.get('opportunities', 'opportunity-one').status, 'dismissed');
  for (const id of ['definition-goal', 'progress-goal', 'relation-goal']) {
    const row = f.store.get('goals', id); assert.equal(row.status, 'paused'); assert.equal(row.userControl.action, 'pause');
  }
  const impact = id => result.goalImpacts.find(row => row.id === id).after;
  assert.equal(impact('definition-goal').definitionAvailable, false);
  assert.equal(impact('progress-goal').definitionAvailable, true); assert.equal(impact('progress-goal').coverage.progressUnavailable, 1);
  assert.equal(impact('relation-goal').definitionAvailable, true); assert.equal(impact('relation-goal').relations[0].state, 'unavailable');
  const seq = f.store.currentSequence(); f.service.decide(withdraw(f)); assert.equal(f.store.currentSequence(), seq);
  assert.equal(f.service.details({ sessionId, understandingId: f.understanding.id }).sources[0].content, original.content);
});

test('source control rejects unrelated originals, stale control revision and foreign understanding scope without writes', t => {
  const f = fixture(t); const extra = f.store.save('events', { id: 'not-a-source', role: 'user', content: '无关' });
  const seq = f.store.currentSequence();
  assert.throws(() => f.service.decide(withdraw(f, { sourceRef: { id: extra.id, revision: 1, expectedControlRevision: null } })), code('source_scope_denied'));
  assert.throws(() => f.service.decide(withdraw(f, { sourceRef: { id: f.source.id, revision: 1, expectedControlRevision: 99 } })), code('revision_conflict'));
  assert.throws(() => f.service.decide(withdraw(f, { sourceRef: { id: f.source.id, revision: 1 } })), code('invalid_source_control'));
  assert.equal(f.store.currentSequence(), seq);
});

test('browser binding/admission alone cannot replace knowledge; exact native claim preserves literal correction and independent version', t => {
  const f = fixture(t), bound = f.service.bindCorrection(request(f));
  assert.equal(bound.created, true); assert.equal(bound.command.result, null);
  f.service.recordCorrectionAdmission({ commandId: bound.command.id, state: 'accepted' });
  assert.equal(f.store.get('understandings', f.understanding.id).status, 'active');
  assert.equal(f.store.listAll('events').length, 1);
  const native = claim(f), input = { sessionId, claims: native.claims, events: native.events };
  const applied = f.service.applyClaimedCorrections(input)[0];
  assert.equal(applied.result.state, 'applied'); assert.equal(applied.result.after.content, text);
  assert.equal(applied.result.after.claimType, 'user_statement'); assert.equal(applied.result.after.claimTypeCheck.reason, 'exact_user_message');
  assert.deepEqual(applied.result.after.scope, f.understanding.scope); assert.equal(applied.result.after.version, 2);
  assert.equal(applied.result.after.previousId, f.understanding.id);
  assert.deepEqual(applied.result.after.sourceIds, [native.claims[0].sourceId]);
  assert.deepEqual(applied.result.after.dependencies, [{ kind: 'events', id: native.claims[0].sourceId, revision: 1 }]);
  assert.equal(Object.hasOwn(applied.result.after, 'learnedFromRunId'), false);
  assert.equal(f.store.get('understandings', f.understanding.id).status, 'superseded');
  const seq = f.store.currentSequence(); assert.deepEqual(f.service.applyClaimedCorrections(input), []);
  assert.equal(f.service.bindCorrection(request(f)).created, false); assert.equal(f.store.currentSequence(), seq);
  const detail = f.service.details({ sessionId, understandingId: applied.result.after.id });
  assert.equal(detail.historyTotal, 2); assert.equal(detail.history[1].understanding.content, f.understanding.content);
  const material = collectContext(f.store, { sessionId, turn: 1 });
  assert.equal(material.understandings.length, 1); assert.equal(material.understandings[0].content, text);
});

test('correction of withdrawn knowledge uses only new eligible user original, never old source dependency', t => {
  const f = fixture(t); f.service.decide(withdraw(f));
  const old = f.store.get('understandings', f.understanding.id);
  f.service.bindCorrection(request(f, { expectedRevision: old.revision }));
  const native = claim(f), applied = f.service.applyClaimedCorrections(native)[0];
  assert.equal(applied.result.state, 'applied'); assert.equal(f.store.get('source_controls', f.source.id).useProhibited, true);
  assert.equal(f.service.details({ sessionId, understandingId: applied.result.after.id }).availability.allowed, true);
  assert.equal(collectContext(f.store, { sessionId, turn: 1 }).understandings[0].content, text);
});

test('unknown admission survives cold read without retry; actual owner original can later establish the only replacement', t => {
  const filename = join(mkdtempSync(join(tmpdir(), 'understanding-cold-')), 'business.sqlite');
  const f = fixture(t, filename), bound = f.service.bindCorrection(request(f));
  f.service.recordCorrectionAdmission({ commandId: bound.command.id, state: 'unknown' });
  const cold = new BusinessStore({ filename }); t.after(() => cold.close());
  const service = new UnderstandingService({ business: cold });
  const duplicate = service.bindCorrection(request(f)); assert.equal(duplicate.created, false);
  assert.equal(duplicate.command.admission.state, 'unknown'); assert.equal(duplicate.command.result, null);
  assert.throws(() => service.recordCorrectionAdmission({ commandId: bound.command.id, state: 'accepted' }), code('correction_admission_conflict'));
  assert.throws(() => service.bindCorrection(request(f, { text: '悄悄换原话' })), code('understanding_identity_conflict'));
  const native = claim(f); const applied = service.applyClaimedCorrections(native)[0];
  assert.equal(applied.admission.state, 'unknown'); assert.equal(applied.result.state, 'applied');
  assert.deepEqual(f.store.get('understanding_commands', bound.command.id).result, applied.result);
});

test('stale version and edited original retain terminal failure and original input without rewriting knowledge', t => {
  for (const changedText of [false, true]) {
    const f = fixture(t), bound = f.service.bindCorrection(request(f));
    if (!changedText) f.service.decide(decision(f));
    const before = f.store.get('understandings', f.understanding.id);
    const native = claim(f, changedText ? { content: [{ type: 'text', text: '编辑了队列原话' }] } : {});
    const applied = f.service.applyClaimedCorrections(native)[0];
    assert.equal(applied.result.state, 'failed');
    assert.equal(applied.result.error.code, changedText ? 'correction_source_mismatch' : 'revision_conflict');
    assert.deepEqual(f.store.get('understandings', f.understanding.id), before);
    assert.equal(f.store.listAll('understandings').length, 1);
    assert.equal(f.store.get('events', native.claims[0].sourceId).message.content[0].text, native.message.content[0].text);
    const seq = f.store.currentSequence(); assert.deepEqual(f.service.applyClaimedCorrections(native), []);
    assert.equal(f.service.bindCorrection(request(f)).created, false); assert.equal(f.store.currentSequence(), seq);
    assert.equal(f.store.get('understanding_commands', bound.command.id).result.state, 'failed');
  }
});

test('native claim validation rejects wrong message identity, session, role, principal and undurable bytes', t => {
  for (const change of [
    native => { native.sessionId = 'another-main'; },
    native => { native.claims[0].messageId = 'another-message'; },
    native => { native.claims[0].inboxRef.sha256 = '0'.repeat(64); },
    native => { native.events[0].data.inserted[0].role = 'assistant'; },
    native => { native.events[0].data.inserted[0].source.principal = { kind: 'share-viewer' }; },
    native => { native.events = []; },
    native => { native.claims.push(structuredClone(native.claims[0])); },
  ]) {
    const f = fixture(t); f.service.bindCorrection(request(f)); const native = claim(f);
    f.store.save('host_bindings', { id: 'another-main', role: 'main' }); change(native);
    assert.throws(() => f.service.applyClaimedCorrections(native), code('invalid_correction_claims'));
    assert.equal(f.store.get('understandings', f.understanding.id).status, 'active');
  }
});

test('unmatched rpcId never applies; duplicate actual owner originals with same rpcId persist an honest failure', t => {
  const f = fixture(t); f.service.bindCorrection(request(f));
  const other = claim(f, { source: { kind: 'user', rpcId: 'different-request' } });
  assert.deepEqual(f.service.applyClaimedCorrections(other), []);
  assert.equal(f.store.get('understandings', f.understanding.id).status, 'active');
  const g = fixture(t); g.service.bindCorrection(request(g));
  const make = id => ({ id, role: 'user', source: { kind: 'user', rpcId: 'correct-one' }, content: [{ type: 'text', text }] });
  const native = claim(g, {}, [make('first'), make('second')]);
  const result = g.service.applyClaimedCorrections(native)[0].result;
  assert.equal(result.state, 'failed'); assert.equal(result.error.code, 'correction_source_mismatch');
  assert.equal(result.claimedSourceIds.length, 2); assert.equal(g.store.listAll('understandings').length, 1);
});

test('correction transaction rollback leaves original knowledge and native input intact if downstream save fails', t => {
  const f = fixture(t); f.service.bindCorrection(request(f)); const native = claim(f);
  const save = f.store.save.bind(f.store); let failOnce = true;
  f.store.save = (kind, row, options) => {
    if (kind === 'understandings' && row.previousId === f.understanding.id && failOnce) { failOnce = false; throw new Error('fixture storage failure'); }
    return save(kind, row, options);
  };
  assert.throws(() => f.service.applyClaimedCorrections(native), /fixture storage failure/);
  assert.deepEqual(f.store.get('understandings', f.understanding.id), f.understanding);
  assert.equal(f.store.get('events', native.claims[0].sourceId).message.content[0].text, text);
  assert.equal(f.store.listAll('understanding_commands')[0].result, null);
});


// The combined order matters: source invalidation changes historical U1 from
// superseded to withdrawn, while U2 correctly does not depend on U1 or S1.
function correctedThenOldSourceWithdrawn(t) {
  const f = fixture(t);
  f.service.bindCorrection(request(f));
  const native = claim(f);
  const corrected = f.service.applyClaimedCorrections(native)[0].result;
  f.service.decide(withdraw(f, { expectedRevision: corrected.retired.revision }));
  const historical = f.store.get('understandings', f.understanding.id);
  assert.equal(historical.status, 'withdrawn');
  assert.deepEqual(f.store.get('understandings', corrected.after.id), corrected.after);
  assert.deepEqual(f.store.get('events', f.source.id), f.source);
  return { ...f, native, corrected, historical };
}

test('withdrawing an old source never restores the correction control on an already replaced understanding', t => {
  const f = correctedThenOldSourceWithdrawn(t);
  const detail = f.service.details({ sessionId, understandingId: f.historical.id });
  assert.equal(detail.sources[0].available, false);
  assert.equal(detail.sources[0].content, f.source.content, 'Old original remains inspectable');
  assert.deepEqual(detail.successors.map(row => row.id), [f.corrected.after.id]);
  assert.equal(detail.controls.correctionAllowed, false, 'Historical withdrawal must not reopen a replaced version');
  assert.equal(f.service.list({ sessionId }).items.find(item => item.understanding.id === f.historical.id).controls.correctionAllowed, false);
  assert.equal(f.service.details({ sessionId, understandingId: f.corrected.after.id }).controls.correctionAllowed, true);
  assert.deepEqual(collectContext(f.store, { sessionId, turn: 2 }).understandings.map(row => row.id), [f.corrected.after.id]);
});

test('corrected U1 then withdrawn S1 cannot bind a second replacement even at the current U1 record revision', t => {
  const f = correctedThenOldSourceWithdrawn(t), sequence = f.store.currentSequence();
  assert.throws(() => f.service.bindCorrection(request(f, { requestId: 'historical-rebind',
    expectedRevision: f.historical.revision, text: '不应从历史版本分叉。' })), code('understanding_unavailable'));
  assert.equal(f.store.currentSequence(), sequence);
  assert.equal(f.store.listAll('understanding_commands').length, 2, 'No new native prompt binding is created');
  assert.deepEqual(f.store.get('understandings', f.corrected.after.id), f.corrected.after);
  assert.deepEqual(f.store.get('events', f.source.id), f.source);
});

test('a previously saved historical correction binding fails at native claiming and retains one eligible successor', t => {
  const f = correctedThenOldSourceWithdrawn(t);
  // This is the exact command shape the old implementation could have saved
  // after withdrawal. It models pre-upgrade durable data, not a public bypass.
  const pending = f.service.savedCommand({ ...request(f, { requestId: 'historical-saved-binding',
    expectedRevision: f.historical.revision, text: '这条新原话仍应保留，但不能重新修订 U1。' }), action: 'correct' });
  const message = { id: 'historical-new-native-original', role: 'user',
    source: { kind: 'user', rpcId: pending.requestId }, content: [{ type: 'text', text: pending.request.text }] };
  const events = [...f.native.events, { seq: 2, type: 'agent/inbox/spliced', time: 1794000000002,
    data: { target: 'next-step', start: 0, inserted: [message] } }];
  const claims = f.business.ingestClaimedInputs({ sessionId, events, messages: [message] });
  const result = f.service.applyClaimedCorrections({ sessionId, claims, events })[0].result;
  assert.equal(result.state, 'failed', 'Existing successor must be checked again at actual native claiming');
  assert.equal(result.error.code, 'understanding_unavailable');
  assert.equal(f.store.get('events', claims[0].sourceId).message.content[0].text, pending.request.text);
  assert.deepEqual(f.store.get('understandings', f.historical.id), f.historical);
  assert.deepEqual(f.store.get('understandings', f.corrected.after.id), f.corrected.after);
  assert.equal(f.store.listAll('understandings').length, 2);
  assert.deepEqual(collectContext(f.store, { sessionId, turn: 2 }).understandings.map(row => row.id), [f.corrected.after.id]);
  const sequence = f.store.currentSequence();
  assert.deepEqual(f.service.applyClaimedCorrections({ sessionId, claims, events }), []);
  assert.equal(f.store.currentSequence(), sequence);
});

test('management without past binding never grants internal correction application',t=>{
  const business=new BusinessStore({filename:':memory:'});t.after(()=>business.close());
  const service=new UnderstandingService({business});
  const source=business.storage.save('events',{id:'blank-source',role:'user',content:'原话'});
  const u=business.storage.save('understandings',{id:'blank-u',version:1,status:'active',scope:{},content:'推断',claimType:'inference',
    sourceIds:[source.id],dependencies:[{kind:'events',id:source.id,revision:source.revision}]});
  assert.equal(service.details({sessionId:'blank',understandingId:u.id}).understanding.content,'推断');
  assert.equal(service.bindCorrection({sessionId:'blank',understandingId:u.id,expectedRevision:u.revision,
    requestId:'explicit-first',text:'新的逐字表述',userIdentity}).created,true);
  assert.throws(()=>service.applyClaimedCorrections({sessionId:'blank',claims:[],events:[]}),code('understanding_session_denied'));
  business.storage.save('host_bindings',{id:'blank',role:'learning'});
  assert.throws(()=>service.applyClaimedCorrections({sessionId:'blank',claims:[],events:[]}),code('understanding_session_denied'));
  assert.equal(business.storage.get('understandings',u.id).revision,u.revision);
});
