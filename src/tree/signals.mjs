import { canonicalJson, digest, fail, oneOf, sourceRefs } from './contracts.mjs';
import { SignalService } from './tree.mjs';

export const signalPolarity = category => category === 'proceeded' ? 'weak' : ['approved', 'adopted_proposal', 'confirmed_inference'].includes(category) ? 'strong' : 'negative';
const program = { kind: 'program', id: 'tree-signal-evidence' };
const unique = values => [...new Map(values.map(v => [canonicalJson(v), v])).values()];
export function evidenceResolver(repo, nativeResolve) {
  return ref => {
    if (ref.sessionId !== 'arcfold-ui:' + repo.rootId()) return nativeResolve(ref);
    const event = repo.list('tree_change_events', e => e.ordinal === ref.seq)[0];
    if (!event || event.actor.kind !== 'user' || digest(event) !== ref.sha256) return null;
    const receipt = repo.get('tree_receipts', event.receiptId);
    return { id: digest(['ui-source', ref]), role: 'user', origin: 'ui', text: canonicalJson({ operation: event.commandType, entityIds: event.entityIds, result: receipt.result }), ref, sha256: ref.sha256 };
  };
}

/** Corrections replace an observation in derived views, never its audit row. */
export function effectiveSignals(repo, resolveSource = () => true) {
  const rows = repo.list('tree_signals'), byId = new Map(rows.map(r => [r.id, r]));
  const ordinals = new Map();
  // Only events that created a signal matter; a filtered list avoids parsing
  // every change event on each call (F56: 83 full reads during one startup).
  for (const event of repo.list('tree_change_events', e => e.entityIds.some(key => key.startsWith('tree_signals:')))) for (const [index, key] of event.entityIds.entries()) if (key.startsWith('tree_signals:') && event.beforeVersions[index] === 0) ordinals.set(key.slice('tree_signals:'.length), event.ordinal);
  const root = row => { const seen = new Set(); while (row.correctionOf) { if (seen.has(row.id) || !byId.has(row.correctionOf)) fail('SIGNAL_HISTORY', 'Broken correction chain'); seen.add(row.id); row = byId.get(row.correctionOf); } return row.id; };
  const latest = new Map();
  for (const row of rows) { const key = root(row), old = latest.get(key); if (!old || (ordinals.get(row.id) ?? 0) > (ordinals.get(old.id) ?? 0)) latest.set(key, row); }
  return [...latest.values()].filter(r => r.sourceRefs.every(resolveSource));
}

/** One human message is one episode even when several nodes learn from it. */
export class EpisodeSignals {
  constructor({ repository, resolveSource, experience }) { Object.assign(this, { repo: repository, resolveSource, experience }); }
  recordCategories(categories, { job, requestId }) {
    const actor = { kind: 'model', id: job.id, role: job.role }, nodeIds = job.nodeIds;
    const signalService = new SignalService({ repository: this.repo, resolveSource: this.resolveSource, context: () => ({ actor, nodeIds }) });
    return this.repo.transaction(() => categories.map((category, index) => {
      const source = job.input.sources.find(s => s.id === category.sourceId);
      if (!source || source.role !== 'user' || source.origin !== 'user' || !job.input.currentTurn?.sourceIds.includes(source.id) || !this.resolveSource(source.ref)) fail('SIGNAL_USER_REQUIRED', 'Categories must refer to the current real human message');
      const turn = this.repo.list('tree_turns', t => t.status === 'settled' && t.userSourceRefs.some(r => digest(r) === digest(source.ref)))[0];
      if (!turn || !turn.nodeIds.some(id => nodeIds.includes(id))) fail('SIGNAL_SCOPE', 'Referenced message must belong to settled experience in this scope');
      const eventId = digest(['human-message', source.ref]), episodeId = digest(['episode', eventId]);
      const signal = signalService.record({ requestId: digest([requestId, 'category', index]), expected: {}, input: { eventId, subjectRefs: category.subjectIds,
        dimension: 'collaboration', subitem: category.category, category: category.category, polarity: signalPolarity(category.category), evidenceKind: 'language', sourceRefs: [source.ref], nodeIds: turn.nodeIds, confidence: 1 } }).result;
      this.repo.command('recordSignalEpisode', { requestId: digest([requestId, 'episode', index]), expected: {}, input: { episodeId, signalId: signal.signalId, note: category.note } }, actor, () => {
        const old = this.repo.get('tree_episodes', episodeId);
        const previous = this.repo.list('tree_turns', t => t.sessionId === turn.sessionId && t.nativeTurn < turn.nativeTurn && t.status === 'settled').sort((a, b) => b.nativeTurn - a.nativeTurn)[0];
        const beforeRefs = previous?.nodeIds.some(id => turn.nodeIds.includes(id)) ? this.experience.material(previous).sources.filter(s => s.role === 'assistant' && s.origin === 'model').map(s => s.ref) : [];
        const resolutionRefs = this.experience.material(turn).sources.filter(s => s.role === 'assistant' && s.origin === 'model').map(s => s.ref);
        this.repo.save('tree_episodes', { ...old, id: episodeId, eventId, turnId: turn.id, signalIds: [...new Set([...(old?.signalIds ?? []), signal.signalId])],
          beforeTurnId: previous?.id ?? null, beforeRefs, reactionRefs: [source.ref], resolutionRefs, nodeIds: turn.nodeIds, state: 'observed', start: old?.start ?? this.repo.now(), ordinal: old?.ordinal ?? this.repo.meta().lastEventOrdinal + 1,
          annotations: [...(old?.annotations ?? []), { jobId: job.id, category: category.category, note: category.note }] }, old?.revision ?? null);
        return { episodeId };
      });
      return { ...signal, episodeId };
    }));
  }
  episodes() {
    const signals = effectiveSignals(this.repo, this.resolveSource);
    return this.repo.list('tree_episodes').map(e => {
      const turn = e.turnId && this.repo.get('tree_turns', e.turnId);
      const before = e.beforeTurnId && this.repo.get('tree_turns', e.beforeTurnId);
      // Preserve stored audit refs, but remove a preceding answer from derived
      // input when it no longer shares the corrected current assignment.
      const beforeRefs = turn && !before?.nodeIds.some(id => turn.nodeIds.includes(id)) ? [] : e.beforeRefs;
      return { ...e, beforeRefs, nodeIds: turn?.nodeIds ?? e.nodeIds, signals: signals.filter(s => s.eventId === e.eventId) };
    }).filter(e => e.reactionRefs.every(this.resolveSource));
  }
  captureConfirmation(receiptId) {
    const receipt = this.repo.get('tree_receipts', receiptId), event = receipt && this.repo.get('tree_change_events', receipt.eventIds[0]);
    if (!event || event.actor.kind !== 'user' || event.commandType !== 'confirmItem') fail('UI_CONFIRMATION', 'Only an actual trusted user confirmation receipt is strong confirmation evidence');
    const eventId = digest(['user-operation', receiptId]), id = digest(['episode', eventId]), existing = this.repo.get('tree_episodes', id); if (existing) return existing;
    if (event.ordinal !== this.repo.meta().lastEventOrdinal) fail('UI_CONFIRMATION_ORDER', 'Capture UI evidence in the same outer transaction as confirmation');
    const item = this.repo.get('tree_items', receipt.result.itemId);
    if (!item || item.kind !== 'understanding' || item.activeVersion !== receipt.result.version) fail('UI_CONFIRMATION', 'Confirmation must identify the exact current understanding version');
    const version = this.repo.get('tree_item_versions', digest(['item_version', item.id, item.activeVersion]));
    const previous = this.repo.get('tree_item_versions', digest(['item_version', item.id, version.supersedes]));
    if (previous?.sourceKind !== 'assistant_inferred') return null;
    const ref = { sessionId: 'arcfold-ui:' + this.repo.rootId(), seq: event.ordinal, sha256: digest(event) }, resolver = evidenceResolver(this.repo, this.resolveSource);
    const service = new SignalService({ repository: this.repo, resolveSource: resolver, context: () => ({ actor: event.actor }) });
    return this.repo.transaction(() => {
      const signal = service.record({ requestId: digest([id, 'signal']), expected: {}, input: { eventId, subjectRefs: [item.id], dimension: 'collaboration', subitem: 'confirmed_inference', category: 'confirmed_inference', polarity: 'strong', evidenceKind: 'ui', sourceRefs: [ref], nodeIds: [item.nodeId], confidence: 1 } }).result;
      this.repo.command('captureUserConfirmation', { requestId: id, expected: {}, input: { receiptId, sourceRefs: [ref] } }, program, () => {
        this.repo.save('tree_episodes', { id, eventId, signalIds: [signal.signalId], beforeRefs: [], reactionRefs: [ref], resolutionRefs: [], nodeIds: [item.nodeId], state: 'observed', start: event.createdAt, ordinal: event.ordinal, confirmationRef: receiptId }); return { episodeId: id };
      }); return this.repo.get('tree_episodes', id);
    });
  }
  // Controls come from a trusted explicit observation of a proposal and its
  // response. No-response is unknown; only actual rejecting evidence is rejected.
  control({ proposalRef, responseRefs, nodeIds, category, outcome, requestId }) {
    oneOf(outcome, ['ignored', 'unknown', 'rejected'], 'control outcome');
    oneOf(category, ['approved', 'adopted_proposal', 'confirmed_inference'], 'control category');
    const proposal = this.resolveSource(proposalRef);
    if (proposal?.role !== 'assistant' || proposal.origin !== 'model') fail('PROPOSAL_SOURCE', 'A control must identify the actual assistant proposal');
    sourceRefs([proposalRef], this.resolveSource); sourceRefs(responseRefs, this.resolveSource, { required: outcome !== 'unknown', user: outcome !== 'unknown' });
    for (const id of nodeIds) if (!this.repo.get('tree_nodes', id)) fail('NODE_NOT_FOUND', 'Unknown control node');
    const id = digest(['proposal-control', proposalRef, category]);
    return this.repo.command('recordProposalControl', { requestId, expected: {}, input: { proposalRef, responseRefs, nodeIds, category, outcome } }, program, () => {
      const old = this.repo.get('tree_episodes', id);
      this.repo.save('tree_episodes', { ...old, id, eventId: id, signalIds: [], beforeRefs: [proposalRef], reactionRefs: responseRefs, resolutionRefs: [], nodeIds,
        state: 'control', category, outcome, start: old?.start ?? this.repo.now(), ordinal: old?.ordinal ?? this.repo.meta().lastEventOrdinal + 1, history: [...(old?.history ?? []), { outcome, responseRefs }] }, old?.revision ?? null);
      return { episodeId: id };
    }).result;
  }
  material(episode) {
    return { ...episode, sources: unique([...episode.beforeRefs, ...episode.reactionRefs, ...episode.resolutionRefs]).map(ref => {
      const s = this.resolveSource(ref); if (!s) fail('SOURCE_CHANGED', 'Episode evidence was withdrawn'); return { ...s, ref, id: s.id ?? digest(ref) };
    }) };
  }
  hookCandidates() {
    const runs = this.repo.list('tree_hook_runs'), groups = new Map();
    for (const run of runs.filter(r => r.result.status === 'needs_action')) {
      const id = digest([run.logicalTurnId, run.methodId, run.version]);
      if (!groups.has(id)) groups.set(id, { id, logicalTurnId: run.logicalTurnId, methodId: run.methodId, version: run.version, hookRunIds: [], recovered: true });
      const group = groups.get(id); group.hookRunIds.push(run.id);
      group.recovered &&= runs.some(r => r.logicalTurnId === run.logicalTurnId && r.hookId === run.hookId && r.version === run.version && r.eventOrdinal > run.eventOrdinal && r.result.status === 'pass');
    }
    // These are execution observations, never additional human negative signals.
    return [...groups.values()].map(group => ({ ...group, kind: 'hook_omission_candidate', separateHumanSignal: false }));
  }
}
