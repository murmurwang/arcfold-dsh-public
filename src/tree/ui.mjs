import { randomUUID } from 'node:crypto';
import { canonicalJson, digest, fail, shape, text, integer, array, oneOf, validateShort, validateLong, STATUSES, CATEGORIES } from './contracts.mjs';
import { TreeService, SignalService } from './tree.mjs';
import { ItemService } from './items.mjs';
import { evidenceResolver, effectiveSignals, signalPolarity, EpisodeSignals } from './signals.mjs';
import { contentHash } from './host-process.mjs';

export const TREE_ENDPOINTS = ['session.current', 'session.selectBranch', 'tree.list', 'node.details', 'turn.details', 'source.read', 'node.rename', 'node.move', 'node.status', 'turn.correct', 'turn.undoCreate', 'turn.undoStatus', 'item.confirm', 'item.edit', 'item.withdraw', 'item.undoCorrection', 'hook.disable', 'signal.correct', 'snapshots.list', 'snapshots.preview', 'snapshots.restore', 'metrics.read', 'reports.list', 'reports.details', 'reports.export', 'parameters.set', 'receipts.read'];
const readEndpoints = new Set(['session.current', 'tree.list', 'node.details', 'turn.details', 'source.read', 'snapshots.list', 'metrics.read', 'reports.list', 'reports.details', 'receipts.read']);
const versionId = (id, version) => digest(['item_version', id, version]);
const methodId = (id, version) => digest(['method', id, version]);

// Called by the trusted turn adapter immediately after capture, never by RPC.
export function bindTurnSnapshot(repository, snapshotId, logicalTurnId) {
  const snapshot = repository.get('tree_snapshots', snapshotId), turn = repository.get('tree_turns', logicalTurnId);
  if (!snapshot || !turn || snapshot.logicalTurnId && snapshot.logicalTurnId !== turn.id) fail('SNAPSHOT_BINDING', 'Snapshot requires its exact originating turn');
  return repository.command('bindTurnSnapshot', { requestId: digest(['snapshot-turn', snapshotId, logicalTurnId]), expected: {}, input: { snapshotId, logicalTurnId } }, { kind: 'program', id: 'tree-turn-adapter' }, () => {
    repository.save('tree_snapshots', { ...snapshot, logicalTurnId }, snapshot.revision); return { snapshotId, logicalTurnId };
  });
}

/** Host-owned domain adapter. Browser data never supplies the actor or scope. */
export class TreeUIService {
  constructor({ repository, resolveSource, metrics, reports, snapshotsFor, browserScope, attribution, selectBranch }) {
    if (typeof browserScope !== 'function') fail('BROWSER_SCOPE_REQUIRED', 'A host-owned browser scope is required');
    Object.assign(this, { repo: repository, metrics, reports, snapshotsFor, browserScope, attribution, selectBranch }); this.resolveSource = evidenceResolver(repository, resolveSource);
  }
  authorize(context) {
    if (context.actor?.kind !== 'user' || context.actor.id !== this.repo.userId || context.signal?.aborted !== false) fail('FORBIDDEN', 'Current authenticated owner required', 403);
    const scope = this.browserScope(context); if (!scope || scope.then || !Array.isArray(scope.nodeIds) || new Set(scope.nodeIds).size !== scope.nodeIds.length || scope.nodeIds.some(id => { const n = this.repo.get('tree_nodes', id); return !n || n.deleted; })) fail('BROWSE_SCOPE', 'Browser scope is unavailable', 403);
    return scope;
  }
  scoped(id, scope) { if (!scope.nodeIds.includes(id)) fail('BROWSE_SCOPE', 'This node is outside the current browser scope', 403); const node = this.repo.get('tree_nodes', id); if (!node || node.deleted) fail('NODE_NOT_FOUND', 'Node not found'); return node; }
  turnJobs(turn) {
    const rows = this.repo.list('tree_jobs', j => j.input?.turnId === turn.id || j.trigger?.turnId === turn.id);
    const assignment = j => j.input?.currentTurn?.assignmentRevision ?? j.input?.assignmentRevision;
    const learning = rows.filter(j => j.role === 'learning').sort((a, b) => b.enqueuedOrder - a.enqueuedOrder || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const owner = j => learning.find(other => other.nodeIds[0] === j.nodeIds[0] && assignment(other) === assignment(j));
    // Scheduling intents are not a second worker. Old intents remain queued
    // after rejected/unknown output; project their actual owner's state without
    // rewriting evidence or dispatching another request from a read endpoint.
    const correctionOwner = intent => rows.find(j => j.role === 'verification' && j.trigger?.intentId === intent.id);
    return rows.filter(j => j.role || (j.kind !== 'learning' || !owner(j)) && (j.kind !== 'verification' || !correctionOwner(j))).map(j => ({ id: j.id, role: j.role ?? j.kind, status: j.status,
      current: (assignment(j) === undefined || assignment(j) === turn.assignmentRevision) && (j.role !== 'learning' || owner(j)?.id === j.id), error: j.error?.code ?? j.error ?? null,
      rejectedItems: j.rejectedItems ?? [] }));
  }
  page(rows, payload, key) {
    const limit = payload.limit ?? 50; integer(limit, 'limit', 1, 100);
    const sorted = rows.toSorted((a, b) => a.id.localeCompare(b.id)), version = digest(sorted.map(r => [r.id, r.revision]));
    let after = '';
    if (payload.cursor) { text(payload.cursor, 'cursor', 2048); let cursor; try { cursor = JSON.parse(Buffer.from(payload.cursor, 'base64url').toString()); } catch { fail('CURSOR_INVALID', 'Invalid page cursor'); } if (cursor.key !== key || cursor.version !== version || typeof cursor.after !== 'string') fail('REVISION_CONFLICT', 'List changed; refresh from the first page'); after = cursor.after; }
    const rest = sorted.filter(r => r.id > after), selected = rest.slice(0, limit);
    return { rows: selected, nextCursor: rest.length > limit ? Buffer.from(canonicalJson({ key, version, after: selected.at(-1).id })).toString('base64url') : null };
  }
  read(endpoint, payload, context, scope) {
    if (endpoint === 'session.current') { shape(payload, []); const turn = this.repo.list('tree_turns', t => t.sessionId === context.sessionId).sort((a, b) => b.nativeTurn - a.nativeTurn)[0];
      if (turn && turn.nodeIds.some(id => !scope.nodeIds.includes(id))) fail('BROWSE_SCOPE', 'Current turn outside scope', 403);
      const nodeIds = turn?.nodeIds ?? [this.repo.rootId()]; return { attribution: this.attribution && scope.nodeIds.length === this.repo.list('tree_nodes', n => !n.deleted).length ? this.attribution.capacity(context.sessionId) : null, turnId: turn?.id ?? null, paths: nodeIds.map(id => this.repo.ancestors(id).filter(n => scope.nodeIds.includes(n.id))),
        // What attribution changed in the tree before this turn's answer, and why (092).
        goalChanges: (turn?.goalChanges ?? []).filter(c => scope.nodeIds.includes(c.nodeId)).map(({ op, name, previousName, parentId, reason }) => ({ op, name, reason,
          ...(op === 'rename' ? { previousName } : {}), ...(op === 'move' ? { parentName: scope.nodeIds.includes(parentId) ? this.repo.get('tree_nodes', parentId)?.name ?? null : null } : {}) })), turnIds: this.repo.list('tree_turns', t => t.sessionId === context.sessionId && t.nodeIds.every(id => scope.nodeIds.includes(id))).map(t => ({ nativeTurn: t.nativeTurn, turnId: t.id })) }; }
    if (endpoint === 'tree.list') {
      shape(payload, [], ['statusFilter', 'cursor', 'limit']); const statuses = payload.statusFilter ?? STATUSES; array(statuses, 'statusFilter', 4).forEach(s => oneOf(s, STATUSES, 'status'));
      const page = this.page(this.repo.list('tree_nodes', n => !n.deleted && scope.nodeIds.includes(n.id) && statuses.includes(n.status)), payload, 'tree:' + digest(scope.nodeIds));
      return { nodes: page.rows.map(n => ({ ...n, oneLine: n.currentSummaryId ? this.repo.get('tree_summaries', n.currentSummaryId)?.oneLine ?? '' : '' })), nextCursor: page.nextCursor, treeRevision: this.repo.meta().treeRevision };
    }
    if (endpoint === 'node.details') {
      shape(payload, ['nodeId']); const node = this.scoped(payload.nodeId, scope), items = this.repo.list('tree_items', i => i.nodeId === node.id).map(item => ({ ...item, current: this.repo.get('tree_item_versions', versionId(item.id, item.activeVersion ?? item.draftVersion)),
        history: this.repo.list('tree_item_versions', v => v.itemId === item.id), method: item.kind === 'method' ? this.repo.get('tree_methods', methodId(item.id, item.activeVersion ?? item.draftVersion)) : null,
        hooks: this.repo.list('tree_hooks', h => h.methodId === item.id && h.version === item.activeVersion), scripts: item.kind !== 'method' ? [] : (this.repo.get('tree_methods', methodId(item.id, item.activeVersion ?? item.draftVersion))?.scripts ?? []).map(ref => { const artifact = this.repo.list('tree_script_artifacts', a => a.scriptId === ref.id && a.version === ref.version)[0]; return { id: ref.id, version: ref.version, usage: artifact?.usage ?? null, readOnlyProbeCount: artifact?.probeIds?.length ?? 0, notVerified: artifact?.notVerified ?? [] }; }), supplement: item.kind === 'supplement' ? this.repo.get('tree_supplements', digest(['supplement', item.id, item.activeVersion])) : null }));
      return { node, path: this.repo.ancestors(node.id).filter(n => scope.nodeIds.includes(n.id)), summary: node.currentSummaryId ? this.repo.get('tree_summaries', node.currentSummaryId) : null, items,
        children: this.repo.list('tree_nodes', n => !n.deleted && n.parentId === node.id && scope.nodeIds.includes(n.id)), promotionHistory: items.filter(i => i.originChain?.length > 1).map(i => ({ itemId: i.id, originChain: i.originChain, reason: i.promotionReason })),
        parameters: ['retentionDays', 'leaveTimeoutHours'].map(name => { const service = new TreeService({ repository: this.repo }); return { name, value: service.parameter(name, node.id), local: this.repo.get('tree_parameters', digest(['parameter', name, node.id])) }; }),
        revisionSet: { ['tree_nodes:' + node.id]: node.revision, ...Object.fromEntries(items.map(i => ['tree_items:' + i.id, i.revision])) } };
    }
    if (endpoint === 'turn.details') {
      shape(payload, ['turnId']); const turn = this.repo.get('tree_turns', payload.turnId); if (!turn || turn.nodeIds.some(id => !scope.nodeIds.includes(id))) fail('BROWSE_SCOPE', 'Turn is outside browser scope', 403);
      return { turn, nodes: turn.nodeIds.map(id => this.scoped(id, scope)), signals: effectiveSignals(this.repo, this.resolveSource).filter(s => s.sourceRefs.some(r => turn.userSourceRefs.some(ref => digest(ref) === digest(r)))),
        statusChanges: Object.values(this.repo.meta().treeObservations ?? {}).flat().filter(o => !o.reversalOf && o.logicalTurnId === turn.id && o.type === 'status' && o.origin !== 'cascade' && scope.nodeIds.includes(o.nodeId)).map(o => { const group = Object.values(this.repo.meta().treeObservations).flat().filter(other => other.commandReceiptId === o.commandReceiptId && other.type === 'status'); return { ...o, nodeName: this.repo.get('tree_nodes', o.nodeId)?.name, expectedRevisions: Object.fromEntries(group.filter(other => scope.nodeIds.includes(other.nodeId)).map(other => [other.nodeId, this.repo.get('tree_nodes', other.nodeId)?.revision])), reversed: Boolean(this.repo.meta().reversedTreeChanges?.[o.commandReceiptId]) }; }),
        hookRuns: this.repo.list('tree_hook_runs', r => r.logicalTurnId === turn.logicalTurnId), jobs: this.turnJobs(turn),
        snapshots: this.repo.list('tree_snapshots', s => s.logicalTurnId === turn.logicalTurnId).map(s => ({ id: s.id, coverage: s.coverage, restoreState: s.restoreState })) };
    }
    if (endpoint === 'metrics.read') { shape(payload, [], ['scopeNodeId', 'range']); if (payload.scopeNodeId) this.scoped(payload.scopeNodeId, scope); else if (!scope.nodeIds.includes(this.repo.rootId()) || scope.nodeIds.length !== this.repo.list('tree_nodes', n => !n.deleted).length) fail('BROWSE_SCOPE', 'Global metrics require the whole tree scope', 403); shape(payload.range ?? {}, [], ['afterOrdinal', 'throughOrdinal']);
      const current = this.metrics.freeze(payload.scopeNodeId ?? null, payload.range), windows = this.repo.list('tree_metric_windows', w => !w.needsRecheck && w.scope === current.scope && w.toOrdinal <= current.toOrdinal).sort((a, b) => a.toOrdinal - b.toOrdinal).slice(-2);
      return { ...current, windows, comparison: this.metrics.compare(windows[0], windows[1]) }; }
    if (endpoint === 'reports.list') {
      shape(payload, [], ['cursor', 'limit']); this.requireReports(scope); const page = this.page(this.repo.list('tree_reports'), payload, 'reports'); return { reports: page.rows.map(r => this.reports.preview(r.id, { actor: context.actor })), nextCursor: page.nextCursor };
    }
    if (endpoint === 'reports.details') { shape(payload, ['reportId'], ['includeEvidence']); this.requireReports(scope); if (payload.includeEvidence !== undefined && typeof payload.includeEvidence !== 'boolean') fail('INVALID_FIELD', 'Explicit evidence choice required'); return this.reports.preview(payload.reportId, { actor: context.actor, includeEvidence: payload.includeEvidence ?? false }); }
    if (endpoint === 'source.read') { shape(payload, ['itemId','version','sourceIndex']); const item = this.repo.get('tree_items', payload.itemId); if (!item) fail('ITEM_NOT_FOUND', 'Item missing'); this.scoped(item.nodeId, scope); const version = this.repo.get('tree_item_versions', versionId(item.id, payload.version)); integer(payload.sourceIndex, 'sourceIndex', 0, 1999); const ref = version?.sourceRefs[payload.sourceIndex], source = ref && this.resolveSource(ref); if (!source) fail('SOURCE_CHANGED', 'Evidence is no longer available'); return { role: source.role, origin: source.origin, text: source.text, ref }; }
    if (endpoint === 'snapshots.list') { shape(payload, ['logicalTurnId']); const turn = this.repo.get('tree_turns', payload.logicalTurnId); if (!turn || turn.nodeIds.some(id => !scope.nodeIds.includes(id))) fail('BROWSE_SCOPE', 'Snapshot turn is outside scope', 403); return { snapshots: this.repo.list('tree_snapshots', s => s.logicalTurnId === turn.id).map(s => ({ id: s.id, coverage: s.coverage, restoreState: s.restoreState, capturedAt: s.capturedAt })) }; }
    if (endpoint === 'receipts.read') {
      shape(payload, ['requestId']); const value = this.repo.meta().uiRequests?.[this.key(context.actor, payload.requestId)]; if (!value) return { state: 'not_found' }; if (value.sessionId && value.sessionId !== context.sessionId) fail('BROWSE_SCOPE', '操作属于另一段对话', 403); value.nodeIds.forEach(id => { if (!scope.nodeIds.includes(id)) fail('BROWSE_SCOPE', 'Receipt belongs to another browse scope', 403); });
      if (value.endpoint === 'snapshots.restore' && ['pending', 'unknown'].includes(value.state)) { const intent = this.repo.meta().restoreIntents?.[digest(['restore', value.domainRequestId])]; if (intent) return { ...value, state: intent.state === 'completed' ? 'success' : intent.state, value: intent }; }
      return value;
    }
    fail('ENDPOINT_NOT_FOUND', 'Unknown tree endpoint', 404);
  }
  requireReports(scope) { if (!scope.nodeIds.includes(this.repo.rootId()) || scope.nodeIds.length !== this.repo.list('tree_nodes', n => !n.deleted).length) fail('BROWSE_SCOPE', 'Reports combine evidence across the tree', 403); }
  key(actor, requestId) { text(requestId, 'requestId', 512); return digest(['tree-ui', actor.id, requestId]); }
  recordUI(key, value) {
    return this.repo.command('recordTreeUIReceipt', { requestId: digest([key, value.state, digest(value)]), expected: {}, input: { key, state: value.state } }, { kind: 'program', id: 'tree-ui' }, () => { const meta = this.repo.meta(); this.repo.save('tree_meta', { ...meta, uiRequests: { ...meta.uiRequests, [key]: value } }, meta.revision); return value; }).result;
  }
  async dispatch(endpoint, payload, context) {
    const scope = this.authorize(context); if (!TREE_ENDPOINTS.includes(endpoint)) fail('ENDPOINT_NOT_FOUND', 'Unknown tree endpoint', 404);
    if (readEndpoints.has(endpoint)) return this.read(endpoint, payload, context, scope);
    text(payload.requestId, 'requestId', 512); const key = this.key(context.actor, payload.requestId), hash = digest([endpoint, payload, ...(endpoint === 'session.selectBranch' ? [context.sessionId] : [])]), prior = this.repo.meta().uiRequests?.[key];
    if (prior) { if (prior.hash !== hash) fail('IDEMPOTENCY_CONFLICT', 'This request identity has different input'); prior.nodeIds.forEach(id => { if (!scope.nodeIds.includes(id)) fail('BROWSE_SCOPE', 'Receipt outside browser scope', 403); }); return prior; }
    const state = { endpoint, hash, nodeIds: [...scope.nodeIds], state: 'pending', domainRequestId: key, requestId: payload.requestId };
    if (endpoint === 'session.selectBranch') {
      shape(payload, ['requestId', 'nodeId', 'expectedTreeRevision', 'expectedSelectionRevision', 'pendingId']);
      this.requireReports(scope);
      if (!this.selectBranch) fail('ENDPOINT_UNAVAILABLE', '当前服务尚未启用目标范围选择');
      if (payload.nodeId !== null) this.scoped(payload.nodeId, scope);
      integer(payload.expectedTreeRevision, 'expectedTreeRevision'); integer(payload.expectedSelectionRevision, 'expectedSelectionRevision', 0);
      if (payload.pendingId !== null) text(payload.pendingId, 'pendingId', 128);
      state.sessionId = context.sessionId; this.recordUI(key, state);
      try {
        const value = await this.selectBranch(payload, context, key);
        return this.recordUI(key, { ...state, state: 'success', value });
      } catch (error) {
        const pending = payload.pendingId && this.repo.meta().attributionPending?.[payload.pendingId];
        this.recordUI(key, { ...state, state: pending?.continuationRequestId === key ? 'unknown' : 'failed', error: { code: error.code ?? 'HOST_ERROR' } }); throw error;
      }
    }
    if (endpoint.startsWith('snapshots.')) {
      if (!this.snapshotsFor) fail('SNAPSHOT_UNAVAILABLE', 'Workspace snapshot service is not mounted');
      shape(payload, endpoint === 'snapshots.preview' ? ['requestId', 'snapshotId', 'paths'] : ['requestId', 'previewId', 'expectedHashes']);
      const preview = endpoint === 'snapshots.restore' && this.repo.meta().restorePreviews?.[payload.previewId], snapshot = this.repo.get('tree_snapshots', payload.snapshotId ?? preview?.snapshotId);
      const turn = snapshot && this.repo.get('tree_turns', snapshot.logicalTurnId); if (!turn || turn.nodeIds.some(id => !scope.nodeIds.includes(id))) fail('BROWSE_SCOPE', 'Snapshot is outside the admitted turn scope', 403);
      state.nodeIds = [...turn.nodeIds]; this.recordUI(key, state); const snapshots = this.snapshotsFor(context);
      try { const value = endpoint === 'snapshots.preview' ? await snapshots.preview({ snapshotId: snapshot.id, paths: payload.paths, requestId: key }) : await snapshots.apply({ previewId: payload.previewId, expectedCurrentHashes: payload.expectedHashes, requestId: key, signal: context.signal });
        if (endpoint === 'snapshots.preview') { value.diffs = await this.previewDiffs(value, snapshots, context.signal); this.authorize(context); }
        return this.recordUI(key, { ...state, state: endpoint === 'snapshots.preview' || value.state === 'completed' ? 'success' : value.state ?? 'unknown', value });
      } catch (error) { this.recordUI(key, { ...state, state: 'unknown', error: { code: error.code ?? 'SNAPSHOT_UNKNOWN' } }); throw error; }
    }
    return this.repo.transaction(() => {
      const beforeNodes = this.repo.list('tree_nodes'), result = this.mutate(endpoint, payload, context, scope, key), receipt = result.receipt ?? result;
      this.metrics.observeTree(receipt, beforeNodes);
      if (result.repair) this.recordRepair(receipt, result.repair);
      if (endpoint !== 'reports.export') state.nodeIds = uniqueIds([...(result.repair?.nodeIds ?? []), ...receipt.eventIds.flatMap(id => this.repo.get('tree_change_events', id).entityIds).flatMap(key => {
        const split = key.indexOf(':'), kind = key.slice(0, split), row = this.repo.get(kind, key.slice(split + 1));
        return kind === 'tree_nodes' ? [row.id] : kind === 'tree_turns' ? row.nodeIds : row?.nodeId ? [row.nodeId] : row?.scopeNodeId ? [row.scopeNodeId] : [];
      })]).filter(id => !this.repo.get('tree_nodes', id)?.deleted);
      return this.recordUI(key, { ...state, state: 'success', value: receipt });
    });
  }
  mutate(endpoint, p, context, scope, requestId) {
    const opts = { repository: this.repo, resolveSource: this.resolveSource, context: () => ({ actor: context.actor }) }, tree = new TreeService(opts), items = new ItemService(opts), command = (input, expected = {}) => ({ requestId, input, expected });
    const node = id => this.scoped(id, scope), expected = (kind, id, value) => { integer(value, 'expectedRevision'); return { [kind + ':' + id]: value }; };
    if (endpoint === 'item.undoCorrection') {
      shape(p, ['requestId', 'itemId', 'expectedRevision', 'replacementId', 'expectedReplacementRevision']);
      const original = items.item(p.itemId), replacement = items.item(p.replacementId);
      node(original.nodeId); node(replacement.nodeId);
      if (original.kind !== 'understanding' || !['invalid', 'changed'].includes(original.lifecycle) || original.replacedBy !== replacement.id ||
          original.nodeId !== replacement.nodeId || replacement.lifecycle !== 'active' || replacement.kind !== 'understanding' ||
          replacement.activeVersion !== 1 || replacement.userProtected || replacement.producerRole !== 'learning') {
        fail('CORRECTION_CHANGED', '更正后的内容已经变化，请先查看历史，不能直接撤销');
      }
      const old = items.version(original.id, original.activeVersion);
      for (const ref of old.sourceRefs) {
        if (!this.resolveSource(ref)) fail('SOURCE_CHANGED', '原理解的来源已不可用，不能直接恢复');
        const owners = this.repo.list('tree_turns', turn => (turn.experienceRefs ?? turn.sourceRefs).some(source => digest(source) === digest(ref)));
        if (owners.length && !owners.some(turn => turn.status === 'settled' && turn.nodeIds.includes(original.nodeId))) fail('SOURCE_CHANGED', '原理解的来源已不属于此事项');
      }
      const revisions = { ...expected('tree_items', original.id, p.expectedRevision), ...expected('tree_items', replacement.id, p.expectedReplacementRevision) };
      return this.repo.command('undoLearningCorrection', command({ itemId: original.id, replacementId: replacement.id }, revisions), context.actor, () => {
        this.repo.save('tree_items', { ...original, lifecycle: 'active', replacedBy: null,
          correctionUndoHistory: [...(original.correctionUndoHistory ?? []), { replacementId: replacement.id, correctionSourceRefs: original.correctionSourceRefs ?? [], requestId }] }, original.revision);
        this.repo.save('tree_items', { ...replacement, lifecycle: 'withdrawn', withdrawalReason: '用户撤销自动更正' }, replacement.revision);
        for (const exposure of this.repo.list('tree_exposures', value => !value.revoked && value.itemVersions.some(version => version.itemId === replacement.id))) {
          this.repo.save('tree_exposures', { ...exposure, revoked: true, invalidationReason: 'user_undid_correction' }, exposure.revision);
        }
        return { itemId: original.id, replacementId: replacement.id };
      });
    }
    if (endpoint === 'turn.undoStatus') {
      shape(p, ['requestId', 'turnId', 'observationId', 'expectedRevisions']); const turn = this.repo.get('tree_turns', p.turnId); if (!turn) fail('TURN_NOT_FOUND', 'Turn not found'); turn.nodeIds.forEach(node);
      const all = Object.values(this.repo.meta().treeObservations ?? {}).flat(), original = all.find(o => o.id === p.observationId && o.logicalTurnId === turn.id && o.type === 'status' && o.origin !== 'cascade');
      if (!original || this.repo.meta().reversedTreeChanges?.[original.commandReceiptId]) fail('REVISION_CONFLICT', 'Status change is unavailable or already reversed');
      const group = all.filter(o => o.commandReceiptId === original.commandReceiptId && o.type === 'status'); shape(p.expectedRevisions, group.map(o => o.nodeId));
      for (const o of group) { const current = node(o.nodeId); integer(p.expectedRevisions[o.nodeId], 'expectedRevision'); if (current.revision !== p.expectedRevisions[o.nodeId] || current.status !== o.after || current.deleted || all.some(later => later.ordinal > o.ordinal && later.nodeId === o.nodeId && ['status', 'parentId', 'deleted'].includes(later.type))) fail('REVISION_CONFLICT', 'This status has changed since the original action'); }
      for (const o of group.filter(o => o.before !== 'active')) if (this.repo.list('tree_nodes', n => !n.deleted && !group.some(g => g.nodeId === n.id) && ['active', 'paused'].includes(n.status) && this.repo.ancestors(n.id).some(a => a.id === o.nodeId)).length) fail('REVISION_CONFLICT', 'Later descendant activity prevents restoring this old status');
      const receipt = this.repo.command('undoTurnStatus', command({ turnId: turn.id, observationId: original.id }, Object.fromEntries(group.map(o => ['tree_nodes:' + o.nodeId, p.expectedRevisions[o.nodeId]]))), context.actor, () => {
        for (const o of group) { const current = node(o.nodeId); this.repo.save('tree_nodes', { ...current, status: o.before, statusOrigin: o.beforeStatusOrigin, cascadeFromId: o.beforeCascadeFromId, statusChangedAt: this.repo.now(), statusSourceRefs: [] }, current.revision); }
        const meta = this.repo.meta(); this.repo.save('tree_meta', { ...meta, treeRevision: meta.treeRevision + 1, reversedTreeChanges: { ...meta.reversedTreeChanges, [original.commandReceiptId]: requestId } }, meta.revision); return { turnId: turn.id, nodeIds: group.map(o => o.nodeId), reversalOf: original.commandReceiptId };
      });
      return { receipt, repair: { producerRole: original.origin === 'attribution' ? 'attribution' : 'main', producerJobId: null, nodeIds: group.map(o => o.nodeId), type: 'user_undo_status', reason: '用户撤销本轮状态判断；等待诊断是否属于原误判', eligible: original.origin !== 'user' } };
    }
    if (endpoint === 'node.rename') { shape(p, ['requestId','nodeId','name','expectedRevision']); node(p.nodeId); text(p.name, 'name', 80);
      const before = node(p.nodeId), receipt = this.repo.command('renameTreeNode', command({ nodeId: p.nodeId, name: p.name }, expected('tree_nodes', p.nodeId, p.expectedRevision)), context.actor, () => { const n = node(p.nodeId); this.repo.save('tree_nodes', { ...n, name: p.name, nameUserProtected: true }, n.revision); const meta = this.repo.meta(); this.repo.save('tree_meta', { ...meta, treeRevision: meta.treeRevision + 1 }, meta.revision); return { nodeId: n.id }; });
      return { receipt, repair: { producerRole: 'attribution', producerJobId: null, nodeIds: [p.nodeId], type: 'user_rename', reason: '用户修改事项名称；仍需判断是原误判还是新的意图', eligible: !before.nameUserProtected && before.name !== p.name } }; }
    if (endpoint === 'node.move') { shape(p, ['requestId','nodeId','parentId','expectedTreeRevision']); const n = node(p.nodeId); node(p.parentId); this.requireSubtree(n.id, scope); if (this.repo.meta().treeRevision !== p.expectedTreeRevision) fail('REVISION_CONFLICT', 'Tree changed'); return tree.moveNode(command({ nodeId: n.id, parentId: p.parentId, sourceRefs: [] }, expected('tree_nodes', n.id, n.revision))); }
    if (endpoint === 'node.status') { shape(p, ['requestId','nodeId','status','expectedRevision']); const before = node(p.nodeId); this.requireSubtree(p.nodeId, scope); if (p.status === 'active') this.repo.ancestors(p.nodeId).forEach(n => node(n.id));
      const receipt = tree.setStatus(command({ nodeId: p.nodeId, status: p.status, sourceRefs: [] }, expected('tree_nodes', p.nodeId, p.expectedRevision)));
      return { receipt, repair: { producerRole: before.statusOrigin === 'model' ? 'main' : 'attribution', producerJobId: null, nodeIds: [p.nodeId], type: 'user_status_change', reason: '用户改变事项状态；重新打开助手标完事项需要回看依据', eligible: before.statusOrigin !== 'user' && before.status !== p.status } }; }
    if (['turn.correct', 'turn.undoCreate'].includes(endpoint)) {
      shape(p, endpoint === 'turn.correct' ? ['requestId','turnId','nodeIds','expectedAssignmentRevision'] : ['requestId','turnId','nodeId','expectedRevision','expectedAssignmentRevision'], endpoint === 'turn.correct' ? ['create'] : []);
      const turn = this.repo.get('tree_turns', p.turnId); if (!turn || turn.nodeIds.some(id => !scope.nodeIds.includes(id))) fail('BROWSE_SCOPE', 'Turn outside scope', 403); if (turn.assignmentRevision !== p.expectedAssignmentRevision) fail('REVISION_CONFLICT', 'Assignment changed');
      let targetIds = p.nodeIds;
      if (endpoint === 'turn.undoCreate') { const n = node(p.nodeId); if (n.revision !== p.expectedRevision || !turn.createdNodeIds.includes(n.id)) fail('REVISION_CONFLICT', 'Created node changed');
        if (this.repo.list('tree_links', l => l.nodeId === n.id && l.active && l.turnId !== turn.id).length || this.repo.list('tree_nodes', c => c.parentId === n.id && !c.deleted).length) fail('NEED_ASSIGNMENT_CORRECTION', 'This node has later experience; correct this turn instead');
        targetIds = turn.nodeIds.filter(id => id !== n.id); if (!targetIds.length) targetIds = [n.parentId]; }
      array(targetIds, 'nodeIds', p.create ? 7 : 8).forEach(node);
      if (p.create) {
        shape(p.create, ['name', 'parentId', 'expectedTreeRevision']); text(p.create.name, 'name', 80); node(p.create.parentId);
        if (p.create.expectedTreeRevision !== this.repo.meta().treeRevision) fail('REVISION_CONFLICT', 'Tree changed');
        this.repo.ancestors(p.create.parentId).forEach(n => node(n.id)); const id = randomUUID(), beforeCreate = this.repo.list('tree_nodes');
        const created = this.repo.command('createCorrectionTarget', { requestId: digest([requestId, 'create']), expected: {}, input: p.create }, context.actor, () => {
          this.repo.save('tree_nodes', { id, parentId: p.create.parentId, name: p.create.name, nameUserProtected: true, status: 'active', statusOrigin: 'user', sourceRefs: [], lastOwnTurnAt: turn.startedAt, lastSummaryWatermark: null });
          for (const ancestor of this.repo.ancestors(p.create.parentId)) if (ancestor.status !== 'active') this.repo.save('tree_nodes', { ...ancestor, status: 'active', statusOrigin: 'user', cascadeFromId: null }, ancestor.revision);
          const meta = this.repo.meta(); this.repo.save('tree_meta', { ...meta, treeRevision: meta.treeRevision + 1 }, meta.revision); return { nodeId: id };
        });
        this.metrics.observeTree(created, beforeCreate); targetIds = [...targetIds, id];
      }
      const receipt = tree.correctAssignment(command({ turnId: turn.id, nodeIds: targetIds, sourceRefs: [], ...(endpoint === 'turn.undoCreate' ? { undoCreate: true } : {}) }, expected('tree_turns', turn.id, turn.revision)));
      return { receipt, repair: { producerRole: 'attribution', producerJobId: turn.attributionRunId, nodeIds: uniqueIds([...turn.nodeIds, ...targetIds]), type: 'assignment_correction', reason: '用户纠正本轮目标归属', eligible: !receipt.result.unchanged } };
    }
    if (endpoint.startsWith('item.')) {
      shape(p, endpoint === 'item.edit' ? ['requestId','itemId','expectedVersion','replacement','reason'] : endpoint === 'item.withdraw' ? ['requestId','itemId','expectedVersion','reason'] : ['requestId','itemId','expectedVersion']);
      const item = items.item(p.itemId); node(item.nodeId); if ((item.activeVersion ?? item.draftVersion) !== p.expectedVersion) fail('REVISION_CONFLICT', 'Item version changed');
      const old = items.version(item.id, p.expectedVersion), exp = expected('tree_items', item.id, item.revision); let receipt;
      if (endpoint === 'item.confirm') {
        if (item.stale) fail('ITEM_RECHECK_REQUIRED', '归属已变化，请核对并保存当前内容后再使用');
        if (item.kind !== 'understanding' || old.sourceKind !== 'assistant_inferred') fail('CONFIRM_INFERENCE_ONLY', 'Only an assistant inference can be confirmed');
        receipt = items.confirm(command({ itemId: item.id, version: p.expectedVersion }, exp));
        new EpisodeSignals({ repository: this.repo, resolveSource: this.resolveSource }).captureConfirmation(receipt.id); return receipt;
      }
      if (endpoint === 'item.withdraw') receipt = items.withdraw(command({ itemId: item.id, version: p.expectedVersion, reason: p.reason }, exp));
      else receipt = this.editItem(command({ itemId: item.id, version: p.expectedVersion, replacement: p.replacement, reason: p.reason }, exp), item, old, context.actor);
      return { receipt, repair: { producerRole: item.producerRole ?? 'learning', producerJobId: item.producerJobId ?? null, itemId: item.id, itemVersion: p.expectedVersion, nodeIds: [item.nodeId], type: endpoint === 'item.edit' ? 'user_edit' : 'user_withdraw', reason: p.reason, eligible: !item.stale && !item.userProtected && old.sourceKind === 'assistant_inferred' } };
    }
    if (endpoint === 'hook.disable') { shape(p, ['requestId','methodId','hookId','expectedVersion']); const item = items.item(p.methodId); node(item.nodeId); if (item.activeVersion !== p.expectedVersion) fail('REVISION_CONFLICT', 'Method changed');
      const hook = this.repo.get('tree_hooks', digest(['hook_version', p.hookId, p.expectedVersion])); if (!hook || hook.methodId !== item.id) fail('HOOK_NOT_FOUND', 'Hook is not part of the current method');
      const receipt = this.repo.command('disableTreeHook', command({ methodId: item.id, hookId: p.hookId, version: p.expectedVersion }, expected('tree_hooks', hook.id, hook.revision)), context.actor, () => { this.repo.save('tree_hooks', { ...hook, enabled: false, manuallyDisabled: true }, hook.revision); return { methodId: item.id, hookId: hook.hookId, enabled: false }; });
      return { receipt, repair: { producerRole: item.producerRole ?? 'learning', producerJobId: item.producerJobId ?? null, nodeIds: [item.nodeId], itemId: item.id, itemVersion: item.activeVersion, type: 'user_disable_hook', reason: '用户停用方法提醒；尚未诊断原因', eligible: hook.enabled && !item.userProtected } }; }
    if (endpoint === 'signal.correct') { shape(p, ['requestId','signalId','category','expectedRevision']); oneOf(p.category, CATEGORIES, 'category'); const old = this.repo.get('tree_signals', p.signalId); if (!old || !effectiveSignals(this.repo, this.resolveSource).some(s => s.id === old.id)) fail('REVISION_CONFLICT', 'Signal has already been corrected'); old.nodeIds.forEach(node);
      const replacement = Object.fromEntries(['eventId','subjectRefs','dimension','subitem','category','polarity','evidenceKind','sourceRefs','nodeIds','confidence'].map(k => [k, old[k]]));
      const receipt = new SignalService(opts).correct(command({ signalId: old.id, replacement: { ...replacement, category: p.category, subitem: p.category, polarity: signalPolarity(p.category) } }, expected('tree_signals', old.id, p.expectedRevision)));
      return { receipt, repair: { producerRole: 'learning', producerJobId: null, nodeIds: old.nodeIds, type: 'user_category_correction', reason: '用户纠正反馈类别', eligible: !old.correctionOf && old.category !== p.category } }; }
    if (endpoint === 'parameters.set') { shape(p, ['requestId','name','nodeId','value','expectedRevision']); node(p.nodeId); const id = digest(['parameter', p.name, p.nodeId]), old = this.repo.get('tree_parameters', id); if ((old?.revision ?? 0) !== p.expectedRevision) fail('REVISION_CONFLICT', 'Parameter changed'); return tree.setParameter(command({ name: p.name, scopeNodeId: p.nodeId, value: p.value, sourceRefs: [] }, old ? expected('tree_parameters', id, p.expectedRevision) : {})); }
    if (endpoint === 'reports.export') { shape(p, ['requestId','reportIds','includeEvidence','expectedRevisions']); this.requireReports(scope); const exp = {}; for (const id of array(p.reportIds, 'reportIds', 100)) Object.assign(exp, expected('tree_reports', id, p.expectedRevisions[id])); return this.reports.export(command({ reportIds: p.reportIds, includeEvidence: p.includeEvidence }, exp), context.actor); }
    fail('ENDPOINT_NOT_FOUND', 'Unknown tree mutation', 404);
  }
  editItem(command, item, old, actor) {
    if (item.lifecycle !== 'active') fail('VERSION_CONFLICT', 'Only active content may be edited; unfinished drafts can be withdrawn');
    text(command.input.reason, 'reason'); const replacement = command.input.replacement;
    if (item.kind === 'understanding') text(replacement, 'understanding', 2000);
    else if (item.kind === 'supplement') validateShort(replacement);
    else { shape(replacement, ['short', 'long']); if (!replacement.short && !replacement.long) fail('TEXT_REQUIRED', 'A method needs text'); if (replacement.short) validateShort(replacement.short); if (replacement.long) validateLong(replacement.long); }
    return this.repo.command('editTreeItem', command, actor, () => {
      const sourceRefs = item.stale ? old.sourceRefs.filter(ref => {
        const owners = this.repo.list('tree_turns', t => (t.experienceRefs ?? t.sourceRefs).some(r => digest(r) === digest(ref)));
        return !owners.length || owners.some(t => t.nodeIds.includes(item.nodeId) && t.status === 'settled');
      }) : old.sourceRefs;
      const version = old.version + 1, content = item.kind === 'method' ? { ...old.content, ...replacement, sourceRefs } : replacement;
      this.repo.save('tree_item_versions', { ...old, id: versionId(item.id, version), version, content, sourceRefs, sourceKind: 'user_expressed', reason: command.input.reason, supersedes: old.version, userEditRef: digest(['change', command.requestId]) });
      if (item.kind === 'method') {
        const bundle = this.repo.get('tree_methods', methodId(item.id, old.version)), hooks = bundle.hooks.map(ref => { const row = this.repo.get('tree_hooks', digest(['hook_version', ref.id, ref.version])); this.repo.save('tree_hooks', { ...row, enabled: false }, row.revision); this.repo.save('tree_hooks', { ...row, id: digest(['hook_version', ref.id, version]), version }); return { id: ref.id, version }; });
        this.repo.save('tree_methods', { ...bundle, id: methodId(item.id, version), version, ...replacement, hooks, evaluation: { status: 'unverified', windowId: null, evidenceIds: [] } });
      } else if (item.kind === 'supplement') { const bundle = this.repo.get('tree_supplements', digest(['supplement', item.id, old.version])); this.repo.save('tree_supplements', { ...bundle, id: digest(['supplement', item.id, version]), version, ...(item.stale ? { traitEvidence: bundle.traitEvidence.filter(ref => sourceRefs.some(r => digest(r) === digest(ref))) } : {}) }); }
      this.repo.save('tree_items', { ...item, activeVersion: version, validation: 'unverified', userProtected: true, producerRole: 'user', producerJobId: null,
        ...(item.stale ? { stale: false, staleReason: null, sourceReview: { ...item.sourceReview, status: 'resolved_by_user', userEditRef: digest(['change', command.requestId]) } } : {}) }, item.revision);
      for (const e of this.repo.list('tree_exposures', e => !e.revoked && e.itemVersions.some(v => v.itemId === item.id))) this.repo.save('tree_exposures', { ...e, revoked: true, invalidationReason: 'user_edit' }, e.revision);
      return { itemId: item.id, version };
    });
  }
  recordRepair(receipt, value) {
    const event = this.repo.get('tree_change_events', receipt.eventIds[0]), ref = { sessionId: 'arcfold-ui:' + this.repo.rootId(), seq: event.ordinal, sha256: digest(event) };
    const id = digest(['ui-repair', receipt.id]);
    this.repo.command('recordUserCorrectionObservation', { requestId: id, expected: {}, input: { receiptId: receipt.id, sourceRefs: [ref] } }, { kind: 'program', id: 'tree-ui' }, () => {
      this.repo.save('tree_repairs', { id, producerRole: value.producerRole, producerJobId: value.producerJobId, itemId: value.itemId ?? null, itemVersion: value.itemVersion ?? null, stage: 'generate', type: value.type, sourceSignalIds: [], nodeIds: value.nodeIds, reason: value.reason, requestId: receipt.requestId, evidenceRefs: [ref], countsAsError: value.eligible ? null : false, eligibleForDiagnosis: value.eligible, attribution: 'source_bound_observation' }); return { repairId: id };
    });
  }
  requireSubtree(id, scope) { for (const n of this.repo.list('tree_nodes', n => !n.deleted && this.repo.ancestors(n.id).some(a => a.id === id))) this.scoped(n.id, scope); }
  async previewDiffs(preview, snapshots, signal) {
    const scan = await snapshots.io.scan({ copy: true, signal });
    const render = bytes => bytes === null ? null : { sha256: contentHash(bytes), size: bytes.length, binary: bytes.includes(0), truncated: bytes.length > 65536, text: bytes.includes(0) ? null : bytes.subarray(0, 65536).toString('utf8') };
    return preview.changes.map(change => {
      const current = scan.manifest.files.find(f => f.path === change.path), fingerprint = current ? { sha256: current.sha256, mode: current.mode } : null;
      if (canonicalJson(fingerprint) !== canonicalJson(change.current)) fail('RESTORE_CONFLICT', 'Files changed while preparing the review');
      const target = change.target ? snapshots.git(['cat-file', 'blob', change.target.blob], undefined, true) : null;
      if (target && contentHash(target) !== change.target.sha256) fail('SNAPSHOT_HASH', 'Saved content changed');
      return { path: change.path, kind: change.kind, current: render(scan.contents.get(change.path) ?? null), restoreTo: render(target) };
    });
  }
}
const uniqueIds = values => [...new Set(values)];
