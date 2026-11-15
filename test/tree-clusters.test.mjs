import test from 'node:test';
import assert from 'node:assert/strict';
import { learningFixture } from './fixtures/tree-learning/helpers.mjs';
import { effectiveSignals, evidenceResolver, EpisodeSignals } from '../src/tree/signals.mjs';
import { ClusterService } from '../src/tree/clusters.mjs';
import { SignalService } from '../src/tree/tree.mjs';
import { digest } from '../src/tree/contracts.mjs';

test('three distinct human episodes trigger a candidate; replay and multi-node do not count twice', async t => {
  const f = learningFixture(t), a = f.create('我写文章'), b = f.create('我做研究');
  const first = await f.feedback(a, 'not_understood', '第一次没理解', [b]);
  const job = f.learning.enqueue(first.turn.id, b); f.complete(job, first.output);
  assert.equal(f.signals.episodes().length, 1); assert.equal(f.clusters.candidate('not_understood', 'negative'), null);
  assert.equal(f.learning.enqueue(first.turn.id, a).id, first.job.id);
  await f.feedback(a, 'not_understood', '第二次没理解'); assert.equal(f.clusters.candidate('not_understood', 'negative'), null);
  await f.feedback(b, 'not_understood', '第三次没理解');
  const candidate = f.clusters.candidate('not_understood', 'negative'); assert.equal(candidate.episodeIds.length, 3); assert.equal(candidate.nodeId, f.repo.rootId());
  assert.equal(f.clusters.candidate('not_understood', 'negative').id, candidate.id);
});

test('none preserves all history and waits for three new episodes instead of repeating old evidence', async t => {
  const f = learningFixture(t), a = f.create('我完成解释');
  for (let i = 0; i < 3; i++) await f.feedback(a, 'misread', '不同原因' + i);
  const c = f.clusters.candidate('misread', 'negative'), frozen = f.clusters.freeze(c), sources = frozen.episodes.flatMap(e => e.sources), evidence = frozen.episodes.map(e => e.sources.find(s => s.role === 'user').id);
  f.clusters.review({ clusterId: c.id, clusterVersion: c.revision, verdict: 'none', commonality: '', evidence }, { job: { id: 'review-synthetic', input: { sources } }, requestId: 'none' });
  assert.equal(f.clusters.candidate('misread', 'negative'), null);
  for (let i = 0; i < 2; i++) await f.feedback(a, 'misread', '新事件' + i);
  assert.equal(f.clusters.candidate('misread', 'negative'), null);
  await f.feedback(a, 'misread', '第六事件'); const next = f.clusters.candidate('misread', 'negative');
  assert.equal(next.epoch, 2); assert.equal(next.episodeIds.length, 3); assert.equal(f.signals.episodes().length, 6); assert.equal(f.repo.get('tree_clusters', c.id).status, 'reviewed_none');
});

test('user category correction invalidates pending cluster and counts only the latest branch', async t => {
  const f = learningFixture(t), a = f.create('我比较方案');
  for (let i = 0; i < 3; i++) await f.feedback(a, 'misread', '反馈' + i);
  const c = f.clusters.candidate('misread', 'negative'), old = effectiveSignals(f.repo)[0]; f.asUser();
  const service = new SignalService({ repository: f.repo, resolveSource: f.resolveSource, context: () => f.context });
  const replacement = Object.fromEntries(['eventId', 'subjectRefs', 'dimension', 'subitem', 'category', 'polarity', 'evidenceKind', 'sourceRefs', 'nodeIds', 'confidence'].map(k => [k, old[k]]));
  service.correct(f.cmd({ signalId: old.id, replacement: { ...replacement, category: 'approved', polarity: 'strong' } }, f.expected('tree_signals', old.id)));
  assert.throws(() => f.clusters.assertCurrent(c), { code: 'JOB_STALE' }); assert.equal(f.clusters.candidate('misread', 'negative'), null);
  assert.equal(effectiveSignals(f.repo).length, 3); assert.equal(effectiveSignals(f.repo).filter(s => s.category === 'misread').length, 2);
  assert.equal(f.repo.list('tree_signals').length, 4);
});

test('weak progress never triggers a positive cluster; strong approval retains separate controls', async t => {
  const f = learningFixture(t), a = f.create('我选方案');
  for (let i = 0; i < 3; i++) await f.feedback(a, 'proceeded');
  assert.equal(f.clusters.candidate('proceeded', 'strong'), null);
  for (let i = 0; i < 3; i++) await f.feedback(a, 'approved');
  const turn = f.experience.turns(a).at(-1), source = f.experience.material(turn).sources.find(s => s.role === 'assistant' && s.origin === 'model');
  f.signals.control({ proposalRef: source.ref, responseRefs: [], nodeIds: [a], category: 'approved', outcome: 'unknown', requestId: 'control' });
  assert.throws(() => f.signals.control({ proposalRef: source.ref, responseRefs: [], nodeIds: [a], category: 'approved', outcome: 'rejected', requestId: 'bad-control' }), { code: 'SOURCE_REQUIRED' });
  const c = f.clusters.candidate('approved', 'strong'), view = f.clusters.freeze(c); assert.equal(view.episodes.length, 3); assert.equal(view.controls[0].outcome, 'unknown');
});

test('cluster commonality needs three source episodes; same category cannot manufacture recurrence', async t => {
  const f = learningFixture(t), a = f.create('我解释机制');
  for (let i = 0; i < 3; i++) await f.feedback(a, 'not_understood');
  const c = f.clusters.candidate('not_understood', 'negative'), frozen = f.clusters.freeze(c), sources = frozen.episodes.flatMap(e => e.sources), evidence = frozen.episodes.map(e => e.sources.find(s => s.role === 'user').id), job = { id: 'review', input: { sources, knownItems: [] } };
  const output = { clusterId: c.id, clusterVersion: c.revision, verdict: 'common', commonality: '先出现名词后解释', evidence };
  assert.throws(() => f.clusters.review({ ...output, evidence: evidence.slice(0, 1) }, { job, requestId: 'bad-evidence' }), { code: 'CLUSTER_EVIDENCE' });
  assert.throws(() => f.clusters.review(output, { job, requestId: 'bad-recurrence', recurrence: { methodId: 'invented', methodVersion: 1, expectation: 'less' } }), { code: 'CLUSTER_RECURRENCE' });
  f.clusters.review(output, { job, requestId: 'common' }); assert.equal(f.repo.get('tree_clusters', c.id).recurrenceCount, 0);
});

test('actual user confirmation receipts form strong UI episodes without forged chat or duplicate confirmation', t => {
  const f = learningFixture(t), node = f.create('我确认几条推断'), resolveSource = evidenceResolver(f.repo, f.resolveSource), signals = new EpisodeSignals({ repository: f.repo, resolveSource, experience: f.experience }), clusters = new ClusterService({ repository: f.repo, signals });
  for (let i = 0; i < 3; i++) {
    f.asModel('learning', [node]); const id = f.propose(node, { understandings: [{ content: '合成推断' + i, source: 'assistant_inferred', sourceRefs: [f.ref] }] }).understandings.itemIds[0];
    f.asUser(); const episode = f.repo.transaction(() => { const receipt = f.items.confirm(f.cmd({ itemId: id, version: 1 }, f.expected('tree_items', id))); return signals.captureConfirmation(receipt.id); });
    assert.equal(signals.captureConfirmation(episode.confirmationRef).id, episode.id); assert.equal(resolveSource(episode.reactionRefs[0]).origin, 'ui');
    const again = f.repo.transaction(() => { const receipt = f.items.confirm(f.cmd({ itemId: id, version: 2 }, f.expected('tree_items', id))); return signals.captureConfirmation(receipt.id); }); assert.equal(again, null);
  }
  assert.equal(signals.episodes().length, 3); const candidate = clusters.candidate('confirmed_inference', 'strong'); assert.equal(candidate.episodeIds.length, 3);
  const frozen = clusters.freeze(candidate); assert.ok(frozen.episodes.every(e => e.sources[0].origin === 'ui'));
});

test('episode preceding answer belongs to the same goal and follows later assignment corrections', async t => {
  const f = learningFixture(t), a = f.create('我复查公开目标'), hidden = f.create('我处理私人目标');
  const privateTurn = await f.feedback(hidden, 'proceeded', '私人目标的合成内容');
  const first = await f.feedback(a, 'misread', '公开目标反馈一'); await f.feedback(a, 'misread', '公开目标反馈二'); await f.feedback(a, 'misread', '公开目标反馈三');
  const episode = f.signals.episodes().find(e => e.turnId === first.turn.id); assert.deepEqual(episode.beforeRefs, []);
  const candidate = f.clusters.candidate('misread', 'negative'), view = f.clusters.freeze(candidate);
  assert.ok(view.episodes.every(e => e.sources.every(s => s.origin !== 'tool-call' && s.role !== 'tool')));
  const privateRefs = f.experience.material(privateTurn.turn).sources.map(s => digest(s.ref));
  assert.ok(view.episodes.every(e => e.sources.every(s => !privateRefs.includes(digest(s.ref)))));
  f.asUser(); f.tree.correctAssignment(f.cmd({ turnId: first.turn.id, nodeIds: [hidden], sourceRefs: [] }, f.expected('tree_turns', first.turn.id)));
  assert.throws(() => f.clusters.assertCurrent(candidate), { code: 'JOB_STALE' });
  const second = f.signals.episodes().find(e => e.beforeTurnId === first.turn.id); assert.deepEqual(second.beforeRefs, []);
});
