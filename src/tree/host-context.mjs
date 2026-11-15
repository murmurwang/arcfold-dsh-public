import { createHash } from 'node:crypto';

export const TREE_CONTEXT_SOURCE = 'arcfold/tree-context';
export const TREE_COMPACTION_RECORD = 'plugin:arcfold/tree-compaction';
const retired = 'arcfold/tree-context-retired';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const TREE_OWNED_KINDS = Object.freeze([TREE_CONTEXT_SOURCE, retired, 'arcfold/hook']);
const owned = message => message.role === 'user' && TREE_OWNED_KINDS.includes(message.source?.kind);
const fail = message => { throw Object.assign(new Error(message), { code: 'TREE_CONTEXT_UNSAFE' }); };

function currentSnapshot(read) {
  const value = structuredClone(read());
  if (!value || !Number.isSafeInteger(value.scopeEpoch) || value.scopeEpoch < 1 ||
      !Array.isArray(value.nodeIds) || !value.nodeIds.length ||
      value.nodeIds.some(id => typeof id !== 'string' || !id) ||
      !Number.isSafeInteger(value.version) || value.version < 1 || typeof value.text !== 'string')
    fail('Current context must have a durable scope epoch, nodes and content version');
  return { value, key: digest(value) };
}

/** Unknown/legacy mixed summaries are refused, never guessed apart or deleted. */
export function assertOwnedCompaction(session) {
  const events = session.snapshotEvents();
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq);
    if (event.type !== 'user/message' || event.data.source?.kind !== 'compact-checkpoint') continue;
    const refs = event.sourceEventSeqs ?? [];
    const summary = refs.map(n => session.eventAt(n)).find(e => e.type === 'compaction/summary');
    const receipt = summary && events.find(e => e.type === TREE_COMPACTION_RECORD &&
      e.data.compactionId === summary.data.compactionId && e.seq < summary.seq &&
      e.data.summaryHash === digest(summary.data.summary) && (
        e.data.contract === 'owned-excluded-v2' && Array.isArray(e.data.ownedKinds) && digest(e.data.ownedKinds) === digest(TREE_OWNED_KINDS) ||
        e.data.contract === 'owned-excluded-v1' && !events.some(old => old.seq < summary.seq && old.type === 'user/message' && old.data.source?.kind === 'arcfold/hook')));
    if (!receipt) fail('Checkpoint lacks durable evidence that owned context was excluded before summarization');
  }
}

/**
 * Subclass the actual host transaction; only its documented summarizer seam is
 * replaced. summarize must use B2's owned, metered job path, never Base.summarize
 * (which makes a purpose=compaction call outside that ownership contract).
 */
export function ownedCompactionClass(Base, { summarize, appendPluginRecord }) {
  if (typeof summarize !== 'function' || typeof appendPluginRecord !== 'function') fail('Owned summarizer and durable recorder required');
  return class OwnedCompaction extends Base {
    async summarize(input, agent, signal) {
      signal?.throwIfAborted();
      assertOwnedCompaction(agent.session);
      const messages = input.messages.filter(message => !owned(message));
      const clean = { ...input, messages };
      const start = agent.session.snapshotEvents().findLast(e => e.type === 'compaction/start');
      if (!start) fail('No native compaction transaction');
      const result = await summarize(clean, agent, signal);
      signal?.throwIfAborted();
      appendPluginRecord(agent.session, TREE_COMPACTION_RECORD, {
        contract: 'owned-excluded-v2', ownedKinds: TREE_OWNED_KINDS, compactionId: start.data.compactionId,
        inputHash: digest(clean), summaryHash: digest(result.summary),
        excluded: input.messages.filter(owned).map(message => ({ id: message.id, source: message.source })),
      });
      return result;
    }
  };
}

/** Scope-owned mounting; does not replace the host loop or mutate human text. */
export function mountOwnedContext(ctx, { readCurrent, createUserMessage }) {
  let session;
  const disposers = [];
  disposers.push(ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    if (decision.kind === 'reject') return decision;
    payload.signal.throwIfAborted();
    session = payload.agent.session;
    assertOwnedCompaction(session);
    const snapshot = currentSnapshot(readCurrent);
    let present = false;
    for (const seq of [...session.surface.nodes]) {
      const event = session.eventAt(seq);
      if (event.type !== 'user/message' || event.data.source?.kind !== TREE_CONTEXT_SOURCE) continue;
      if (event.data.source.snapshotKey === snapshot.key && !present) { present = true; continue; }
      session.append('user/message', createUserMessage({ source: { kind: retired },
        content: [{ type: 'text', text: '[previous Arcfold context retired]' }] }),
      { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] });
    }
    if (decision.messages.some(owned)) fail('Only the context owner may inject scoped context');
    if (present) return decision;
    const { scopeEpoch, nodeIds, version, text } = snapshot.value;
    return { ...decision, messages: [...decision.messages, createUserMessage({
      source: { kind: TREE_CONTEXT_SOURCE, scopeEpoch, nodeIds, version, snapshotKey: snapshot.key },
      content: [{ type: 'text', text }],
    })] };
  }));
  disposers.push(ctx.on('llm/stream', (options, next) => {
    if (!session || options.sessionId !== session.id) return next();
    return (async function* () {
      options.signal?.throwIfAborted();
      assertOwnedCompaction(session);
      const snapshot = currentSnapshot(readCurrent);
      const active = options.messages.filter(m => m.source?.kind === TREE_CONTEXT_SOURCE);
      if (active.length !== 1 || active[0].source.snapshotKey !== snapshot.key ||
          digest(active[0].content) !== digest([{ type: 'text', text: snapshot.value.text }]))
        fail('Scoped context changed before model dispatch');
      yield* next();
    })();
  }));
  return async () => { for (const dispose of disposers.reverse()) await dispose(); };
}
