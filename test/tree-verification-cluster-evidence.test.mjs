import test from 'node:test';
import assert from 'node:assert/strict';
import { learningFixture, emptyVerification } from './fixtures/tree-learning/helpers.mjs';
import { TreeModelOwner } from '../src/tree/model-owner.mjs';
import { TreeJobs } from '../src/tree/jobs.mjs';
import { TreeRepository } from '../src/tree/repository.mjs';
import { VerificationService } from '../src/tree/verification.mjs';
import { CONTRACT, digest, fail } from '../src/tree/contracts.mjs';
import { requireClusterReactions } from '../src/tree/cluster-evidence.mjs';
import { join } from 'node:path';

const target = 'not_understood', second = 'misread';
const wire = out => ({ role: 'assistant', content: [{ type: 'text', text: JSON.stringify(out) }] });
const proposal = (verdict, evidence = verdict.evidence) => ({
  content: '合成的共同理解', source: 'assistant_inferred', sourceIds: evidence, origin: 'cluster:' + verdict.clusterId,
});
const method = (verdict, evidence = verdict.evidence) => ({
  kind: 'collaboration', short: { situation: '介绍新概念时', action: '先介绍实例', basis: '合成反馈', notApplicable: '' }, long: null,
  hooks: [], scriptRequests: [], expectedEffect: { category: target, change: 'less', text: '减少没听明白的反馈' },
  origin: 'cluster:' + verdict.clusterId, sourceIds: evidence,
});

async function sample(t, categories = [target]) {
  const f = learningFixture(t), node = f.create('我讲清楚一个合成概念');
  for (const category of categories) for (let i = 0; i < 3; i++) await f.feedback(node, category, `合成反馈 ${category} ${i}`);
  const clusters = categories.map(category => f.clusters.candidate(category, 'negative'));
  const service = new VerificationService({ repository: f.repo, experience: f.experience, contextBuilder: f.builder, jobs: f.jobs, modelConfig: f.config, clusters: f.clusters });
  const job = service.enqueue(node, { reason: 'cluster', clusterIds: clusters.map(c => c.id) });
  const verdicts = job.input.clusters.map(c => ({
    clusterId: c.id, clusterVersion: c.revision, verdict: 'common', commonality: '合成共同问题',
    evidence: c.episodes.map(e => job.input.sources.find(s => digest(s.ref) === digest(e.reactionRefs[0])).id),
  }));
  const other = job.input.sources.filter(s => verdicts.every(v => !v.evidence.includes(s.id))).slice(0, 2).map(s => s.id);
  assert.equal(other.length, 2);
  return { ...f, node, service, job, verdicts, other, apply: (...args) => service.applyResult(...args) };
}
function receive(f, job, result) {
  f.jobs.prepare(job.id); f.jobs.submit(job.id);
  const inv = f.jobs.admitInvocation(job.id, { turn: 1, step: 1, stepStartSeq: 1, requestHash: digest(['synthetic-reply', job.id]), allowedTools: [] });
  const invocation = f.jobs.invocationResult(inv.id, { state: 'result_received', resultHash: digest(result), nativeLogRef: 'synthetic#4', usage: { inputTokens: 60, outputTokens: 40 } });
  const received = f.jobs.receive(job.id, { message: wire(result), nativeLogRef: 'synthetic#5', eventsHash: digest(['synthetic-events', result]) });
  return { invocation, received };
}
function oldValidation(f, job, raw, code = 'CLUSTER_EVIDENCE') {
  f.jobs.transition(job.id, 'validated', { validatedResult: raw, outputEnvelope: { schemaVersion: CONTRACT, jobId: job.id, inputHash: job.inputHash, result: raw }, rejectedItems: [] });
  return f.jobs.recordError(job.id, { code, message: 'original synthetic apply error' });
}
function rejectedResult(f) {
  const bad = { ...f.verdicts[0], evidence: f.other };
  return { ...emptyVerification(), clusters: [bad], proposals: { understandings: [proposal(bad)], methods: [method(bad)] } };
}
function mixedResult(f) {
  const raw = rejectedResult(f), good = f.verdicts[1];
  raw.clusters.push(good);
  raw.proposals.understandings.push({ content: '一条独立的练习认识', source: 'assistant_inferred', sourceIds: good.evidence, origin: 'routine' });
  raw.proposals.methods.push(method(good));
  return raw;
}

test('a reply citing real but unrelated sources ends invalid with no writes and a following verification can commit', async t => {
  const f = await sample(t), raw = rejectedResult(f), { received } = receive(f, f.job, raw);
  const after = f.jobs.validate(f.job.id);
  assert.equal(after.status, 'invalid_output'); assert.equal(after.error.code, 'CLUSTER_EVIDENCE');
  assert.equal(after.leaseOwner, null); assert.deepEqual(after.rawMessage, wire(raw)); assert.equal(after.resultHash, received.resultHash);
  assert.deepEqual(after.rejectedItems.map(i => [i.item, i.code]), [
    ['clusters[0]', 'CLUSTER_EVIDENCE'], ['proposals.understandings[0]', 'CLUSTER_PROPOSAL'], ['proposals.methods[0]', 'CLUSTER_PROPOSAL'],
  ]);
  assert.equal(f.repo.list('tree_items').length, 0);
  assert.equal(f.repo.get('tree_clusters', f.verdicts[0].clusterId).status, 'candidate');
  await f.turn(f.node, '合成下一轮');
  const next = f.service.enqueue(f.node, { reason: 'window' });
  receive(f, next, emptyVerification());
  assert.equal(f.jobs.validate(next.id).status, 'validated');
  assert.equal(f.jobs.commit(next.id, f.apply).status, 'committed');
});

test('one bad verdict and its dependent proposals do not stop a valid verdict and an independent proposal from being written', async t => {
  const f = await sample(t, [target, second]), raw = mixedResult(f);
  receive(f, f.job, raw);
  const validated = f.jobs.validate(f.job.id);
  assert.deepEqual(validated.validatedResult.clusters, [f.verdicts[1]]);
  assert.deepEqual(validated.rejectedItems.map(i => i.code), ['CLUSTER_EVIDENCE', 'CLUSTER_PROPOSAL', 'CLUSTER_PROPOSAL']);
  assert.equal(f.jobs.commit(f.job.id, f.apply).status, 'committed');
  const [bad, good] = f.verdicts.map(v => f.repo.get('tree_clusters', v.clusterId));
  assert.equal(bad.status, 'candidate'); assert.deepEqual(bad.methodIds, []);
  assert.equal(good.status, 'common'); assert.equal(good.methodIds.length, 1);
  assert.deepEqual(f.repo.list('tree_items').map(i => i.kind).sort(), ['method', 'understanding']);
});

test('matching counts both distinct original episodes and distinct reactions, not repeated or unrelated refs', () => {
  const [a, b, c, unrelated] = ['a', 'b', 'c', 'other'].map((value, seq) => ({ sessionId: 'fixture', seq, sha256: digest(value) }));
  const episodes = [{ id: 'one', reactionRefs: [a, b] }, { id: 'two', reactionRefs: [a] }, { id: 'three', reactionRefs: [c], beforeRefs: [unrelated] }];
  assert.throws(() => requireClusterReactions(episodes, [a, a, c]), { code: 'CLUSTER_EVIDENCE' });
  assert.throws(() => requireClusterReactions(episodes, [a, b, unrelated]), { code: 'CLUSTER_EVIDENCE' });
  assert.throws(() => requireClusterReactions([{ ...episodes[0], reactionRefs: [b] }, { ...episodes[1], id: 'one' }, episodes[2]], [a, b, c]), { code: 'CLUSTER_EVIDENCE' });
  requireClusterReactions(episodes, [a, b, c]);
});

for (const mode of ['invalid', 'salvage', 'stale']) test(`restart rechecks a durable legacy evidence failure once, without touching model or usage (${mode})`, async t => {
  const f = await sample(t, mode === 'salvage' ? [target, second] : [target]), raw = mode === 'salvage' ? mixedResult(f) : rejectedResult(f);
  const { invocation, received } = receive(f, f.job, raw), old = oldValidation(f, f.job, raw);
  const repository = new TreeRepository({ treeFilename: join(f.dir, 'tree.sqlite'), userId: 'fixture-user' }); t.after(() => repository.close());
  if (mode === 'stale') f.revoked.add(digest(f.job.input.sources.find(s => s.id === f.verdicts[0].evidence[0]).ref));
  const jobs = new TreeJobs({ repository, assertSources: rows => rows.every(s => Boolean(f.resolveSource(s.ref))) });
  // The existing fixture services use the original connection. Use the same
  // restarted connection for atomic application, with production apply unchanged.
  const apply = (...args) => {
    if (mode !== 'salvage') assert.fail('invalid or stale output cannot enter application');
    const clusters = Object.assign(Object.create(Object.getPrototypeOf(f.service.clusters)), f.service.clusters, { repo: repository });
    const service = Object.assign(Object.create(VerificationService.prototype), f.service, { repo: repository, jobs, clusters });
    return service.applyResult(...args);
  };
  const sessions = new Map(), owner = new TreeModelOwner({ jobs, applyResult: apply, host: { sessions }, ledgerLookup: () => assert.fail('existing usage must not be read again') });
  owner.readEvents = () => assert.fail('durable result does not need the old native log');
  if (mode === 'invalid') {
    sessions.set(old.nativeSessionId, {});
    const [live] = await owner.recover();
    assert.equal(live.error, 'LIVE_SESSION');
    assert.deepEqual(jobs.get(f.job.id), old);
    sessions.clear();
  }
  const [recovered] = await owner.recover();
  const status = { invalid: 'invalid_output', salvage: 'committed', stale: 'stale' }[mode];
  assert.equal(recovered.status, status); assert.equal(jobs.get(f.job.id).status, status);
  assert.deepEqual(recovered.clusterEvidenceRecheck.previousError, old.error);
  for (const key of ['rawMessage', 'resultHash', 'nativeLogRef', 'eventsHash', 'invocationIds']) assert.deepEqual(recovered[key], received[key]);
  assert.deepEqual(repository.get('tree_invocations', invocation.id), invocation);
  assert.deepEqual(await owner.recover(), []);
  if (mode === 'salvage') assert.equal(repository.get('tree_clusters', f.verdicts[1].clusterId).status, 'common');
  if (mode === 'invalid') assert.equal(recovered.rejectedItems[0].code, 'CLUSTER_EVIDENCE');
});

test('an unrelated application failure leaves its validated output recoverable', async t => {
  const f = await sample(t), raw = { ...emptyVerification(), clusters: f.verdicts };
  receive(f, f.job, raw);
  assert.equal(f.jobs.validate(f.job.id).status, 'validated');
  assert.throws(() => f.jobs.commit(f.job.id, () => fail('FIXTURE_IO', 'temporary synthetic write error')), { code: 'FIXTURE_IO' });
  const old = f.jobs.recordError(f.job.id, { code: 'FIXTURE_IO', message: 'temporary synthetic write error' });
  assert.deepEqual(f.jobs.validate(f.job.id), old);
  assert.equal(f.jobs.commit(f.job.id, f.apply).status, 'committed');
});
