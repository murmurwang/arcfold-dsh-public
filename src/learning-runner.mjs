import { randomUUID } from 'node:crypto';
import { hash } from './context-material.mjs';
import { canonicalJson } from './store.mjs';
import { LearningDefaults, learningExecutionConfig, deploymentSelectionValidator } from './learning-defaults.mjs';

// DSH rc.1 keeps this required fact even when optional context is suppressed.
// Match workingDirectory.contextText + joinContextSections, never a free-form
// model instruction. Native projection may regenerate its message id.
export function directoryContext(cwd) {
  const section = { name: 'working-directory:current', text: `Current working directory: ${JSON.stringify(cwd)}.` };
  return { role: 'user', source: { kind: 'runtime-context', form: 'snapshot', sections: [section] },
    content: [{ type: 'text', text: `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${section.text}` }] };
}
export function contextMatches(message, expected) {
  if (!message || typeof message.id !== 'string' || !message.id) return false;
  const { id, ...body } = message;
  return canonicalJson(body) === canonicalJson(expected);
}

/** Dispatches durable learning intents through DSH; it contains no model/tool loop. */
export class LearningRunner {
  constructor({ business, learning, host, config, defaults, onSettled = () => {}, logger = console }) {
    if (!config || !['preset', 'provider', 'model', 'reasoningEffort'].every(key => typeof config[key] === 'string' && config[key]))
      throw new Error('Learning requires an explicit preset, provider, model and reasoningEffort');
    if (!Number.isSafeInteger(config.maxTokens) || config.maxTokens < 1)
      throw new Error('Learning requires an explicit positive maxTokens');
    Object.assign(this, { business, learning, host, config: { ...config }, logger });
    this.storage = business.storage;
    this.defaults = defaults ?? new LearningDefaults({ business,
      deployment: { ...config, cwd: config.cwd ?? host.workingDirectory?.defaultDirectory },
      assertSelection: deploymentSelectionValidator(config) });
    this.defaults.initialize();
    this.onSettled = onSettled;
    this.closed = false;
    this.active = null;
    this.handle = null;
    this.rerunRequested = false;
    this.closing = null;
    this.creation = new AbortController();
  }

  executionConfigFor(id) { return learningExecutionConfig(this.storage.get('learning_runs', id)); }

  updateRun(id, changes) {
    const run = this.storage.get('learning_runs', id);
    if (!run) throw new Error('Missing learning dispatch identity');
    if ('executionConfig' in changes || 'defaultsRevision' in changes)
      throw new Error('A started learning execution configuration cannot be replaced');
    return this.storage.save('learning_runs', { ...run, ...changes }, { expectedRevision: run.revision });
  }

  attention(id, error) {
    const details = { code: error?.code || 'learning_host_failure', message: String(error?.message || error) };
    this.storage.transaction(() => {
      const run = this.storage.get('learning_runs', id);
      if (run && run.state !== 'settled') this.updateRun(id, {
        state: run.state === 'prepared' ? 'failed' : 'unknown', error: details,
      });
      const pending = this.storage.get('learning_pending', id);
      if (pending?.status === 'pending') this.storage.save('learning_pending', {
        ...pending, status: 'needs_attention', error: details,
        effect: 'the delivered answer is retained; no automatic model retry',
      }, { expectedRevision: pending.revision });
    });
    this.logger.warn?.(`Arcfold learning ${id}: ${details.message}`);
  }

  kick() {
    if (this.closed) return this.active || Promise.resolve();
    if (this.active) { this.rerunRequested = true; return this.active; }
    this.rerunRequested = false;
    // Leave synchronous event publication. One helper at a time, independently
    // of all main Agents; a new human input never awaits this promise.
    const task = Promise.resolve().then(async () => {
      while (!this.closed) {
        const pending = this.storage.list('learning_pending', { where: { status: 'pending' }, limit: 1 })[0];
        if (!pending) return;
        try { await this.runOne(pending.id); }
        catch (error) { this.attention(pending.id, error); }
      }
    });
    this.active = task;
    void task.finally(() => {
      if (this.active === task) this.active = null;
      if (this.rerunRequested && !this.closed) void this.kick().catch(error => this.logger.error?.(error));
    }).catch(error => this.logger.error?.(error));
    return task;
  }

  async readSession(sessionId, ownedHandle = null) {
    const live = this.host.sessions.get(sessionId);
    if (live && live !== ownedHandle?.agent.session) throw new Error('Recovery refused: the learning session already has a live owner');
    let handle;
    try { handle = await this.host.sessionPersistence.open(sessionId, 'read'); }
    catch (error) {
      if (error?.name === 'SessionPersistenceNotFoundError' && error.sessionId === sessionId) return null;
      throw error;
    }
    try { return (await handle.read()).events; }
    finally { await handle.close(); }
  }

  guardStream(options, next) {
    const runs = typeof options.sessionId === 'string'
      ? this.storage.listAll('learning_runs', { where: { sessionId: options.sessionId } }) : [];
    if (!runs.length) return next();
    const runner = this;
    return (async function* () {
      options.signal?.throwIfAborted();
      const run = runner.storage.get('learning_runs', runs[0].id);
      const execution = runner.executionConfigFor(run.id);
      const input = runner.learning.prepare(run.id);
      const originals = options.messages.filter(message => message.source?.kind === 'arcfold/learning');
      const contexts = options.messages.filter(message => message.source?.kind === 'runtime-context');
      const systems = options.messages.filter(message => message.role === 'system')
        .flatMap(message => message.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
      const unexpected = options.messages.some(message => message.role !== 'system' &&
        !['arcfold/learning', 'runtime-context'].includes(message.source?.kind));
      const session = runner.host.sessions.get(options.sessionId);
      if (runner.closed || runs.length !== 1 || run.state !== 'submitted' || run.dispatchCount !== 0 ||
          options.purpose !== undefined || options.provider !== execution.provider || options.model !== execution.model ||
          options.reasoningEffort !== execution.reasoningEffort || options.maxTokens !== execution.maxTokens ||
          options.tools?.length || options.toolHistory?.tools?.length || options.toolHistory?.updates?.length ||
          unexpected || options.system !== undefined ||
          options.messages.length !== 3 || originals.length !== 1 || hash(originals[0]) !== hash(run.message) || systems !== input.prompt ||
          !session || run.hostCwd !== execution.cwd || runner.host.workingDirectory.get(session) !== run.hostCwd || contexts.length !== 1 ||
          !contextMatches(contexts[0], run.hostContext))
        throw new Error('Learning request differs from its single-call, no-tools, frozen-input contract');
      // This is a dispatch intent, NOT proof that a provider received or billed
      // it. Persist before entering downstream code; uncertainty never retries.
      runner.updateRun(run.id, { dispatchCount: 1, requestHash: hash({ messages: options.messages, tools: options.tools || [] }),
        runtimeContextMessage: contexts[0],
        dispatchEvidence: 'validated-before-downstream-stream; provider outcome requires native events' });
      yield* next();
    })();
  }

  async setup(agentCtx, input, execution) {
    await this.host.agentPresets.mount(agentCtx, execution.preset);
    agentCtx.tools.restrict({ allow: [] });
    // Only this no-tools helper has a complete frozen prompt. Main Arcfold
    // Agents retain DSH's native persona/tool instructions and runtime context.
    agentCtx.systemPrompt.suppressRuntimeContext();
    agentCtx.systemPrompt.section({ name: 'arcfold:learning', order: 50, interpolate: false, complete: true, text: input.prompt });
    agentCtx.on('agent/pre-step', async (payload, next) => {
      const decision = await next();
      if (decision.kind === 'reject') return decision;
      // DSH prepares once more with no messages to finish a normal turn. That
      // empty completion check is not another model call and must remain valid.
      if (payload.step > 1 && decision.messages.length) throw new Error('Learning accepts exactly one input and one model request');
      this.learning.prepare(input.id);
      if (payload.step === 1) {
        const cwd = this.host.workingDirectory.get(payload.agent.session);
        const contexts = decision.messages.filter(message => message.source?.kind === 'runtime-context');
        const expected = directoryContext(cwd);
        if (cwd !== execution.cwd || contexts.length !== 1 || !contextMatches(contexts[0], expected))
          throw new Error('Learning requires the exact native working-directory context and no other runtime facts');
        this.updateRun(input.id, { hostCwd: cwd, hostContext: expected });
      }
      return decision;
    });
    return { commit: () => {
      if (this.closed) throw new Error('Learning plugin is stopping');
      this.learning.prepare(input.id);
    } };
  }

  async runOne(id) {
    let run = this.storage.get('learning_runs', id);
    let existingEvents = null;
    if (run) {
      // Inspect before resume: resuming a DSH Agent can start its pending inbox.
      existingEvents = await this.readSession(run.sessionId);
      if (run.state !== 'prepared') {
        if (['submitted', 'settled', 'unknown'].includes(run.state) && existingEvents?.some(event => event.type === 'turn/end')) {
          if (run.state === 'unknown') this.updateRun(id, { state: 'submitted',
            recoveredFrom: 'unknown; durable-native-log-found-without-model-dispatch' });
          const result = this.learning.commit(id, { sessionId: run.sessionId, events: existingEvents });
          this.updateRun(id, { state: 'settled', resultStatus: result.status, recoveredFrom: 'durable-native-log' });
          this.onSettled(id);
          return result;
        }
        throw new Error('Prior learning submission has no complete durable result; no request was repeated');
      }
      if (existingEvents?.some(event => ['turn/start', 'user/message', 'agent/inbox/spliced', 'assistant/request'].includes(event.type)))
        throw new Error('Prepared learning identity already contains execution evidence; automatic resume refused');
    }
    // A legacy prepared row is never filled from today's configuration.
    if (run) this.executionConfigFor(id);
    let input;
    this.storage.transaction(() => {
      input = this.learning.prepare(id);
      if (run) return;
      const snapshot = this.defaults.snapshot();
      const message = { id: `arcfold-learning-${randomUUID()}`, role: 'user',
        source: { kind: 'arcfold/learning', pendingId: id, deliveryId: input.deliveryId },
        content: [{ type: 'text', text: input.inputText }] };
      run = this.storage.save('learning_runs', { id, pendingId: id, deliveryId: input.deliveryId,
        sessionId: `session-${randomUUID()}`, messageId: message.id, message,
        inputHash: input.inputHash, state: 'prepared', dispatchCount: 0, ...snapshot,
        authority: 'auxiliary-learning; does-not-act-as-human-or-authorize-tools' });
    });
    if (this.closed) return;
    const execution = this.executionConfigFor(id);
    const agentOptions = { provider: execution.provider, model: execution.model, maxTokens: execution.maxTokens,
      reasoningEffort: execution.reasoningEffort };
    const setup = agentCtx => this.setup(agentCtx, input, execution);
    const handle = existingEvents
      ? await this.host.agents.resume({ resumeSessionId: run.sessionId, agentOptions, setup, signal: this.creation.signal })
      : await this.host.agents.create({ sessionId: run.sessionId, agentOptions, setup,
        signal: this.creation.signal,
        meta: { agentPreset: execution.preset, cwd: execution.cwd } });
    this.handle = handle;
    try {
      if (this.closed) throw new Error('Learning plugin stopped before submission');
      if (await this.host.sessions.flush(handle.agent.session) !== true)
        throw new Error('Learning requires a durable native session writer');
      this.learning.prepare(id);
      this.updateRun(id, { state: 'submitted', submissionEvidence: 'intent persisted before followup; not proof of provider receipt' });
      handle.agent.followup(run.message);
      await handle.agent.whenIdle();
      const expected = handle.agent.session.snapshotEvents();
      let events;
      try {
        if (await this.host.sessions.flush(handle.agent.session) !== true)
          throw new Error('Learning output was not confirmed durable');
        events = await this.readSession(run.sessionId, handle);
      } catch (error) {
        if (!this.closed) throw error;
        // Cordis unloads sibling effects in parallel, including the host's
        // handle owner. Wait for that same disposer and then read durable data.
        await handle.dispose();
        events = await this.readSession(run.sessionId);
      }
      if (!events || events.length < expected.length || hash(events.slice(0, expected.length)) !== hash(expected))
        throw new Error('Durable learning readback differs from the completed native prefix');
      const result = this.learning.commit(id, { sessionId: run.sessionId, events });
      this.updateRun(id, { state: 'settled', resultStatus: result.status });
      this.onSettled(id);
      return result;
    } finally {
      await handle.dispose();
      if (this.handle === handle) this.handle = null;
    }
  }

  close() {
    if (!this.closing) {
      this.closed = true;
      this.creation.abort(new Error('Learning plugin is stopping'));
      // DSH owns cancellation, native session persistence and tool cleanup.
      this.closing = (async () => {
        this.handle?.agent.cancel({ kind: 'disposed' }, { keepInbox: true });
        await this.active;
      })();
    }
    return this.closing;
  }

  async recover() {
    // Read-only recovery of already-submitted work; never creates/resumes an
    // Agent. Complete durable output can be committed even after a prior stop.
    for (const run of this.storage.listAll('learning_runs')) {
      if (!['submitted', 'unknown'].includes(run.state)) continue;
      try {
        const events = await this.readSession(run.sessionId);
        if (!events?.some(event => event.type === 'turn/end')) throw new Error('Learning outcome remains unknown; request was not repeated');
        if (run.state === 'unknown') this.updateRun(run.id, { state: 'submitted', recoveredFrom: 'durable-native-log; no-model-retry' });
        const result = this.learning.commit(run.id, { sessionId: run.sessionId, events });
        this.updateRun(run.id, { state: 'settled', resultStatus: result.status, recoveredFrom: 'durable-native-log' });
        this.onSettled(run.id);
      } catch (error) { this.attention(run.id, error); }
    }
  }
}
