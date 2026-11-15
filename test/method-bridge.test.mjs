import assert from 'node:assert/strict';
import test from 'node:test';
import { BusinessStore } from '../src/business.mjs';
import { SessionBridge } from '../src/session-bridge.mjs';
import { METHOD_CONTEXT, METHOD_TOOL, methodContextMessage, hasSuccessfulMethodReceipt } from '../src/method-context.mjs';
import { hash } from '../src/evidence.mjs';

function fixture(t) {
  const business = new BusinessStore({ filename: ':memory:' }), events = [];
  const session = { id: 'method-main', surface: { nodes: [] }, snapshotEvents: () => structuredClone(events), eventAt: seq => events[seq] };
  session.append = (type, data, extra = {}) => {
    const event = { seq: events.length, type, data, time: 1793957945000 + events.length, ...extra };
    events.push(event);
    if (extra.surfaceOp === 'append') session.surface.nodes.push(event.seq);
    else if (extra.surfaceOp?.op === 'replace') session.surface.nodes.splice(session.surface.nodes.indexOf(extra.surfaceOp.startSeq), 1, event.seq);
    return event;
  };
  session.deriveMessages = () => session.surface.nodes.map(seq => events[seq].data.message || events[seq].data);
  const bridge = new SessionBridge({ business, sessions: { get: () => session, flush: async () => true }, persistence: {}, logger: { warn() {} } });
  t.after(() => bridge.close());
  const source = business.storage.save('events', { id: 'method-original', role: 'user', content: '先查原件。' });
  const method = business.storage.save('methods', { id: 'first-method', version: 1, status: 'trial', maxTrialUses: 1,
    title: '核查原件', guidance: 'METHOD_GUIDANCE_SENTINEL：先读取原件，再解释。', appliesTo: '解释项目', doesNotApplyTo: '无原件讨论',
    sourceIds: [source.id], dependencies: [{ kind: 'events', id: source.id, revision: source.revision }] });
  const input = { id: 'human-one', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '解释项目' }] };
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [input] });
  session.append('turn/start', { turn: 1 });
  const signal = new AbortController().signal;
  const prepare = (turn, step, messages = []) => bridge.prepare({ agent: { session }, turn, step, messages, signal }, { kind: 'enter', messages });
  const admit = result => result.messages.forEach(message => session.append('user/message', message, { surfaceOp: 'append' }));
  const guard = async messages => { for await (const _ of bridge.guardStream({ sessionId: session.id, messages, signal }, () => (async function* () { yield 'sent'; })())) {} };
  return { business, store: business.storage, bridge, methods: bridge.methods, session, events, method, source, input, prepare, admit, guard };
}

async function select(f, { result = true, resultError = false } = {}) {
  const prepared = await f.prepare(1, 1, [f.input]);
  f.session.append('step/start', { turn: 1, step: 1 });
  f.admit(prepared);
  const snapshot = f.store.listAll('context_snapshots')[0], shown = snapshot.material.methods[0];
  const selection = { id: shown.id, revision: shown.revision, contentHash: shown.contentHash, reason: '解释本地项目需核原件', sourceIds: shown.sourceIds };
  const callId = 'select-one', args = JSON.stringify({ selections: [selection] });
  f.session.append('assistant/message', { turn: 1, step: 1, message: { id: 'assistant-select', role: 'assistant',
    source: { kind: 'model' }, content: [{ type: 'tool-call', name: METHOD_TOOL, id: callId, arguments: args }] } }, { surfaceOp: 'append' });
  f.session.append('tool/call', { turn: 1, step: 1, name: METHOD_TOOL, callId, arguments: args });
  const reserved = f.methods.reserve({ sessionId: f.session.id, turn: 1, startSeq: 1, callId,
    contextSnapshotId: snapshot.id, contextMessageId: snapshot.contextMessageId, selections: [selection] });
  if (result) f.session.append('tool/result', { turn: 1, step: 1, message: { id: 'select-result', role: 'tool',
    source: { kind: 'tool', callId }, toolCallId: callId, isError: resultError,
    content: [{ type: 'text', text: JSON.stringify(reserved.receipt) }] } }, { surfaceOp: 'append' });
  f.session.append('step/end', { turn: 1, step: 1 });
  return reserved;
}

test('successful native receipt admits full guidance on the next step, including the final reserved trial', async t => {
  const f = fixture(t), reserved = await select(f);
  const catalog = f.store.listAll('context_snapshots')[0].material;
  assert.equal(JSON.stringify(catalog).includes(f.method.guidance), false);
  const next = await f.prepare(1, 2, [methodContextMessage(reserved.bundle)]);
  assert.equal(next.messages.filter(row => row.source.kind === METHOD_CONTEXT).length, 1);
  f.session.append('step/start', { turn: 1, step: 2 }); f.admit(next);
  await f.guard(f.session.deriveMessages());
  const inputs = f.store.listAll('method_inputs');
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].inputHash, hash(next.messages.find(row => row.source.kind === METHOD_CONTEXT)));
  assert.match(inputs[0].evidence, /actual-send-requires-native-request-evidence/);
  assert.equal(f.store.get('methods', f.method.id).status, 'trial');
  assert.equal(f.methods.details(f.method.id).usage.remaining, 0);
});

test('failed or missing native result cannot smuggle deferred guidance into the next model step', async t => {
  for (const options of [{ result: false }, { resultError: true }]) {
    const f = fixture(t), reserved = await select(f, options);
    const deferred = methodContextMessage(reserved.bundle);
    const next = await f.prepare(1, 2, [deferred]);
    assert.equal(next.messages.some(row => row.source.kind === METHOD_CONTEXT), false);
    f.session.append('step/start', { turn: 1, step: 2 }); f.admit(next);
    await assert.rejects(f.guard([...f.session.deriveMessages(), deferred]), error => error.code === 'ARCFOLD_METHOD_CONTEXT_CHANGED');
    await f.guard(f.session.deriveMessages());
    assert.equal(f.store.listAll('method_inputs').length, 0);
    assert.equal(f.methods.details(f.method.id).usage.trialUses, 1);
  }
});

test('withdrawal before stream consumption prevents dispatch and next preparation removes only plugin guidance', async t => {
  const f = fixture(t), reserved = await select(f);
  const next = await f.prepare(1, 2, [methodContextMessage(reserved.bundle)]);
  f.session.append('step/start', { turn: 1, step: 2 }); f.admit(next);
  const oldGuidance = f.events.find(event => event.type === 'user/message' && event.data.source.kind === METHOD_CONTEXT);
  const human = { id: 'human-original-two', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'HUMAN_ORIGINAL_SENTINEL' }] };
  f.session.append('user/message', human, { surfaceOp: 'append' });
  f.store.save('source_controls', { id: f.source.id, useProhibited: true });
  let calls = 0;
  await assert.rejects(async () => { for await (const _ of f.bridge.guardStream({ sessionId: f.session.id,
    messages: f.session.deriveMessages() }, () => { calls++; return (async function* () {})(); })) {} });
  assert.equal(calls, 0); assert.equal(f.store.listAll('method_inputs').length, 0);
  const refreshed = await f.prepare(1, 3);
  const visible = [...f.session.deriveMessages(), ...refreshed.messages];
  assert.equal(visible.some(row => row.source.kind === METHOD_CONTEXT), false);
  assert.equal(JSON.stringify(visible).includes(f.method.guidance), false);
  assert.ok(visible.some(row => row.id === human.id));
  assert.ok(f.events[oldGuidance.seq].data.content[0].text.includes(f.method.guidance));
});

test('native terminal settles usage without treating a reply or interrupted result as effective method use', async t => {
  const f = fixture(t), reserved = await select(f);
  const next = await f.prepare(1, 2, [methodContextMessage(reserved.bundle)]);
  f.session.append('step/start', { turn: 1, step: 2 }); f.admit(next);
  f.session.append('step/end', { turn: 1, step: 2 });
  f.session.append('turn/end', { turn: 1, reason: { kind: 'error' } });
  await f.bridge.reconcile(f.session);
  const adoption = f.store.get('method_adoptions', reserved.receipt.adoptionIds[0]);
  assert.equal(adoption.state, 'settled'); assert.equal(adoption.outcome, 'failed');
  assert.equal(adoption.effectiveness, 'not_assessed');
  assert.equal(f.methods.details(f.method.id).usage.trialUses, 1);
  assert.equal(f.methods.details(f.method.id).method.status, 'paused');
  f.session.append('turn/start', { turn: 2 });
  const newInput = { ...f.input, id: 'human-next' };
  f.session.append('agent/inbox/spliced', { inserted: [newInput] });
  const later = await f.prepare(2, 1, [newInput, methodContextMessage(reserved.bundle)]);
  assert.equal([...f.session.deriveMessages(), ...later.messages].some(row => row.source.kind === METHOD_CONTEXT), false);
});

test('native receipt matching rejects forged producer, duplicate result and another native step', async t => {
  const f = fixture(t), reserved = await select(f);
  const adoption = f.store.get('method_adoptions', reserved.receipt.adoptionIds[0]);
  assert.equal(hasSuccessfulMethodReceipt(f.events, adoption), true);
  const changed = f.session.snapshotEvents(), result = changed.find(row => row.type === 'tool/result');
  result.data.message.source.kind = 'program';
  assert.equal(hasSuccessfulMethodReceipt(changed, adoption), false);
  result.data.message.source.kind = 'tool'; result.data.step++;
  assert.equal(hasSuccessfulMethodReceipt(changed, adoption), false);
  result.data.step--;
  assert.equal(hasSuccessfulMethodReceipt([...changed, { ...result, seq: 100 }], adoption), false);
});

test('closed native writer falls back only to persisted bytes and preserves unresolved use until a real end is readable', async t => {
  const f = fixture(t), reserved = await select(f);
  const withoutEnd = f.session.snapshotEvents();
  f.session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: 'disposed' } });
  const durableEnd = f.session.snapshotEvents();
  let persisted = withoutEnd, opens = 0, closed = 0;
  f.bridge.sessions.flush = async () => { throw new Error('flush on a closed handle'); };
  f.bridge.persistence.open = async (id, mode) => {
    assert.equal(id, f.session.id); assert.equal(mode, 'read'); opens++;
    return { read: async () => ({ events: structuredClone(persisted) }), close: async () => { closed++; } };
  };
  await f.bridge.reconcile(f.session);
  const adoptionId = reserved.receipt.adoptionIds[0];
  assert.equal(f.store.get('method_adoptions', adoptionId).state, 'reserved');
  assert.equal(f.store.listAll('bridge_failures').length, 1);
  assert.equal(f.methods.details(f.method.id).pendingAdoptionCount, 1);
  persisted = durableEnd;
  await f.bridge.reconcile(f.session);
  assert.equal(f.store.get('method_adoptions', adoptionId).state, 'settled');
  assert.equal(f.store.get('method_adoptions', adoptionId).outcome, 'cancelled');
  assert.equal(f.methods.details(f.method.id).usage.trialUses, 1);
  assert.equal(f.store.listAll('deliveries').length, 0);
  const sequence = f.store.currentSequence();
  await f.bridge.reconcile(f.session);
  assert.equal(f.store.currentSequence(), sequence);
  assert.equal(opens, 3); assert.equal(closed, 3);
});

test('shutdown read failure preserves both failures and closes its read handle before business teardown', async t => {
  const f = fixture(t), reserved = await select(f);
  const end = f.session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: 'disposed' } });
  let readClosed = false, atClose;
  f.bridge.sessions.flush = async () => { throw new Error('flush on a closed handle'); };
  f.bridge.persistence.open = async (_id, mode) => {
    assert.equal(mode, 'read');
    return { read: async () => { throw new Error('read handle closed during host disposal'); },
      close: async () => { readClosed = true; } };
  };
  const close = f.business.close.bind(f.business);
  f.business.close = () => {
    if (!f.store.closed) atClose = { readClosed, failures: f.store.listAll('bridge_failures'),
      adoption: f.store.get('method_adoptions', reserved.receipt.adoptionIds[0]) };
    close();
  };
  f.bridge.observe(f.session, end);
  await f.bridge.close();
  assert.equal(atClose.readClosed, true); assert.equal(atClose.failures.length, 2);
  assert.equal(atClose.adoption.state, 'reserved');
  assert.equal(f.store.closed, true);
});

test('readable history cannot replace the initial live writer barrier for a new main binding', async t => {
  const f = fixture(t); let reads = 0;
  f.bridge.sessions.flush = async () => false;
  f.bridge.persistence.open = async () => { reads++; return { read: async () => ({ events: f.events }), close: async () => {} }; };
  await assert.rejects(f.prepare(1, 1, [f.input]), /participating durable session writer/);
  assert.equal(reads, 0); assert.equal(f.bridge.isBound(f.session.id), false);
  assert.equal(f.store.listAll('method_adoptions').length, 0);
});
