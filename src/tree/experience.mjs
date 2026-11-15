import { canonicalJson, digest, fail, integer, jsonClone, validateRef } from './contracts.mjs';
import { DomainService } from './tree.mjs';

const messageOf = (event, messageId) => event.type === 'agent/inbox/spliced' ? event.data.inserted?.find(m => m.id === messageId) : event.type === 'user/message' ? event.data : event.data?.message;
const visibleBlocks = message => (message?.content ?? []).filter(b => b.type !== 'reasoning');

/** Reads a host-frozen durable native log. Source labels never come from text. */
export class NativeSources {
  constructor({ readSession, isRevoked = () => false }) { Object.assign(this, { readSession, isRevoked }); }
  events(sessionId) {
    const packet = this.readSession(sessionId);
    if (packet?.then || packet?.durable !== true || packet.sessionId !== sessionId || !Array.isArray(packet.events)) fail('DURABLE_SOURCE_REQUIRED', 'A synchronously frozen durable native log is required');
    const events = jsonClone(packet.events);
    for (const [seq, event] of events.entries()) if (event.seq !== seq || typeof event.type !== 'string' || !event.data) fail('NATIVE_LOG_INVALID', 'Native original log must retain its complete event sequence');
    return events;
  }
  ref(sessionId, event, messageId) {
    const message = messageOf(event, messageId);
    return { sessionId, seq: event.seq, ...(message?.id ? { messageId: message.id } : {}), sha256: digest(event) };
  }
  project(sessionId, event, messageId) {
    let role, origin, content;
    if (['user/message', 'agent/inbox/spliced'].includes(event.type) && messageOf(event, messageId)?.source?.kind === 'user') { role = 'user'; origin = 'user'; content = visibleBlocks(messageOf(event, messageId)); }
    else if (event.type === 'assistant/message' && event.data.message?.source?.kind === 'model') {
      role = 'assistant'; origin = 'model'; content = visibleBlocks(event.data.message).filter(b => b.type !== 'tool-call');
    } else if (event.type === 'tool/call') { role = 'assistant'; origin = 'tool-call'; content = [{ type: 'tool-call', id: event.data.callId, name: event.data.name, arguments: event.data.arguments }]; }
    else if (event.type === 'tool/result' && event.data.message?.role === 'tool') { role = 'tool'; origin = 'tool'; content = visibleBlocks(event.data.message); }
    else return null;
    if (!content.length) return null;
    const ref = this.ref(sessionId, event, messageId);
    return { id: digest(['native-source', ref]), role, origin, content, text: content.map(b => b.type === 'text' ? b.text : canonicalJson(b)).join('\n'), ref, sha256: ref.sha256, nativeType: event.type, at: new Date(event.time).toISOString(), ...(event.type === 'tool/result' ? { toolCallId: event.data.message.toolCallId, isError: event.data.message.isError === true } : {}) };
  }
  resolve(ref) {
    validateRef(ref); if (this.isRevoked(ref)) return null;
    const event = this.events(ref.sessionId)[ref.seq];
    if (!event || digest(event) !== ref.sha256 || ref.messageId && messageOf(event, ref.messageId)?.id !== ref.messageId) return null;
    return this.project(ref.sessionId, event, ref.messageId);
  }
  resolveMany(refs) {
    const eventsBySession = new Map();
    return refs.map(ref => {
      validateRef(ref);
      if (this.isRevoked(ref)) return null;
      if (!eventsBySession.has(ref.sessionId)) eventsBySession.set(ref.sessionId, this.events(ref.sessionId));
      const event = eventsBySession.get(ref.sessionId)[ref.seq];
      if (!event || digest(event) !== ref.sha256 || ref.messageId && messageOf(event, ref.messageId)?.id !== ref.messageId) return null;
      return this.project(ref.sessionId, event, ref.messageId);
    });
  }
  claimed(sessionId, messages) {
    const events = this.events(sessionId);
    return messages.filter(m => m.source?.kind === 'user').map(message => {
      const original = events.find(e => e.type === 'agent/inbox/spliced' && e.data.inserted?.some(m => m.id === message.id && canonicalJson(m) === canonicalJson(message)));
      if (!original) fail('USER_INBOX_SOURCE', 'Claimed user input must match its durable native inbox original');
      return this.project(sessionId, original, message.id);
    });
  }
  turn(sessionId, nativeTurn, { requireEnd = true } = {}) {
    integer(nativeTurn, 'native turn', 0); const events = this.events(sessionId);
    const start = events.find(e => e.type === 'turn/start' && e.data.turn === nativeTurn);
    if (!start) fail('TURN_SOURCE_MISSING', 'Native turn start missing');
    const end = events.find(e => e.type === 'turn/end' && e.seq > start.seq && e.data.turn === nativeTurn);
    if (requireEnd && !end) fail('TURN_NOT_SETTLED', 'Native turn has not durably ended');
    const next = events.find(e => e.type === 'turn/start' && e.seq > start.seq), through = end?.seq ?? (next ? next.seq - 1 : events.at(-1).seq);
    const ownEvents = events.filter(e => e.seq >= start.seq && e.seq <= through), sources = ownEvents.map(e => this.project(sessionId, e)).filter(Boolean);
    const userSources = sources.filter(s => s.role === 'user' && s.origin === 'user');
    if (!userSources.length) fail('PROGRAM_NOT_USER', 'Program-only input is not a logical human turn');
    return { sessionId, nativeTurn, startSeq: start.seq, endSeq: end?.seq ?? null, nativeHash: digest(ownEvents), endReason: end?.data.reason ?? null, sources, userSources };
  }
}

export class ExperienceService extends DomainService {
  constructor(options) { super(options); this.sources = options.sources; }
  settle(turnId) {
    const actor = this.actor([]); if (actor.kind !== 'program') fail('HOST_REQUIRED', 'Only durable host turn/end settles experience');
    const turn = this.repo.get('tree_turns', turnId); if (!turn) fail('TURN_NOT_FOUND', 'Attribution must exist before settlement');
    const captured = this.sources.turn(turn.sessionId, turn.nativeTurn), requestId = digest(['settle-experience', turnId]), receiptId = digest(['receipt', requestId]);
    const prior = this.repo.get('tree_receipts', receiptId);
    if (prior) { if (turn.experienceHash !== captured.nativeHash) fail('SOURCE_CHANGED', 'Settled native turn changed'); return prior; }
    for (const ref of turn.userSourceRefs) {
      const original = this.sources.resolve(ref);
      if (!original || !captured.userSources.some(s => s.ref.messageId === ref.messageId && canonicalJson(s.content) === canonicalJson(original.content))) fail('SOURCE_CHANGED', 'Attribution user source differs from the durable turn');
    }
    const refs = [...turn.userSourceRefs, ...captured.sources.filter(s => s.role !== 'user' || !turn.userSourceRefs.some(r => r.messageId === s.ref.messageId)).map(s => s.ref)], status = captured.endReason.kind === 'completed' ? 'settled' : captured.endReason.kind === 'error' ? 'failed' : 'interrupted';
    return this.repo.command('settleExperience', { requestId, expected: { [`tree_turns:${turnId}`]: turn.revision }, input: { turnId, nativeHash: captured.nativeHash, endSeq: captured.endSeq, sourceRefs: refs } }, actor, () => {
      this.replace('tree_turns', turn, { status, settledAt: this.repo.now(), experienceRefs: refs, experienceHash: captured.nativeHash, nativeEndSeq: captured.endSeq, nativeEndReason: captured.endReason, settlementReceiptId: receiptId });
      const jobs = [];
      for (const nodeId of turn.nodeIds) {
        const node = this.node(nodeId); this.replace('tree_nodes', node, { lastOwnTurnAt: this.repo.now(), lastOwnTurnId: turnId });
        if (status !== 'settled') continue;
        const id = digest(['settled-learning', turnId, nodeId, turn.assignmentRevision]);
        const input = { turnId, assignmentRevision: turn.assignmentRevision, sourceRefs: refs };
        this.repo.save('tree_jobs', { id, kind: 'learning', scopeKey: nodeId, nodeIds: [nodeId], input, inputHash: digest(input), inputRevisionSet: { [`tree_turns:${turnId}`]: turn.revision + 1 }, status: 'queued', triggerKind: 'settled_main_turn' }); jobs.push(id);
      }
      return { turnId, status, nodeIds: turn.nodeIds, sourceRefs: refs, learningIntents: jobs };
    });
  }
  turns(nodeId, { includeInterrupted = true } = {}) {
    this.node(nodeId);
    const ids = new Set(this.repo.list('tree_links', l => l.nodeId === nodeId && l.active).map(l => l.turnId));
    return this.repo.list('tree_turns', t => ids.has(t.id) && (t.status === 'settled' || includeInterrupted && ['interrupted', 'failed'].includes(t.status)))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.sessionId.localeCompare(b.sessionId) || a.nativeTurn - b.nativeTurn || a.id.localeCompare(b.id));
  }
  material(turn) {
    const sources = [], revokedRefs = [];
    for (const ref of turn.experienceRefs ?? turn.sourceRefs) { const value = this.sources.resolve(ref); if (value) sources.push(value); else revokedRefs.push(ref); }
    return { turnId: turn.id, status: turn.status, assignmentRevision: turn.assignmentRevision, sources, revokedRefs, nativeHash: turn.experienceHash ?? null };
  }
  assertReadScope(nodeId) {
    const ctx = this.context(); if (ctx.actor.kind === 'user') return;
    if (!(ctx.nodeIds ?? []).some(id => this.repo.ancestors(id).some(n => n.id === nodeId) || this.node(nodeId).parentId === id)) fail('OUT_OF_SCOPE', 'History is limited to ancestors and direct children');
  }
  history(nodeId, { afterTurnId = null, limit = 10, byteLimit = 65536 } = {}) {
    this.assertReadScope(nodeId); integer(limit, 'limit', 1, 50); integer(byteLimit, 'byte limit', 1024, 65536);
    const all = this.turns(nodeId); let index = 0, offset = 0, cursor;
    if (afterTurnId !== null) {
      if (typeof afterTurnId !== 'string') fail('CURSOR_STALE', 'History cursor must be a string');
      if (afterTurnId.startsWith('page:')) {
        try { cursor = JSON.parse(Buffer.from(afterTurnId.slice(5), 'base64url').toString()); } catch { fail('CURSOR_STALE', 'Malformed history cursor'); }
        if (!cursor || cursor.nodeId !== nodeId || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) fail('CURSOR_STALE', 'History cursor belongs to a different scope');
        index = all.findIndex(t => t.id === cursor.turnId); offset = cursor.offset;
      } else { const prior = all.findIndex(t => t.id === afterTurnId); if (prior < 0) fail('CURSOR_STALE', 'Unknown previous turn'); index = prior + 1; }
    }
    if (index < 0) fail('CURSOR_STALE', 'History cursor no longer belongs to this node');
    const encode = (turnId, offset, hash) => 'page:' + Buffer.from(canonicalJson({ nodeId, turnId, offset, hash })).toString('base64url');
    const items = [], revokedRefs = []; let bytes = 0;
    for (let i = index; i < all.length && items.length < limit; i++) {
      const material = this.material(all[i]); revokedRefs.push(...material.revokedRefs);
      const projected = canonicalJson(material), from = i === index ? offset : 0, points = [...projected];
      if (i === index && cursor && cursor.hash !== digest(material)) fail('CURSOR_STALE', 'Source withdrawal or assignment changed this page; restart from its turn');
      if (from > points.length) fail('CURSOR_STALE', 'History offset is outside this turn');
      let to = from;
      while (to < points.length && bytes + Buffer.byteLength(points[to]) <= byteLimit) bytes += Buffer.byteLength(points[to++]);
      if (to > from) items.push({ turnId: all[i].id, status: all[i].status, text: points.slice(from, to).join(''), offset: from, complete: from === 0 && to === points.length });
      if (to < points.length) return { items, revokedRefs, nextCursor: encode(all[i].id, to, digest(material)) };
      if (items.length === limit && i + 1 < all.length) return { items, revokedRefs, nextCursor: all[i].id };
    }
    return { items, revokedRefs, nextCursor: null };
  }
}
