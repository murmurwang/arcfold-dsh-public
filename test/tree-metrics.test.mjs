import test from 'node:test';
import assert from 'node:assert/strict';
import { learningFixture, emptyLearning } from './fixtures/tree-learning/helpers.mjs';
import { MetricsService, ReflectionTriggers, METRIC_VERSION } from '../src/tree/metrics.mjs';
import { VerificationService } from '../src/tree/verification.mjs';
import { SignalService } from '../src/tree/tree.mjs';
import { digest } from '../src/tree/contracts.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SnapshotService } from '../src/tree/snapshots.mjs';
import { FixtureWorkspaceIO } from './fixtures/tree-scripts/helpers.mjs';
import { bindTurnSnapshot } from '../src/tree/ui.mjs';

const metric = f => new MetricsService({ repository: f.repo, experience: f.experience, signals: f.signals });

test('a completed restore counts only for its source-bound file result, never an unrelated fragment', async t => {
  const f = learningFixture(t), a = f.create('我恢复合成文稿'), turn = await f.turn(a), m = metric(f);
  const workspace = join(f.dir, 'metric-workspace'), storageRoot = join(f.dir, 'metric-snapshots'), runtimeRoot = join(f.dir, 'metric-workers'); for (const path of [workspace, storageRoot, runtimeRoot]) mkdirSync(path);
  f.asUser(); f.context.sessionPolicy = { mode: 'workspace-write', workspaceRoot: workspace };
  const io = new FixtureWorkspaceIO({ workspace, runtimeRoot, protectedRoots: [f.repo.filename] }), snapshots = new SnapshotService({ repository: f.repo, workspace, storageRoot, runtimeRoot, io, allowUnconfinedFixture: true, protectedRoots: [f.repo.filename], context: () => f.context });
  writeFileSync(join(workspace, 'draft.txt'), '原稿'); const saved = await snapshots.capture({ requestId: 'metric-before', reason: 'main_turn' }); bindTurnSnapshot(f.repo, saved.id, turn.id); writeFileSync(join(workspace, 'draft.txt'), '需要重做的稿件');
  const source = f.experience.material(turn).sources.find(s => s.role === 'assistant' && s.origin === 'model');
  m.fragment({ firstResultRef: source.ref, nodeIds: [a], fragmentKey: '无文件的建议', outputPaths: [], requestId: 'unrelated' });
  const preview = await snapshots.preview({ snapshotId: saved.id, paths: ['draft.txt'], requestId: 'preview' }); assert.equal(m.freeze(a).observations.rates.firstPass.value, null);
  const restored = await snapshots.apply({ previewId: preview.id, expectedCurrentHashes: preview.expectedCurrentHashes, requestId: 'confirmed', signal: new AbortController().signal }); assert.equal(restored.state, 'completed');
  assert.equal(m.freeze(a).observations.restores, 1); assert.equal(m.freeze(a).observations.unboundRestores, 1); assert.equal(m.freeze(a).observations.rates.firstPass.value, null);
  m.fragment({ firstResultRef: source.ref, nodeIds: [a], fragmentKey: '文稿的首次结果', outputPaths: ['draft.txt'], requestId: 'file-result' });
  assert.equal(m.freeze(a).observations.rates.firstPass.denominator, 1); assert.equal(m.freeze(a).observations.rates.firstPass.value, 0); assert.equal(m.freeze(a).observations.unboundRestores, 0);
});

test('global recent-100 window excludes earlier tree activity and avoids invented historical lifecycle state', async t => {
  const f = learningFixture(t), a = f.create('我持续观察'), m = metric(f), before = f.repo.list('tree_nodes');
  f.asUser(); const old = f.tree.setStatus(f.cmd({ nodeId: a, status: 'paused', sourceRefs: [] }, f.expected('tree_nodes', a))); m.observeTree(old, before);
  for (let i = 0; i < 101; i++) await f.turn(a, '合成持续轮次' + i);
  const current = m.freeze(); assert.equal(current.observations.logicalTurns, 100); assert.equal(current.observations.growth.raw, 0); assert.equal(current.observations.growth.assignedNodesPer100Turns, 1);
  assert.equal(m.freeze(null, { throughOrdinal: current.toOrdinal - 1 }).observations.learningInventory.historicalStateMissing, true);
});

test('zero opportunities stay null and missing observations are not silently successful', t => {
  const f = learningFixture(t), m = metric(f), window = m.freeze();
  assert.equal(window.observations.userMessages, 0);
  for (const value of Object.values(window.observations.rates)) { assert.equal(value.value, null); assert.equal(value.interval, null); assert.equal(value.denominator, 0); }
});

test('hook recovery is separate from human feedback and an immediate omission correction is not counted twice', async t => {
  const f = learningFixture(t), a = f.create('我补齐遗漏'), first = await f.turn(a), m = metric(f);
  f.complete(f.learning.enqueue(first.id, a), emptyLearning());
  f.repo.command('fixtureHookOutcomes', f.cmd({}), { kind: 'program', id: 'fixture' }, () => {
    for (const [id, hookId, methodId, status, eventOrdinal] of [['miss', 'h1', 'm1', 'needs_action', 1], ['recovered', 'h1', 'm1', 'pass', 2], ['still-missing', 'h2', 'm2', 'needs_action', 3]]) f.repo.save('tree_hook_runs', { id, logicalTurnId: first.id, eventKey: 'turn_end:' + eventOrdinal, methodId, hookId, version: 1, scopeEpoch: 1, inputHash: digest(id), result: { status }, continuationCycle: eventOrdinal, observedAt: f.repo.now(), eventOrdinal }); return {};
  });
  assert.equal(m.freeze(a).observations.hookRecovered, 1); assert.equal(m.freeze(a).observations.hookOmissionCandidates, 1); assert.equal(m.freeze(a).observations.rates.negativeFeedback.numerator, 0);
  await f.feedback(a, 'omitted', '你还漏了第二项'); const observations = m.freeze(a).observations;
  assert.equal(observations.hookRecovered, 1); assert.equal(observations.hookOmissionCandidates, 0); assert.equal(observations.counts.omitted, 1);
});

test('one human message with several negative categories and two goals counts once globally', async t => {
  const f = learningFixture(t), a = f.create('我讨论甲'), b = f.create('我讨论乙'), turn = await f.turn(a, '你没听懂，也误解了我的意思', 'native-main', [b]);
  for (const node of [a, b]) {
    const job = f.learning.enqueue(turn.id, node), s = job.input.sources.find(s => s.role === 'user');
    f.complete(job, { understandings: [], methods: [], revisions: [], supplements: [], categories: ['not_understood', 'misread'].map(category => ({ category, note: '合成分类', sourceId: s.id, subjectIds: [] })) });
  }
  const global = metric(f).freeze(), local = metric(f).freeze(a);
  assert.equal(global.observations.userMessages, 1); assert.equal(global.observations.rates.understandingProblems.numerator, 1); assert.equal(local.observations.rates.understandingProblems.value, 1);
});

test('category correction invalidates a saved window and recomputes historical derived counts', async t => {
  const f = learningFixture(t), a = f.create('我纠正分类'); await f.feedback(a, 'misread'); const m = metric(f), before = m.saveWindow(a), signal = f.repo.list('tree_signals')[0];
  f.asUser(); const service = new SignalService({ repository: f.repo, resolveSource: f.resolveSource, context: () => f.context });
  const replacement = Object.fromEntries(['eventId','subjectRefs','dimension','subitem','category','polarity','evidenceKind','sourceRefs','nodeIds','confidence'].map(k => [k, signal[k]]));
  service.correct(f.cmd({ signalId: signal.id, replacement: { ...replacement, category: 'approved', polarity: 'strong' } }, f.expected('tree_signals', signal.id)));
  assert.equal(f.repo.get('tree_metric_windows', before.id).needsRecheck, true);
  const after = m.freeze(a, { throughOrdinal: before.toOrdinal }); assert.equal(after.observations.counts.misread, 0); assert.equal(after.observations.counts.approved, 1); assert.notEqual(after.id, before.id);
});

test('unanswered proposals are unknown; only source-bound adopted and rejected decisions enter denominator', async t => {
  const f = learningFixture(t), a = f.create('我选择提议'), m = metric(f), first = await f.turn(a, '列两个建议'), second = await f.turn(a, '第一个采用'), third = await f.turn(a, '再给一个建议'), fourth = await f.turn(a, '这个暂不采用');
  const ref = turn => f.experience.material(turn).sources.find(s => s.role === 'assistant' && s.origin === 'model').ref;
  const one = m.proposal({ proposalRef: ref(first), nodeIds: [a], requestId: 'proposal-one' }), two = m.proposal({ proposalRef: ref(third), nodeIds: [a], requestId: 'proposal-two' });
  assert.equal(m.freeze(a).observations.rates.adoption.value, null); const boundary = f.repo.meta().lastEventOrdinal;
  m.respond({ proposalId: one.proposalId, outcome: 'adopted', responseRefs: second.userSourceRefs, requestId: 'response-one' });
  m.respond({ proposalId: two.proposalId, outcome: 'rejected', responseRefs: fourth.userSourceRefs, requestId: 'response-two' });
  const rate = m.freeze(a).observations.rates.adoption; assert.equal(rate.numerator, 1); assert.equal(rate.denominator, 2); assert.equal(rate.value, 0.5);
  assert.equal(m.freeze(a, { throughOrdinal: boundary }).observations.rates.adoption.value, null);
});

test('proposal outcomes cannot use assistant text or a response in another goal', async t => {
  const f = learningFixture(t), a = f.create('我收到建议'), b = f.create('我讨论私事'), m = metric(f), first = await f.turn(a), other = await f.turn(b);
  const source = f.experience.material(first).sources.find(s => s.role === 'assistant' && s.origin === 'model'), p = m.proposal({ proposalRef: source.ref, nodeIds: [a], requestId: 'proposal' });
  assert.throws(() => m.respond({ proposalId: p.proposalId, outcome: 'adopted', responseRefs: [source.ref], requestId: 'fake-user' }), { code: 'USER_SOURCE_REQUIRED' });
  assert.throws(() => m.respond({ proposalId: p.proposalId, outcome: 'adopted', responseRefs: other.userSourceRefs, requestId: 'other-goal' }), { code: 'PROPOSAL_SCOPE' });
  assert.throws(() => m.respond({ proposalId: p.proposalId, outcome: 'adopted', responseRefs: first.userSourceRefs, requestId: 'earlier-message' }), { code: 'RESPONSE_ORDER' });
});

test('a fragment needing redo never becomes a first-pass success when the user later proceeds', async t => {
  const f = learningFixture(t), a = f.create('我修改文稿'), m = metric(f), first = await f.turn(a, '请给出第一稿'); f.complete(f.learning.enqueue(first.id, a), emptyLearning());
  const redo = await f.feedback(a, 'redo', '这一段要重做'), proceed = await f.feedback(a, 'proceeded', '改后可以，继续');
  const firstResultRef = f.experience.material(first).sources.find(s => s.role === 'assistant' && s.origin === 'model').ref;
  assert.equal(m.freeze(a).observations.rates.firstPass.value, null); assert.equal(m.freeze(a).missing.unboundFirstAttemptFeedback, 2);
  const { fragmentId } = m.fragment({ firstResultRef, nodeIds: [a], fragmentKey: '第一段', requestId: 'fragment' });
  m.fragmentFeedback({ fragmentId, responseRefs: [...redo.turn.userSourceRefs, ...proceed.turn.userSourceRefs], requestId: 'feedback' });
  const rate = m.freeze(a).observations.rates.firstPass; assert.equal(rate.denominator, 1); assert.equal(rate.numerator, 0);
});

test('two distinct proposal spans in one answer retain separate outcomes', async t => {
  const f = learningFixture(t), a = f.create('我比较建议'), m = metric(f), first = await f.turn(a), response = await f.turn(a, '采用第一个，第二个先不做');
  const source = f.experience.material(first).sources.find(s => s.role === 'assistant' && s.origin === 'model');
  const one = m.proposal({ proposalRef: source.ref, start: 0, end: 1, nodeIds: [a], requestId: 'span-one' }), two = m.proposal({ proposalRef: source.ref, start: 1, end: 2, nodeIds: [a], requestId: 'span-two' });
  assert.notEqual(one.proposalId, two.proposalId);
  m.respond({ proposalId: one.proposalId, outcome: 'adopted', responseRefs: response.userSourceRefs, requestId: 'adopt' });
  m.respond({ proposalId: two.proposalId, outcome: 'rejected', responseRefs: response.userSourceRefs, requestId: 'reject' });
  assert.equal(m.freeze(a).observations.rates.adoption.value, 0.5);
});

test('only adjacent comparable windows with at least ten settled turns expose a trend', async t => {
  const f = learningFixture(t), a = f.create('我比较合作情况'), m = metric(f);
  for (let i = 0; i < 10; i++) await f.feedback(a, i < 3 ? 'misread' : 'proceeded', '前窗口' + i);
  const first = m.saveWindow(a); for (let i = 0; i < 10; i++) await f.feedback(a, i < 1 ? 'misread' : 'proceeded', '后窗口' + i);
  const second = m.saveWindow(a, { afterOrdinal: first.toOrdinal }), trend = m.compare(first, second);
  assert.equal(trend.comparable, true); assert.ok(trend.trends.understandingProblems.delta < 0);
  assert.equal(m.compare(first, { ...second, algorithmVersion: METRIC_VERSION + '-other' }).comparable, false);
  assert.equal(m.compare(first, { ...second, fromOrdinal: first.toOrdinal + 1 }).comparable, false);
  assert.equal(m.compare(first, { ...second, observations: { ...second.observations, logicalTurns: 9 } }).comparable, false);
});

test('stagnation is only a review candidate with actual per-turn refs, never a change to node status', async t => {
  const f = learningFixture(t), a = f.create('我深入一个复杂问题'), m = metric(f);
  for (let i = 0; i < 10; i++) await f.feedback(a, 'proceeded', '继续推敲' + i);
  const candidate = m.stagnation(a); assert.equal(candidate.status, 'candidate_only'); assert.equal(candidate.progress.length, 10); assert.ok(candidate.progress.every(p => p.sourceRefs.length)); assert.equal(f.repo.get('tree_nodes', a).status, 'active');
  const turnId = candidate.turnIds.at(-1); f.repo.command('fixtureConfirmedOutput', f.cmd({ turnId }), { kind: 'program', id: 'fixture' }, () => { const meta = f.repo.meta(); meta.progressEvidence[turnId].confirmedOutputs = ['synthetic-output']; f.repo.save('tree_meta', meta, meta.revision); return {}; });
  assert.equal(m.stagnation(a), null);
});

test('tree growth shows raw changes but excludes cascading and reversed status changes', t => {
  const f = learningFixture(t), a = f.create('我完成父目标'), b = f.create('我完成子目标', a), m = metric(f), before = f.repo.list('tree_nodes');
  f.asUser(); const completed = f.tree.setStatus(f.cmd({ nodeId: a, status: 'completed', sourceRefs: [] }, f.expected('tree_nodes', a))); m.observeTree(completed, before);
  let growth = m.growth(); assert.equal(growth.raw, 2); assert.equal(growth.confirmedUserChanges, 1); assert.equal(growth.observations.find(o => o.nodeId === b).origin, 'cascade');
  const completedNodes = f.repo.list('tree_nodes'), reopened = f.tree.setStatus(f.cmd({ nodeId: a, status: 'active', sourceRefs: [] }, f.expected('tree_nodes', a))); m.observeTree(reopened, completedNodes);
  growth = m.growth(); assert.equal(growth.raw, 3); assert.equal(growth.confirmedUserChanges, 1); assert.equal(growth.valueJudgment, null);
});

test('unretracted attribution creation remains explicitly weak after a later real user turn', async t => {
  const f = learningFixture(t), m = metric(f), before = f.repo.list('tree_nodes'); f.asModel('attribution');
  const receipt = f.tree.applyAttribution(f.cmd({ sessionId: 'creation-fixture', nativeTurn: 1, sourceRefs: [f.ref], userSourceRefs: [f.ref], actions: [{ action: 'create', name: '我开始合成新事项' }], statusChanges: [] })); m.observeTree(receipt, before); const node = receipt.result.nodeIds[0];
  assert.equal(m.growth().weakUnretractedCreations, 0); await f.turn(node);
  const growth = m.growth(); assert.equal(growth.weakUnretractedCreations, 1); assert.equal(growth.confirmedUserChanges, 0); assert.equal(growth.valueJudgment, null);
});

test('cluster and stagnation trigger scans keep durable identities instead of duplicating jobs', async t => {
  const f = learningFixture(t), a = f.create('我反复解释'), m = metric(f);
  for (let i = 0; i < 10; i++) await f.feedback(a, i < 3 ? 'not_understood' : 'proceeded', '合成经历' + i);
  const verification = new VerificationService({ repository: f.repo, experience: f.experience, contextBuilder: f.builder, jobs: f.jobs, modelConfig: f.config, clusters: f.clusters });
  const triggers = new ReflectionTriggers({ repository: f.repo, metrics: m, clusters: f.clusters, verification });
  const first = triggers.scan(a), second = triggers.scan(a); assert.equal(first.length, 2); assert.deepEqual(second.map(j => j.id), first.map(j => j.id)); assert.equal(f.repo.list('tree_jobs', j => j.role === 'verification').length, 2);
});
