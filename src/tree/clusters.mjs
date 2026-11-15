import { canonicalJson, digest, fail, oneOf } from './contracts.mjs';

const actor = { kind: 'program', id: 'tree-clusters' };
export class ClusterService {
  constructor({ repository, signals }) { this.repo = repository; this.signals = signals; }
  group(category, polarity) {
    return this.signals.episodes().filter(e => e.state !== 'control' && e.signals.some(s => s.category === category && s.polarity === polarity)).sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id));
  }
  signature(episodes) { return digest(episodes.map(e => [e.id, e.nodeIds, e.beforeRefs, e.reactionRefs, e.resolutionRefs, e.signals.map(s => s.id).sort()])); }
  scope(episodes) {
    const paths = [...new Set(episodes.flatMap(e => e.nodeIds))].map(id => this.repo.ancestors(id).map(n => n.id));
    return paths[0]?.filter(id => paths.every(p => p.includes(id))).at(-1) ?? this.repo.rootId();
  }
  candidate(category, polarity) {
    oneOf(polarity, ['negative', 'strong'], 'cluster polarity');
    const history = this.repo.list('tree_clusters', c => c.category === category && c.polarity === polarity).sort((a, b) => a.epoch - b.epoch);
    const previous = history.at(-1), all = this.group(category, polarity);
    if (previous?.status === 'candidate') {
      const selected = all.filter(e => previous.episodeIds.includes(e.id));
      if (this.signature(selected) === previous.evidenceHash) return previous;
      // Corrected evidence cannot retain an old pending diagnosis.
      this.repo.command('invalidateClusterCandidate', { requestId: digest(['cluster-stale', previous.id, previous.revision]), expected: { ['tree_clusters:' + previous.id]: previous.revision }, input: { clusterId: previous.id } }, actor, () => {
        this.repo.save('tree_clusters', { ...previous, status: 'stale', needsRecheck: true }, previous.revision); return { clusterId: previous.id };
      });
    }
    const reviewed = history.filter(c => ['common', 'reviewed_none'].includes(c.status) && !c.needsRecheck).at(-1);
    const watermark = reviewed?.reviewWatermark ?? 0, episodes = all.filter(e => e.ordinal > watermark);
    if (episodes.length < 3) return null;
    const epoch = (previous?.epoch ?? 0) + 1, evidenceHash = this.signature(episodes), id = digest(['cluster', category, polarity, epoch, evidenceHash]);
    const controls = polarity === 'strong' ? this.signals.episodes().filter(e => e.state === 'control' && e.category === category && e.nodeIds.some(id => episodes.some(s => s.nodeIds.includes(id)))) : [];
    return this.repo.command('createClusterCandidate', { requestId: id, expected: {}, input: { category, polarity, epoch, evidenceHash } }, actor, () => {
      this.repo.save('tree_clusters', { id, category, polarity, epoch, episodeIds: episodes.map(e => e.id), status: 'candidate', methodIds: [], reviewWatermark: watermark,
        triggerWatermark: Math.max(...episodes.map(e => e.ordinal)), recurrenceCount: reviewed?.recurrenceCount ?? 0, previousClusterId: reviewed?.id ?? null,
        previousMethodIds: reviewed?.methodIds ?? [], evidenceHash, nodeId: this.scope(episodes), controlIds: controls.map(e => e.id), needsRecheck: false }); return { clusterId: id };
    }).result.clusterId && this.repo.get('tree_clusters', id);
  }
  assertCurrent(cluster) {
    const current = this.repo.get('tree_clusters', cluster.id), episodes = this.group(cluster.category, cluster.polarity).filter(e => cluster.episodeIds.includes(e.id));
    if (current?.revision !== cluster.revision || current.status !== 'candidate' || this.signature(episodes) !== cluster.evidenceHash) fail('JOB_STALE', 'Cluster evidence or category correction changed');
    return episodes;
  }
  freeze(cluster) {
    const episodes = this.assertCurrent(cluster), controls = this.signals.episodes().filter(e => cluster.controlIds.includes(e.id));
    return { ...cluster, episodes: episodes.map(e => this.signals.material(e)), controls: controls.map(e => this.signals.material(e)) };
  }
  review({ clusterId, clusterVersion, verdict, commonality, evidence }, { job, requestId, methodIds = [], recurrence = null }) {
    const cluster = this.repo.get('tree_clusters', clusterId);
    if (!cluster || cluster.revision !== clusterVersion) fail('JOB_STALE', 'Cluster version changed');
    this.assertCurrent(cluster); oneOf(verdict, ['common', 'none'], 'cluster verdict');
    if (verdict === 'none' && (methodIds.length || recurrence) || verdict === 'common' && !commonality.trim()) fail('CLUSTER_DIAGNOSIS', 'No common cause cannot create a method or recurrence claim');
    const evidenceSources = evidence.map(id => job.input.sources.find(s => s.id === id));
    if (evidenceSources.some(s => !s)) fail('OUTPUT_REFERENCE', 'Unknown cluster evidence');
    const episodeRefs = this.assertCurrent(cluster).map(e => e.reactionRefs);
    if (episodeRefs.filter(refs => refs.some(ref => evidenceSources.some(s => digest(s.ref) === digest(ref)))).length < 3) fail('CLUSTER_EVIDENCE', 'Diagnosis needs three distinct original episodes');
    if (recurrence && (!cluster.previousMethodIds.includes(recurrence.methodId) || !job.input.knownItems.some(i => i.id === recurrence.methodId && i.version === recurrence.methodVersion) || !recurrence.expectation)) fail('CLUSTER_RECURRENCE', 'Recurrence requires an explicit current method and expectation binding');
    return this.repo.command('reviewCluster', { requestId, expected: { ['tree_clusters:' + cluster.id]: clusterVersion }, input: { clusterId, verdict, commonality, evidence, methodIds, recurrence } }, { kind: 'model', id: job.id, role: 'verification' }, () => {
      this.repo.save('tree_clusters', { ...cluster, status: verdict === 'none' ? 'reviewed_none' : 'common', commonality, evidenceRefs: evidenceSources.map(s => s.ref), methodIds,
        reviewWatermark: cluster.triggerWatermark, recurrence, recurrenceCount: cluster.recurrenceCount + (recurrence ? 1 : 0), needsRecheck: false }, cluster.revision); return { clusterId, verdict };
    }).result;
  }
}
