import { CONTRACT, canonicalJson, digest, fail, jsonClone } from './contracts.mjs';
import { validateOutput, resolveSourceIds } from './prompts.mjs';
import { effectiveSignals, EpisodeSignals } from './signals.mjs';
import { itemInput } from './learning.mjs';
import { LocalReports } from './reports.mjs';

const unique = values => [...new Map(values.map(v => [canonicalJson(v), v])).values()];
const versionKey = (id, version) => digest(['item_version', id, version]);

export class VerificationService {
  constructor({ repository, experience, contextBuilder, jobs, modelConfig, clusters, writerRouter }) {
    Object.assign(this, { repo: repository, experience, builder: contextBuilder, jobs, config: modelConfig, clusters, writers: writerRouter }); this.resolveSource = contextBuilder.resolveSource; this.reports = new LocalReports({ repository, resolveSource: this.resolveSource });
  }
  exposureTurn(exposure) {
    const invocation = this.repo.get('tree_invocations', exposure.invocationId) ?? this.repo.list('tree_invocations', i => i.ledgerRequestId === exposure.invocationId)[0];
    if (!invocation || invocation.role !== 'main' || invocation.nativeSessionId !== exposure.modelSessionId) return null;
    return this.repo.list('tree_turns', t => t.sessionId === invocation.nativeSessionId && t.nativeTurn === invocation.nativeTurn && t.status === 'settled')[0] ?? null;
  }
  freeze(nodeId, { reason = 'window', summaryId = null, clusterIds = [], afterTurnId = null } = {}) {
    if (!['window', 'cluster', 'stagnation'].includes(reason)) fail('VERIFICATION_TRIGGER', 'Unsupported reflection trigger');
    const node = this.builder.node(nodeId);
    const clusterViews = clusterIds.map(id => { const row = this.repo.get('tree_clusters', id); if (!row || row.nodeId !== nodeId) fail('CLUSTER_SCOPE', 'Cluster must be reviewed at its common ancestor'); return this.clusters.freeze(row); });
    const clusterRefs = clusterViews.flatMap(c => c.episodes.flatMap(e => [...e.beforeRefs, ...e.reactionRefs, ...e.resolutionRefs]));
    const clusterTurns = this.repo.list('tree_turns', t => t.status === 'settled' && (t.experienceRefs ?? t.sourceRefs).some(r => clusterRefs.some(ref => digest(ref) === digest(r))));
    const ownTurns = [...new Map([...this.experience.turns(nodeId, { includeInterrupted: false }), ...clusterTurns].map(t => [t.id, t])).values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.sessionId.localeCompare(b.sessionId) || a.nativeTurn - b.nativeTurn);
    const start = afterTurnId === null ? 0 : ownTurns.findIndex(t => t.id === afterTurnId) + 1;
    if (afterTurnId !== null && start === 0) fail('WINDOW_BOUNDARY', 'Unknown prior window boundary');
    const turns = ownTurns.slice(start), ids = new Set(turns.map(t => t.id));
    const exposures = this.repo.list('tree_exposures', e => e.role === 'main').filter(e => { const turn = this.exposureTurn(e); return turn && ids.has(turn.id); });
    const signals = effectiveSignals(this.repo, this.resolveSource), allTurns = this.repo.list('tree_turns');
    const feedbackScopes = new Set([nodeId, ...clusterViews.flatMap(c => c.episodes.flatMap(e => e.nodeIds))]);
    const effects = turns.map(turn => {
      const material = this.experience.material(turn); if (material.revokedRefs.length) fail('SOURCE_CHANGED', 'Verification cannot silently omit withdrawn experience');
      const next = allTurns.filter(t => t.sessionId === turn.sessionId && t.nativeTurn > turn.nativeTurn).sort((a, b) => a.nativeTurn - b.nativeTurn)[0];
      const feedback = (next?.nodeIds.some(id => feedbackScopes.has(id)) ? next.userSourceRefs : []).map(this.resolveSource).filter(Boolean);
      const observations = exposures.filter(e => this.exposureTurn(e).id === turn.id);
      return { turnId: turn.id, assignmentRevision: turn.assignmentRevision, exposureIds: observations.map(e => e.id), itemVersions: unique(observations.flatMap(e => e.visibleItemVersions ?? e.itemVersions)),
        input: material.sources.filter(s => s.role === 'user' && s.origin === 'user'), answer: material.sources.filter(s => s.role === 'assistant' && s.origin === 'model'), feedback,
        signals: signals.filter(s => s.sourceRefs.some(ref => feedback.some(source => digest(ref) === digest(source.ref)))),
        uiActions: this.repo.list('tree_change_events', e => e.actor.kind === 'user' && e.entityIds.some(key => key === 'tree_turns:' + turn.id)) };
    });
    const summary = summaryId ? this.repo.get('tree_summaries', summaryId) : null;
    if (summaryId && (!summary || summary.nodeId !== nodeId)) fail('SUMMARY_SCOPE', 'Window needs its own exact summary');
    const before = summary?.previousVersion ? this.repo.get('tree_summaries', digest(['summary', nodeId, summary.previousVersion])) : null;
    const context = this.builder.build([nodeId], 'verification'), exposedIds = new Set(exposures.flatMap(e => e.itemVersions.map(v => v.itemId)));
    const reviewNodeIds = [...new Set([nodeId, ...clusterViews.flatMap(c => c.episodes.flatMap(e => e.nodeIds))])];
    const extraRows = clusterViews.length ? this.builder.activeItems([...new Set(exposures.flatMap(e => e.nodeIds))], 'verification').filter(r => exposedIds.has(r.item.id)) : [];
    const rows = [...new Map([...this.builder.activeItems(context.ancestorPaths.flat(), 'verification'), ...extraRows].filter(r => ['understanding', 'method'].includes(r.item.kind)).map(r => [r.item.id, r])).values()];
    const sources = unique([...effects.flatMap(e => [...e.input, ...e.answer, ...e.feedback]), ...clusterViews.flatMap(c => [...c.episodes, ...c.controls].flatMap(e => e.sources))]);
    const knownItems = rows.map(itemInput), trace = knownItems.map(item => ({ ...item, usedTurns: effects.filter(e => e.itemVersions.some(v => v.itemId === item.id && v.version === item.version)).map(e => e.turnId),
      expectation: item.method?.expectation ?? null, inputMode: item.method ? item.method.short ? 'short_rule' : exposures.some(e => e.methodReadVersions?.some(v => v.itemId === item.id && v.version === item.version)) ? 'full_method_read' : 'directory_only' : 'understanding',
      categoryCount: new Set(effects.filter(e => e.itemVersions.some(v => v.itemId === item.id && v.version === item.version)).flatMap(e => e.signals.filter(s => s.category === item.method?.expectation?.category).map(s => s.eventId))).size }));
    const window = { nodeId, reason, summaryId, summaryVersion: summary?.version ?? null, throughTurnIds: turns.map(t => t.id), effectsHash: digest(effects), clusterVersions: clusterViews.map(c => [c.id, c.revision]) };
    window.consolidationWindow = summary ? digest(['consolidation-window', nodeId, summary.sourceWatermark ?? [summary.throughTurnIds, summary.assignmentVersions]]) : null;
    const windowId = digest(['verification-window', window]);
    const input = { inputVersion: CONTRACT, role: 'verification', scope: { nodeIds: [nodeId], ancestorPaths: unique([...context.ancestorPaths, ...reviewNodeIds.map(id => this.repo.ancestors(id).map(n => n.id))]), treeRevision: context.treeRevision }, sources, knownItems,
      allowedIds: { nodeIds: [...new Set([...context.ancestorPaths.flat(), ...exposures.flatMap(e => e.nodeIds), ...knownItems.flatMap(i => i.originChain ?? [])])], subjectIds: knownItems.map(i => i.id), fileIds: [],
        opportunitySourceIds: unique(effects.filter(e => e.exposureIds.length).flatMap(e => e.input.map(s => s.id))), clusters: clusterViews.map(c => ({ id: c.id, version: c.revision })),
        nodeVersions: [{ id: nodeId, version: node.revision }], summaryVersions: summary ? [{ id: nodeId, version: summary.version }] : [] },
      changeReceipts: [], window: { ...window, id: windowId }, effects, trace, exposures, reviewNodeIds, clusters: clusterViews, summaryBefore: before, summaryAfter: summary,
      hookObservations: new EpisodeSignals({ repository: this.repo, resolveSource: this.resolveSource }).hookCandidates().filter(h => ids.has(h.logicalTurnId)),
      constraints: context.segments.filter(s => s.nodeId !== null) };
    const revisions = { ['tree_nodes:' + nodeId]: node.revision };
    for (const id of reviewNodeIds) revisions['tree_nodes:' + id] = this.repo.get('tree_nodes', id).revision;
    for (const turn of turns) revisions['tree_turns:' + turn.id] = turn.revision;
    for (const row of rows) revisions['tree_items:' + row.item.id] = row.item.revision;
    for (const row of exposures) revisions['tree_exposures:' + row.id] = row.revision;
    for (const row of clusterViews) revisions['tree_clusters:' + row.id] = row.revision;
    return { input, revisions };
  }
  enqueue(nodeId, options) {
    const frozen = this.freeze(nodeId, options), key = frozen.input.window.id;
    const existing = this.repo.get('tree_jobs', digest(['model_job', 'verification', key])); if (existing) return existing;
    return this.jobs.enqueue({ role: 'verification', key, nodeIds: [nodeId], input: frozen.input, revisionSet: frozen.revisions, config: this.config('verification', { parentJobId: options?.parentJobId, nodeIds: [nodeId] }), trigger: { kind: options?.reason ?? 'window', producerRole: 'program', windowId: key, ...(options?.parentJobId ? { parentJobId: options.parentJobId } : {}) } });
  }
  enqueueCorrection(intent) {
    const key = digest(['assignment-source-recheck', intent.id]);
    const existing = this.repo.get('tree_jobs', digest(['model_job', 'verification', key]));
    // A failed or unknown request remains this intent's owner. Never recreate
    // it with a newer prompt, model selection or item revision on restart.
    if (existing) return existing;
    const item = this.repo.get('tree_items', intent.input.itemId), turn = this.repo.get('tree_turns', intent.input.turnId);
    if (!item || item.lifecycle !== 'active' || !item.stale || item.staleReason !== 'assignment_corrected' || item.activeVersion !== intent.input.itemVersion ||
        turn?.assignmentRevision !== intent.input.assignmentRevision || turn.nodeIds.includes(item.nodeId)) fail('JOB_STALE', 'Correction target or assignment has changed');
    const version = this.repo.get('tree_item_versions', versionKey(item.id, item.activeVersion));
    const originalRefs = new Set(version.sourceRefs.map(canonicalJson));
    const turns = this.repo.list('tree_turns', t => (t.experienceRefs ?? t.sourceRefs).some(r => originalRefs.has(canonicalJson(r))));
    const retained = version.sourceRefs.filter(ref => {
      const owners = turns.filter(t => (t.experienceRefs ?? t.sourceRefs).some(r => canonicalJson(r) === canonicalJson(ref)));
      return !owners.length || owners.some(t => t.nodeIds.includes(item.nodeId) && t.status === 'settled');
    });
    const sources = unique(retained.map(ref => { const source = this.resolveSource(ref); if (!source) fail('SOURCE_CHANGED', 'A remaining source is unavailable'); return source; }));
    if (!sources.length) fail('RECHECK_EVIDENCE_MISSING', 'No remaining evidence can support a model recheck');
    const node = this.builder.node(item.nodeId), path = this.repo.ancestors(node.id).map(n => n.id);
    const known = itemInput({ item, version, method: item.kind === 'method' ? this.repo.get('tree_methods', digest(['method', item.id, item.activeVersion])) : null });
    // The old claim is the review target, not new evidence. Removed raw refs
    // stay in the historical version and never enter this frozen request.
    if (item.kind === 'method') { known.content = { ...known.content }; delete known.content.sourceRefs; }
    const supplement = item.kind === 'supplement' ? this.repo.get('tree_supplements', digest(['supplement', item.id, item.activeVersion])) : null;
    const input = { inputVersion: CONTRACT, role: 'verification', scope: { nodeIds: [node.id], ancestorPaths: [path], treeRevision: this.repo.meta().treeRevision },
      sources, knownItems: [known], allowedIds: { nodeIds: path, subjectIds: [item.id], fileIds: [], opportunitySourceIds: [], clusters: [], nodeVersions: [], summaryVersions: [] }, changeReceipts: [],
      sourceRecheck: { intentId: intent.id, itemId: item.id, itemVersion: item.activeVersion, removedSourceCount: version.sourceRefs.length - retained.length,
        ...(supplement ? { universalStopgap: supplement.universalStopgap, retainedTraitSourceIds: sources.filter(s => supplement.traitEvidence.some(ref => digest(ref) === digest(s.ref))).map(s => s.id) } : {}) },
      assignmentRevision: turn.assignmentRevision, exposures: [], effects: [], trace: [], reviewNodeIds: [node.id], clusters: [],
      window: { id: key, nodeId: node.id, reason: 'assignment_correction' } };
    const revisionSet = { ['tree_items:' + item.id]: item.revision, ['tree_nodes:' + node.id]: node.revision };
    for (const row of turns) revisionSet['tree_turns:' + row.id] = row.revision;
    return this.jobs.enqueue({ role: 'verification', key, nodeIds: [node.id], input, revisionSet, config: this.config('verification', { turnId: turn.id, nodeIds: [node.id] }),
      trigger: { kind: 'assignment_correction', producerRole: 'program', intentId: intent.id, turnId: turn.id, assignmentRevision: turn.assignmentRevision } });
  }
  applyResult(result, { job, requestId }) {
    const output = validateOutput('verification', result, job.input);
    return this.repo.transaction(() => {
      this.jobs.assertCurrent(job);
      const report = this.reports.recordReview(output, { job, requestId: digest([requestId, 'report']) });
      if (job.input.sourceRecheck) {
        const intentId = job.input.sourceRecheck.intentId;
        this.repo.command('completeSourceRecheckReport', { requestId: digest([requestId, 'intent']), expected: {}, input: { intentId, jobId: job.id, reportId: report.reportId } },
          { kind: 'program', id: 'source-recheck' }, () => {
            const intent = this.repo.get('tree_jobs', intentId);
            if (!intent || intent.status !== 'queued') fail('JOB_STALE', 'Source recheck intent changed');
            this.repo.save('tree_jobs', { ...intent, status: 'committed', ownedJobId: job.id, reportId: report.reportId }, intent.revision);
            return { intentId, reportId: report.reportId };
          });
      }
      return { reportId: report.reportId, reportOnly: true };
    });
  }
}

/** B3 owns summaries; B5 applies its already-validated relocation/proposals. */
export class ConsolidationReflection {
  constructor({ repository, consolidation, resolveSource, writerRouter }) { Object.assign(this, { repo: repository, consolidation, resolveSource, writers: writerRouter }); }
  applyResult(result, context) {
    const { job } = context;
    const output = validateOutput('consolidation', result, job.input);
    if (job.trigger.reason === 'node_complete' && this.repo.get('tree_nodes', job.nodeIds[0]).status !== 'completed') fail('JOB_STALE', 'Node is no longer completed');
    // Consolidation maintains the experience summary; proposed learning and
    // promotion remain visible in the job output and are not applied.
    const summary = this.consolidation.applyResult(output, context);
    return { ...summary.result, moved: [], retrospect: { status: 'report_only' } };
  }
}
