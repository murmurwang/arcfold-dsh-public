import assert from 'node:assert/strict';
import test from 'node:test';
import { BusinessStore } from '../src/business.mjs';
import { SessionBridge } from '../src/session-bridge.mjs';
import { GOAL_CONTEXT, GOAL_TOOL, goalContextMessage, hasSuccessfulGoalReceipt } from '../src/goal-context.mjs';
import { hash } from '../src/evidence.mjs';

function fixture(t) {
  const business = new BusinessStore({ filename: ':memory:' }), events = [];
  const session = { id: 'goal-main', surface: { nodes: [] }, snapshotEvents: () => structuredClone(events), eventAt: seq => events[seq] };
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
  const source = business.storage.save('events', { id: 'goal-original', role: 'user', content: 'GOAL_ORIGINAL：逐步形成一套能解释实际系统的作品。' });
  const goal = business.storage.save('goals', { id: 'long-term-goal', definitionVersion: 1, status: 'tracking',
    title: '完成系统研究作品', outcome: '能从原件讲清楚系统如何工作', scope: {}, userControl: null,
    sourceIds: [source.id], dependencies: [{ kind: 'events', id: source.id, revision: source.revision }],
    progress: { content: '', sourceIds: [], dependencies: [] }, relations: [] });
  const input = { id: 'human-one', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '这次只核对一个入口。' }] };
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [input] });
  session.append('turn/start', { turn: 1 });
  const signal = new AbortController().signal;
  const prepare = (turn, step, messages = []) => bridge.prepare({ agent: { session }, turn, step, messages, signal }, { kind: 'enter', messages });
  const admit = result => result.messages.forEach(message => session.append('user/message', message, { surfaceOp: 'append' }));
  return { business, store: business.storage, bridge, goals: bridge.goals, session, events, goal, source, input, prepare, admit, signal };
}

async function select(f, { result = true, resultError = false } = {}) {
  const prepared = await f.prepare(1, 1, [f.input]);
  f.session.append('step/start', { turn: 1, step: 1 }); f.admit(prepared);
  const snapshot = f.store.listAll('context_snapshots')[0], shown = snapshot.material.goals[0];
  const selection = { id: shown.id, revision: shown.revision, definitionVersion: shown.definitionVersion,
    contentHash: shown.contentHash, reason: '核清一个实际入口可为长期作品提供证据', sourceIds: shown.sourceIds };
  const callId = 'link-one', args = JSON.stringify({ selection });
  f.session.append('assistant/message', { turn: 1, step: 1, message: { id: 'assistant-link', role: 'assistant',
    source: { kind: 'model' }, content: [{ type: 'tool-call', name: GOAL_TOOL, id: callId, arguments: args }] } }, { surfaceOp: 'append' });
  f.session.append('tool/call', { turn: 1, step: 1, name: GOAL_TOOL, callId, arguments: args });
  const linked = f.goals.link({ sessionId: f.session.id, turn: 1, startSeq: 1, callId,
    contextSnapshotId: snapshot.id, contextMessageId: snapshot.contextMessageId, selection, maxCharacters: 24000 });
  if (result) f.session.append('tool/result', { turn: 1, step: 1, message: { id: 'link-result', role: 'tool',
    source: { kind: 'tool', callId }, toolCallId: callId, isError: resultError,
    content: [{ type: 'text', text: JSON.stringify(linked.receipt) }] } }, { surfaceOp: 'append' });
  f.session.append('step/end', { turn: 1, step: 1 });
  return linked;
}

function chooseDiscussion(f, mode = 'discuss') {
  f.input.source.rpcId = 'browser-goal-discussion';
  f.input.content = [{ type: 'text', text: mode === 'repair' ? '只依这次新原话重新澄清目标。' : '明确选回暂停的目标，只讨论，不恢复。' }];
  const goal = mode === 'repair' ? f.store.get('goals', f.goal.id) : f.goals.decide({ goalId: f.goal.id,
    expectedRevision: f.goal.revision, definitionVersion: 1, action: 'pause', requestId: 'pause-before-discussion', userIdentity: 'browser:owner' }).goal;
  f.goals.bindDiscussion({ sessionId: f.session.id, goalId: f.goal.id, expectedRevision: goal.revision,
    definitionVersion: goal.definitionVersion, mode, requestId: f.input.source.rpcId,
    content: f.input.content, userIdentity: 'browser:owner' });
}

test('explicit paused-goal discussion prepares from the real inbox and sends only after native admission', async t => {
  const f = fixture(t); chooseDiscussion(f);
  const prepared = await f.prepare(1, 1, [f.input]);
  const snapshot = f.store.listAll('context_snapshots')[0];
  assert.equal(snapshot.material.goals.length, 1);
  assert.equal(snapshot.material.goals[0].explicitDiscussion, true);
  assert.equal(snapshot.material.goals[0].status, 'paused');
  const original = f.store.get('events', snapshot.claimedInputs[0].sourceId);
  assert.equal(original.provenance.sourceRef.type, 'agent/inbox/spliced');
  assert.equal(f.events.some(event => event.type === 'user/message'), false);
  f.session.append('step/start', { turn: 1, step: 1 });
  let calls = 0;
  const send = messages => (async () => { for await (const _ of f.bridge.guardStream({ sessionId: f.session.id,
    messages, signal: f.signal }, () => { calls++; return (async function* () {})(); })) {} })();
  await assert.rejects(send(prepared.messages), error => error.code === 'ARCFOLD_CONTEXT_CHANGED');
  assert.equal(calls, 0);
  f.admit(prepared);
  await send(f.session.deriveMessages()); assert.equal(calls, 1);
  const cutoff = snapshot.material.cutoffSequence;
  const refreshed = await f.prepare(1, 2);
  assert.equal(f.store.listAll('context_snapshots')[0].material.cutoffSequence, cutoff);
  assert.equal(f.store.listAll('events').filter(row => row.message?.id === f.input.id).length, 1);
  assert.equal(f.store.get('events', original.id).provenance.sourceRef.type, 'agent/inbox/spliced');
  assert.equal(f.store.get('goals', f.goal.id).status, 'paused');
  assert.equal(refreshed.kind, 'enter');
});

test('claimed input cannot be sent with changed native identity, text, missing request input or a withdrawn original', async t => {
  const f = fixture(t); chooseDiscussion(f);
  const prepared = await f.prepare(1, 1, [f.input]);
  f.session.append('step/start', { turn: 1, step: 1 }); f.admit(prepared);
  const options = { sessionId: f.session.id, messages: f.session.deriveMessages() };
  f.bridge.assertRequestCurrent(options);
  for (const modify of [
    message => { message.source.rpcId = 'another-browser-send'; },
    message => { message.source.principal = { kind: 'agent', id: 'untrusted' }; },
    message => { message.content[0].text = '另一个要求'; },
  ]) {
    const changed = f.session.snapshotEvents();
    modify(changed.find(event => event.type === 'user/message' && event.data.id === f.input.id).data);
    assert.throws(() => f.bridge.assertRequestCurrent(options, changed), error => error.code === 'ARCFOLD_CONTEXT_CHANGED');
  }
  assert.throws(() => f.bridge.assertRequestCurrent({ ...options, messages: options.messages.filter(row => row.id !== f.input.id) }),
    error => error.code === 'ARCFOLD_CONTEXT_CHANGED');
  const sourceId = f.store.listAll('context_snapshots')[0].claimedInputs[0].sourceId;
  f.store.save('source_controls', { id: sourceId, withdrawn: true });
  assert.throws(() => f.bridge.assertRequestCurrent(options), error => error.code === 'ARCFOLD_CONTEXT_CHANGED');
});

test('repair uses one new inbox original through formal admission and full goal evidence without reviving old content', async t => {
  const f = fixture(t);
  f.store.save('source_controls', { id: f.source.id, withdrawn: true }); f.goals.reconcile();
  chooseDiscussion(f, 'repair');
  const linked = await select(f), snapshot = f.store.listAll('context_snapshots')[0];
  const sourceId = snapshot.claimedInputs[0].sourceId;
  assert.equal(snapshot.material.goals[0].repairOnly, true);
  assert.deepEqual(snapshot.material.goals[0].sourceIds, [sourceId]);
  assert.deepEqual(linked.bundle.links[0].sources.map(row => row.id), [sourceId]);
  assert.equal(JSON.stringify(linked.bundle).includes(f.source.content), false);
  const prepared = await f.prepare(1, 2, [goalContextMessage(linked.bundle)]);
  f.session.append('step/start', { turn: 1, step: 2 }); f.admit(prepared);
  f.bridge.assertRequestCurrent({ sessionId: f.session.id, messages: f.session.deriveMessages() });
  assert.equal(f.store.listAll('events').filter(row => row.message?.id === f.input.id).length, 1);
  assert.equal(f.store.listAll('context_snapshots')[0].material.cutoffSequence, snapshot.material.cutoffSequence);
});

test('successful native goal link supplies full original evidence and records the actual prepared message', async t => {
  const f = fixture(t), linked = await select(f);
  assert.equal(JSON.stringify(f.store.listAll('context_snapshots')[0].material.goals).includes(f.source.content), false);
  const next = await f.prepare(1, 2, [goalContextMessage(linked.bundle)]);
  const full = next.messages.filter(row => row.source.kind === GOAL_CONTEXT);
  assert.equal(full.length, 1); assert.ok(full[0].content[0].text.includes(f.source.content));
  f.session.append('step/start', { turn: 1, step: 2 }); f.admit(next);
  let calls = 0;
  for await (const _ of f.bridge.guardStream({ sessionId: f.session.id, messages: f.session.deriveMessages(), signal: f.signal },
    () => { calls++; return (async function* () { yield 'sent'; })(); })) {}
  assert.equal(calls, 1);
  const inputs = f.store.listAll('goal_inputs'); assert.equal(inputs.length, 1);
  assert.equal(inputs[0].inputHash, hash(full[0]));
  assert.equal(f.store.get('goals', f.goal.id).status, 'tracking');
  assert.equal(f.store.listAll('goal_decisions').length, 0);
});

test('missing or failed goal result cannot turn deferred content into adopted background', async t => {
  for (const options of [{ result: false }, { resultError: true }]) {
    const f = fixture(t), linked = await select(f, options), deferred = goalContextMessage(linked.bundle);
    const next = await f.prepare(1, 2, [deferred]);
    assert.equal(next.messages.some(row => row.source.kind === GOAL_CONTEXT), false);
    f.session.append('step/start', { turn: 1, step: 2 }); f.admit(next);
    assert.throws(() => f.bridge.assertGoalRequestCurrent({ sessionId: f.session.id,
      messages: [...f.session.deriveMessages(), deferred] }), error => error.code === 'ARCFOLD_GOAL_CONTEXT_CHANGED');
    assert.equal(f.store.listAll('goal_inputs').length, 0);
  }
});

test('a user pause prevents stale goal dispatch and removes only plugin background while preserving the link', async t => {
  const f = fixture(t), linked = await select(f), linkBefore = f.store.get('goal_links', linked.receipt.linkId);
  const next = await f.prepare(1, 2, [goalContextMessage(linked.bundle)]);
  f.session.append('step/start', { turn: 1, step: 2 }); f.admit(next);
  f.goals.decide({ goalId: f.goal.id, expectedRevision: f.goal.revision, definitionVersion: 1,
    action: 'pause', requestId: 'pause-current-goal', userIdentity: 'browser:fixture-owner' });
  let calls = 0;
  await assert.rejects(async () => { for await (const _ of f.bridge.guardStream({ sessionId: f.session.id,
    messages: f.session.deriveMessages(), signal: f.signal }, () => { calls++; return (async function* () {})(); })) {} });
  assert.equal(calls, 0); assert.equal(f.store.listAll('goal_inputs').length, 0);
  const refreshed = await f.prepare(1, 3);
  assert.equal([...f.session.deriveMessages(), ...refreshed.messages].some(row => row.source.kind === GOAL_CONTEXT), false);
  assert.ok(f.session.deriveMessages().some(row => row.id === f.input.id));
  assert.deepEqual(f.store.get('goal_links', linked.receipt.linkId), linkBefore);
  f.session.append('turn/end', { turn: 1, reason: { kind: 'error' } });
  await f.bridge.reconcile(f.session);
  const outcome = f.store.get('goal_link_outcomes', linked.receipt.linkId);
  assert.equal(outcome.outcome, 'failed'); assert.equal(outcome.deliveryId, null);
  assert.equal(outcome.contributionEffect, 'not_assessed');
  assert.equal(f.store.get('goals', f.goal.id).status, 'paused');
});

test('goal receipt cannot detach from exact selection, native producer or unique result', async t => {
  const f = fixture(t), linked = await select(f), link = f.store.get('goal_links', linked.receipt.linkId);
  assert.equal(hasSuccessfulGoalReceipt(f.events, link), true);
  const changed = f.session.snapshotEvents(), call = changed.find(row => row.type === 'tool/call');
  call.data.arguments = JSON.stringify({ selection: { ...link.selection, reason: 'a different claim' } });
  assert.equal(hasSuccessfulGoalReceipt(changed, link), false);
  call.data.arguments = JSON.stringify({ selection: link.selection });
  const result = changed.find(row => row.type === 'tool/result'); result.data.message.source.kind = 'program';
  assert.equal(hasSuccessfulGoalReceipt(changed, link), false);
  result.data.message.source.kind = 'tool';
  assert.equal(hasSuccessfulGoalReceipt([...changed, { ...result, seq: 100 }], link), false);
});
