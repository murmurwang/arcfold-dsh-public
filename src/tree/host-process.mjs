import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const error = (code, message) => Object.assign(new Error(message), { code });
export const contentHash = value => createHash('sha256').update(value).digest('hex');
export const beneath = (path, root) => path === root || path.startsWith(root + sep);
const quoted = value => JSON.stringify(value);
const pathFilter = value => `(subpath ${quoted(value)})`;
function anchorDirectories(policy) {
  const paths = new Set();
  for (const root of [...policy.protectedRoots, policy.runtimeRoot, ...(policy.immutableRoots ?? [])]) {
    let path = dirname(root);
    while (path !== dirname(path)) { paths.add(path); path = dirname(path); }
    paths.add(path);
  }
  return `(deny file-write* ${[...paths].map(p => `(literal ${quoted(p)})`).join(' ')})`;
}

export function canonicalPath(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw error('PATH_INVALID', 'An absolute path is required');
  let ancestor = resolve(path), suffix = [];
  while (!existsSync(ancestor)) {
    if (dirname(ancestor) === ancestor) throw error('PATH_INVALID', 'No existing ancestor');
    suffix.unshift(ancestor.slice(dirname(ancestor).length + 1)); ancestor = dirname(ancestor);
  }
  return join(realpathSync(ancestor), ...suffix);
}

/** Intersect a declared ceiling with actual session writes; extra roots never widen it. */
export function processPolicy({ workspace, protectedRoots, runtimeRoot, immutableRoots = [], sessionPolicy, authorizedWriteRoots = [] }) {
  workspace = realpathSync(workspace); runtimeRoot = realpathSync(runtimeRoot);
  const protectedPaths = [...new Set(protectedRoots.map(canonicalPath))];
  if (!protectedPaths.length || protectedPaths.some(p => beneath(runtimeRoot, p)))
    throw error('PROTECTION_INVALID', 'Separate private artifacts/data from the ephemeral execution directory');
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(sessionPolicy?.mode))
    throw error('POLICY_INVALID', 'An explicit live session policy is required');
  const sessionRoot = realpathSync(sessionPolicy.workspaceRoot);
  const writeRoots = sessionPolicy.mode === 'read-only' ? [] : authorizedWriteRoots.map(canonicalPath).map(p => {
    if (!beneath(p, workspace) || !beneath(p, sessionRoot)) throw error('WRITE_ROOT_DENIED', 'Write grant exceeds workspace/session ceiling');
    if (protectedPaths.some(root => beneath(p, root)) || beneath(p, runtimeRoot)) throw error('WRITE_ROOT_DENIED', 'Protected write target');
    return p;
  });
  return Object.freeze({ workspace, runtimeRoot, protectedRoots: protectedPaths, immutableRoots: immutableRoots.map(canonicalPath), writeRoots });
}

/** Kernel file denials are mandatory even when the workspace contains private data. */
export function macScriptProfile(policy, runDirectory, node = process.execPath) {
  const run = realpathSync(runDirectory), executable = realpathSync(node);
  if (!beneath(run, policy.runtimeRoot) || run === policy.runtimeRoot) throw error('RUN_ROOT_INVALID', 'Owned per-run directory required');
  const exclusions = [...policy.protectedRoots, policy.runtimeRoot].map(p => `(require-not ${pathFilter(p)})`).join(' ');
  const within = root => `(require-all ${pathFilter(root)} ${exclusions})`;
  const writable = root => `(require-all ${within(root)} ${(policy.immutableRoots ?? []).map(p => `(require-not ${pathFilter(p)})`).join(' ')})`;
  return [
    '(version 1)', '(deny default)', '(import "dyld-support.sb")', '(allow syscall*)',
    // No import of system.sb: it broadly grants XPC lookup. Node only needs its
    // fixed interpreter/libraries, JIT, metadata and a small read-only sysctl set.
    '(allow sysctl-read)', '(allow dynamic-code-generation)',
    '(allow process-exec (literal ' + quoted(executable) + '))',
    '(allow file-read-metadata)',
    `(allow file-read* file-map-executable (literal ${quoted(executable)}) (subpath "/System") (subpath "/usr/lib") (subpath "/usr/share") (subpath "/private/var/db/timezone"))`,
    `(allow file-read* ${within(policy.workspace)} ${pathFilter(run)} (literal "/dev/null") (literal "/dev/urandom"))`,
    `(allow file-write* ${pathFilter(run)} (literal "/dev/null") ${policy.writeRoots.map(writable).join(' ')})`,
    anchorDirectories(policy),
    // Deny-by-default covers network (including Unix sockets), task inspection,
    // signal and fork. Generated scripts have no ambient child-process grant.
  ].join('\n');
}

/** Ordinary command processes retain their session grants but cannot see private artifacts. */
export function macMainProfile(policy) {
  const hidden = [...policy.protectedRoots, policy.runtimeRoot];
  const exclusions = [...hidden, ...(policy.immutableRoots ?? [])].map(p => `(require-not ${pathFilter(p)})`).join(' ');
  return ['(version 1)', '(allow default)',
    `(deny file-read* file-write* file-map-executable ${hidden.map(pathFilter).join(' ')})`,
    '(deny file-write*)',
    `(allow file-write* (literal "/dev/null") ${policy.writeRoots.map(p => `(require-all ${pathFilter(p)} ${exclusions})`).join(' ')})`,
    '(deny process-info* mach-task-name mach-lookup)', '(allow process-info* (target self))', '(deny signal)',
    anchorDirectories(policy),
  ].join('\n');
}

/** Closed boundary, not a fallback to the original argv. Linux remains unverified. */
export function confinedArgv({ policy, runDirectory, argv, kind = 'script', platform = process.platform }) {
  if (platform !== 'darwin') throw error('SANDBOX_UNAVAILABLE', 'This platform has no validated tree confinement backend');
  if (!Array.isArray(argv) || !argv.length || argv.some(v => typeof v !== 'string' || v.includes('\0')))
    throw error('ARGV_INVALID', 'Exact argv required');
  if (!['script', 'main'].includes(kind)) throw error('POLICY_INVALID', 'Unknown process owner');
  if (kind === 'script' && realpathSync(argv[0]) !== realpathSync(process.execPath)) throw error('INTERPRETER_DENIED', 'Only fixed Node is supported');
  // Desktop's signed Electron executable supplies Node for its own workers.
  const runAsNode = argv[0] === process.execPath && Boolean(process.versions.electron) &&
    process.env.ELECTRON_RUN_AS_NODE === '1';
  return { argv: ['/usr/bin/sandbox-exec', '-p', kind === 'script' ? macScriptProfile(policy, runDirectory) : macMainProfile(policy), '--', ...argv],
    enforcement: 'full', platform, kind, runAsNode };
}

export async function spawnConfined(wrapped, { cwd, runDirectory, signal, input, timeoutMs = 30000, outputLimit = 1048576, assertCurrent = () => {} }) {
  if (wrapped?.enforcement !== 'full') throw error('SANDBOX_UNAVAILABLE', 'Full enforcement required');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 ||
      !Number.isInteger(outputLimit) || outputLimit < 1 || outputLimit > 1048576) throw error('LIMIT_INVALID', 'Execution limits exceed contract');
  signal?.throwIfAborted(); await assertCurrent(); signal?.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    let size = 0, truncated = false, reason = null, spawnError, groupKilled = false; const captured = { stdout: [], stderr: [] };
    const child = spawn(wrapped.argv[0], wrapped.argv.slice(1), { cwd, detached: true,
      env: { PATH: '/usr/bin:/bin', HOME: runDirectory, TMPDIR: runDirectory, LANG: 'en_US.UTF-8', TZ: 'UTC',
        ...(wrapped.runAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    if (child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(input); }
    const killGroup = () => {
      if (!child.pid || groupKilled) return;
      try { process.kill(-child.pid, 'SIGKILL'); groupKilled = true; }
      catch (e) { if (e.code === 'ESRCH') groupKilled = true; else spawnError = e; }
    };
    // Several already-buffered output chunks can arrive after the first kill.
    // Do not signal the same terminating group repeatedly (macOS may report
    // EPERM for a group containing only unreaped zombies).
    const stop = why => { reason ??= why; killGroup(); };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const abort = () => stop('cancelled'); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    for (const [stream, which] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) stream.on('data', bytes => {
      const retained = bytes.subarray(0, Math.max(0, outputLimit - size));
      if (retained.length) captured[which].push(Buffer.from(retained));
      size += bytes.length;
      if (size > outputLimit) { truncated = true; stop('output-limit'); }
    });
    child.on('error', e => { spawnError = e; });
    child.on('close', (code, exitSignal) => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      // Also close any child that remained in this owned group after its leader.
      killGroup();
      if (spawnError) reject(spawnError);
      else {
        // Decode after joining chunks so a split UTF-8 character is preserved.
        // Invalid byte replacement can expand UTF-8 length; cap that final
        // representation too, without ending on a partial character.
        let remaining = outputLimit;
        const decode = parts => {
          const encoded = Buffer.from(Buffer.concat(parts).toString('utf8'));
          if (encoded.length > remaining) { truncated = true; reason ??= 'output-limit'; }
          const value = new TextDecoder().decode(encoded.subarray(0, remaining), { stream: true }); remaining -= Buffer.byteLength(value); return value;
        };
        const stdout = decode(captured.stdout), stderr = decode(captured.stderr);
        resolveResult({ code, signal: exitSignal, stdout, stderr, truncated, reason });
      }
    });
  });
}

/** Clamp the host's explicit danger-mode bypass before invoking its real executor. */
export function protectedBashClass(Base, readPolicy) {
  return class ProtectedBash extends Base {
    execute(spec) {
      if (!spec.sandboxPolicy) throw error('POLICY_INVALID', 'No live session policy');
      return super.execute({ ...spec, sandboxPolicy: { ...spec.sandboxPolicy,
        mode: spec.sandboxPolicy.mode === 'danger-full-access' ? 'workspace-write' : spec.sandboxPolicy.mode } });
    }
    async confine(command, sessionPolicy, signal) {
      signal?.throwIfAborted();
      const policy = await readPolicy(sessionPolicy);
      return { ...confinedArgv({ policy, kind: 'main', argv: ['/bin/bash', '-c', command] }),
        denialSignatures: ['Operation not permitted', 'Permission denied'] };
    }
  };
}

const fsMethods = new Set(['resolve', 'stat', 'lstat', 'readText', 'readBytes', 'readByteRange', 'listDir', 'writeText', 'editText', 'patchText', 'deleteFile', 'moveFile']);
let mutationTail = Promise.resolve();
/**
 * Actual DSH filesystem methods run behind the same kernel fence as commands.
 * A pathname check alone is insufficient: a concurrent shell can swap symlinks
 * after the check. The host provider's original atomic write/CAS code is reused.
 */
export function protectedFileSystemClass(Base, { readPolicy, cordisUrl, fileSystemUrl }) {
  const remote = async (method, args, signal, sessionPolicy) => {
    signal?.throwIfAborted();
    const policy = await readPolicy(sessionPolicy);
    const worker = fileURLToPath(import.meta.url);
    const immutableRoots = [...new Set([...(policy.immutableRoots ?? []), dirname(worker), dirname(fileURLToPath(fileSystemUrl))])];
    const wrapped = confinedArgv({ policy: { ...policy, immutableRoots }, kind: 'main', argv: [process.execPath, worker, '--tree-filesystem-worker'] });
    const result = await spawnConfined(wrapped, { cwd: policy.workspace, runDirectory: policy.workspace, signal,
      input: JSON.stringify({ method, args, cordisUrl, fileSystemUrl, cwd: policy.workspace }) });
    if (result.code !== 0 || result.truncated) throw error('FS_SANDBOX_DENIED', result.stderr || 'Filesystem worker failed or exceeded output limit');
    let response;
    try { response = JSON.parse(result.stdout); } catch { throw error('FS_SANDBOX_DENIED', 'No complete filesystem worker receipt'); }
    if (response.error) throw error(response.error.code, response.error.message);
    return response.bytes ? Uint8Array.from(Buffer.from(response.bytes, 'base64')) : response.value;
  };
  const mutate = (method, args, signal, policy) => {
    const result = mutationTail.then(() => remote(method, args, signal, policy));
    mutationTail = result.then(() => {}, () => {}); return result;
  };
  return class ProtectedFileSystem extends Base {
    get sandboxMode() { return 'workspace-write'; }
    resolve(path, opts) { return remote('resolve', [path, { cwd: opts?.cwd }], opts?.signal); }
    stat(target, signal) { return remote('stat', [target], signal); }
    lstat(path, opts, signal) { return remote('lstat', [path, opts], signal); }
    readText(target, signal) { return remote('readText', [target], signal); }
    readBytes(target, signal, maxBytes) { return remote('readBytes', [target, null, maxBytes], signal); }
    readByteRange(target, range, signal) { return remote('readByteRange', [target, range], signal); }
    async streamText(target, signal) {
      // Streaming retains the provider's exact UTF-8/binary contract; errors at
      // this bounded transport are explicit, never a successful truncation.
      const text = await this.readText(target, signal);
      return (async function* () { yield text; })();
    }
    listDir(target, signal) { return remote('listDir', [target], signal); }
    writeText(target, content, expected, signal, policy) { return mutate('writeText', [target, content, expected], signal, policy); }
    editText(target, edit, expected, signal, policy) { return mutate('editText', [target, edit, expected], signal, policy); }
    patchText(target, hunks, expected, signal, policy) { return mutate('patchText', [target, hunks, expected], signal, policy); }
    deleteFile(target, expected, signal, policy) { return mutate('deleteFile', [target, expected], signal, policy); }
    moveFile(source, destination, options, signal, policy) { return mutate('moveFile', [source, destination, options], signal, policy); }
    watch() { throw error('FS_WATCH_UNAVAILABLE', 'Protected watcher is not implemented; never use an unrestricted watcher'); }
  };
}

if (process.argv[2] === '--tree-filesystem-worker' && resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  let body = '';
  for await (const chunk of process.stdin) { body += chunk; if (Buffer.byteLength(body) > 1048576) throw error('INPUT_LIMIT', 'Filesystem request exceeds limit'); }
  let ctx;
  try {
    const request = JSON.parse(body);
    if (!fsMethods.has(request.method)) throw error('METHOD_INVALID', 'Unsupported filesystem operation');
    const [{ Context }, { default: Local }] = await Promise.all([import(request.cordisUrl), import(request.fileSystemUrl)]);
    ctx = new Context();
    const fileSystem = new Local(ctx, { cwd: request.cwd, diffBasisMaxBytes: 65536 });
    const args = request.args.map(value => value === null ? undefined : value);
    const value = await fileSystem[request.method](...args);
    process.stdout.write(JSON.stringify(value instanceof Uint8Array ? { bytes: Buffer.from(value).toString('base64') } : { value }));
  } catch (e) { process.stdout.write(JSON.stringify({ error: { code: e.code ?? 'FS_WORKER_ERROR', message: e.message } })); }
  finally { if (ctx) await ctx.fiber.dispose(); }
}

export function denyPrivatePath(path, policy) {
  const target = canonicalPath(path);
  if ([...policy.protectedRoots, policy.runtimeRoot].some(root => beneath(target, root)))
    throw error('PRIVATE_ARTIFACT_DENIED', 'Ordinary tools cannot access private artifacts or runtime data');
  return target;
}

/** A minimal capability owner; B4 adds snapshot and durable run-intent services. */
export class ScriptBoundary {
  #runs = new Map();
  constructor({ policy, resolveArtifact, assertCurrent, record }) {
    if ([resolveArtifact, assertCurrent, record].some(fn => typeof fn !== 'function')) throw error('BROKER_INVALID', 'Trusted artifact/authorization/audit services required');
    this.policy = policy; this.resolveArtifact = resolveArtifact; this.assertCurrent = assertCurrent; this.record = record;
    mkdirSync(policy.runtimeRoot, { recursive: true, mode: 0o700 });
  }
  revoke(predicate) { for (const run of this.#runs.values()) if (predicate(run.ticket)) run.abort.abort(); }
  async run(ticket, args, { signal, readOnly = false, timeoutMs = 30000, beforeSpawn = async () => {} } = {}) {
    const frozen = structuredClone(ticket);
    await this.assertCurrent(frozen);
    const artifact = await this.resolveArtifact(frozen);
    if (!artifact || !Array.isArray(artifact.files) || artifact.files.length < 1 || artifact.files.length > 16) throw error('ARTIFACT_INVALID', 'Bounded immutable artifact required');
    const root = mkdtempSync(join(this.policy.runtimeRoot, 'run-'));
    const abort = new AbortController(), id = randomUUID();
    this.#runs.set(id, { ticket: frozen, abort });
    const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
    try {
      let bytes = 0; const names = new Set();
      for (const file of artifact.files) {
        if (typeof file.path !== 'string' || !file.path.endsWith('.mjs') || isAbsolute(file.path) || file.path.includes('\\') || file.path.includes('\0') ||
            file.path.split('/').some(p => !p || p === '.' || p === '..') || names.has(file.path)) throw error('ARTIFACT_INVALID', 'Unique relative ESM files required');
        names.add(file.path);
        const source = canonicalPath(file.sourcePath);
        if (!this.policy.protectedRoots.some(p => beneath(source, p)) || !statSync(source).isFile() || lstatSync(file.sourcePath).isSymbolicLink())
          throw error('ARTIFACT_INVALID', 'Private regular artifact file required');
        const content = readFileSync(source); bytes += content.length;
        if (bytes > 262144 || contentHash(content) !== file.sha256) throw error('ARTIFACT_HASH_MISMATCH', 'Artifact changed or exceeds size limit');
        const target = join(root, file.path); mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); writeFileSync(target, content, { flag: 'wx', mode: 0o400 });
      }
      if (!names.has(artifact.entry)) throw error('ARTIFACT_INVALID', 'Entry is not a verified artifact');
      const input = JSON.stringify(args);
      if (typeof input !== 'string' || Buffer.byteLength(input) > 65536) throw error('ARGS_INVALID', 'Bounded JSON args required');
      const inputPath = join(root, 'input.json'); writeFileSync(inputPath, input, { flag: 'wx', mode: 0o400 });
      const policy = readOnly ? { ...this.policy, writeRoots: [] } : this.policy;
      const wrapped = confinedArgv({ policy, runDirectory: root, argv: [process.execPath, join(root, artifact.entry), '--input', inputPath, ...(readOnly ? ['--dry-run'] : [])] });
      await this.record({ id, phase: 'prepared', ticket: frozen, artifactHash: contentHash(artifact.files.map(f => f.sha256).join(':')) });
      await beforeSpawn();
      const result = await spawnConfined(wrapped, { cwd: policy.workspace, runDirectory: root, signal: combined, timeoutMs,
        ...(readOnly ? { timeoutMs: Math.min(timeoutMs, 10000) } : {}),
        outputLimit: readOnly ? 65536 : 1048576, assertCurrent: () => this.assertCurrent(frozen) });
      await this.record({ id, phase: 'completed', result }); return result;
    } finally { this.#runs.delete(id); rmSync(root, { recursive: true, force: true }); }
  }
}
