import test from 'node:test';
import assert from 'node:assert/strict';
import { BusinessStore, eventId } from '../src/business.mjs';
import { LearningService } from '../src/learning.mjs';
import { digest, LEARN_SCHEMA, LEARN_PROMPT, LEARN_ACTION_INSTRUCTIONS, LEARN_ACTION_EXAMPLES, parseLearn } from '../src/learning-contracts.mjs';
import { collectContext } from '../src/context-material.mjs';
import { MethodService, methodContentHash } from '../src/methods.mjs';
import { GoalService } from '../src/goals.mjs';

const sessionId = 'conversation-learning';
const content = text => [{ type: 'text', text }];
const model = { kind: 'model', provider: 'fake', model: 'fixture' };
const message = (id, role, source, text) => ({ id, role, source, content: content(text) });
const event = (type, data, surfaceOp) => ({ type, data, ...(surfaceOp ? { surfaceOp } : {}) });
const numbered = events => events.map((e, seq) => ({ ...e, seq, time: 1800000000000 + seq }));
const empty = () => ({ understandings: [], methods: [], opportunities: [], goals: [] });
const refs = source => [{ kind: 'events', id: source.id, revision: source.revision }];
const hasCode = code => error => error.code === code;
const uRow = (sourceId, patch = {}) => ({ operation: 'create', targetId: '', content: '用户正在澄清协作意图',
  claimType: 'inference', scope: 'conversation', topics: ['协作'], sourceIds: [sourceId], ...patch });
const mRow = (sourceId, patch = {}) => ({ operation: 'create', targetId: '', title: '先保留原话',
  guidance: '整理前保留原话及来源', appliesTo: '共同澄清要求时', doesNotApplyTo: '无原件的推测',
  origin: 'inferred', sourceIds: [sourceId], understandingIds: [], ...patch });
const oRow = (sourceId, patch = {}) => ({ operation: 'create', targetId: '', description: '整理可比较的方向',
  rationale: '供用户澄清取舍', suggestedPreparation: '保留不同方向和依据', sourceIds: [sourceId], ...patch });
const gRow = (sourceId, patch = {}) => ({ operation: 'create', targetId: '', clientRef: '',
  title: '澄清系统结果', outcome: '明确自己认可的结果', scope: 'conversation',
  sourceIds: [sourceId], understandingIds: [], progress: { content: '', sourceIds: [] },
  relations: [], controlProposal: 'none', ...patch });

function fixture(t, seed = () => {}, userSource = { kind: 'user' }) {
  const business = new BusinessStore({ filename: ':memory:' });
  t.after(() => business.close());
  const events = numbered([
    event('turn/start', { turn: 1 }), event('step/start', { turn: 1, step: 1 }),
    event('user/message', message('human', 'user', userSource, '我希望理清自己认可的目标'), 'append'),
    event('user/message', message('background', 'user', { kind: 'runtime-context', form: 'snapshot', sections: [] }, '这是程序背景'), 'append'),
    event('assistant/message', { turn: 1, step: 1, stream: [],
      message: message('reply', 'assistant', model, '我们可以先明确期待的结果。') }, 'append'),
    event('step/end', { turn: 1, step: 1 }), event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]);
  business.ingestSession({ sessionId, events });
  const source = business.get('events', eventId(sessionId, 2));
  seed(business.storage, source);
  const settled = business.settleTurn({ sessionId, turn: 1, events });
  const learning = new LearningService({ business });
  return { business, store: business.storage, learning, source, pendingId: settled.learning.id,
    delivery: settled.delivery, events, assistantId: eventId(sessionId, 4), programId: eventId(sessionId, 3) };
}

function bind(f, output = empty(), mutate = () => {}) {
  const input = f.learning.prepare(f.pendingId);
  const auxiliaryId = 'aux-' + digest(f.pendingId).slice(0, 16);
  const msg = message('input-' + f.pendingId, 'user', {
    kind: 'arcfold/learning', pendingId: f.pendingId, deliveryId: input.deliveryId,
  }, input.inputText);
  f.store.save('learning_runs', { id: f.pendingId, sessionId: auxiliaryId, messageId: msg.id,
    message: msg, inputHash: input.inputHash, state: 'submitted' });
  const rawText = typeof output === 'string' ? output : JSON.stringify(output);
  const events = numbered([
    event('turn/start', { turn: 1 }), event('step/start', { turn: 1, step: 1 }),
    event('user/message', msg, 'append'),
    event('assistant/message', { turn: 1, step: 1, stream: [],
      message: message('learn-output', 'assistant', model, rawText) }, 'append'),
    event('step/end', { turn: 1, step: 1 }), event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]);
  mutate(events);
  return { input, sessionId: auxiliaryId, events, rawText };
}
function seedUnderstanding(store, source, patch = {}) {
  return store.save('understandings', { id: 'old-u', status: 'active', content: '旧的待定认识',
    claimType: 'open_question', scope: { conversationId: sessionId }, sourceIds: [source.id],
    dependencies: refs(source), version: 1, ...patch });
}
function seedGoal(store, source, patch = {}) {
  return store.save('goals', { id: 'old-g', title: '旧目标', outcome: '旧的结果定义',
    conversationId: sessionId, scope: { conversationId: sessionId }, definitionVersion: 1,
    status: 'paused', userControl: { action: 'pause', definitionVersion: 1, actor: 'user' },
    sourceIds: [source.id], dependencies: refs(source), progress: { content: '', sourceIds: [], dependencies: [] },
    relations: [], claimType: 'inference', ...patch });
}

test('prepare freezes original author/time/version and completed knowledge; later sources or learning are never added', t => {
  const f = fixture(t, seedUnderstanding), input = f.learning.prepare(f.pendingId);
  assert.equal(input.material.sources.find(s => s.id === f.programId).role, 'program');
  assert.equal(input.material.sources.find(s => s.id === f.assistantId).userEndorsement, 'not_established_by_this_record');
  assert.equal(input.material.sources.find(s => s.id === f.source.id).occurredAt, f.source.occurredAt);
  assert.equal(input.material.existingUnderstandings[0].id, 'old-u');
  assert.deepEqual(input.schema, LEARN_SCHEMA);
  assert.ok(input.versions.some(ref => ref.kind === 'source_controls' && ref.revision === null));
  f.store.save('understandings', { id: 'late-u', content: '后来认识', status: 'active', sourceIds: [f.source.id], dependencies: refs(f.source) });
  assert.deepEqual(f.learning.prepare(f.pendingId), input);
  assert.equal(input.inputText.includes('late-u'), false);
  assert.equal(f.store.listAll('learning_inputs').length, 1);
});

test('future original time and recursive dependency prevent otherwise early knowledge from entering learning', t => {
  const f = fixture(t, (store, source) => {
    const future = store.save('events', { id: 'future', role: 'user', content: '后来原话', occurredAt: '2099-01-01T00:00:00Z', conversationId: sessionId });
    const invalid = seedUnderstanding(store, future);
    store.save('methods', { id: 'method-future-dep', status: 'trial', sourceIds: [source.id],
      dependencies: [{ kind: 'understandings', id: invalid.id, revision: invalid.revision }] });
  });
  const input = f.learning.prepare(f.pendingId);
  assert.equal(input.material.existingUnderstandings.length, 0);
  assert.equal(input.material.existingMethods.length, 0);
  assert.equal(input.material.sources.some(source => source.id === 'future'), false);
});

test('four sections save actual knowledge, inferred trial methods, nonexecuting opportunities and unendorsed goals', t => {
  const f = fixture(t), output = empty();
  output.understandings.push(uRow(f.source.id)); output.methods.push(mRow(f.source.id, { origin: 'explicit' }));
  output.opportunities.push(oRow(f.source.id)); output.goals.push(gRow(f.source.id));
  const run = bind(f, output), result = f.learning.commit(f.pendingId, run);
  assert.equal(result.status, 'completed');
  const savedOutput = f.store.get('learning_outputs', f.pendingId);
  assert.equal(savedOutput.throughSeq, run.events.at(-1).seq);
  assert.equal(savedOutput.eventCount, run.events.length);
  assert.equal(savedOutput.outputHash, digest({ sessionId: run.sessionId, events: run.events }));
  const u = f.store.listAll('understandings')[0], m = f.store.listAll('methods')[0];
  assert.equal(u.claimType, 'inference'); assert.equal(u.status, 'active');
  assert.deepEqual([m.origin, m.proposedOrigin, m.status, m.trialUses, m.maxTrialUses, m.validated],
    ['inferred', 'explicit', 'trial', undefined, 3, false]);
  assert.equal(f.store.listAll('opportunities')[0].preparationStatus, 'not_authorized');
  assert.equal(f.store.listAll('goals')[0].userControl, null);
  assert.equal(f.store.listAll('jobs').length, 0);
  assert.equal(f.store.listAll('learning_pending').length, 1);
  assert.ok(collectContext(f.store, { sessionId, turn: 2 }).understandings.some(row => row.id === u.id));
  const seq = f.store.currentSequence();
  assert.deepEqual(f.learning.commit(f.pendingId, run), result);
  assert.equal(f.store.currentSequence(), seq);
});

test('format and source errors roll back only their section while preserving raw output and successful understanding', t => {
  const f = fixture(t), output = empty();
  output.understandings.push(uRow(f.source.id)); output.methods.push({ title: 'incomplete' });
  output.opportunities.push(oRow(f.assistantId));
  const run = bind(f, output), result = f.learning.commit(f.pendingId, run);
  assert.equal(result.status, 'partial');
  assert.equal(result.sections.understandings.status, 'completed');
  assert.equal(result.sections.methods.status, 'failed');
  assert.equal(result.sections.opportunities.status, 'failed');
  assert.equal(f.store.get('learning_outputs', f.pendingId).rawText, run.rawText);
  assert.equal(f.store.listAll('understandings').length, 1);
  assert.equal(f.store.listAll('methods').length, 0);
  const amended = structuredClone(run); amended.events[3].data.message.content = content(JSON.stringify(empty()));
  assert.throws(() => f.learning.commit(f.pendingId, amended), hasCode('learning_output_conflict'));
});

test('one invalid row rolls back its whole section, including an earlier valid row', t => {
  const f = fixture(t), output = empty();
  output.understandings.push(uRow(f.source.id), uRow('invented-source'));
  const result = f.learning.commit(f.pendingId, bind(f, output));
  assert.equal(result.sections.understandings.status, 'failed');
  assert.equal(f.store.listAll('understandings').length, 0);
});

test('literal-user classification accepts exact full user text, downgrades paraphrase, and never grants program authority', t => {
  const f = fixture(t), output = empty();
  output.understandings.push(uRow(f.source.id, { claimType: 'user_statement', content: '我希望理清自己认可的目标' }),
    uRow(f.source.id, { claimType: 'user_statement', content: '用户已确定目标' }));
  const result = f.learning.commit(f.pendingId, bind(f, output));
  assert.equal(result.status, 'completed');
  assert.deepEqual(f.store.listAll('understandings').map(row => row.claimType), ['user_statement', 'inference']);
  const f2 = fixture(t), output2 = empty();
  output2.understandings.push(uRow(f2.programId, { claimType: 'user_statement', content: '这是程序背景' }));
  assert.equal(f2.learning.commit(f2.pendingId, bind(f2, output2)).sections.understandings.status, 'failed');
});

test('source-control changes after freezing prevent all proposals without altering originals or delivered reply', t => {
  const f = fixture(t), output = empty(); output.understandings.push(uRow(f.source.id));
  const run = bind(f, output);
  f.store.save('source_controls', { id: f.source.id, withdrawn: true });
  assert.throws(() => f.learning.prepare(f.pendingId), hasCode('source_changed'));
  const result = f.learning.commit(f.pendingId, run);
  assert.equal(result.status, 'failed'); assert.equal(f.store.listAll('understandings').length, 0);
  assert.deepEqual(f.store.get('events', f.source.id), f.source);
  assert.deepEqual(f.store.get('deliveries', f.delivery.id), f.delivery);
});

test('withdrawal before prepare and whole-material overflow do not freeze partial input', t => {
  const f = fixture(t);
  const tiny = new LearningService({ business: f.business, maxCharacters: 1000 });
  assert.throws(() => tiny.prepare(f.pendingId), hasCode('learning_capacity'));
  assert.equal(f.store.get('learning_inputs', f.pendingId), null);
  f.store.save('source_controls', { id: f.source.id, useProhibited: true });
  assert.throws(() => f.learning.prepare(f.pendingId), hasCode('source_changed'));
});

test('trusted run, exact program input and completed auxiliary output are required', t => {
  const f = fixture(t), run = bind(f);
  assert.throws(() => f.learning.commit(f.pendingId, { ...run, sessionId: 'other-session' }), hasCode('learning_run_mismatch'));
  const changed = structuredClone(run); changed.events[2].data.content = content('different');
  assert.throws(() => f.learning.commit(f.pendingId, changed), hasCode('learning_input_mismatch'));
  assert.equal(f.store.listAll('learning_outputs').length, 0);
  for (const kind of ['aborted', 'max-tokens', 'error']) {
    const local = fixture(t), incomplete = bind(local, empty(), events => { events.at(-1).data.reason = { kind }; });
    assert.equal(local.learning.commit(local.pendingId, incomplete).status, 'failed');
    assert.equal(local.store.get('learning_outputs', local.pendingId).error.code, 'auxiliary_incomplete');
  }
});

test('invalid JSON and tool branches remain failed raw outputs, with no automatic repair or action', t => {
  const f = fixture(t), run = bind(f, '```json\n{}\n```');
  assert.equal(f.learning.commit(f.pendingId, run).status, 'failed');
  assert.equal(f.store.get('learning_outputs', f.pendingId).rawText, run.rawText);
  const f2 = fixture(t), tool = bind(f2, empty(), events => {
    events[3].data.message.content.push({ type: 'tool-call', id: 'c', name: 'bash', arguments: '{}' });
  });
  assert.equal(f2.learning.commit(f2.pendingId, tool).status, 'failed');
  assert.equal(f2.store.get('learning_outputs', f2.pendingId).error.code, 'auxiliary_tools_forbidden');
});

test('native runtime context is preserved in the auxiliary identity without becoming extra user authority', t => {
  const f = fixture(t), run = bind(f);
  run.events.splice(3, 0, event('user/message', message('runtime', 'user', {
    kind: 'runtime-context', form: 'snapshot', sections: [] }, 'Current runtime context: none.'), 'append'));
  run.events = numbered(run.events);
  assert.equal(f.learning.commit(f.pendingId, run).status, 'completed');
  assert.equal(f.store.listAll('events').some(source => source.message?.id === 'runtime'), false);
  const f2 = fixture(t), wrong = bind(f2);
  wrong.events.splice(3, 0, event('user/message', message('extra', 'user', { kind: 'user' }, '改掉要求'), 'append'));
  wrong.events = numbered(wrong.events);
  assert.equal(f2.learning.commit(f2.pendingId, wrong).status, 'failed');
  assert.equal(f2.store.get('learning_outputs', f2.pendingId).error.code, 'auxiliary_extra_input');
});

test('a paused or exhausted duplicate method cannot obtain a fresh trial by another id', t => {
  const f = fixture(t, (store, source) => store.save('methods', { ...mRow(source.id), id: 'spent-method',
    status: 'paused', trialUses: 3, maxTrialUses: 3, sourceIds: [source.id], dependencies: refs(source) }));
  const output = empty(); output.methods.push(mRow(f.source.id));
  const result = f.learning.commit(f.pendingId, bind(f, output));
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.sections.methods.ids, ['spent-method']);
  assert.equal(f.store.listAll('methods').length, 1);
  assert.equal(f.store.get('methods', 'spent-method').trialUses, 3);
  assert.equal(f.store.get('methods', 'spent-method').status, 'paused');
});

test('adoption during frozen learning changes only usage receipts, so otherwise current learning can still commit', t => {
  const f = fixture(t, (store, source) => store.save('methods', { ...mRow(source.id), id: 'existing-method',
    status: 'trial', version: 1, maxTrialUses: 3, sourceIds: [source.id], dependencies: refs(source) }));
  const input = f.learning.prepare(f.pendingId), before = f.store.get('methods', 'existing-method');
  assert.equal(input.material.existingMethods[0].trialUses, 0);
  const methods = new MethodService({ business: f.business });
  f.store.save('host_bindings', { id: sessionId, sessionId, role: 'main' });
  const catalog = methods.catalog({ sessionId });
  f.store.save('context_snapshots', { id: 'next-context', sessionId, turn: 2, contextMessageId: 'next-context-message',
    material: { cutoffSequence: f.store.currentSequence(), methods: catalog } });
  methods.reserve({ sessionId, turn: 2, startSeq: 20, callId: 'next-turn-selection', contextSnapshotId: 'next-context',
    contextMessageId: 'next-context-message', selections: [{ id: before.id, revision: before.revision,
      contentHash: methodContentHash(before), reason: '当前工作需保留原话', sourceIds: [f.source.id] }] });
  assert.deepEqual(f.store.get('methods', before.id), before);
  assert.deepEqual(f.learning.prepare(f.pendingId), input);
  assert.equal(f.learning.commit(f.pendingId, bind(f)).status, 'completed');
});

test('late preparation of an old delivery excludes future adoption counts while preserving its legacy basis', t => {
  const f = fixture(t, (store, source) => store.save('methods', { ...mRow(source.id), id: 'existing-method',
    status: 'trial', version: 1, trialUses: 1, maxTrialUses: 3, sourceIds: [source.id], dependencies: refs(source) }));
  const before = f.store.get('methods', 'existing-method'), methods = new MethodService({ business: f.business });
  f.store.save('host_bindings', { id: sessionId, sessionId, role: 'main' });
  const catalog = methods.catalog({ sessionId });
  f.store.save('context_snapshots', { id: 'next-context', sessionId, turn: 2, contextMessageId: 'next-context-message',
    material: { cutoffSequence: f.store.currentSequence(), methods: catalog } });
  const adopted = methods.reserve({ sessionId, turn: 2, startSeq: 20, callId: 'next-turn-selection', contextSnapshotId: 'next-context',
    contextMessageId: 'next-context-message', selections: [{ id: before.id, revision: before.revision,
      contentHash: methodContentHash(before), reason: '当前工作需保留原话', sourceIds: [f.source.id] }] });
  assert.ok(f.store.get('method_adoptions', adopted.receipt.adoptionIds[0]).createdSequence > f.delivery.createdSequence);
  assert.equal(methods.catalog({ sessionId })[0].trialUses, 2);
  assert.equal(f.store.get('learning_inputs', f.pendingId), null);
  const input = f.learning.prepare(f.pendingId);
  assert.equal(input.material.boundary.sequence, f.delivery.createdSequence);
  assert.equal(input.material.existingMethods[0].trialUses, 1);
  assert.equal(f.learning.commit(f.pendingId, bind(f)).status, 'completed');
});

test('Learn direct pause preserves the old guidance and atomically creates a reasoned user notification', t => {
  const f = fixture(t, (store, source) => store.save('methods', { ...mRow(source.id), id: 'existing-method',
    status: 'trial', version: 1, maxTrialUses: 3, sourceIds: [source.id], dependencies: refs(source) }));
  const before = f.store.get('methods', 'existing-method'), output = empty();
  output.methods.push(mRow(f.source.id, { operation: 'pause', targetId: before.id, guidance: '新的反馈要求先重新核查适用范围' }));
  assert.equal(f.learning.commit(f.pendingId, bind(f, output)).status, 'completed');
  const method = f.store.get('methods', before.id), notice = f.store.listAll('notifications')[0];
  assert.equal(method.guidance, before.guidance); assert.equal(method.status, 'paused');
  assert.equal(notice.methodRevision, method.revision); assert.equal(notice.reason, method.pauseReason);
  assert.equal(notice.status, 'unread');
});

test('understanding replacement invalidates dependencies across all kinds while independent later sections can commit', t => {
  const f = fixture(t, (store, source) => {
    const old = seedUnderstanding(store, source);
    const dependency = [{ kind: 'understandings', id: old.id, revision: old.revision }];
    store.save('methods', { id: 'old-m', title: '旧方法', guidance: '旧指导', appliesTo: 'a', doesNotApplyTo: 'b',
      status: 'trial', sourceIds: [source.id], dependencies: [...refs(source), ...dependency], trialUses: 1, maxTrialUses: 3 });
    seedGoal(store, source, { dependencies: [...refs(source), ...dependency] });
  });
  const output = empty(); output.understandings.push(uRow(f.source.id, { operation: 'supersede', targetId: 'old-u' }));
  output.methods.push(mRow(f.source.id)); output.goals.push(gRow(f.source.id));
  const result = f.learning.commit(f.pendingId, bind(f, output));
  assert.equal(result.status, 'completed');
  assert.equal(f.store.get('understandings', 'old-u').status, 'superseded');
  assert.equal(f.store.get('methods', 'old-m').status, 'paused');
  assert.equal(f.store.listAll('notifications').filter(row => row.methodId === 'old-m').length, 1);
  assert.equal(f.store.get('goals', 'old-g').useProhibited, true);
  assert.equal(f.store.get('goals', 'old-g').status, 'paused');
  assert.ok(result.sections.understandings.changes.some(ref => ref.kind === 'methods' && ref.id === 'old-m'));
  assert.ok(result.sections.understandings.changes.some(ref => ref.kind === 'goals' && ref.id === 'old-g'));
});

test('a record changed externally after an earlier own section cannot borrow that section exemption', t => {
  const f = fixture(t, seedUnderstanding), output = empty();
  output.understandings.push(uRow(f.source.id, { operation: 'supersede', targetId: 'old-u' }));
  output.methods.push(mRow(f.source.id));
  const run = bind(f, output), commitSection = f.learning.commitSection.bind(f.learning);
  f.learning.commitSection = (input, section, rows) => {
    const value = commitSection(input, section, rows);
    if (section === 'understandings') {
      const old = f.store.get('understandings', 'old-u');
      f.store.save('understandings', { ...old, externalAnnotation: 'changed after commit' }, { expectedRevision: old.revision });
    }
    return value;
  };
  const result = f.learning.commit(f.pendingId, run);
  assert.equal(result.status, 'partial');
  assert.equal(result.sections.understandings.status, 'completed');
  assert.equal(result.sections.methods.error.code, 'source_changed');
  assert.equal(f.store.listAll('methods').length, 0);
});

test('goal definition updates preserve paused user control and version relationship targets independently', t => {
  const f = fixture(t, (store, source) => {
    seedGoal(store, source);
    seedGoal(store, source, { id: 'outer-goal', status: 'tracking', userControl: null,
      relations: [{ type: 'supports', targetId: 'old-g', targetDefinitionVersion: 1, reason: '旧定义',
        sourceIds: [source.id], dependencies: refs(source) }] });
  });
  const output = empty(); output.goals.push(gRow(f.source.id, { operation: 'update', targetId: 'old-g',
    outcome: '更准确的结果定义', controlProposal: 'resume', progress: { content: '本次完成一次澄清', sourceIds: [f.assistantId] } }));
  const result = f.learning.commit(f.pendingId, bind(f, output));
  assert.equal(result.status, 'completed');
  const goal = f.store.get('goals', 'old-g');
  assert.equal(goal.status, 'paused'); assert.equal(goal.userControl.action, 'pause');
  assert.equal(goal.userControl.definitionVersion, 1); assert.equal(goal.definitionVersion, 2);
  assert.equal(goal.controlProposal.action, 'resume');
  assert.equal(f.store.get('goals', 'outer-goal').relations[0].targetDefinitionVersion, 1);
  assert.equal(f.store.listAll('audit').length, 1);
});

test('goal aliases form versioned relationships; cyclic or unsupported relationships roll back the goal section', t => {
  const f = fixture(t), output = empty();
  output.goals.push(gRow(f.source.id, { clientRef: 'new-goal:a' }), gRow(f.source.id, { clientRef: 'new-goal:b',
    relations: [{ type: 'part_of', targetId: 'new-goal:a', reason: '组成关系待确认', sourceIds: [f.source.id] }] }));
  assert.equal(f.learning.commit(f.pendingId, bind(f, output)).status, 'completed');
  const goals = f.store.listAll('goals');
  assert.equal(goals[1].relations[0].targetId, goals[0].id);
  assert.equal(goals[1].relations[0].targetDefinitionVersion, 1);
  assert.equal(goals[1].relations[0].sourceDefinitionVersion, goals[1].definitionVersion);
  const f2 = fixture(t), cyclic = structuredClone(output);
  cyclic.goals[0].relations = [{ type: 'part_of', targetId: 'new-goal:b', reason: '循环', sourceIds: [f2.source.id] }];
  const result = f2.learning.commit(f2.pendingId, bind(f2, cyclic));
  assert.equal(result.sections.goals.status, 'failed'); assert.equal(f2.store.listAll('goals').length, 0);
});

test('goal creation cannot use assistant-only evidence and updates cannot use an unshown or invalidated target', t => {
  const f = fixture(t, (store, source) => seedGoal(store, source, { useProhibited: true,
    sourceInvalidation: { kind: 'source_dependency', reason: 'withdrawn' } }));
  assert.equal(f.learning.prepare(f.pendingId).material.existingGoals.length, 0);
  const output = empty(); output.goals.push(gRow(f.source.id, { operation: 'update', targetId: 'old-g' }));
  assert.equal(f.learning.commit(f.pendingId, bind(f, output)).sections.goals.status, 'failed');
  const f2 = fixture(t), noUser = empty(); noUser.goals.push(gRow(f2.assistantId));
  assert.equal(f2.learning.commit(f2.pendingId, bind(f2, noUser)).sections.goals.status, 'failed');
});

function repairFixture(t) {
  const rpcId = 'repair-current-user';
  return fixture(t, (store, source) => {
    const goal = seedGoal(store, source, { title: '不可再显示的旧标题', outcome: '不可再显示的旧定义',
      useProhibited: true, sourceInvalidation: { kind: 'source_dependency', reason: 'source_changed' } });
    new GoalService({ business: { storage: store } }).bindDiscussion({ sessionId, requestId: rpcId,
      content: content(source.message.content[0].text), goalId: goal.id, expectedRevision: goal.revision,
      definitionVersion: goal.definitionVersion, mode: 'repair', userIdentity: 'browser:owner' });
  }, { kind: 'user', rpcId });
}

test('explicit goal repair freezes metadata and the current original, then saves a full new definition without restoring user control', t => {
  const f = repairFixture(t), input = f.learning.prepare(f.pendingId);
  assert.equal(input.material.existingGoals.length, 1);
  assert.equal(input.material.existingGoals[0].repairOnly, true);
  assert.equal(input.inputText.includes('不可再显示'), false);
  assert.equal(input.material.goalDiscussions[0].sourceId, f.source.id);
  const output = empty(); output.goals.push(gRow(f.source.id, { operation: 'update', targetId: 'old-g',
    title: '本次新澄清', outcome: '用新原话定义的结果', controlProposal: 'resume' }));
  const result = f.learning.commit(f.pendingId, bind(f, output));
  assert.equal(result.status, 'completed');
  const goal = f.store.get('goals', 'old-g');
  assert.equal(goal.id, 'old-g'); assert.equal(goal.useProhibited, false); assert.equal(goal.sourceInvalidation, null);
  assert.equal(goal.status, 'paused'); assert.equal(goal.userControl.action, 'pause');
  assert.equal(goal.definitionVersion, 2); assert.equal(goal.controlProposal.action, 'resume');
  assert.deepEqual(goal.sourceIds, [f.source.id]);
});

test('repair requires the current human source and remains partial on invalid model output', t => {
  const f = repairFixture(t), output = empty();
  output.goals.push(gRow(f.assistantId, { operation: 'update', targetId: 'old-g', outcome: '只有助手提议' }));
  const result = f.learning.commit(f.pendingId, bind(f, output));
  assert.equal(result.status, 'partial'); assert.equal(result.sections.goals.status, 'failed');
  assert.equal(f.store.get('goals', 'old-g').useProhibited, true);
  assert.equal(f.store.get('goals', 'old-g').status, 'paused');
});

test('prompt admission bookkeeping does not alter frozen intent; a real user control during learning still rejects the old output', t => {
  const f = repairFixture(t), output = empty();
  output.goals.push(gRow(f.source.id, { operation: 'update', targetId: 'old-g' }));
  const run = bind(f, output), goals = new GoalService({ business: f.business });
  goals.recordDiscussionAdmission({ bindingId: f.store.listAll('goal_discussions')[0].id, state: 'accepted' });
  assert.equal(f.learning.commit(f.pendingId, run).status, 'completed');
  const other = repairFixture(t), late = bind(other, output), service = new GoalService({ business: other.business });
  const before = other.store.get('goals', 'old-g');
  service.decide({ goalId: before.id, expectedRevision: before.revision, definitionVersion: before.definitionVersion,
    action: 'close', requestId: 'while-learning', userIdentity: 'browser:owner' });
  assert.equal(other.learning.commit(other.pendingId, late).sections.goals.error.code, 'source_changed');
  assert.equal(other.store.get('goals', 'old-g').status, 'closed');
});

function linkForLearning(store, source) {
  const goals = new GoalService({ business: { storage: store } });
  if (!store.get('goals', 'old-g')) seedGoal(store, source, { status: 'tracking', userControl: null });
  if (!store.get('host_bindings', sessionId)) store.save('host_bindings', { id: sessionId, role: 'main', sessionId });
  const cutoffSequence = store.currentSequence(), entries = goals.catalog({ sessionId, cutoffSequence, inputMessageIds: ['human'] });
  store.save('context_snapshots', { id: 'learning-goal-snapshot', sessionId, turn: 1, contextMessageId: 'learning-goal-context',
    material: { sessionId, turn: 1, cutoffSequence, inputMessageIds: ['human'], goals: entries } });
  const shown = entries[0];
  const result = goals.link({ sessionId, turn: 1, startSeq: 0, callId: 'native-goal-call',
    contextSnapshotId: 'learning-goal-snapshot', contextMessageId: 'learning-goal-context',
    selection: { id: shown.id, revision: shown.revision, definitionVersion: shown.definitionVersion,
      contentHash: shown.contentHash, reason: '本轮只澄清结果，不证明实现。', sourceIds: shown.sourceIds } });
  return { goals, linkId: result.receipt.linkId };
}

test('learning joins a pre-delivery immutable association with its later exact delivery outcome, without admitting post-delivery links', t => {
  let linked;
  const f = fixture(t, (store, source) => { linked = linkForLearning(store, source); });
  const before = f.store.get('goal_links', linked.linkId);
  const outcome = linked.goals.settleTurn({ sessionId, turn: 1, startSeq: 0, outcome: 'completed', deliveryId: f.delivery.id })[0];
  assert.ok(before.createdSequence < f.delivery.createdSequence);
  assert.ok(outcome.createdSequence > f.delivery.createdSequence);
  const input = f.learning.prepare(f.pendingId);
  assert.equal(input.material.goalLinks.length, 1);
  assert.equal(input.material.goalLinks[0].deliveryId, f.delivery.id);
  assert.equal(input.material.goalLinks[0].selection.reason, before.selection.reason);
  assert.equal(input.material.goalLinks[0].contributionEffect, 'not_assessed');
  assert.deepEqual(f.store.get('goal_links', linked.linkId), before);
  assert.equal(f.learning.commit(f.pendingId, bind(f)).status, 'completed');
  const late = fixture(t), lateLink = linkForLearning(late.store, late.source);
  lateLink.goals.settleTurn({ sessionId, turn: 1, startSeq: 0, outcome: 'completed', deliveryId: late.delivery.id });
  assert.deepEqual(late.learning.prepare(late.pendingId).material.goalLinks, []);
});

test('reuse of a cancelled opportunity only links the original and never requeues work', t => {
  const f = fixture(t, (store, source) => store.save('opportunities', {
    id: 'old-opportunity', conversationId: sessionId, status: 'dismissed', preparationStatus: 'cancelled',
    description: '旧的准备', rationale: '原理由', suggestedPreparation: '原范围', sourceIds: [source.id], dependencies: refs(source) }));
  const output = empty(); output.opportunities.push({ operation: 'reuse', targetId: 'old-opportunity',
    description: '', rationale: '', suggestedPreparation: '', sourceIds: [] });
  const result = f.learning.commit(f.pendingId, bind(f, output));
  assert.equal(result.status, 'completed');
  assert.equal(f.store.get('opportunities', 'old-opportunity').revision, 1);
  assert.equal(f.store.get('opportunities', 'old-opportunity').status, 'dismissed');
  assert.equal(f.store.listAll('jobs').length, 0);
});

// Synthetic shape only: no private request, response text or source identity is included.
test('action contract rejects all five invented create targets without cleaning the original', () => {
  const output = empty();
  output.understandings = Array.from({ length: 4 }, (_, index) => uRow('fixture-source', {
    targetId: `invented-understanding-${index}`, content: `Synthetic observation ${index}`,
  }));
  output.methods = [mRow('fixture-source', { targetId: 'invented-method' })];
  const original = JSON.stringify(output), parsed = parseLearn(original);
  assert.deepEqual(Object.values(parsed.issues).flat().map(issue => issue.path), [
    'understandings[0].targetId', 'understandings[1].targetId',
    'understandings[2].targetId', 'understandings[3].targetId', 'methods[0].targetId',
  ]);
  assert.equal(JSON.stringify(parsed.value), original);
  assert.equal(JSON.stringify(output), original);
});

const actionRows = { understandings: uRow, methods: mRow, opportunities: oRow, goals: gRow };

test('every create action requires an exact empty target, including missing and wrong-type values', () => {
  for (const [section, make] of Object.entries(actionRows)) {
    const valid = empty(); valid[section] = [make('fixture-source')];
    assert.deepEqual(parseLearn(JSON.stringify(valid)).issues[section], []);
    for (const targetId of ['invented', 'new-goal:alias', ' ', '\n', null, 7, {}, [], undefined]) {
      const output = empty(); output[section] = [make('fixture-source', { targetId })];
      const raw = JSON.stringify(output), parsed = parseLearn(raw);
      assert.ok(parsed.issues[section].some(issue => issue.path === `${section}[0].targetId`), `${section}: ${String(targetId)}`);
      assert.equal(JSON.stringify(parsed.value), raw);
    }
  }
});

test('existing-record actions require nonblank IDs; goal aliases are separate from durable targets', () => {
  const actions = { understandings: ['supersede', 'withdraw'], methods: ['revise', 'pause'], opportunities: ['reuse'], goals: ['update'] };
  for (const [section, operations] of Object.entries(actions)) for (const operation of operations) {
    for (const targetId of ['', ' \n ', null, {}, undefined, 'x'.repeat(201)]) {
      const output = empty(); output[section] = [actionRows[section]('fixture-source', { operation, targetId })];
      assert.ok(parseLearn(JSON.stringify(output)).issues[section].some(issue => issue.path === `${section}[0].targetId`));
    }
    const output = empty(); output[section] = [actionRows[section]('fixture-source', { operation, targetId: 'visible-record' })];
    assert.deepEqual(parseLearn(JSON.stringify(output)).issues[section], []);
  }
  for (const [operation, targetId, clientRef, accepted] of [
    ['create', '', '', true], ['create', '', 'new-goal:child', true],
    ['create', '', 'child', false], ['create', '', ' new-goal:child', false], ['create', '', '\n', false],
    ['create', '', null, false], ['create', '', 'new-goal:' + 'x'.repeat(200), false],
    ['update', 'visible-goal', '', true], ['update', 'visible-goal', 'new-goal:child', false],
  ]) {
    const output = empty(); output.goals = [gRow('fixture-source', { operation, targetId, clientRef })];
    const issues = parseLearn(JSON.stringify(output)).issues.goals;
    assert.equal(issues.length === 0, accepted, JSON.stringify({ operation, targetId, clientRef }));
    if (!accepted) assert.ok(issues.some(issue => issue.path === 'goals[0].clientRef'));
  }
});

test('model instructions and identifier examples use the exact executable action schema; closed fields remain closed', () => {
  const printed = LEARN_PROMPT.split('合同：').at(-1).split('\n空形状：')[0];
  assert.deepEqual(JSON.parse(printed), LEARN_SCHEMA);
  assert.ok(LEARN_PROMPT.includes(LEARN_ACTION_INSTRUCTIONS));
  assert.ok(LEARN_PROMPT.includes(JSON.stringify(LEARN_ACTION_EXAMPLES)));
  for (const [section, fragments] of Object.entries(LEARN_ACTION_EXAMPLES)) for (const fragment of fragments) {
    assert.ok(LEARN_ACTION_INSTRUCTIONS.includes(`${section}.${fragment.operation}：targetId `));
    const output = empty(); output[section] = [actionRows[section]('fixture-source', fragment)];
    assert.deepEqual(parseLearn(JSON.stringify(output)).issues[section], []);
  }
  const output = empty(); output.methods = [mRow('fixture-source', { confirmed: true })];
  assert.ok(parseLearn(JSON.stringify(output)).issues.methods.some(issue => issue.path === 'methods[0].confirmed'));
  output.methods = [mRow('fixture-source', { operation: 'invented-operation' })];
  assert.ok(parseLearn(JSON.stringify(output)).issues.methods.some(issue => issue.path === 'methods[0].operation'));
  output.methods = [mRow('fixture-source', { guidance: 'x'.repeat(4001) })];
  assert.ok(parseLearn(JSON.stringify(output)).issues.methods.some(issue => issue.path === 'methods[0].guidance'));
  assert.throws(() => parseLearn('```json\n{}\n```'), hasCode('invalid_output'));
});

test('each malformed action section fails without writes while the other three commit and exact partial replay is inert', t => {
  for (const rejected of Object.keys(actionRows)) {
    const f = fixture(t), output = empty();
    for (const [section, make] of Object.entries(actionRows)) output[section] = [make(f.source.id)];
    output[rejected].push(actionRows[rejected](f.source.id, { targetId: 'invented-create-target' }));
    const run = bind(f, output), result = f.learning.commit(f.pendingId, run);
    assert.equal(result.status, 'partial');
    for (const section of Object.keys(actionRows)) {
      assert.equal(result.sections[section].status, section === rejected ? 'failed' : 'completed');
      assert.equal(f.store.listAll(section).length, section === rejected ? 0 : 1);
    }
    const failed = result.sections[rejected];
    assert.deepEqual(failed.ids, []); assert.deepEqual(failed.changes, []);
    assert.equal(failed.error.code, 'invalid_output');
    assert.ok(failed.error.details.some(issue => issue.path === `${rejected}[1].targetId`));
    assert.equal(f.store.get('learning_outputs', f.pendingId).rawText, run.rawText);
    assert.equal(f.store.listAll('jobs').length, 0);
    assert.equal(f.store.listAll('learning_runs').length, 1);
    const seq = f.store.currentSequence();
    assert.deepEqual(f.learning.commit(f.pendingId, run), result);
    assert.equal(f.store.currentSequence(), seq);
  }
});

test('syntactically valid existing IDs still require displayed records and aliases still require valid relationships', t => {
  const f = fixture(t), output = empty();
  output.understandings = [uRow(f.source.id, { operation: 'supersede', targetId: 'not-shown' })];
  output.methods = [mRow(f.source.id, { operation: 'revise', targetId: 'not-shown' })];
  output.opportunities = [oRow(f.source.id, { operation: 'reuse', targetId: 'not-shown', description: '', rationale: '', suggestedPreparation: '', sourceIds: [] })];
  output.goals = [gRow(f.source.id, { operation: 'update', targetId: 'not-shown' })];
  assert.ok(Object.values(parseLearn(JSON.stringify(output)).issues).every(issues => issues.length === 0));
  const result = f.learning.commit(f.pendingId, bind(f, output));
  assert.equal(result.status, 'failed');
  for (const section of Object.keys(actionRows)) {
    assert.equal(result.sections[section].error.code, 'learning_conflict');
    assert.equal(f.store.listAll(section).length, 0);
  }
  for (const duplicate of [false, true]) {
    const local = fixture(t), proposed = empty();
    proposed.goals = [gRow(local.source.id, { clientRef: 'new-goal:parent' }), gRow(local.source.id, {
      clientRef: duplicate ? 'new-goal:parent' : 'new-goal:child',
      relations: duplicate ? [] : [{ type: 'part_of', targetId: 'new-goal:missing', reason: 'Synthetic relation', sourceIds: [local.source.id] }],
    })];
    assert.deepEqual(parseLearn(JSON.stringify(proposed)).issues.goals, []);
    assert.equal(local.learning.commit(local.pendingId, bind(local, proposed)).sections.goals.status, 'failed');
    assert.equal(local.store.listAll('goals').length, 0);
  }
});
