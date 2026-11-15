import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const RUNTIME_PROTOCOL = 'arcfold-runtime-v1';
const hostEntry = fileURLToPath(new URL('./runtime-host.mjs', import.meta.url));
const busy = error => ['EAGAIN', 'EWOULDBLOCK'].includes(error.code) && error.syscall === 'flock';
const validRunId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
export const lifecycleError = (code, message, details) => Object.assign(new Error(message), { code, details });
export async function readRuntimeRecord(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function writeRuntimeRecord(path, value, { exclusive = false } = {}) {
  const temporary = exclusive ? path : join(dirname(path), '.runtime-' + randomUUID());
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync(); } finally { await file.close(); }
  if (!exclusive) await rename(temporary, path);
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

/** The lock file is never deleted. PID records do not confer ownership. */
export async function acquireRuntimeLease(runtimeDirectory, { probe = false } = {}) {
  if (!['darwin', 'linux'].includes(process.platform)) throw lifecycleError('unsupported_platform', 'The runtime owner requires POSIX flock.');
  const { tryLockExclusive } = await import('@deepseek-ai/node-addon-system/flock');
  if (!probe) await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  const path = join(runtimeDirectory, 'owner.lock');
  for (let attempt = 0; attempt < 3; attempt++) {
    let handle;
    try { handle = await open(path, constants.O_RDWR | constants.O_NOFOLLOW | (probe ? 0 : constants.O_CREAT), 0o600); }
    catch (error) { if (probe && error.code === 'ENOENT') return null; throw error; }
    try {
      await tryLockExclusive(handle.fd);
      const held = await handle.stat({ bigint: true }), current = await stat(path, { bigint: true }).catch(error => {
        if (error.code === 'ENOENT') return null; throw error;
      });
      if (current && held.dev === current.dev && held.ino === current.ino) return handle;
    } catch (error) {
      await handle.close();
      if (busy(error)) {
        // A read-only status probe briefly holds the same kernel lock. Give that
        // probe a bounded chance to release; never infer ownership from a PID.
        if (!probe && attempt < 2) { await delay(10); continue; }
        throw lifecycleError('already_running', 'This data directory already has a runtime owner.');
      }
      throw error;
    }
    await handle.close();
  }
  throw lifecycleError('owner_path_changed', 'The runtime lock changed while acquiring ownership.');
}
async function ownerHeld(runtimeDirectory) {
  try { const lease = await acquireRuntimeLease(runtimeDirectory, { probe: true }); await lease?.close(); return false; }
  catch (error) { if (error.code === 'already_running') return true; throw error; }
}
export async function runtimeControl(current, method, timeoutMs = 1000) {
  if (!current || current.schema !== RUNTIME_PROTOCOL || !['status', 'stop', 'open'].includes(method) ||
      !validRunId(current.runId) || current.controlAddress?.host !== '127.0.0.1' ||
      !Number.isSafeInteger(current.controlAddress.port) || current.controlAddress.port < 1 || current.controlAddress.port > 65535)
    throw lifecycleError('invalid_runtime_record', 'No valid current runtime control identity.');
  const controlPath = join(current.dataRoot, 'runtime', 'runs', current.runId, 'control.json');
  const file = await open(controlPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let control;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600 || info.size > 4096)
      throw lifecycleError('invalid_control_owner', 'The runtime control identity is not a private user-owned file.');
    control = JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
  if (control.schema !== RUNTIME_PROTOCOL || control.runId !== current.runId || control.dataRoot !== current.dataRoot ||
      control.address?.host !== current.controlAddress.host || control.address?.port !== current.controlAddress.port ||
      typeof control.token !== 'string' || !/^[a-f0-9]{64}$/.test(control.token))
    throw lifecycleError('invalid_control_owner', 'The private runtime control identity does not match its public record.');
  return new Promise((resolve, reject) => {
    const socket = createConnection(current.controlAddress); let data = '', settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => finish(lifecycleError('control_timeout', 'The owned runtime did not answer.')), timeoutMs);
    socket.on('error', error => finish(error));
    socket.on('connect', () => socket.write(JSON.stringify({ schema: RUNTIME_PROTOCOL, runId: current.runId, dataRoot: current.dataRoot, method, token: control.token }) + '\n'));
    socket.on('data', chunk => {
      data += chunk; if (Buffer.byteLength(data) > 256 * 1024) return finish(lifecycleError('invalid_control_response', 'Runtime response is too large.'));
      if (!data.includes('\n')) return;
      try { const value = JSON.parse(data.slice(0, data.indexOf('\n')));
        if (value.schema !== RUNTIME_PROTOCOL || value.runId !== current.runId || value.dataRoot !== current.dataRoot)
          throw lifecycleError('runtime_identity_changed', 'Runtime control identity did not match.');
        if (value.controlError) {
          const messages = { unsupported_platform:'Opening the authenticated page is currently supported only on macOS.',
            runtime_not_ready:'The runtime is not ready to open its page.', browser_open_failed:'The authenticated page could not be opened.' };
          const code = value.controlError.code;
          throw lifecycleError(Object.hasOwn(messages, code) ? code : 'invalid_control_response', messages[code] ?? 'The runtime control request failed.');
        }
        if (method === 'open' && value.opened !== true) throw lifecycleError('invalid_control_response', 'The runtime did not confirm opening its page.');
        finish(null, method === 'open' ? { opened:true } : value);
      } catch (error) { finish(error); }
    });
    socket.on('end', () => { if (!settled) finish(lifecycleError('control_closed', 'Runtime control closed without a complete response.')); });
  });
}

/** Status reads existing files only; it neither initializes data nor signals PIDs. */
export async function inspectOwnedRuntime(identity) {
  const current = await readRuntimeRecord(join(identity.runtimeDirectory, 'current.json'));
  if (current && (current.schema !== RUNTIME_PROTOCOL || current.dataRoot !== identity.dataRoot || !validRunId(current.runId)))
    throw lifecycleError('invalid_runtime_record', 'Runtime metadata belongs to a different data directory.');
  const held = await ownerHeld(identity.runtimeDirectory);
  if (held) {
    if (current) try { return { ...await runtimeControl(current, 'status'), ownerHeld: true }; } catch {}
    return { schema: RUNTIME_PROTOCOL, dataRoot: identity.dataRoot, phase: 'unreachable', ownerHeld: true,
      runId: null, lastKnownRunId: current?.runId ?? null, shutdownEvidence: 'unconfirmed' };
  }
  const receipt = current && await readRuntimeRecord(join(identity.runtimeDirectory, 'runs', current.runId, 'official-shutdown-returned.json'));
  const failure = current && await readRuntimeRecord(join(identity.runtimeDirectory, 'runs', current.runId, 'failure.json'));
  const confirmed = receipt?.runId === current?.runId && receipt?.dataRoot === identity.dataRoot && receipt?.kind === 'official-shutdown-returned';
  return { schema: RUNTIME_PROTOCOL, dataRoot: identity.dataRoot, phase: 'stopped', ownerHeld: false,
    runId: current?.runId ?? null, lastPhase: current?.phase ?? null, lastError: failure ?? current?.error ?? null,
    shutdownEvidence: confirmed ? 'official-shutdown-returned' : current ? 'unconfirmed' : 'none',
    shutdownReceipt: confirmed ? receipt : null };
}
const deadlineMs = value => {
  const timeout = value ?? 60000;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 600000) throw lifecycleError('invalid_timeout', 'Use a timeout between 100 and 600000 ms.');
  return timeout;
};
export async function statusRuntime({ configPath }) {
  const { loadRuntimeIdentity } = await import('./runtime-config.mjs');
  return inspectOwnedRuntime(await loadRuntimeIdentity(configPath));
}
export async function openRuntime({ configPath, timeoutMs, signal }) {
  if (process.platform !== 'darwin') throw lifecycleError('unsupported_platform', 'Opening the authenticated page is currently supported only on macOS.');
  const timeout = deadlineMs(timeoutMs); signal?.throwIfAborted();
  const { loadRuntimeIdentity } = await import('./runtime-config.mjs');
  const identity = await loadRuntimeIdentity(configPath), before = await inspectOwnedRuntime(identity);
  if (!before.ownerHeld) throw lifecycleError('runtime_not_running', 'Start Arcfold before opening its page.');
  if (!before.runId || before.phase !== 'ready') throw lifecycleError('runtime_not_ready', 'The runtime is not ready to open its page.');
  const current = await readRuntimeRecord(join(identity.runtimeDirectory, 'current.json'));
  if (current?.runId !== before.runId) throw lifecycleError('runtime_identity_changed', 'The runtime owner changed before opening its page.');
  signal?.throwIfAborted();
  return runtimeControl(current, 'open', Math.min(timeout, 10000));
}
export async function startRuntime({ configPath, timeoutMs, signal }) {
  const timeout = deadlineMs(timeoutMs); signal?.throwIfAborted();
  const { loadRuntimePlan } = await import('./runtime-config.mjs');
  const plan = await loadRuntimePlan(configPath), existing = await inspectOwnedRuntime(plan);
  if (existing.ownerHeld) throw lifecycleError('already_running', 'This data directory already has a runtime owner.', existing);
  const runId = randomUUID(), runDirectory = join(plan.runtimeDirectory, 'runs', runId);
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  const launchFile = join(runDirectory, 'launch.json');
  await writeRuntimeRecord(launchFile, { schema: RUNTIME_PROTOCOL, runId, runDirectory, plan }, { exclusive: true });
  let output, errors, child, done, closed = false, exit, launchError;
  try {
    output = await open(join(runDirectory, 'stdout.log'), 'ax', 0o600);
    errors = await open(join(runDirectory, 'stderr.log'), 'ax', 0o600);
    child = spawn(process.execPath, [hostEntry, '--launch', launchFile], { cwd: plan.workspace, detached: true,
      stdio: ['ignore', output.fd, errors.fd], env: { ...process.env, DSH_HOME: plan.nativeHome } });
    child.once('error', error => { launchError = error; });
    done = new Promise(resolveDone => child.once('close', (code, exitSignal) => { closed = true; exit = { code, signal: exitSignal }; resolveDone(exit); }));
  } finally { await output?.close(); await errors?.close(); }
  child.unref();
  const ownStatePath = join(runDirectory, 'state.json');
  const isOwnState = value => value?.schema === RUNTIME_PROTOCOL && value.runId === runId && value.dataRoot === plan.dataRoot &&
    value.pid === child.pid && value.configurationHash === plan.configurationHash;
  let childFailureObserved = false;
  const deadline = Date.now() + timeout;
  try {
    for (;;) {
      signal?.throwIfAborted(); if (launchError) throw launchError;
      const own = await readRuntimeRecord(ownStatePath);
      if (own && !isOwnState(own)) throw lifecycleError('invalid_runtime_record', 'The startup record does not belong to this child.');
      if (own?.phase === 'failed') {
        childFailureObserved = true;
        throw lifecycleError(own.error?.code || 'startup_failed', own.error?.message || 'Runtime startup failed.', own);
      }
      if (own) {
        const current = await inspectOwnedRuntime(plan);
        if (current.ownerHeld && current.runId === runId && current.phase === 'ready') return current;
      }
      if (closed) throw lifecycleError('startup_exited', 'Runtime exited before validated readiness.', { exit, own });
      if (Date.now() >= deadline) throw lifecycleError('startup_timeout', 'Runtime readiness was not confirmed before the deadline.', { runId });
      await delay(50);
    }
  } catch (error) {
    if (!closed && !childFailureObserved) {
      const latest = await readRuntimeRecord(ownStatePath).catch(() => null);
      childFailureObserved = isOwnState(latest) && latest.phase === 'failed';
    }
    // A ChildProcess handle from this call is the only PID signal authority.
    // A verified failed child is already cleaning up. The official interrupt
    // escalates an in-progress shutdown to immediate exit, so do not add one.
    // Cancellation/timeout without that evidence still sends one SIGTERM only.
    if (!closed && !childFailureObserved && child.pid) child.kill('SIGTERM');
    let timer; try { await Promise.race([done, new Promise(resolveWait => { timer = setTimeout(resolveWait, 7000); })]); } finally { clearTimeout(timer); }
    throw error;
  }
}
export async function stopRuntime({ configPath, timeoutMs, signal }) {
  const timeout = deadlineMs(timeoutMs); signal?.throwIfAborted();
  const { loadRuntimeIdentity } = await import('./runtime-config.mjs');
  const identity = await loadRuntimeIdentity(configPath), before = await inspectOwnedRuntime(identity);
  if (!before.ownerHeld) return before;
  if (!before.runId) throw lifecycleError('runtime_unreachable', 'An owner holds the data lock but its control identity is unavailable; no PID was signalled.', before);
  const current = await readRuntimeRecord(join(identity.runtimeDirectory, 'current.json'));
  if (current?.runId !== before.runId) throw lifecycleError('runtime_identity_changed', 'The runtime owner changed before stop.');
  try { await runtimeControl(current, 'stop'); }
  catch (error) {
    const after = await inspectOwnedRuntime(identity);
    if (!after.ownerHeld && after.runId === before.runId) return after;
    throw lifecycleError('stop_unconfirmed', 'The single stop request was not acknowledged; no PID was signalled.', { runId: before.runId, cause: error.code });
  }
  const deadline = Date.now() + timeout;
  for (;;) {
    signal?.throwIfAborted(); const result = await inspectOwnedRuntime(identity);
    if (result.runId && result.runId !== before.runId) throw lifecycleError('runtime_identity_changed', 'Another runtime owns this data after the stop request.');
    if (!result.ownerHeld) return result;
    if (Date.now() >= deadline) throw lifecycleError('stop_unconfirmed', 'Stop was requested once; release of ownership remains unconfirmed.', { runId: before.runId });
    await delay(50);
  }
}
export async function restartRuntime(options) {
  const previous = await stopRuntime(options); options.signal?.throwIfAborted();
  return { ...await startRuntime(options), previous };
}
