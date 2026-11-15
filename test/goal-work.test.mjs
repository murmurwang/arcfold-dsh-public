import test from 'node:test';
import assert from 'node:assert/strict';
import { BusinessStore } from '../src/business.mjs';
import { GoalService } from '../src/goals.mjs';
import { saveGoalTransition, applyGoalChanges } from '../src/learning-goals.mjs';
import { captureWorks, workId, workState, workRelation, workViews, linkWork,
  automaticWorkContext, workContextCurrent, frozenGoalCurrent } from '../src/goal-work.mjs';
import { collectContext, refreshContext } from '../src/context-material.mjs';
import { assertResumeInput } from '../src/goal-work-control.mjs';

function fixture(t, { capture = true } = {}) {
  const business = new BusinessStore({ filename: ':memory:' }), store = business.storage;
  t.after(() => business.close());
  const sessionId = 'work-main', nativeGoalId = 'native-work', events = [];
  const add = (type, data, extra = {}) => {
    const event = { seq: events.length, time: Date.parse('2026-11-08T00:00:00Z') + events.length,
      type, data, ...extra }; events.push(event); return event;
  };
  const native = { id: nativeGoalId, revision: 1, objective: 'First authorized task A', phase: 'active', maxGoalRounds: 8 };
  add('command/run', { commandId: 'command-create', name: 'goal', args: native.objective, source: { kind: 'user' } });
  add('goal/change', { operation: 'create', goal: native, roundsStarted: 0 });
  add('command/done', { commandId: 'command-create', kind: 'success' });
  const sync = () => { business.ingestSession({ sessionId, events }); captureWorks(store, sessionId, events); };
  business.ingestSession({ sessionId, events });
  if (capture) sync();
  const source = store.save('events', { id: 'long-original', role: 'user', content: '我希望形成可以长期复用的研究成果。',
    occurredAt: '2026-11-07T00:00:00Z', provenance: { kind: 'fixture_owner_original' } });
  const goal = saveGoalTransition(store, null, { id: 'long-goal', title: '研究成果', outcome: '形成可复用依据',
    definitionVersion: 1, scope: {}, status: 'tracking', userControl: null, sourceIds: [source.id],
    dependencies: [{ kind: 'events', id: source.id, revision: source.revision }],
    progress: { content: '', sourceIds: [], dependencies: [] }, relations: [] },
    { commandId: 'first-goal', pendingId: 'fixture', reason: 'fixture-definition' });
  store.save('host_bindings', { id: sessionId, role: 'main' });
  const goals = new GoalService({ business });
  const id = workId(sessionId, nativeGoalId);
  const associate = () => linkWork(store, { work: store.get('goal_works', id), goal: store.get('goals', goal.id),
    state: workState(store, id), reason: '这次工作提供可复用的研究依据', sourceIds: [source.id],
    expectedRelationId: null, origin: { kind: 'fixture_model_selection', id: 'selection' } });
  return { business, store, sessionId, nativeGoalId, events, add, native, sync, source, goal, goals, id, associate };
}
test('work capture preserves exact successful command originals, is idempotent, and creates no long-term goal', t => {
  const f = fixture(t), work = f.store.get('goal_works', f.id);
  assert.equal(f.store.listAll('goal_works').length, 1);
  assert.equal(f.store.listAll('goals').length, 1); // only the explicitly seeded fixture goal
  assert.equal(f.store.listAll('goal_work_links').length, 0);
  const original = f.store.get('events', work.sourceIds[0]);
  assert.equal(original.content, f.events[0].data.args);
  assert.equal(original.message, undefined);
  assert.equal(original.provenance.kind, 'native_user_command');
  const seq = f.store.currentSequence(); f.sync();
  assert.equal(f.store.currentSequence(), seq);
  assert.equal(f.store.listAll('jobs').length, 0);
});
test('an unfinished command is visible as unverified execution and cannot acquire a verified work identity', t => {
  const f = fixture(t, { capture: false });
  captureWorks(f.store, f.sessionId, f.events.slice(0, 2));
  assert.equal(f.store.get('goal_works', f.id), null);
  const shown = workViews(f.store, f.sessionId, { ...f.native, activation: 'disarmed', roundsStarted: 0 })[0];
  assert.equal(shown.provenance, 'legacy-unverified');
  assert.equal(shown.canResume, false);
});
test('late progress keeps frozen goal context and the existing association; definition and relations do not', t => {
  const f = fixture(t); f.associate();
  const work = f.store.get('goal_works', f.id);
  const material = collectContext(f.store, { sessionId: f.sessionId, turn: 1 });
  material.workGoalContext = automaticWorkContext(f.goals, work, workState(f.store, f.id), material.cutoffSequence);
  const before = structuredClone(material), previous = f.store.get('goals', f.goal.id);
  saveGoalTransition(f.store, previous, { ...previous, progress: {
    content: '新进展供下一轮读取', sourceIds: [f.source.id], dependencies: previous.dependencies } },
  { commandId: 'new-progress', pendingId: 'learn-progress', reason: 'learn_update' });
  assert.deepEqual(refreshContext(f.store, material), before, 'the actual frozen input is neither replaced nor rejected');
  assert.equal(workContextCurrent(f.store, material.workGoalContext), true);
  const next = automaticWorkContext(f.goals, work, workState(f.store, f.id), f.store.currentSequence());
  assert.equal(next.goal.progress.content, '新进展供下一轮读取');
  assert.equal(workRelation(f.store, f.id).id, material.workGoalContext.relationId);
  saveGoalTransition(f.store, null, { ...f.goal, id: 'another', title: '另一研究方向' },
    { commandId: 'related', pendingId: null, reason: 'fixture-definition' });
  const current = f.store.get('goals', f.goal.id);
  saveGoalTransition(f.store, current, { ...current, relations: [{ type: 'supports', targetId: 'another',
    reason: 'relationship changed', sourceIds: [f.source.id], dependencies: current.dependencies }] },
  { commandId: 'relationship-change', pendingId: 'learn-relations', reason: 'learn_update' });
  assert.equal(frozenGoalCurrent(f.store, before.workGoalContext.goal), false);
  assert.equal(workContextCurrent(f.store, before.workGoalContext), false);
});
test('cold first capture never attaches an old successful selection for A to the later native objective B', t => {
  const f = fixture(t, { capture: false });
  const start = f.add('turn/start', { turn: 1 });
  f.add('user/message', { id: 'native-round', role: 'user', source: {
    kind: 'goal', goalId: f.nativeGoalId, revision: 1, round: 1 }, content: [{ type: 'text', text: 'A' }] });
  const shown = f.goals.catalog({ sessionId: f.sessionId })[0];
  f.store.save('context_snapshots', { id: 'snapshot', sessionId: f.sessionId, turn: 1, contextMessageId: 'context',
    material: { cutoffSequence: f.store.currentSequence(), inputMessageIds: [], goals: [shown] } });
  const selection = { id: shown.id, revision: shown.revision, definitionVersion: shown.definitionVersion,
    contentHash: shown.contentHash, reason: 'A supports the long goal', sourceIds: shown.sourceIds };
  const args = JSON.stringify({ selection });
  f.add('tool/call', { name: 'arcfold_link_goal', callId: 'select-a', turn: 1, step: 1, arguments: args });
  const linked = f.goals.link({ sessionId: f.sessionId, turn: 1, startSeq: start.seq, callId: 'select-a',
    contextSnapshotId: 'snapshot', contextMessageId: 'context', selection });
  f.add('tool/result', { turn: 1, step: 1, message: { id: 'selected', role: 'tool', source: { kind: 'tool', callId: 'select-a' },
    toolCallId: 'select-a', isError: false, content: [{ type: 'text', text: JSON.stringify(linked.receipt) }] } });
  f.add('goal/change', { operation: 'edit', goal: { ...f.native, revision: 2, objective: 'Different task B' }, roundsStarted: 1 });
  f.sync();
  assert.equal(workState(f.store, f.id).objective, 'Different task B');
  assert.equal(workRelation(f.store, f.id), null);
  assert.equal(f.store.listAll('goal_links').length, 1, 'the original selection is retained for history');
});
test('Learn associates only its explicit displayed work; wrong, duplicate and late selections roll back', t => {
  const f = fixture(t), work = f.store.get('goal_works', f.id);
  const make = () => ({ operation: 'update', targetId: f.goal.id, clientRef: '', title: f.goal.title,
    outcome: f.goal.outcome, scope: 'global', sourceIds: [f.source.id], understandingIds: [],
    progress: { content: '', sourceIds: [] }, relations: [], controlProposal: 'none',
    workLinks: [{ workId: work.id, reason: '本次工作为目标留下依据', sourceIds: [f.source.id] }] });
  const material = { sessionId: f.sessionId, inputEventIds: [], existingGoals: [f.goal],
    goalWorks: [{ ...workState(f.store, work.id), id: work.id, sessionId: f.sessionId, relationId: null }] };
  const apply = (rows, pendingId) => f.store.transaction(() => applyGoalChanges(f.store, { rows, material, pendingId,
    assertTarget: (kind, id) => f.store.get(kind, id), understandingRefs: () => [],
    assertSources: ids => ids.map(id => { const row = f.store.get('events', id); assert.ok(row); return { kind: 'events', id, revision: row.revision }; }) }));
  const wrong = make(); wrong.workLinks[0].workId = 'invented';
  const before = f.store.currentSequence(); assert.throws(() => apply([wrong], 'bad'), /工作联系/);
  assert.equal(f.store.currentSequence(), before);
  const duplicate = make(); duplicate.workLinks.push({ ...duplicate.workLinks[0] });
  assert.throws(() => apply([duplicate], 'duplicate'), /只能联系一个/);
  assert.equal(f.store.currentSequence(), before);
  apply([make()], 'valid'); const relation = workRelation(f.store, work.id);
  assert.equal(relation.goalId, f.goal.id);
  assert.equal(relation.authority, 'model-association-only; no-new-work-or-control');
  assert.throws(() => apply([make()], 'late'), /更新的工作联系/);
  assert.equal(workRelation(f.store, work.id).id, relation.id);
});
test('natural tracking interpretation uses actual current owner input and never changes native work', t => {
  const f = fixture(t); f.associate();
  const message = { id: 'owner-stop-tracking', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '不再追求这项研究了。' }] };
  const inbox = f.add('agent/inbox/spliced', { inserted: [message] });
  f.business.ingestSession({ sessionId: f.sessionId, events: f.events });
  const source = f.business.ingestClaimedInputs({ sessionId: f.sessionId, events: f.events, messages: [message] })[0];
  const material = { sessionId: f.sessionId, inputEventIds: [source.sourceId], existingGoals: [f.goal], goalWorks: [] };
  const row = { operation: 'update', targetId: f.goal.id, clientRef: '', title: f.goal.title, outcome: f.goal.outcome,
    scope: 'global', sourceIds: [source.sourceId], understandingIds: [], progress: { content: '', sourceIds: [] },
    relations: [], controlProposal: 'close' };
  const beforeEvents = structuredClone(f.events);
  const apply = (material, command, value = row) => f.store.transaction(() => applyGoalChanges(f.store, {
    material, rows: [value], pendingId: command, assertTarget: (kind, id) => f.store.get(kind, id),
    understandingRefs: () => [], assertSources: ids => ids.map(id => ({ kind: 'events', id, revision: f.store.get('events', id).revision })) }));
  assert.throws(() => apply({ ...material, inputEventIds: [] }, 'auto-no-control'), /真实owner/);
  apply(material, 'close');
  assert.equal(f.store.get('goals', f.goal.id).status, 'closed');
  assert.equal(f.store.get('goals', f.goal.id).trackingInterpretation.claimType, 'inference');
  assert.equal(f.goals.catalog({ sessionId: f.sessionId }).length, 0);
  assert.equal(automaticWorkContext(f.goals, f.store.get('goal_works', f.id), workState(f.store, f.id), f.store.currentSequence()), null);
  assert.deepEqual(f.events, beforeEvents, 'tracking interpretation cannot pause or resume native work');
  const closed = f.store.get('goals', f.goal.id);
  saveGoalTransition(f.store, closed, { ...closed, userControl: { action: 'close', decisionId: 'old-control',
    nativeBoundary: { sessionId: f.sessionId, throughSeq: inbox.seq } } },
    { commandId: 'explicit-control', pendingId: null, reason: 'close', actor: 'trusted_user_goal_decision' });
  apply(material, 'queued-resume', { ...row, controlProposal: 'resume' });
  assert.equal(f.store.get('goals', f.goal.id).status, 'closed');
  assert.equal(f.store.get('goals', f.goal.id).trackingInterpretation.applied, false);
  const fresh = { ...message, id: 'new-owner-resume', content: [{ type: 'text', text: '现在重新继续关注这项长期方向。' }] };
  f.add('agent/inbox/spliced', { inserted: [fresh] });
  f.business.ingestSession({ sessionId: f.sessionId, events: f.events });
  const freshSource = f.business.ingestClaimedInputs({ sessionId: f.sessionId, events: f.events, messages: [fresh] })[0];
  const beforeResume = structuredClone(f.events);
  apply({ ...material, inputEventIds: [freshSource.sourceId] }, 'fresh-resume',
    { ...row, sourceIds: [freshSource.sourceId], controlProposal: 'resume' });
  const resumed = f.store.get('goals', f.goal.id);
  assert.equal(resumed.status, 'tracking');
  assert.equal(resumed.trackingInterpretation.applied, true);
  assert.equal(resumed.userControl.decisionId, 'old-control', 'the explicit historical decision is preserved');
  assert.deepEqual(f.events, beforeResume, 'background tracking resume never calls native goals.resume');
});
test('resume input checks the original inbox arrival after pause or block, not later claim time', () => {
  const message = { id: 'owner', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '继续这件事' }] };
  const goal = { id: 'native' };
  const events = [
    { seq: 0, type: 'agent/inbox/spliced', data: { inserted: [message] } },
    { seq: 1, type: 'goal/change', data: { operation: 'pause', goal } },
    { seq: 2, type: 'turn/start', data: { turn: 2 } },
    { seq: 3, type: 'user/message', data: message },
  ];
  assert.throws(() => assertResumeInput({ events, startSeq: 2, callSeq: 4, goal }), /received after/);
  const fresh = [{ seq: 0, type: 'goal/change', data: { operation: 'pause', goal } },
    { seq: 1, type: 'agent/inbox/spliced', data: { inserted: [message] } }, ...events.slice(2)];
  assert.equal(assertResumeInput({ events: fresh, startSeq: 2, callSeq: 4, goal }).input.data.id, 'owner');
  fresh[0].data.operation = 'block';
  assert.equal(assertResumeInput({ events: fresh, startSeq: 2, callSeq: 4, goal }).input.data.id, 'owner');
  fresh[0].seq = 2.5;
  assert.throws(() => assertResumeInput({ events: fresh, startSeq: 2, callSeq: 4, goal }), /received after/);
  assert.throws(() => assertResumeInput({ events: fresh.filter(e => e.type !== 'user/message'), startSeq: 2, callSeq: 4, goal }), /received after/);
});

test('work controls keep one durable decision, reconcile unknown without replay, and reject stale or withdrawn resume', async t => {
  const f = fixture(t), agent = { id: f.sessionId, session: {
    snapshotEvents: () => structuredClone(f.events), get seq() { return f.events.length; },
  } };
  let current = { ...f.native, activation: 'armed', roundsStarted: 0 }, calls = 0;
  let flush = async () => false;
  const native = { get: () => current, pause() {
    calls++; current = { ...current, revision: current.revision + 1, phase: 'paused', activation: 'disarmed' };
    f.add('goal/change', { operation: 'pause', goal: current, roundsStarted: 0 }); return current;
  }, resume() {
    calls++; current = { ...current, revision: current.revision + 1, phase: 'active', activation: 'armed' };
    f.add('goal/change', { operation: 'resume', goal: current, roundsStarted: 0 }); return current;
  } };
  f.goals.nativeRoot = { get: name => ({ agents: { get: () => agent }, goals: native,
    sessions: { flush: session => flush(session) } })[name] };
  const request = { sessionId: f.sessionId, workId: f.id, nativeGoalId: f.nativeGoalId,
    nativeRevision: 1, requestId: 'pause-once', userIdentity: 'browser:owner', action: 'pause', agent };
  const first = await f.goals.controlWork(request);
  assert.equal(first.state, 'unknown'); assert.equal(calls, 1);
  flush = async () => true;
  const observed = await f.goals.controlWork(request);
  assert.equal(observed.state, 'applied'); assert.equal(calls, 1);
  await f.goals.controlWork(request); assert.equal(calls, 1);
  await assert.rejects(f.goals.controlWork({ ...request, action: 'resume' }), /同一工作决定/);
  await assert.rejects(f.goals.controlWork({ ...request, requestId: 'stale' }), /执行已变化/);
  const sourceId = f.store.get('goal_works', f.id).sourceIds[0];
  f.store.save('source_controls', { id: sourceId, withdrawn: true });
  await assert.rejects(f.goals.controlWork({ ...request, action: 'resume', requestId: 'withdrawn',
    nativeRevision: current.revision }), /来源已经变化或撤回|原话来源/);
  assert.equal(calls, 1);
});
test('two concurrent identical work controls share the observed native operation and never perform it twice', async t => {
  const f = fixture(t), gate = Promise.withResolvers();
  const agent = { id: f.sessionId, session: { snapshotEvents: () => structuredClone(f.events),
    get seq() { return f.events.length; } } };
  let native = { ...f.native, activation: 'armed', roundsStarted: 0 }, calls = 0;
  const services = { agents: { get: () => agent }, sessions: { flush: () => gate.promise },
    goals: { get: () => native, pause() { calls++; native = { ...native, phase: 'paused', activation: 'disarmed', revision: 2 };
      f.add('goal/change', { operation: 'pause', goal: native, roundsStarted: 0 }); return native; } } };
  f.goals.nativeRoot = { get: name => services[name] };
  const request = { sessionId: f.sessionId, workId: f.id, nativeGoalId: f.nativeGoalId,
    nativeRevision: 1, requestId: 'same', userIdentity: 'browser:owner', action: 'pause', agent };
  const a = f.goals.controlWork(request), b = f.goals.controlWork(request);
  gate.resolve(true);
  const results = await Promise.all([a, b]);
  assert.deepEqual(results.map(row => row.state), ['applied', 'applied']);
  assert.equal(calls, 1); assert.equal(f.store.listAll('goal_work_controls').length, 1);
});

test('a repeated same-goal association keeps the proven frozen body; replacing its target retires it', t => {
  const f = fixture(t); f.associate();
  const work = f.store.get('goal_works', f.id), state = workState(f.store, f.id);
  const material = collectContext(f.store, { sessionId: f.sessionId, turn: 1 });
  material.workGoalContext = automaticWorkContext(f.goals, work, state, material.cutoffSequence);
  const original = structuredClone(material);
  linkWork(f.store, { work, goal: f.store.get('goals', f.goal.id), state,
    reason: '同一关系的后续解释，不能热替换冻结正文', sourceIds: [f.source.id],
    expectedRelationId: workRelation(f.store, f.id).id, origin: { kind: 'learn', id: 'repeat' } });
  assert.notEqual(workRelation(f.store, f.id).id, original.workGoalContext.relationId);
  assert.equal(workContextCurrent(f.store, original.workGoalContext), true);
  assert.deepEqual(refreshContext(f.store, material), original);
  const other = saveGoalTransition(f.store, null, { ...f.goal, id: 'other-goal', title: '另一个长期目标' },
    { commandId: 'other', pendingId: null, reason: 'fixture-definition' });
  linkWork(f.store, { work, goal: other, state, reason: '新解释联系另一目标', sourceIds: [f.source.id],
    expectedRelationId: workRelation(f.store, f.id).id, origin: { kind: 'learn', id: 'replace' } });
  assert.equal(workContextCurrent(f.store, original.workGoalContext), false);
  assert.equal(refreshContext(f.store, material).workGoalContext, undefined);
});


test('blocking reasons survive captured native history and current execution takes precedence without leaking stale reasons', t => {
  const f = fixture(t), reason = { code: 'model-reported', message: '等待用户选择。' };
  f.add('goal/change', { operation: 'block', goal: { ...f.native, revision: 2, phase: 'blocked', blockedReason: reason }, roundsStarted: 1 });
  f.sync();
  assert.deepEqual(workViews(f.store, f.sessionId)[0].blockedReason, reason);
  const seq = f.store.currentSequence();
  const live = { ...f.native, phase: 'blocked', revision: 3, blockedReason: { code: 'round-limit', message: 'Round limit reached.' } };
  assert.deepEqual(workViews(f.store, f.sessionId, live)[0].blockedReason, live.blockedReason);
  assert.equal(workViews(f.store, f.sessionId, { ...f.native, revision: 4, activation: 'armed' })[0].blockedReason, null);
  assert.equal(f.store.currentSequence(), seq, 'viewing writes no business data');
  f.store.save('source_controls', { id: f.store.get('goal_works', f.id).sourceIds[0], withdrawn: true });
  assert.equal(workViews(f.store, f.sessionId)[0].blockedReason, null);
});
