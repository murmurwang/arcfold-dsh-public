import { CONTRACT, canonicalJson, digest, fail, integer, jsonClone } from './contracts.mjs';
import { validateOutput } from './prompts.mjs';
import { compactLearningSource } from './experience.mjs';
import { TERMINAL_JOBS } from './jobs.mjs';

export class ConsolidationService {
  constructor({ repository, experience, contextBuilder, jobs }) { Object.assign(this, { repo: repository, experience, builder: contextBuilder, jobs }); }
  plan(nodeId, reason) {
    if (!['threshold', 'leave_timeout', 'node_leave', 'node_complete'].includes(reason)) fail('SUMMARY_TRIGGER', 'Unknown consolidation trigger');
    const node = this.builder.node(nodeId), turns = this.experience.turns(nodeId), session = this.repo.list('tree_learning_sessions', s => s.nodeId === nodeId)[0];
    // A hidden/revoked version still owns its immutable version number.
    const previous = node.currentSummaryId && this.repo.get('tree_summaries', node.currentSummaryId), threshold = reason === 'threshold', history = session?.history ?? [];
    const coveredJobs = threshold ? history.slice(0, -3) : history;
    const selected = threshold ? turns.filter(t => coveredJobs.some(h => h.turnId === t.id)) : turns;
    if (!selected.length) return null;
    const throughTurnIds = selected.map(t => t.id), assignmentVersions = Object.fromEntries(selected.map(t => [t.id, t.assignmentRevision]));
    if (!threshold && canonicalJson(previous?.throughTurnIds ?? []) === canonicalJson(throughTurnIds) && canonicalJson(previous?.assignmentVersions ?? {}) === canonicalJson(assignmentVersions)) return null;
    const material = selected.map(t => this.experience.material(t));
    if (material.some(m => m.revokedRefs.length)) fail('SUMMARY_SOURCE_REVOKED', 'Do not silently summarize missing original evidence');
    const sourceWatermark = digest([throughTurnIds, assignmentVersions, material.map(m => m.nativeHash)]);
    const learningRecords = coveredJobs.map(entry => {
      const job = this.jobs.get(entry.jobId), input = jsonClone(job.input); delete input.epochSeed;
      if (job.status !== 'committed') fail('SUMMARY_LEARNING_RECEIPT', 'Only committed learning can enter a stable summary');
      const turn = job.trigger.turnId && this.repo.get('tree_turns', job.trigger.turnId);
      if (job.invalidated || turn && !turn.nodeIds.includes(nodeId) || job.input.sources.some(s => !this.experience.sources.resolve(s.ref))) return { jobId: job.id, invalidated: true, reason: '来源已撤回或归属已纠正；旧输入和输出不再作为本节点整理依据。', inputHash: job.inputHash, resultHash: job.resultHash };
      return { jobId: job.id, input, output: job.validatedResult, receipt: job.resultRef, nativeLogRef: job.nativeLogRef, invalidated: job.invalidated === true };
    });
    return { nodeId, reason, throughTurnIds, assignmentVersions, material, sourceWatermark,
      learningRecords,
      previousSummaryId: previous?.id ?? null, previousVersion: previous?.version ?? null, nodeRevision: node.revision,
      coveredJobIds: coveredJobs.map(h => h.jobId), recentJobIds: history.slice(-3).map(h => h.jobId), contextEpoch: session?.contextEpoch ?? null };
  }
  freeze(plan) {
    const context = this.builder.build([plan.nodeId], 'consolidation'), own = this.builder.node(plan.nodeId);
    const siblings = this.repo.list('tree_nodes', n => !n.deleted && n.parentId === own.parentId && n.id !== own.id).map(n => n.id);
    const items = this.builder.activeItems([...new Set([...context.ancestorPaths.flat(), ...siblings])], 'consolidation');
    const sources = [...new Map(plan.material.flatMap(m => m.sources).map(s => [s.id, s])).values()];
    const knownItems = items.map(({ item, version, method }) => ({ id: item.id, version: item.activeVersion, nodeId: item.nodeId, kind: item.kind, sourceKind: version.sourceKind, userProtected: item.userProtected, content: method ? { short: method.short, long: method.long } : version.content }));
    const { material: _material, learningRecords, ...summaryPlan } = plan;
    const learningHistory = learningRecords.map(record => {
      if (!record.input) return record;
      const { sources: originalSources, ...input } = record.input;
      return { ...record, input: { ...input, sourceIds: originalSources.map(s => s.id) } };
    });
    const input = { inputVersion: CONTRACT, role: 'consolidation', scope: { nodeIds: [plan.nodeId], ancestorPaths: context.ancestorPaths, treeRevision: context.treeRevision }, sources, knownItems,
      allowedIds: { nodeIds: [...new Set(context.ancestorPaths.flat())], fileIds: [], subjectIds: [] }, trigger: { reason: plan.reason }, changeReceipts: [], summaryPlan, learningHistory, constraints: context.segments };
    const revisions = { [`tree_nodes:${plan.nodeId}`]: plan.nodeRevision };
    for (const turnId of plan.throughTurnIds) revisions[`tree_turns:${turnId}`] = this.repo.get('tree_turns', turnId).revision;
    for (const { item } of items) revisions[`tree_items:${item.id}`] = item.revision;
    return { input, revisions };
  }
  applyResult(result, { job, requestId }) {
    const output = validateOutput('consolidation', result, job.input), plan = job.input.summaryPlan, current = this.plan(plan.nodeId, plan.reason);
    if (!current || current.sourceWatermark !== plan.sourceWatermark || current.previousSummaryId !== plan.previousSummaryId) fail('JOB_STALE', 'Summary source assignment or previous version changed');
    const node = this.builder.node(plan.nodeId), version = (plan.previousVersion ?? 0) + 1, id = digest(['summary', node.id, version]);
    const sourceRefs = [...new Map(job.input.sources.map(s => [canonicalJson(s.ref), s.ref])).values()];
    return this.repo.command('commitTreeSummary', { requestId, expected: job.inputRevisionSet, input: { nodeId: node.id, jobId: job.id, sourceWatermark: plan.sourceWatermark, sourceRefs } }, { kind: 'model', id: job.id, role: 'consolidation' }, () => {
      const { oneLine, ...body } = output.summary;
      // setDown only marks that the goal may have been put down; the status
      // stays as it is until the user says so.
      const setDown = ['node_leave', 'leave_timeout'].includes(plan.reason) && output.setDown ? { reason: output.setDown.reason, sourceIds: output.setDown.sourceIds } : null;
      this.repo.save('tree_summaries', { id, nodeId: node.id, version, oneLine, body, throughTurnIds: plan.throughTurnIds, sourceRefs, previousVersion: plan.previousVersion,
        sourceWatermark: plan.sourceWatermark, assignmentVersions: plan.assignmentVersions, coveredJobIds: plan.coveredJobIds, recentJobIds: plan.recentJobIds, reason: plan.reason, jobId: job.id,
        ...(setDown ? { setDown } : {}) });
      this.repo.save('tree_nodes', { ...node, currentSummaryId: id, lastSummaryWatermark: plan.sourceWatermark, summaryNameStale: false }, node.revision);
      // Broaden/retrospect remain versioned proposals for B5; this service never
      // silently grants them item/method activation authority.
      return { summaryId: id, version, nodeId: node.id, proposals: { broaden: output.broaden, retrospect: output.retrospect }, epochPending: plan.reason === 'threshold' };
    });
  }
  finishEpoch(jobId) {
    const job = this.jobs.get(jobId); if (job.status !== 'committed') fail('SUMMARY_NOT_COMMITTED', 'Only a committed durable summary can replace context');
    const plan = job.input.summaryPlan; if (plan.reason !== 'threshold') return null;
    const summary = this.repo.list('tree_summaries', s => s.jobId === jobId)[0];
    if (!summary || summary.sourceRefs.some(ref => !this.experience.sources.resolve(ref))) fail('SUMMARY_SOURCE_REVOKED', 'Summary evidence is no longer current');
    const session = this.repo.list('tree_learning_sessions', s => s.nodeId === plan.nodeId)[0];
    if (session?.summaryId === summary.id && session.contextEpoch === plan.contextEpoch + 1) return session;
    if (session?.contextEpoch !== plan.contextEpoch) fail('JOB_STALE', 'A different learning epoch already advanced');
    return this.jobs.replaceEpoch(plan.nodeId, { summaryId: summary.id, summaryHash: digest(summary), sourceWatermark: summary.sourceWatermark, recentJobIds: plan.recentJobIds });
  }
  learningSeed(nodeId) {
    const session = this.repo.list('tree_learning_sessions', s => s.nodeId === nodeId)[0];
    if (!session || session.contextEpoch === 1 || session.appendSeq > 0) return null;
    const summary = this.repo.get('tree_summaries', session.summaryId);
    if (!summary || digest(summary) !== session.summaryHash || !this.builder.summary({ ...this.builder.node(nodeId), currentSummaryId: summary.id })) fail('EPOCH_COVERAGE', 'The new epoch requires its exact verified summary');
    const recent = session.recentJobIds.map(id => {
      const job = this.jobs.get(id); if (job.status !== 'committed' || job.invalidated || job.nodeIds[0] !== nodeId || job.input.sources.some(s => !this.experience.sources.resolve(s.ref))) fail('EPOCH_COVERAGE', 'Recent learning receipt or source is no longer valid');
      const input = jsonClone(job.input); delete input.epochSeed; input.sources = input.sources.map(compactLearningSource);
      return { jobId: job.id, input, output: job.validatedResult, receipt: job.resultRef, nativeLogRef: job.nativeLogRef };
    });
    return { contextEpoch: session.contextEpoch, summary: { id: summary.id, version: summary.version, oneLine: summary.oneLine, body: summary.body, sourceWatermark: summary.sourceWatermark }, recent, constraints: this.builder.build([nodeId], 'learning').segments };
  }
  pressure({ fullRequest, measure, contextWindow, maxOutputTokens, estimated = false }) {
    if (estimated) {
      const reading = measure(fullRequest);
      if (reading?.kind !== 'estimated' || reading.inputHash !== digest(fullRequest) || !Number.isSafeInteger(reading.tokens) || reading.tokens < 0)
        fail('TOKEN_ESTIMATE_REQUIRED', 'Native learning requires a source-bound input estimate');
      // Unknown provider capacity cannot be advertised as an exact safe bound.
      // The native adapter still validates the actual request and reports errors.
      if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0 || !Number.isSafeInteger(maxOutputTokens))
        return { ...reading, limit: null, capacityStatus: 'unknown', needsSummary: false };
      const limit = Math.floor(Math.min(contextWindow * 0.7, contextWindow - maxOutputTokens - Math.min(8192, contextWindow * 0.1)));
      if (limit <= 0) fail('CONTEXT_CAPACITY', 'Model leaves no safe learning capacity');
      return { ...reading, limit, capacityStatus: 'estimated', needsSummary: reading.tokens > limit };
    }
    integer(contextWindow, 'model context window'); integer(maxOutputTokens, 'output tokens');
    const reading = measure(fullRequest);
    if (reading?.then || reading?.kind !== 'exact' || reading.inputHash !== digest(fullRequest) || !Number.isSafeInteger(reading.tokens) || reading.tokens < 0 || !reading.tokenizerIdentity) fail('EXACT_TOKEN_COUNT_REQUIRED', 'Full prompt/messages/tools need a source-bound exact count; the host character heuristic is not proof');
    const limit = Math.floor(Math.min(128000, contextWindow * 0.8, contextWindow - maxOutputTokens - 65536));
    if (limit <= 0) fail('CONTEXT_CAPACITY', 'Model leaves no safe learning capacity');
    return { tokens: reading.tokens, limit, needsSummary: reading.tokens > limit, tokenizerIdentity: reading.tokenizerIdentity, inputHash: reading.inputHash };
  }
  // A goal the conversation has moved away from is consolidated as soon as its
  // own learning has settled, instead of waiting for the idle timeout; a goal
  // renamed by main is consolidated again so its one line matches the name.
  // plan() returns nothing when the latest summary already covers the same
  // turns, so leaving or renaming twice over the same turns adds no job.
  departed() {
    // Runs on every worker scan, so turns, links and learning are indexed once
    // per scan instead of being listed again for every goal.
    const turns = this.repo.list('tree_turns'), byId = new Map(turns.map(t => [t.id, t])), own = new Map(), learning = new Set();
    for (const link of this.repo.list('tree_links', l => l.active)) { const t = byId.get(link.turnId); if (t?.status === 'settled') own.set(link.nodeId, [...(own.get(link.nodeId) ?? []), t]); }
    for (const job of this.repo.list('tree_jobs', j => (j.role === 'learning' || !j.role && j.kind === 'learning') && !TERMINAL_JOBS.includes(j.status))) for (const id of job.nodeIds ?? []) learning.add(id);
    const order = (a, b) => a.startedAt.localeCompare(b.startedAt) || a.sessionId.localeCompare(b.sessionId) || a.nativeTurn - b.nativeTurn || a.id.localeCompare(b.id);
    const result = [];
    for (const node of this.repo.list('tree_nodes', n => !n.deleted && n.status === 'active' && n.lastOwnTurnAt)) {
      const settled = own.get(node.id); if (!settled?.length) continue;
      const last = settled.sort(order).at(-1);
      const left = turns.some(t => t.sessionId === last.sessionId && t.nativeTurn > last.nativeTurn && t.status === 'settled' && !t.nodeIds.includes(node.id));
      if (!left && !node.summaryNameStale) continue;
      // Wait for this goal's running turn and learning: a summary frozen while
      // learning commits would go stale, and the same turns are not planned twice.
      if (learning.has(node.id) || turns.some(t => t.status === 'open' && t.nodeIds.includes(node.id) && t.startedAt > last.startedAt)) continue;
      try { const plan = this.plan(node.id, 'node_leave'); if (plan) result.push(plan); }
      // Learning of the last turns may still be running, or a source may be gone;
      // either way this goal waits and the others are still planned.
      catch (error) { if (!['SUMMARY_LEARNING_RECEIPT', 'SUMMARY_SOURCE_REVOKED'].includes(error.code)) throw error; }
    }
    return result;
  }
  due(at = this.repo.now()) {
    const now = Date.parse(at), result = [];
    for (const node of this.repo.list('tree_nodes', n => !n.deleted && n.lastOwnTurnAt)) {
      const timeout = this.builder.repo.ancestors(node.id).reverse().map(n => this.repo.get('tree_parameters', digest(['parameter', 'leaveTimeoutHours', n.id]))).find(Boolean)?.value ?? 24;
      if (now - Date.parse(node.lastOwnTurnAt) >= timeout * 3600000) { const plan = this.plan(node.id, 'leave_timeout'); if (plan) result.push(plan); }
    }
    return result;
  }
}
