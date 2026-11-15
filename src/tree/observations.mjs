import { digest, fail } from './contracts.mjs';

const unique = values => [...new Map(values.map(v => [digest(v), v])).values()];

// Quotes locate evidence; they do not prove that a model's interpretation is
// correct. Semantic acceptance remains a separate, held-out evaluation.
export function quotedSource(envelope, quote, role) {
  const source = envelope.sources.find(s => s.id === quote.sourceId);
  if (!envelope.currentTurn?.sourceIds.includes(quote.sourceId) || source?.role !== role || source.origin !== (role === 'user' ? 'user' : 'model')) fail('OUTPUT_CURRENT_SOURCE', 'Observation requires the current actual speaker');
  const start = source.text.indexOf(quote.text);
  if (!quote.text.trim() || start < 0 || source.text.indexOf(quote.text, start + 1) >= 0) fail('OUTPUT_QUOTE', 'Evidence quote must locate one exact span in its source');
  return { source, start, end: start + quote.text.length };
}

export function learningCorrections(output, envelope) {
  const corrections = {}, replacements = new Map();
  for (const revision of output.revisions) {
    const target = envelope.knownItems.find(i => i.id === revision.targetId && i.version === revision.targetVersion);
    if (!target) fail('OUTPUT_VERSION', 'Correction target changed');
    if (target.kind !== 'understanding') fail('OUTPUT_CORRECTION', 'Only understandings may use this correction route');
    if (corrections[target.id]) fail('OUTPUT_CORRECTION', 'One correction per item per result');
    const replacement = output.understandings[revision.replacedByIndex];
    if (!replacement) fail('OUTPUT_CORRECTION', 'A correction needs a replacement');
    const claim = revision.correctionEvidence;
    let correction = envelope.trigger?.correction;
    if (claim) {
      const sources = claim.quotes.map(q => quotedSource(envelope, q, 'user').source);
      if (new Set(sources.map(s => s.id)).size !== sources.length || revision.sourceIds.some(id => !sources.some(s => s.id === id)) || sources.some(s => !revision.sourceIds.includes(s.id)) || revision.sourceIds.some(id => !replacement.sourceIds.includes(id))) fail('OUTPUT_CORRECTION', 'Correction and replacement must bind the same current human evidence');
      correction = { itemIds: [target.id], sourceIds: sources.map(s => s.id), global: claim.scope === 'global', evidence: claim.quotes, classification: 'learning_model' };
    }
    if (!correction?.itemIds?.includes(target.id) || revision.sourceIds.some(id => !correction.sourceIds?.includes(id)) || !revision.sourceIds.some(id => envelope.sources.some(s => s.id === id && s.role === 'user' && s.origin === 'user'))) fail('OUTPUT_CORRECTION', 'Only a source-bound current-user correction may revise an understanding');
    if (!envelope.scope.nodeIds.includes(target.nodeId) && !correction.global) fail('OUTPUT_LOCAL_EXCEPTION', 'A local exception cannot invalidate ancestor content');
    if (replacements.has(revision.replacedByIndex) && replacements.get(revision.replacedByIndex) !== target.nodeId) fail('OUTPUT_CORRECTION', 'One replacement cannot acquire conflicting scopes');
    replacements.set(revision.replacedByIndex, target.nodeId);
    corrections[target.id] = { ...correction, sourceRefs: revision.sourceIds.map(id => envelope.sources.find(s => s.id === id).ref) };
  }
  return corrections;
}

export function validateObservations(output, envelope) {
  const observed = output.observations;
  if (!observed) return;
  const seen = new Set(), once = key => { if (seen.has(key)) fail('OUTPUT_OBSERVATION_DUPLICATE', 'Duplicate observation'); seen.add(key); };
  for (const kind of ['proposals', 'firstResults']) for (const quote of observed[kind]) {
    const span = quotedSource(envelope, quote, 'assistant');
    once(kind + ':' + digest([span.source.ref, span.start, span.end]));
  }
  for (const [kind, key, list] of [['proposalResponses', 'proposalId', 'proposals'], ['resultFeedback', 'fragmentId', 'fragments']]) for (const observation of observed[kind]) {
    once(kind + ':' + observation[key]);
    const target = envelope.observationContext?.[list]?.find(v => v.id === observation[key]);
    if (!target || !target.nodeIds.some(id => envelope.scope.nodeIds.includes(id)) || target.turnId === envelope.currentTurn.id) fail('OUTPUT_OBSERVATION_TARGET', 'Feedback must reference a supplied earlier object in this node');
    observation.quotes.forEach(q => quotedSource(envelope, q, 'user'));
  }
  for (const quote of observed.confirmedDecisions) { quotedSource(envelope, quote, 'user'); once('decision:' + digest(quote)); }
}

export class LearningObservations {
  constructor({ repository, metrics }) { this.repo = repository; this.metrics = metrics; }
  freeze(nodeId, priorTurnIds) {
    const meta = this.repo.meta();
    const select = rows => Object.values(rows ?? {}).filter(r => r.nodeIds.includes(nodeId) && priorTurnIds.includes(r.turnId));
    const proposals = select(meta.proposals).filter(r => this.metrics.resolveSource(r.proposalRef));
    const fragments = select(meta.taskFragments).filter(r => this.metrics.resolveSource(r.firstResultRef));
    const projection = (row, ref, span) => {
      const source = this.metrics.resolveSource(ref);
      return { id: row.id, nodeIds: [nodeId], turnId: row.turnId, sourceId: source.id, text: span ? source.text.slice(span.start, span.end) : source.text };
    };
    // Do not copy mutable response history: it can include a later turn from
    // another learning queue. Only pre-existing objects and their originals.
    return { proposals: proposals.map(p => projection(p, p.proposalRef, p)), fragments: fragments.map(f => projection(f, f.firstResultRef, f.span)),
      sources: unique([...proposals.map(p => this.metrics.resolveSource(p.proposalRef)), ...fragments.map(f => this.metrics.resolveSource(f.firstResultRef))]) };
  }
}
