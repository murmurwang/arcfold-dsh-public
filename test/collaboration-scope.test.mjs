import test from 'node:test';
import assert from 'node:assert/strict';
import { BusinessStore } from '../src/business.mjs';
import { GoalService } from '../src/goals.mjs';
import { UnderstandingService } from '../src/understandings.mjs';
import { MethodService } from '../src/methods.mjs';
import { OpportunityService } from '../src/opportunities.mjs';
import { ImportService } from '../src/importer.mjs';
import { collectContext } from '../src/context-material.mjs';
import { captureWorks, linkWork, workId, workState } from '../src/goal-work.mjs';
import { createGoalHandler } from '../packages/method-ui/src/goal-host.mjs';
import { createUnderstandingHandler } from '../packages/method-ui/src/understanding-host.mjs';
import { createOpportunityHandler } from '../packages/method-ui/src/opportunity-host.mjs';
import { createMethodHandler } from '../packages/method-ui/src/index.mjs';
import { createImportHandler } from '../packages/method-ui/src/import-host.mjs';

const code = expected => error => error.code === expected;
const a = 'chat-a', b = 'chat-b';
function fixture(t, count = 25) {
  const business = new BusinessStore({ filename: ':memory:' }); t.after(() => business.close());
  const store = business.storage;
  const services = { goals: new GoalService({ business }), understandings: new UnderstandingService({ business }),
    methods: new MethodService({ business }), opportunities: new OpportunityService({ business }), imports: new ImportService({ business }) };
  for (const sessionId of [a, b]) store.save('host_bindings', { id: sessionId, role: 'main' });
  const rows = [];
  for (let i = 0; i < count; i++) {
    const origin = i % 2 ? a : b, local = i % 3 ? origin : null;
    const scope = local ? { conversationId: local } : {};
    const source = store.save('events', { id: 'source-' + i, role: 'user', author: 'user', conversationId: origin,
      content: 'Original ' + i, provenance: { kind: 'test-original', sessionId: origin } });
    const sourceIds = [source.id], dependencies = [{ kind: 'events', id: source.id, revision: source.revision }];
    const goal = store.save('goals', { id: 'goal-' + i, conversationId: origin, title: 'Goal ' + i,
      outcome: 'Outcome ' + i, scope, definitionVersion: 1, status: 'tracking', sourceIds, dependencies,
      progress: { content: '', sourceIds: [], dependencies: [] }, relations: [] });
    const understanding = store.save('understandings', { id: 'understanding-' + i, scope, content: 'Understanding ' + i,
      claimType: 'inference', status: 'active', version: 1, sourceIds, dependencies });
    const method = store.save('methods', { id: 'method-' + i, scope, title: 'Method ' + i, guidance: 'Guidance ' + i,
      appliesTo: 'when relevant', doesNotApplyTo: 'otherwise', status: 'trial', version: 1, maxTrialUses: 3, sourceIds, dependencies });
    const opportunity = store.save('opportunities', { id: 'opportunity-' + i, conversationId: origin,
      learnedFromRunId: 'learn-' + i, description: 'Opportunity ' + i, rationale: 'Reason ' + i,
      suggestedPreparation: 'Prepare ' + i, status: 'pending', sourceIds, dependencies });
    store.save('learning_sections', { id: 'learn-' + i + ':opportunities', status: 'completed', ids: [opportunity.id] });
    const batch = store.save('import_batches', { id: 'batch-' + i, sessionId: origin, status: 'ready',
      scopeMap: [], previewHash: 'a'.repeat(64), file: { sha256: 'b'.repeat(64) } });
    rows.push({ origin, local, source, goal, understanding, method, opportunity, batch });
  }
  return { business, store, rows, ...services };
}
function pages(read, identify) {
  const ids = []; let offset = 0, total;
  do { const page = read(offset); total ??= page.total; assert.equal(page.total, total);
    ids.push(...page.items.map(identify)); offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(new Set(ids).size, ids.length); assert.equal(ids.length, total); return ids;
}
function reads(f, sessionId, viewScope) {
  return [
    [offset => f.goals.list({ sessionId, viewScope, offset, limit: 4 }), x => x.goal.id, 'scoped'],
    [offset => f.understandings.list({ sessionId, viewScope, offset, limit: 4 }), x => x.understanding.id, 'scoped'],
    [offset => f.methods.listCards({ sessionId, viewScope, offset, limit: 4 }), x => x.method.id, 'scoped'],
    [offset => f.opportunities.list(sessionId, { viewScope, offset, limit: 4 }), x => x.opportunity.id, 'origin'],
    [offset => f.imports.list({ sessionId, viewScope, offset, limit: 4 }), x => x.id, 'origin'],
  ];
}

test('all five owner collections agree across chats and filter before pagination without changing model inputs', t => {
  const f = fixture(t);
  const before = collectContext(f.store, { sessionId: a, turn: 1, maxCharacters: 180000 });
  const sequence = f.store.currentSequence();
  const allA = reads(f, a, 'all'), allB = reads(f, b, 'all');
  allA.forEach(([read, id], i) => assert.deepEqual(pages(read, id), pages(allB[i][0], allB[i][1])));
  for (const sessionId of [a, b]) for (const [read, id, kind] of reads(f, sessionId, 'current')) {
    const expected = f.rows.filter(row => kind === 'scoped' ? !row.local || row.local === sessionId : row.origin === sessionId).length;
    assert.equal(pages(read, id).length, expected);
  }
  assert.equal(f.store.currentSequence(), sequence);
  assert.deepEqual(collectContext(f.store, { sessionId: a, turn: 1, maxCharacters: 180000 }), before);
  assert.equal(f.methods.listCards().total, 0, 'legacy management reads keep their original notice/decision selection');
  assert.equal(f.methods.listCards({ sessionId: a, viewScope: 'all' }).total, 25, 'ordinary trial methods are also accumulated knowledge');
});

test('all understanding history is readable without broadening correction or source-control scope', t => {
  const f = fixture(t, 4), row = f.rows.find(row => row.local === b), u = row.understanding;
  const next = f.store.save('understandings', { ...u, id: 'new-version', previousId: u.id, version: 2 });
  f.store.save('understanding_commands', { id: 'old-command', sessionId: b, understandingId: u.id, action: 'correct', result: { after: next } });
  const sequence = f.store.currentSequence();
  const detail = f.understandings.details({ sessionId: a, understandingId: next.id, viewScope: 'all' });
  assert.equal(detail.historyTotal, 2); assert.equal(detail.commandsTotal, 1);
  assert.deepEqual(detail.sources[0].provenance, row.source.provenance);
  assert.equal(detail.browse.related, false); assert.equal(detail.controls.correctionAllowed, false);
  assert.equal(detail.controls.sourceControlAllowed, false);
  const request = { sessionId: a, understandingId: u.id, expectedRevision: u.revision, requestId: 'foreign', userIdentity: 'browser:owner' };
  assert.throws(() => f.understandings.decide({ ...request, action: 'stop-understanding' }), code('understanding_not_found'));
  assert.throws(() => f.understandings.bindCorrection({ ...request, text: 'A new statement' }), code('understanding_not_found'));
  assert.throws(() => f.understandings.details({ sessionId: a, understandingId: u.id, viewScope: 'current' }), code('understanding_not_found'));
  assert.equal(f.store.currentSequence(), sequence);
});

test('all goal and opportunity details do not authorize foreign discussion, work continuation or import confirmation', t => {
  const f = fixture(t, 4), row = f.rows.find(row => row.local === b), sequence = f.store.currentSequence();
  assert.equal(f.goals.details(row.goal.id, { sessionId: a, viewScope: 'all' }).browse.related, false);
  assert.throws(() => f.goals.details(row.goal.id, { sessionId: a, viewScope: 'current' }), code('goal_not_found'));
  assert.throws(() => f.goals.bindDiscussion({ sessionId: a, goalId: row.goal.id, expectedRevision: row.goal.revision,
    definitionVersion: 1, mode: 'discuss', content: [{ type: 'text', text: 'Discuss' }], requestId: 'foreign', userIdentity: 'browser:owner' }), code('goal_scope_denied'));
  assert.throws(() => f.opportunities.bindContinuation({ sessionId: a, opportunityId: row.opportunity.id,
    expectedRevision: row.opportunity.revision, text: 'Continue', requestId: 'foreign', userIdentity: 'browser:owner' }), code('preparation_continuation_scope'));
  assert.throws(() => f.imports.confirm({ sessionId: a, batchId: row.batch.id, expectedRevision: row.batch.revision,
    previewHash: row.batch.previewHash, requestId: 'foreign', userIdentity: 'browser:owner' }), code('import_not_confirmable'));
  assert.equal(f.store.currentSequence(), sequence);
});

test('a global goal shows the same cross-chat work originals while controls stay with each original chat', t => {
  const f = fixture(t, 1), nativeBySession = new Map(), agents = new Map();
  for (const sessionId of [a, b]) {
    const native = { id: 'work-' + sessionId, revision: 1, objective: 'Authorized ' + sessionId, phase: 'active', activation: 'armed', maxGoalRounds: 3, roundsStarted: 0 };
    const events = [{ type: 'command/run', data: { commandId: 'create', name: 'goal', args: native.objective, source: { kind: 'user' } } },
      { type: 'goal/change', data: { operation: 'create', goal: native, roundsStarted: 0 } },
      { type: 'command/done', data: { commandId: 'create', kind: 'success' } }].map((event, seq) => ({ ...event, seq, time: 1794000000000 + seq }));
    f.business.ingestSession({ sessionId, events }); captureWorks(f.store, sessionId, events);
    const id = workId(sessionId, native.id);
    linkWork(f.store, { work: f.store.get('goal_works', id), goal: f.rows[0].goal, state: workState(f.store, id),
      reason: 'Supports shared goal', sourceIds: [f.rows[0].source.id], expectedRelationId: null, origin: { kind: 'test', id: sessionId } });
    agents.set(sessionId, { id: sessionId }); nativeBySession.set(sessionId, native);
  }
  f.goals.nativeRoot = { get: name => name === 'agents' ? agents : name === 'goals' ? { get: agent => nativeBySession.get(agent.id) } : undefined };
  const sequence = f.store.currentSequence(), read = sessionId => f.goals.details(f.rows[0].goal.id, { sessionId, viewScope: 'all' }).works;
  const left = read(a), right = read(b);
  assert.deepEqual(left.map(w => w.id), right.map(w => w.id)); assert.equal(left.length, 2);
  for (const [current, rows] of [[a, left], [b, right]]) for (const work of rows) {
    assert.equal(work.objective, 'Authorized ' + work.sessionId);
    assert.equal(work.canStop, work.sessionId === current); if (work.sessionId !== current) assert.equal(work.canResume, false);
  }
  assert.equal(f.store.currentSequence(), sequence);
  // Preserve the upstream stage projection while keeping cross-chat browsing
  // from exposing a resume action for another chat's otherwise resumable work.
  for (const [sessionId, native] of nativeBySession) {
    native.activation = 'disarmed';
    f.store.save('execution_stages', { id: 'stage-' + sessionId, sessionId, nativeGoalId: native.id,
      status: 'waiting', objective: 'Current stage ' + sessionId });
  }
  f.goals.execution = { view: row => row && { available: true, status: row.status, objective: row.objective } };
  const beforeRead = f.store.currentSequence();
  for (const current of [a, b]) for (const work of read(current)) {
    assert.equal(work.stage.status, 'waiting');
    assert.equal(work.stage.objective, 'Current stage ' + work.sessionId);
    assert.equal(work.canResume, work.sessionId === current);
  }
  assert.equal(f.store.currentSequence(), beforeRead);
});

test('explicit browsing preserves more than twenty work records while model-facing reads stay bounded', t => {
  const f = fixture(t, 1), events = [];
  for (let i = 0; i < 48; i++) {
    const goal = { id: 'past-' + i, revision: 1, objective: 'Past work ' + i, phase: 'completed', maxGoalRounds: 3 };
    for (const event of [
      { type: 'command/run', data: { commandId: 'create-' + i, name: 'goal', args: goal.objective, source: { kind: 'user' } } },
      { type: 'goal/change', data: { operation: 'create', goal, roundsStarted: 0 } },
      { type: 'command/done', data: { commandId: 'create-' + i, kind: 'success' } },
    ]) events.push({ ...event, seq: events.length, time: 1794000000000 + events.length });
  }
  f.business.ingestSession({ sessionId: a, events }); captureWorks(f.store, a, events);
  for (let i = 0; i < 24; i++) {
    const id = workId(a, 'past-' + i);
    linkWork(f.store, { work: f.store.get('goal_works', id), goal: f.rows[0].goal, state: workState(f.store, id),
      reason: 'Supports shared goal', sourceIds: [f.rows[0].source.id], expectedRelationId: null, origin: { kind: 'test', id } });
  }
  const sequence = f.store.currentSequence();
  assert.equal(f.goals.works(a).length, 20);
  assert.equal(f.goals.list({ sessionId: a }).items[0].works.length, 20,
    'legacy goal cards retain their own work history even when newer unrelated works fill the top-level page');
  for (const sessionId of [a, b]) {
    const all = f.goals.list({ sessionId, viewScope: 'all' });
    assert.equal(all.works.length, 24); assert.equal(all.items[0].works.length, 24);
    assert.equal(f.goals.details(f.rows[0].goal.id, { sessionId, viewScope: 'all' }).works.length, 24);
  }
  assert.equal(f.goals.list({ sessionId: a, viewScope: 'current' }).works.length, 24);
  assert.equal(f.store.currentSequence(), sequence);
});

test('orphan method history remains in all without inventing a chat relationship or losing original notices', t => {
  const f = fixture(t, 1);
  const notice = f.store.save('notifications', { id: 'orphan-notice', kind: 'method_paused', methodId: 'missing', methodVersion: 1,
    message: 'Original historical notice', status: 'unread' });
  const all = f.methods.listCards({ sessionId: a, viewScope: 'all' });
  assert.ok(all.items.some(row => row.method.id === 'missing'));
  const detail = f.methods.cardDetails('missing', { sessionId: a, viewScope: 'all' });
  assert.deepEqual(detail.notifications.items, [notice]); assert.equal(detail.activation.allowed, false);
  assert.ok(!f.methods.listCards({ sessionId: a, viewScope: 'current' }).items.some(row => row.method.id === 'missing'));
});

test('all preserves live unindexed top-level work and its current-chat stop entry without waking a cold chat', t => {
  const f = fixture(t, 1), agents = [a, b].map(id => ({ id }));
  const native = new Map(agents.map(agent => [agent.id, { id: 'legacy-' + agent.id, revision: 1,
    objective: 'Original live work ' + agent.id, phase: 'active', activation: 'armed', roundsStarted: 0, maxGoalRounds: 3 }]));
  f.goals.nativeRoot = { get: name => name === 'agents' ? { get: id => agents.find(x => x.id === id), roots: () => agents }
    : name === 'goals' ? { get: agent => native.get(agent.id) } : undefined };
  const sequence = f.store.currentSequence(); assert.equal(f.store.listAll('goal_works').length, 0);
  const allA = f.goals.list({ sessionId: a, viewScope: 'all' }).works;
  const allB = f.goals.list({ sessionId: b, viewScope: 'all' }).works;
  assert.deepEqual(new Set(allA.map(w => w.id)), new Set(allB.map(w => w.id)));
  assert.equal(allA.length, 2); assert.equal(allA.find(w => w.sessionId === a).canStop, true);
  assert.equal(allA.find(w => w.sessionId === b).canStop, false);
  assert.equal(allA.every(w => w.provenance === 'legacy-unverified' && !w.canResume), true);
  assert.equal(f.goals.list({ sessionId: 'cold', viewScope: 'all' }).works.every(w => !w.canStop && !w.canResume), true);
  assert.equal(f.goals.list({ sessionId: a, viewScope: 'current' }).works.length, 1);
  assert.equal(f.store.currentSequence(), sequence);
});

test('explicit owner browsing works in cold chats without granting write capability or requiring agent creation', async t => {
  const f = fixture(t, 2), live = () => new AbortController().signal;
  const peer = { id: 'owner', principal: { kind: 'owner' }, interactions: 'answer', signal: live() };
  const common = { ...f, agents: { get: () => undefined }, agentPresets: { composedPreset: () => undefined }, connection: { browserPeer: peer } };
  const understandings = createUnderstandingHandler(common), imports = createImportHandler(common);
  const read = { sessionId: 'cold', viewScope: 'all' }, sequence = f.store.currentSequence();
  assert.equal((await understandings('list', read, live(), peer)).total, 2);
  const detail = await understandings('details', { ...read, understandingId: f.rows[0].understanding.id }, live(), peer);
  assert.equal(detail.controls.correctionAllowed, false); assert.equal(detail.controls.sourceControlAllowed, false);
  assert.equal((await imports('list', read, live(), peer)).canImport, false);
  assert.equal((await imports('details', { ...read, batchId: f.rows[0].batch.id }, live(), peer)).batch.id, f.rows[0].batch.id);
  await assert.rejects(understandings('correct', { sessionId: 'cold', understandingId: f.rows[0].understanding.id,
    expectedRevision: 1, requestId: 'denied', text: 'Do not send' }, live(), peer), code('understanding_session_denied'));
  await assert.rejects(imports('confirm', { sessionId: 'cold', batchId: f.rows[0].batch.id,
    expectedRevision: 1, previewHash: 'a'.repeat(64), requestId: 'denied' }, live(), peer), code('import_session_denied'));
  assert.equal(f.store.currentSequence(), sequence);
});

test('authenticated read routes accept display scope; invalid scopes, untrusted peers and scoped writes are refused', async t => {
  const f = fixture(t, 4), live = () => new AbortController().signal;
  const peer = { id: 'owner', principal: { kind: 'owner' }, interactions: 'answer', signal: live() };
  const agents = new Map([a, b].map(id => [id, { id, ctx: {} }]));
  let prompts = 0;
  const common = { ...f, agents, agentPresets: { composedPreset: () => 'arcfold-main' }, connection: { browserPeer: peer },
    prompt: () => { prompts++; throw new Error('No prompts while browsing'); } };
  const handlers = [createGoalHandler(common), createUnderstandingHandler(common), createMethodHandler(common),
    createOpportunityHandler(common), createImportHandler(common)];
  for (let i = 0; i < handlers.length; i++) {
    const handler = handlers[i], endpoint = i === 2 ? 'cards' : 'list';
    const invoke = async (payload, browser = peer) => {
      try { const r = await handler(endpoint, payload, live(), browser); return r?.ok === false ? r.error : r; }
      catch (error) { return error; }
    };
    const request = { sessionId: a, viewScope: 'all' }, valid = await invoke(request);
    assert.equal((valid?.value ?? valid).total, 4, 'route ' + i);
    assert.equal((await invoke({ ...request, viewScope: 'arbitrary' })).code, 'invalid_browse_scope');
    assert.equal((await invoke(request, { ...peer })).code, 'trusted_browser_required');
  }
  const row = f.rows.find(row => row.local === b);
  assert.equal((await handlers[3]('details', { sessionId: a, opportunityId: row.opportunity.id, viewScope: 'all' }, live(), peer)).ok, true);
  const scopedWrite = await handlers[0]('discuss', { sessionId: a, viewScope: 'all', goalId: row.goal.id, expectedRevision: 1,
    definitionVersion: 1, mode: 'discuss', text: 'Do not send', requestId: 'write' }, live(), peer);
  assert.equal(scopedWrite.ok, false); assert.equal(scopedWrite.error.code, 'invalid_goal_request'); assert.equal(prompts, 0);
});
