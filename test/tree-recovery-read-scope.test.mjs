import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { learningFixture } from './fixtures/tree-learning/helpers.mjs';
import { TreeRuntime } from '../src/tree/runtime.mjs';
import { TreeRepository } from '../src/tree/repository.mjs';
import { TreeJobs } from '../src/tree/jobs.mjs';
import { StartupTiming } from '../src/startup-timing.mjs';

// Only the native model/worker boundary is replaced. Recovery, afterCommit,
// source validation, episode/cluster construction and enqueue all stay real.
function runtimeFor(f, repo = f.repo, optimized = true) {
  const jobs = new TreeJobs({ repository: repo, assertSources: () => true });
  const host = { sessions: { get: () => undefined }, sessionPersistence: { open: async id => ({ read: async () => ({ events: f.logs.get(id) ?? [] }), close: async () => {} }) } };
  const runtime = new TreeRuntime({ repository: repo, host, createUserMessage: x => x, defineTool: x => x, modelConfig: f.config, jobs,
    owner: { recover: async () => [], close: async () => {} } });
  // Keep any new jobs durably queued for comparison, without starting a model.
  runtime.scanPending = true;
  if (!optimized) for (const object of [runtime, runtime.signals, runtime.metrics, runtime.triggers]) object.readScope = null;
  return runtime;
}
async function history(t, count) {
  const f = learningFixture(t), node = f.repo.rootId();
  for (let i = 0; i < count; i++) await f.feedback(node, 'misread', `合成原文${i}：` + '保持原文边界。'.repeat(20));
  return f;
}

test('real recovery keeps the same jobs, cluster decisions and trigger ownership as uncached recovery', async t => {
  const f = await history(t, 10), filename = join(f.dir, 'uncached.sqlite'); copyFileSync(f.repo.filename, filename);
  const other = new TreeRepository({ treeFilename: filename, userId: f.repo.userId }); t.after(() => other.close());
  const clock = () => '2026-11-25T00:00:00.000Z'; f.repo.now = clock; other.now = clock;
  const cached = runtimeFor(f), reference = runtimeFor(f, other, false);
  await cached.recover(); await reference.recover();
  assert.deepEqual(f.repo.list('tree_jobs'), other.list('tree_jobs'));
  assert.deepEqual(f.repo.list('tree_clusters'), other.list('tree_clusters'));
  assert.deepEqual(f.repo.meta().reflectionTriggers, other.meta().reflectionTriggers);
  assert.ok(f.repo.list('tree_jobs', j => j.role === 'verification').length > 0, 'real reflection enqueues work');
  const before = f.repo.list('tree_jobs'); await cached.recover();
  assert.deepEqual(f.repo.list('tree_jobs'), before, 'a second recovery does not duplicate jobs');
  assert.equal(cached.readScope.active, null);
});

test('420 jobs and 7000 history events exercise the complete recovery callback within five seconds', async t => {
  const f = await history(t, 20), repo = f.repo;
  const sample = repo.list('tree_jobs', j => j.role === 'learning' && j.status === 'committed')[0];
  const pad = '合成性能材料'.repeat(12000);
  repo.transaction(() => {
    for (let i = 20; i < 85; i++) repo.save('tree_jobs', { ...sample, id: `recovery-learning-${i}`, rawMessage: { role: 'assistant', content: [{ type: 'text', text: pad }] } });
    for (let i = repo.list('tree_jobs').length; i < 420; i++) repo.save('tree_jobs', { ...sample, id: `recovery-other-${i}`, role: 'main', rawMessage: { role: 'assistant', content: [{ type: 'text', text: pad }] } });
    const count = repo.list('tree_change_events').length;
    for (let i = count; i < 7000; i++) repo.save('tree_change_events', { id: `history-${i}`, ordinal: i + 10000, commandType: 'synthetic-history', actor: { kind: 'program', id: 'fixture' }, entityIds: [`tree_jobs:recovery-other-${i}`], beforeVersions: [0], afterVersions: [1], sourceRefs: [], receiptId: `synthetic-${i}` });
  });
  const runtime = runtimeFor(f); let afterCommitCalls = 0, episodeBuilds = 0;
  const afterCommit = runtime.afterCommit.bind(runtime), episodes = runtime.signals.readEpisodes.bind(runtime.signals);
  runtime.afterCommit = job => { afterCommitCalls++; return afterCommit(job); };
  runtime.signals.readEpisodes = () => { episodeBuilds++; return episodes(); };
  const expectedCallbacks = repo.list('tree_jobs', j => j.role && j.status === 'committed').length;
  assert.equal(repo.list('tree_jobs', j => j.role === 'learning' && j.status === 'committed').length, 85);
  const timing = new StartupTiming({ directory: f.dir });
  const start = performance.now(); await runtime.recover(timing); const elapsed = performance.now() - start; timing.finish();
  assert.equal(afterCommitCalls, expectedCallbacks, 'all original callbacks run');
  assert.ok(episodeBuilds < 30, `episodes rebuilt ${episodeBuilds} times instead of once per category/job`);
  assert.ok(elapsed < 5000, `full recovery took ${elapsed.toFixed(1)} ms`);
  assert.ok(repo.list('tree_jobs', j => j.role === 'verification').length > 0);
  const scope = { nodeIds: [repo.rootId()] }, nodeStart = performance.now();
  const details = runtime.ui.read('node.details', { nodeId: repo.rootId() }, {}, scope);
  assert.equal(details.node.id, repo.rootId()); assert.ok(performance.now() - nodeStart < 1000);
  const turn = repo.list('tree_turns', row => row.sessionId === 'native-main').at(-1), turnStart = performance.now();
  const result = runtime.ui.read('turn.details', { turnId: turn.id }, {}, scope);
  assert.equal(result.turn.id, turn.id); assert.ok(performance.now() - turnStart < 1000);
  t.diagnostic(`complete recovery ${elapsed.toFixed(1)} ms; callbacks ${afterCommitCalls}; episode builds ${episodeBuilds}`);
});
