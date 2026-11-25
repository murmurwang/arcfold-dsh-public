import { canonicalJson, digest, fail, CATEGORIES, integer, text } from './contracts.mjs';
import { effectiveSignals, signalPolarity } from './signals.mjs';

export const METRIC_VERSION = 'arcfold.observed-metrics/1';
const program = { kind: 'program', id: 'tree-metrics' };
const unique = values => [...new Map(values.map(v => [canonicalJson(v), v])).values()];
export function ratio(numerator, denominator) {
  if (!denominator) return { numerator, denominator, value: null, interval: null };
  const p = numerator / denominator, z = 1.95996398454, d = 1 + z * z / denominator, center = (p + z * z / (2 * denominator)) / d, margin = z * Math.sqrt(p * (1 - p) / denominator + z * z / (4 * denominator * denominator)) / d;
  return { numerator, denominator, value: p, interval: [Math.max(0, center - margin), Math.min(1, center + margin)], intervalMethod: 'Wilson95-descriptive-not-causal' };
}

export class MetricsService {
  constructor({ repository, experience, signals, readScope }) { Object.assign(this, { repo: repository, experience, signals, readScope }); this.resolveSource = signals.resolveSource; }
  ordinal(kind, id, { first = false } = {}) {
    if (this.readScope?.active) {
      return this.readScope.memo(this, () => {
        const rows = new Map();
        for (const event of this.repo.list('tree_change_events')) for (const [i, key] of event.entityIds.entries()) {
          if (event.entityIds.indexOf(key) !== i) continue;
          const row = rows.get(key) ?? { first: null, last: null };
          row.last = Math.max(row.last ?? event.ordinal, event.ordinal);
          if (event.beforeVersions[i] === 0) row.first = Math.min(row.first ?? event.ordinal, event.ordinal);
          rows.set(key, row);
        }
        return rows;
      }, index => {
        return index.get(kind + ':' + id)?.[first ? 'first' : 'last'] ?? 0;
      });
    }
    const values = this.repo.list('tree_change_events', e => e.entityIds.includes(kind + ':' + id) && (!first || e.beforeVersions[e.entityIds.indexOf(kind + ':' + id)] === 0)).map(e => e.ordinal);
    return values.length ? (first ? Math.min(...values) : Math.max(...values)) : 0;
  }
  turns(scopeNodeId = null) {
    return this.repo.list('tree_turns', t => t.status === 'settled' && (!scopeNodeId || t.nodeIds.includes(scopeNodeId))).map(t => ({ ...t, ordinal: this.ordinal('tree_turns', t.id, { first: true }) })).sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id));
  }
  proposal({ proposalRef, nodeIds, requestId, start = 0, end }) {
    const source = this.resolveSource(proposalRef); if (source?.role !== 'assistant' || source.origin !== 'model') fail('PROPOSAL_SOURCE', 'An actual assistant proposal source is required');
    end ??= source.text.length; integer(start, 'start', 0, source.text.length); integer(end, 'end', start + 1, source.text.length);
    const turn = this.repo.list('tree_turns', t => t.status === 'settled' && t.experienceRefs?.some(ref => digest(ref) === digest(proposalRef)))[0];
    if (!turn || !nodeIds.length || nodeIds.some(id => !turn.nodeIds.includes(id))) fail('PROPOSAL_SCOPE', 'A proposal must belong to the actual settled turn');
    const id = digest(['initiative-proposal', proposalRef, start, end]);
    return this.repo.command('recordInitiativeProposal', { requestId, expected: {}, input: { proposalRef, nodeIds, start, end } }, program, () => {
      const meta = this.repo.meta(), old = meta.proposals?.[id];
      if (!old || nodeIds.some(n => !old.nodeIds.includes(n))) this.repo.save('tree_meta', { ...meta, proposals: { ...meta.proposals, [id]: old ? { ...old, nodeIds: [...new Set([...old.nodeIds, ...nodeIds])] } : { id, proposalRef, start, end, nodeIds, turnId: turn.id, state: 'unknown', responseRefs: [], ordinal: meta.lastEventOrdinal + 1 } } }, meta.revision); return { proposalId: id };
    }).result;
  }
  respond({ proposalId, outcome, responseRefs, requestId }) {
    if (!['adopted', 'rejected', 'ignored', 'unknown'].includes(outcome)) fail('PROPOSAL_OUTCOME', 'Unknown proposal outcome');
    const proposal = this.repo.meta().proposals?.[proposalId]; if (!proposal) fail('PROPOSAL_NOT_FOUND', 'Proposal missing');
    if (outcome !== 'unknown' && !responseRefs.length || responseRefs.some(ref => { const s = this.resolveSource(ref); return s?.role !== 'user' || s.origin !== 'user'; })) fail('USER_SOURCE_REQUIRED', 'A known proposal outcome needs actual human response');
    for (const ref of responseRefs) this.responseTurn(proposal.turnId, proposal.nodeIds, ref);
    // Called only from trusted source-bound classification, not text matching.
    return this.repo.command('recordProposalOutcome', { requestId, expected: {}, input: { proposalId, outcome, sourceRefs: responseRefs } }, program, () => {
      const meta = this.repo.meta(), old = meta.proposals[proposalId];
      this.repo.save('tree_meta', { ...meta, proposals: { ...meta.proposals, [proposalId]: { ...old, state: outcome, responseRefs, history: [...(old.history ?? []), { outcome, responseRefs, ordinal: meta.lastEventOrdinal + 1 }] } } }, meta.revision); return { proposalId, outcome };
    }).result;
  }
  responseTurn(beforeTurnId, nodeIds, ref) {
    const before = this.repo.get('tree_turns', beforeTurnId), response = this.repo.list('tree_turns', t => t.status === 'settled' && t.userSourceRefs.some(r => digest(r) === digest(ref)))[0];
    if (!before || !response || !response.nodeIds.some(id => nodeIds.includes(id) && before.nodeIds.includes(id))) fail('PROPOSAL_SCOPE', 'Response belongs to another goal');
    if (this.ordinal('tree_turns', response.id, { first: true }) <= this.ordinal('tree_turns', before.id, { first: true })) fail('RESPONSE_ORDER', 'A response must follow the actual result');
    return response;
  }
  // The integration classifier must identify a task fragment explicitly. Broad
  // proceeded/redo labels alone cannot establish that this was a first attempt.
  fragment({ firstResultRef, nodeIds, fragmentKey, requestId, outputPaths = [], span }) {
    text(fragmentKey, 'fragmentKey', 256); const source = this.resolveSource(firstResultRef);
    const turn = this.repo.list('tree_turns', t => t.status === 'settled' && t.experienceRefs?.some(r => digest(r) === digest(firstResultRef)))[0];
    if (source?.role !== 'assistant' || source.origin !== 'model' || !turn || !nodeIds.length || nodeIds.some(id => !turn.nodeIds.includes(id))) fail('FRAGMENT_SOURCE', 'A fragment needs its actual first assistant result');
    if (span) { integer(span.start, 'start', 0, source.text.length); integer(span.end, 'end', span.start + 1, source.text.length); }
    if (!Array.isArray(outputPaths) || outputPaths.some(p => typeof p !== 'string' || !p || p.startsWith('/') || p.split('/').includes('..'))) fail('FRAGMENT_OUTPUTS', 'Output paths must be workspace-relative evidence from the trusted result classifier');
    const id = digest(['task-fragment', firstResultRef, fragmentKey]);
    return this.repo.command('recordTaskFragment', { requestId, expected: {}, input: { firstResultRef, nodeIds, fragmentKey, outputPaths, ...(span ? { span } : {}) } }, program, () => {
      const meta = this.repo.meta(), old = meta.taskFragments?.[id];
      if (!old || nodeIds.some(n => !old.nodeIds.includes(n))) this.repo.save('tree_meta', { ...meta, taskFragments: { ...meta.taskFragments, [id]: old ? { ...old, nodeIds: [...new Set([...old.nodeIds, ...nodeIds])] } : { id, firstResultRef, nodeIds, turnId: turn.id, fragmentKey, outputPaths, feedbackRefs: [], ...(span ? { span } : {}) } } }, meta.revision); return { fragmentId: id };
    }).result;
  }
  fragmentFeedback({ fragmentId, responseRefs, requestId, outcome }) {
    const fragment = this.repo.meta().taskFragments?.[fragmentId]; if (!fragment) fail('FRAGMENT_MISSING', 'Task fragment missing');
    if (!responseRefs.length) fail('USER_SOURCE_REQUIRED', 'Actual feedback is required');
    if (outcome !== undefined && !['proceeded', 'redo', 'unknown'].includes(outcome)) fail('FRAGMENT_OUTCOME', 'Unknown result feedback');
    for (const ref of responseRefs) { const s = this.resolveSource(ref); if (s?.role !== 'user' || s.origin !== 'user') fail('USER_SOURCE_REQUIRED', 'Actual human feedback required'); this.responseTurn(fragment.turnId, fragment.nodeIds, ref); }
    return this.repo.command('bindFragmentFeedback', { requestId, expected: {}, input: { fragmentId, responseRefs, ...(outcome === undefined ? {} : { outcome }) } }, program, () => {
      const meta = this.repo.meta(), old = meta.taskFragments[fragmentId]; this.repo.save('tree_meta', { ...meta, taskFragments: { ...meta.taskFragments, [fragmentId]: { ...old, feedbackRefs: unique([...old.feedbackRefs, ...responseRefs]),
        ...(outcome === undefined ? {} : { classifiedFeedback: [...(old.classifiedFeedback ?? []), { outcome, responseRefs, ordinal: meta.lastEventOrdinal + 1 }] }) } } }, meta.revision); return { fragmentId };
    }).result;
  }
  freeze(scopeNodeId = null, { afterOrdinal = 0, throughOrdinal = this.repo.meta().lastEventOrdinal } = {}) {
    integer(afterOrdinal, 'afterOrdinal', 0); integer(throughOrdinal, 'throughOrdinal', afterOrdinal);
    if (scopeNodeId && !this.repo.get('tree_nodes', scopeNodeId)) fail('NODE_NOT_FOUND', 'Metric scope missing');
    let turns = this.turns(scopeNodeId).filter(t => t.ordinal > afterOrdinal && t.ordinal <= throughOrdinal); if (!scopeNodeId && turns.length > 100) { turns = turns.slice(-100); afterOrdinal = Math.max(afterOrdinal, turns[0].ordinal - 1); }
    const turnIds = new Set(turns.map(t => t.id)), refs = unique(turns.flatMap(t => t.userSourceRefs)), validRefs = refs.filter(ref => { const s = this.resolveSource(ref); return s?.role === 'user' && s.origin === 'user'; });
    const messages = new Set(validRefs.map(digest)), signals = effectiveSignals(this.repo, this.resolveSource).filter(s => s.sourceRefs.some(ref => messages.has(digest(ref))));
    const categoryRefs = names => new Set(signals.filter(s => names.includes(s.category)).flatMap(s => s.sourceRefs.filter(r => messages.has(digest(r))).map(digest)));
    const counts = Object.fromEntries(CATEGORIES.map(name => [name, categoryRefs([name]).size]));
    const negative = categoryRefs(CATEGORIES.filter(c => signalPolarity(c) === 'negative'));
    const fragments = Object.values(this.repo.meta().taskFragments ?? {}).filter(f => (!scopeNodeId || f.nodeIds.includes(scopeNodeId)) && this.resolveSource(f.firstResultRef));
    const restores = Object.values(this.repo.meta().restoreIntents ?? {}).filter(r => r.state === 'completed' && r.changes?.length).flatMap(r => {
      const turnId = this.repo.get('tree_snapshots', r.snapshotId)?.logicalTurnId;
      const ordinal = this.repo.list('tree_change_events', event => { const receipt = event.commandType === 'recordTreeRestore' && this.repo.get('tree_receipts', event.receiptId); return receipt?.result?.id === r.id && receipt.result.state === 'completed'; })[0]?.ordinal;
      return turnId && ordinal ? [{ id: r.id, turnId, ordinal, paths: r.changes.map(c => c.path) }] : [];
    });
    const assessedFragments = fragments.flatMap(f => {
      const feedback = this.turns().flatMap(t => t.userSourceRefs.filter(r => f.feedbackRefs.some(ref => digest(ref) === digest(r))).map(ref => ({ ref, ordinal: t.ordinal }))).sort((a, b) => a.ordinal - b.ordinal);
      // A human message can accept result A and reject result B. Source-bound
      // per-fragment classifications take precedence over broad message labels.
      const classified = feedback.map(entry => ({ ...entry, classification: f.classifiedFeedback?.find(c => c.ordinal <= throughOrdinal && c.responseRefs.some(r => digest(r) === digest(entry.ref))) }));
      const first = classified.find(entry => entry.classification ? entry.classification.outcome !== 'unknown' : effectiveSignals(this.repo, this.resolveSource).some(s => ['proceeded', 'redo'].includes(s.category) && s.sourceRefs.some(r => digest(r) === digest(entry.ref))));
      const restore = restores.filter(r => r.turnId === f.turnId && r.paths.some(path => f.outputPaths?.includes(path))).sort((a, b) => a.ordinal - b.ordinal)[0];
      if (restore && (!first || restore.ordinal < first.ordinal)) return restore.ordinal > afterOrdinal && restore.ordinal <= throughOrdinal ? [{ id: f.id, outcome: 'redo', restoreId: restore.id }] : [];
      if (!first || !messages.has(digest(first.ref))) return [];
      const categories = signals.filter(s => s.sourceRefs.some(r => digest(r) === digest(first.ref))).map(s => s.category);
      return [{ id: f.id, outcome: first.classification?.outcome ?? (categories.includes('redo') ? 'redo' : 'proceeded'), ref: first.ref }];
    });
    const boundFeedback = new Set(fragments.flatMap(f => f.feedbackRefs).map(digest));
    const proposals = Object.values(this.repo.meta().proposals ?? {}).filter(p => turnIds.has(p.turnId) && this.resolveSource(p.proposalRef)).map(p => {
      const response = p.history?.filter(h => h.ordinal <= throughOrdinal).at(-1); return { ...p, state: response?.outcome ?? 'unknown', responseRefs: response?.responseRefs ?? [] };
    });
    const decidedProposals = proposals.filter(p => ['adopted', 'rejected', 'ignored'].includes(p.state) && p.responseRefs.length && p.responseRefs.every(this.resolveSource));
    const inferred = new Map(), methods = new Map();
    for (const item of this.repo.list('tree_items', i => !scopeNodeId || i.nodeId === scopeNodeId)) {
      const versions = this.repo.list('tree_item_versions', v => v.itemId === item.id);
      if (item.kind === 'understanding') for (const version of versions.filter(v => v.sourceKind === 'assistant_inferred')) {
        const confirmation = versions.find(v => v.supersedes === version.version && v.confirmationRef && this.ordinal('tree_item_versions', v.id, { first: true }) > afterOrdinal && this.ordinal('tree_item_versions', v.id, { first: true }) <= throughOrdinal);
        const evaluations = (item.reviews ?? []).filter(r => r.version === version.version && ['met', 'not_met'].includes(r.result) && r.opportunityRefs.some(ref => messages.has(digest(ref))));
        if (confirmation || evaluations.length) inferred.set(item.id + ':' + version.version, confirmation ? 'met' : evaluations.at(-1).result);
      }
      if (item.kind === 'method') for (const evaluation of item.evaluations ?? []) {
        const job = this.repo.list('tree_jobs', j => j.role === 'verification' && j.status === 'committed' && j.input.window?.id === evaluation.windowId)[0];
        if (job && this.ordinal('tree_jobs', job.id) > afterOrdinal && this.ordinal('tree_jobs', job.id) <= throughOrdinal && job.input.window.throughTurnIds.some(id => turnIds.has(id))) methods.set(item.id + ':' + evaluation.version, evaluation);
      }
    }
    const methodEvaluated = [...methods.values()].filter(e => e.opportunityCount > 0 && e.result !== 'unclear');
    const hooks = this.signals.hookCandidates().filter(h => turnIds.has(h.logicalTurnId));
    const unrecovered = hooks.filter(h => !h.recovered && !signals.some(s => s.category === 'omitted' && this.repo.list('tree_turns', t => t.sessionId === this.repo.get('tree_turns', h.logicalTurnId)?.sessionId && t.nativeTurn > this.repo.get('tree_turns', h.logicalTurnId)?.nativeTurn).sort((a, b) => a.nativeTurn - b.nativeTurn)[0]?.userSourceRefs.some(ref => s.sourceRefs.some(r => digest(r) === digest(ref)))));
    const recurrentRefs = new Set(this.repo.list('tree_clusters', c => c.recurrence && !c.needsRecheck).flatMap(c => c.evidenceRefs ?? []).map(digest).filter(ref => negative.has(ref)));
    const learned = this.repo.list('tree_items', i => ['understanding', 'method'].includes(i.kind) && (!scopeNodeId || i.nodeId === scopeNodeId) && this.ordinal('tree_items', i.id, { first: true }) <= throughOrdinal);
    // Lifecycle rows are mutable; do not invent historical state when asked to
    // reconstruct an older watermark. Saved live windows retain their snapshot.
    const currentLifecycle = throughOrdinal === this.repo.meta().lastEventOrdinal;
    const learningInventory = { learned: learned.length, methodsCreated: learned.filter(i => i.kind === 'method' && this.ordinal('tree_items', i.id, { first: true }) > afterOrdinal).length, invalidOrWithdrawn: currentLifecycle ? learned.filter(i => ['invalid', 'withdrawn'].includes(i.lifecycle) || i.validation === 'contradicted').length : null, historicalStateMissing: !currentLifecycle };
    const rates = { understandingProblems: ratio(categoryRefs(['not_understood', 'misread', 'restart']).size, messages.size), negativeFeedback: ratio(negative.size, messages.size),
      confirmedInferences: ratio([...inferred.values()].filter(v => v === 'met').length, inferred.size), adoption: ratio(decidedProposals.filter(p => p.state === 'adopted').length, decidedProposals.length),
      firstPass: ratio(assessedFragments.filter(f => f.outcome === 'proceeded').length, assessedFragments.length), methodExpectations: ratio(methodEvaluated.filter(e => e.result === 'met').length, methodEvaluated.length), recurrence: ratio(recurrentRefs.size, negative.size) };
    const scope = scopeNodeId ?? 'global', identity = [scope, afterOrdinal, throughOrdinal, turns.map(t => [t.id, t.assignmentRevision]), signals.map(s => s.id), [...inferred], [...methods], proposals, assessedFragments];
    return { id: digest(['metric-window', identity]), scope, fromOrdinal: afterOrdinal, toOrdinal: throughOrdinal, observations: { logicalTurns: turns.length, userMessages: messages.size, turnIds: [...turnIds], counts,
      strong: categoryRefs(['approved', 'adopted_proposal', 'confirmed_inference']).size, weakProgress: counts.proceeded, unresolvedProposals: proposals.filter(p => p.state === 'unknown').length, hookRecovered: hooks.filter(h => h.recovered).length, hookOmissionCandidates: unrecovered.length,
      methodUnclear: [...methods.values()].filter(e => e.result === 'unclear').length, learningInventory, restores: restores.filter(r => r.ordinal > afterOrdinal && r.ordinal <= throughOrdinal && turnIds.has(r.turnId)).length, unboundRestores: restores.filter(r => r.ordinal > afterOrdinal && r.ordinal <= throughOrdinal && turnIds.has(r.turnId) && !fragments.some(f => f.turnId === r.turnId && r.paths.some(path => f.outputPaths?.includes(path)))).length, rates, growth: this.growth({ afterOrdinal, throughOrdinal, scopeNodeId }) },
      numerators: Object.fromEntries(Object.entries(rates).map(([k, v]) => [k, v.numerator])), denominators: Object.fromEntries(Object.entries(rates).map(([k, v]) => [k, v.denominator])),
      missing: { revokedUserSources: refs.length - validRefs.length, unboundFirstAttemptFeedback: [...categoryRefs(['proceeded', 'redo'])].filter(ref => !boundFeedback.has(ref)).length, unassessedInferences: this.repo.list('tree_items', i => i.kind === 'understanding' && i.validation === 'unverified' && (!scopeNodeId || i.nodeId === scopeNodeId)).length, unboundAdoptionSignals: signals.filter(s => s.category === 'adopted_proposal' && !s.subjectRefs.some(id => proposals.some(p => p.id === id))).length },
      algorithmVersion: METRIC_VERSION, needsRecheck: false, caveat: '观察统计；沉默不等于认可，样本间未保证独立，不构成因果收益证明。' };
  }
  saveWindow(scopeNodeId, options) {
    const value = this.freeze(scopeNodeId, options), existing = this.repo.get('tree_metric_windows', value.id); if (existing && !existing.needsRecheck) return existing;
    return this.repo.command('recordMetricWindow', { requestId: digest(['metrics', value.id, existing?.revision ?? 0]), expected: {}, input: { scopeNodeId, from: value.fromOrdinal, to: value.toOrdinal } }, program, () => {
      this.repo.save('tree_metric_windows', value, existing?.revision ?? null); return { windowId: value.id };
    }).result.windowId && this.repo.get('tree_metric_windows', value.id);
  }
  compare(previous, current) {
    if (!previous || !current || previous.needsRecheck || current.needsRecheck || previous.algorithmVersion !== current.algorithmVersion || previous.scope !== current.scope || previous.toOrdinal !== current.fromOrdinal || previous.observations.logicalTurns < 10 || current.observations.logicalTurns < 10) return { comparable: false, reason: '需要两个相邻、算法相同且各至少10轮的有效窗口', trends: {} };
    const trends = Object.fromEntries(Object.entries(current.observations.rates).map(([name, now]) => { const before = previous.observations.rates[name]; return [name, now.value === null || before.value === null ? null : { previous: before.value, current: now.value, delta: now.value - before.value }]; }));
    return { comparable: true, trends, notImproved: Object.entries(trends).filter(([name, value]) => value && (['understandingProblems', 'negativeFeedback', 'recurrence'].includes(name) ? value.delta >= 0 : value.delta <= 0)).map(([name]) => name), caveat: current.caveat };
  }
  observeTree(receipt, beforeNodes, { logicalTurnId = receipt.result?.turnId ?? null } = {}) {
    const event = this.repo.get('tree_change_events', receipt.eventIds[0]); if (!event) fail('TREE_RECEIPT', 'Actual tree command receipt required');
    if (logicalTurnId && !this.repo.get('tree_turns', logicalTurnId)) fail('TURN_NOT_FOUND', 'Tree observation must belong to a real turn');
    const key = digest(['tree-observation', receipt.id]); if (this.repo.meta().treeObservations?.[key]) return this.repo.meta().treeObservations[key];
    const observations = [];
    for (const id of event.entityIds.filter(k => k.startsWith('tree_nodes:')).map(k => k.slice(11))) {
      if (id === this.repo.rootId()) continue; const before = beforeNodes.find(n => n.id === id), after = this.repo.get('tree_nodes', id);
      for (const type of ['created', 'name', 'parentId', 'status', 'deleted']) {
        if (type === 'created' ? Boolean(before) : !before || canonicalJson(before[type] ?? null) === canonicalJson(after[type] ?? null)) continue;
        const origin = type === 'status' && after.statusOrigin === 'cascade' ? 'cascade' : event.actor.kind === 'user' ? 'user' : event.actor.role === 'attribution' || event.commandType === 'applyAttribution' ? 'attribution' : 'assistant';
        observations.push({ id: digest([key, id, type]), nodeId: id, type, before: before?.[type] ?? null, after: type === 'created' ? after.parentId : after[type], origin, ordinal: event.ordinal, sourceRefs: event.sourceRefs, commandReceiptId: receipt.id, logicalTurnId, reversalOf: receipt.result?.reversalOf ?? null,
          beforeStatusOrigin: before?.statusOrigin ?? null, beforeCascadeFromId: before?.cascadeFromId ?? null, afterRevision: after.revision });
      }
    }
    this.repo.command('observeTreeChanges', { requestId: key, expected: {}, input: { receiptId: receipt.id } }, program, () => { const meta = this.repo.meta(); this.repo.save('tree_meta', { ...meta, treeObservations: { ...meta.treeObservations, [key]: observations } }, meta.revision); return { observations }; }); return observations;
  }
  growth({ afterOrdinal = 0, throughOrdinal = this.repo.meta().lastEventOrdinal, scopeNodeId = null } = {}) {
    const observations = Object.values(this.repo.meta().treeObservations ?? {}).flat().filter(o => o.ordinal > afterOrdinal && o.ordinal <= throughOrdinal && (!scopeNodeId || o.nodeId === scopeNodeId));
    const all = Object.values(this.repo.meta().treeObservations ?? {}).flat();
    const unreversed = observations.filter(o => !o.reversalOf && o.origin !== 'cascade' && !this.repo.get('tree_nodes', o.nodeId)?.deleted && !all.some(later => later.ordinal > o.ordinal && later.nodeId === o.nodeId && later.type === o.type && canonicalJson(later.after) === canonicalJson(o.before)));
    const eligible = unreversed.filter(o => o.origin === 'user'), weak = unreversed.filter(o => o.origin === 'attribution' && o.type === 'created' && this.turns().some(t => t.ordinal > o.ordinal));
    const turns = this.turns(scopeNodeId).filter(t => t.ordinal > afterOrdinal && t.ordinal <= throughOrdinal), assignedNodeCount = new Set(turns.flatMap(t => t.nodeIds).filter(id => id !== this.repo.rootId())).size;
    const completions = unreversed.filter(o => o.type === 'status' && o.after === 'completed').map(o => { const created = all.find(c => c.nodeId === o.nodeId && c.type === 'created' && c.ordinal <= o.ordinal); return { nodeId: o.nodeId, origin: o.origin, userTurnsSinceCreation: created ? this.turns(o.nodeId).filter(t => t.ordinal > created.ordinal && t.ordinal <= o.ordinal).length : null }; });
    return { raw: observations.length, excludingCascadeAndReversed: unreversed.length, confirmedUserChanges: eligible.length, weakUnretractedCreations: weak.length, weakAssistantCompletions: completions.filter(c => c.origin !== 'user').length, completions,
      assignedNodeCount, logicalTurns: turns.length, assignedNodesPer100Turns: turns.length >= 100 ? assignedNodeCount * 100 / turns.length : null,
      userStatusChoices: Object.fromEntries(['active', 'paused', 'completed', 'abandoned'].map(status => [status, eligible.filter(o => o.type === 'status' && o.after === status).length])), byType: Object.fromEntries(['created', 'name', 'parentId', 'status'].map(type => [type, eligible.filter(o => o.type === type).length])), observations, valueJudgment: null };
  }
  stagnation(nodeId) {
    // Judge whole blocks of ten settled turns. The block's turn ids are the
    // trigger key, so each block is reviewed at most once instead of once per
    // later turn.
    const node = this.repo.get('tree_nodes', nodeId), all = this.turns(nodeId), end = Math.floor(all.length / 10) * 10, turns = all.slice(end - 10, end);
    if (node?.status !== 'active' || end === 0) return null;
    const progress = turns.map(t => this.repo.meta().progressEvidence?.[t.id] ?? { turnId: t.id, state: 'unclassified', sourceRefs: this.experience.material(t).sources.map(s => s.ref), confirmedOutputs: [], confirmedDecisions: [] });
    if (progress.some(p => p.confirmedOutputs.length || p.confirmedDecisions.length)) return null;
    return { nodeId, turnIds: turns.map(t => t.id), progress, status: 'candidate_only', needsSemanticReview: true };
  }
}

export class ReflectionTriggers {
  constructor({ repository, metrics, clusters, verification, readScope }) { Object.assign(this, { repo: repository, metrics, clusters, verification, readScope }); }
  once(key, input, enqueue) {
    const old = this.repo.meta().reflectionTriggers?.[key]; if (old) return this.repo.get('tree_jobs', old.jobId);
    return this.repo.transaction(() => {
      const job = enqueue(); this.repo.command('recordReflectionTrigger', { requestId: key, expected: {}, input }, program, () => { const meta = this.repo.meta(); this.repo.save('tree_meta', { ...meta, reflectionTriggers: { ...meta.reflectionTriggers, [key]: { ...input, jobId: job.id } } }, meta.revision); return { jobId: job.id }; }); return job;
    });
  }
  scan(nodeId, options = {}) { return this.readScope ? this.readScope.run(() => this.scanCurrent(nodeId, options)) : this.scanCurrent(nodeId, options); }
  scanCurrent(nodeId, { summaryId = null, previousWindow = null, currentWindow = null, parentJobId = null } = {}) {
    const jobs = [];
    for (const category of CATEGORIES.filter(c => c !== 'proceeded')) { const cluster = this.clusters.candidate(category, signalPolarity(category)); if (cluster) jobs.push(this.once(digest(['reflect-cluster', cluster.id, cluster.revision]), { kind: 'cluster', clusterId: cluster.id }, () => this.verification.enqueue(cluster.nodeId, { reason: 'cluster', clusterIds: [cluster.id], parentJobId }))); }
    if (summaryId) jobs.push(this.once(digest(['reflect-summary', summaryId]), { kind: 'routine', summaryId }, () => this.verification.enqueue(nodeId, { reason: 'window', summaryId, parentJobId })));
    const stagnation = this.metrics.stagnation(nodeId);
    if (stagnation) jobs.push(this.once(digest(['reflect-stagnation', nodeId, stagnation.turnIds]), { kind: 'stagnation', ...stagnation }, () => this.verification.enqueue(nodeId, { reason: 'stagnation', parentJobId })));
    const trend = this.metrics.compare(previousWindow, currentWindow);
    if (trend.comparable && trend.notImproved.length) jobs.push(this.once(digest(['reflect-trend', previousWindow.id, currentWindow.id]), { kind: 'trend', previousWindow: previousWindow.id, currentWindow: currentWindow.id, trend }, () => this.verification.enqueue(nodeId, { reason: 'window', summaryId, parentJobId })));
    return [...new Map(jobs.map(j => [j.id, j])).values()];
  }
}
