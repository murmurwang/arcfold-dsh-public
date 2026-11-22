// The frozen job input is also the envelope that validates model output. It
// carries refs, hashes and bookkeeping that only the program reads. The model
// gets this view of it; validation keeps using the complete frozen input.
const pick = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const SOURCE = ['id', 'role', 'origin', 'text', 'at', 'toolCallId', 'isError'];
// A native source projection: an id, a role and a durable log reference.
const isSource = value => object(value) && typeof value.id === 'string' && typeof value.role === 'string' && typeof value.text === 'string' &&
  object(value.ref) && typeof value.ref.sessionId === 'string' && typeof value.ref.sha256 === 'string';

/** A source keeps its id and wording; text is its complete flattened content. */
export function sourceView(source) {
  return { ...pick(source, SOURCE), ...(object(source.elided) ? { elided: { chars: source.elided.chars } } : {}) };
}
const segmentView = segment => object(segment) && typeof segment.text === 'string' ? pick(segment, ['key', 'nodeId', 'text']) : walk(segment);
const listed = (value, view) => Array.isArray(value) ? value.map(row => object(row) ? view(row) : walk(row)) : walk(value);
const fields = {
  context: value => listed(value, segmentView),
  constraints: value => listed(value, segmentView),
  exposures: value => listed(value, row => pick(row, ['id', 'nodeIds', 'itemVersions', 'visibleItemVersions', 'role'])),
  changeReceipts: value => listed(value, row => pick(row, ['commandType', 'entityIds', 'beforeVersions', 'afterVersions'])),
  signals: value => listed(value, row => walk(Object.fromEntries(Object.entries(row).filter(([key]) => !['eventId', 'createdAt', 'updatedAt'].includes(key))))),
};
function walk(value) {
  if (Array.isArray(value)) return value.map(walk);
  if (!object(value)) return value;
  if (isSource(value)) return sourceView(value);
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, Object.hasOwn(fields, key) ? fields[key](child) : walk(child)]));
}

/** Deterministic model-facing view of a frozen auxiliary job input. */
export function modelView(input) { return walk(input); }
