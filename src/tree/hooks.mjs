import { isAbsolute, resolve } from 'node:path';
import { canonicalJson, digest, fail, jsonClone } from './contracts.mjs';
import { HOOK_RULES, validateHook } from './items.mjs';
import { beneath, canonicalPath } from './host-process.mjs';
import { assertOwnedCompaction } from './host-context.mjs';

const actor = { kind: 'program', id: 'tree-hooks' };
const pathFields = new Set(['filePath', 'earlierFilesInTurn', 'filesWritten', 'filesWrittenInNode']);
const negative = new Set(['not_contains']);
const methodKey = (id, version) => digest(['method', id, version]);
const itemKey = (id, version) => digest(['item_version', id, version]);

/** Unknown host effects remain unknown; text matching never grants authority. */
export function matchCondition(condition, fields, { workspace, fileEffects = 'unknown' } = {}) {
  const { field, op, value } = condition;
  if (!Object.hasOwn(fields, field) || fields[field] === undefined || fields[field] === null) return { matched: null, diagnostic: 'missing_field:' + field };
  const actual = fields[field], values = Array.isArray(actual) ? actual : [actual];
  const incomplete = pathFields.has(field) && Array.isArray(actual) && fileEffects !== 'complete';
  if (incomplete && negative.has(op)) return { matched: null, diagnostic: 'incomplete_file_effects' };
  if (values.some(v => !['string', 'boolean'].includes(typeof v))) return { matched: null, diagnostic: 'unsupported_host_field:' + field };
  const compare = entry => {
    if (typeof value === 'boolean' || typeof entry === 'boolean') return op === 'equals' && entry === value;
    if (pathFields.has(field)) {
      if (!workspace) return null;
      const a = canonicalPath(isAbsolute(entry) ? entry : resolve(workspace, entry)), b = canonicalPath(isAbsolute(value) ? value : resolve(workspace, value));
      if (op === 'equals') return a === b;
      if (op === 'ends_with') {
        // A relative suffix matches complete canonical path components. An
        // absolute suffix names the entire path, never a string fragment.
        if (isAbsolute(value)) return a === b;
        const base = canonicalPath(workspace); if (!beneath(b, base) || b === base) return false;
        return a.endsWith('/' + b.slice(base.length + 1));
      }
      // A directory condition compares canonical path components, never a
      // lexical prefix such as /source matching /source-evil or a symlink.
      return beneath(a, b);
    }
    if (op === 'equals') return entry === value;
    if (op === 'starts_with') return entry.startsWith(value);
    if (op === 'ends_with') return entry.endsWith(value);
    return entry.includes(value);
  };
  const matches = values.map(compare);
  if (matches.some(v => v === null)) return { matched: null, diagnostic: 'path_context_missing' };
  if (incomplete && !matches.some(Boolean)) return { matched: null, diagnostic: 'incomplete_file_effects' };
  return { matched: op === 'not_contains' ? matches.every(v => !v) : matches.some(Boolean), diagnostic: null };
}

export class HookService {
  constructor({ repository, readScope, resolveSource, workspace }) {
    if (typeof readScope !== 'function' || typeof resolveSource !== 'function') fail('HOOK_HOST_REQUIRED', 'Hooks require trusted scope and original-source services');
    Object.assign(this, { repo: repository, readScope, resolveSource, workspace });
  }
  snapshot(sessionId, moment) {
    if (!HOOK_RULES[moment]) fail('INVALID_HOOK', 'Unknown hook event');
    const scope = this.readScope(sessionId);
    if (!scope || !(scope.phase === 'active' || moment === 'node_leave' && scope.phase === 'leaving')) fail('SCOPE_STALE', 'Hook scope is not admitted');
    // After a user undoes a created goal, the old scope may contain both
    // surviving and deleted nodes. Keep checking hooks on surviving paths.
    const ids = moment === 'node_leave' && scope.phase === 'leaving'
      ? scope.previousNodeIds.filter(id => { const node = this.repo.get('tree_nodes', id); return node && !node.deleted; })
      : scope.nodeIds;
    const paths = ids.map(id => this.repo.ancestors(id));
    const byId = new Map(), depths = new Map();
    for (const path of paths) for (const [depth, node] of path.entries()) {
      byId.set(node.id, node);
      depths.set(node.id, depth);
    }
    const nodes = [...byId.values()].sort((a, b) => depths.get(a.id) - depths.get(b.id) || a.id.localeCompare(b.id));
    const relevant = new Set(byId.keys());
    const itemsByNode = new Map();
    for (const item of this.repo.listByNodeIds('tree_items', [...relevant], i => i.kind === 'method' && i.lifecycle === 'active' && !i.stale)) {
      if (!itemsByNode.has(item.nodeId)) itemsByNode.set(item.nodeId, []);
      itemsByNode.get(item.nodeId).push(item);
    }
    const hooks = [];
    for (const node of nodes) for (const item of (itemsByNode.get(node.id) ?? []).sort((a, b) => a.id.localeCompare(b.id))) {
      const bundle = this.repo.get('tree_methods', methodKey(item.id, item.activeVersion)), version = this.repo.get('tree_item_versions', itemKey(item.id, item.activeVersion));
      if (!bundle || !version || bundle.pendingScriptRequests.length || version.sourceRefs.some(ref => !this.resolveSource(ref))) continue;
      for (const ref of bundle.hooks) {
        const hook = this.repo.get('tree_hooks', digest(['hook_version', ref.id, ref.version]));
        if (!hook?.enabled || hook.moment !== moment) continue;
        validateHook({ moment: hook.moment, conditions: hook.conditions, action: hook.action, message: hook.message });
        hooks.push({ ...hook, itemRevision: item.revision, hookRevision: hook.revision, sourceRefs: version.sourceRefs });
      }
    }
    if (hooks.length > 100) fail('HOOK_CAPACITY', 'This event cannot activate more than 100 hooks; no hooks were silently dropped');
    const turn = this.repo.get('tree_turns', scope.turnId);
    if (!turn || turn.assignmentRevision !== scope.assignmentRevision) fail('SCOPE_STALE', 'Assignment changed before hook admission');
    const value = { sessionId, moment, scopeEpoch: scope.epoch, scopeToken: scope.token, logicalTurnId: turn.logicalTurnId, turnId: turn.id, nodeIds: ids, hooks };
    return { ...value, key: digest(value) };
  }
  assertCurrent(snapshot) {
    if (this.snapshot(snapshot.sessionId, snapshot.moment).key !== snapshot.key) fail('HOOK_STALE', 'Scope, method, hook or source changed');
  }
  evaluate({ sessionId, moment, eventKey, fields, origin = 'program', fileEffects = 'unknown', signal, nodeId = null }) {
    signal?.throwIfAborted();
    if (typeof eventKey !== 'string' || !eventKey || typeof fields !== 'object' || !fields || Array.isArray(fields)) fail('HOOK_EVENT', 'A stable native event key and host-projected fields are required');
    if (Object.keys(fields).some(key => !HOOK_RULES[moment]?.fields.includes(key))) fail('HOOK_EVENT', 'Only the registered host projection is accepted');
    if (moment === 'user_message' && origin !== 'user') return { ignored: 'program_not_user', runs: [], contexts: [], reminders: [], notes: [], decision: 'allow', continuation: null };
    const snapshot = this.snapshot(sessionId, moment);
    if (['node_leave', 'node_enter'].includes(moment)) {
      nodeId ??= fields.nodeId ?? (snapshot.nodeIds.length === 1 ? snapshot.nodeIds[0] : null);
      if (!snapshot.nodeIds.includes(nodeId)) fail('HOOK_EVENT', 'A node lifecycle event must identify one admitted node');
    }
    const input = { sessionId, moment, eventKey, fields: jsonClone(fields), origin, fileEffects, scopeKey: snapshot.key, nodeId };
    const inputHash = digest(input), id = digest(['hook-event', sessionId, eventKey, moment]);
    const receipt = this.repo.command('evaluateTreeHooks', { requestId: id, expected: {}, input }, actor, () => {
      this.assertCurrent(snapshot); signal?.throwIfAborted();
      const history = this.repo.list('tree_hook_runs', row => row.logicalTurnId === snapshot.logicalTurnId);
      const cycle = Math.max(0, ...history.map(row => row.continuationCycle)), runs = [], contexts = [], reminders = [], notes = [], continuing = [];
      let decision = 'allow';
      for (const hook of snapshot.hooks) {
        let result;
        try {
          const conditions = hook.conditions.map(c => matchCondition(c, fields, { workspace: this.workspace, fileEffects }));
          const matched = conditions.some(c => c.matched === false) ? false : conditions.some(c => c.matched === null) ? null : true;
          result = { status: matched === true ? 'matched' : matched === null ? 'unknown' : 'pass', diagnostics: conditions.map(c => c.diagnostic).filter(Boolean), action: null, message: hook.message };
          if (matched === true) {
            result.action = hook.action;
            if (hook.action === 'block') {
              if (moment === 'node_complete' && fields.completedBy === 'user') { result.action = 'remind_user'; reminders.push(hook.message); }
              else decision = 'deny';
            } else if (hook.action === 'ask_user') { if (decision !== 'deny') decision = 'ask'; }
            else if (hook.action === 'add_context') contexts.push(hook.message);
            else if (hook.action === 'remind_user') reminders.push(hook.message);
            else if (hook.action === 'leave_note') notes.push({ hookId: hook.hookId, methodId: hook.methodId, version: hook.version, nodeId, message: hook.message });
            else if (hook.action === 'continue') {
              const earlier = history.filter(row => row.hookId === hook.hookId && row.version === hook.version).sort((a, b) => b.eventOrdinal - a.eventOrdinal);
              const consecutive = (earlier[0]?.result.status === 'needs_action' ? earlier[0].result.consecutive ?? 1 : 0) + 1;
              result = { ...result, status: 'needs_action', consecutive, exhausted: consecutive >= 2 || cycle >= 3 };
              if (result.exhausted) reminders.push(hook.message); else continuing.push(hook);
            }
          }
        } catch (error) {
          // Only unexpected condition execution errors fail open. Scope,
          // source, budget and process gates are outside this catch.
          result = { status: 'error', action: null, message: hook.message, diagnostics: [{ code: error.code ?? 'HOOK_ERROR', message: error.message }], failOpen: true };
        }
        runs.push({ id: digest(['hook-run', sessionId, eventKey, moment, hook.hookId, hook.version]), logicalTurnId: snapshot.logicalTurnId,
          eventKey: digest([sessionId, eventKey, moment]), hookId: hook.hookId, methodId: hook.methodId, version: hook.version, scopeEpoch: snapshot.scopeEpoch, inputHash,
          result, continuationCycle: cycle + Number(continuing.length > 0), observedAt: this.repo.now(), eventOrdinal: this.repo.meta().lastEventOrdinal + 1 });
      }
      const nextCycle = cycle + Number(continuing.length > 0);
      for (const run of runs) this.repo.save('tree_hook_runs', { ...run, continuationCycle: nextCycle });
      if (notes.length || moment === 'node_enter') {
        const meta = this.repo.meta(), saved = { ...(meta.hookNotes ?? {}) };
        for (const note of notes) { const runId = runs.find(run => run.hookId === note.hookId).id, noteId = digest(['hook-note', runId, note.nodeId]); saved[noteId] = { ...note, id: noteId, runId, consumedBy: null }; }
        if (moment === 'node_enter') for (const note of Object.values(saved)) {
          const item = this.repo.get('tree_items', note.methodId), hook = this.repo.get('tree_hooks', digest(['hook_version', note.hookId, note.version]));
          const version = item && this.repo.get('tree_item_versions', itemKey(item.id, item.activeVersion));
          if (note.nodeId === nodeId && !note.consumedBy && item?.lifecycle === 'active' && !item.stale && item.activeVersion === note.version && hook?.enabled && version?.sourceRefs.every(ref => this.resolveSource(ref))) {
            contexts.push(note.message); saved[note.id] = { ...note, consumedBy: id };
            const run = { id: digest(['hook-note-entry', note.id, id]), logicalTurnId: snapshot.logicalTurnId, eventKey: digest([sessionId, eventKey, moment]), hookId: note.hookId, methodId: note.methodId, version: note.version, scopeEpoch: snapshot.scopeEpoch, inputHash,
              result: { status: 'matched', action: 'add_context', message: note.message, priorRunId: note.runId }, continuationCycle: nextCycle, observedAt: this.repo.now(), eventOrdinal: this.repo.meta().lastEventOrdinal + 1 };
            if (!runs.some(existing => existing.hookId === run.hookId && existing.version === run.version)) { runs.push(run); this.repo.save('tree_hook_runs', run); }
          }
        }
        this.repo.save('tree_meta', { ...meta, hookNotes: saved }, meta.revision);
      }
      const continuation = continuing.length ? { source: { kind: 'arcfold/hook', hookRunIds: runs.filter(r => continuing.some(h => h.hookId === r.hookId)).map(r => r.id), versions: continuing.map(h => ({ hookId: h.hookId, version: h.version })), logicalTurnId: snapshot.logicalTurnId, scopeEpoch: snapshot.scopeEpoch }, text: [...new Set(continuing.map(h => h.message))].join('\n'), cycle: nextCycle } : null;
      return { snapshot, inputHash, runs: runs.map(r => r.id), decision, contexts: [...new Set(contexts)], reminders: [...new Set(reminders)], notes, continuation,
        signals: runs.filter(r => r.result.exhausted).map(r => ({ kind: 'hook_continue_exhausted', hookRunId: r.id, logicalTurnId: r.logicalTurnId })) };
    });
    return receipt.result;
  }
  /** Approval and native permission are supplied by separate trusted host paths. */
  async beforeTool(event, { baseDecision, requestApproval, execute }) {
    if (!['allow', 'ask', 'deny'].includes(baseDecision)) fail('HOST_PERMISSION_REQUIRED', 'A native permission decision is required');
    const result = this.evaluate({ ...event, moment: 'before_tool' });
    if (baseDecision !== 'allow') return { ...result, decision: baseDecision, executed: false };
    if (result.decision === 'deny') return { ...result, executed: false };
    if (result.decision === 'ask') {
      if (typeof requestApproval !== 'function') return { ...result, decision: 'deny', denial: 'approval_missing', executed: false };
      const approval = await requestApproval({ sessionId: event.sessionId, eventKey: event.eventKey, inputHash: result.inputHash, scopeEpoch: result.snapshot.scopeEpoch });
      if (approval?.approved !== true || approval.sessionId !== event.sessionId || approval.eventKey !== event.eventKey || approval.inputHash !== result.inputHash || approval.scopeEpoch !== result.snapshot.scopeEpoch) return { ...result, decision: 'deny', denial: 'approval_missing', executed: false };
    }
    event.signal?.throwIfAborted(); this.assertCurrent(result.snapshot);
    if (typeof execute !== 'function') return { ...result, decision: 'allow', executed: false };
    const executionId = digest(['hook-tool-execution', event.sessionId, event.eventKey]);
    const old = this.repo.meta().hookToolExecutions?.[executionId];
    if (old) return { ...result, decision: 'deny', executed: false, denial: 'already_admitted_no_replay', previousState: old.state };
    const record = (state, extra = {}) => this.repo.command('recordHookToolExecution', { requestId: digest([executionId, state]), expected: {}, input: { executionId, state, inputHash: result.inputHash } }, actor, () => {
      const meta = this.repo.meta(), executions = meta.hookToolExecutions ?? {};
      if (state === 'started' && executions[executionId]) fail('EXECUTION_ALREADY_ADMITTED', 'Tool execution already has an owner');
      this.repo.save('tree_meta', { ...meta, hookToolExecutions: { ...executions, [executionId]: { state, inputHash: result.inputHash, scopeEpoch: result.snapshot.scopeEpoch, at: this.repo.now(), ...extra } } }, meta.revision);
      return { executionId, state };
    });
    record('started');
    try { event.signal?.throwIfAborted(); this.assertCurrent(result.snapshot); const value = await execute(); record('completed'); return { ...result, decision: 'allow', executed: true, value }; }
    catch (error) { record('failed', { error: { code: error.code ?? 'TOOL_FAILED', message: error.message } }); throw error; }
  }
  assertContinuation(result, signal) {
    signal?.throwIfAborted(); this.assertCurrent(result.snapshot); if (!result.continuation) fail('NO_CONTINUATION', 'No admitted hook continuation');
    const ordinal = Math.max(...result.runs.map(id => this.repo.get('tree_hook_runs', id)?.eventOrdinal ?? -1));
    if (this.repo.list('tree_hook_runs', row => row.logicalTurnId === result.snapshot.logicalTurnId && row.result.action === 'continue').some(row => row.eventOrdinal > ordinal)) fail('CONTINUATION_STALE', 'A later stop check superseded this pending continuation');
    return result.continuation;
  }
  claimContinuation(result, nativeMessageId, signal) {
    this.assertContinuation(result, signal);
    if (typeof nativeMessageId !== 'string' || !nativeMessageId) fail('HOOK_EVENT', 'Persist the actual native steering message identity before admission');
    const id = digest(['hook-steer', result.snapshot.logicalTurnId, result.continuation.cycle]);
    if (this.repo.meta().hookContinuations?.[id]) return { claimed: false, state: this.repo.meta().hookContinuations[id] };
    return this.repo.command('claimHookContinuation', { requestId: id, expected: {}, input: { nativeMessageId, runIds: result.runs, scopeEpoch: result.snapshot.scopeEpoch } }, actor, () => {
      this.assertContinuation(result, signal); const meta = this.repo.meta();
      if (meta.hookContinuations?.[id]) fail('CONTINUATION_ALREADY_CLAIMED', 'A persisted send intent already owns this cycle');
      const state = { nativeMessageId, runIds: result.runs, scopeEpoch: result.snapshot.scopeEpoch, state: 'send_intent', at: this.repo.now() };
      this.repo.save('tree_meta', { ...meta, hookContinuations: { ...meta.hookContinuations, [id]: state } }, meta.revision);
      return { claimed: true, state };
    }).result;
  }
  message(result, runIds = result.runs.filter(id => this.repo.get('tree_hook_runs', id)?.result.action === 'add_context' || result.continuation?.source.hookRunIds.includes(id))) {
    const runs = runIds.map(id => this.repo.get('tree_hook_runs', id)).filter(run => run && ['add_context', 'continue'].includes(run.result.action));
    if (!runs.length) return null;
    return { source: { kind: 'arcfold/hook', hookRunIds: runs.map(r => r.id), scopeEpoch: result.snapshot.scopeEpoch, logicalTurnId: result.snapshot.logicalTurnId }, content: [{ type: 'text', text: [...new Set(runs.map(r => r.result.message))].join('\n') }] };
  }
  validMessage(sessionId, message) {
    const source = message.source, scope = this.readScope(sessionId), turn = scope && this.repo.get('tree_turns', scope.turnId);
    if (message.role !== 'user' || source?.kind !== 'arcfold/hook' || !Array.isArray(source.hookRunIds) || !source.hookRunIds.length || scope?.phase !== 'active' || scope.epoch !== source.scopeEpoch || turn?.assignmentRevision !== scope.assignmentRevision || turn?.logicalTurnId !== source.logicalTurnId) return false;
    const runs = source.hookRunIds.map(id => this.repo.get('tree_hook_runs', id));
    for (const run of runs) {
      if (!run || run.scopeEpoch !== scope.epoch || run.logicalTurnId !== turn.logicalTurnId || !['add_context', 'continue'].includes(run.result.action)) return false;
      const item = this.repo.get('tree_items', run.methodId), hook = this.repo.get('tree_hooks', digest(['hook_version', run.hookId, run.version]));
      if (!item || item.lifecycle !== 'active' || item.stale || item.activeVersion !== run.version || !hook?.enabled || !scope.nodeIds.some(id => this.repo.ancestors(id).some(node => node.id === item.nodeId))) return false;
      const version = this.repo.get('tree_item_versions', itemKey(item.id, item.activeVersion)); if (!version || version.sourceRefs.some(ref => !this.resolveSource(ref))) return false;
    }
    return canonicalJson(message.content) === canonicalJson([{ type: 'text', text: [...new Set(runs.map(r => r.result.message))].join('\n') }]);
  }
}

/** The native loop still owns delivery. This adapter only retires stale owned text. */
export function mountHookContext(ctx, { service, sessionId, createUserMessage }) {
  let session;
  const offPrepare = ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next(); if (decision.kind === 'reject') return decision; payload.signal.throwIfAborted();
    session = payload.agent.session; if (session.id !== sessionId) fail('HOOK_SESSION', 'Hook context cannot mount another native session');
    assertOwnedCompaction(session);
    for (const seq of [...session.surface.nodes]) {
      const event = session.eventAt(seq); if (event.type !== 'user/message' || event.data.source?.kind !== 'arcfold/hook' || service.validMessage(sessionId, event.data)) continue;
      session.append('user/message', createUserMessage({ source: { kind: 'arcfold/tree-context-retired' }, content: [{ type: 'text', text: '[previous Arcfold hook retired]' }] }), { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] });
    }
    for (const message of decision.messages) if (message.source?.kind === 'arcfold/hook' && !service.validMessage(sessionId, message)) fail('HOOK_STALE', 'Pending hook text no longer belongs to this scope');
    return decision;
  });
  const offStream = ctx.on('llm/stream', (options, next) => {
    if (!session || options.sessionId !== sessionId) return next();
    return (async function* () {
      options.signal?.throwIfAborted(); assertOwnedCompaction(session);
      if (options.messages.some(m => m.source?.kind === 'arcfold/hook' && !service.validMessage(sessionId, m))) fail('HOOK_STALE', 'Hook version or scope changed before dispatch');
      yield* next();
    })();
  });
  return async () => { await offStream(); await offPrepare(); };
}
