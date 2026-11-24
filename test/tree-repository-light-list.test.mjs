import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TreeRepository } from '../src/tree/repository.mjs';

// F56: filtered lists of tree_jobs used to parse every full job body on each
// call. They now filter a cached light copy and parse only the matches.

function repository(t) {
  const dir = mkdtempSync(join(tmpdir(), 'arcfold-light-list-'));
  const repo = new TreeRepository({ treeFilename: join(dir, 'tree.sqlite'), userId: 'light-list-user' });
  t.after(() => { repo.close(); rmSync(dir, { recursive: true, force: true }); });
  return repo;
}
const big = n => 'x'.repeat(n);
function job(i, extra = {}) {
  return { id: `job-${String(i).padStart(4, '0')}`, kind: i % 3 ? 'learning' : 'verification', role: i % 2 ? 'learning' : undefined, scopeKey: `node-${i % 5}`,
    inputHash: `hash-${i}`, inputRevisionSet: { a: i }, status: i % 4 ? 'committed' : 'queued', nodeIds: [`node-${i % 5}`], enqueuedOrder: i,
    trigger: { turnId: `turn-${i % 7}`, nativeSessionId: `s-${i % 2}`, nativeTurn: i },
    input: { turnId: `turn-${i % 7}`, summaryPlan: i % 5 === 0 ? { reason: 'threshold', contextEpoch: 1 } : undefined, context: big(2000), sources: [{ text: big(1000) }] },
    nativeMessage: { content: big(3000) }, prompt: { text: big(1000) }, ...extra };
}
const strip = value => JSON.parse(JSON.stringify(value));
function seed(repo, count) { repo.transaction(() => { for (let i = 0; i < count; i++) repo.save('tree_jobs', strip(job(i))); }); }
const reference = (repo, predicate) => repo.list('tree_jobs').filter(predicate);
const predicates = [
  j => j.role === 'learning' && j.status === 'committed',
  j => !j.role && j.kind === 'verification' && j.status === 'queued',
  j => j.input.summaryPlan?.reason === 'threshold',
  j => j.trigger.nativeSessionId === 's-1' && j.trigger.nativeTurn === 7,
  j => j.nodeIds.includes('node-3') && j.input.turnId === 'turn-2',
];

test('filtered lists return the same full records, in the same order, as filtering every row', t => {
  const repo = repository(t); seed(repo, 60);
  for (const predicate of predicates) assert.deepEqual(repo.list('tree_jobs', predicate), reference(repo, predicate));
  const [first] = repo.list('tree_jobs', j => j.id === 'job-0001');
  assert.equal(first.nativeMessage.content.length, 3000, 'the returned record is the full body');
  assert.equal(first.input.context.length, 2000);
  assert.equal(Object.isFrozen(first), false, 'callers get their own copy, not the cache');
});

test('a predicate that reads a left-out field fails loudly', t => {
  const repo = repository(t); seed(repo, 3);
  assert.throws(() => repo.list('tree_jobs', j => j.nativeMessage.content.length > 0), e => e.code === 'LIGHT_FIELD');
  assert.throws(() => repo.list('tree_jobs', j => j.input.context.length > 0), e => e.code === 'LIGHT_FIELD');
  assert.throws(() => repo.list('tree_jobs', j => { j.status = 'x'; return true; }), TypeError, 'the light copy is frozen');
});

test('the light cache follows own writes, rollback and another connection', t => {
  const repo = repository(t); seed(repo, 10);
  const queued = () => repo.list('tree_jobs', j => j.status === 'queued').map(j => j.id);
  assert.deepEqual(queued(), ['job-0000', 'job-0004', 'job-0008']);

  const one = repo.get('tree_jobs', 'job-0001');
  repo.transaction(() => repo.save('tree_jobs', { ...one, status: 'queued' }, one.revision));
  assert.deepEqual(queued(), ['job-0000', 'job-0001', 'job-0004', 'job-0008'], 'an update keeps the record in place');

  repo.transaction(() => repo.save('tree_jobs', strip(job(99, { status: 'queued' }))));
  assert.deepEqual(queued(), ['job-0000', 'job-0001', 'job-0004', 'job-0008', 'job-0099'], 'an insert is visible at once');

  const two = repo.get('tree_jobs', 'job-0002');
  assert.throws(() => repo.transaction(() => {
    repo.save('tree_jobs', { ...two, status: 'queued' }, two.revision);
    assert.ok(queued().includes('job-0002'), 'visible inside its own transaction');
    throw new Error('roll back');
  }), /roll back/);
  assert.ok(!queued().includes('job-0002'), 'rollback clears the cache');

  const other = new TreeRepository({ treeFilename: repo.filename, userId: repo.userId });
  t.after(() => other.close());
  const three = other.get('tree_jobs', 'job-0003');
  other.transaction(() => other.save('tree_jobs', { ...three, status: 'queued' }, three.revision));
  assert.ok(queued().includes('job-0003'), 'a write from another connection invalidates the cache');
  for (const predicate of predicates) assert.deepEqual(repo.list('tree_jobs', predicate), reference(repo, predicate));
});

test('a repeated filtered list parses only the matching full bodies', t => {
  const repo = repository(t); seed(repo, 200);
  repo.list('tree_jobs', j => j.status === 'queued');
  const parse = JSON.parse; let large = 0;
  JSON.parse = (text, ...rest) => { if (typeof text === 'string' && text.length > 5000) large++; return parse(text, ...rest); };
  try { assert.equal(repo.list('tree_jobs', j => j.status === 'queued').length, 50); }
  finally { JSON.parse = parse; }
  assert.equal(large, 50, 'only the 50 matching bodies were parsed in full');
});

test('420 large completed jobs: recovery reads once and repeated scans avoid large-body parses', async t => {
  const { TreeRuntime } = await import('../src/tree/runtime.mjs');
  const { TreeJobs } = await import('../src/tree/jobs.mjs');
  const repo = repository(t);
  repo.transaction(() => {
    for (let i = 0; i < 420; i++) repo.save('tree_jobs', strip(job(i, {
      role: 'learning', status: 'committed', nativeMessage: { content: big(110000) },
    })));
  });
  const runtime = Object.assign(Object.create(TreeRuntime.prototype), {
    repo, closed: false, workers: new Map(), jobs: new TreeJobs({ repository: repo, assertSources: () => true }),
    planScan() {}, afterCommit() {}, owner: { recover: async () => [] },
    logs: new Map(), diagnostic() {}, kick() {}, settleTurn() {}, handlePressure() {},
  });
  const recoveryStart = performance.now();
  await runtime.recover();
  const recoveryMs = performance.now() - recoveryStart;
  assert.ok(recoveryMs < 5000, `synthetic recovery: ${recoveryMs} ms`);
  await runtime.scanOne();
  const parse = JSON.parse; let large = 0;
  JSON.parse = (text, ...rest) => { if (typeof text === 'string' && text.length > 100000) large++; return parse(text, ...rest); };
  const scanStart = performance.now();
  try { assert.equal(await runtime.scanOne(), false); }
  finally { JSON.parse = parse; }
  const scanMs = performance.now() - scanStart;
  assert.equal(large, 0, 'completed payloads are not parsed by an idle scan');
  assert.ok(scanMs < 200, `synthetic scan: ${scanMs} ms`);
  t.diagnostic(`420 jobs, ~47 MB: recovery ${recoveryMs.toFixed(1)} ms; warm scan ${scanMs.toFixed(1)} ms`);
});
