import { assertNativeContinuationIntegrity } from './native-continuation.mjs';
import { createHash } from 'node:crypto';
import { Store, DomainError, canonicalJson, identity, jsonClone } from './store.mjs';

const MESSAGE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result']);
const SURFACE_TYPES = new Set([...MESSAGE_TYPES, 'system/message', 'developer/message']);
const hash = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
export const eventId = (sessionId, seq) => `dsh-event:${hash([sessionId, seq])}`;
const turnId = (sessionId, turn) => `dsh-turn:${hash([sessionId, turn])}`;

/** Read visible text without persisting a second copy of message blocks. */
export function messageText(message) {
  return (message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('');
}

function eventBatch(sessionId, events) {
  identity(sessionId, 'Session id');
  if (!Array.isArray(events)) throw new DomainError('invalid_events', 'Events must be an array.', 400);
  const copy = jsonClone(events);
  for (let i = 0; i < copy.length; i++) {
    const event = copy[i];
    if (!event || typeof event !== 'object' || Array.isArray(event) ||
        !Number.isSafeInteger(event.seq) || event.seq < 0 ||
        !Number.isSafeInteger(event.time) || !Number.isFinite(new Date(event.time).getTime()) ||
        !event.data || typeof event.data !== 'object' || Array.isArray(event.data))
      throw new DomainError('invalid_event', 'Expected a lossless DSH event with seq, time and data.', 400);
    identity(event.type, 'Event type');
    if (i && event.seq !== copy[i - 1].seq + 1)
      throw new DomainError('event_sequence_gap', 'Event batches must retain contiguous DSH order.');
  }
  return copy;
}

function validateMessage(message, role) {
  if (!message || typeof message !== 'object' || !Array.isArray(message.content) ||
      !message.source || typeof message.source !== 'object')
    throw new DomainError('invalid_message', 'A DSH source message needs its content and producer.', 400);
  identity(message.id, 'Message id'); identity(message.source.kind, 'Message producer');
  if (message.role !== role) throw new DomainError('invalid_message_role', 'Event type and message role disagree.', 400);
  for (const block of message.content) {
    if (!block || typeof block !== 'object' || typeof block.type !== 'string' ||
        (['text', 'reasoning'].includes(block.type) && typeof block.text !== 'string'))
      throw new DomainError('invalid_message', 'Message blocks must preserve their declared type.', 400);
  }
}

function sourceProjection(sessionId, event, sha256) {
  if (!MESSAGE_TYPES.has(event.type)) return null;
  const message = event.type === 'user/message' ? event.data : event.data.message;
  const role = event.type === 'user/message' ? 'user' : event.type === 'assistant/message' ? 'assistant' : 'tool';
  validateMessage(message, role);
  // A user-role runtime snapshot/relay is never a human decision.
  const author = message.source.kind === (role === 'assistant' ? 'model' : role) ? role : 'program';
  const sourceRef = { sessionId, seq: event.seq, type: event.type, sha256 };
  return { id: eventId(sessionId, event.seq), conversationId: sessionId, sessionId,
    role: author, author, occurredAt: new Date(event.time).toISOString(),
    provenance: { kind: 'dsh_session', source: message.source, sourceRef },
    message, surfaceOp: event.surfaceOp ?? null,
    sourceEventSeqs: event.sourceEventSeqs ?? [],
    ...(event.type !== 'user/message' ? { turn: event.data.turn, step: event.data.step } : {}),
    ...(event.data.interrupted === true ? { interrupted: true } : {}) };
}

function sourceIndex(sources) {
  const index = new Map();
  for (const source of sources) {
    // Authentic command sources are business originals, not chat messages.
    if (!source.message?.id) continue;
    const id = source.message.id;
    if (!index.has(id)) index.set(id, []);
    index.get(id).push(source);
  }
  return index;
}

function sameMessage(sources, message) {
  if (sources.some(source => canonicalJson(source.message) !== canonicalJson(message)))
    throw new DomainError('source_identity_conflict', 'The same native message identity has different original content.');
}

// The caller owns the official claim boundary. Match its complete message to
// real durable insertion facts; this does not implement another inbox/driver.
function claimedOrigins(batch, messages) {
  return messages.map(message => {
    const origins = batch.flatMap(event => event.type === 'agent/inbox/spliced' && Array.isArray(event.data.inserted)
      ? event.data.inserted.flatMap((input, index) => input?.id === message.id ? [{ message: input, event, index }] : []) : []);
    if (!origins.length)
      throw new DomainError('invalid_claimed_input', 'Claimed input has no durable native inbox original.');
    // Official queue editing preserves message.id and replaces its content.
    // Only the latest insertion can match the host's current claimed payload;
    // sameMessage still protects any original already saved as a source.
    const origin = origins.at(-1);
    if (canonicalJson(origin.message) !== canonicalJson(message))
      throw new DomainError('source_identity_conflict', 'Claimed input differs from its latest durable inbox original.');
    return origin;
  });
}

const metadata = new Set(['revision', 'createdAt', 'updatedAt', 'createdSequence', 'updatedSequence']);
function original(record) {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !metadata.has(key)));
}

/** Only business records live here. DSH remains the execution/event-log owner. */
export class BusinessStore {
  constructor({ filename }) { this.storage = new Store(filename); }
  get(...args) { return this.storage.get(...args); }
  list(...args) { return this.storage.list(...args); }
  listAll(...args) { return this.storage.listAll(...args); }
  transaction(fn) { return this.storage.transaction(fn); }
  close() { this.storage.close(); }

  immutable(kind, record) {
    const existing = this.get(kind, record.id);
    if (existing) {
      if (canonicalJson(original(existing)) !== canonicalJson(record))
        throw new DomainError('source_identity_conflict', 'The same DSH identity has different original content.', 409,
          { kind, id: record.id });
      return existing;
    }
    return this.storage.save(kind, record);
  }

  /** Caller supplies the official claimed batch and a prefix covered by flush. */
  ingestClaimedInputs({ sessionId, events, messages }) {
    const batch = eventBatch(sessionId, events), inputs = jsonClone(messages);
    if (!Array.isArray(inputs)) throw new DomainError('invalid_claimed_input', 'Claimed messages must be an array.', 400);
    if (!inputs.length) return [];
    if (!batch.length || batch[0].seq !== 0)
      throw new DomainError('incomplete_history', 'Claimed input requires the complete durable native prefix.');
    const ids = new Set();
    for (const message of inputs) {
      if (message?.role !== 'user' || message.source?.kind !== 'user' || message.source.principal !== undefined)
        throw new DomainError('invalid_claimed_input', 'Only original owner user input can be admitted here.');
      validateMessage(message, 'user');
      if (ids.has(message.id)) throw new DomainError('invalid_claimed_input', 'Claimed message identities must be unique.');
      ids.add(message.id);
    }
    const origins = claimedOrigins(batch, inputs);
    return this.transaction(() => {
      this.ingestSession({ sessionId, events: batch });
      const index = sourceIndex(this.listAll('events', { where: { sessionId } }));
      return inputs.map((message, i) => {
        const origin = origins[i];
        const inboxRef = { sessionId, seq: origin.event.seq, type: origin.event.type,
          sha256: hash(origin.event), index: origin.index };
        const previous = index.get(message.id) || [];
        sameMessage(previous, message);
        let source = previous[0];
        if (!source) {
          source = this.immutable('events', {
            id: `dsh-inbox:${hash([sessionId, origin.event.seq, origin.index])}`,
            conversationId: sessionId, sessionId, role: 'user', author: 'user',
            occurredAt: new Date(origin.event.time).toISOString(), message,
            provenance: { kind: 'dsh_session', source: message.source, sourceRef: inboxRef },
            surfaceOp: null, sourceEventSeqs: [] });
          index.set(message.id, [source]);
        }
        return { messageId: message.id, sourceId: source.id, inboxRef, messageHash: hash(message) };
      });
    });
  }

  /** Append/replay a contiguous prefix or its known continuation, atomically. */
  ingestSession({ sessionId, events }) {
    const batch = eventBatch(sessionId, events);
    return this.transaction(() => {
      const tail = this.list('dsh_events', { where: { sessionId }, order: 'desc', limit: 1 })[0];
      let next = (tail?.seq ?? -1) + 1, inserted = 0, reused = 0;
      const sourceIds = [];
      const sources = sourceIndex(this.listAll('events', { where: { sessionId } }));
      for (const event of batch) {
        const id = eventId(sessionId, event.seq), existing = this.get('dsh_events', id);
        if (!existing && event.seq !== next)
          throw new DomainError('event_sequence_gap', 'Import the missing original DSH events first.');
        const sha256 = hash(event);
        this.immutable('dsh_events', { id, sessionId, seq: event.seq, type: event.type, time: event.time, sha256 });
        const projection = sourceProjection(sessionId, event, sha256);
        if (projection) {
          const previous = sources.get(projection.message.id) || [];
          const inbox = previous.find(row => row.provenance.sourceRef.type === 'agent/inbox/spliced');
          const nativeUser = projection.message.role === 'user' && projection.message.source.kind === 'user';
          const originalInput = previous.some(row => row.message.role === 'user' && row.message.source.kind === 'user');
          if (nativeUser || originalInput || inbox) sameMessage(previous, projection.message);
          // An already stored formal source retains its original event identity.
          // New formal admission reuses its prepared original, not a second copy.
          const direct = this.get('events', id);
          const source = direct ? this.immutable('events', projection)
            : inbox || (nativeUser && previous[0]) || this.immutable('events', projection);
          if (!previous.some(row => row.id === source.id)) sources.set(projection.message.id, [...previous, source]);
          sourceIds.push(source.id);
        }
        if (existing) reused++;
        else { inserted++; next++; }
      }
      return { inserted, reused, sourceIds };
    });
  }

  /** Caller must have confirmed DSH flush === true; this never calls a model. */
  settleTurn({ sessionId, turn, events }) {
    if (!Number.isSafeInteger(turn) || turn < 0)
      throw new DomainError('invalid_turn', 'A nonnegative DSH turn number is required.', 400);
    const batch = eventBatch(sessionId, events);
    if (!batch.length || batch[0].seq !== 0)
      throw new DomainError('incomplete_history', 'Settlement requires the complete original event prefix.');
    return this.transaction(() => {
      const imported = this.ingestSession({ sessionId, events: batch });
      const sourceIds = new Map(batch.filter(event => MESSAGE_TYPES.has(event.type))
        .map((event, index) => [event.seq, imported.sourceIds[index]]));
      const analyzed = analyzeTurn(sessionId, turn, batch, sourceIds);
      if (analyzed.reason) return { status: 'not_deliverable', reason: analyzed.reason };
      const { start, end, final, inputEventIds, sourceEventIds, background } = analyzed;
      const rounds = batch.filter(event => event.seq > start.seq && event.seq < end.seq &&
        event.type === 'user/message' && event.data.source?.kind === 'goal' && event.data.source.round > 0);
      let nativeContinuation;
      if (rounds.length) {
        const snapshots = this.listAll('context_snapshots', { where: { sessionId, turn } });
        nativeContinuation = snapshots.length === 1 ? snapshots[0].material.nativeContinuation : null;
        if (!nativeContinuation || rounds.length !== 1 || nativeContinuation.messageId !== rounds[0].data.id ||
            nativeContinuation.sessionId !== sessionId || nativeContinuation.turn !== turn ||
            nativeContinuation.goalId !== rounds[0].data.source.goalId ||
            nativeContinuation.revision !== rounds[0].data.source.revision ||
            nativeContinuation.round !== rounds[0].data.source.round)
          return { status: 'not_deliverable', reason: 'unproven_native_continuation' };
        assertNativeContinuationIntegrity(this.storage, nativeContinuation);
      }
      const id = turnId(sessionId, turn), reused = this.get('deliveries', id) !== null;
      const delivery = this.immutable('deliveries', {
        id, kind: 'formal_reply', taskOutcome: 'not_assessed', conversationId: sessionId, sessionId, turn,
        eventId: eventId(sessionId, final.seq), inputEventIds, sourceEventIds,
        startSeq: start.seq, throughSeq: end.seq,
        endEventId: eventId(sessionId, end.seq),
        occurredAt: new Date(end.time).toISOString(), backgroundAtTurnEnd: background,
        ...(nativeContinuation ? { nativeContinuation } : {}),
      });
      const learningId = `learn:${hash([sessionId, turn])}`;
      let learning = this.get('learning_pending', learningId);
      if (learning && (learning.deliveryId !== delivery.id || learning.throughSeq !== end.seq))
        throw new DomainError('learning_identity_conflict', 'Learning work is bound to another delivery.');
      learning ||= this.storage.save('learning_pending', {
        id: learningId, kind: 'delivery_learning', status: 'pending', sessionId, conversationId: sessionId,
        turn, deliveryId: delivery.id, throughSeq: end.seq, sourceEventIds,
      });
      return { status: 'delivered', delivery, learning, reused };
    });
  }
}

function analyzeTurn(sessionId, turn, events, sourceIds) {
  const starts = events.filter(event => event.type === 'turn/start' && event.data.turn === turn);
  const ends = events.filter(event => event.type === 'turn/end' && event.data.turn === turn);
  if (starts.length !== 1 || ends.length !== 1 || starts[0].seq >= ends[0].seq)
    return { reason: 'incomplete_turn' };
  const start = starts[0], end = ends[0];
  if (events.some(event => event.type === 'session/end-seed' && event.data.inherited === true && event.seq > end.seq))
    return { reason: 'inherited_turn' };
  if (end.data.reason?.kind !== 'completed') return { reason: `turn_${end.data.reason?.kind || 'unknown'}` };
  const inside = events.filter(event => event.seq > start.seq && event.seq < end.seq);
  if (inside.some(event => event.type === 'turn/start' || event.type === 'turn/end' ||
      (event.data.turn !== undefined && event.data.turn !== turn))) return { reason: 'invalid_turn_boundary' };
  let step = null;
  for (const event of inside) {
    if (event.type === 'step/start') {
      if (step !== null || !Number.isSafeInteger(event.data.step) || event.data.step < 0)
        return { reason: 'invalid_step_boundary' };
      step = event.data.step;
    } else if (event.type === 'step/end') {
      if (step === null || step !== event.data.step) return { reason: 'invalid_step_boundary' };
      step = null;
    } else if (['assistant/message', 'assistant/attempt', 'tool/call', 'tool/result'].includes(event.type) &&
        (step === null || event.data.step !== step)) return { reason: 'invalid_step_boundary' };
  }
  if (step !== null) return { reason: 'incomplete_step' };
  const assistants = inside.filter(event => event.type === 'assistant/message');
  const final = assistants.at(-1);
  if (!final || final.data.interrupted === true || final.data.message.source.kind !== 'model')
    return { reason: 'no_complete_assistant' };
  if (final.data.message.content.some(block => block.type === 'tool-call')) return { reason: 'final_tool_call' };
  if (!messageText(final.data.message).trim()) return { reason: 'empty_reply' };

  // Surface replacements can hide an earlier reply; don't publish its old text.
  let surface = [];
  for (const event of events) {
    if (event.seq >= end.seq) break;
    if (!SURFACE_TYPES.has(event.type)) continue;
    if (event.surfaceOp === 'append') surface.push(event.seq);
    else if (event.surfaceOp?.op === 'replace') {
      const first = surface.indexOf(event.surfaceOp.startSeq), last = surface.indexOf(event.surfaceOp.endSeq);
      if (first < 0 || last < first) return { reason: 'invalid_surface' };
      surface.splice(first, last - first + 1, event.seq);
    } else return { reason: 'invalid_surface' };
  }
  if (!surface.includes(final.seq)) return { reason: 'reply_replaced' };
  if (inside.some(event => event.seq > final.seq && event.type === 'user/message' && event.data.source.kind === 'user'))
    return { reason: 'unanswered_user_input' };

  const calls = new Map(), dispatched = new Set(), results = new Set();
  for (const event of inside) {
    if (event.type === 'assistant/message') {
      for (const block of event.data.message.content.filter(block => block.type === 'tool-call')) {
        if (typeof block.id !== 'string' || calls.has(block.id)) return { reason: 'invalid_tool_trace' };
        calls.set(block.id, event.seq);
      }
    } else if (event.type === 'tool/call') {
      if (typeof event.data.callId !== 'string' || dispatched.has(event.data.callId)) return { reason: 'invalid_tool_trace' };
      dispatched.add(event.data.callId);
      if (!calls.has(event.data.callId)) calls.set(event.data.callId, event.seq);
    } else if (event.type === 'tool/result') {
      const message = event.data.message, id = message.toolCallId;
      if (!calls.has(id) || calls.get(id) >= event.seq || results.has(id) ||
          message.source.kind !== 'tool' || message.source.callId !== id || event.seq > final.seq)
        return { reason: 'invalid_tool_trace' };
      results.add(id);
    }
  }
  if ([...calls.keys()].some(id => !results.has(id))) return { reason: 'unresolved_tools' };
  const jobs = new Set(), children = new Set();
  for (const event of events) {
    if (event.seq >= end.seq) break;
    if (event.data.owner === sessionId && typeof event.data.jobId === 'string') {
      if (event.type === 'job/registered') jobs.add(event.data.jobId);
      if (event.type === 'job/settled') jobs.delete(event.data.jobId);
    }
    if (event.type === 'subagent/catalog' && typeof event.data.childId === 'string') children.add(event.data.childId);
  }
  const sources = inside.filter(event => MESSAGE_TYPES.has(event.type));
  return { start, end, final,
    inputEventIds: sources.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')
      .map(event => sourceIds.get(event.seq)),
    sourceEventIds: sources.map(event => sourceIds.get(event.seq)),
    background: { unsettledJobIds: [...jobs], observedSubagentIds: [...children],
      subagentCompletion: 'not_determined_by_parent_catalog' } };
}
