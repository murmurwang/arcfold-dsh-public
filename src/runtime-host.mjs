import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { RUNTIME_PROTOCOL, acquireRuntimeLease, lifecycleError, writeRuntimeRecord } from './runtime-lifecycle.mjs';

const errorView = error => ({ code: error.code || 'runtime_failure', message: String(error.message || error) });
const launchBrowser = (command, args) => new Promise((resolveDone, reject) => {
  execFile(command, args, { timeout:5000, maxBuffer:65536 }, error => error ? reject(error) : resolveDone());
});

/** The URL is obtained from this host only and never leaves the opener boundary. */
export async function openRuntimeBrowser(ctx, { platform = process.platform, opener = launchBrowser } = {}) {
  if (platform !== 'darwin') throw lifecycleError('unsupported_platform', 'Opening the authenticated page is currently supported only on macOS.');
  try {
    const url = ctx.get('connection').authenticatedUrl(ctx.get('webApp').getAdvertisedUrl());
    await opener('/usr/bin/open', [url]);
    return { opened:true };
  } catch { throw lifecycleError('browser_open_failed', 'The authenticated page could not be opened.'); }
}

/** Own one host lifetime. Injected functions isolate lifecycle tests, not a CLI plugin hook. */
export async function runOwnedRuntime({ plan, runId, runDirectory }, { prepareBoot, loadOfficialHost, inspectReady, refreshReady }) {
  const lease = await acquireRuntimeLease(plan.runtimeDirectory);
  let server, controlAddress, official, stopping, cancelled = false, phase = 'starting', ready, failure, bootStarted = false;
  const controlToken = randomBytes(32);
  let officialClosed = false, shutdownEvidence = 'unconfirmed', teardownError;
  const sockets = new Set();
  const state = observation => {
    const view = { ...(ready ?? {}), ...(observation ?? {}) };
    if (ready && (phase !== 'ready' || cancelled)) {
      const reason = 'runtime-' + phase;
      view.mode = 'configuration-only';
      view.routeAvailability = { ...view.routeAvailability, main:{available:false,reason}, learn:{available:false,reason} };
      view.issues = [...new Set([...(view.issues ?? []),reason])];
      delete view.modelGate;
    }
    // Observation fields cannot replace the owned process identity or phase.
    return { ...view, schema:RUNTIME_PROTOCOL, dataRoot:plan.dataRoot, runId, pid:process.pid,
      phase, configurationHash:plan.configurationHash, controlAddress,
      ...(failure ? {error:failure} : {}), ...(teardownError ? {teardownError} : {}), shutdownEvidence };
  };
  const status = async () => {
    if (phase !== 'ready' || cancelled || !official) return state();
    const observedHost = official; let observation, timer;
    try {
      observation = await Promise.race([
        Promise.resolve().then(() => refreshReady(observedHost.ctx, plan)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(lifecycleError('readiness_refresh_timeout', 'Readiness observation timed out.')), 750); }),
      ]);
      if (!observation || !['execution-ready','configuration-only'].includes(observation.mode) ||
          typeof observation.routeAvailability?.main?.available !== 'boolean' ||
          typeof observation.routeAvailability?.learn?.available !== 'boolean' || !Array.isArray(observation.issues))
        throw lifecycleError('readiness_refresh_failed', 'Invalid readiness observation.');
      observation = { mode:observation.mode, routeAvailability:observation.routeAvailability,
        issues:observation.issues, modelGate:observation.modelGate ?? null };
    } catch (error) {
      const code = error.code === 'readiness_refresh_timeout' ? error.code : 'readiness_refresh_failed';
      observation = { mode:'configuration-only', modelGate:null,
        routeAvailability:{main:{available:false,reason:code},learn:{available:false,reason:code},credentialConfigured:null,providerCredentialValidated:false},
        issues:[code], statusObservationError:{code,message:'Current runtime readiness could not be confirmed.'} };
    } finally { clearTimeout(timer); }
    // A delayed read is never allowed to restore availability after stop/fail.
    if (phase !== 'ready' || cancelled || official !== observedHost) return state();
    return state(observation);
  };
  let writes = Promise.resolve();
  const publish = () => { const value = state(); return writes = writes.catch(() => {}).then(async () => {
    await writeRuntimeRecord(join(runDirectory, 'state.json'), value);
    await writeRuntimeRecord(join(plan.runtimeDirectory, 'current.json'), value);
  }); };
  let resolveStopped;
  const stopped = new Promise(resolveDone => { resolveStopped = resolveDone; });
  const stop = () => {
    cancelled = true;
    if (stopping) return stopping;
    // Before runProfile returns, the startup path will observe cancellation and
    // join this same shutdown operation once the official handle is available.
    if (!official) { phase = 'stopping'; void publish().catch(() => {}); return null; }
    phase = failure ? 'failed' : 'stopping';
    stopping = (async () => {
      try { official.ctx.get?.('arcfoldRuntimeGuard')?.close(); }
      catch (error) { failure ??= errorView(error); }
      await publish().catch(error => { failure ??= errorView(error); });
      await official.shutdown.shutdown(0);
      officialClosed = true;
      await writeRuntimeRecord(join(runDirectory, 'official-shutdown-returned.json'), {
        kind: 'official-shutdown-returned', schema: RUNTIME_PROTOCOL, runId, dataRoot: plan.dataRoot,
        returnedAt: new Date().toISOString(), scope: 'official profile teardown returned; user work and unknown outcomes are not declared successful',
      }, { exclusive: true });
      shutdownEvidence = 'official-shutdown-returned';
      phase = failure ? 'failed' : 'stopped'; await publish(); resolveStopped();
    })();
    void stopping.catch(error => { failure ??= errorView(error); teardownError = errorView(error); resolveStopped(); });
    return stopping;
  };
  // Do not call shutdown again in this listener. runProfile installs its own
  // SIGTERM handler; repeated interrupt would force an early process exit.
  const onTerm = () => { cancelled = true; };
  process.on('SIGTERM', onTerm);
  const exitReceipt = code => {
    try { writeFileSync(join(runDirectory, 'process-exit.json'), JSON.stringify({ runId, code, phase, at: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 }); } catch {}
  };
  process.once('exit', exitReceipt);
  try {
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
    server = createServer(socket => {
      if (socket.remoteAddress !== '127.0.0.1') { socket.destroy(); return; }
      sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
      socket.setTimeout(2000, () => socket.destroy()); let input = '', handled = false;
      socket.on('data', chunk => {
        if (handled) return; input += chunk;
        if (Buffer.byteLength(input) > 2048) { socket.destroy(); return; }
        if (!input.includes('\n')) return; handled = true;
        try {
          const request = JSON.parse(input.slice(0, input.indexOf('\n')));
          if (request.schema !== RUNTIME_PROTOCOL || request.runId !== runId || request.dataRoot !== plan.dataRoot || !['status', 'stop', 'open'].includes(request.method) ||
              Object.keys(request).some(key => !['schema','runId','dataRoot','method','token'].includes(key)) ||
              typeof request.token !== 'string' || !/^[a-f0-9]{64}$/.test(request.token) ||
              !timingSafeEqual(Buffer.from(request.token, 'hex'), controlToken)) { socket.destroy(); return; }
          if (request.method === 'open') {
            socket.setTimeout(7000, () => socket.destroy());
            const opening = phase === 'ready' && official && !cancelled ? openRuntimeBrowser(official.ctx)
              : Promise.reject(lifecycleError('runtime_not_ready', 'The runtime is not ready to open its page.'));
            void opening.then(() => socket.end(JSON.stringify({schema:RUNTIME_PROTOCOL,runId,dataRoot:plan.dataRoot,opened:true})+'\n'),
              error => socket.end(JSON.stringify({schema:RUNTIME_PROTOCOL,runId,dataRoot:plan.dataRoot,
                controlError:{code:['unsupported_platform','runtime_not_ready'].includes(error.code) ? error.code : 'browser_open_failed'}})+'\n'));
            return;
          }
          if (request.method === 'status') {
            void status().then(value => { if (!socket.destroyed) socket.end(JSON.stringify(value)+'\n'); }, () => socket.destroy());
            return;
          }
          if (request.method === 'stop') { cancelled = true; phase = failure ? 'failed' : 'stopping'; }
          socket.end(JSON.stringify(state()) + '\n');
          if (request.method === 'stop') void stop();
        } catch { socket.destroy(); }
      });
    });
    server.maxConnections = 16;
    await new Promise((listening, reject) => { server.once('error', reject); server.listen({ host:'127.0.0.1', port:0, exclusive:true }, listening); });
    controlAddress = { host:'127.0.0.1', port:server.address().port };
    // Only this 0600 record contains the independent control secret. Public
    // state, logs, errors, and command responses never include it.
    await writeRuntimeRecord(join(runDirectory, 'control.json'), { schema:RUNTIME_PROTOCOL, runId, dataRoot:plan.dataRoot,
      address:controlAddress, token:controlToken.toString('hex') }, { exclusive:true });
    await publish();
    if (!cancelled) {
      await mkdir(plan.nativeHome, { recursive: true, mode: 0o700 });
      const options = await prepareBoot(plan, runDirectory);
      if (!cancelled) {
        const { runProfile } = await loadOfficialHost(plan);
        if (!cancelled) { bootStarted = true; official = await runProfile(options); }
      }
    }
    if (official) {
      if (cancelled) await stop();
      else {
        ready = await inspectReady(official.ctx, plan);
        if (cancelled) await stop();
        else { phase = 'ready'; await writeRuntimeRecord(join(runDirectory, 'ready.json'), state(), { exclusive: true }); await publish(); await stopped; await stopping; }
      }
    } else { phase = 'cancelled'; await publish(); }
  } catch (error) {
    failure = errorView(error); phase = 'failed';
    try { official?.ctx.get?.('arcfoldRuntimeGuard')?.fail(error); }
    catch (guardError) { teardownError = errorView(guardError); }
    await writeRuntimeRecord(join(runDirectory, 'failure.json'), { ...failure, runId, bootStarted }, { exclusive: true }).catch(() => {});
    await publish().catch(() => {});
    if (official) try { await stop(); } catch {}
    throw error;
  } finally {
    await writes.catch(() => {});
    for (const socket of sockets) socket.destroy();
    if (server?.listening) await new Promise(done => server.close(done));
    process.off('SIGTERM', onTerm);
    if (!official || officialClosed) await lease.close();
    // An unexpected rejected teardown is not proof that the host stopped.
    // Keep a strong reference and its kernel lock until this private child exits.
    else process.once('exit', () => { void lease.fd; });
  }
  return { runId, phase, bootStarted };
}

async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== '--launch') throw new Error('Private runtime entry requires one launch record.');
  const launch = JSON.parse(await readFile(resolve(process.argv[3]), 'utf8'));
  if (launch.schema !== RUNTIME_PROTOCOL || typeof launch.runId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(launch.runId) || launch.runDirectory !== join(launch.plan.runtimeDirectory, 'runs', launch.runId))
    throw new Error('Invalid runtime launch identity.');
  // Set these before root boot helpers or any official module is imported.
  process.chdir(launch.plan.workspace); process.env.DSH_HOME = launch.plan.nativeHome;
  const { loadRuntimePlan, prepareRuntimeBoot } = await import('./runtime-config.mjs');
  const plan = await loadRuntimePlan(launch.plan.configPath);
  if (!isDeepStrictEqual(plan, launch.plan)) throw new Error('Runtime configuration or installation changed after the launch request.');
  await runOwnedRuntime({ ...launch, plan }, { prepareBoot: prepareRuntimeBoot,
    // The profile's Cordis peer becomes resolvable only after runProfile installs
    // official package resolution. Keep imports inside the owned error/teardown path.
    inspectReady: async (...args) => (await import('./runtime-readiness.mjs')).inspectRuntimeReady(...args),
    refreshReady: async (...args) => (await import('./runtime-readiness.mjs')).refreshRuntimeReadiness(...args),
    loadOfficialHost: async () => {
      const require = createRequire(plan.installation.installAnchor);
      return import(pathToFileURL(require.resolve('@deepseek-ai/dsh/profile-boot')).href);
    } });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) { console.error(JSON.stringify(errorView(error))); process.exit(1); }
}
