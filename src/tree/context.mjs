import { canonicalJson, digest, fail, jsonClone } from './contracts.mjs';
import { DomainService } from './tree.mjs';
import { TREE_CONTEXT_SOURCE, assertOwnedCompaction } from './host-context.mjs';

const actor = { kind: 'program', id: 'tree-context' };
const versionId = (id, version) => digest(['item_version', id, version]);
const retired = 'arcfold/tree-context-retired';

export class ContextBuilder extends DomainService {
  constructor(options) { super(options); this.sources = options.sources; this.mounted = new Map(); }
  activeItems(nodeIds, role = 'main') {
    return this.repo.listByNodeIds('tree_items', nodeIds, i => i.lifecycle === 'active' && !i.stale && i.activeVersion).flatMap(item => {
      const version = this.repo.get('tree_item_versions', versionId(item.id, item.activeVersion));
      if (!version || version.sourceRefs.some(ref => !this.resolveSource(ref))) return [];
      if (item.kind === 'supplement') {
        const supplement = this.repo.get('tree_supplements', digest(['supplement', item.id, item.activeVersion]));
        if (!supplement || supplement.target !== role) return [];
        return [{ item, version, supplement }];
      }
      if (item.kind === 'method') {
        const method = this.repo.get('tree_methods', digest(['method', item.id, item.activeVersion]));
        if (!method || method.pendingScriptRequests.length) return [];
        return [{ item, version, method }];
      }
      return [{ item, version }];
    }).sort((a, b) => nodeIds.indexOf(a.item.nodeId) - nodeIds.indexOf(b.item.nodeId) || a.item.id.localeCompare(b.item.id));
  }
  summary(node) {
    const summary = node.currentSummaryId && this.repo.get('tree_summaries', node.currentSummaryId);
    if (!summary || summary.sourceRefs.some(ref => !this.resolveSource(ref)) || summary.throughTurnIds.some(id => {
      const turn = this.repo.get('tree_turns', id); return !turn?.nodeIds.includes(node.id) || turn.assignmentRevision !== summary.assignmentVersions[id];
    })) return null;
    return summary;
  }
  reusableComponent(source) {
    if (!Array.isArray(source.sourceRefs)) return false;
    let available;
    try {
      available = source.componentKey?.startsWith('cross-session:') && this.sources?.resolveMany
        ? this.sources.resolveMany(source.sourceRefs).every(Boolean) : source.sourceRefs.every(ref => this.resolveSource(ref));
    } catch { return false; }
    return available &&
      (source.itemVersions ?? []).every(v => { const item = this.repo.get('tree_items', v.itemId); return item && !item.stale && item.lifecycle !== 'invalid'; }) &&
      (source.turnAssignments ?? []).every(v => { const turn = this.repo.get('tree_turns', v.turnId); return turn?.status === 'settled' && turn.assignmentRevision === v.assignmentRevision && turn.nodeIds.includes(v.nodeId); }) &&
      (source.summaryVersions ?? []).every(v => Boolean(this.summary({ id: v.nodeId, currentSummaryId: digest(['summary', v.nodeId, v.version]) })));
  }
  crossSessionSegments(nodeIds, sessionId, currentTurn) {
    const selected = new Set(nodeIds);
    const turns = this.repo.list('tree_turns', turn => turn.status === 'settled' && turn.settledAt < currentTurn.startedAt && turn.sessionId !== sessionId && turn.nodeIds.some(id => selected.has(id)))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.sessionId.localeCompare(b.sessionId) || a.nativeTurn - b.nativeTurn || a.id.localeCompare(b.id));
    const recent = turns.slice(-6), entries = [], assignments = [], refs = [];
    let resolved = null;
    if (this.sources?.resolveMany) {
      try {
        const allRefs = recent.flatMap(turn => turn.experienceRefs ?? turn.sourceRefs);
        const allSources = this.sources.resolveMany(allRefs);
        resolved = new Map(allRefs.map((ref, index) => [digest(ref), allSources[index]]));
      } catch { /* Individual turns below retain the conservative fallback. */ }
    }
    let usedBytes = 0, omitted = turns.length - recent.length;
    for (const turn of recent.toReversed()) {
      // A mixed-goal turn can contain private information from another branch.
      // Do not send its unsplit original into a narrower current scope.
      if (turn.nodeIds.some(id => !selected.has(id))) { omitted++; continue; }
      let sources;
      try { sources = resolved ? (turn.experienceRefs ?? turn.sourceRefs).map(ref => resolved.get(digest(ref))) : this.sources?.resolveMany ? this.sources.resolveMany(turn.experienceRefs ?? turn.sourceRefs) : (turn.experienceRefs ?? turn.sourceRefs).map(ref => this.resolveSource(ref)); }
      catch { omitted++; continue; }
      if (sources.some(source => !source)) { omitted++; continue; }
      const visible = sources.filter(source => source.role === 'user' && source.origin === 'user' || source.role === 'assistant' && source.origin === 'model');
      const messages = visible.map(source => ({ role: source.role, text: source.text, sourceId: source.id }));
      const entry = { turnId: turn.id, sessionId: turn.sessionId, messages };
      const bytes = Buffer.byteLength(canonicalJson(entry));
      if (usedBytes + bytes > 48 * 1024) { omitted++; continue; }
      usedBytes += bytes; entries.unshift(entry); refs.push(...visible.map(source => source.ref));
      assignments.push({ turnId: turn.id, nodeId: turn.nodeIds.find(id => selected.has(id)), assignmentRevision: turn.assignmentRevision });
    }
    if (!turns.length) return [];
    const value = { recentOtherSessions: entries, omittedTurns: omitted,
      instruction: '这些是同一目标在其他聊天的原话和答复，不代表用户已采纳助手建议。若未覆盖所需经历，用历史工具查证。' };
    return [{ key: 'cross-session:' + digest([...selected].sort()), nodeId: null, version: digest([value, assignments]),
      text: canonicalJson(value), sourceRefs: refs, itemVersions: [], summaryVersions: [], turnAssignments: assignments }];
  }
  build(nodeIds, role = 'main') {
    const paths = nodeIds.map(id => this.repo.ancestors(id)), ordered = [...new Map(paths.flat().map(n => [n.id, n])).values()];
    const items = this.activeItems(ordered.map(n => n.id), role), itemVersions = items.map(({ item }) => ({ itemId: item.id, version: item.activeVersion }));
    const summaries = ordered.map(n => this.summary(n)).filter(Boolean), summaryVersions = summaries.map(s => ({ nodeId: s.nodeId, version: s.version }));
    const segments = ordered.map(node => {
      const rows = items.filter(i => i.item.nodeId === node.id), summary = summaries.find(s => s.nodeId === node.id), own = nodeIds.includes(node.id);
      const value = { target: { id: node.id, name: node.name, status: node.status, statusOrigin: node.statusOrigin },
        understandings: rows.filter(r => r.item.kind === 'understanding').map(({ item, version }) => ({ id: item.id, version: item.activeVersion, source: version.sourceKind, validation: item.validation, content: version.content })),
        rules: rows.filter(r => r.method?.short).map(({ item, method }) => ({ id: item.id, version: item.activeVersion, text: method.short })),
        methods: rows.filter(r => r.method?.long).map(({ item, method }) => ({ id: item.id, version: item.activeVersion, name: method.long.name, description: method.long.description })),
        supplements: rows.filter(r => r.supplement).map(({ item, version }) => ({ id: item.id, version: item.activeVersion, text: version.content })),
        experience: summary ? { version: summary.version, oneLine: summary.oneLine, ...(own ? { body: summary.body } : {}) } : null,
        children: own ? this.repo.list('tree_nodes', n => !n.deleted && n.parentId === node.id).map(n => ({ id: n.id, name: n.name, status: n.status, oneLine: this.summary(n)?.oneLine ?? '' })).sort((a, b) => a.id.localeCompare(b.id)) : [],
        probes: own ? this.repo.list('tree_items', i => i.nodeId === node.id && i.lifecycle === 'active' && i.probe).map(i => ({ itemId: i.id, version: i.activeVersion, what: i.probe.what })) : [] };
      const text = canonicalJson({ ...value, instruction: '同一节点以最后一份背景为准；旧版中没有继续列出的内容已撤销。' });
      return { key: `node:${node.id}`, nodeId: node.id, version: digest(value), text,
        sourceRefs: [...rows.flatMap(r => r.version.sourceRefs), ...(summary?.sourceRefs ?? [])],
        itemVersions: rows.map(r => ({ itemId: r.item.id, version: r.item.activeVersion })), summaryVersions: summary ? [{ nodeId: node.id, version: summary.version }] : [] };
    });
    // Names/parent/status/oneLine are the explicitly permitted global discovery
    // view; the parent lets main see where each goal sits in the tree.
    // No sibling understanding, method, source text or summary body enters it.
    const overview = this.repo.list('tree_nodes', n => !n.deleted && n.status === 'active').map(n => ({ id: n.id, parentId: n.parentId ?? null, name: n.name, status: n.status, oneLine: this.summary(n)?.oneLine ?? '' })).sort((a, b) => a.id.localeCompare(b.id));
    const text = canonicalJson({ globalOverview: overview });
    segments.unshift({ key: 'global-overview', nodeId: null, version: digest(overview), text,
      sourceRefs: this.repo.list('tree_nodes', n => !n.deleted && n.status === 'active').flatMap(n => this.summary(n)?.sourceRefs ?? []), itemVersions: [],
      summaryVersions: this.repo.list('tree_nodes', n => !n.deleted && n.status === 'active').flatMap(n => { const summary = this.summary(n); return summary ? [{ nodeId: n.id, version: summary.version }] : []; }) });
    return { role, nodeIds: [...nodeIds], ancestorPaths: paths.map(p => p.map(n => n.id)), segments, itemVersions, summaryVersions,
      treeRevision: this.repo.meta().treeRevision, renderedHash: digest(segments), bytes: Buffer.byteLength(segments.map(s => s.text).join('\n')) };
  }
  scope(sessionId) { return this.repo.meta().contextSessions?.[sessionId] ?? null; }
  async activate(sessionId, turnId, { cancelPrevious, expectedEpoch } = {}) {
    const turn = this.repo.get('tree_turns', turnId);
    if (!turn || turn.sessionId !== sessionId) fail('TURN_SCOPE', 'Only this native turn may choose its session scope');
    const token = digest(['scope-transition', sessionId, turnId, turn.assignmentRevision]), previous = this.scope(sessionId);
    if (previous?.token === token && previous.phase === 'active') return previous;
    if (expectedEpoch !== undefined && previous?.epoch !== expectedEpoch) fail('SCOPE_STALE', 'Scope changed before transition');
    if (previous && typeof cancelPrevious !== 'function') fail('SCOPE_CANCELLER_REQUIRED', 'An owned cancellation callback must stop previous scope execution');
    const beginId = digest(['begin-scope', token]);
    if (previous?.token !== token) this.repo.command('leaveTreeScope', { requestId: beginId, expected: { [`tree_turns:${turnId}`]: turn.revision }, input: { sessionId, turnId, token, sourceRefs: turn.userSourceRefs } }, actor, () => {
      const meta = this.repo.meta(), old = meta.contextSessions?.[sessionId];
      const scope = { token, phase: 'leaving', epoch: (old?.epoch ?? 0) + 1, nodeIds: turn.nodeIds, turnId, assignmentRevision: turn.assignmentRevision,
        previousNodeIds: old?.nodeIds ?? [], leaveEvents: (old?.nodeIds ?? []).filter(id => !turn.nodeIds.includes(id)).map(nodeId => ({ type: 'node_leave', nodeId })), sourceRefs: turn.userSourceRefs };
      this.repo.save('tree_meta', { ...meta, contextSessions: { ...meta.contextSessions, [sessionId]: scope } }, meta.revision); return scope;
    });
    const pending = this.scope(sessionId);
    if (pending?.token !== token) fail('SCOPE_STALE', 'A later scope owns cancellation; do not cancel it from this old transition');
    if (pending.previousNodeIds.length) await cancelPrevious(jsonClone(pending));
    return this.repo.command('enterTreeScope', { requestId: digest(['finish-scope', token]), expected: {}, input: { sessionId, token, sourceRefs: turn.userSourceRefs } }, actor, () => {
      const meta = this.repo.meta(), current = meta.contextSessions?.[sessionId], latest = this.repo.get('tree_turns', turnId);
      if (current?.token !== token || latest.assignmentRevision !== turn.assignmentRevision) fail('SCOPE_STALE', 'A later turn/correction superseded this transition');
      const scope = { ...current, phase: 'active', enteredAt: this.repo.now(), enterEvents: current.nodeIds.filter(id => !current.previousNodeIds.includes(id)).map(nodeId => ({ type: 'node_enter', nodeId })) };
      this.repo.save('tree_meta', { ...meta, contextSessions: { ...meta.contextSessions, [sessionId]: scope } }, meta.revision); return scope;
    }).result;
  }
  capture(sessionId, role = 'main') {
    const scope = this.scope(sessionId), turn = scope && this.repo.get('tree_turns', scope.turnId);
    if (!scope || scope.phase !== 'active' || scope.assignmentRevision !== turn?.assignmentRevision || canonicalJson(scope.nodeIds) !== canonicalJson(turn.nodeIds)) fail('SCOPE_STALE', 'No active current assignment scope');
    const value = { ...this.build(scope.nodeIds, role), scopeEpoch: scope.epoch, turnId: scope.turnId, assignmentRevision: scope.assignmentRevision };
    if (role === 'main') {
      value.segments.push(...this.crossSessionSegments(scope.nodeIds, sessionId, turn));
      value.renderedHash = digest(value.segments);
      value.bytes = Buffer.byteLength(value.segments.map(s => s.text).join('\n'));
    }
    return { ...value, key: digest(value) };
  }
  assertCurrent(sessionId, snapshot) { if (this.capture(sessionId, snapshot.role).key !== snapshot.key) fail('CONTEXT_STALE', 'Scope, versions or source availability changed before dispatch'); return true; }
  expose(sessionId, invocationId, boundaryIndex, snapshot) {
    this.assertCurrent(sessionId, snapshot);
    const mounted = this.mounted.get(sessionId);
    if (mounted && (mounted.snapshotKey !== snapshot.key || mounted.messages.some(m => !this.reusableComponent(m.source)))) fail('CONTEXT_STALE', 'Native projection must be refreshed before exposure');
    const messages = mounted?.messages, visibleVersions = messages ? [...new Map(messages.flatMap(m => m.source.itemVersions ?? []).map(v => [canonicalJson(v), v])).values()] : snapshot.itemVersions;
    const id = digest(['exposure', invocationId]), existing = this.repo.get('tree_exposures', id);
    if (existing) { if (existing.contextKey !== snapshot.key || existing.revoked) fail('EXPOSURE_CHANGED', 'An invocation cannot change exposure'); return existing; }
    this.repo.command('recordTreeExposure', { requestId: id, expected: {}, input: { invocationId, contextKey: snapshot.key } }, actor, () => {
      this.repo.save('tree_exposures', { id, invocationId, role: snapshot.role, nodeIds: snapshot.nodeIds, itemVersions: snapshot.itemVersions, visibleItemVersions: visibleVersions, summaryVersions: snapshot.summaryVersions,
        renderedHash: messages ? digest(messages) : snapshot.renderedHash, contextKey: snapshot.key, treeRevision: snapshot.treeRevision, modelSessionId: sessionId, boundaryIndex, scopeEpoch: snapshot.scopeEpoch,
        bytes: messages ? Buffer.byteLength(canonicalJson(messages)) : snapshot.bytes }); return { exposureId: id };
    }); return this.repo.get('tree_exposures', id);
  }
}

/** Per-component native projection: unchanged ancestors keep their position. */
export function mountTreeContext(ctx, { builder, sessionId, createUserMessage }) {
  let session; const disposers = [];
  disposers.push(ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next(); if (decision.kind === 'reject') return decision;
    payload.signal.throwIfAborted(); session = payload.agent.session;
    if (session.id !== sessionId) fail('CONTEXT_SESSION', 'Context owner cannot mount another native session');
    assertOwnedCompaction(session); const snapshot = builder.capture(sessionId), current = new Map(snapshot.segments.map(s => [s.key, s])), retainedMessages = [], latest = new Map();
    for (const seq of [...session.surface.nodes]) {
      const event = session.eventAt(seq); if (event.type !== 'user/message' || event.data.source?.kind !== TREE_CONTEXT_SOURCE) continue;
      const source = event.data.source, segment = current.get(source.componentKey);
      // Preserve earlier same-scope versions for a stable prefix, but never
      // retain an out-of-scope component or withdrawn original evidence.
      if (segment && (!segment.key.startsWith('cross-session:') || source.componentVersion === segment.version) && builder.reusableComponent(source)) {
        retainedMessages.push(event.data); latest.set(segment.key, event.data); continue;
      }
      session.append('user/message', createUserMessage({ source: { kind: retired }, content: [{ type: 'text', text: '[previous Arcfold component retired]' }] }), { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] });
    }
    if (decision.messages.some(m => [TREE_CONTEXT_SOURCE, retired].includes(m.source?.kind))) fail('CONTEXT_OWNER', 'Only the scoped context owner may inject its messages');
    const additions = [];
    for (const segment of snapshot.segments) {
      const previous = latest.get(segment.key); if (previous?.source.componentVersion === segment.version) continue;
      let text = segment.text, overview;
      if (segment.key === 'global-overview') {
        overview = JSON.parse(segment.text).globalOverview;
        if (previous?.source.overview) {
          const old = new Map(previous.source.overview.map(row => [row.id, row])), now = new Set(overview.map(row => row.id));
          const changes = [...overview.filter(row => !old.has(row.id) || canonicalJson(row) !== canonicalJson(old.get(row.id))), ...[...old.values()].filter(row => !now.has(row.id)).map(row => ({ id: row.id, removed: true }))];
          text = canonicalJson({ globalOverviewChanges: changes, instruction: '只更新这些节点；同一编号以最后一行为准，removed 表示不再列入进行中概貌。' });
        }
      }
      additions.push(createUserMessage({ source: { kind: TREE_CONTEXT_SOURCE, componentKey: segment.key, componentVersion: segment.version, sourceRefs: segment.sourceRefs, itemVersions: segment.itemVersions, summaryVersions: segment.summaryVersions, ...(segment.turnAssignments ? { turnAssignments: segment.turnAssignments } : {}), ...(overview ? { overview } : {}) }, content: [{ type: 'text', text }] }));
    }
    builder.mounted.set(sessionId, { snapshotKey: snapshot.key, messages: [...retainedMessages, ...additions] });
    return { ...decision, messages: [...decision.messages, ...additions] };
  }));
  disposers.push(ctx.on('llm/stream', (options, next) => {
    if (!session || options.sessionId !== sessionId) return next();
    return (async function* () {
      options.signal?.throwIfAborted(); assertOwnedCompaction(session);
      const snapshot = builder.capture(sessionId), actual = options.messages.filter(m => m.source?.kind === TREE_CONTEXT_SOURCE);
      const mounted = builder.mounted.get(sessionId);
      if (mounted?.snapshotKey !== snapshot.key || actual.some(m => !builder.reusableComponent(m.source)) || canonicalJson(actual) !== canonicalJson(mounted.messages)) fail('CONTEXT_STALE', 'Actual native input differs from the prepared current-scope projection');
      yield* next();
    })();
  }));
  return async () => { builder.mounted.delete(sessionId); for (const dispose of disposers.reverse()) await dispose(); };
}
