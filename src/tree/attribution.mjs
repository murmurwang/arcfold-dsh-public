import { CONTRACT, canonicalJson, digest, fail } from './contracts.mjs';
import { TreeService } from './tree.mjs';

export class AttributionService {
  constructor({ repository, sources, contextBuilder, jobs, modelOwner, modelConfig, cancelJob, timers = { setTimeout, clearTimeout } }) {
    Object.assign(this, { repo: repository, sources, builder: contextBuilder, jobs, owner: modelOwner, modelConfig, cancelJob, timers }); this.pending = new Map();
  }
  existing(sessionId, nativeTurn) { return this.repo.get('tree_turns', digest(['turn', sessionId, nativeTurn])); }
  selection(sessionId) { return this.repo.meta().attributionSelections?.[sessionId] ?? { nodeId: null, revision: 0 }; }
  candidateNodes(at = this.repo.now(), branchId = null) {
    const service = new TreeService({ repository: this.repo, context: () => ({ actor: { kind: 'program', id: 'tree-attribution' } }) });
    const now = Date.parse(at);
    const rows = this.repo.list('tree_nodes', n => !n.deleted).filter(node => {
      if (branchId && !this.repo.ancestors(node.id).some(n => n.id === branchId)) return false;
      if (node.id === branchId || node.pinned === true || ['active', 'paused'].includes(node.status)) return true;
      const owner = node.statusOrigin === 'cascade' && node.cascadeFromId ? this.repo.get('tree_nodes', node.cascadeFromId) : node;
      return now - Date.parse(owner.statusChangedAt ?? owner.updatedAt) <= service.parameter('retentionDays', owner.id) * 86400000;
    }).sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true) || a.id.localeCompare(b.id));
    return rows;
  }
  capacity(sessionId) {
    const selection = this.selection(sessionId), selected = selection.nodeId && this.repo.get('tree_nodes', selection.nodeId);
    const selectionMissing = Boolean(selection.nodeId && (!selected || selected.deleted));
    const totalCount = this.candidateNodes().length, count = selection.nodeId ? selectionMissing ? 0 : this.candidateNodes(this.repo.now(), selection.nodeId).length : totalCount;
    return { limit: 2000, totalCount, count, selection, selectionMissing, blocked: selectionMissing || count > 2000,
      path: selected && !selected.deleted ? this.repo.ancestors(selected.id).map(n => ({ id: n.id, name: n.name })) : [],
      pending: Object.values(this.repo.meta().attributionPending ?? {}).filter(p => p.sessionId === sessionId && p.state !== 'consumed').map(p => ({ id: p.id, state: p.state, revision: p.revision, text: p.preview, nativeTurn: p.nativeTurn })) };
  }
  candidates(at = this.repo.now(), sessionId = null) {
    const selection = this.selection(sessionId);
    if (selection.nodeId && (!this.repo.get('tree_nodes', selection.nodeId) || this.repo.get('tree_nodes', selection.nodeId).deleted)) fail('CANDIDATE_CAPACITY', '选定的目标已不存在，请重新选择一支目标后继续。');
    const rows = this.candidateNodes(at, selection.nodeId);
    if (rows.length > 2000) fail('CANDIDATE_CAPACITY', `当前范围有${rows.length}个候选，超过2000个；请选择一支更小的目标后继续，尚未调用模型。`);
    return rows.map(node => ({ id: node.id, name: node.name, status: node.status, statusOrigin: node.statusOrigin, path: this.repo.ancestors(node.id).map(n => ({ id: n.id, name: n.name })), oneLine: this.builder.summary(node)?.oneLine ?? '', revision: node.revision }));
  }
  freeze(sessionId, nativeTurn, messages) {
    const userSources = this.sources.claimed(sessionId, messages); if (!userSources.length) fail('PROGRAM_NOT_USER', 'Only a new actual human batch needs attribution');
    const prior = this.repo.list('tree_turns', t => t.sessionId === sessionId && t.nativeTurn < nativeTurn).sort((a, b) => b.nativeTurn - a.nativeTurn)[0];
    const selection = this.selection(sessionId), candidates = this.candidates(this.repo.now(), sessionId), candidateIds = new Set(candidates.map(n => n.id));
    const previousNodeIds = (prior?.nodeIds ?? [selection.nodeId ?? this.repo.rootId()]).filter(id => candidateIds.has(id)), scopeNodes = previousNodeIds.length ? previousNodeIds : [selection.nodeId ?? this.repo.rootId()];
    const context = this.builder.build(scopeNodes, 'attribution');
    // The explicit branch is the complete discovery range for this judgement.
    // Ancestor knowledge is inherited, but the global discovery list is omitted.
    if (selection.nodeId) context.segments = context.segments.filter(s => s.key !== 'global-overview');
    const priorAnswer = prior ? this.sources.turn(sessionId, prior.nativeTurn).sources.filter(s => s.origin === 'model' && this.sources.resolve(s.ref)).at(-1) : null;
    const sources = [...userSources, ...(priorAnswer ? [priorAnswer] : [])], knownItems = this.builder.activeItems(context.ancestorPaths.flat(), 'attribution').map(({ item }) => ({ id: item.id, version: item.activeVersion, nodeId: item.nodeId, kind: item.kind, userProtected: item.userProtected }));
    // Candidate node revisions also change when an unrelated turn is linked.
    // Recheck the actual candidate fields atomically at commit instead of
    // rejecting a correct judgment on every unrelated bookkeeping update.
    const revisions = {};
    for (const i of knownItems) revisions[`tree_items:${i.id}`] = this.repo.get('tree_items', i.id).revision;
    return { input: { inputVersion: CONTRACT, role: 'attribution', scope: { nodeIds: scopeNodes, ancestorPaths: context.ancestorPaths, treeRevision: context.treeRevision }, sources, knownItems,
      allowedIds: { nodeIds: candidates.map(n => n.id), fileIds: [], subjectIds: [] }, changeReceipts: [], candidates,
      context: context.segments, currentTurn: { sessionId, nativeTurn, userSourceIds: userSources.map(s => s.id), selectionRevision: selection.revision, selectedBranchId: selection.nodeId } }, revisions, scopeNodes };
  }
  applyResult(result, { job, requestId }) {
    const input = job.input, { sessionId, nativeTurn, userSourceIds } = input.currentTurn;
    const old = this.existing(sessionId, nativeTurn);
    if (old) fail('JOB_STALE', 'This turn was already assigned, corrected or routed by a deadline fallback');
    if (this.selection(sessionId).revision !== (input.currentTurn.selectionRevision ?? 0)) fail('JOB_STALE', '用户已改变本聊天的目标范围，本次旧判断不再采用');
    if (input.currentTurn.selectedBranchId && input.currentTurn.selectedBranchId !== this.repo.rootId() && result.actions.some(a => a.action === 'create')) fail('ATTRIBUTION_RANGE', '选定分支时只能在候选父目标下创建子目标，不能在范围外新建');
    return this.repo.transaction(() => {
      if (this.existing(sessionId, nativeTurn) || this.selection(sessionId).revision !== (input.currentTurn.selectionRevision ?? 0)) fail('JOB_STALE', 'Turn or selected branch changed while the model ran');
      const current = this.candidates(this.repo.now(), sessionId);
      const meaning = candidates => candidates.map(({ revision: _revision, ...candidate }) => candidate);
      if (canonicalJson(meaning(current)) !== canonicalJson(meaning(input.candidates))) fail('JOB_STALE', 'Attribution candidate information changed while the model ran');
      const expected = { ...job.inputRevisionSet, ...Object.fromEntries(current.map(n => [`tree_nodes:${n.id}`, n.revision])) };
      const resolve = id => { const source = input.sources.find(s => s.id === id); if (!source || !this.sources.resolve(source.ref)) fail('JOB_STALE', 'Attribution source changed'); return source.ref; };
      const refs = userSourceIds.map(resolve), tree = new TreeService({ repository: this.repo, resolveSource: ref => this.sources.resolve(ref), context: () => ({ actor: { kind: 'model', id: job.id, role: 'attribution' }, nodeIds: input.scope.nodeIds, candidateNodeIds: input.allowedIds.nodeIds }) });
      return tree.applyAttribution({ requestId, expected, input: { sessionId, nativeTurn, userSourceRefs: refs, sourceRefs: refs,
        actions: result.actions, statusChanges: result.statusChanges.map(s => ({ nodeId: s.nodeId, status: s.status, sourceRefs: [resolve(s.sourceId)] })), attributionRunId: job.id } });
    });
  }
  fallback(sessionId, nativeTurn, messages, reason, runId = null) {
    const old = this.existing(sessionId, nativeTurn); if (old) return old;
    const refs = this.sources.claimed(sessionId, messages).map(s => s.ref); if (!refs.length) fail('PROGRAM_NOT_USER', 'No human original to route');
    const tree = new TreeService({ repository: this.repo, resolveSource: ref => this.sources.resolve(ref), context: () => ({ actor: { kind: 'program', id: 'tree-attribution' } }) });
    const branchId = this.selection(sessionId).nodeId;
    tree.applyAttribution({ requestId: digest(['attribution-fallback', sessionId, nativeTurn]), expected: {}, input: { sessionId, nativeTurn, userSourceRefs: refs, sourceRefs: refs, actions: branchId ? [{ action: 'continue', nodeId: branchId }] : [], statusChanges: [], failure: reason.slice(0, 2000), attributionRunId: runId } });
    return this.existing(sessionId, nativeTurn);
  }
  attribute(request) {
    const key = digest([request.sessionId, request.nativeTurn]); if (this.pending.has(key)) return this.pending.get(key);
    const promise = this.#attribute(request); this.pending.set(key, promise); void promise.finally(() => this.pending.delete(key)).catch(() => {}); return promise;
  }
  cancelPending(jobId, reason) {
    const current = this.jobs.get(jobId);
    if (['queued', 'prepared', 'submitted', 'validated'].includes(current.status)) this.jobs.transition(jobId, 'cancelled', { cancellationReason: reason });
    if (['committed', 'cancelled', 'failed', 'stale', 'unknown'].includes(current.status)) return;
    const result = this.cancelJob(jobId);
    if (result?.then) { void Promise.resolve(result).catch(() => {}); fail('CANCELLATION_REQUIRED', 'Cancellation callback must be synchronous'); }
  }
  async #attribute({ sessionId, nativeTurn, messages, signal, agent, modelSelection }) {
    signal?.throwIfAborted(); const old = this.existing(sessionId, nativeTurn); if (old) return old;
    if (!messages.some(m => m.source?.kind === 'user')) return null;
    if (typeof this.cancelJob !== 'function') fail('CANCELLATION_REQUIRED', 'Attribution needs an owned synchronous cancellation callback');
    let job, timer, abort;
    try {
      const frozen = this.freeze(sessionId, nativeTurn, messages);
      job = this.jobs.enqueue({ role: 'attribution', key: `${sessionId}:${nativeTurn}`, nodeIds: frozen.scopeNodes, input: frozen.input, revisionSet: frozen.revisions,
        config: this.modelConfig(agent, modelSelection), trigger: { kind: 'human_input', producerRole: 'user', origin: 'user', nativeSessionId: sessionId, nativeTurn, ordinal: this.repo.meta().lastEventOrdinal } });
      const cancelled = new Promise((_, reject) => {
        const stop = code => {
          try { this.cancelPending(job.id, code); } catch (error) { reject(error); return; }
          reject(Object.assign(new Error(code), { code }));
        };
        timer = this.timers.setTimeout(() => stop('ATTRIBUTION_DEADLINE'), 60000); abort = () => stop('ATTRIBUTION_ABORTED'); signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
      await Promise.race([this.owner.run(job.id), cancelled]); signal?.throwIfAborted();
      const turn = this.existing(sessionId, nativeTurn); if (turn) return turn;
      const result = this.jobs.get(job.id); this.cancelPending(job.id, 'ATTRIBUTION_UNAVAILABLE');
      return this.fallback(sessionId, nativeTurn, messages, `Attribution ${result.status}: ${canonicalJson(result.error ?? {})}`, job.id);
    } catch (error) {
      if (job) { try { this.cancelPending(job.id, error.code ?? 'ATTRIBUTION_UNAVAILABLE'); } catch (cancelError) { error = cancelError; } }
      if (signal?.aborted || ['ATTRIBUTION_ABORTED', 'CANDIDATE_CAPACITY'].includes(error.code)) throw error;
      return this.fallback(sessionId, nativeTurn, messages, `${error.code ?? 'ATTRIBUTION_UNAVAILABLE'}: ${error.message}`, job?.id ?? null);
    } finally { if (timer !== undefined) this.timers.clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); }
  }
}
