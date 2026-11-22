import { randomUUID } from 'node:crypto';
import { CONTRACT, ROLES, array, canonicalJson, digest, fail, integer, jsonClone, oneOf, shape, text } from './contracts.mjs';
import { compilePrompt, parseFinalOutput, outputBindings } from './prompts.mjs';
import { recordKey } from './repository.mjs';

export const ROLE_LIMITS = Object.freeze({ main: 8192, attribution: 2048, learning: 8192, consolidation: 8192, verification: 8192, improvement: 8192, script_writer: 8192 });
export const WRITER_TOOLS = Object.freeze(['writer_read', 'writer_list', 'writer_search', 'writer_put', 'writer_probe', 'writer_finish']);
export const TERMINAL_JOBS = Object.freeze(['committed', 'failed', 'unknown', 'invalid_output', 'stale', 'cancelled']);
export const CONTEXT_REJECTED = 'CONTEXT_WINDOW_EXCEEDED';
// A failed learning job whose turn may be frozen again in a later native
// session: either stopped locally before submission, or refused by the
// provider for context size with no output. Paid, unknown and ordinary
// failures never qualify.
export function deferredLearning(job) {
  if (job?.role !== 'learning' || job.status !== 'failed') return false;
  if (job.error?.code === 'LEARNING_PRESSURE') return !job.submittedAt && !job.invocationIds.length;
  return job.error?.code === CONTEXT_REJECTED && job.providerRejected === true;
}
// Recovery after the host stopped mid-learning. With no request identity the
// guard never released a provider request, so the turn may be learned again in
// the same native session. A job that owns a request identity but left no
// durable result is lost and never retried, so one turn is never paid twice.
export const LEARNING_INTERRUPTED = 'LEARNING_INTERRUPTED';
export const RESULT_LOST = 'RESULT_LOST';
export function interruptedLearning(job) {
  return job?.role === 'learning' && job.status === 'failed' && job.error?.code === LEARNING_INTERRUPTED && job.notSent === true && !job.invocationIds.length;
}
const priority = { attribution: 0, script_writer: 1, learning: 2, consolidation: 3, verification: 4, improvement: 5, main: 0 };
const triggers = {
  main: ['user_turn'], attribution: ['human_input'], learning: ['settled_main_turn', 'assignment_correction'],
  consolidation: ['threshold', 'leave_timeout', 'node_complete'], verification: ['window', 'cluster', 'stagnation', 'assignment_correction'],
  improvement: ['repair_group'], script_writer: ['explicit_script_request', 'learned_script_request'],
};
export function freezeModelConfig(role, value) {
  shape(value, ['provider', 'model', 'reasoningEffort', 'maxTokens', 'preset', 'cwd', 'modelVersion', 'priceVersion', 'budgetScope', 'stage'], ['contextWindow']);
  for (const key of ['provider', 'model', 'preset', 'cwd', 'modelVersion', 'priceVersion', 'budgetScope', 'stage']) text(value[key], key, 4096);
  if (!value.cwd.startsWith('/')) fail('CONFIG_PATH', 'Explicit absolute working directory required');
  if (value.budgetScope === 'dsh-native') {
    if (value.reasoningEffort !== null) text(value.reasoningEffort, 'reasoning effort', 256);
    if (value.maxTokens !== null) integer(value.maxTokens, 'maxTokens', 1, role === 'main' ? Number.MAX_SAFE_INTEGER : ROLE_LIMITS[role]);
    if (value.contextWindow != null) integer(value.contextWindow, 'context window');
  } else {
    oneOf(value.reasoningEffort, ['off', 'low', 'high', 'max'], 'reasoning effort');
    integer(value.maxTokens, 'maxTokens', 1, role === 'main' && value.budgetScope !== 'arcfold-tree-v3-150cny' ? Number.MAX_SAFE_INTEGER : ROLE_LIMITS[role]);
  }
  return jsonClone(value);
}

export class TreeJobs {
  constructor({ repository, assertSources, now = () => Date.now() }) {
    if (typeof assertSources !== 'function') fail('SOURCE_RESOLVER_REQUIRED', 'Jobs require a trusted source recheck');
    this.repo = repository; this.assertSources = assertSources; this.now = now;
  }
  get(id) { const job = this.repo.get('tree_jobs', id); if (!job) fail('JOB_NOT_FOUND', 'Model job not found'); return job; }
  #command(type, requestId, input, expected, mutation) { return this.repo.command(type, { requestId, input, expected }, { kind: 'program', id: 'tree-model-jobs' }, mutation); }
  #replace(job, updates) { return this.repo.save('tree_jobs', { ...job, ...updates }, job.revision); }
  assertCurrent(job) {
    if (job.invalidated || ['stale', 'cancelled'].includes(job.status)) fail('JOB_STALE', 'Job scope was invalidated');
    for (const [key, revision] of Object.entries(job.inputRevisionSet)) { const index = key.indexOf(':'); if (index < 1 || this.repo.get(key.slice(0, index), key.slice(index + 1))?.revision !== revision) fail('JOB_STALE', 'A frozen input revision changed'); }
    const checked = this.assertSources(job.input.sources);
    if (checked?.then) fail('ASYNC_GUARD', 'Source recheck must be synchronous'); if (checked === false) fail('JOB_STALE', 'A frozen source changed or was withdrawn');
    if (digest(job.input) !== job.inputHash || digest(job.modelConfig) !== job.modelConfigHash || digest(job.prompt.text) !== job.promptHash) fail('JOB_CORRUPT', 'Frozen model input was altered');
    return true;
  }
  enqueue({ role, key, nodeIds, input, revisionSet, config, trigger }) {
    oneOf(role, ROLES, 'role'); text(key, 'stable job key', 512); array(nodeIds, 'nodeIds', 8); if (!nodeIds.length) fail('JOB_SCOPE', 'At least one node is required');
    if (!trigger || !triggers[role].includes(trigger.kind)) fail('JOB_TRIGGER', 'Role requires an explicit host trigger');
    if (['main', 'attribution', 'learning'].includes(role) && !['main', 'user', 'program'].includes(trigger.producerRole)) fail('RECURSIVE_JOB', 'Auxiliary events cannot recursively schedule user learning');
    if (['main', 'attribution'].includes(role) && trigger.origin !== 'user') fail('PROGRAM_NOT_USER', 'Only real human input starts a logical user turn');
    if (role === 'learning' && (trigger.kind === 'settled_main_turn' ? trigger.producerRole !== 'main' || trigger.status !== 'settled' : trigger.actorKind !== 'user')) fail('RECURSIVE_JOB', 'Learning requires settled main experience or a trusted user correction');
    if (role === 'learning' && nodeIds.length !== 1) fail('JOB_SCOPE', 'Each learning job belongs to one node');
    const id = digest(['model_job', role, key]), prompt = compilePrompt(role), modelConfig = freezeModelConfig(role, config);
    const envelope = { ...jsonClone(input), inputVersion: CONTRACT, role, jobId: id, trigger: jsonClone(trigger) };
    if (canonicalJson(envelope.scope?.nodeIds) !== canonicalJson(nodeIds) || !Array.isArray(envelope.sources) || !Array.isArray(envelope.knownItems) || !envelope.allowedIds) fail('INPUT_CONTRACT', 'A complete frozen scope and reference envelope is required');
    if (['learning', 'consolidation', 'verification', 'improvement'].includes(role)) envelope.outputBindings = outputBindings(envelope);
    for (const nodeId of nodeIds) { const node = this.repo.get('tree_nodes', nodeId); if (!node || node.deleted) fail('JOB_SCOPE', 'Unknown scope node'); }
    const inputHash = digest(envelope), inputRevisionSet = jsonClone(revisionSet), specification = { role, key, nodeIds, inputHash, inputRevisionSet, modelConfig, promptHash: prompt.hash };
    // Retry under another caller request id must still find this same job.
    const existing = this.repo.get('tree_jobs', id);
    if (existing) { if (existing.specificationHash !== digest(specification)) fail('JOB_IDENTITY_CONFLICT', 'A job key cannot be reused with different frozen input or configuration'); return existing; }
    this.#command('enqueueModelJob', digest(['enqueue', id]), specification, inputRevisionSet, () => {
      const job = { id, kind: role, role, scopeKey: nodeIds.join(','), nodeIds, input: envelope, inputHash, inputRevisionSet, modelConfig, modelConfigHash: digest(modelConfig), prompt, promptHash: prompt.hash, specificationHash: digest(specification), status: 'queued', trigger, nativeSessionId: null, invocationIds: [], enqueuedOrder: trigger.ordinal ?? this.repo.meta().lastEventOrdinal };
      this.assertCurrent(job); this.repo.save('tree_jobs', job); return { jobId: id };
    }); return this.get(id);
  }
  prepare(id, workerId = 'local-worker') {
    const current = this.get(id); if (current.status !== 'queued') return current;
    this.#command('prepareModelJob', digest(['prepare', id]), { jobId: id, workerId }, { [recordKey('tree_jobs', id)]: current.revision }, () => {
      const job = this.get(id); this.assertCurrent(job);
      const active = this.repo.list('tree_jobs', j => ['prepared', 'submitted', 'result_received', 'validated'].includes(j.status));
      if (!['main', 'attribution'].includes(job.role) && active.filter(j => !['main', 'attribution'].includes(j.role)).length >= 2) fail('WORKER_BUSY', 'Two background model jobs are already active');
      if (job.role === 'script_writer' && active.some(j => j.role === 'script_writer')) fail('WRITER_BUSY', 'Only one writer may run');
      if (['learning', 'consolidation'].includes(job.role)) {
        if (this.repo.list('tree_jobs', j => j.role === 'learning' && j.status === 'unknown' && j.nodeIds.some(n => job.nodeIds.includes(n))).length) fail('LEARNING_UNKNOWN', 'Resolve the uncertain prior learning request before reusing its session');
        if (active.some(j => ['learning', 'consolidation'].includes(j.role) && j.nodeIds.some(n => job.nodeIds.includes(n)))) fail('NODE_BUSY', 'This node already has an active learning/consolidation writer');
        if (this.repo.list('tree_jobs', j => j.id !== id && j.status === 'queued' && ['learning', 'consolidation'].includes(j.role) && j.nodeIds.some(n => job.nodeIds.includes(n)) && j.enqueuedOrder < job.enqueuedOrder).length) fail('NODE_ORDER', 'Earlier node experience must be processed first');
      }
      let nativeSessionId = `session-${randomUUID()}`, contextEpoch = 1;
      if (job.role === 'main') { text(job.trigger.nativeSessionId, 'main native session', 512); integer(job.trigger.nativeTurn, 'main native turn', 1); nativeSessionId = job.trigger.nativeSessionId; }
      if (job.role === 'learning') {
        const sessionId = digest(['learning_session', job.nodeIds[0]]); let session = this.repo.get('tree_learning_sessions', sessionId);
        if (!session) session = this.repo.save('tree_learning_sessions', { id: sessionId, nodeId: job.nodeIds[0], sessionId: nativeSessionId, contextEpoch: 1, appendSeq: 0, sourceWatermark: null, appliedChangeOrdinal: 0, estimateTokens: 0, history: [] });
        if (session.paused) fail('LEARNING_PAUSED', 'Learning awaits successful context consolidation');
        nativeSessionId = session.sessionId; contextEpoch = session.contextEpoch;
      }
      this.#replace(job, { status: 'prepared', nativeSessionId, contextEpoch, leaseOwner: workerId, preparedAt: this.repo.now() }); return { jobId: id, nativeSessionId, contextEpoch };
    }); return this.get(id);
  }
  queued() { return this.repo.list('tree_jobs', j => j.status === 'queued' && ROLES.includes(j.role)).sort((a, b) => priority[a.role] - priority[b.role] || a.enqueuedOrder - b.enqueuedOrder || a.id.localeCompare(b.id)); }
  transition(id, next, details = {}) {
    const current = this.get(id); if (current.status === next) return current;
    const allowed = { prepared: ['submitted', 'failed', 'stale', 'cancelled', 'unknown'], submitted: ['result_received', 'unknown', 'cancelled', 'stale'], unknown: ['result_received'], result_received: ['validated', 'invalid_output', 'stale', 'unknown'], validated: ['committed', 'stale', 'cancelled'], queued: ['failed', 'stale', 'cancelled'] };
    if (!allowed[current.status]?.includes(next)) fail('JOB_TRANSITION', `Cannot change ${current.status} to ${next}`);
    this.#command('transitionModelJob', digest(['transition', id, current.status, next, current.revision]), { jobId: id, next, details }, { [recordKey('tree_jobs', id)]: current.revision }, () => {
      this.#replace(current, { ...details, status: next, ...(TERMINAL_JOBS.includes(next) ? { leaseOwner: null } : {}) }); return { jobId: id, status: next };
    }); return this.get(id);
  }
  submit(id) { const job = this.get(id); this.assertCurrent(job); return this.transition(id, 'submitted', { submittedAt: this.repo.now(), startedMs: this.now() }); }
  failBeforeInvocation(id, { nativeLogRef, eventsHash, reason }) {
    const job = this.get(id);
    if (!['submitted', 'unknown'].includes(job.status) || job.invocationIds.length || this.repo.list('tree_invocations', call => call.jobId === id).length) fail('INVOCATION_EXISTS', 'Only a durably ended, never admitted request can be recorded as not sent');
    text(nativeLogRef, 'native failure receipt', 4096); text(eventsHash, 'native failure hash', 128); text(reason, 'native failure reason', 4096);
    this.#command('recordPreDispatchFailure', digest(['not-sent', id, eventsHash]), { jobId: id, nativeLogRef, eventsHash, reason }, { [recordKey('tree_jobs', id)]: job.revision }, () => {
      this.#replace(job, { status: 'failed', leaseOwner: null, nativeLogRef, eventsHash, error: { code: 'NATIVE_PRE_DISPATCH', message: reason }, notSent: true }); return { jobId: id, status: 'failed' };
    }); return this.get(id);
  }
  // Only recovery calls this, after the native session was read without a live
  // owner and held no complete result and no input message for this job.
  failInterrupted(id, { eventsHash }) {
    const job = this.get(id);
    if (job.role !== 'learning' || job.status !== 'unknown') fail('INTERRUPTION_STATE', 'Only an uncertain learning request can be resolved as interrupted');
    text(eventsHash, 'native events hash', 128);
    const sent = job.invocationIds.length > 0 || this.repo.list('tree_invocations', call => call.jobId === id).length > 0;
    const error = sent ? { code: RESULT_LOST, message: 'Host stopped after the request was released; no durable result, not retried' }
      : { code: LEARNING_INTERRUPTED, message: 'Host stopped before the request was released; not sent' };
    this.#command('recordInterruptedLearning', digest(['interrupted', id, eventsHash]), { jobId: id, eventsHash, code: error.code }, { [recordKey('tree_jobs', id)]: job.revision }, () => {
      this.#replace(job, { status: 'failed', leaseOwner: null, eventsHash, error, ...(sent ? { resultLost: true } : { notSent: true }) }); return { jobId: id, status: 'failed' };
    }); return this.get(id);
  }
  failRejected(id, { nativeLogRef, eventsHash, code, message }) {
    const job = this.get(id);
    if (!['submitted', 'unknown'].includes(job.status) || !job.invocationIds.length) fail('REJECTION_STATE', 'Only a submitted request with a guarded identity can be recorded as provider-rejected');
    text(nativeLogRef, 'native failure receipt', 4096); text(eventsHash, 'native failure hash', 128); text(code, 'provider error code', 256); text(message, 'provider error message', 4096);
    this.#command('recordProviderRejection', digest(['provider-rejected', id, eventsHash]), { jobId: id, nativeLogRef, eventsHash, code }, { [recordKey('tree_jobs', id)]: job.revision }, () => {
      this.#replace(job, { status: 'failed', leaseOwner: null, nativeLogRef, eventsHash, error: { code, message }, providerRejected: true }); return { jobId: id, status: 'failed' };
    }); return this.get(id);
  }
  // Start a fresh native session for the current epoch content. Used when the
  // provider refused the session's first append and nothing older can be
  // summarized; replaceEpoch still verifies the exact summary and coverage.
  rotateEpoch(nodeId) {
    const session = this.repo.get('tree_learning_sessions', digest(['learning_session', nodeId])); if (!session) fail('SESSION_REQUIRED', 'Learning session missing');
    if (!session.summaryId) fail('EPOCH_COVERAGE', 'A first epoch without a verified summary cannot rotate');
    return this.replaceEpoch(nodeId, { summaryId: session.summaryId, summaryHash: session.summaryHash, sourceWatermark: session.sourceWatermark, recentJobIds: session.recentJobIds });
  }
  recordError(id, error) {
    const job = this.get(id), details = { code: error.code ?? 'HOST_ERROR', message: error.message };
    this.#command('recordModelJobError', digest(['job-error', id, job.revision]), { jobId: id, error: details }, { [recordKey('tree_jobs', id)]: job.revision }, () => {
      this.#replace(job, { error: details }); return { jobId: id };
    }); return this.get(id);
  }
  bindMessage(id, message) {
    const job = this.get(id);
    if (job.nativeMessage) { if (canonicalJson(job.nativeMessage) !== canonicalJson(message)) fail('MESSAGE_CONFLICT', 'The native input identity is immutable'); return job; }
    if (job.status !== 'prepared' || message.role !== 'user' || !message.id || message.source?.kind !== 'arcfold/tree-job' || message.source.jobId !== job.id || message.source.inputHash !== job.inputHash || canonicalJson(message.content) !== canonicalJson([{ type: 'text', text: canonicalJson(job.input) }])) fail('MESSAGE_CONFLICT', 'Exact host-created input message required before submission');
    this.#command('bindModelMessage', digest(['native-message', id]), { jobId: id, message }, { [recordKey('tree_jobs', id)]: job.revision }, () => { this.#replace(job, { nativeMessage: jsonClone(message) }); return { jobId: id, messageId: message.id }; }); return this.get(id);
  }
  admitInvocation(id, { turn, step, stepStartSeq, requestHash, allowedTools }) {
    const job = this.get(id); if (job.status !== 'submitted') fail('JOB_NOT_SUBMITTED', 'Request has no submitted job'); this.assertCurrent(job);
    for (const n of [turn, step, stepStartSeq]) integer(n, 'native position', 0);
    const position = { sessionId: job.nativeSessionId, turn, step, stepStartSeq }, requestId = `dsh-messages-${digest(position)}`, invocationId = digest(['tree_invocation', requestId]);
    const existing = this.repo.get('tree_invocations', invocationId);
    if (existing) { if (existing.jobId !== id || existing.requestHash !== requestHash || existing.state !== 'admitted') fail('INVOCATION_REPLAY', 'Native position already owns a different or finished request'); return existing; }
    if (job.role !== 'main' && job.role !== 'script_writer' && job.invocationIds.length >= 1) fail('ROLE_CALL_LIMIT', 'Reader roles have one model request per job');
    if (job.role === 'script_writer' && (job.invocationIds.length >= 12 || this.now() - job.startedMs >= 120000)) fail('WRITER_LIMIT', 'Writer step/time limit reached');
    const tools = [...allowedTools].sort();
    if (!['main', 'script_writer'].includes(job.role) && tools.length || job.role === 'script_writer' && tools.some(t => !WRITER_TOOLS.includes(t))) fail('ROLE_TOOLS', 'Role tools exceed the frozen allowlist');
    this.#command('admitModelInvocation', digest(['admit', invocationId]), { jobId: id, position, requestHash, allowedTools: tools }, { [recordKey('tree_jobs', id)]: job.revision }, () => {
      this.repo.save('tree_invocations', { id: invocationId, jobId: id, role: job.role, nativeSessionId: job.nativeSessionId, nativeTurn: turn, nativeStep: step, stepStartSeq, ordinal: job.invocationIds.length + 1, modelConfigHash: job.modelConfigHash, promptHash: job.promptHash, inputHash: job.inputHash, requestHash, allowedTools: tools, state: 'admitted', ledgerRequestId: requestId });
      this.#replace(job, { invocationIds: [...job.invocationIds, invocationId] }); return { invocationId, requestId };
    }); return this.repo.get('tree_invocations', invocationId);
  }
  invocationResult(invocationId, details) {
    const invocation = this.repo.get('tree_invocations', invocationId); if (!invocation) fail('INVOCATION_MISSING', 'No request identity');
    shape(details, ['state'], ['usage', 'resultHash', 'nativeLogRef']); oneOf(details.state, ['result_received', 'unknown'], 'invocation result');
    if (invocation.state === 'result_received') { if (details.resultHash !== invocation.resultHash) fail('RESULT_CONFLICT', 'A request has one immutable result'); return invocation; }
    this.#command('recordInvocationResult', digest(['invocation-result', invocationId, details.state]), { invocationId, ...details }, { [recordKey('tree_invocations', invocationId)]: invocation.revision }, () => { this.repo.save('tree_invocations', { ...invocation, ...details }, invocation.revision); return { invocationId }; }); return this.repo.get('tree_invocations', invocationId);
  }
  receive(id, { message, nativeLogRef, eventsHash }) {
    const job = this.get(id); text(nativeLogRef, 'durable native log reference', 4096); text(eventsHash, 'native events hash', 128);
    const resultHash = digest(message);
    if (job.resultHash) {
      if (job.resultHash !== resultHash) fail('RESULT_CONFLICT', 'A job cannot replace its received result');
      return job.status === 'unknown' ? this.transition(id, 'result_received') : job;
    }
    return this.transition(id, 'result_received', { rawMessage: jsonClone(message), resultHash, nativeLogRef, eventsHash, resultReceivedAt: this.repo.now() });
  }
  validate(id) {
    const job = this.get(id); if (['validated', 'committed', 'invalid_output', 'stale'].includes(job.status)) return job;
    if (job.status !== 'result_received') fail('RESULT_REQUIRED', 'Durable received output required');
    try {
      this.assertCurrent(job);
      const parsed = job.role === 'main' ? { result: { message: job.rawMessage }, rawHash: digest(job.rawMessage) } : parseFinalOutput(job.role, job.rawMessage, job.input);
      return this.transition(id, 'validated', { validatedResult: parsed.result, outputEnvelope: { schemaVersion: CONTRACT, jobId: id, inputHash: job.inputHash, result: parsed.result }, rawHash: parsed.rawHash, rejectedItems: parsed.rejectedItems ?? [] });
    } catch (e) { return this.transition(id, e.code === 'JOB_STALE' ? 'stale' : 'invalid_output', { error: { code: e.code ?? 'OUTPUT_JSON', message: e.message, validationErrors: e.validationErrors ?? e.errors ?? [] }, rawHash: e.rawHash ?? digest(job.rawMessage) }); }
  }
  commit(id, applyResult = () => ({})) {
    const job = this.get(id); if (job.status === 'committed') return job;
    if (job.status !== 'validated') fail('VALIDATED_REQUIRED', 'Only validated output can commit');
    try {
      return this.repo.transaction(() => {
        this.assertCurrent(this.get(id));
        const result = applyResult(jsonClone(job.validatedResult), { job, requestId: digest(['apply-model-result', id]) });
        if (result?.then) fail('ASYNC_COMMIT', 'Domain application must be synchronous');
        if (job.role === 'learning') {
          const s = this.repo.get('tree_learning_sessions', digest(['learning_session', job.nodeIds[0]]));
          if (s.sessionId !== job.nativeSessionId || s.contextEpoch !== job.contextEpoch) fail('JOB_STALE', 'Learning epoch changed');
          this.#command('appendLearningReceipt', digest(['learning-append', id]), { jobId: id }, { [recordKey('tree_learning_sessions', s.id)]: s.revision }, () => {
            this.repo.save('tree_learning_sessions', { ...s, appendSeq: s.appendSeq + 1, sourceWatermark: job.trigger.watermark ?? job.trigger.ordinal ?? s.sourceWatermark, appliedChangeOrdinal: this.repo.meta().lastEventOrdinal, history: [...s.history, { jobId: id, turnId: job.trigger.turnId ?? null, sourceRefs: job.input.sources.map(s => s.ref), nativeLogRef: job.nativeLogRef, resultHash: job.resultHash, receipt: jsonClone(result), inputHash: job.inputHash }] }, s.revision); return { nodeId: s.nodeId };
          });
        }
        return this.transition(id, 'committed', { resultRef: jsonClone(result), committedAt: this.repo.now() });
      });
    } catch (e) { if (e.code === 'JOB_STALE') return this.transition(id, 'stale', { error: { code: e.code, message: e.message } }); throw e; }
  }
  replaceEpoch(nodeId, { summaryId, sourceWatermark, recentJobIds, summaryHash }) {
    const session = this.repo.get('tree_learning_sessions', digest(['learning_session', nodeId])); if (!session) fail('SESSION_REQUIRED', 'Learning session missing');
    const summary = this.repo.get('tree_summaries', summaryId);
    if (!summary || summary.nodeId !== nodeId || digest(summary) !== summaryHash || canonicalJson(session.history.slice(-3).map(h => h.jobId)) !== canonicalJson(recentJobIds) || sourceWatermark === undefined || summary.sourceWatermark !== sourceWatermark || canonicalJson(summary.coveredJobIds ?? []) !== canonicalJson(session.history.slice(0, -3).map(h => h.jobId))) fail('EPOCH_COVERAGE', 'A verified summary, exact coverage watermark and latest three learning jobs are required');
    if (this.repo.list('tree_jobs', j => j.nodeIds?.includes(nodeId) && ['prepared', 'submitted', 'result_received', 'validated'].includes(j.status)).length) fail('NODE_BUSY', 'Cannot replace an active learning epoch');
    const id = digest(['epoch', nodeId, session.contextEpoch + 1]);
    this.#command('replaceLearningEpoch', id, { nodeId, summaryId, sourceWatermark, recentJobIds, summaryHash }, { [recordKey('tree_learning_sessions', session.id)]: session.revision }, () => {
      this.repo.save('tree_learning_sessions', { ...session, sessionId: `session-${randomUUID()}`, previousSessions: [...(session.previousSessions ?? []), { sessionId: session.sessionId, contextEpoch: session.contextEpoch }], contextEpoch: session.contextEpoch + 1, appendSeq: 0, summaryId, summaryHash, sourceWatermark, recentJobIds, paused: false, estimateTokens: 0 }, session.revision); return { nodeId, epoch: session.contextEpoch + 1 };
    }); return this.repo.get('tree_learning_sessions', session.id);
  }
  pauseLearning(nodeId, reason) {
    const s = this.repo.get('tree_learning_sessions', digest(['learning_session', nodeId])); if (!s) fail('SESSION_REQUIRED', 'Learning session missing'); text(reason, 'pause reason');
    this.#command('pauseLearningEpoch', digest(['pause-learning', s.id, s.revision]), { nodeId, reason }, { [recordKey('tree_learning_sessions', s.id)]: s.revision }, () => { this.repo.save('tree_learning_sessions', { ...s, paused: true, pauseReason: reason }, s.revision); return { nodeId }; });
  }
}
