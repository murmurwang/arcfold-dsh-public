import { createHash } from 'node:crypto';
import { DomainError, canonicalJson, jsonClone } from '../store.mjs';
export { canonicalJson, jsonClone };
export const SCHEMA = 'arcfold.goal-tree/v3';
export const SCHEMA_VERSION = 1;
export const CONTRACT = 'arcfold.tree.v3.1';
export const digest = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
export const fail = (code, message, status = 409) => { throw new DomainError(code, message, status); };
export const count = text => [...text].length;
export function text(value, field, max = 2000, empty = false) {
  if (typeof value !== 'string' || value.includes('\0') || (!empty && !value.trim()) || count(value) > max) fail('INVALID_FIELD', `Invalid ${field}`, 400);
  return value;
}
export function array(value, field, max = 2000) {
  if (!Array.isArray(value) || value.length > max) fail('INVALID_FIELD', `Invalid ${field}`, 400); return value;
}
export function oneOf(value, choices, field) { if (!choices.includes(value)) fail('INVALID_FIELD', `Invalid ${field}`, 400); return value; }
export function integer(value, field, min = 1, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('INVALID_FIELD', `Invalid ${field}`, 400); return value;
}
export function shape(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(k => !Object.hasOwn(value, k)) ||
      Object.keys(value).some(k => !required.includes(k) && !optional.includes(k))) fail('INVALID_SHAPE', 'Missing or unknown fields', 400);
  return value;
}
export const STATUSES = ['active', 'paused', 'completed', 'abandoned'];
export const CATEGORIES = ['not_understood', 'misread', 'restart', 'repeated', 'overdone', 'omitted', 'misreported', 'redo', 'proceeded', 'approved', 'adopted_proposal', 'confirmed_inference'];
export const ROLES = ['main', 'attribution', 'learning', 'consolidation', 'verification', 'script_writer', 'improvement'];
export const IMMUTABLE_KINDS = new Set(['tree_item_versions', 'tree_summaries', 'tree_change_events', 'tree_receipts', 'tree_methods', 'tree_supplements']);

// Minimum persisted contracts. Role-specific output schemas live in B2 and
// cannot add authority fields to model output. Stored extension fields are host-owned.
export const RECORD_FIELDS = Object.freeze({
  tree_meta: 'schemaVersion userId rootNodeId treeRevision lastEventOrdinal',
  tree_nodes: 'parentId name status statusOrigin sourceRefs lastOwnTurnAt lastSummaryWatermark',
  tree_turns: 'sessionId nativeTurn logicalTurnId userSourceRefs sourceRefs nodeIds status startedAt',
  tree_links: 'turnId nodeId assignmentRevision active sourceRefs',
  tree_summaries: 'nodeId version oneLine body throughTurnIds sourceRefs previousVersion',
  tree_items: 'kind nodeId activeVersion lifecycle validation userProtected originNodeId',
  tree_item_versions: 'itemId version content sourceKind sourceRefs reason',
  tree_methods: 'itemId version short long scripts hooks expectation evaluation',
  tree_supplements: 'itemId version target scopeNodeId traitEvidence universalStopgap',
  tree_parameters: 'name scopeNodeId value sourceRefs actor',
  tree_exposures: 'invocationId role nodeIds itemVersions summaryVersions renderedHash treeRevision modelSessionId boundaryIndex',
  tree_learning_sessions: 'nodeId sessionId contextEpoch appendSeq sourceWatermark appliedChangeOrdinal estimateTokens',
  tree_jobs: 'kind scopeKey inputHash inputRevisionSet status',
  tree_invocations: 'jobId role nativeSessionId ordinal modelConfigHash promptHash inputHash allowedTools state',
  tree_signals: 'eventId subjectRefs dimension subitem category polarity evidenceKind sourceRefs nodeIds confidence',
  tree_episodes: 'signalIds beforeRefs reactionRefs resolutionRefs nodeIds state start',
  tree_clusters: 'category polarity epoch episodeIds status methodIds reviewWatermark recurrenceCount',
  tree_repairs: 'producerRole stage type sourceSignalIds nodeIds reason requestId',
  tree_change_events: 'ordinal commandType actor entityIds beforeVersions afterVersions sourceRefs receiptId',
  tree_hooks: 'hookId methodId version scopeNodeId moment conditions action message enabled',
  tree_hook_runs: 'logicalTurnId eventKey hookId version scopeEpoch inputHash result continuationCycle observedAt',
  tree_script_artifacts: 'scriptId methodId version language entry files argSchema dryRunSupport buildRunId activationState',
  tree_script_runs: 'runId methodVersion nodeEpoch workspaceIdentity policyHash snapshotId argvHash state',
  tree_snapshots: 'snapshotId workspaceIdentity manifestHash commitId reason coverage restoreState',
  tree_reports: 'category fingerprint step problem evidenceRefs whyUniversal stopgapIds suggestedFix status exportAudit',
  tree_metric_windows: 'scope fromOrdinal toOrdinal observations numerators denominators missing algorithmVersion',
  tree_receipts: 'requestId inputHash result revisions eventIds',
});
export function validateRef(ref) {
  shape(ref, ['sessionId', 'seq', 'sha256'], ['messageId']);
  text(ref.sessionId, 'sessionId', 512); integer(ref.seq, 'seq', 0);
  if (!/^[a-f0-9]{64}$/.test(ref.sha256)) fail('INVALID_SOURCE', 'Source must have an exact SHA-256');
  if (ref.messageId !== undefined) text(ref.messageId, 'messageId', 512);
}
export function sourceRefs(refs, resolveSource, { user = false, required = true } = {}) {
  array(refs, 'sourceRefs', 20); if (required && !refs.length) fail('SOURCE_REQUIRED', 'Immutable source evidence required');
  let human = false;
  for (const ref of refs) {
    validateRef(ref); const source = resolveSource(ref);
    if (!source || source.then || source.sha256 !== ref.sha256) fail('SOURCE_CHANGED', 'Source cannot be verified synchronously');
    human ||= source.role === 'user' && source.origin === 'user';
  }
  if (user && !human) fail('USER_SOURCE_REQUIRED', 'User-expressed content requires an actual human source, not a program message');
  return jsonClone(refs);
}
export function validateRecord(kind, record) {
  if (!Object.hasOwn(RECORD_FIELDS, kind)) fail('UNKNOWN_KIND', `Unknown tree record kind ${kind}`);
  if (RECORD_FIELDS[kind].split(' ').some(k => !Object.hasOwn(record, k))) fail('INVALID_RECORD', `Incomplete ${kind}`);
  text(record.id, 'id', 512);
  const lists = {
    tree_turns: ['nodeIds'], tree_summaries: ['throughTurnIds'], tree_methods: ['scripts', 'hooks'], tree_supplements: ['traitEvidence'],
    tree_exposures: ['nodeIds', 'itemVersions', 'summaryVersions'], tree_invocations: ['allowedTools'], tree_signals: ['subjectRefs', 'nodeIds'],
    tree_episodes: ['signalIds', 'beforeRefs', 'reactionRefs', 'resolutionRefs', 'nodeIds'], tree_clusters: ['episodeIds', 'methodIds'],
    tree_repairs: ['sourceSignalIds', 'nodeIds'], tree_change_events: ['entityIds', 'beforeVersions', 'afterVersions'], tree_hooks: ['conditions'],
    tree_script_artifacts: ['files'], tree_reports: ['evidenceRefs', 'stopgapIds', 'exportAudit'], tree_receipts: ['eventIds'],
  }[kind] ?? [];
  lists.forEach(k => array(record[k], k, 100000));
  const objects = {
    tree_summaries: ['body'], tree_methods: ['expectation', 'evaluation'], tree_parameters: ['actor'], tree_jobs: ['inputRevisionSet'],
    tree_change_events: ['actor'], tree_script_artifacts: ['argSchema'], tree_snapshots: ['coverage'], tree_metric_windows: ['numerators', 'denominators'], tree_receipts: ['result', 'revisions'],
  }[kind] ?? [];
  for (const k of objects) if (!record[k] || typeof record[k] !== 'object' || Array.isArray(record[k])) fail('INVALID_RECORD', `Invalid ${kind}.${k}`);
  const identities = {
    tree_meta: ['userId', 'rootNodeId'], tree_turns: ['sessionId', 'logicalTurnId'], tree_links: ['turnId', 'nodeId'], tree_summaries: ['nodeId'],
    tree_items: ['nodeId', 'originNodeId'], tree_item_versions: ['itemId', 'reason'], tree_methods: ['itemId'], tree_supplements: ['itemId', 'scopeNodeId'],
    tree_parameters: ['scopeNodeId'], tree_exposures: ['invocationId', 'role', 'renderedHash', 'modelSessionId'], tree_learning_sessions: ['nodeId', 'sessionId'],
    tree_jobs: ['kind', 'scopeKey', 'inputHash', 'status'], tree_invocations: ['jobId', 'role', 'nativeSessionId', 'modelConfigHash', 'promptHash', 'inputHash', 'state'],
    tree_signals: ['eventId', 'dimension', 'subitem'], tree_episodes: ['state', 'start'], tree_clusters: ['category', 'polarity', 'status'],
    tree_repairs: ['producerRole', 'stage', 'type', 'reason', 'requestId'], tree_change_events: ['commandType', 'receiptId'],
    tree_hooks: ['hookId', 'methodId', 'scopeNodeId', 'moment', 'action'], tree_hook_runs: ['logicalTurnId', 'eventKey', 'hookId', 'inputHash', 'observedAt'],
    tree_script_artifacts: ['scriptId', 'methodId', 'language', 'entry', 'buildRunId', 'activationState'], tree_script_runs: ['runId', 'policyHash', 'snapshotId', 'argvHash', 'state'],
    tree_snapshots: ['snapshotId', 'manifestHash', 'commitId', 'reason'], tree_reports: ['category', 'fingerprint', 'step', 'problem', 'whyUniversal', 'suggestedFix', 'status'],
    tree_metric_windows: ['algorithmVersion'], tree_receipts: ['requestId', 'inputHash'],
  }[kind] ?? [];
  identities.forEach(k => text(record[k], k, k === 'problem' || k === 'whyUniversal' || k === 'suggestedFix' || k === 'reason' ? 20000 : 512));
  if (kind === 'tree_turns') { integer(record.nativeTurn, 'nativeTurn', 0); oneOf(record.status, ['open', 'settled', 'interrupted', 'failed'], 'turn status'); }
  if (kind === 'tree_links') { integer(record.assignmentRevision, 'assignmentRevision'); if (typeof record.active !== 'boolean') fail('INVALID_RECORD', 'Link active must be boolean'); }
  if (kind === 'tree_jobs') oneOf(record.status, ['queued', 'prepared', 'submitted', 'result_received', 'validated', 'committed', 'failed', 'unknown', 'invalid_output', 'stale', 'cancelled'], 'job status');
  if (kind === 'tree_exposures') {
    oneOf(record.role, ROLES, 'role'); integer(record.treeRevision, 'treeRevision'); integer(record.boundaryIndex, 'boundaryIndex', 0);
    for (const ref of record.itemVersions) { shape(ref, ['itemId', 'version']); text(ref.itemId, 'itemId', 512); integer(ref.version, 'item version'); }
    for (const ref of record.summaryVersions) { shape(ref, ['nodeId', 'version']); text(ref.nodeId, 'nodeId', 512); integer(ref.version, 'summary version'); }
  }
  if (kind === 'tree_invocations') oneOf(record.role, ROLES, 'role');
  if (kind === 'tree_hooks' && typeof record.enabled !== 'boolean') fail('INVALID_RECORD', 'Hook enabled must be boolean');
  if (kind === 'tree_meta') { integer(record.schemaVersion, 'schemaVersion'); integer(record.treeRevision, 'treeRevision'); integer(record.lastEventOrdinal, 'lastEventOrdinal', 0); }
  if (kind === 'tree_change_events') integer(record.ordinal, 'ordinal');
  for (const field of ['sourceRefs', 'userSourceRefs']) if (record[field] !== undefined) array(record[field], field).forEach(validateRef);
  if (kind === 'tree_nodes') { text(record.name, 'name', 200); oneOf(record.status, STATUSES, 'status'); oneOf(record.statusOrigin, ['user', 'model', 'cascade'], 'statusOrigin'); }
  if (kind === 'tree_items') { oneOf(record.kind, ['understanding', 'method', 'supplement'], 'item kind'); oneOf(record.lifecycle, ['draft', 'active', 'withdrawn', 'changed', 'invalid'], 'lifecycle'); oneOf(record.validation, ['unverified', 'supported', 'refuted'], 'validation'); if (typeof record.userProtected !== 'boolean') fail('INVALID_RECORD', 'User protection must be boolean'); if (record.activeVersion !== null) integer(record.activeVersion, 'activeVersion'); if (record.lifecycle === 'active' && record.activeVersion === null) fail('INVALID_RECORD', 'Active items need a version'); }
  if (kind === 'tree_item_versions') oneOf(record.sourceKind, ['user_expressed', 'assistant_inferred', 'unknown'], 'sourceKind');
  if (kind === 'tree_supplements') oneOf(record.target, ['learning', 'attribution', 'consolidation'], 'supplement target');
  if (kind === 'tree_parameters') { oneOf(record.name, ['retentionDays', 'leaveTimeoutHours'], 'parameter'); integer(record.value, record.name, 1, record.name === 'retentionDays' ? 365 : 168); }
  if (kind === 'tree_signals') { oneOf(record.category, CATEGORIES, 'category'); oneOf(record.polarity, ['negative', 'weak', 'strong'], 'polarity'); oneOf(record.evidenceKind, ['language', 'ui', 'program'], 'evidenceKind'); }
  if (record.version !== undefined) integer(record.version, 'version');
  return record;
}

export function validateShort(value) {
  shape(value, ['situation', 'action', 'basis', 'notApplicable']);
  for (const key of Object.keys(value)) text(value[key], key, 200, true);
  if (count(Object.values(value).join('')) > 200) fail('CONTENT_LIMIT', 'Short text exceeds 200 codepoints');
}
export function validateLong(value) {
  shape(value, ['name', 'description', 'whenToUse', 'steps', 'pitfalls', 'verify']);
  text(value.name, 'name', 80); text(value.description, 'description', 60);
  for (const key of ['whenToUse', 'steps', 'pitfalls', 'verify']) text(value[key], key, 2000, true);
  if (count(value.whenToUse + value.steps + value.pitfalls + value.verify) > 2000) fail('CONTENT_LIMIT', 'Long text exceeds 2000 codepoints');
}
