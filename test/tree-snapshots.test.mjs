import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, renameSync, symlinkSync, chmodSync, statSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { snapshotFixture } from './fixtures/tree-scripts/helpers.mjs';
import { SnapshotService } from '../src/tree/snapshots.mjs';
import { digest } from '../src/tree/contracts.mjs';

const write = (f, path, text) => writeFileSync(join(f.workspace, path), text);
const read = (f, path) => readFileSync(join(f.workspace, path), 'utf8');
const preview = (f, snapshot, id = 'preview') => f.snapshots.preview({ snapshotId: snapshot.id, requestId: id });
const apply = (f, preview, id = 'restore') => f.snapshots.apply({ previewId: preview.id, expectedCurrentHashes: preview.expectedCurrentHashes, requestId: id });

test('S11 shadow Git restores added/deleted/edited files and modes without touching user Git history or index', async t => {
  const f = snapshotFixture(t); write(f, 'edited.txt', 'before'); mkdirSync(join(f.workspace, 'nested')); write(f, 'nested/deleted.txt', 'return me'); chmodSync(join(f.workspace, 'nested/deleted.txt'), 0o755);
  const git = args => execFileSync('/usr/bin/git', ['-C', f.workspace, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', ...args], { encoding: 'utf8' }).trim();
  git(['init', '-q']); git(['add', '.']); git(['commit', '-qm', 'User history']); const head = git(['rev-parse', 'HEAD']), index = readFileSync(join(f.workspace, '.git/index'));
  const before = await f.snapshots.capture({ requestId: 'before', reason: 'main_turn' }); assert.equal(before.coverage.state, 'partial'); assert.equal(before.coverage.enforcement, 'fixture-algorithm-only');
  write(f, 'edited.txt', 'after'); rmSync(join(f.workspace, 'nested'), { recursive: true }); write(f, 'added.txt', 'remove me');
  const plan = await preview(f, before); assert.deepEqual(new Set(plan.changes.map(c => c.kind)), new Set(['changed', 'deleted', 'added']));
  const result = await apply(f, plan); assert.equal(result.state, 'completed'); assert.equal(read(f, 'edited.txt'), 'before'); assert.equal(read(f, 'nested/deleted.txt'), 'return me'); assert.equal(statSync(join(f.workspace, 'nested/deleted.txt')).mode & 0o777, 0o755); assert.equal(existsSync(join(f.workspace, 'added.txt')), false);
  assert.equal(git(['rev-parse', 'HEAD']), head); assert.deepEqual(readFileSync(join(f.workspace, '.git/index')), index); assert.ok(f.repo.get('tree_snapshots', result.beforeSnapshotId));
  write(f, 'edited.txt', 'new user edit after completed restore'); assert.equal((await apply(f, plan)).state, 'completed'); assert.equal(read(f, 'edited.txt'), 'new user edit after completed restore');
});
test('S10 a post-preview edit rejects the entire restore before any target is overwritten', async t => {
  const f = snapshotFixture(t); write(f, 'a', 'a0'); write(f, 'b', 'b0'); const snapshot = await f.snapshots.capture({ requestId: 'base', reason: 'script', protectedPaths: ['a', 'b'] });
  write(f, 'a', 'a1'); write(f, 'b', 'b1'); const plan = await preview(f, snapshot); write(f, 'b', 'another agent');
  await assert.rejects(apply(f, plan), { code: 'RESTORE_CONFLICT' }); assert.equal(read(f, 'a'), 'a1'); assert.equal(read(f, 'b'), 'another agent');
});
test('S14 exclusions are visible; symlink/credential/unprotected targets refuse snapshots and restoration', async t => {
  const f = snapshotFixture(t); write(f, 'safe', 'content'); write(f, '.env', 'synthetic canary, never captured'); mkdirSync(join(f.workspace, 'node_modules')); write(f, 'node_modules/generated', 'excluded'); symlinkSync(f.storageRoot, join(f.workspace, 'private-link'));
  const snapshot = await f.snapshots.capture({ requestId: 'partial', reason: 'main_turn' }); assert.equal(snapshot.coverage.state, 'partial'); assert.deepEqual(snapshot.manifest.files.map(f => f.path), ['safe']);
  assert.deepEqual(new Set(snapshot.coverage.exclusions.map(e => e.reason)), new Set(['credentials', 'excluded_directory', 'symlink']));
  for (const target of ['.env', 'node_modules/generated', 'private-link/secret']) await assert.rejects(f.snapshots.capture({ requestId: target, reason: 'script', protectedPaths: [target] }), { code: 'SNAPSHOT_UNCOVERED' });
  rmSync(join(f.workspace, 'safe')); symlinkSync(join(f.workspace, '.env'), join(f.workspace, 'safe'));
  await assert.rejects(preview(f, snapshot), { code: 'SNAPSHOT_UNCOVERED' }); assert.equal(f.repo.list('tree_snapshots').length, 1);
});
test('stable scan retries at most twice and never commits mixed file state', async t => {
  const f = snapshotFixture(t); write(f, 'changing', 'start'); const scan = f.io.scan.bind(f.io); let scans = 0;
  f.io.scan = async options => { const value = await scan(options); scans++; if (scans === 1) write(f, 'changing', 'stable'); return value; };
  const snapshot = await f.snapshots.capture({ requestId: 'stabilizes', reason: 'main_turn' }); assert.equal(scans, 4); assert.equal(snapshot.manifest.files[0].sha256, (await scan({ copy: false })).manifest.files[0].sha256);
  scans = 0; f.io.scan = async options => { const value = await scan(options); write(f, 'changing', 'continually ' + ++scans); return value; };
  await assert.rejects(f.snapshots.capture({ requestId: 'busy', reason: 'main_turn' }), { code: 'SNAPSHOT_BUSY' }); assert.equal(scans, 4); assert.equal(f.repo.list('tree_snapshots').length, 1);
});
test('workspace device/inode replacement and shared cross-session lock refuse conflicting work', async t => {
  const f = snapshotFixture(t), other = new SnapshotService(f.options);
  await f.snapshots.locked(async () => assert.rejects(other.capture({ requestId: 'busy', reason: 'main_turn' }), { code: 'SNAPSHOT_BUSY' }));
  renameSync(f.workspace, f.workspace + '-old'); mkdirSync(f.workspace); await assert.rejects(f.snapshots.capture({ requestId: 'replaced', reason: 'main_turn' }), { code: 'WORKSPACE_IDENTITY' });
});
test('restore requires the owning user and current write policy; fixed-worker configuration never silently becomes unconfined', async t => {
  const f = snapshotFixture(t); assert.throws(() => new SnapshotService({ ...f.options, allowUnconfinedFixture: false }), { code: 'SANDBOX_UNAVAILABLE' });
  write(f, 'a', 'before'); const snapshot = await f.snapshots.capture({ requestId: 'base', reason: 'main_turn' }); write(f, 'a', 'after');
  f.asModel('main'); await assert.rejects(preview(f, snapshot), { code: 'USER_RESTORE_REQUIRED' }); f.asUser(); const plan = await preview(f, snapshot);
  f.context.sessionPolicy.mode = 'read-only'; const result = await apply(f, plan); assert.equal(result.state, 'failed'); assert.equal(read(f, 'a'), 'after');
});
for (const stage of ['prepared', 'spawn_intent', 'worker_returned', 'committed']) test(`S12 host interruption at ${stage} preserves intent and reconciles only proven outcomes`, async t => {
  const f = snapshotFixture(t); write(f, 'a', 'before'); const snapshot = await f.snapshots.capture({ requestId: 'base', reason: 'main_turn' }); write(f, 'a', 'after'); const plan = await preview(f, snapshot);
  f.snapshots.fault = point => { if (point === stage) throw new Error('Synthetic host stop: ' + stage); };
  await assert.rejects(apply(f, plan), /Synthetic host stop/); const id = digest(['restore', 'restore']), next = new SnapshotService(f.options), calls = f.io.calls;
  const result = await next.reconcile(id);
  assert.equal(result.state, stage === 'spawn_intent' ? 'unknown' : 'completed'); assert.equal(read(f, 'a'), stage === 'spawn_intent' ? 'after' : 'before');
  if (stage === 'spawn_intent' || stage === 'committed') assert.equal(f.io.calls, calls, 'unknown/already-completed intent is never resent');
});
for (const stage of ['started', 'staged', 'applied:0', 'completed']) test(`S12 actual worker process exits at ${stage}; recovery checks bytes and safely completes original intent`, async t => {
  const f = snapshotFixture(t); write(f, 'a', 'a0'); write(f, 'b', 'b0'); const snapshot = await f.snapshots.capture({ requestId: 'base', reason: 'main_turn' }); write(f, 'a', 'a1'); write(f, 'b', 'b1'); const plan = await preview(f, snapshot);
  f.io.nextRestoreFault = stage; const stopped = await apply(f, plan); assert.equal(stopped.state, 'partial');
  const result = await new SnapshotService(f.options).reconcile(stopped.id); assert.equal(result.state, 'completed'); assert.equal(read(f, 'a'), 'a0'); assert.equal(read(f, 'b'), 'b0');
});
test('S12 a later user edit during partial restore is preserved and requires a fresh preview', async t => {
  const f = snapshotFixture(t); write(f, 'a', 'a0'); write(f, 'b', 'b0'); const snapshot = await f.snapshots.capture({ requestId: 'base', reason: 'main_turn' }); write(f, 'a', 'a1'); write(f, 'b', 'b1'); const plan = await preview(f, snapshot);
  f.io.nextRestoreFault = 'applied:0'; const partial = await apply(f, plan); write(f, 'b', 'new user content'); const result = await f.snapshots.reconcile(partial.id);
  assert.equal(result.state, 'conflict'); assert.equal(read(f, 'b'), 'new user content'); assert.equal(result.beforeSnapshotId, partial.beforeSnapshotId);
});
for (const stage of ['prepared', 'worker_returned']) test(`S12 real host process exit at ${stage} releases the workspace lock and reopens committed journal`, async t => {
  const f = snapshotFixture(t); write(f, 'a', 'before'); const snapshot = await f.snapshots.capture({ requestId: 'base', reason: 'main_turn' }); write(f, 'a', 'after'); const plan = await preview(f, snapshot);
  const input = join(f.dir, 'crash-input.json'); writeFileSync(input, JSON.stringify({ treeFilename: f.repo.filename, workspace: f.workspace, runtimeRoot: f.runtimeRoot, storageRoot: f.storageRoot, stage,
    command: { previewId: plan.id, expectedCurrentHashes: plan.expectedCurrentHashes, requestId: 'child-restore' } }));
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/tree-scripts/restore-crash.mjs', import.meta.url)), input], { encoding: 'utf8', timeout: 20000 });
  assert.equal(child.status, 72, child.stderr); const result = await f.snapshots.reconcile(digest(['restore', 'child-restore'])); assert.equal(result.state, 'completed'); assert.equal(read(f, 'a'), 'before');
});
test('S14 oversized files are explicit exclusions and cannot become protected script targets', async t => {
  const f = snapshotFixture(t); write(f, 'large', ''); truncateSync(join(f.workspace, 'large'), 20 * 1024 * 1024 + 1);
  const snapshot = await f.snapshots.capture({ requestId: 'large', reason: 'main_turn' }); assert.deepEqual(snapshot.coverage.exclusions, [{ path: 'large', reason: 'file_size' }]);
  await assert.rejects(f.snapshots.capture({ requestId: 'unsafe-script', reason: 'script', protectedPaths: ['large'] }), { code: 'SNAPSHOT_UNCOVERED' });
});
test('S14 the actual 256-MiB aggregate limit rejects capture instead of silently omitting ordinary files', async t => {
  const f = snapshotFixture(t);
  for (let n = 0; n < 13; n++) { const path = 'part-' + n; write(f, path, ''); truncateSync(join(f.workspace, path), 20 * 1024 * 1024); }
  await assert.rejects(f.snapshots.capture({ requestId: 'over-total', reason: 'main_turn' }), { code: 'SNAPSHOT_TOTAL_SIZE' }); assert.equal(f.repo.list('tree_snapshots').length, 0);
});
test('30-day cleanup preserves unknown-run and pending-preview snapshots while expiring unreferenced content', async t => {
  const f = snapshotFixture(t); write(f, 'a', 'content'); const capture = requestId => f.snapshots.capture({ requestId, reason: 'main_turn' });
  const unknown = await capture('unknown'), pending = await capture('pending'), expired = await capture('expired'); await preview(f, pending);
  f.repo.transaction(() => f.repo.save('tree_script_runs', { id: 'unknown-run', runId: 'unknown-run', methodVersion: { itemId: 'synthetic-method', version: 1 }, nodeEpoch: 1, workspaceIdentity: f.snapshots.identity,
    policyHash: digest('synthetic-policy'), snapshotId: unknown.id, argvHash: digest([]), state: 'revoked', processState: 'unknown' }));
  const removed = await f.snapshots.prune(new Date(Date.now() + 31 * 86400000).toISOString()); assert.deepEqual(removed, [expired.id]); assert.equal(f.snapshots.snapshot(unknown.id).restoreState, 'available'); assert.equal(f.snapshots.snapshot(pending.id).restoreState, 'available'); assert.throws(() => f.snapshots.snapshot(expired.id), { code: 'SNAPSHOT_UNAVAILABLE' });
});
