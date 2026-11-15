import { createHash } from 'node:crypto';
import { canonicalJson } from './store.mjs';
import { sourceAvailable, hash as sourceHash } from './evidence.mjs';

const digest = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const reject = message => { throw Object.assign(new Error(message), { code: 'ARCFOLD_NATIVE_CONTINUATION_INVALID' }); };
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const positive = value => Number.isSafeInteger(value) && value > 0;
const text = message => (message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('');
const goalMessages = messages => messages.filter(message => message.source?.kind === 'goal' && message.source.round > 0);

function ref(store, sessionId, event) {
  const rows = store.listAll('dsh_events', { where: { sessionId, seq: event.seq } });
  if (rows.length !== 1 || rows[0].sha256 !== digest(event) || rows[0].type !== event.type)
    reject('Delegation needs its exact durable native event index');
  return { id: rows[0].id, sessionId, seq: event.seq, type: event.type, sha256: digest(event) };
}
function commandOrigin(events, change) {
  const matches = [];
  for (const run of events.filter(event => event.type === 'command/run' && event.seq < change.seq &&
      event.data.name === 'goal' && event.data.source?.kind === 'user')) {
    const dones = events.filter(event => event.type === 'command/done' && event.data.commandId === run.data.commandId);
    if (dones.length !== 1 || dones[0].seq < change.seq || dones[0].data.kind !== 'success') continue;
    const changes = events.filter(event => event.type === 'goal/change' && event.seq > run.seq && event.seq < dones[0].seq);
    if (changes.length === 1 && changes[0] === change) matches.push({ kind: 'native-command', actor: 'user',
      command: run.data, events: [run, change, dones[0]], inputEvents: [] });
  }
  return matches;
}
function toolOrigin(events, change, actions = ['create', 'edit']) {
  const matches = [];
  for (const call of events.filter(event => event.type === 'tool/call' && event.seq < change.seq &&
      ['create_goal', 'update_goal', 'arcfold_start_work', 'arcfold_revise_work', 'arcfold_decide_work'].includes(event.data.name))) {
    let args;
    try { args = JSON.parse(call.data.arguments); } catch { continue; }
    const action = ['create_goal', 'arcfold_start_work'].includes(call.data.name) ? 'create'
      : call.data.name === 'arcfold_revise_work' ? 'edit'
      : call.data.name === 'arcfold_decide_work' && args.action === 'wait' ? 'pause'
      : args.action === 'blocked' ? 'block' : args.action;
    if (!actions.includes(action) || action !== change.data.operation) continue;
    if (action === 'create' && args.objective?.trim() !== change.data.goal.objective) continue;
    if (action !== 'create' && (args.goal_id !== change.data.goal.id || args.revision + 1 !== change.data.goal.revision)) continue;
    if (action === 'edit' && args.objective !== undefined && args.objective.trim() !== change.data.goal.objective) continue;
    const results = events.filter(event => event.type === 'tool/result' && event.data.message?.toolCallId === call.data.callId);
    if (results.length !== 1 || results[0].seq <= change.seq || results[0].data.message.isError ||
        results[0].data.error || !same(results[0].sourceEventSeqs, [call.seq])) continue;
    let result;
    try { result = JSON.parse(text(results[0].data.message)); } catch { continue; }
    if (!result?.goal || !Object.entries(change.data.goal).every(([key, value]) => same(result.goal[key], value))) continue;
    const assistants = events.filter(event => event.type === 'assistant/message' && event.seq < call.seq &&
      event.data.turn === call.data.turn && event.data.step === call.data.step &&
      event.data.message?.role === 'assistant' && event.data.message.source?.kind === 'model' &&
      event.data.message.content.some(block => block.type === 'tool-call' && block.id === call.data.callId &&
        block.name === call.data.name && block.arguments === call.data.arguments));
    if (assistants.length !== 1) continue;
    const competing = events.filter(event => event.type === 'goal/change' && event.seq > call.seq && event.seq < results[0].seq);
    if (competing.length !== 1 || competing[0] !== change) continue;
    const start = events.findLast(event => event.seq < call.seq && event.type === 'turn/start');
    if (!start || start.data.turn !== call.data.turn) continue;
    const inputEvents = events.filter(event => event.seq > start.seq && event.seq < call.seq && event.type === 'user/message' &&
      event.data.role === 'user' && event.data.source?.kind === 'user' && event.data.source.principal === undefined);
    if (['create', 'edit'].includes(action) && !inputEvents.length) continue;
    matches.push({ kind: 'native-goal-tool', actor: 'model', callId: call.data.callId, arguments: args,
      events: [start, ...inputEvents, assistants[0], call, change, results[0]], inputEvents });
  }
  return matches;
}
function originalSources(store, sessionId, inputEvents) {
  return inputEvents.map(event => {
    const sources = store.listAll('events', { where: { sessionId } })
      .filter(source => source.message?.id === event.data.id && same(source.message, event.data));
    if (sources.length !== 1 || !sourceAvailable(store, sources[0])) reject('Original delegation input is missing or unavailable');
    const source = sources[0];
    return { id: source.id, revision: source.revision, messageHash: digest(source.message),
      occurredAt: source.occurredAt, role: source.role };
  });
}

/** Exact original creation, reusable for business-only work indexing after native flush. */
export function nativeGoalOrigin({ store, sessionId, events, goalId }) {
  const creates = events.filter(e => e.type === 'goal/change' && e.data.operation === 'create' && e.data.goal?.id === goalId);
  if (creates.length !== 1) return null;
  const origins = [...commandOrigin(events, creates[0]), ...toolOrigin(events, creates[0], ['create'])];
  if (origins.length !== 1) return null;
  const origin = origins[0];
  return { ...origin, inputs: originalSources(store, sessionId, origin.inputEvents) };
}

/** Freeze provenance, never activation or a second execution state. */
export function freezeNativeContinuation({ store, sessionId, turn, messages, events, goal, stage = null }) {
  const submitted = goalMessages(messages);
  if (!submitted.length) return null;
  if (submitted.length !== 1) reject('A native round has more than one goal message');
  const message = submitted[0], source = message.source;
  if (!positive(source.revision) || !positive(source.round) || message.role !== 'user' ||
      !goal || goal.id !== source.goalId || goal.revision !== source.revision ||
      goal.phase !== 'active' || goal.activation !== 'armed' || source.round !== goal.roundsStarted + 1)
    reject('The native round does not own the current active and armed goal');
  const start = events.findLast(event => event.type === 'turn/start');
  if (!start || start.data.turn !== turn || events.some(event => event.seq > start.seq && event.type === 'turn/end'))
    reject('A native continuation needs the current open turn');
  const insertions = events.flatMap(event => event.type === 'agent/inbox/spliced'
    ? (event.data.inserted || []).flatMap((input, index) => input.id === message.id ? [{ event, input, index }] : []) : []);
  if (insertions.length !== 1 || !same(insertions[0].input, message)) reject('Native goal message has no unique durable original');
  const chain = events.filter(event => event.type === 'goal/change' && event.data.goal?.id === source.goalId);
  if (!chain.length || chain[0].data.operation !== 'create' || chain[0].data.goal.revision !== 1 ||
      chain.at(-1).data.goal.revision !== source.revision ||
      chain.some((event, index) => event.data.goal.revision !== index + 1))
    reject('The delegated goal definition chain is missing, stale or discontinuous');
  const origins = [...commandOrigin(events, chain[0]), ...toolOrigin(events, chain[0], ['create'])];
  if (origins.length !== 1) reject('The goal has no unique original command or successful create_goal delegation');
  const origin = origins[0];
  let activeOrigin = origin;
  if (stage) {
    const candidates = chain.flatMap(change => toolOrigin(events, change)).filter(candidate => candidate.callId === stage.origin.callId);
    if (candidates.length !== 1 || stage.sessionId !== sessionId || stage.nativeGoalId !== goal.id || stage.nativeRevision !== goal.revision)
      reject('The current Arcfold stage has no exact successful native definition receipt');
    activeOrigin = candidates[0];
  }
  const activeInputs = stage ? activeOrigin.inputEvents.filter(event => stage.sourceRefs.some(reference =>
    store.get('events', reference.id)?.message?.id === event.data.id)) : activeOrigin.inputEvents;
  if (stage && !activeInputs.length) reject('The current stage has no owner source in its successful definition call');
  const inputs = originalSources(store, sessionId, activeInputs);
  if (stage) for (const reference of stage.sourceRefs) {
    const row = store.get('events', reference.id);
    if (!sourceAvailable(store, row) || row.revision !== reference.revision || sourceHash(row.message) !== reference.messageHash)
      reject('The current Arcfold stage source changed');
    if (!inputs.some(input => input.id === reference.id)) inputs.push({ id: row.id, revision: row.revision,
      messageHash: digest(row.message), occurredAt: row.occurredAt, role: row.role });
  }
  const initialIds = store.listAll('events', { where: { sessionId } }).filter(row =>
    origin.inputEvents.some(event => row.message?.id === event.data.id && same(row.message, event.data))).map(row => row.id);
  const nativeEvents = [...new Map([...origin.events, ...activeOrigin.events, ...chain, insertions[0].event, start].map(event => [event.seq, event])).values()]
    .sort((a, b) => a.seq - b.seq).map(event => ref(store, sessionId, event));
  const proof = { kind: 'native-goal-continuation', sessionId, turn,
    goalId: source.goalId, revision: source.revision, round: source.round,
    messageId: message.id, messageHash: digest(message), inboxRef: { seq: insertions[0].event.seq, index: insertions[0].index },
    cutoff: { throughSeq: events.at(-1).seq },
    initialDelegation: { kind: origin.kind, actor: origin.actor,
      ...(origin.command ? { command: origin.command } : { callId: origin.callId }),
      sourceIds: initialIds },
    ...(stage ? { activeDelegation: { kind: 'arcfold-stage', stageId: stage.id, definitionVersion: stage.definitionVersion,
      sourceIds: inputs.map(row => row.id), eventIds: activeOrigin.events.map(event => ref(store, sessionId, event).id) } } : {}),
    // UI controls do not emit a command/user message. Keep native facts and say
    // the actor was not recorded; never manufacture a fresh user authorization.
    definitionChain: chain.map(event => ({ seq: event.seq, goalId: event.data.goal.id,
      revision: event.data.goal.revision, operation: event.data.operation,
      attribution: event === chain[0] ? origin.kind : 'native_control', actor: event === chain[0] ? origin.actor : 'unrecorded' })),
    currentDefinition: { ...chain.at(-1).data.goal },
    originalInputs: inputs, nativeEvents,
    authority: 'historical-delegation-and-native-control-facts; not-current-user-input-or-long-term-goal-control' };
  return { ...proof, proofHash: digest(proof) };
}

/** Historical facts stay intact even after future use of their sources is withdrawn. */
export function assertNativeContinuationIntegrity(store, proof) {
  const { proofHash, ...body } = proof;
  if (proof.kind !== 'native-goal-continuation' || digest(body) !== proofHash) reject('Native continuation proof changed');
  for (const reference of proof.nativeEvents) {
    const row = store.get('dsh_events', reference.id);
    if (!row || row.sessionId !== proof.sessionId || row.seq !== reference.seq || row.type !== reference.type ||
        row.sha256 !== reference.sha256) reject('Native delegation original changed');
  }
  for (const input of proof.originalInputs) {
    const source = store.get('events', input.id);
    if (!source || source.sessionId !== proof.sessionId || source.revision !== input.revision ||
        digest(source.message) !== input.messageHash)
      reject('Original delegation input changed');
  }
  return proof;
}

/** Current reuse (including Learn) still requires all original sources to be available. */
export function assertNativeContinuationStored(store, proof) {
  assertNativeContinuationIntegrity(store, proof);
  for (const reference of proof.nativeEvents) {
    if (proof.activeDelegation && !proof.activeDelegation.eventIds.includes(reference.id)) continue;
    const control = store.get('source_controls', reference.id);
    if (control?.withdrawn || control?.useProhibited) reject('Native delegation original was withdrawn');
  }
  for (const input of proof.originalInputs)
    if (!sourceAvailable(store, store.get('events', input.id))) reject('Original delegation input was withdrawn');
  return proof;
}

/** A synchronous final-send check; the official driver still owns scheduling. */
export function assertNativeContinuationCurrent({ store, proof, events, agent, goal, messages, historical = false }) {
  if (historical) assertNativeContinuationIntegrity(store, proof);
  else assertNativeContinuationStored(store, proof);
  if (!agent || agent.id !== proof.sessionId || agent.status !== 'running') reject('Native continuation Agent is not current');
  for (const reference of proof.nativeEvents) {
    const event = events.find(row => row.seq === reference.seq);
    if (!event || digest(event) !== reference.sha256) reject('Native delegation prefix changed');
  }
  const start = events.findLast(event => event.type === 'turn/start');
  if (!start || start.data.turn !== proof.turn || events.some(event => event.seq > start.seq && event.type === 'turn/end'))
    reject('Native continuation turn is no longer open');
  const entered = events.filter(event => event.seq > start.seq && event.type === 'user/message' && event.data.id === proof.messageId);
  const sent = messages.filter(message => message.id === proof.messageId);
  if (entered.length !== 1 || sent.length !== 1 || digest(entered[0].data) !== proof.messageHash ||
      digest(sent[0]) !== proof.messageHash) reject('Native goal message was not admitted unchanged');
  // A new owner input or its successful Arcfold transition supersedes the old
  // automatic admission. GoalExecution checks the new stage before every send/tool.
  if (historical) return;
  if (goal?.id === proof.goalId && goal.revision === proof.revision && goal.phase === 'active' &&
      goal.activation === 'armed' && goal.roundsStarted === proof.round) return;
  // Completing/blocking inside this same round may need a final answer step.
  // It does not authorize any next automatic round or a definition edit.
  const latest = events.findLast(event => event.type === 'goal/change');
  const terminals = latest?.seq > start.seq && latest.data.goal?.id === proof.goalId &&
    latest.data.goal.revision === proof.revision + 1 && ['complete', 'block', 'pause'].includes(latest.data.operation)
    ? toolOrigin(events, latest, ['complete', 'block', 'pause']).filter(origin => latest.data.operation !== 'pause' ||
      events.some(event => event.type === 'tool/call' && event.data.callId === origin.callId && event.data.name === 'arcfold_decide_work')) : [];
  if (terminals.length === 1 && goal?.id === proof.goalId && same(goal.phase, latest.data.goal.phase) &&
      goal.revision === latest.data.goal.revision && goal.roundsStarted === proof.round) return;
  reject('Native goal authority changed before dispatch');
}
