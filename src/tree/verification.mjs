import { CONTRACT, canonicalJson, digest, fail, jsonClone } from './contracts.mjs';
import { ItemService } from './items.mjs';
import { validateOutput, resolveSourceIds, consolidationReason, RETROSPECT_REASONS } from './prompts.mjs';
import { effectiveSignals, EpisodeSignals } from './signals.mjs';
import { itemInput, proposalInput } from './learning.mjs';
import { LocalReports } from './reports.mjs';

const unique = values => [...new Map(values.map(v => [canonicalJson(v), v])).values()];
const versionKey = (id, version) => digest(['item_version', id, version]);
// Prompt versions frozen into jobs by 0.5.x, when review roles only reported.
// A job keeps the meaning it was frozen with, so these still only report.
export const REPORT_ONLY_PROMPTS = Object.freeze(['arcfold.tree.consolidation/4.0.0', 'arcfold.tree.verification/4.0.0', 'arcfold.tree.improvement/4.0.0']);

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
  applyCorrection(output, { job, requestId }) {
    return this.repo.transaction(() => {
      this.jobs.assertCurrent(job);
      const invocation = job.invocationIds.map(id => this.repo.get('tree_invocations', id)).find(i => i?.jobId === job.id && i.role === 'verification' && i.inputHash === job.inputHash && i.state === 'result_received');
      if (!invocation) fail('EXPOSURE_REQUIRED', 'Source review requires its actual completed reader invocation');
      const target = job.input.sourceRecheck, exposureId = digest(['source-recheck-exposure', job.id]);
      const actor = { kind: 'model', id: job.id, role: 'verification' };
      this.repo.command('recordSourceRecheckExposure', { requestId: digest([requestId, 'exposure']), expected: {}, input: { jobId: job.id, invocationId: invocation.id } }, { kind: 'program', id: 'source-recheck' }, () => {
        this.repo.save('tree_exposures', { id: exposureId, kind: 'source_recheck', role: 'verification', invocationId: invocation.id, modelSessionId: job.nativeSessionId,
          nodeIds: job.nodeIds, itemVersions: [{ itemId: target.itemId, version: target.itemVersion }], summaryVersions: [], renderedHash: job.inputHash,
          treeRevision: job.input.scope.treeRevision, boundaryIndex: invocation.stepStartSeq, inputHash: job.inputHash, requestHash: invocation.requestHash, revoked: false });
        return { exposureId };
      });
      const service = new ItemService({ repository: this.repo, resolveSource: this.resolveSource, context: () => ({ actor, nodeIds: job.nodeIds, sourceRecheck: { jobId: job.id, exposureId } }) });
      const op = output.operations[0], probe = output.probes[0];
      const action = op ?? probe;
      const replacement = op?.op === 'rewrite' ? job.input.knownItems[0].kind === 'method' ? proposalInput({ methods: [op.detail.replacement] }, job.input).methods[0] : op.detail.replacement.content : undefined;
      const receipt = service.recheckSources({ requestId: digest([requestId, 'source-review']), expected: job.inputRevisionSet, input: {
        itemId: target.itemId, version: target.itemVersion, operation: op?.op ?? 'probe', reason: op?.reason ?? probe.what,
        sourceRefs: resolveSourceIds(action.evidence, job.input), ...(replacement === undefined ? {} : { replacement }),
      } }).result;
      this.repo.command('completeSourceRecheckIntent', { requestId: digest([requestId, 'intent']), expected: {}, input: { intentId: target.intentId, jobId: job.id } }, { kind: 'program', id: 'source-recheck' }, () => {
        const intent = this.repo.get('tree_jobs', target.intentId);
        this.repo.save('tree_jobs', { ...intent, status: 'committed', ownedJobId: job.id }, intent.revision); return { intentId: intent.id };
      });
      return { sourceRecheck: receipt };
    });
  }
  reportOnly(result, { job, requestId }) {
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
  applyResult(result, { job, requestId }) {
    if (REPORT_ONLY_PROMPTS.includes(job.prompt.version)) return this.reportOnly(result, { job, requestId });
    const output = validateOutput('verification', result, job.input), input = job.input, nodeId = job.nodeIds[0];
    if (input.sourceRecheck) return this.applyCorrection(output, { job, requestId });
    const refs = ids => resolveSourceIds(ids, input), actor = { kind: 'model', id: job.id, role: 'verification' };
    for (const fix of output.formatFixes.filter(f => ['understanding', 'method'].includes(f.target))) {
      output.operations.push({ op: 'rewrite', targetId: fix.id, targetVersion: fix.version, stage: 'generate', reason: fix.reason, evidence: fix.sourceIds, detail: { replacement: fix.fixed } });
    }
    const exactExposure = (id, version) => input.exposures.find(e => !e.revoked && e.itemVersions.some(v => v.itemId === id && v.version === version));
    const evidenceFor = (id, version, evidence) => {
      const eligible = input.effects.filter(e => e.itemVersions.some(v => v.itemId === id && v.version === version)).flatMap(e => e.input.map(s => s.id));
      return [...new Set(evidence.filter(id => eligible.includes(id)))];
    };
    // Frozen-input admission rules are shared with the native reader validator.
    return this.repo.transaction(() => {
      this.jobs.assertCurrent(job);
      // Validate the complete frozen read set before the first mutation. There
      // is no await inside this transaction, so only this batch can retire it.
      for (const e of input.exposures) if (digest(this.repo.get('tree_exposures', e.id)) !== digest(e)) fail('JOB_STALE', 'Actual exposure changed before batch commit');
      const frozenExposures = new Map(input.exposures.filter(e => !e.revoked).map(e => [e.id, e]));
      const service = new ItemService({ repository: this.repo, resolveSource: this.resolveSource, context: () => ({ actor, nodeIds: input.reviewNodeIds, reviewExposure: id => frozenExposures.get(id) }) });
      const outcomes = [], repaired = [], diagnostics = [];
      const actions = [...output.operations];
      for (const evaluation of output.verifications) if (!actions.some(o => o.targetId === evaluation.methodId)) actions.push({ op: 'support', targetId: evaluation.methodId, targetVersion: evaluation.methodVersion, stage: 'none', reason: evaluation.observed || '本窗口检验', evidence: evaluation.evidence, detail: {} });
      for (const [index, op] of actions.entries()) {
        const original = this.repo.get('tree_items', op.targetId), evaluation = output.verifications.find(v => v.methodId === original.id), exposure = exactExposure(original.id, op.targetVersion);
        const opportunities = evaluation?.opportunityCount === 0 ? [] : evidenceFor(original.id, op.targetVersion, evaluation?.evidence ?? op.evidence), currentVersion = this.repo.get('tree_item_versions', versionKey(original.id, op.targetVersion));
        let operation = op.op, detail = op.detail, target = original, replacement;
        if (op.op === 'rewrite') replacement = original.kind === 'method' ? proposalInput({ methods: [op.detail.replacement] }, input).methods[0] : op.detail.replacement.content;
        if (op.op === 'harden') {
          const additions = detail.hooks.map((hook, hookIndex) => {
            if (hook.moment !== 'turn_end' || hook.action !== 'remind_user') return hook;
            diagnostics.push({ code: 'HARDEN_REMINDER_TO_CONTEXT', itemId: original.id, itemVersion: op.targetVersion, hookIndex });
            // End-of-turn tool and file conditions cannot be evaluated at the next user message.
            return { moment: 'user_message', action: 'add_context', conditions: [], message: hook.message };
          });
          replacement = { ...currentVersion.content, hooks: [...currentVersion.content.hooks, ...additions], scriptRequests: detail.scriptRequests };
        }
        if (op.op === 'merge') {
          target = this.repo.get('tree_items', detail.targetId); replacement = this.repo.get('tree_item_versions', versionKey(target.id, target.activeVersion)).content;
        }
        // Protected understanding reviews only attach evidence. The generic
        // support operation must not manufacture confirmation from a rebuttal.
        const evaluationResult = evaluation?.result ?? (original.kind === 'understanding' && !original.userProtected && op.op === 'support' && opportunities.length ? 'met' : 'unclear');
        const history = (original.evaluations ?? []).filter(e => e.version === op.targetVersion && e.consolidationWindow);
        const unclearWindows = new Set(); for (const e of history.toReversed()) { if (e.result !== 'unclear' || e.opportunityCount !== 0) break; unclearWindows.add(e.consolidationWindow); }
        const unclear = unclearWindows.size;
        const summaryWindow = input.window.reason === 'window' ? input.window.consolidationWindow : null;
        const already = summaryWindow && history.some(e => e.consolidationWindow === summaryWindow);
        if (evaluation && original.kind === 'method' && summaryWindow && !already && !original.userProtected && evaluationResult === 'unclear' && !opportunities.length && unclear >= 2 && operation === 'support') {
          operation = original.nodeId !== original.originNodeId ? 'demote' : 'withdraw'; detail = { toNodeId: original.originNodeId };
        }
        const commandInput = { itemId: target.id, version: target.activeVersion, exposureId: exposure.id, operation, reason: operation !== op.op ? '连续三个不同整理窗口没有适用机会' : op.reason,
          sourceRefs: refs(op.evidence), windowId: input.window.id, opportunityRefs: refs(opportunities), result: evaluationResult,
          ...(['move', 'promote', 'demote'].includes(operation) ? { toNodeId: detail.toNodeId } : {}),
          ...(['rewrite', 'harden', 'merge'].includes(operation) ? { replacement } : {}), ...(operation === 'merge' ? { mergeTargetId: original.id, mergeTargetVersion: original.activeVersion } : {}) };
        const expected = { ['tree_items:' + target.id]: target.revision, ...(operation === 'merge' ? { ['tree_items:' + original.id]: original.revision } : {}) };
        const applied = service.review({ requestId: digest([requestId, 'operation', index]), expected, input: commandInput }).result; outcomes.push(applied);
        this.repo.command('recordVerificationEvidence', { requestId: digest([requestId, 'evidence', index]), expected: {}, input: { itemId: original.id, operation, evaluation: evaluation ?? null } }, actor, () => {
          const item = this.repo.get('tree_items', target.id);
          this.repo.save('tree_items', { ...item, evaluations: [...(item.evaluations ?? []), { version: op.targetVersion, result: evaluationResult, opportunityCount: opportunities.length, sourceRefs: refs(op.evidence), windowId: input.window.id, consolidationWindow: summaryWindow, observed: evaluation?.observed ?? op.reason }] }, item.revision);
          if (!['support', 'mark_changed'].includes(operation) && op.stage !== 'none') {
            const id = digest([requestId, 'repair', index]);
            this.repo.save('tree_repairs', { id, producerRole: original.producerRole ?? 'learning', producerJobId: original.producerJobId ?? null, itemId: original.id, itemVersion: op.targetVersion, stage: op.stage, type: operation,
              sourceSignalIds: unique(input.effects.flatMap(e => e.signals.filter(s => s.sourceRefs.some(ref => refs(op.evidence).some(r => digest(r) === digest(ref)))).map(s => s.id))), nodeIds: [nodeId], reason: op.reason, requestId, evidenceRefs: refs(op.evidence), category: original.kind === 'method' ? currentVersion.content.expectedEffect.category : 'understanding', countsAsError: true }); repaired.push(id);
          }
          return { itemId: original.id };
        });
      }
      for (const [index, missed] of output.missed.entries()) this.repo.command('recordMissedLearning', { requestId: digest([requestId, 'missed', index]), expected: {}, input: missed }, actor, () => {
        const evidenceRefs = refs(missed.evidence), related = input.effects.filter(e => [...e.input, ...e.answer, ...e.feedback].some(s => missed.evidence.includes(s.id)));
        const producerJobs = this.repo.list('tree_jobs', j => j.role === 'learning' && j.status === 'committed' && related.some(e => e.turnId === j.trigger.turnId) && j.nodeIds.some(id => input.reviewNodeIds.includes(id)));
        const id = digest([requestId, 'missed-repair', index]);
        this.repo.save('tree_repairs', { id, producerRole: 'learning', producerJobId: producerJobs.length === 1 ? producerJobs[0].id : null, producerJobIds: producerJobs.map(j => j.id), stage: 'generate', type: 'missed', category: 'missed_learning', nodeIds: [...new Set(producerJobs.flatMap(j => j.nodeIds))], sourceSignalIds: [], reason: missed.what, evidenceRefs, requestId, countsAsError: producerJobs.length > 0, attribution: producerJobs.length ? 'bound_committed_producer' : 'unresolved' });
        repaired.push(id); return { repairId: id };
      });
      const { proposals } = this.applyProposals(output, job, requestId);
      proposals.push(...this.learnMissed(output.missed, job, requestId, service));
      const formatFixes = this.applyFormatFixes(output.formatFixes, job, requestId);
      for (const [index, probe] of output.probes.entries()) this.repo.command('recordVerificationProbe', { requestId: digest([requestId, 'probe', index]), expected: {}, input: probe }, actor, () => {
        const item = this.repo.get('tree_items', probe.itemId); if (item.lifecycle !== 'active' || item.activeVersion !== probe.itemVersion) fail('PROBE_STALE', 'Probe target was changed by this batch');
        this.repo.save('tree_items', { ...item, probe: { what: probe.what, evidenceRefs: refs(probe.evidence), version: item.activeVersion, windowId: input.window.id } }, item.revision); return { itemId: item.id };
      });
      return { windowId: input.window.id, operations: outcomes, repairs: repaired, proposals, formatFixes, missed: output.missed, probes: output.probes,
        ...(diagnostics.length ? { diagnostics } : {}) };
    });
  }
  learnMissed(missed, job, requestId, service) {
    if (!missed.length) return [];
    const { reviewNodeIds, sources } = job.input;
    const cited = new Set(missed.flatMap(gap => gap.evidence));
    const nodesByRef = new Map(sources.filter(source => cited.has(source.id)).map(source => [canonicalJson(source.ref), new Set()]));
    // Feedback on one effect belongs to the turn that actually contains the
    // source. Match its immutable reference, including sources from cluster controls.
    const links = this.repo.listByNodeIds('tree_links', reviewNodeIds, link => link.active);
    for (const turnId of new Set(links.map(link => link.turnId))) {
      const turn = this.repo.get('tree_turns', turnId);
      for (const ref of turn.experienceRefs ?? turn.sourceRefs) {
        const targets = nodesByRef.get(canonicalJson(ref));
        if (targets) {
          for (const id of turn.nodeIds) if (reviewNodeIds.includes(id)) targets.add(id);
        }
      }
    }
    const known = new Map(reviewNodeIds.map(id => [id, new Set()]));
    for (const { item, version } of this.builder.activeItems(reviewNodeIds)) {
      if (item.kind === 'understanding') known.get(item.nodeId).add(version.content);
    }
    const proposals = [];
    for (const [index, gap] of missed.entries()) {
      const evidence = sources.filter(source => gap.evidence.includes(source.id));
      const targets = new Set(evidence.flatMap(source => [...nodesByRef.get(canonicalJson(source.ref))]));
      if (!targets.size) targets.add(job.input.window.nodeId);
      const source = evidence.some(s => s.role === 'user' && s.origin === 'user') ? 'user_expressed' : 'assistant_inferred';
      const understanding = { content: gap.what, source, sourceIds: gap.evidence };
      const input = proposalInput({ understandings: [understanding] }, job.input);
      const pending = [...targets].filter(nodeId => !known.get(nodeId).has(gap.what));
      if (!pending.length) continue;
      let rejection;
      try {
        // A finding shared by several goals becomes visible on all of them together.
        const written = this.repo.transaction(() => pending.map(nodeId => {
          const key = digest([requestId, 'missed-understanding', index, nodeId]);
          const result = service.commitProposal({ requestId: key, expected: {}, input: { ...input, nodeId } }).result;
          const outcome = result.understandings;
          if (outcome.status === 'rejected') {
            rejection = { kind: 'missed_understanding', jobId: job.id, index, nodeId, code: outcome.code, message: outcome.reason };
            throw new Error(outcome.reason);
          }
          recordOrigins(this.repo, outcome.itemIds, job, digest([key, 'origin']));
          return { origin: 'missed', partition: 'understandings', result };
        }));
        proposals.push(...written);
        for (const nodeId of pending) known.get(nodeId).add(gap.what);
      } catch (error) {
        if (!rejection) throw error;
        const key = digest([requestId, 'missed-understanding-diagnostic', index]);
        this.repo.command('recordMissedUnderstandingDiagnostic', { requestId: key, expected: {}, input: rejection }, { kind: 'program', id: 'reflection' }, () => {
          const meta = this.repo.meta();
          this.repo.save('tree_meta', { ...meta, runtimeDiagnostics: { ...meta.runtimeDiagnostics, [key]: { ...rejection, at: this.repo.now() } } }, meta.revision);
          return rejection;
        });
      }
    }
    return proposals;
  }
  applyProposals(output, job, requestId) {
    const items = new ItemService({ repository: this.repo, resolveSource: this.resolveSource, context: () => ({ actor: { kind: 'model', id: job.id, role: 'verification' }, nodeIds: job.nodeIds }) });
    const idsByOrigin = new Map(), proposals = [];
    for (const [partition, values] of Object.entries(output.proposals)) for (const [index, value] of values.entries()) {
      const result = items.commitProposal({ requestId: digest([requestId, 'proposal', partition, index]), expected: {}, input: proposalInput({ [partition]: [value] }, job.input) }).result;
      const ids = result[partition].itemIds ?? []; proposals.push({ origin: value.origin, partition, result }); idsByOrigin.set(value.origin, [...(idsByOrigin.get(value.origin) ?? []), ...ids]);
      recordOrigins(this.repo, ids, job, digest([requestId, 'proposal-origin', partition, index]));
      if (partition === 'methods') for (const id of ids) { if (this.repo.get('tree_items', id).lifecycle === 'draft' && !this.writers) fail('WRITER_ROUTER_REQUIRED', 'Generated scripts need owned jobs'); this.writers?.enqueueDraft(id, job); }
    }
    for (const [index, verdict] of output.clusters.entries()) {
      const cluster = this.repo.get('tree_clusters', verdict.clusterId), methods = (idsByOrigin.get('cluster:' + verdict.clusterId) ?? []).filter(id => this.repo.get('tree_items', id).kind === 'method');
      const recurrenceEvaluation = output.verifications.find(v => cluster.previousMethodIds.includes(v.methodId) && v.result === 'not_met');
      const recurrence = recurrenceEvaluation ? { methodId: recurrenceEvaluation.methodId, methodVersion: recurrenceEvaluation.methodVersion, expectation: job.input.knownItems.find(i => i.id === recurrenceEvaluation.methodId).method.expectation } : null;
      if (recurrence && methods.length) fail('DUPLICATE_RECURRENCE_METHOD', 'A bound recurring failure must repair the original method instead of creating another');
      this.clusters.review(verdict, { job, requestId: digest([requestId, 'cluster', index]), methodIds: recurrence ? [recurrence.methodId] : methods, recurrence });
    }
    return { proposals };
  }
  applyFormatFixes(fixes, job, requestId) {
    return fixes.filter(f => ['name', 'summary'].includes(f.target)).map((fix, index) => {
      const node = this.repo.get('tree_nodes', fix.id), actor = { kind: 'model', id: job.id, role: 'verification' };
      if (!job.nodeIds.includes(node.id) || node.nameUserProtected && fix.target === 'name' || node.summaryUserProtected && fix.target === 'summary') fail('USER_PROTECTED', 'Only own unprotected generated content may receive format corrections');
      return this.repo.command('repairGeneratedFormat', { requestId: digest([requestId, 'format', index]), expected: {}, input: { ...fix, sourceRefs: resolveSourceIds(fix.sourceIds, job.input) } }, actor, () => {
        let changes;
        if (fix.target === 'name') changes = { name: fix.fixed };
        else {
          const old = this.repo.get('tree_summaries', node.currentSummaryId);
          if (!old || old.version !== fix.version || old.id !== job.input.summaryAfter?.id) fail('JOB_STALE', 'Summary changed before format correction');
          for (const decision of fix.fixed.decisions) if (decision.by === 'user' && !decision.sourceIds.some(id => job.input.sources.some(s => s.id === id && s.role === 'user' && s.origin === 'user'))) fail('USER_SOURCE_REQUIRED', 'Summary cannot turn an assistant proposal into a user decision');
          const version = old.version + 1, id = digest(['summary', node.id, version]), { oneLine, ...body } = fix.fixed;
          this.repo.save('tree_summaries', { ...old, id, version, oneLine, body, previousVersion: old.version, formatRepairJobId: job.id, formatRepairEvidence: resolveSourceIds(fix.sourceIds, job.input) }); changes = { currentSummaryId: id };
        }
        this.repo.save('tree_nodes', { ...node, ...changes }, node.revision);
        const id = digest([requestId, 'format-repair', index]); this.repo.save('tree_repairs', { id, producerRole: fix.target === 'name' ? 'attribution' : 'consolidation', stage: 'generate', type: 'format', sourceSignalIds: [], nodeIds: [node.id], reason: fix.reason, requestId, countsAsError: true, category: fix.target, evidenceRefs: resolveSourceIds(fix.sourceIds, job.input) });
        return { target: fix.target, nodeId: node.id, repairId: id, ...changes };
      }).result;
    });
  }
}

/** B3 owns summaries; B5 applies its already-validated relocation/proposals. */
export class ConsolidationReflection {
  constructor({ repository, consolidation, resolveSource, writerRouter }) { Object.assign(this, { repo: repository, consolidation, resolveSource, writers: writerRouter }); }
  applyResult(result, context) {
    const { job, requestId } = context, output = validateOutput('consolidation', result, job.input), nodeId = job.nodeIds[0], reason = consolidationReason(job.input);
    if (REPORT_ONLY_PROMPTS.includes(job.prompt.version)) {
      if (reason === 'node_complete' && this.repo.get('tree_nodes', nodeId).status !== 'completed') fail('JOB_STALE', 'Node is no longer completed');
      return { ...this.consolidation.applyResult(output, context).result, moved: [], retrospect: { status: 'report_only' } };
    }
    if (!RETROSPECT_REASONS.includes(reason) && (output.retrospect.understandings.length || output.retrospect.methods.length)) fail('RETROSPECT_TRIGGER', 'Retrospection requires completing or leaving the goal');
    if (reason === 'node_complete' && this.repo.get('tree_nodes', nodeId).status !== 'completed') fail('JOB_STALE', 'Node is no longer completed');
    return this.repo.transaction(() => {
      const summary = this.consolidation.applyResult(output, context), moved = [];
      for (const [index, proposal] of output.broaden.entries()) {
        const item = this.repo.get('tree_items', proposal.id);
        if (!item || item.nodeId !== nodeId || item.activeVersion !== proposal.version || item.kind !== proposal.kind || item.userProtected || item.lifecycle !== 'active') fail('JOB_STALE', 'Only this node’s current unprotected item can be broadened');
        const version = this.repo.get('tree_item_versions', versionKey(item.id, item.activeVersion));
        if (version.sourceKind === 'unknown' || version.sourceRefs.some(ref => !this.resolveSource(ref)) || !this.repo.ancestors(nodeId).some(n => n.id === proposal.toNodeId && n.id !== nodeId)) fail('PROMOTION_SCOPE', 'Promotion requires eligible evidence and an actual ancestor');
        this.repo.command('broadenLearnedItem', { requestId: digest([requestId, 'broaden', index]), expected: { ['tree_items:' + item.id]: item.revision }, input: { ...proposal, sourceRefs: resolveSourceIds(proposal.sourceIds, job.input) } }, { kind: 'model', id: job.id, role: 'consolidation' }, () => {
          this.repo.save('tree_items', { ...item, nodeId: proposal.toNodeId, validation: 'unverified', originChain: [...new Set([...(item.originChain ?? [item.originNodeId]), proposal.toNodeId])], promotionReason: proposal.reason }, item.revision);
          for (const h of this.repo.list('tree_hooks', h => h.methodId === item.id && h.enabled)) this.repo.save('tree_hooks', { ...h, scopeNodeId: proposal.toNodeId }, h.revision);
          for (const e of this.repo.list('tree_exposures', e => !e.revoked && e.itemVersions.some(v => v.itemId === item.id))) this.repo.save('tree_exposures', { ...e, revoked: true, invalidationReason: 'scope_broadened' }, e.revision);
          return { itemId: item.id, nodeId: proposal.toNodeId };
        }); moved.push(item.id);
      }
      // A completed node leaves the background of later work, so what its
      // completion teaches is kept one level up, where sibling work reads it.
      // A goal that was only left may be resumed, so it keeps what it taught.
      const targetId = reason === 'node_complete' ? this.repo.get('tree_nodes', nodeId).parentId ?? nodeId : nodeId;
      const service = new ItemService({ repository: this.repo, resolveSource: this.resolveSource, context: () => ({ actor: { kind: 'model', id: job.id, role: 'consolidation' }, nodeIds: [...new Set([nodeId, targetId])] }) });
      const proposals = service.commitProposal({ requestId: digest([requestId, 'retrospect']), expected: {}, input: { ...proposalInput(output.retrospect, job.input), nodeId: targetId } }).result;
      recordOrigins(this.repo, [...(proposals.understandings.itemIds ?? []), ...(proposals.methods.itemIds ?? [])], job, digest([requestId, 'retrospect-origin']));
      for (const id of proposals.methods.itemIds ?? []) { if (this.repo.get('tree_items', id).lifecycle === 'draft' && !this.writers) fail('WRITER_ROUTER_REQUIRED', 'Retrospective scripts require owned jobs'); this.writers?.enqueueDraft(id, job); }
      return { ...summary.result, moved, retrospect: proposals };
    });
  }
}

function recordOrigins(repo, ids, job, requestId) {
  return repo.command('recordReflectionOrigins', { requestId, expected: {}, input: { itemIds: ids, jobId: job.id } }, { kind: 'program', id: 'reflection' }, () => {
    for (const id of ids) { const item = repo.get('tree_items', id); repo.save('tree_items', { ...item, producerJobId: job.id, producerRole: job.role, producerWindowId: job.input.window?.id ?? null }, item.revision); }
    return { itemIds: ids };
  });
}
