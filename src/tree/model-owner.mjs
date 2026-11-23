import { canonicalJson, digest, fail } from './contracts.mjs';
import { WRITER_TOOLS, TERMINAL_JOBS, CONTEXT_REJECTED, RESULT_LOST, LEARNING_INTERRUPTED } from './jobs.mjs';
import { directoryContext, contextMatches } from '../learning-runner.mjs';
import { compilePrompt } from './prompts.mjs';
import { modelView } from './model-view.mjs';
import { nativeAgentOptions, nativeModel } from './native-models.mjs';
import { nativeResponseComplete } from './native-model-records.mjs';
import { LlmError } from '@deepseek-ai/dsh-llm';

// The single turn carrying this job's input ended because the host disposed
// the agent, and no assistant answer was recorded inside it.
// Returns that turn's end event, or null.
function disposedWithoutAnswer(events, own) {
  if (own.length !== 1) return null;
  const start = events.findLast(e => e.type === 'turn/start' && e.seq < own[0].seq);
  const end = start && events.find(e => e.type === 'turn/end' && e.data?.turn === start.data?.turn && e.seq > own[0].seq);
  if (!end || end.data?.reason?.kind !== 'aborted' || end.data.reason.reason?.kind !== 'disposed') return null;
  return events.some(e => e.type === 'assistant/message' && e.seq > start.seq && e.seq < end.seq) ? null : end;
}
const requestHash = options =>digest({ messages: options.messages, tools: options.tools ?? [], toolHistory: options.toolHistory ?? null });
function nativePosition(session) {
  const events = session.snapshotEvents(), start = events.findLast(e => e.type === 'step/start'), turn = events.findLast(e => e.type === 'turn/start');
  if (!start || !turn || !Number.isSafeInteger(start.data.turn) || !Number.isSafeInteger(start.data.step) || turn.data.turn !== start.data.turn || turn.seq >= start.seq || events.slice(start.seq + 1).some(e => ['assistant/message', 'assistant/attempt', 'step/end', 'turn/end'].includes(e.type))) fail('NATIVE_STEP', 'No live unattempted native step');
  return { turn: start.data.turn, step: start.data.step, stepStartSeq: start.seq, events };
}

/** Uses DSH create/resume/followup/whenIdle. There is no second agent/tool loop. */
export class TreeModelOwner {
  constructor({ jobs, host, createUserMessage, ledgerLookup = () => null, applyResult = () => ({}), mountWriterTools, verifyMainInput, inputTokenCount, timers = { setTimeout, clearTimeout } }) {
    Object.assign(this, { jobs, host, createUserMessage, ledgerLookup, applyResult, mountWriterTools, verifyMainInput, inputTokenCount, timers });
    this.handles = new Map(); this.running = new Map(); this.closed = false;
  }
  owns(sessionId) { return this.jobs.repo.list('tree_jobs', j => j.nativeSessionId === sessionId && ['prepared', 'submitted', 'result_received', 'validated'].includes(j.status)).length > 0; }
  jobFor(sessionId) {
    const owners = this.jobs.repo.list('tree_jobs', j => j.nativeSessionId === sessionId && ['prepared', 'submitted', 'result_received', 'validated'].includes(j.status));
    if (owners.length !== 1) fail('MODEL_OWNER', 'One active tree job must own this native session'); return owners[0];
  }
  messageFor(job) {
    if (!job.nativeMessage) fail('MESSAGE_MISSING', 'Native input identity must be persisted before sending'); return job.nativeMessage;
  }
  previousLearningInput(sourceJob, job) {
    if (job.role !== 'learning' || sourceJob.role !== 'learning' || canonicalJson(sourceJob.nodeIds) !== canonicalJson(job.nodeIds)) return false;
    if (sourceJob.status === 'committed') return true;
    if (!job.input.previousReceipt?.rejectedOutputs?.some(receipt => receipt.jobId === sourceJob.id && receipt.state === sourceJob.status && receipt.adopted === false && receipt.nativeLogRef === sourceJob.nativeLogRef)) return false;
    // A rejected result is history, never adopted state. Its exact settled
    // response and the rejection receipt can remain in this node's own worker.
    if (sourceJob.status === 'invalid_output' && sourceJob.resultHash && sourceJob.nativeLogRef && sourceJob.invocationIds.length)
      return sourceJob.invocationIds.every(id => { const call = this.jobs.repo.get('tree_invocations', id), receipt = call && this.ledgerLookup(call.ledgerRequestId); return call?.state === 'result_received' && (receipt?.status === 'settled' || nativeModel(sourceJob.modelConfig) && nativeResponseComplete(receipt)); });
    if (sourceJob.status === 'failed' && sourceJob.error?.code === 'NATIVE_PRE_DISPATCH' && sourceJob.nativeLogRef && !sourceJob.invocationIds.length) return true;
    // A turn the host disposed without an answer, resolved on recovery from
    // that exact native log position, stays as unanswered history.
    return sourceJob.status === 'failed' && [RESULT_LOST, LEARNING_INTERRUPTED].includes(sourceJob.error?.code) && Boolean(sourceJob.nativeLogRef);
  }
  assertProjection(job, options) {
    if (options.purpose !== undefined || options.system !== undefined) fail('PURPOSE_BYPASS', 'Tree roles use owned native messages, never purpose calls');
    const config = job.modelConfig;
    if (['provider', 'model', 'reasoningEffort', 'maxTokens'].some(k => nativeModel(config) ? (options[k] ?? null) !== (config[k] ?? null) : options[k] !== config[k])) fail('MODEL_CONFIG_CHANGED', 'Actual request differs from frozen model configuration');
    const session = this.host.sessions.get(options.sessionId), header = session?.requestHeader()?.config;
    if (!session || !header || ['provider', 'model', 'reasoningEffort', 'maxTokens'].some(k => header[k] !== options[k])) fail('NATIVE_CONFIG_CHANGED', 'Native header and provider configuration disagree');
    const systems = options.messages.filter(m => m.role === 'system').flatMap(m => m.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    if (job.role === 'main') {
      const check = this.verifyMainInput?.(job, options);
      if (check !== true) throw new LlmError(check?.message ?? '主对话发送前核对未通过，请重新发送本轮原话。', 'MAIN_INPUT_GUARD');
    } else {
      if (systems !== job.prompt.text) fail('PROMPT_CHANGED', 'Auxiliary fixed prompt changed');
      let current = 0;
      for (const message of options.messages.filter(m => m.role !== 'system')) {
        if (message.source?.kind === 'arcfold/tree-job') {
          const sourceJob = this.jobs.repo.get('tree_jobs', message.source.jobId);
          if (!sourceJob || sourceJob.nativeSessionId !== job.nativeSessionId || sourceJob.id !== job.id && !this.previousLearningInput(sourceJob, job)) fail('FOREIGN_JOB_INPUT', 'This session contains input from an unrelated or unresolved job');
          const expected = this.messageFor(sourceJob);
          if (canonicalJson(message) !== canonicalJson(expected)) fail('JOB_INPUT_CHANGED', 'Program input differs from the frozen envelope');
          if (sourceJob.id === job.id) current++;
        } else if (message.source?.kind === 'runtime-context') {
          if (!contextMatches(message, directoryContext(config.cwd))) fail('RUNTIME_CONTEXT_CHANGED', 'Unexpected native context');
        } else if (!['assistant', 'tool', 'developer'].includes(message.role) || message.role === 'developer' && job.role !== 'script_writer' || message.role === 'tool' && job.role !== 'script_writer') fail('FOREIGN_JOB_INPUT', 'Unexpected input in an auxiliary session');
      }
      if (current !== 1) fail('JOB_INPUT_MISSING', 'Exactly one current job envelope is required');
    }
    const tools = (options.tools ?? []).map(t => t.name), history = options.toolHistory;
    if (!['main', 'script_writer'].includes(job.role) && (tools.length || history?.tools?.length || history?.updates?.length)) fail('ROLE_TOOLS', 'Reader roles must have no tools or tool history');
    if (job.role === 'script_writer') {
      const names = [...tools, ...(history?.tools ?? []).map(t => t.name), ...(history?.updates ?? []).flatMap(u => (u.additions ?? []).map(t => t.name))];
      if (names.some(name => !WRITER_TOOLS.includes(name))) fail('ROLE_TOOLS', 'Writer has only the broker tool allowlist');
    }
    // Reservation still uses the declared 1M bound. This byte guard is a separate
    // conservative small-input limit; long-context tests require a trusted full
    // message/system/tools token counter instead of a character-ratio estimate.
    if (job.modelConfig.budgetScope === 'arcfold-tree-v3-150cny') {
      const measured = this.inputTokenCount?.(options);
      if (measured?.then) fail('ASYNC_GUARD', 'Input counting must be synchronous');
      if (measured !== undefined) {
        if (!Number.isSafeInteger(measured) || measured < 0 || measured > (job.trigger.longContextTest === true ? 160000 : 128000)) fail('INPUT_LIMIT', 'Full request token count exceeds the test limit');
      } else if (job.trigger.longContextTest || Buffer.byteLength(canonicalJson({ messages: options.messages, tools: options.tools ?? [], toolHistory: history ?? null })) > 96000) fail('INPUT_COUNTER_REQUIRED', 'Long input requires a trusted tokenizer; no rough estimate may bypass the limit');
    }
    this.jobs.assertCurrent(job); return tools;
  }
  guardStream(options, next) {
    if (!this.owns(options.sessionId)) return next(); const owner = this;
    return (async function* () {
      if (owner.closed) fail('OWNER_CLOSED', 'Tree model owner is closed'); options.signal?.throwIfAborted();
      await owner.prepareInput?.(options); options.signal?.throwIfAborted();
      const job = owner.jobFor(options.sessionId), tools = owner.assertProjection(job, options), position = nativePosition(owner.host.sessions.get(options.sessionId));
      owner.jobs.admitInvocation(job.id, { ...position, requestHash: requestHash(options), allowedTools: tools });
      yield* next();
    })();
  }
  identity(options, session = this.host.sessions.get(options.sessionId)) {
    const job = this.jobFor(options.sessionId); this.assertProjection(job, options); const position = nativePosition(session);
    const invocation = this.jobs.repo.list('tree_invocations', i => i.jobId === job.id && i.nativeSessionId === session.id && i.stepStartSeq === position.stepStartSeq)[0];
    if (!invocation || invocation.state !== 'admitted' || invocation.requestHash !== requestHash(options)) fail('INVOCATION_GUARD', 'Request did not pass the exact tree step guard');
    return { requestId: invocation.ledgerRequestId, metadata: { ...(job.trigger.repairEvidence ?? {}), owner: 'arcfold-dsh-tree-v3', sessionId: session.id, turn: position.turn, step: position.step, stepStartSeq: position.stepStartSeq, nativeThroughSeq: position.events.at(-1).seq, nativePrefixHash: digest(position.events), role: job.role, treeJobId: job.id, treeInvocationId: invocation.id, treeInputHash: job.inputHash, promptHash: job.promptHash, modelConfigHash: job.modelConfigHash, modelVersion: job.modelConfig.modelVersion, treePriceVersion: job.modelConfig.priceVersion, budgetScope: job.modelConfig.budgetScope, stage: job.modelConfig.stage } };
  }
  assertRequest(options) {
    const identity = this.identity(options), job = this.jobFor(options.sessionId);
    if (job.status !== 'submitted') fail('MODEL_OWNER', 'Job is no longer submitted');
    if (this.host.workingDirectory && this.host.workingDirectory.get(this.host.sessions.get(options.sessionId)) !== job.modelConfig.cwd) fail('WORKSPACE_CHANGED', 'Native working directory changed');
    return identity;
  }
  async setup(agentCtx, id) {
    const job = this.jobs.get(id);
    if (!this.host.agentPresets) fail('PRESET_REQUIRED', 'Owned roles require the native preset registry');
    await this.host.agentPresets.mount(agentCtx, job.modelConfig.preset);
    if (job.role !== 'main') {
      // Native restrictions mask inherited tools; broker tools register locally.
      // The request guard separately checks all visible scoped tool names.
      agentCtx.tools.restrict({ allow: [] });
      agentCtx.systemPrompt.suppressRuntimeContext();
    }
    agentCtx.systemPrompt.section({ name: 'arcfold:tree-role', order: 50, interpolate: false, complete: job.role !== 'main', text: job.prompt.text });
    if (job.role === 'script_writer') {
      if (!this.mountWriterTools) fail('WRITER_BROKER_REQUIRED', 'Writer requires dedicated broker tools'); await this.mountWriterTools(agentCtx, job);
      agentCtx.on('tools/pre-execute', async (exec, next) => {
        if (!WRITER_TOOLS.includes(exec.name)) fail('ROLE_TOOLS', 'Unapproved writer tool');
        this.jobs.assertCurrent(this.jobs.get(id)); const result = await next(); this.jobs.assertCurrent(this.jobs.get(id)); return result;
      });
    }
    agentCtx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next(); if (decision.kind === 'reject' || !decision.messages.length) return decision;
      this.jobs.assertCurrent(this.jobs.get(id)); return decision;
    });
    return { commit: () => this.jobs.assertCurrent(this.jobs.get(id)) };
  }
  attachMain(agentCtx) {
    // The normal user Agent remains host-owned. B7 admits its current job in
    // pre-step; this owner does not create another main conversation or inbox.
    const prompt = compilePrompt('main');
    agentCtx.systemPrompt.section({ name: 'arcfold:tree-main', order: 50, interpolate: false, text: prompt.text });
    agentCtx.on('agent/pre-step', async (payload, next) => {
      const decision = await next(); if (decision.kind === 'reject' || !decision.messages.length) return decision;
      const job = this.jobFor(payload.agent.session.id);
      if (job.role !== 'main' || job.trigger.nativeTurn !== payload.turn || job.status !== 'submitted') fail('MAIN_OWNER', 'Current native user turn lacks a submitted main owner');
      this.jobs.assertCurrent(job); return decision;
    });
  }
  async readEvents(sessionId, ownedHandle) {
    const live = this.host.sessions.get(sessionId);
    if (live && live !== ownedHandle?.agent.session) fail('LIVE_SESSION', 'Cannot recover another live native owner');
    let reader;
    try { reader = await this.host.sessionPersistence.open(sessionId, 'read'); }
    catch (e) { if (e?.name === 'SessionPersistenceNotFoundError') return null; throw e; }
    try { return (await reader.read()).events; } finally { await reader.close(); }
  }
  #resultsFromEvents(job, events) {
    const mainStart = job.role === 'main' && events.find(e => e.type === 'turn/start' && e.data.turn === job.trigger.nativeTurn);
    const mainEnd = mainStart && events.find(e => e.type === 'turn/end' && e.data.turn === job.trigger.nativeTurn && e.seq > mainStart.seq);
    const own = events.find(e => e.type === 'user/message' && (job.role === 'main' ? mainStart && mainEnd && e.seq > mainStart.seq && e.seq < mainEnd.seq && e.data.source?.kind === 'user' : e.data.source?.jobId === job.id));
    if (!own) return null;
    const start = [...events].reverse().find(e => e.type === 'turn/start' && e.seq < own.seq), end = start && events.find(e => e.type === 'turn/end' && e.data.turn === start.data.turn && e.seq > own.seq);
    if (!end || job.role !== 'main' && !['completed', 'max-tokens'].includes(end.data.reason?.kind)) return null;
    const messages = events.filter(e => e.type === 'assistant/message' && e.seq > own.seq && e.seq < end.seq);
    const final = messages.at(-1)?.data.message;
    if (!final || final.content?.some(b => b.type === 'tool-call') && !(job.role !== 'main' && end.data.reason?.kind === 'max-tokens')) return null;
    return { final, start, end, own, events };
  }
  consume(id, events) {
    const job = this.jobs.get(id), result = events && this.#resultsFromEvents(job, events);
    if (!result && events && job.role !== 'main' && !job.invocationIds.length) {
      const own = events.filter(e => e.type === 'user/message' && e.data.source?.jobId === job.id);
      const start = own.length === 1 && events.findLast(e => e.type === 'turn/start' && e.seq < own[0].seq);
      const end = start && events.find(e => e.type === 'turn/end' && e.data.turn === start.data.turn && e.seq > own[0].seq);
      if (end?.data?.reason?.kind === 'error' && canonicalJson(own[0].data) === canonicalJson(job.nativeMessage)
        && !events.some(e => e.type === 'assistant/message' && e.seq > start.seq && e.seq < end.seq))
        return this.jobs.failBeforeInvocation(id, { nativeLogRef: `${job.nativeSessionId}#${end.seq}`, eventsHash: digest(events), reason: end.data.reason.error?.message ?? 'Native request guard rejected before admission' });
    }
    if (!result && events && job.role !== 'main' && job.invocationIds.length) {
      const rejection = this.#contextRejection(job, events);
      if (rejection) return this.jobs.failRejected(id, rejection);
    }
    if (!result) fail('RESULT_UNKNOWN', 'No complete durable native result for this exact job');
    if (!job.invocationIds.length) fail('INVOCATION_MISSING', 'A model result requires at least one guarded paid identity');
    for (const invocationId of job.invocationIds) {
      const invocation = this.jobs.repo.get('tree_invocations', invocationId), ledger = this.ledgerLookup(invocation.ledgerRequestId);
      const message = events.find(e => e.type === 'assistant/message' && e.seq > invocation.stepStartSeq && !events.some(s => s.type === 'step/start' && s.seq > invocation.stepStartSeq && s.seq < e.seq));
      if (!message || !ledger || !(nativeModel(job.modelConfig) ? nativeResponseComplete(ledger) : ledger.status === 'settled')) fail('USAGE_UNKNOWN', 'Every completed model step requires its own completed request record');
      this.jobs.invocationResult(invocationId, { state: 'result_received', usage: ledger.usage, resultHash: digest(message.data), nativeLogRef: `${job.nativeSessionId}#${message.seq}` });
    }
    this.jobs.receive(id, { message: { role: 'assistant', content: result.final.content }, nativeLogRef: `${job.nativeSessionId}#${result.end.seq}`, eventsHash: digest(events) });
    // A durable provider limit with a settled receipt is a known incomplete
    // result, including reasoning-only output. Preserve it and reject; never
    // parse a coincidentally closed prefix or automatically request more tokens.
    if (job.role !== 'main' && result.end.data.reason?.kind === 'max-tokens')
      return this.jobs.transition(id, 'invalid_output', { error: { code: 'OUTPUT_LIMIT', message: 'Provider reached the output limit before completing the final result' }, rawHash: digest(result.final) });
    const validated = this.jobs.validate(id); return validated.status === 'validated' ? this.jobs.commit(id, this.applyResult) : validated;
  }
  // A known refusal: the native turn that carried this job ended with the
  // provider's context-window error, produced no assistant output, and every
  // guarded request has a durable failed native record. Anything less stays
  // unknown. Native-model route only; metered accounting is unchanged.
  #contextRejection(job, events) {
    if (job.role !== 'learning' || !nativeModel(job.modelConfig)) return null;
    const own = events.filter(e => e.type === 'user/message' && e.data.source?.jobId === job.id); if (own.length !== 1) return null;
    const start = events.findLast(e => e.type === 'turn/start' && e.seq < own[0].seq);
    const end = start && events.find(e => e.type === 'turn/end' && e.data.turn === start.data.turn && e.seq > own[0].seq);
    const error = end?.data.reason?.kind === 'error' ? end.data.reason.error : null;
    if (error?.code !== CONTEXT_REJECTED) return null;
    if (events.some(e => e.type === 'assistant/message' && e.seq > start.seq && e.seq < end.seq)) return null;
    for (const invocationId of job.invocationIds) {
      const invocation = this.jobs.repo.get('tree_invocations', invocationId), record = invocation && this.ledgerLookup(invocation.ledgerRequestId);
      if (record?.status !== 'failed' || record.finish !== 'error') return null;
    }
    return { nativeLogRef: `${job.nativeSessionId}#${end.seq}`, eventsHash: digest(events), code: error.code, message: String(error.message || 'Provider rejected the request for context size').slice(0, 4096) };
  }
  run(id) {
    if (this.running.has(id)) return this.running.get(id); const promise = this.#run(id); this.running.set(id, promise);
    void promise.finally(() => this.running.delete(id)).catch(() => {}); return promise;
  }
  async #run(id) {
    let handle, deadline;
    try {
      if (this.closed) fail('OWNER_CLOSED', 'Owner is closed'); let job = this.jobs.get(id);
      if (job.role === 'main') fail('MAIN_HOST_OWNED', 'Main stays in its existing native user Agent; use attachMain and consume');
      if (job.status === 'committed' || ['invalid_output', 'stale', 'cancelled', 'failed'].includes(job.status)) return job;
      if (job.status === 'queued') job = this.jobs.prepare(id);
      if (job.status === 'prepared' && !job.nativeMessage) job = this.jobs.bindMessage(id, this.createUserMessage({ source: { kind: 'arcfold/tree-job', jobId: job.id, role: job.role, inputHash: job.inputHash, origin: 'program' }, content: [{ type: 'text', text: canonicalJson(modelView(job.input)) }] }));
      const existing = await this.readEvents(job.nativeSessionId);
      if (job.status !== 'prepared') return this.consume(id, existing);
      if (existing?.some(e => e.type === 'user/message' && e.data.source?.jobId === id)) fail('RESULT_UNKNOWN', 'Prepared job already has native submission evidence; never resend');
      if (existing?.length) {
        const start = existing.findLast(e => e.type === 'turn/start'), end = existing.findLast(e => e.type === 'turn/end');
        if (start && (!end || end.seq < start.seq)) fail('RESULT_UNKNOWN', 'Previous native turn remains uncertain');
      }
      const config = job.modelConfig, options = { agentOptions: nativeModel(config) ? nativeAgentOptions(config) : { provider: config.provider, model: config.model, maxTokens: config.maxTokens, reasoningEffort: config.reasoningEffort }, setup: ctx => this.setup(ctx, id), meta: { agentPreset: config.preset, cwd: config.cwd } };
      // A log that exists but holds no events, as left by a host stop right
      // after creation, is resumed: creating it again would be refused.
      handle = existing ? await this.host.agents.resume({ ...options, resumeSessionId: job.nativeSessionId }) : await this.host.agents.create({ ...options, sessionId: job.nativeSessionId });
      // A resumed learning session retains its previous native selection. Move
      // only this owned background session to the job's already-frozen route;
      // persist that selection before any submission or provider request.
      if (existing && typeof handle.agent.model?.current === 'function') {
        const current = handle.agent.model.current();
        if (!current || ['provider', 'model', 'reasoningEffort'].some(key => (current[key] ?? null) !== (config[key] ?? null))) {
          if (typeof handle.agent.model.select !== 'function') fail('MODEL_SELECTION_UNAVAILABLE', 'Cannot apply the frozen background model to its native session');
          handle.agent.model.select({ provider: config.provider, model: config.model, ...(config.reasoningEffort == null ? {} : { reasoningEffort: config.reasoningEffort }) });
        }
      }
      this.handles.set(id, handle);
      if (await this.host.sessions.flush(handle.agent.session) !== true) fail('SESSION_NOT_DURABLE', 'Native session is not durably owned');
      // A long learning append can be deferred before submission, inbox append,
      // invocation identity, reservation or any provider request exists.
      await this.beforeSubmit?.(this.jobs.get(id), handle.agent);
      this.jobs.submit(id);
      if (job.role === 'script_writer') deadline = this.timers.setTimeout(() => handle.agent.cancel({ kind: 'user', message: 'Writer reached its 120 second host limit' }, { keepInbox: false }), 120000);
      handle.agent.followup(this.messageFor(this.jobs.get(id))); await handle.agent.whenIdle();
      const prefix = handle.agent.session.snapshotEvents();
      if (await this.host.sessions.flush(handle.agent.session) !== true) fail('RESULT_UNKNOWN', 'Native result flush failed');
      const durable = await this.readEvents(job.nativeSessionId, handle);
      if (!durable || digest(durable.slice(0, prefix.length)) !== digest(prefix)) fail('RESULT_UNKNOWN', 'Durable result differs from native observed prefix');
      const release = await this.beforeResult?.(this.jobs.get(id));
      try { return this.consume(id, durable); }
      finally { release?.(); }
    } catch (e) {
      const job = this.jobs.get(id);
      if (['WORKER_BUSY', 'WRITER_BUSY', 'NODE_BUSY', 'NODE_ORDER', 'LEARNING_UNKNOWN', 'LEARNING_PAUSED'].includes(e.code)) throw e;
      if (TERMINAL_JOBS.includes(job.status)) return job;
      // Domain application is atomic. Keep a validated result recoverable when
      // an application error rolls the transaction back; it is already received.
      if (['result_received', 'validated'].includes(job.status)) return this.jobs.recordError(id, e);
      const state = e.code === 'JOB_STALE' ? 'stale' : job.status === 'queued' || job.status === 'prepared' && e.code !== 'RESULT_UNKNOWN' ? 'failed' : 'unknown';
      return this.jobs.transition(id, state, { error: { code: e.code ?? 'HOST_ERROR', message: e.message } });
    } finally { if (deadline !== undefined) this.timers.clearTimeout(deadline); if (handle) await handle.dispose(); this.handles.delete(id); }
  }
  async recover() {
    const results = [];
    for (const job of this.jobs.repo.list('tree_jobs', j => ['submitted', 'unknown', 'result_received', 'validated'].includes(j.status) && j.role)) {
      let events;
      try { events = await this.readEvents(job.nativeSessionId); results.push(this.consume(job.id, events)); }
      catch (e) {
        const current = this.jobs.get(job.id);
        if (current.status === 'submitted' && e.code !== 'LIVE_SESSION') this.jobs.transition(job.id, 'unknown', { error: { code: e.code ?? 'HOST_ERROR', message: e.message } });
        const settled = e.code === 'RESULT_UNKNOWN' && this.#settleInterrupted(job.id, events ?? []);
        results.push(settled ? { id: job.id, status: settled.status, nodeId: settled.nodeIds[0], interrupted: settled.error } : { id: job.id, status: this.jobs.get(job.id).status, error: e.code ?? e.message });
      }
    } return results;
  }
  // A learning request interrupted when the host stopped: readable session, no
  // complete result, and either this job's input never became durable there or
  // the native log ended its turn as disposed without any answer. Any other
  // turn ending, or no ending, keeps the existing unknown protection.
  #settleInterrupted(id, events) {
    const job = this.jobs.get(id);
    if (job.role !== 'learning' || job.status !== 'unknown') return null;
    const own = events.filter(e => e.type === 'user/message' && e.data.source?.jobId === id), end = own.length ? disposedWithoutAnswer(events, own) : null;
    if (own.length && !end) return null;
    return this.jobs.failInterrupted(id, { eventsHash: digest(events), ...(end ? { nativeLogRef: `${job.nativeSessionId}#${end.seq}` } : {}) });
  }
  async close() { this.closed = true; for (const handle of this.handles.values()) handle.agent.cancel({ kind: 'disposed' }, { keepInbox: true }); await Promise.allSettled([...this.running.values()]); }
}
