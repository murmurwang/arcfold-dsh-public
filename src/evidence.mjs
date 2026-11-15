import { createHash } from 'node:crypto';

export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const unavailable = row => !row || row.deleted || row.withdrawn === true || row.useProhibited || ['withdrawn', 'superseded', 'rejected', 'paused'].includes(row.status);
const atSequence = (row, cutoff) => Number.isSafeInteger(row?.createdSequence) && Number.isSafeInteger(row.updatedSequence) && row.createdSequence <= cutoff && row.updatedSequence <= cutoff;
export const sourceText = row => typeof row.content === 'string' ? row.content : (row.message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
// Provider replay state belongs to the original native message/transport, not
// to quoted evidence. Keep its persisted original and sourceRef hash untouched;
// only omit the known opaque field from the model-facing provenance copy.
export function evidenceProvenance(provenance) {
  if (provenance?.kind === 'dsh_session' && provenance.source?.kind === 'model') {
    const { replayState, ...source } = provenance.source;
    return structuredClone({ ...provenance, source });
  }
  return structuredClone(provenance ?? null);
}
export const sourceAvailable = (store, row) => !unavailable(row) && !(store.get('source_controls', row.id)?.useProhibited || store.get('source_controls', row.id)?.withdrawn);

// A record never outlives its originals or the exact dependency revisions it read.
export function dependenciesCurrent(store, row, cutoff, path = new Set()) {
  if (unavailable(row) || !atSequence(row, cutoff) || path.has(row.id)) return false;
  const next = new Set([...path, row.id]);
  for (const ref of row.dependencies || []) {
    const kind = ref.kind || ['events', 'understandings', 'methods'].find(k => store.get(k, ref.id));
    if (!['events', 'understandings', 'methods'].includes(kind)) return false;
    const dependency = store.get(kind, ref.id);
    if (unavailable(dependency) || dependency.revision !== ref.revision || !atSequence(dependency, cutoff)) return false;
    if (kind === 'events' && !sourceAvailable(store, dependency)) return false;
    if (kind !== 'events' && !dependenciesCurrent(store, dependency, cutoff, next)) return false;
  }
  return Array.isArray(row.sourceIds) && row.sourceIds.length > 0 && row.sourceIds.every(id => {
    const source = store.get('events', id);
    return sourceAvailable(store, source) && atSequence(source, cutoff);
  });
}
