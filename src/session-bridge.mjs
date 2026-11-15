import { captureWorks, workId, workState, automaticWorkContext } from './goal-work.mjs';
import { freezeNativeContinuation, assertNativeContinuationCurrent, assertNativeContinuationStored, assertNativeContinuationIntegrity } from './native-continuation.mjs';
import { collectContext, contextMessage, hash, refreshContext } from './context-material.mjs';
import { sourceAvailable } from './evidence.mjs';
import { canonicalJson } from './store.mjs';
import { MethodService } from './methods.mjs';
import { METHOD_CONTEXT, methodContextMessage, eligibleMethodBundle, methodTurn } from './method-context.mjs';
import { GoalService } from './goals.mjs';
import { UnderstandingService } from './understandings.mjs';
import { GOAL_CONTEXT, goalContextMessage, eligibleGoalBundle } from './goal-context.mjs';

export class SessionBridge {
  constructor({ business, methods = new MethodService({ business }), goals = new GoalService({ business }), understandings = new UnderstandingService({ business, goals }), sessions, persistence, logger = console, maxContextCharacters = 24000 }) {
    Object.assign(this, { business, sessions, persistence, logger, maxContextCharacters });
    this.methods = methods;
    this.goals = goals;
    this.understandings = understandings;
    this.pending = new Map();
    this.closed = false;
  }
  get storage() { return this.business.storage; }
  isBound(sessionId) { return typeof sessionId === 'string' && this.storage.get('host_bindings', sessionId)?.role === 'main'; }

  // A reference to the existing host, not another goal/activation registry.
  useNativeRuntime(root) {
    if (this.nativeRoot && this.nativeRoot !== root) throw new Error('Arcfold native host identity changed');
    this.nativeRoot = root;
    this.goals.nativeRoot = root;
  }

  // The official synchronous tools.guard runs after pre-execute/approval.
  // No separate terminal flag: use only this turn's frozen proof and live goal.
  nativeContinuationToolDenial(exec) {
    const agent = exec.agent, session = agent?.session, events = session?.snapshotEvents?.();
    const start = events?.findLast(event => event.type === 'turn/start');
    if (!start) return;
    const snapshots = this.storage.listAll('context_snapshots', { where: { sessionId: session.id, turn: start.data.turn } });
    const proof = snapshots.find(row => row.material.nativeContinuation)?.material.nativeContinuation;
    if (!proof) return; // A later ordinary human turn is not the prior automatic round.
    try {
      if (snapshots.length !== 1 || this.nativeRoot?.get('agents')?.get(agent.id) !== agent ||
          agent.status !== 'running' || events.some(event => event.seq > start.seq && event.type === 'turn/end'))
        throw new Error('Native continuation tool no longer belongs to its current turn');
      const historical = this.work?.historicalContinuation(agent);
      if (historical) assertNativeContinuationIntegrity(this.storage, proof);
      else assertNativeContinuationStored(this.storage, proof);
      const goal = this.nativeRoot.get('goals').get(agent);
      if (!historical && (!goal || goal.id !== proof.goalId || goal.revision !== proof.revision || goal.phase !== 'active' ||
          goal.activation !== 'armed' || goal.roundsStarted !== proof.round))
        return 'This automatic goal round no longer authorizes tools. After completion or blocking, provide only the final explanation.';
      const callId = exec.rootCallId ?? exec.callId;
      const call = events.findLast(event => event.type === 'tool/call' && event.data.callId === callId);
      const assistant = call && events.findLast(event => event.seq < call.seq && event.type === 'assistant/message' &&
        event.data.turn === call.data.turn && event.data.step === call.data.step);
      if (!call || call.data.turn !== start.data.turn || !assistant ||
          assistant.data.message.role !== 'assistant' || assistant.data.message.source?.kind !== 'model')
        throw new Error('Native continuation tool has no current model call original');
      const batch = assistant.data.message.content.filter(block => block.type === 'tool-call');
      const terminal = batch.some(block => {
        if (block.name !== 'update_goal') return false;
        try { return ['complete', 'blocked'].includes(JSON.parse(block.arguments).action); } catch { return false; }
      });
      if (terminal && batch.length !== 1)
        return 'Call update_goal complete or blocked alone. A terminal transition cannot share a tool batch with further actions.';
    } catch (error) { return error.message; }
  }

  async durablePrefix(session) {
    // Capture BEFORE the awaited flush: later events are not covered by this barrier.
    const events = session.snapshotEvents();
    if (await this.sessions.flush(session) !== true) throw new Error('Arcfold requires a participating durable session writer');
    return events;
  }

  ingestAndSettle(sessionId, events) {
    this.business.ingestSession({ sessionId, events });
    captureWorks(this.storage, sessionId, events);
    const settled = [];
    for (const event of events) if (event.type === 'turn/end') {
      // The full durable prefix also proves fork inheritance. BusinessStore
      // restricts this delivery's sources to its own turn/end internally.
      const result = this.business.settleTurn({ sessionId, turn: event.data.turn, events });
      settled.push(result);
      const starts = events.filter(row => row.type === 'turn/start' && row.data.turn === event.data.turn);
      const ends = events.filter(row => row.type === 'turn/end' && row.data.turn === event.data.turn);
      const inherited = events.some(row => row.type === 'session/end-seed' && row.data.inherited === true && row.seq > event.seq);
      if (starts.length === 1 && ends.length === 1 && starts[0].seq < event.seq && !inherited) {
        const outcome = ({ completed: 'completed', aborted: 'cancelled', error: 'failed', interrupted: 'interrupted' })[event.data.reason?.kind] ?? 'unknown';
        this.methods.settleTurn({ sessionId, turn: event.data.turn, startSeq: starts[0].seq,
          outcome, deliveryId: result.delivery?.id ?? null });
        this.goals.settleTurn({ sessionId, turn: event.data.turn, startSeq: starts[0].seq,
          outcome, deliveryId: result.delivery?.id ?? null });
      }
    }
    return settled;
  }

  async reconcile(session) {
    if (!this.isBound(session.id)) return [];
    let events;
    try { events = await this.durablePrefix(session); }
    catch (error) {
      // The host may close its writer before our queued turn-end observer runs.
      // Keep that failure, then reconcile only actual persisted bytes. A missing
      // durable end remains unresolved; a live/synthesized end is not evidence.
      this.recordFailure(session.id, error);
      events = await this.readPersisted(session.id);
    }
    return this.ingestAndSettle(session.id, events);
  }

  async readPersisted(sessionId) {
    const handle = await this.persistence.open(sessionId, 'read');
    try { return (await handle.read()).events; }
    finally { await handle.close(); }
  }

  recordFailure(sessionId, error) {
    const id = 'bridge-failure-' + hash({ sessionId, message: String(error?.message || error) });
    if (!this.storage.get('bridge_failures', id)) this.storage.save('bridge_failures', {
      id, sessionId, message: String(error?.message || error), operation: 'business_reconciliation',
      authority: 'does not change the DSH execution result',
    });
    this.logger.warn?.(`Arcfold could not reconcile ${sessionId}: ${String(error?.message || error)}`);
  }

  assertRequestCurrent(options, events = null) {
    const liveAgent = this.nativeRoot?.get('agents')?.get(options.sessionId);
    if (liveAgent) this.work?.assertCurrent(liveAgent);
    const messages = options.messages.filter(message => message.source?.kind === 'arcfold/context');
    if (messages.length !== 1) throw new Error('Arcfold request must contain exactly one current context snapshot');
    const message = messages[0];
    const snapshots = this.storage.listAll('context_snapshots', { where: { sessionId: options.sessionId, contextMessageId: message.id } });
    if (snapshots.length !== 1 || hash(contextMessage(snapshots[0].material)) !== hash(message)) throw new Error('Arcfold request context is not the saved material');
    if (hash(refreshContext(this.storage, snapshots[0].material)) !== hash(snapshots[0].material)) {
      const error = new Error('Arcfold background changed before model dispatch; this request was not sent');
      error.code = 'ARCFOLD_CONTEXT_CHANGED';
      throw error;
    }
    this.assertClaimedInputsEntered(options, snapshots[0], events);
    const continuation = snapshots[0].material.nativeContinuation;
    if (continuation) {
      const agent = this.nativeRoot?.get('agents')?.get(options.sessionId);
      assertNativeContinuationCurrent({ store: this.storage, proof: continuation,
        events: events ?? this.sessions.get(options.sessionId)?.snapshotEvents() ?? [],
        agent, goal: agent && this.nativeRoot.get('goals')?.get(agent), messages: options.messages,
        historical: agent && this.work?.historicalContinuation(agent) });
    }
  }

  // Preparing from a durable inbox original is not proof that the host admitted
  // it. Check the actual native turn and the assembled request before dispatch.
  assertClaimedInputsEntered(options, snapshot, events = null) {
    const claims = snapshot.claimedInputs || [];
    if (!claims.length) return;
    const native = events ?? this.sessions.get(options.sessionId)?.snapshotEvents();
    const reject = () => { throw Object.assign(new Error('Arcfold claimed input did not enter this native turn unchanged; this request was not sent'),
      { code: 'ARCFOLD_CONTEXT_CHANGED' }); };
    if (!native) reject();
    const starts = native.filter(event => event.type === 'turn/start' && event.data.turn === snapshot.turn);
    if (starts.length !== 1 || native.some(event => event.seq > starts[0].seq && event.type === 'turn/end')) reject();
    for (const claim of claims) {
      const source = this.storage.get('events', claim.sourceId), ref = claim.inboxRef;
      if (!sourceAvailable(this.storage, source) || source.sessionId !== options.sessionId ||
          source.message?.id !== claim.messageId || source.message.role !== 'user' ||
          source.message.source?.kind !== 'user' || source.message.source.principal !== undefined ||
          hash(JSON.parse(canonicalJson(source.message))) !== claim.messageHash ||
          ref?.sessionId !== options.sessionId || ref.type !== 'agent/inbox/spliced' || !Number.isSafeInteger(ref.index)) reject();
      const inbox = native.filter(event => event.seq === ref.seq && event.type === ref.type);
      if (inbox.length !== 1 || hash(JSON.parse(canonicalJson(inbox[0]))) !== ref.sha256 ||
          canonicalJson(inbox[0].data.inserted?.[ref.index] ?? null) !== canonicalJson(source.message)) reject();
      const entered = native.filter(event => event.seq > starts[0].seq && event.type === 'user/message' && event.data.id === claim.messageId);
      const sent = options.messages.filter(message => message.id === claim.messageId);
      if (entered.length !== 1 || sent.length !== 1 || canonicalJson(entered[0].data) !== canonicalJson(source.message) ||
          canonicalJson(sent[0]) !== canonicalJson(source.message)) reject();
    }
  }

  // Synchronous so the paid sender can repeat this after its final awaited I/O,
  // immediately before network dispatch. This does not claim a request was sent.
  assertMethodRequestCurrent(options, events = null) {
    const session = this.sessions.get(options.sessionId);
    if (!session) throw new Error('Arcfold requires the current native session before dispatch');
    const { position, step } = methodTurn(session);
    const bundle = eligibleMethodBundle(this.methods, events ?? session.snapshotEvents(), position);
    const expected = bundle.methods.length ? methodContextMessage(bundle) : null;
    const provided = options.messages.filter(message => message.source?.kind === METHOD_CONTEXT);
    if (provided.length !== (expected ? 1 : 0) || expected && hash(provided[0]) !== hash(expected)) {
      const error = new Error('Arcfold method input changed or lacks a successful native selection result; this request was not sent');
      error.code = 'ARCFOLD_METHOD_CONTEXT_CHANGED';
      throw error;
    }
    return { bundle, expected, position, step };
  }

  assertGoalRequestCurrent(options, events = null) {
    const session = this.sessions.get(options.sessionId);
    if (!session) throw new Error('Arcfold requires the current native session before dispatch');
    const { position, step } = methodTurn(session);
    const bundle = eligibleGoalBundle(this.goals, events ?? session.snapshotEvents(), position);
    const expected = bundle.links.length ? goalContextMessage(bundle) : null;
    const provided = options.messages.filter(message => message.source?.kind === GOAL_CONTEXT);
    if (provided.length !== (expected ? 1 : 0) || expected && hash(provided[0]) !== hash(expected)) {
      const error = new Error('Arcfold goal input changed or lacks a successful native selection result; this request was not sent');
      error.code = 'ARCFOLD_GOAL_CONTEXT_CHANGED';
      throw error;
    }
    return { bundle, expected, position, step };
  }

  guardStream(options, next) {
    if (!this.isBound(options.sessionId) || options.purpose !== undefined) return next();
    const bridge = this;
    return (async function* () {
      options.signal?.throwIfAborted();
      // Runs when the downstream model stream is first consumed, after awaited
      // request preparation/checkpoints and before calling the provider chain.
      const session = bridge.sessions.get(options.sessionId);
      if (!session) throw new Error('Arcfold requires the current native session before dispatch');
      const events = await bridge.durablePrefix(session);
      options.signal?.throwIfAborted();
      bridge.methods.reconcile();
      bridge.goals.reconcile();
      bridge.assertRequestCurrent(options, events);
      const { position, step, bundle, expected } = bridge.assertMethodRequestCurrent(options, events);
      const linked = bridge.assertGoalRequestCurrent(options, events);
      if (expected) {
        const requestIdentity = 'method-request-' + hash({ ...position, stepSeq: step.seq,
          headerSeq: events.findLast(row => row.type === 'request/header')?.seq ?? null,
          attempts: events.filter(row => row.seq > step.seq && row.type === 'assistant/attempt').map(row => row.seq) });
        bridge.methods.recordInput({ adoptionIds: bundle.methods.map(row => row.adoptionId), ...position,
          step: step.data.step, requestIdentity, inputHash: hash(expected) });
      }
      if (linked.expected) {
        const requestIdentity = 'goal-request-' + hash({ ...linked.position, stepSeq: linked.step.seq,
          headerSeq: events.findLast(row => row.type === 'request/header')?.seq ?? null,
          attempts: events.filter(row => row.seq > linked.step.seq && row.type === 'assistant/attempt').map(row => row.seq) });
        bridge.goals.recordInput({ linkIds: linked.bundle.links.map(row => row.linkId), ...linked.position,
          step: linked.step.data.step, requestIdentity, inputHash: hash(linked.expected) });
      }
      yield* next();
    })();
  }

  observe(session, event) {
    if (this.closed || event.type !== 'turn/end' || !this.isBound(session.id)) return;
    const previous = this.pending.get(session.id) || Promise.resolve();
    // A microtask leaves the synchronous session/event notification stack.
    const task = previous.then(() => this.reconcile(session)).catch(error => this.recordFailure(session.id, error));
    this.pending.set(session.id, task);
    void task.finally(() => { if (this.pending.get(session.id) === task) this.pending.delete(session.id); }).catch(error => this.logger.error?.(error));
  }

  async prepare({ agent, messages, turn, step, signal }, decision) {
    if (this.closed) throw new Error('Arcfold plugin is stopping');
    if (decision.kind === 'reject' || step === 1 && decision.messages.length === 0) return decision;
    signal.throwIfAborted();
    const session = agent.session;
    await this.pending.get(session.id);
    const events = await this.durablePrefix(session);
    signal.throwIfAborted();
    this.methods.reconcile();
    this.goals.reconcile();
    const directInputs = messages.filter(message => message.role === 'user' && message.source?.kind === 'user');
    for (const message of directInputs) {
      const original = events.find(event => event.type === 'agent/inbox/spliced' && event.data.inserted?.some(input => input.id === message.id && hash(input) === hash(message)));
      if (!original) throw new Error('Claimed user input has no matching durable inbox source');
    }
    let claimedInputs;
    this.storage.transaction(() => {
      const bound = this.storage.get('host_bindings', session.id);
      if (!bound) this.storage.save('host_bindings', { id: session.id, sessionId: session.id, role: 'main', binding: 'trusted-arcfold-agent-preset' });
      else if (bound.role !== 'main') throw new Error('Arcfold session has a conflicting role');
      this.ingestAndSettle(session.id, events);
      claimedInputs = this.business.ingestClaimedInputs({ sessionId: session.id, events,
        messages: directInputs.filter(message => message.source.principal === undefined) });
    });
    // Keep original ingestion committed if an explicit replacement is stale.
    this.understandings.applyClaimedCorrections({ sessionId: session.id, claims: claimedInputs, events });
    const key = 'context-' + hash({ sessionId: session.id, turn });
    const previous = this.storage.get('context_snapshots', key);
    const nativeGoal = this.nativeRoot?.get('goals')?.get(agent);
    const currentContinuation = freezeNativeContinuation({ store: this.storage, sessionId: session.id, turn,
      messages, events, goal: nativeGoal, stage: this.work?.current(agent) });
    if (previous?.material.nativeContinuation && currentContinuation &&
        canonicalJson(previous.material.nativeContinuation) !== canonicalJson(currentContinuation))
      throw new Error('Native continuation identity changed inside its turn');
    const continuation = previous?.material.nativeContinuation ?? currentContinuation;
    const claims = new Map((previous?.claimedInputs || []).map(claim => [claim.messageId, claim]));
    for (const claim of claimedInputs) {
      const prior = claims.get(claim.messageId);
      if (prior && canonicalJson(prior) !== canonicalJson(claim)) throw new Error('Arcfold claimed input changed within its native turn');
      claims.set(claim.messageId, claim);
    }
    claimedInputs = [...claims.values()];
    const newInputIds = directInputs.map(message => message.id);
    const reuse = previous && !newInputIds.some(id => !previous.material.inputMessageIds.includes(id));
    const requiredMaterial = continuation ? { nativeContinuation: continuation } : {};
    if (this.work) {
      const currentStage = this.work.current(agent), stage = this.work.view(currentStage);
      if (stage) requiredMaterial.executionStage = { ...stage, boundToTurn: this.work.boundToTurn(currentStage, turn) };
    }
    if (continuation && !reuse) {
      const work = this.storage.get('goal_works', workId(session.id, continuation.goalId));
      const background = work && automaticWorkContext(this.goals, work,
        workState(this.storage, work.id), this.storage.currentSequence());
      if (background) requiredMaterial.workGoalContext = background;
    }
    const material = reuse ? refreshContext(this.storage, previous.material)
      : collectContext(this.storage, { sessionId: session.id, turn,
        inputMessageIds: [...new Set([...(previous?.material.inputMessageIds || []), ...newInputIds])],
        maxCharacters: this.maxContextCharacters, requiredMaterial });
    if (requiredMaterial.executionStage) material.executionStage = requiredMaterial.executionStage;
    const message = contextMessage(material);
    if (!previous || hash(previous.material) !== hash(material) || canonicalJson(previous.claimedInputs || []) !== canonicalJson(claimedInputs)) this.storage.save('context_snapshots', {
      id: key, sessionId: session.id, turn, material, contextMessageId: message.id, claimedInputs,
      evidence: 'prepared-material; actual adoption requires matching native user/message and request',
    }, { expectedRevision: previous?.revision ?? null });
    signal.throwIfAborted();
    const start = events.findLast(event => event.type === 'turn/start');
    if (!start || start.data.turn !== turn || events.some(event => event.seq > start.seq && event.type === 'turn/end'))
      throw new Error('Arcfold preparation requires the current open native turn');
    const bundle = eligibleMethodBundle(this.methods, events, { sessionId: session.id, turn, startSeq: start.seq });
    const methodMessage = bundle.methods.length ? methodContextMessage(bundle) : null;
    const linked = eligibleGoalBundle(this.goals, events, { sessionId: session.id, turn, startSeq: start.seq });
    const goalMessage = linked.links.length ? goalContextMessage(linked) : null;
    const expected = new Map([['arcfold/context', message], [METHOD_CONTEXT, methodMessage], [GOAL_CONTEXT, goalMessage]]);
    const present = new Set();
    // Only our context nodes are retired; human originals and tool receipts stay.
    for (const seq of [...session.surface.nodes]) {
      const event = session.eventAt(seq);
      const kind = event?.data.source?.kind;
      if (event?.type !== 'user/message' || !expected.has(kind)) continue;
      if (expected.get(kind) && !present.has(kind) && hash(event.data) === hash(expected.get(kind))) { present.add(kind); continue; }
      session.append('user/message', {
        id: 'arcfold-retired-' + hash({ sessionId: session.id, seq }), role: 'user',
        source: { kind: 'arcfold/context-retired', replacedContextId: event.data.id },
        content: [{ type: 'text', text: '此前的 Arcfold 背景已移出当前模型上下文；原始记录仍保留供历史审计。' }],
      }, { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] });
    }
    // A deferred context can survive a failed tool. Reconstruct ours from saved
    // selections plus successful native results instead of trusting that inbox.
    const admitted = decision.messages.filter(row => !expected.has(row.source?.kind));
    const additions = [...expected].filter(([kind, row]) => row && !present.has(kind)).map(([, row]) => row);
    const lastInput = admitted.findLastIndex(row => messages.includes(row));
    return { ...decision, messages: admitted.toSpliced(lastInput + 1, 0, ...additions) };
  }

  async recover() {
    for (const binding of this.storage.listAll('host_bindings')) {
      if (binding.role !== 'main') continue;
      try {
        const live = this.sessions.get(binding.sessionId);
        if (live) { await this.reconcile(live); continue; }
        this.ingestAndSettle(binding.sessionId, await this.readPersisted(binding.sessionId));
      } catch (error) { this.recordFailure(binding.sessionId, error); }
    }
  }

  async close() {
    this.closed = true;
    await Promise.allSettled([...this.pending.values()]);
    this.business.close();
  }
}
