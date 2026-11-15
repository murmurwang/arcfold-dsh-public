import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ownEvidenceDirectory, assertEvidenceOwnership } from '../evidence-ownership.mjs';
import { canonicalJson, digest, fail } from './contracts.mjs';
import { beneath, canonicalPath, contentHash, processPolicy, confinedArgv, spawnConfined } from './host-process.mjs';

export const SNAPSHOT_LIMITS = Object.freeze({ fileBytes: 20 * 1024 * 1024, totalBytes: 256 * 1024 * 1024, retentionDays: 30, scanAttempts: 2 });
export function workspaceIdentity(workspace) {
  const path = realpathSync(workspace), stat = statSync(path, { bigint: true });
  if (!stat.isDirectory()) fail('WORKSPACE_IDENTITY', 'Workspace must be a real directory');
  return { path, dev: String(stat.dev), ino: String(stat.ino) };
}
export function relativeFile(path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\\') || path.includes('\0') || path.split('/').some(p => !p || p === '.' || p === '..')) fail('SNAPSHOT_PATH', 'A canonical relative file path is required');
  return path;
}

/**
 * Trusted fixed worker, serialized into its own confined process. It never
 * loads workspace code. Production file reads/writes do not run in the host.
 */
export async function workspaceWorker(request) {
  const fs = await import('node:fs'), path = await import('node:path'), crypto = await import('node:crypto');
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const error = (code, message) => Object.assign(new Error(message), { code });
  const inside = (target, root) => target === root || target.startsWith(root + path.sep);
  const root = fs.realpathSync(request.workspace), directory = fs.realpathSync(request.runDirectory);
  const identity = () => { const stat = fs.statSync(root, { bigint: true }); return { path: fs.realpathSync(request.workspace), dev: String(stat.dev), ino: String(stat.ino) }; };
  const assertIdentity = () => { const current = identity(); if (['path', 'dev', 'ino'].some(key => current[key] !== request.workspaceIdentity[key])) throw error('WORKSPACE_IDENTITY', 'Workspace was replaced'); };
  const exclusions = [], files = []; let totalBytes = 0;
  const ignored = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.cache', '.ssh', '.aws', '.gnupg']);
  const exclusion = (name, absolute) => {
    if (request.protectedRoots.some(p => inside(absolute, p)) || inside(absolute, request.runtimeRoot)) return 'arcfold_private';
    if (ignored.has(name)) return 'excluded_directory';
    if (name.startsWith('.env') || ['.npmrc', '.netrc', 'credentials', 'credentials.json', 'id_rsa', 'id_ed25519'].includes(name) || /\.(pem|key|p12|pfx)$/i.test(name)) return 'credentials';
    return null;
  };
  const checkedPath = (relative, allowMissingParents = false) => {
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\\') || relative.includes('\0') || relative.split('/').some(p => !p || p === '.' || p === '..')) throw error('SNAPSHOT_PATH', 'Invalid relative path');
    let absolute = root;
    for (const [index, name] of relative.split('/').entries()) {
      absolute = path.join(absolute, name);
      if (exclusion(name, absolute)) throw error('SNAPSHOT_EXCLUDED', 'Protected or excluded path');
      try {
        const stat = fs.lstatSync(absolute); if (stat.isSymbolicLink()) throw error('SNAPSHOT_SYMLINK', 'Symlink path refused');
        if (index < relative.split('/').length - 1 && !stat.isDirectory()) throw error('SNAPSHOT_PATH', 'Parent must remain a directory');
      } catch (e) { if (e.code !== 'ENOENT' || !allowMissingParents && index < relative.split('/').length - 1) throw e; }
    }
    return absolute;
  };
  const read = relative => {
    assertIdentity(); const absolute = checkedPath(relative, true); let fd;
    try {
      fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const before = fs.fstatSync(fd); if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o7000)) throw error('SNAPSHOT_FILE_TYPE', 'Only ordinary single-link files are supported');
      if (before.size > request.limits.fileBytes) throw error('SNAPSHOT_FILE_SIZE', 'File exceeds content coverage');
      const parts = []; let length = 0;
      for (;;) { const buffer = Buffer.alloc(Math.min(65536, request.limits.fileBytes + 1 - length)), count = fs.readSync(fd, buffer, 0, buffer.length, null); if (!count) break; length += count; if (length > request.limits.fileBytes) throw error('SNAPSHOT_FILE_SIZE', 'File grew beyond content coverage'); parts.push(buffer.subarray(0, count)); }
      const content = Buffer.concat(parts, length), after = fs.fstatSync(fd), current = fs.lstatSync(absolute);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== current.ino || before.dev !== current.dev || current.isSymbolicLink() || !inside(fs.realpathSync(absolute), root)) throw error('SNAPSHOT_BUSY', 'File changed while read');
      return { content, sha256: hash(content), size: content.length, mode: before.mode & 0o777 };
    } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  };
  const journalPath = path.join(directory, 'worker-journal.json');
  const journal = value => {
    const next = path.join(directory, 'worker-journal.next'), body = { requestHash: request.requestHash, pid: process.pid, ...value };
    const fd = fs.openSync(next, 'w', 0o600); try { fs.writeFileSync(fd, JSON.stringify(body)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(next, journalPath); const parent = fs.openSync(directory, 'r'); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    if (request.faultAt === value.phase) process.exit(91);
    return body;
  };
  let applied = [];
  try {
    assertIdentity();
    if (request.operation === 'scan') {
      const walk = relative => {
        const absolute = relative ? checkedPath(relative) : root;
        for (const name of fs.readdirSync(absolute).sort()) {
          const child = relative ? relative + '/' + name : name, target = path.join(root, child), reason = exclusion(name, target);
          if (reason) { exclusions.push({ path: child, reason }); continue; }
          const stat = fs.lstatSync(target);
          if (stat.isSymbolicLink()) { exclusions.push({ path: child, reason: 'symlink' }); continue; }
          if (stat.isDirectory()) { walk(child); continue; }
          if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o7000)) { exclusions.push({ path: child, reason: 'non_regular_or_linked' }); continue; }
          if (stat.size > request.limits.fileBytes) { exclusions.push({ path: child, reason: 'file_size' }); continue; }
          const file = read(child); if (!file) throw error('SNAPSHOT_BUSY', 'File disappeared while scanning');
          totalBytes += file.size; if (totalBytes > request.limits.totalBytes) throw error('SNAPSHOT_TOTAL_SIZE', 'Workspace exceeds bounded snapshot storage');
          if (request.copy) { const output = path.join(directory, 'files', file.sha256); if (!fs.existsSync(output)) fs.writeFileSync(output, file.content, { flag: 'wx', mode: 0o600 }); }
          files.push({ path: child, sha256: file.sha256, size: file.size, mode: file.mode });
        }
      };
      fs.mkdirSync(path.join(directory, 'files'), { recursive: true, mode: 0o700 }); walk(''); assertIdentity();
      process.stdout.write(JSON.stringify({ ok: true, manifest: { files, exclusions, totalBytes } })); return;
    }
    if (request.operation !== 'restore') throw error('SNAPSHOT_OPERATION', 'Unsupported fixed worker operation');
    journal({ phase: 'started', applied });
    const currentHash = change => { const current = read(change.path); return current ? { sha256: current.sha256, mode: current.mode } : null; };
    const fingerprintForWorker = file => ({ sha256: file.sha256, mode: file.mode });
    const same = (a, b) => a === null && b === null || a !== null && b !== null && a.sha256 === b.sha256 && a.mode === b.mode;
    for (const change of request.changes) if (!same(currentHash(change), change.current)) throw error('RESTORE_CONFLICT', 'Files changed after preview');
    for (const change of request.changes) {
      if (!change.target || change.skipWrite) continue;
      const content = fs.readFileSync(path.join(directory, 'files', change.target.sha256)); if (hash(content) !== change.target.sha256) throw error('SNAPSHOT_HASH', 'Stored target content changed');
      const components = change.path.split('/').slice(0, -1); let parent = '';
      for (const name of components) { parent = parent ? parent + '/' + name : name; const absolute = checkedPath(parent, true); if (!fs.existsSync(absolute)) fs.mkdirSync(absolute, { mode: 0o755 }); checkedPath(parent); }
      const stage = checkedPath(change.stage), previous = read(change.stage);
      if (previous) { if (!same(fingerprintForWorker(previous), fingerprintForWorker(change.target))) throw error('RESTORE_CONFLICT', 'A staging file was changed'); continue; }
      const fd = fs.openSync(stage, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, change.target.mode);
      try { fs.writeFileSync(fd, content); fs.fchmodSync(fd, change.target.mode); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    journal({ phase: 'staged', applied });
    for (const [index, change] of request.changes.entries()) {
      assertIdentity(); if (!same(currentHash(change), change.current)) throw error('RESTORE_CONFLICT', 'A file changed during restore');
      const target = checkedPath(change.path, true);
      if (!change.skipWrite) { if (change.target) fs.renameSync(checkedPath(change.stage), target); else if (fs.existsSync(target)) fs.unlinkSync(target); }
      if (fs.existsSync(path.dirname(target))) { const parent = fs.openSync(path.dirname(target), 'r'); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); } }
      applied.push(change.path); journal({ phase: 'applied:' + index, applied });
    }
    for (const change of request.changes) if (change.target) {
      const stage = read(change.stage); if (!stage) continue;
      if (!same(fingerprintForWorker(stage), fingerprintForWorker(change.target))) throw error('RESTORE_CONFLICT', 'A staging file was changed before cleanup');
      fs.unlinkSync(checkedPath(change.stage));
    }
    for (const change of request.changes) if (!same(currentHash(change), change.target && { sha256: change.target.sha256, mode: change.target.mode })) throw error('RESTORE_CONFLICT', 'Restored content was changed concurrently');
    const receipt = journal({ phase: 'completed', applied }); process.stdout.write(JSON.stringify({ ok: true, receipt }));
  } catch (error) {
    const failure = { code: error.code ?? 'SNAPSHOT_IO', message: error.message };
    if (request.operation === 'restore') journal({ phase: 'failed', applied, error: failure });
    process.stdout.write(JSON.stringify({ ok: false, error: failure })); process.exitCode = 1;
  }
}

const workerSource = `await (${workspaceWorker.toString()})(JSON.parse((await import('node:fs')).readFileSync(process.argv[3], 'utf8')));\n`;
/** The same deny-by-default OS boundary as generated scripts, with fixed code. */
export class ConfinedWorkspaceIO {
  constructor({ workspace, runtimeRoot, protectedRoots }) {
    this.workspace = realpathSync(workspace); mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 }); this.runtimeRoot = realpathSync(runtimeRoot);
    this.protectedRoots = protectedRoots.map(canonicalPath); this.enforcement = 'full';
  }
  prepare(operation, extras = {}) {
    const directory = mkdtempSync(join(this.runtimeRoot, 'snapshot-')), request = { operation, workspace: this.workspace, workspaceIdentity: workspaceIdentity(this.workspace), runDirectory: directory,
      runtimeRoot: this.runtimeRoot, protectedRoots: this.protectedRoots, limits: SNAPSHOT_LIMITS, ...extras };
    request.requestHash = digest(request); mkdirSync(join(directory, 'files'), { mode: 0o700 });
    writeFileSync(join(directory, 'worker.mjs'), workerSource, { flag: 'wx', mode: 0o400 }); writeFileSync(join(directory, 'input.json'), canonicalJson(request), { flag: 'wx', mode: 0o400 });
    return request;
  }
  async execute(request, { sessionPolicy = { mode: 'read-only', workspaceRoot: this.workspace }, signal } = {}) {
    const writes = request.operation === 'restore' ? request.changes.flatMap(c => {
      const parents = c.target ? c.path.split('/').slice(0, -1).map((_p, n, parts) => join(this.workspace, ...parts.slice(0, n + 1))).filter(p => !existsSync(p)) : [];
      return [join(this.workspace, c.path), ...(c.target ? [join(this.workspace, c.stage), ...parents] : [])];
    }) : [];
    let wrapped;
    try {
      if (writes.length && sessionPolicy.mode === 'read-only') fail('RESTORE_POLICY', 'Current session does not permit file restoration');
      const policy = processPolicy({ workspace: this.workspace, runtimeRoot: this.runtimeRoot, protectedRoots: this.protectedRoots, sessionPolicy, authorizedWriteRoots: writes });
      wrapped = confinedArgv({ policy, runDirectory: request.runDirectory, argv: [process.execPath, join(request.runDirectory, 'worker.mjs'), '--input', join(request.runDirectory, 'input.json')] });
    } catch (error) { error.beforeSpawn = true; throw error; }
    const result = await spawnConfined(wrapped, { cwd: this.workspace, runDirectory: request.runDirectory, signal, timeoutMs: 120000, assertCurrent: () => {
      if (digest(workspaceIdentity(this.workspace)) !== digest(request.workspaceIdentity) || readFileSync(join(request.runDirectory, 'worker.mjs'), 'utf8') !== workerSource || readFileSync(join(request.runDirectory, 'input.json'), 'utf8') !== canonicalJson(request)) throw Object.assign(new Error('Fixed worker input or workspace changed'), { code: 'SNAPSHOT_IDENTITY', beforeSpawn: true });
    } });
    let output; try { output = JSON.parse(result.stdout); } catch { output = { ok: false, error: { code: 'SNAPSHOT_WORKER', message: result.stderr || 'No complete fixed-worker receipt' } }; }
    return { ...result, output };
  }
  async scan({ copy = false, signal } = {}) {
    const request = this.prepare('scan', { copy });
    try {
      const result = await this.execute(request, { signal }); if (result.code !== 0 || !result.output.ok || result.truncated) fail(result.output.error?.code ?? 'SNAPSHOT_WORKER', result.output.error?.message ?? 'Incomplete scan');
      const { manifest } = result.output, contents = new Map();
      if (copy) for (const file of manifest.files) { const bytes = readFileSync(join(request.runDirectory, 'files', file.sha256)); if (contentHash(bytes) !== file.sha256) fail('SNAPSHOT_HASH', 'Captured bytes changed'); contents.set(file.path, bytes); }
      return { manifest, contents };
    } finally { rmSync(request.runDirectory, { recursive: true, force: true }); }
  }
  inspect(request) {
    if (!beneath(request.runDirectory, this.runtimeRoot) || request.runDirectory === this.runtimeRoot) fail('SNAPSHOT_PATH', 'Unknown worker directory');
    if (readFileSync(join(request.runDirectory, 'worker.mjs'), 'utf8') !== workerSource || readFileSync(join(request.runDirectory, 'input.json'), 'utf8') !== canonicalJson(request)) fail('SNAPSHOT_IDENTITY', 'Restore worker identity changed');
    if (!existsSync(join(request.runDirectory, 'worker-journal.json'))) return { state: 'unknown', reason: 'no_worker_receipt' };
    const journal = JSON.parse(readFileSync(join(request.runDirectory, 'worker-journal.json'), 'utf8'));
    if (journal.requestHash !== request.requestHash) fail('SNAPSHOT_IDENTITY', 'Worker journal does not match persisted restore intent');
    if (['completed', 'failed'].includes(journal.phase)) return { state: 'finished', journal };
    try { process.kill(journal.pid, 0); return { state: 'unknown', reason: 'worker_may_be_alive', journal }; }
    catch (error) { if (error.code !== 'ESRCH') return { state: 'unknown', reason: 'worker_status_unavailable', journal }; return { state: 'interrupted', journal }; }
  }
  cleanup(request) { if (!beneath(request.runDirectory, this.runtimeRoot) || request.runDirectory === this.runtimeRoot) fail('SNAPSHOT_PATH', 'Not an owned run directory'); rmSync(request.runDirectory, { recursive: true, force: true }); }
}

const program = { kind: 'program', id: 'tree-snapshots' };
const fingerprint = file => file ? { sha256: file.sha256, mode: file.mode } : null;
const unfinished = value => ['prepared', 'spawn_intent', 'partial', 'unknown'].includes(value.state);
export class SnapshotService {
  constructor({ repository, workspace, storageRoot, runtimeRoot, protectedRoots, context, io, allowUnconfinedFixture = false, fault = () => {} }) {
    this.repo = repository; this.identity = workspaceIdentity(workspace); this.workspace = this.identity.path; this.context = context; this.fault = fault;
    mkdirSync(storageRoot, { recursive: true, mode: 0o700 }); this.storageRoot = realpathSync(storageRoot);
    if (beneath(this.storageRoot, this.workspace)) {
      // Parent workspaces are permitted only because both scanning and ordinary
      // tools receive the same explicit protected root, never by hiding its name.
      protectedRoots = [...protectedRoots, this.storageRoot];
    }
    this.protectedRoots = [...new Set([...protectedRoots, this.storageRoot].map(canonicalPath))];
    this.directory = join(this.storageRoot, digest(this.identity)); mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.gitDirectory = join(this.directory, 'shadow.git');
    this.io = io ?? new ConfinedWorkspaceIO({ workspace: this.workspace, runtimeRoot, protectedRoots: this.protectedRoots });
    if (this.io.enforcement !== 'full' && !allowUnconfinedFixture) fail('SANDBOX_UNAVAILABLE', 'Snapshot I/O requires the fixed confined worker');
    this.enforcement = this.io.enforcement;
  }
  assertIdentity() { if (digest(workspaceIdentity(this.workspace)) !== digest(this.identity)) fail('WORKSPACE_IDENTITY', 'Workspace realpath/device/inode changed'); }
  user() { const actor = this.context?.().actor; if (actor?.kind !== 'user' || actor.id !== this.repo.meta().userId) fail('USER_RESTORE_REQUIRED', 'Only the owning user can preview or restore files'); return actor; }
  async locked(operation) {
    this.assertIdentity(); let lease;
    try { lease = await ownEvidenceDirectory(join(this.directory, 'workspace-lock')); }
    catch (error) { if (['EAGAIN', 'EWOULDBLOCK'].includes(error.code)) fail('SNAPSHOT_BUSY', 'Another capture or restore owns this workspace'); throw error; }
    try { assertEvidenceOwnership(lease, join(this.directory, 'workspace-lock')); this.assertIdentity(); return await operation(lease); }
    finally { await lease.close(); }
  }
  pending(exceptId = null) { return Object.values(this.repo.meta().restoreIntents ?? {}).filter(row => row.id !== exceptId && digest(row.workspaceIdentity) === digest(this.identity) && unfinished(row)); }
  unresolvedScripts() { return this.repo.list('tree_script_runs', row => digest(row.workspaceIdentity) === digest(this.identity) && (['prepared', 'spawn_intent', 'running', 'unknown'].includes(row.processState ?? row.state) || row.state === 'revoked' && !row.result && row.processState !== 'not_started')); }
  assertAvailable(exceptId = null, { retentionOnly = false } = {}) {
    if (this.pending(exceptId).length) fail('RESTORE_PENDING', 'An unfinished restore must be reconciled before other file work');
    if (!retentionOnly && this.unresolvedScripts().length) fail('SCRIPT_PENDING', 'An unobserved script may still be writing; do not race it with new file operations');
  }
  git(argv, input, binary = false) {
    const result = execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '--git-dir', this.gitDirectory, ...argv], {
      cwd: this.directory, input, encoding: binary ? undefined : 'utf8', maxBuffer: SNAPSHOT_LIMITS.fileBytes + 65536, timeout: 10000,
      env: { PATH: '/usr/bin:/bin', HOME: this.directory, TMPDIR: this.directory, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Arcfold Snapshot', GIT_AUTHOR_EMAIL: 'snapshot@localhost', GIT_COMMITTER_NAME: 'Arcfold Snapshot', GIT_COMMITTER_EMAIL: 'snapshot@localhost', LANG: 'C', TZ: 'UTC' }, stdio: ['pipe', 'pipe', 'pipe'],
    }); return binary ? result : result.trim();
  }
  saveGit(manifest, contents, id) {
    if (!existsSync(this.gitDirectory)) this.git(['init', '--bare']);
    const tree = new Map();
    for (const file of manifest.files) {
      const bytes = contents.get(file.path); if (!bytes || contentHash(bytes) !== file.sha256) fail('SNAPSHOT_HASH', 'Stable capture content missing');
      const blob = this.git(['hash-object', '-w', '--stdin'], bytes); file.blob = blob;
      let directory = tree; const parts = file.path.split('/');
      for (const part of parts.slice(0, -1)) { if (!directory.has(part)) directory.set(part, new Map()); directory = directory.get(part); }
      directory.set(parts.at(-1), file);
    }
    const storeTree = directory => {
      const records = [...directory.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, entry]) => entry instanceof Map ? `040000 tree ${storeTree(entry)}\t${name}\0` : `${entry.mode & 0o111 ? '100755' : '100644'} blob ${entry.blob}\t${name}\0`);
      return this.git(['mktree', '-z'], Buffer.from(records.join('')));
    };
    const commit = this.git(['commit-tree', storeTree(tree), '-m', 'Arcfold content snapshot ' + id]); this.git(['update-ref', 'refs/snapshots/' + id, commit]); return commit;
  }
  protectedTargets(manifest, targets) {
    for (const path of targets.map(relativeFile)) {
      if (path.split('/').some(name => ['.git', 'node_modules', 'dist', 'build', 'coverage', '.cache', '.ssh', '.aws', '.gnupg', '.npmrc', '.netrc', 'credentials', 'credentials.json', 'id_rsa', 'id_ed25519'].includes(name) || name.startsWith('.env') || /\.(pem|key|p12|pfx)$/i.test(name))) fail('SNAPSHOT_UNCOVERED', 'Excluded paths cannot be script write targets, even before creation');
      if (manifest.exclusions.some(row => path === row.path || path.startsWith(row.path + '/'))) fail('SNAPSHOT_UNCOVERED', 'A required write target is excluded: ' + path);
      const absolute = canonicalPath(join(this.workspace, path));
      if (!beneath(absolute, this.workspace) || this.protectedRoots.some(root => beneath(absolute, root))) fail('SNAPSHOT_UNCOVERED', 'A required write target is outside protected content coverage');
      if (!manifest.files.some(file => file.path === path) && existsSync(absolute) && statSync(absolute).isDirectory()) fail('SNAPSHOT_UNCOVERED', 'Script targets must identify files, not an unbounded directory');
    }
  }
  async stableScan(signal) {
    for (let attempt = 0; attempt < SNAPSHOT_LIMITS.scanAttempts; attempt++) {
      try {
        const first = await this.io.scan({ copy: true, signal }), second = await this.io.scan({ copy: false, signal }); this.assertIdentity();
        if (digest(first.manifest) === digest(second.manifest)) return first;
      } catch (error) { if (!['SNAPSHOT_BUSY', 'ENOENT'].includes(error.code)) throw error; }
    }
    fail('SNAPSHOT_BUSY', 'Workspace did not stabilize in two capture attempts');
  }
  async capture({ requestId, reason, protectedPaths = [], signal }) {
    return this.locked(() => { this.assertAvailable(); return this.captureLocked({ requestId, reason, protectedPaths, signal }); });
  }
  async captureLocked({ requestId, reason, protectedPaths = [], signal }) {
    if (!requestId || !['main_turn', 'script', 'pre_restore'].includes(reason)) fail('SNAPSHOT_REQUEST', 'Stable request identity and a declared snapshot trigger are required');
    const id = digest(['snapshot', this.identity, requestId]), specificationHash = digest({ reason, protectedPaths }), old = this.repo.get('tree_snapshots', id);
    if (old) { if (old.specificationHash !== specificationHash) fail('IDEMPOTENCY_CONFLICT', 'Snapshot request changed'); return old; }
    const { manifest, contents } = await this.stableScan(signal); this.protectedTargets(manifest, protectedPaths);
    const commitId = this.saveGit(manifest, contents, id), manifestHash = digest(manifest);
    this.repo.command('captureTreeSnapshot', { requestId: id, expected: {}, input: { id, reason, manifestHash, commitId } }, program, () => {
      this.repo.save('tree_snapshots', { id, snapshotId: id, workspaceIdentity: this.identity, manifestHash, commitId, reason, specificationHash, manifest,
        coverage: { state: manifest.exclusions.length ? 'partial' : 'full', exclusions: manifest.exclusions, includedFiles: manifest.files.length, totalBytes: manifest.totalBytes, protectedPaths, enforcement: this.enforcement }, restoreState: 'available', capturedAt: this.repo.now() }); return { snapshotId: id };
    }); return this.repo.get('tree_snapshots', id);
  }
  snapshot(id) {
    const snapshot = this.repo.get('tree_snapshots', id);
    if (!snapshot || snapshot.restoreState === 'expired' || digest(snapshot.workspaceIdentity) !== digest(this.identity) || digest(snapshot.manifest) !== snapshot.manifestHash) fail('SNAPSHOT_UNAVAILABLE', 'Snapshot is missing or belongs to another workspace');
    return snapshot;
  }
  async preview({ snapshotId, paths = null, requestId }) {
    const actor = this.user(); if (!requestId) fail('SNAPSHOT_REQUEST', 'A preview request identity is required');
    return this.locked(async () => {
      this.assertAvailable(); const snapshot = this.snapshot(snapshotId), scan = await this.io.scan({ copy: false });
      const selected = [...new Set(paths ?? [...snapshot.manifest.files, ...scan.manifest.files].map(f => f.path))].sort(); selected.forEach(relativeFile);
      this.protectedTargets(scan.manifest, selected); this.protectedTargets(snapshot.manifest, selected);
      const changes = selected.map(path => {
        const target = snapshot.manifest.files.find(f => f.path === path) ?? null, current = scan.manifest.files.find(f => f.path === path) ?? null;
        return { path, current: fingerprint(current), target: target ? { ...fingerprint(target), size: target.size, blob: target.blob } : null, kind: target === null ? 'added' : current === null ? 'deleted' : 'changed' };
      }).filter(change => canonicalJson(change.current) !== canonicalJson(fingerprint(change.target)));
      const expectedCurrentHashes = Object.fromEntries(changes.map(change => [change.path, change.current])), id = digest(['restore-preview', requestId]);
      const value = { id, snapshotId, workspaceIdentity: this.identity, changes, expectedCurrentHashes, exclusions: scan.manifest.exclusions, actor, at: this.repo.now(), state: 'previewed' };
      return this.repo.command('previewTreeRestore', { requestId: id, expected: {}, input: { snapshotId, paths, manifestHash: digest(scan.manifest) } }, actor, () => {
        const meta = this.repo.meta(); this.repo.save('tree_meta', { ...meta, restorePreviews: { ...meta.restorePreviews, [id]: value } }, meta.revision); return value;
      }).result;
    });
  }
  saveRestore(id, updates, actor = program) {
    const current = this.repo.meta().restoreIntents?.[id], value = { ...current, ...updates, id };
    this.repo.command('recordTreeRestore', { requestId: digest([id, current?.revision ?? 0, updates]), expected: {}, input: { id, state: value.state } }, actor, () => {
      const meta = this.repo.meta(), row = meta.restoreIntents?.[id];
      if ((row?.revision ?? 0) !== (current?.revision ?? 0)) fail('RESTORE_CONFLICT', 'Restore intent changed');
      this.repo.save('tree_meta', { ...meta, restoreIntents: { ...meta.restoreIntents, [id]: { ...value, revision: (row?.revision ?? 0) + 1, updatedAt: this.repo.now() } } }, meta.revision); return { id, state: value.state };
    }); return this.repo.meta().restoreIntents[id];
  }
  loadTargets(request) {
    for (const change of request.changes) if (change.target) {
      if (!/^[a-f0-9]{40}$/.test(change.target.blob)) fail('SNAPSHOT_HASH', 'Invalid shadow Git object');
      const bytes = this.git(['cat-file', 'blob', change.target.blob], undefined, true); if (contentHash(bytes) !== change.target.sha256) fail('SNAPSHOT_HASH', 'Shadow Git target changed');
      writeFileSync(join(request.runDirectory, 'files', change.target.sha256), bytes, { mode: 0o400 });
    }
  }
  async executeIntent(id, signal) {
    const intent = this.saveRestore(id, { state: 'spawn_intent' }), request = intent.request; this.fault('spawn_intent', intent);
    let result;
    try { result = await this.io.execute(request, { sessionPolicy: this.context().sessionPolicy, signal }); }
    catch (error) { return this.saveRestore(id, { state: error.beforeSpawn ? 'failed' : 'unknown', error: { code: error.code ?? 'RESTORE_IO', message: error.message } }); }
    this.fault('worker_returned', { ...intent, result });
    const observed = this.io.inspect(request);
    if (result.code === 0 && !result.truncated && observed.journal?.phase === 'completed') {
      const final = this.saveRestore(id, { state: 'completed', receipt: observed.journal, workerExited: true }); this.fault('committed', final); this.io.cleanup(request); return final;
    }
    return this.saveRestore(id, { state: 'partial', workerExited: true, observation: observed, error: result.output?.error ?? { code: 'RESTORE_INTERRUPTED', message: 'Restore did not produce a complete success receipt' } });
  }
  async apply({ previewId, expectedCurrentHashes, requestId, signal }) {
    const actor = this.user(); if (!requestId || !expectedCurrentHashes) fail('SNAPSHOT_REQUEST', 'Restore needs an exact preview, expected file hashes and request identity');
    const id = digest(['restore', requestId]), inputHash = digest({ previewId, expectedCurrentHashes, actor });
    return this.locked(async () => {
      const prior = this.repo.meta().restoreIntents?.[id]; if (prior) { if (prior.inputHash !== inputHash) fail('IDEMPOTENCY_CONFLICT', 'Restore request changed'); return prior; }
      this.assertAvailable(); const preview = this.repo.meta().restorePreviews?.[previewId];
      if (!preview || preview.actor.id !== actor.id || digest(preview.workspaceIdentity) !== digest(this.identity) || canonicalJson(preview.expectedCurrentHashes) !== canonicalJson(expectedCurrentHashes)) fail('RESTORE_CONFLICT', 'Preview identity or expected hashes changed');
      const snapshot = this.snapshot(preview.snapshotId), scan = await this.io.scan({ copy: false, signal }); this.protectedTargets(scan.manifest, preview.changes.map(c => c.path));
      for (const change of preview.changes) if (canonicalJson(fingerprint(scan.manifest.files.find(f => f.path === change.path))) !== canonicalJson(change.current)) fail('RESTORE_CONFLICT', 'A file changed after preview: ' + change.path);
      const before = await this.captureLocked({ requestId: 'pre-restore:' + id, reason: 'pre_restore', protectedPaths: preview.changes.map(c => c.path), signal });
      const changes = preview.changes.map((change, index) => ({ ...change, stage: change.path + '.arcfold-restore-' + id.slice(0, 16) + '-' + index }));
      const request = this.io.prepare('restore', { changes });
      this.loadTargets(request);
      const intent = this.saveRestore(id, { state: 'prepared', inputHash, previewId, snapshotId: snapshot.id, beforeSnapshotId: before.id, workspaceIdentity: this.identity, actor, request, changes });
      this.fault('prepared', intent); return this.executeIntent(id, signal);
    });
  }
  async reconcile(restoreId, { signal } = {}) {
    const actor = this.context?.().actor;
    if (!actor || !['program', 'user'].includes(actor.kind) || actor.kind === 'user' && actor.id !== this.repo.meta().userId) fail('USER_RESTORE_REQUIRED', 'Only the trusted recovery owner can continue an existing user restore');
    return this.locked(async () => {
      const intent = this.repo.meta().restoreIntents?.[restoreId]; if (!intent || intent.actor.id !== this.repo.meta().userId || digest(intent.workspaceIdentity) !== digest(this.identity)) fail('RESTORE_UNAVAILABLE', 'No owned restore intent');
      if (!unfinished(intent)) return intent;
      this.assertAvailable(restoreId);
      const observed = this.io.inspect(intent.request);
      if (intent.state !== 'prepared' && observed.state === 'unknown' && !intent.workerExited) return this.saveRestore(restoreId, { state: 'unknown', observation: observed });
      const scan = await this.io.scan({ copy: false, signal }), original = intent.changes; this.protectedTargets(scan.manifest, original.map(c => c.path));
      const changes = [];
      for (const change of original) {
        const current = fingerprint(scan.manifest.files.find(f => f.path === change.path)), target = fingerprint(change.target);
        if (canonicalJson(current) !== canonicalJson(change.current) && canonicalJson(current) !== canonicalJson(target)) return this.saveRestore(restoreId, { state: 'conflict', error: { code: 'RESTORE_CONFLICT', message: 'Recovery found a later edit; a new preview is required: ' + change.path } });
        changes.push({ ...change, current, skipWrite: canonicalJson(current) === canonicalJson(target) });
      }
      if (observed.journal?.phase === 'completed' && changes.every(c => c.skipWrite)) { const final = this.saveRestore(restoreId, { state: 'completed', receipt: observed.journal }); this.io.cleanup(intent.request); return final; }
      const request = this.io.prepare('restore', { changes }); this.loadTargets(request);
      this.saveRestore(restoreId, { state: 'prepared', request, workerExited: false, priorRequests: [...(intent.priorRequests ?? []), intent.request], recoveryObservation: observed });
      return this.executeIntent(restoreId, signal);
    });
  }
  async prune(at = this.repo.now()) {
    return this.locked(async () => {
      this.assertAvailable(null, { retentionOnly: true }); const cutoff = Date.parse(at) - SNAPSHOT_LIMITS.retentionDays * 86400000;
      const referenced = new Set(Object.values(this.repo.meta().restoreIntents ?? {}).filter(unfinished).flatMap(row => [row.snapshotId, row.beforeSnapshotId]));
      for (const run of this.repo.list('tree_script_runs', run => !['succeeded', 'failed', 'revoked'].includes(run.state))) referenced.add(run.snapshotId);
      for (const run of this.unresolvedScripts()) referenced.add(run.snapshotId);
      for (const preview of Object.values(this.repo.meta().restorePreviews ?? {})) if (preview.state === 'previewed' && !Object.values(this.repo.meta().restoreIntents ?? {}).some(row => row.previewId === preview.id && !unfinished(row))) referenced.add(preview.snapshotId);
      const expired = this.repo.list('tree_snapshots', row => digest(row.workspaceIdentity) === digest(this.identity) && row.restoreState !== 'expired' && Date.parse(row.capturedAt) < cutoff && !referenced.has(row.id));
      if (!expired.length) return [];
      this.repo.command('expireTreeSnapshots', { requestId: digest(['expire-snapshots', at, expired.map(r => r.id)]), expected: Object.fromEntries(expired.map(row => ['tree_snapshots:' + row.id, row.revision])), input: { snapshotIds: expired.map(row => row.id) } }, program, () => {
        for (const row of expired) this.repo.save('tree_snapshots', { ...row, restoreState: 'expired' }, row.revision); return { snapshotIds: expired.map(row => row.id) };
      });
      for (const row of expired) this.git(['update-ref', '-d', 'refs/snapshots/' + row.id]); this.git(['gc', '--prune=now']); return expired.map(row => row.id);
    });
  }
}
