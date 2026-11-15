import { digest } from '../../../src/tree/contracts.mjs';
export function futureRecords(nodeId, sourceRef) {
  const hash = digest('fixture'), at = '2026-11-12T00:00:00.000Z';
  // These records are the persisted handoff to B2-B6, not simulated completed
  // model calls, scripts or evidence of product effectiveness.
  return [
    ['tree_summaries', { nodeId, version: 1, oneLine: '合成摘要', body: { status: 'active', outputs: [], decisions: [], next: '', pending: [] }, throughTurnIds: ['turn'], sourceRefs: [sourceRef], previousVersion: null }],
    ['tree_learning_sessions', { nodeId, sessionId: 'learning-native', contextEpoch: 1, appendSeq: 0, sourceWatermark: null, appliedChangeOrdinal: 0, estimateTokens: 0 }],
    ['tree_jobs', { kind: 'learning', scopeKey: nodeId, inputHash: hash, inputRevisionSet: {}, status: 'queued' }],
    ['tree_invocations', { jobId: 'job', role: 'learning', nativeSessionId: 'learning-native', ordinal: 1, modelConfigHash: hash, promptHash: hash, inputHash: hash, allowedTools: [], state: 'prepared' }],
    ['tree_episodes', { signalIds: ['signal'], beforeRefs: [], reactionRefs: [sourceRef], resolutionRefs: [], nodeIds: [nodeId], state: 'open', start: at }],
    ['tree_clusters', { category: 'misread', polarity: 'negative', epoch: 1, episodeIds: ['episode'], status: 'candidate', methodIds: [], reviewWatermark: 0, recurrenceCount: 0 }],
    ['tree_repairs', { producerRole: 'learning', stage: 'generate', type: 'missing_source', sourceSignalIds: ['signal'], nodeIds: [nodeId], reason: '合成修复记录', requestId: 'repair-request' }],
    ['tree_hook_runs', { logicalTurnId: 'turn', eventKey: 'turn-end', hookId: 'hook', version: 1, scopeEpoch: 1, inputHash: hash, result: { passed: false }, continuationCycle: 0, observedAt: at }],
    ['tree_script_artifacts', { scriptId: 'script', methodId: 'method', version: 1, language: 'node-esm', entry: 'main.mjs', files: [{ relativePath: 'main.mjs', hash, size: 0 }], argSchema: { type: 'object' }, dryRunSupport: true, buildRunId: 'build', activationState: 'draft' }],
    ['tree_script_runs', { runId: 'run', methodVersion: { itemId: 'method', version: 1 }, nodeEpoch: 1, workspaceIdentity: { pathHash: hash, dev: 1, ino: 1 }, policyHash: hash, snapshotId: 'snapshot', argvHash: hash, state: 'denied' }],
    ['tree_snapshots', { snapshotId: 'snapshot', workspaceIdentity: { pathHash: hash, dev: 1, ino: 1 }, manifestHash: hash, commitId: hash, reason: 'fixture', coverage: { included: [], excluded: [], failed: [] }, restoreState: 'unused' }],
    ['tree_reports', { category: 'format', fingerprint: hash, step: '学习', problem: '合成问题', evidenceRefs: [sourceRef], whyUniversal: '无个人特征关联', stopgapIds: [], suggestedFix: '完整校验', status: 'unhandled', exportAudit: [] }],
    ['tree_metric_windows', { scope: { nodeIds: [nodeId] }, fromOrdinal: 0, toOrdinal: 1, observations: [], numerators: {}, denominators: {}, missing: [], algorithmVersion: 'v1' }],
  ].map(([kind, body]) => [kind, { ...body, id: digest(['kind-fixture', kind]) }]);
}
