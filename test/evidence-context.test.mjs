import test from 'node:test';
import assert from 'node:assert/strict';
import { BusinessStore, eventId } from '../src/business.mjs';
import { MethodService, usageForVersion } from '../src/methods.mjs';
import { GoalService } from '../src/goals.mjs';
import { LearningService } from '../src/learning.mjs';
import { digest } from '../src/learning-contracts.mjs';
import { collectContext, contextMessage, refreshContext } from '../src/context-material.mjs';
import { evidenceProvenance, sourceText } from '../src/evidence.mjs';
import { methodContextMessage } from '../src/method-context.mjs';

const sessionId = 'evidence-main', position = { sessionId, turn: 2, startSeq: 100 };
const replayState = { response: { provider: 'fixture', responseId: 'original-response' },
  blocks: [{ type: 'reasoning', thinkingSignature: 'opaque-transport-only-'.repeat(2200) }] };
const code = value => error => error.code === value;

function fixture(t, text = '  原话与回答保持空白。\nreplayState 是正文里的普通文字。\n') {
  const business = new BusinessStore({ filename: ':memory:' }); t.after(() => business.close());
  const message = (id, role, source, text) => ({ id, role, source, content: [{ type: 'text', text }] });
  const events = [
    { type: 'turn/start', data: { turn: 1 } }, { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'user/message', data: message('human', 'user', { kind: 'user' }, '请保留原文和出处。'), surfaceOp: 'append' },
    { type: 'assistant/message', data: { turn: 1, step: 1, stream: [], message: message('answer', 'assistant',
      { kind: 'model', provider: 'fixture', model: 'fixture', replayState }, text) }, surfaceOp: 'append' },
    { type: 'step/end', data: { turn: 1, step: 1 } }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ].map((event, seq) => ({ ...event, seq, time: 1800000000000 + seq }));
  business.ingestSession({ sessionId, events });
  const store = business.storage, source = store.get('events', eventId(sessionId, 3));
  const sources = [store.get('events', eventId(sessionId, 2)), source];
  const evidence = { sourceIds: sources.map(row => row.id),
    dependencies: sources.map(row => ({ kind: 'events', id: row.id, revision: row.revision })) };
  store.save('host_bindings', { id: sessionId, sessionId, role: 'main' });
  store.save('understandings', { id: 'understanding', content: '回答是助手的解释，不能当作用户确认。',
    status: 'active', claimType: 'inference', ...evidence });
  const method = store.save('methods', { id: 'method', title: '保留原文', guidance: '完整阅读原文再解释，不改变来源身份。',
    appliesTo: '有原文时', doesNotApplyTo: '无原文时', status: 'trial', version: 1, maxTrialUses: 3, ...evidence });
  store.save('goals', { id: 'goal', title: '可回查的解释', outcome: '解释有完整原文依据', status: 'tracking',
    definitionVersion: 1, claimType: 'inference', progress: { content: '', sourceIds: [], dependencies: [] }, relations: [], ...evidence });
  const settled = business.settleTurn({ sessionId, turn: 1, events });
  const material = collectContext(store, { sessionId, turn: 2 });
  const snapshot = store.save('context_snapshots', { id: 'snapshot', sessionId, turn: 2,
    contextMessageId: contextMessage(material).id, material });
  const native = { ...position, contextSnapshotId: snapshot.id, contextMessageId: snapshot.contextMessageId };
  return { business, store, sources, source, method, events, material, native, settled,
    methods: new MethodService({ business }), goals: new GoalService({ business }), learning: new LearningService({ business }) };
}
function acquire(f, maxCharacters = 24000) {
  const { id, revision, contentHash, sourceIds } = f.material.methods[0];
  return f.methods.reserve({ ...f.native, callId: 'method-call', maxCharacters,
    selections: [{ id, revision, contentHash, sourceIds, reason: '当前需要核对原文。' }] });
}
function link(f, maxCharacters = 24000) {
  const { id, revision, definitionVersion, contentHash, sourceIds } = f.material.goals[0];
  return f.goals.link({ ...f.native, callId: 'goal-call', maxCharacters,
    selection: { id, revision, definitionVersion, contentHash, sourceIds, reason: '本次解释需有来源。' } });
}
function assertEvidence(f, source) {
  const original = f.store.get('events', source.id);
  assert.equal(source.content, sourceText(original));
  assert.equal(source.role, original.role);
  assert.deepEqual(source.provenance.sourceRef, original.provenance.sourceRef);
  assert.equal(Object.hasOwn(source.provenance.source, 'replayState'), false);
}

test('only native model replay metadata is omitted; authority, references and other provenance are preserved', () => {
  const original = { kind: 'dsh_session', sourceRef: { sessionId, seq: 3, sha256: 'original-event-hash' },
    source: { kind: 'model', provider: 'fixture', model: 'fixture', principal: 'not-a-human', replayState },
    instructionAuthority: 'none' };
  const frozen = structuredClone(original), view = evidenceProvenance(original);
  const expected = structuredClone(original); delete expected.source.replayState;
  assert.deepEqual(view, expected); assert.deepEqual(original, frozen);
  for (const source of [{ kind: 'user', principal: 'program', replayState: 'literal user metadata' },
    { kind: 'tool', callId: 'call', replayState: 'unrelated field' }]) {
    const other = { ...original, source };
    assert.deepEqual(evidenceProvenance(other), other);
  }
  const legacy = { kind: 'legacy3_original', originalProvenance: original, userEndorsement: 'not-established' };
  assert.deepEqual(evidenceProvenance(legacy), legacy);
});

test('short complete method evidence with large native replay fits, keeps originals, and still respects withdrawal', t => {
  const f = fixture(t), original = structuredClone(f.source), result = acquire(f);
  assert.ok(methodContextMessage(result.bundle).content[0].text.length < 24000);
  assert.equal(result.bundle.methods[0].method.guidance, f.method.guidance);
  for (const source of result.bundle.methods[0].sources) assertEvidence(f, source);
  assert.deepEqual(f.store.get('events', original.id), original);
  f.business.ingestSession({ sessionId, events: f.events });
  assert.deepEqual(f.store.get('events', original.id), original, 'native originals still replay and ingest identically');
  assert.equal(usageForVersion(f.store, f.method).trialUses, 1);
  f.store.save('source_controls', { id: f.source.id, withdrawn: true });
  assert.throws(() => f.methods.assertCurrent({ ...position, adoptionId: result.receipt.adoptionIds[0] }), code('method_unavailable'));
});

test('large actual original text still exceeds capacity and does not consume a trial', t => {
  const f = fixture(t, '原始正文不能被截断。'.repeat(3000));
  assert.throws(() => acquire(f), code('method_capacity'));
  assert.equal(usageForVersion(f.store, f.method).trialUses, 0);
  assert.equal(f.store.listAll('method_adoptions').length, 0);
});

test('understanding collection and refresh project a copy while preserving the old snapshot and source identity', t => {
  const f = fixture(t);
  assert.equal(f.material.understandings.length, 1);
  assert.equal(f.material.coverage.omitted.capacity, 0);
  const legacy = structuredClone(f.material);
  for (const source of legacy.understandings[0].evidence) source.provenance = f.store.get('events', source.id).provenance;
  const before = structuredClone(legacy), refreshed = refreshContext(f.store, legacy);
  for (const source of refreshed.understandings[0].evidence) assertEvidence(f, source);
  assert.deepEqual(legacy, before);
  assert.equal(refreshed.cutoffSequence, legacy.cutoffSequence);
  assert.notEqual(contextMessage(legacy).id, contextMessage(refreshed).id);
});

test('new and legacy frozen goal links expose compact evidence without changing the original link hash', t => {
  const f = fixture(t), current = link(f);
  for (const source of current.bundle.links[0].sources) assertEvidence(f, source);
  const old = fixture(t), fullEntry = old.goals.fullEntry;
  // Emulate the old writer before first save, not a mutation of an existing link.
  old.goals.fullEntry = function(...args) {
    const entry = fullEntry.apply(this, args);
    for (const source of entry.sources) source.provenance = old.store.get('events', source.id).provenance;
    return entry;
  };
  const prior = link(old, 180000); old.goals.fullEntry = fullEntry;
  const original = old.store.get('goal_links', prior.receipt.linkId);
  const projected = old.goals.currentBundle(position);
  assert.equal(projected.links.length, 1);
  for (const source of projected.links[0].sources) assertEvidence(old, source);
  assert.deepEqual(old.store.get('goal_links', original.id), original);
  assert.doesNotThrow(() => old.goals.assertCore(original));
  const tampered = structuredClone(original); delete tampered.bundle.sources[1].provenance.source.replayState;
  assert.throws(() => old.goals.assertCore(tampered), code('goal_link_changed'));
});

test('new learning input preserves literal content and author without duplicating native transport state', t => {
  const f = fixture(t), learning = new LearningService({ business: f.business, maxCharacters: 24000 });
  const original = structuredClone(f.source), input = learning.prepare(f.settled.learning.id);
  for (const source of input.material.sources) assertEvidence(f, source);
  assert.equal(input.inputText.includes('opaque-transport-only-'), false);
  assert.equal(input.material.sources.find(row => row.id === f.source.id).userEndorsement, 'not_established_by_this_record');
  assert.equal(input.versions.find(row => row.kind === 'events' && row.id === original.id).hash, digest(original));
  assert.deepEqual(f.store.get('events', original.id), original);
});

test('already frozen learning bytes and native run message remain unchanged across prepare', t => {
  const f = fixture(t), save = f.store.save.bind(f.store);
  f.store.save = (kind, row, ...args) => {
    if (kind === 'learning_inputs') {
      row = structuredClone(row);
      for (const source of row.material.sources) source.provenance = f.store.get('events', source.id).provenance;
      row.inputText = JSON.stringify(row.material); row.inputHash = digest(row.inputText); row.materialHash = digest(row.material);
    }
    return save(kind, row, ...args);
  };
  const legacy = f.learning.prepare(f.settled.learning.id); f.store.save = save;
  const run = f.store.save('learning_runs', { id: legacy.id, message: { content: [{ type: 'text', text: legacy.inputText }] }, inputHash: legacy.inputHash });
  assert.ok(legacy.inputText.includes('opaque-transport-only-'));
  assert.deepEqual(f.learning.prepare(legacy.id), legacy);
  assert.deepEqual(f.store.get('learning_runs', run.id), run);
  assert.doesNotThrow(() => f.learning.assertVersions(legacy));
});
