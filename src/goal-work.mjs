// Goal/work associations are background interpretations, never a scheduler.
import { createHash } from 'node:crypto';
import { canonicalJson, DomainError } from './store.mjs';
import { nativeGoalOrigin } from './native-continuation.mjs';
import { sourceAvailable, dependenciesCurrent } from './evidence.mjs';
import { hasSuccessfulGoalReceipt } from './goal-context.mjs';
const hash = x => createHash('sha256').update(canonicalJson(x)).digest('hex');
const copy = x => structuredClone(x);
const fail = message => { throw new DomainError('goal_work_changed', message); };
export const workId = (sessionId, nativeGoalId) => 'goal-work-' + hash([sessionId, nativeGoalId]);
export const nativeDefinitionHash = goal => hash({ objective: goal.objective, maxGoalRounds: goal.maxGoalRounds });
const captureCursors = new WeakMap();
const coreOf = ({ revision, createdAt, updatedAt, createdSequence, updatedSequence, ...core }) => core;
function immutable(store, kind, value) {
  const old = store.get(kind, value.id);
  if (old) { if (canonicalJson(coreOf(old)) !== canonicalJson(value)) fail('工作原件身份冲突。'); return old; }
  return store.save(kind, value);
}
function nativeRef(store, sessionId, event) {
  const rows = store.listAll('dsh_events', { where: { sessionId, seq: event.seq } });
  if (rows.length !== 1 || rows[0].sha256 !== hash(event)) fail('工作缺少已持久保存的原生原件。');
  return { id: rows[0].id, seq: event.seq, sha256: rows[0].sha256, type: event.type };
}
export function assertWork(store, work) {
  if (!work) fail('工作不存在。');
  for (const ref of work.nativeEvents) {
    const row = store.get('dsh_events', ref.id);
    if (!row || row.sessionId !== work.sessionId || row.seq !== ref.seq || row.sha256 !== ref.sha256 ||
        store.get('source_controls', ref.id)?.withdrawn || store.get('source_controls', ref.id)?.useProhibited)
      fail('工作的原生委托来源已经变化或撤回。');
  }
  for (const ref of work.sourceRefs) {
    const row = store.get('events', ref.id);
    if (!sourceAvailable(store, row) || row.revision !== ref.revision || hash(coreOf(row)) !== ref.hash)
      fail('工作的原话来源已经变化或撤回。');
  }
  return work;
}
export function workState(store, id, cutoff = store.currentSequence()) {
  return store.listAll('goal_work_observations', { where: { workId: id } })
    .filter(row => row.createdSequence <= cutoff).sort((a, b) => a.nativeSeq - b.nativeSeq).at(-1) ?? null;
}
export function workRelation(store, id, cutoff = store.currentSequence()) {
  return store.listAll('goal_work_links', { where: { workId: id } })
    .filter(row => row.createdSequence <= cutoff).sort((a, b) => a.createdSequence - b.createdSequence).at(-1) ?? null;
}
export function relationState(store, work, relation, state) {
  if (!relation) return null;
  const goal = store.get('goals', relation.goalId);
  let status = 'current';
  try { assertWork(store, work); } catch { status = 'unavailable'; }
  if (!goal || goal.withdrawn || goal.deleted || goal.useProhibited ||
      !dependenciesCurrent(store, { ...goal, status: 'active' }, store.currentSequence()) ||
      relation.sourceRefs.some(ref => {
        const row = store.get('events', ref.id);
        return !sourceAvailable(store, row) || row.revision !== ref.revision;
      })) status = 'unavailable';
  else if (status === 'current' && (goal.definitionVersion !== relation.definitionVersion ||
      state?.definitionHash !== relation.nativeDefinitionHash)) status = 'needs_review';
  return { goalId: relation.goalId, definitionVersion: relation.definitionVersion, reason: status === 'unavailable' ? '' : relation.reason,
    state: status, claimType: 'inference', relationId: relation.id };
}
export function linkWork(store, { work, goal, state, reason, sourceIds, origin, expectedRelationId }) {
  assertWork(store, work);
  if (!goal || !reason?.trim() || !sourceIds?.length || new Set(sourceIds).size !== sourceIds.length)
    fail('工作联系需要完整目标、理由与原件。');
  if (goal.scope?.conversationId && goal.scope.conversationId !== work.sessionId) fail('工作与目标不在同一范围。');
  if (expectedRelationId !== undefined && (workRelation(store, work.id)?.id ?? null) !== expectedRelationId)
    fail('学习期间已有更新的工作联系，旧结果不能覆盖。');
  const latest = workState(store, work.id);
  if (!state || !latest || state.definitionHash !== latest.definitionHash) fail('工作定义已经变化。');
  const sourceRefs = sourceIds.map(id => {
    const row = store.get('events', id);
    if (!sourceAvailable(store, row)) fail('联系来源已不可用。');
    return { id, revision: row.revision };
  });
  const id = 'work-link-' + hash([work.id, origin]);
  return immutable(store, 'goal_work_links', { id, workId: work.id, sessionId: work.sessionId,
    goalId: goal.id, definitionVersion: goal.definitionVersion, nativeGoalId: work.nativeGoalId,
    nativeRevision: state.nativeRevision, nativeDefinitionHash: state.definitionHash, reason, sourceRefs, origin,
    authority: 'model-association-only; no-new-work-or-control' });
}
/** Called only after the existing native durable-prefix barrier, including turn-end reconciliation. */
export function captureWorks(store, sessionId, events) {
  let cursors = captureCursors.get(store);
  if (!cursors) captureCursors.set(store, cursors = new Map());
  const tail = events.at(-1)?.seq ?? -1;
  if (cursors.get(sessionId) === tail) return;
  for (const created of events.filter(e => e.type === 'goal/change' && e.data.operation === 'create')) {
    const nativeGoalId = created.data.goal?.id;
    if (!nativeGoalId) continue;
    const id = workId(sessionId, nativeGoalId);
    let work = store.get('goal_works', id);
    if (!work) {
      let origin;
      try { origin = nativeGoalOrigin({ store, sessionId, events, goalId: nativeGoalId }); }
      catch (error) { if (error.code !== 'ARCFOLD_NATIVE_CONTINUATION_INVALID') throw error; continue; }
      if (!origin) continue; // Unfinished/ambiguous originals remain visible as unverified work.
      const sourceIds = origin.inputs.map(row => row.id);
      if (origin.kind === 'native-command') {
        const event = origin.events.find(e => e.type === 'command/run');
        const ref = nativeRef(store, sessionId, event);
        const source = immutable(store, 'events', { id: 'goal-command-source-' + hash([sessionId, event.seq]),
          sessionId, conversationId: sessionId, role: 'user', author: 'user',
          content: event.data.args, occurredAt: new Date(event.time).toISOString(),
          provenance: { kind: 'native_user_command', sourceRef: { sessionId, ...ref },
            command: event.data.name, commandId: event.data.commandId } });
        sourceIds.push(source.id);
      }
      work = immutable(store, 'goal_works', { id, sessionId, nativeGoalId,
        createSeq: created.seq, originKind: origin.kind,
        nativeEvents: origin.events.map(e => nativeRef(store, sessionId, e)),
        sourceIds, sourceRefs: sourceIds.map(id => {
          const row = store.get('events', id); return { id, revision: row.revision, hash: hash(coreOf(row)) };
        }), authority: 'verified-native-delegation; association-not-yet-inferred' });
    }
    const previous = workState(store, id);
    let state = previous && { id: nativeGoalId, revision: previous.nativeRevision, objective: previous.objective,
      phase: previous.phase, maxGoalRounds: previous.maxGoalRounds, blockedReason: previous.blockedReason }, roundsStarted = previous?.roundsStarted ?? 0;
    for (const event of events.filter(e => e.seq > (previous?.nativeSeq ?? -1))) {
      if (event.type === 'goal/change' && event.data.goal?.id === nativeGoalId) {
        state = { ...event.data.goal }; roundsStarted = event.data.roundsStarted ?? roundsStarted;
      } else if (event.type === 'goal/change' && event.data.cleared?.id === nativeGoalId) {
        if (state) state = { ...state, revision: event.data.cleared.revision, phase: 'cleared' }; else continue;
      } else if (event.type === 'user/message' && event.data.source?.kind === 'goal' &&
          event.data.source.goalId === nativeGoalId) {
        if (!state) continue; roundsStarted = Math.max(roundsStarted, event.data.source.round);
      } else continue;
      immutable(store, 'goal_work_observations', { id: 'work-observation-' + hash([id, event.seq]),
        workId: id, sessionId, nativeSeq: event.seq, nativeRef: nativeRef(store, sessionId, event),
        nativeGoalId, nativeRevision: state.revision, objective: state.objective, phase: state.phase,
        maxGoalRounds: state.maxGoalRounds, roundsStarted, definitionHash: nativeDefinitionHash(state),
        ...(state.phase === 'blocked' && state.blockedReason ? { blockedReason: copy(state.blockedReason) } : {}) });
    }
    for (const link of store.listAll('goal_links', { where: { sessionId } })) {
      const start = events.find(e => e.seq === link.startSeq && e.type === 'turn/start');
      if (!start || !hasSuccessfulGoalReceipt(events, link)) continue;
      const endSeq = events.find(e => e.seq > start.seq && e.type === 'turn/end')?.seq ?? Infinity;
      const belongs = created.seq > start.seq && created.seq < endSeq || events.some(e => e.seq > start.seq &&
        e.seq < endSeq && e.type === 'user/message' && e.data.source?.kind === 'goal' && e.data.source.goalId === nativeGoalId);
      if (!belongs) continue;
      const relationId = 'work-link-' + hash([id, { kind: 'native_goal_selection', linkId: link.id }]);
      if (store.get('goal_work_links', relationId)) continue;
      const goal = store.get('goals', link.goalId);
      if (goal?.definitionVersion !== link.definitionVersion) continue;
      const receiptSeq = events.find(e => e.type === 'tool/result' && e.data.message?.toolCallId === link.callId)?.seq;
      const atSelection = store.listAll('goal_work_observations', { where: { workId: id } })
        .filter(row => row.nativeSeq <= Math.max(created.seq, receiptSeq ?? -1))
        .sort((a, b) => a.nativeSeq - b.nativeSeq).at(-1);
      try { linkWork(store, { work, goal, state: atSelection, reason: link.selection.reason,
        sourceIds: link.selection.sourceIds, origin: { kind: 'native_goal_selection', linkId: link.id } }); }
      catch (error) { if (error.code !== 'goal_work_changed') throw error; }
    }
  }
  if (store.depth === 0) cursors.set(sessionId, tail);
}
export function worksForDelivery(store, delivery) {
  const cutoff = delivery.createdSequence;
  return store.listAll('goal_works', { where: { sessionId: delivery.sessionId } }).filter(work =>
    work.createdSequence <= cutoff && (delivery.nativeContinuation?.goalId === work.nativeGoalId ||
      store.listAll('goal_work_observations', { where: { workId: work.id } }).some(row =>
        row.createdSequence <= cutoff && row.nativeSeq > delivery.startSeq && row.nativeSeq <= delivery.throughSeq)))
    .map(work => ({ ...copy(work), state: workState(store, work.id, cutoff),
      relationId: workRelation(store, work.id, cutoff)?.id ?? null }));
}
export function workViews(store, sessionId, native = null, goalId = null, limit = 20) {
  const known = store.listAll('goal_works', { where: { sessionId } }).reverse();
  const views = known.flatMap(work => {
    const state = workState(store, work.id), relation = workRelation(store, work.id);
    if (goalId && relation?.goalId !== goalId || !state) return [];
    let valid = true; try { assertWork(store, work); } catch { valid = false; }
    const current = native?.id === work.nativeGoalId ? native : null;
    return [{ id: work.id, sessionId, nativeGoalId: work.nativeGoalId,
      objective: current?.objective ?? state.objective, nativeRevision: current?.revision ?? state.nativeRevision,
      phase: current?.phase ?? state.phase, activation: current?.activation ?? 'unavailable',
      blockedReason: valid && (current ? current.phase === 'blocked' && current.blockedReason
        : state.phase === 'blocked' && state.blockedReason) || null,
      roundsStarted: current?.roundsStarted ?? state.roundsStarted, maxGoalRounds: current?.maxGoalRounds ?? state.maxGoalRounds,
      relation: relationState(store, work, relation, current ? { ...state, definitionHash: nativeDefinitionHash(current) } : state), provenance: valid ? 'verified-native-delegation' : 'source-unavailable',
      canStop: current?.phase === 'active', canResume: Boolean(valid && current &&
        (['paused', 'blocked'].includes(current.phase) || current.phase === 'active' && current.activation === 'disarmed')) }];
  });
  if (!goalId && native && !known.some(work => work.nativeGoalId === native.id)) views.unshift({
    id: workId(sessionId, native.id), sessionId, nativeGoalId: native.id, objective: native.objective,
    nativeRevision: native.revision, phase: native.phase, activation: native.activation,
    blockedReason: native.phase === 'blocked' ? native.blockedReason ?? null : null,
    roundsStarted: native.roundsStarted, maxGoalRounds: native.maxGoalRounds, relation: null,
    provenance: 'legacy-unverified', canStop: native.phase === 'active', canResume: false });
  return limit === null ? views : views.slice(0, limit);
}
export function automaticWorkContext(goals, work, state, cutoff) {
  const store = goals.store, relation = workRelation(store, work.id, cutoff);
  if (relationState(store, work, relation, state)?.state !== 'current') return null;
  const goal = store.get('goals', relation.goalId);
  if (goal.status !== 'tracking' || goal.updatedSequence > cutoff) return null;
  const selection = { id: goal.id, revision: goal.revision, definitionVersion: goal.definitionVersion,
    reason: relation.reason, sourceIds: relation.sourceRefs.map(ref => ref.id) };
  const bundle = goals.fullEntry(goal, { repairOnly: false }, selection,
    { sessionId: work.sessionId, material: { cutoffSequence: cutoff, inputMessageIds: [] } });
  const understandings = [], visited = new Set();
  function include(record) {
    for (const ref of record.dependencies || []) {
      if (ref.kind !== 'understandings' || visited.has(ref.id)) continue;
      visited.add(ref.id);
      const row = store.get('understandings', ref.id);
      if (!row || row.revision !== ref.revision || !dependenciesCurrent(store, row, cutoff)) fail('目标依赖的理解已经变化。');
      understandings.push(copy(row)); include(row);
    }
  }
  include(goal);
  for (const related of bundle.relatedGoals) include(store.get('goals', related.id));
  return { workId: work.id, relationId: relation.id, nativeDefinitionHash: state.definitionHash,
    ...bundle, understandings, authority: 'previously-established-model-association; no-new-delegation' };
}

export const goalContentHash = goal => hash({ id: goal.id, title: goal.title, outcome: goal.outcome,
  definitionVersion: goal.definitionVersion, scope: goal.scope || {}, status: goal.status,
  userControl: goal.userControl ?? null, sourceIds: goal.sourceIds || [], dependencies: goal.dependencies || [],
  progress: goal.progress ?? null, relations: goal.relations || [], useProhibited: goal.useProhibited === true,
  withdrawn: goal.withdrawn === true, deleted: goal.deleted === true });
const definition = row => ({ id: row.id, title: row.title, outcome: row.outcome, definitionVersion: row.definitionVersion,
  scope: row.scope || {}, status: row.status, userControl: row.userControl ?? null,
  sourceIds: row.sourceIds, dependencies: row.dependencies, relations: row.relations || [], useProhibited: row.useProhibited === true,
  withdrawn: row.withdrawn === true, deleted: row.deleted === true });
/** A late progress-only update does not rewrite or invalidate a proven frozen definition. */
export function frozenGoalCurrent(store, shown, cutoff = store.currentSequence()) {
  const current = store.get('goals', shown.id);
  if (!current) return false;
  const old = current.revision === shown.revision ? current : store.listAll('audit', { where: { goalId: shown.id } })
    .flatMap(row => [row.before, row.after]).find(row => row?.revision === shown.revision);
  return Boolean(old && (!shown.contentHash || goalContentHash(old) === shown.contentHash) &&
    hash(definition(old)) === hash(definition(current)) &&
    dependenciesCurrent(store, { ...old, status: 'active' }, cutoff) &&
    !current.withdrawn && !current.deleted && !current.useProhibited);
}

export function workContextCurrent(store, context) {
  const work = store.get('goal_works', context.workId);
  const relation = store.get('goal_work_links', context.relationId);
  const state = workState(store, context.workId);
  const currentRelation = workRelation(store, context.workId);
  if (!currentRelation || currentRelation.goalId !== relation?.goalId ||
      currentRelation.definitionVersion !== relation?.definitionVersion ||
      currentRelation.nativeDefinitionHash !== relation?.nativeDefinitionHash ||
      relationState(store, work, currentRelation, state)?.state !== 'current' ||
      relationState(store, work, relation, state)?.state !== 'current' ||
      state?.definitionHash !== context.nativeDefinitionHash) return false;
  return [context.goal, ...context.relatedGoals, ...context.understandings].every(shown => {
    const kind = shown.definitionVersion === undefined ? 'understandings' : 'goals';
    const row = store.get(kind, shown.id);
    return kind === 'goals' ? frozenGoalCurrent(store, shown) && row.status === 'tracking'
      : row?.revision === shown.revision && dependenciesCurrent(store, row, store.currentSequence());
  }) && context.sources.every(ref => {
    const row = store.get('events', ref.id);
    return row?.revision === ref.revision && sourceAvailable(store, row);
  });
}
