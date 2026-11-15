// These subprocesses use the exact lifecycle source with a small fake official
// profile implementation. Selected shutdown regressions extract and hash-check
// the pinned official controller itself. They exercise OS ownership/IPC, not
// DSH plugin boot, credentials, a model, or the configuration contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
import { openRuntimeBrowser } from '../src/runtime-host.mjs';

const source = dirname(dirname(fileURLToPath(import.meta.url)));
const json = async path => JSON.parse(await readFile(path, 'utf8'));
async function until(read, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const result = await read(); if (result) return result;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await delay(15);
  }
}
async function exists(path) { try { await stat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
const digest = value => createHash('sha256').update(value).digest('hex');

async function copyOfficialShutdown(directory) {
  const require = createRequire(join(source, 'package.json'));
  const entry = require.resolve('@deepseek-ai/dsh/profile-boot');
  const entryText = await readFile(entry, 'utf8');
  const chunk = entryText.match(/from "(\.\/profile-boot-[^"/]+\.js)"/);
  assert.ok(chunk, 'The pinned official profile-boot entry must identify its implementation chunk.');
  const text = await readFile(join(dirname(entry), chunk[1]), 'utf8');
  const marker = '//#region lib/types/process-shutdown.js\n';
  const start = text.indexOf(marker), end = text.indexOf('//#endregion', start);
  assert.ok(start >= 0 && end > start, 'The pinned official shutdown region must exist.');
  const controller = text.slice(start, end + '//#endregion'.length);
  assert.equal(digest(controller), '3d2a24919925fc7dc5922991086ccff4b570effccd00a0dee6725f5881b0b631');
  const target = join(directory, 'official-shutdown.mjs');
  await writeFile(target, controller + '\nexport { createProcessShutdown };\n', { flag:'wx' });
  return target;
}

async function fixture(t, options = {}) {
  const { longDataRoot = false, separatedProfile = false, ...configuration } = options;
  const root = await realpath(await mkdtemp(join(tmpdir(), 'arcfold-lifecycle-test-')));
  const profileDir = join(root, 'profile');
  const directory = separatedProfile ? join(profileDir, 'node_modules/@arcfold/dsh') : join(root, 'product');
  const install = join(root, 'installation'), workspace = join(root, 'workspace');
  const dataRoot = join(root, longDataRoot ? 'long-durable-data-'.repeat(9) : 'data'), runtimeDirectory = join(dataRoot, 'runtime');
  await Promise.all([mkdir(join(directory, 'src'), { recursive: true }), mkdir(workspace),
    mkdir(join(install, 'node_modules/@deepseek-ai/dsh'), { recursive: true })]);
  if (separatedProfile) {
    // Real split installation: a profile product has the flock dependency but
    // cannot see host-owned Cordis through any ancestor node_modules directory.
    await mkdir(join(directory, 'node_modules/@deepseek-ai'), {recursive:true});
    await symlink(join(source, 'node_modules/@deepseek-ai/node-addon-system'),
      join(directory, 'node_modules/@deepseek-ai/node-addon-system'), 'dir');
    for (const name of ['cordis', 'dsh-app-boot'])
      await symlink(join(source, 'node_modules/@deepseek-ai', name), join(install, 'node_modules/@deepseek-ai', name), 'dir');
    await writeFile(join(directory,'package.json'),JSON.stringify({name:'@arcfold/dsh',version:'0.1.0',type:'module',
      peerDependencies:{'@deepseek-ai/cordis':'4.1.0'}}));
    await writeFile(join(profileDir,'package.json'),JSON.stringify({name:'fixture-profile',private:true,
      dependencies:{'@arcfold/dsh':'0.1.0'},dsh:{profile:{bundles:[]}}}));
    for (const name of ['runtime-guard.mjs','learning-defaults.mjs','store.mjs'])
      await copyFile(join(source,'src',name),join(directory,'src',name));
  } else await symlink(join(source, 'node_modules'), join(directory, 'node_modules'), 'dir');
  for (const name of ['runtime-lifecycle.mjs', 'runtime-host.mjs'])
    await copyFile(join(source, 'src', name), join(directory, 'src', name));
  await writeFile(join(directory, 'src/runtime-config.mjs'), `
    import { readFile, writeFile } from 'node:fs/promises';
    import { createHash } from 'node:crypto';
    import { join } from 'node:path';
    export async function loadRuntimeIdentity(configPath) {
      const p = JSON.parse(await readFile(configPath, 'utf8'));
      return { configPath, dataRoot:p.dataRoot, runtimeDirectory:p.runtimeDirectory };
    }
    export async function loadRuntimePlan(configPath) {
      const raw = await readFile(configPath, 'utf8');
      return {...JSON.parse(raw), configPath, configurationHash:createHash('sha256').update(raw).digest('hex')};
    }
    export async function prepareRuntimeBoot(plan, runDirectory) {
      await writeFile(join(runDirectory,'prepare.json'), JSON.stringify({cwd:process.cwd(),home:process.env.DSH_HOME}));
      return {runDirectory, config:plan.config};
    }
  `);
  const readinessPrelude = separatedProfile ? `
    import { symbols } from '@deepseek-ai/cordis';
    import { getRuntimeGuard } from './runtime-guard.mjs';
    const launch = JSON.parse(await readFile(process.argv[3], 'utf8'));
    await writeFile(join(launch.runDirectory,'readiness-import.json'),JSON.stringify({guardImported:typeof getRuntimeGuard==='function'}));
    if (launch.plan.config.readinessImportFailure)
      throw Object.assign(new Error('fixture readiness module import failed'),{code:'fixture_readiness_import_failure'});
  ` : '';
  await writeFile(join(directory, 'src/runtime-readiness.mjs'), `
    import assert from 'node:assert/strict';
    ${readinessPrelude}
    import { access, readFile, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { setTimeout as delay } from 'node:timers/promises';
    let heldFirstStatus=false;
    export async function inspectRuntimeReady(ctx, plan) {
      if (plan.config.separatedProfile) assert.equal(ctx.cordisSymbols,symbols,'Readiness must consume the same official Cordis instance');
      await writeFile(join(ctx.runDirectory,'readiness-entered.json'),'{}');
      if (plan.config.readinessFailure) throw Object.assign(new Error('fixture readiness failed'), {code:'fixture_readiness_failure'});
      while (plan.config.readinessGate) {
        try { await access(plan.config.readinessGate); break; } catch { await delay(10); }
      }
      return { mode:plan.config.mode ?? 'configuration-only', url:'http://127.0.0.1:1234/',
        identity:{fixture:true}, routeAvailability:{main:{available:plan.config.mode==='execution-ready',model:'initial-main'},learn:{available:false}}, issues:[] };
    }
    export async function refreshRuntimeReadiness(ctx, plan) {
      const value=JSON.parse(await readFile(plan.config.statusPath,'utf8'));
      let gate=value.gate;
      if(gate&&value.onlyFirst) {if(heldFirstStatus) gate=null;else heldFirstStatus=true;}
      await writeFile(join(ctx.runDirectory,'status-refresh-entered.json'),JSON.stringify({gate:gate??null}));
      if(value.fail) throw new Error('fixture observation failure with private detail');
      if(value.hang) await new Promise(()=>{});
      if(value.invalid) return undefined;
      while(gate) {
        try {await access(gate);break;} catch {await delay(10);}
      }
      await writeFile(join(ctx.runDirectory,'status-refresh-returned.json'),JSON.stringify({gate:gate??null}));
      const {gate:ignoredGate,onlyFirst,fail,hang,invalid,...observation}=value;
      return observation;
    }
  `);
  await writeFile(join(install, 'package.json'), JSON.stringify({type:'module',dependencies:
    separatedProfile ? {'@deepseek-ai/cordis':'4.1.0','@deepseek-ai/dsh-app-boot':'0.2.2-rc.1'} : {}}));
  await writeFile(join(install, 'node_modules/@deepseek-ai/dsh/package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', type: 'module', exports: { './profile-boot': './profile-boot.mjs' } }));
  if (configuration.officialShutdown) await copyOfficialShutdown(join(install, 'node_modules/@deepseek-ai/dsh'));
  await writeFile(join(install, 'node_modules/@deepseek-ai/dsh/profile-boot.mjs'), `
    import { appendFileSync } from 'node:fs';
    import { access, appendFile, readFile, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { setTimeout as delay } from 'node:timers/promises';
    const launch = JSON.parse(await readFile(process.argv[3], 'utf8'));
    await writeFile(join(launch.runDirectory,'official-import.json'), JSON.stringify({cwd:process.cwd(),home:process.env.DSH_HOME}));
    export async function runProfile(options) {
      const {runDirectory,config} = options;
      await writeFile(join(runDirectory,'official-start.json'),'{}');
      if (config.startFailure) {
        await writeFile(join(runDirectory,'startup-cleaned.json'),'{}');
        throw Object.assign(new Error('fixture boot failed after cleanup'), {code:'fixture_start_failure'});
      }
      let resolverContext, cordisSymbols;
      if (config.separatedProfile) {
        const {Context,symbols} = await import('@deepseek-ai/cordis');
        const {PluginPackages,createRuntimeResolution,loadProfileDirectory} = await import('@deepseek-ai/dsh-app-boot');
        const profile = loadProfileDirectory('dsh',config.profileDir,launch.plan.installation.installAnchor,{userLayer:false});
        if (profile.skippedBundles.length) throw new Error('Fixture profile unexpectedly skipped a bundle');
        const resolution = await createRuntimeResolution({installAnchor:launch.plan.installation.installAnchor,profile,home:launch.plan.nativeHome});
        resolverContext = new Context();
        await resolverContext.plugin(PluginPackages,{resolution});
        cordisSymbols = symbols;
        await writeFile(join(runDirectory,'official-resolver-ready.json'),JSON.stringify({profileDir:profile.dir}));
      }
      const shutdown = async () => {
        appendFileSync(join(runDirectory,'guard-and-close.jsonl'),JSON.stringify({event:'official-shutdown'})+'\\n');
        await appendFile(join(runDirectory,'shutdown-calls.jsonl'), JSON.stringify({at:Date.now()})+'\\n');
        if (config.forceExit) process.exit(0);
        while (config.shutdownGate) {
          try { await access(config.shutdownGate); break; } catch { await delay(10); }
        }
        await resolverContext?.fiber.dispose();
      };
      let controller = {shutdown};
      if (config.officialShutdown) {
        const {createProcessShutdown} = await import('./official-shutdown.mjs');
        controller = createProcessShutdown(shutdown, code => {
          appendFileSync(join(runDirectory,'official-force-exit.jsonl'),JSON.stringify({code})+'\\n');
          process.exit(code);
        }, code => {process.exitCode = code;}, config.shutdownTimeoutMs ?? 5000);
        process.on('SIGTERM', () => {
          appendFileSync(join(runDirectory,'official-interrupt.jsonl'),JSON.stringify({code:0})+'\\n');
          controller.interrupt(0);
        });
      } else process.on('SIGTERM', () => { void shutdown().then(() => process.exit(0)); });
      const guard = {
        close() { appendFileSync(join(runDirectory,'guard-and-close.jsonl'),JSON.stringify({event:'guard-close'})+'\\n'); },
        fail(error) { appendFileSync(join(runDirectory,'guard-and-close.jsonl'),JSON.stringify({event:'guard-fail',code:error.code})+'\\n'); },
      };
      return {ctx:{runDirectory,cordisSymbols,get:name => name==='arcfoldRuntimeGuard' ? guard : undefined},shutdown:controller};
    }
  `);
  const configPath = join(root, 'runtime.json');
  const statusPath=join(root,'status-input.json');
  const config = { mode: 'configuration-only', ...configuration, statusPath, separatedProfile, profileDir };
  await writeFile(statusPath,JSON.stringify({mode:config.mode,issues:[],modelGate:{phase:'ready',reason:null},
    routeAvailability:{main:{available:config.mode==='execution-ready',model:'initial-main'},learn:{available:false},credentialConfigured:false,providerCredentialValidated:false}}));
  const plan = { dataRoot, runtimeDirectory, nativeHome: join(dataRoot, 'native'), businessFilename: join(dataRoot, 'business.sqlite'),
    workspace, installation: { installAnchor: join(install, 'package.json') }, config };
  await writeFile(configPath, JSON.stringify(plan));
  const api = await import(pathToFileURL(join(directory, 'src/runtime-lifecycle.mjs')).href);
  const state = () => api.statusRuntime({ configPath });
  const record = () => api.readRuntimeRecord(join(runtimeDirectory, 'current.json'));
  const release = path => writeFile(path, 'released');
  t.after(async () => {
    for (const path of [config.readinessGate, config.shutdownGate]) if (path) await release(path);
    const observation=await json(statusPath);
    if(observation.gate) await release(observation.gate);
    delete observation.hang; delete observation.fail; delete observation.invalid;
    await writeFile(statusPath,JSON.stringify(observation));
    await api.stopRuntime({ configPath, timeoutMs: 10000 }).catch(() => {});
  });
  return { root, directory, plan, configPath, statusPath, api, state, record, release,
    run: id => join(runtimeDirectory, 'runs', id),
    start: extra => api.startRuntime({ configPath, timeoutMs: 15000, ...extra }),
    stop: extra => api.stopRuntime({ configPath, timeoutMs: 10000, ...extra }) };
}

test('status does not create data and stale PID metadata never authorizes signalling', async t => {
  const f = await fixture(t);
  assert.equal((await f.state()).shutdownEvidence, 'none');
  assert.equal(await exists(f.plan.dataRoot), false);
  await mkdir(f.plan.runtimeDirectory, { recursive: true });
  await writeFile(join(f.plan.runtimeDirectory, 'current.json'), JSON.stringify({ schema:'arcfold-runtime-v1',
    dataRoot:f.plan.dataRoot, runId:'stale', pid:process.pid, phase:'ready', controlPath:join(f.root,'missing.sock') }));
  assert.equal((await f.stop()).shutdownEvidence, 'unconfirmed');
  assert.equal(await exists(join(f.plan.runtimeDirectory, 'owner.lock')), false);
});

test('start sets cwd/home before official imports; restart preserves data and explicit configuration', { timeout: 40000 }, async t => {
  const f = await fixture(t), initialConfig = await readFile(f.configPath);
  const first = await f.start();
  assert.equal(first.mode, 'configuration-only');
  assert.equal(first.ownerHeld, true);
  assert.deepEqual(await json(join(f.run(first.runId), 'official-import.json')), { cwd:f.plan.workspace, home:f.plan.nativeHome });
  assert.deepEqual(await json(join(f.run(first.runId), 'prepare.json')), { cwd:f.plan.workspace, home:f.plan.nativeHome });
  await assert.rejects(f.start(), { code:'already_running' });
  await writeFile(join(f.plan.nativeHome, 'unfinished-session-original'), 'unknown outcome remains unknown');
  await writeFile(f.plan.businessFilename, 'fixture durable record, not a real SQLite database');
  const original = digest(await readFile(f.plan.businessFilename));
  const second = await f.api.restartRuntime({ configPath:f.configPath, timeoutMs:15000 });
  assert.notEqual(second.runId, first.runId);
  assert.equal(second.previous.shutdownEvidence, 'official-shutdown-returned');
  assert.equal(digest(await readFile(f.plan.businessFilename)), original);
  assert.equal(await readFile(join(f.plan.nativeHome,'unfinished-session-original'),'utf8'), 'unknown outcome remains unknown');
  assert.deepEqual(await readFile(f.configPath), initialConfig);
  const stopped = await f.stop();
  assert.equal(stopped.shutdownEvidence, 'official-shutdown-returned');
  assert.deepEqual((await readFile(join(f.run(second.runId),'guard-and-close.jsonl'),'utf8')).trim().split('\n').map(JSON.parse),
    [{event:'guard-close'},{event:'official-shutdown'}]);
  assert.equal((await f.stop()).runId, second.runId);
});

test('simultaneous starts yield exactly one kernel owner', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const attempts = await Promise.allSettled([f.start(), f.start()]);
  assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
  const ready = attempts.find(r => r.status === 'fulfilled').value;
  assert.equal((await f.state()).runId, ready.runId);
  const runs = await readdir(join(f.plan.runtimeDirectory, 'runs'));
  const boots = await Promise.all(runs.map(id => exists(join(f.run(id),'official-start.json'))));
  assert.equal(boots.filter(Boolean).length, 1);
});

test('control requires the exact live run identity and cannot stop another run', { timeout: 30000 }, async t => {
  const f = await fixture(t), ready = await f.start(), current = await f.record();
  const controlPath = join(f.run(ready.runId), 'control.json'), control = await json(controlPath);
  for (const wrong of [{runId:'wrong-run'}, {token:'0'.repeat(64)}, {dataRoot:join(f.root,'another-data')},
    {method:'open',token:'0'.repeat(64)}, {method:'open',url:'https://unrequested.invalid/'}]) {
    const result = await new Promise(resolveDone => {
      const socket = createConnection(current.controlAddress); let connected = false, response = '';
      socket.setTimeout(2000, () => socket.destroy());
      socket.on('connect', () => { connected = true; socket.write(JSON.stringify({schema:'arcfold-runtime-v1',
        runId:ready.runId, dataRoot:f.plan.dataRoot, token:control.token, method:'stop', ...wrong})+'\n'); });
      socket.on('data', chunk => { response += chunk; });
      socket.on('error', () => {});
      socket.on('close', () => resolveDone({connected,response}));
    });
    assert.deepEqual(result, {connected:true,response:''});
  }
  await chmod(controlPath, 0o644);
  try { await assert.rejects(f.api.runtimeControl(current, 'stop'), {code:'invalid_control_owner'}); }
  finally { await chmod(controlPath, 0o600); }
  assert.equal((await f.state()).phase, 'ready');
  assert.equal((await f.state()).runId, ready.runId);
  assert.equal(await exists(join(f.run(ready.runId),'shutdown-calls.jsonl')), false);
});

test('browser opening uses only the same host authenticated URL and returns no secret', async () => {
  const base = 'http://127.0.0.1:1234/', authenticated = base + '?token=synthetic-browser-secret', calls = [];
  const ctx = { get:name => ({connection:{authenticatedUrl(url) { assert.equal(url,base); return authenticated; }},
    webApp:{getAdvertisedUrl:() => base}}[name]) };
  assert.deepEqual(await openRuntimeBrowser(ctx,{platform:'darwin',opener:async (...args) => {calls.push(args);}}), {opened:true});
  assert.deepEqual(calls,[['/usr/bin/open',[authenticated]]]);
  await assert.rejects(openRuntimeBrowser(ctx,{platform:'darwin',opener:async () => {throw new Error(authenticated);}}),
    error => error.code === 'browser_open_failed' && !String(error).includes('synthetic-browser-secret') && error.cause === undefined);
});

test('unsupported browser platforms do not read credentials or invoke an opener', async () => {
  let called = false;
  await assert.rejects(openRuntimeBrowser({get() {called = true;}},{platform:'linux',opener:async () => {called = true;}}),
    {code:'unsupported_platform'});
  assert.equal(called,false);
});

test('long private data paths use authenticated loopback control without leaking its secret', { timeout:30000 }, async t => {
  const f = await fixture(t, {longDataRoot:true});
  assert.ok(Buffer.byteLength(f.plan.runtimeDirectory) > 150);
  const ready = await f.start(), current = await f.record();
  const control = await json(join(f.run(ready.runId),'control.json'));
  assert.equal(current.controlAddress.host, '127.0.0.1');
  assert.ok(Number.isSafeInteger(current.controlAddress.port) && current.controlAddress.port > 0);
  assert.match(control.token, /^[a-f0-9]{64}$/);
  assert.equal((await stat(join(f.run(ready.runId),'control.json'))).mode & 0o777, 0o600);
  for (const name of await readdir(f.run(ready.runId))) {
    if (name === 'control.json') continue;
    assert.equal((await readFile(join(f.run(ready.runId),name),'utf8')).includes(control.token), false, name);
  }
  assert.equal(JSON.stringify(await f.state()).includes(control.token), false);
  assert.equal(JSON.stringify(current).includes(control.token), false);
  assert.equal((await f.stop()).shutdownEvidence, 'official-shutdown-returned');
});

test('concurrent stops share one official teardown and only confirm after it returns', { timeout: 30000 }, async t => {
  const gate = join(await mkdtemp(join(tmpdir(),'arcfold-stop-gate-')), 'release');
  const f = await fixture(t, { shutdownGate:gate }), ready = await f.start();
  const a = f.stop(), b = f.stop();
  const calls = join(f.run(ready.runId), 'shutdown-calls.jsonl');
  await until(() => exists(calls), 'official teardown entry');
  assert.equal((await f.state()).ownerHeld, true);
  assert.equal(await exists(join(f.run(ready.runId),'official-shutdown-returned.json')), false);
  assert.equal((await readFile(calls,'utf8')).trim().split('\n').length, 1);
  await f.release(gate);
  const results = await Promise.all([a,b]);
  assert.ok(results.every(value => value.shutdownEvidence === 'official-shutdown-returned'));
  assert.equal((await readFile(calls,'utf8')).trim().split('\n').length, 1);
});

test('exit zero without returned official shutdown remains unconfirmed', { timeout: 30000 }, async t => {
  const f = await fixture(t, { forceExit:true }), ready = await f.start();
  const result = await f.stop();
  assert.equal(result.phase, 'stopped');
  assert.equal(result.ownerHeld, false);
  assert.equal(result.shutdownEvidence, 'unconfirmed');
  assert.equal((await json(join(f.run(ready.runId),'process-exit.json'))).code, 0);
  assert.equal(await exists(join(f.run(ready.runId),'official-shutdown-returned.json')), false);
});

test('a failed state write cannot skip official teardown or manufacture a clean metadata result', { timeout: 30000 }, async t => {
  const f = await fixture(t), ready = await f.start();
  // Live control may report ready before the initial durable publication ends.
  // publish writes state before current; wait for that same-run receipt before
  // deliberately replacing state, so the injection cannot race that writer.
  await until(async () => {
    const current = await f.record();
    return current?.runId === ready.runId && current.phase === 'ready';
  }, 'durable ready publication before state-write fault injection');
  const statePath = join(f.run(ready.runId), 'state.json');
  await rm(statePath); await mkdir(statePath);
  const result = await f.stop();
  assert.equal(result.shutdownEvidence, 'official-shutdown-returned');
  assert.ok(result.lastError);
  assert.equal((await readFile(join(f.run(ready.runId),'shutdown-calls.jsonl'),'utf8')).trim().split('\n').length, 1);
  assert.equal(await exists(join(f.run(ready.runId),'failure.json')), true);
});

test('stop during pending readiness prevents late ready and joins the same teardown', { timeout: 30000 }, async t => {
  const gate = join(await mkdtemp(join(tmpdir(),'arcfold-ready-gate-')), 'release');
  const f = await fixture(t, { readinessGate:gate });
  const startResult = f.start().then(value => ({ value }), error => ({ error }));
  const current = await until(async () => {
    const value = await f.record(); return value && await exists(join(f.run(value.runId),'readiness-entered.json')) && value;
  }, 'pending readiness');
  const stopResult = f.stop();
  await until(() => exists(join(f.run(current.runId),'shutdown-calls.jsonl')), 'stop while readiness pending');
  await f.release(gate);
  assert.equal((await stopResult).shutdownEvidence, 'official-shutdown-returned');
  assert.ok((await startResult).error);
  assert.equal(await exists(join(f.run(current.runId),'ready.json')), false);
  assert.equal((await readFile(join(f.run(current.runId),'shutdown-calls.jsonl'),'utf8')).trim().split('\n').length, 1);
});

test('aborted startup signals only its own child once and does not invent a flush receipt', { timeout: 30000 }, async t => {
  const gate = join(await mkdtemp(join(tmpdir(),'arcfold-cancel-gate-')), 'release');
  const f = await fixture(t, { readinessGate:gate, officialShutdown:true }), controller = new AbortController();
  const starting = f.start({ signal:controller.signal }).then(value => ({ value }), error => ({ error }));
  const current = await until(async () => {
    const value = await f.record(); return value && await exists(join(f.run(value.runId),'readiness-entered.json')) && value;
  }, 'readiness before cancellation');
  controller.abort(new Error('fixture caller cancelled'));
  assert.equal((await starting).error.message, 'fixture caller cancelled');
  assert.equal((await f.state()).shutdownEvidence, 'unconfirmed');
  assert.equal(await exists(join(f.run(current.runId),'ready.json')), false);
  assert.equal((await readFile(join(f.run(current.runId),'shutdown-calls.jsonl'),'utf8')).trim().split('\n').length, 1);
  assert.equal((await readFile(join(f.run(current.runId),'official-interrupt.jsonl'),'utf8')).trim().split('\n').length, 1);
});

test('official startup failure is retained, releases ownership, and cannot report ready', { timeout: 30000 }, async t => {
  const f = await fixture(t, { startFailure:true });
  await assert.rejects(f.start(), error => ['fixture_start_failure','startup_exited'].includes(error.code));
  const state = await f.state();
  assert.equal(state.ownerHeld, false);
  assert.equal(state.shutdownEvidence, 'unconfirmed');
  assert.equal(state.lastError.code, 'fixture_start_failure');
  assert.equal(await exists(join(f.run(state.runId),'startup-cleaned.json')), true);
  assert.equal(await exists(join(f.run(state.runId),'ready.json')), false);
});

test('readiness failure releases the guard wait before official teardown', { timeout: 30000 }, async t => {
  const f = await fixture(t, { readinessFailure:true });
  await assert.rejects(f.start(), error => ['fixture_readiness_failure','startup_exited'].includes(error.code));
  const state = await f.state();
  assert.equal(state.ownerHeld, false);
  const trace = (await readFile(join(f.run(state.runId),'guard-and-close.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(trace.slice(0,3), [{event:'guard-fail',code:'fixture_readiness_failure'}, {event:'guard-close'}, {event:'official-shutdown'}]);
  assert.equal(await exists(join(f.run(state.runId),'ready.json')), false);
});

test('the pinned official controller forces exit when interrupted during pending cleanup', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'arcfold-official-shutdown-'));
  const module = await copyOfficialShutdown(directory);
  const {createProcessShutdown} = await import(pathToFileURL(module).href);
  let release, entered;
  const gate = new Promise(resolveDone => {release = resolveDone;});
  const disposing = new Promise(resolveDone => {entered = resolveDone;});
  t.after(() => release());
  const forced = [], completed = [];
  const controller = createProcessShutdown(async () => {entered();await gate;},
    code => forced.push(code), code => completed.push(code));
  const pending = controller.shutdown(0);
  await disposing;
  controller.interrupt(0);controller.interrupt(0);
  assert.deepEqual(forced, [0]);
  assert.deepEqual(completed, []);
  release();await pending;
  assert.deepEqual(forced, [0]);
  assert.deepEqual(completed, []);
});

test('a verified failed startup waits for official cleanup without escalating it with SIGTERM', {timeout:30000}, async t => {
  const gate = join(await mkdtemp(join(tmpdir(),'arcfold-failed-cleanup-')), 'release');
  const f = await fixture(t, {readinessFailure:true,shutdownGate:gate,officialShutdown:true});
  let settled = false;
  const starting = f.start().then(value => ({value}), error => ({error})).finally(() => {settled = true;});
  const current = await until(async () => {
    const value = await f.record();
    return value?.phase === 'failed' && await exists(join(f.run(value.runId),'shutdown-calls.jsonl')) && value;
  }, 'failed startup already inside official cleanup');
  const failure = await readFile(join(f.run(current.runId),'failure.json'));
  // Leave several parent polling intervals for the old unconditional SIGTERM
  // branch to fire. The exact official controller above makes that fatal.
  await delay(180);
  assert.equal(settled, false);
  assert.equal((await f.state()).ownerHeld, true);
  assert.equal(await exists(join(f.run(current.runId),'official-interrupt.jsonl')), false);
  assert.equal(await exists(join(f.run(current.runId),'official-force-exit.jsonl')), false);
  await f.release(gate);
  assert.equal((await starting).error.code, 'fixture_readiness_failure');
  const state = await f.state();
  assert.equal(state.ownerHeld, false);
  assert.equal(state.lastError.code, 'fixture_readiness_failure');
  assert.equal(state.shutdownEvidence, 'official-shutdown-returned');
  assert.deepEqual(await readFile(join(f.run(current.runId),'failure.json')), failure);
  assert.equal((await json(join(f.run(current.runId),'process-exit.json'))).code, 1);
  assert.equal((await readFile(join(f.run(current.runId),'shutdown-calls.jsonl'),'utf8')).trim().split('\n').length, 1);
  assert.equal(await exists(join(f.run(current.runId),'ready.json')), false);
});

test('official cleanup timeout after startup failure remains unconfirmed without a parent interrupt', {timeout:30000}, async t => {
  const gate = join(await mkdtemp(join(tmpdir(),'arcfold-failed-timeout-')), 'release');
  const f = await fixture(t, {readinessFailure:true,shutdownGate:gate,officialShutdown:true,shutdownTimeoutMs:1200});
  await assert.rejects(f.start(), {code:'fixture_readiness_failure'});
  const state = await f.state(), directory = f.run(state.runId);
  assert.equal(state.ownerHeld, false);
  assert.equal(state.lastError.code, 'fixture_readiness_failure');
  assert.equal(state.shutdownEvidence, 'unconfirmed');
  assert.equal((await json(join(directory,'process-exit.json'))).code, 0);
  assert.deepEqual((await readFile(join(directory,'official-force-exit.jsonl'),'utf8')).trim().split('\n').map(JSON.parse), [{code:0}]);
  assert.equal(await exists(join(directory,'official-interrupt.jsonl')), false);
  assert.equal(await exists(join(directory,'official-shutdown-returned.json')), false);
  assert.equal(await exists(join(directory,'ready.json')), false);
});

test('a failed record with a different configuration identity cannot suppress owned-child cancellation', {timeout:30000}, async t => {
  const gate = join(await mkdtemp(join(tmpdir(),'arcfold-forged-failed-')), 'release');
  const f = await fixture(t, {readinessGate:gate,officialShutdown:true});
  const starting = f.start().then(value => ({value}), error => ({error}));
  const current = await until(async () => {
    const value = await f.record();return value && await exists(join(f.run(value.runId),'readiness-entered.json')) && value;
  }, 'owned child awaiting readiness');
  await f.api.writeRuntimeRecord(join(f.run(current.runId),'state.json'), {...current,
    phase:'failed',configurationHash:'0'.repeat(64),error:{code:'unrelated_failure',message:'not this launch'}});
  assert.equal((await starting).error.code, 'invalid_runtime_record');
  assert.equal((await readFile(join(f.run(current.runId),'official-interrupt.jsonl'),'utf8')).trim().split('\n').length, 1);
  assert.equal((await f.state()).shutdownEvidence, 'unconfirmed');
  assert.equal(await exists(join(f.run(current.runId),'official-shutdown-returned.json')), false);
});

test('status reads the current model controls without rewriting the startup snapshot', {timeout:30000}, async t => {
  const f=await fixture(t,{mode:'execution-ready'}),started=await f.start();
  // The control channel may observe ready between ready.json and the queued
  // state.json publication. Compare only the fully published startup snapshot.
  await until(async () => (await json(join(f.run(started.runId),'state.json'))).phase === 'ready', 'persisted startup state');
  const originalReady=await readFile(join(f.run(started.runId),'ready.json'));
  const originalState=await readFile(join(f.run(started.runId),'state.json'));
  const input=await json(f.statusPath);
  input.routeAvailability.main={available:true,model:'new-native-default',reasoningEffort:'high',maxTokens:512};
  input.routeAvailability.learn={available:true,model:'independent-learning',reasoningEffort:'off',maxTokens:256};
  // Fields outside the refresh contract cannot replace the owner's startup identity.
  input.phase='pretend-stopped';input.url='http://unrequested.invalid/';input.runId='pretend-owner';
  await writeFile(f.statusPath,JSON.stringify(input));
  const status=await f.state();
  assert.equal(status.phase,'ready');assert.equal(status.runId,started.runId);
  assert.equal(status.url,started.url);assert.deepEqual(status.identity,started.identity);
  assert.deepEqual(status.routeAvailability.main,input.routeAvailability.main);
  assert.deepEqual(status.routeAvailability.learn,input.routeAvailability.learn);
  assert.deepEqual(await readFile(join(f.run(started.runId),'ready.json')),originalReady);
  assert.deepEqual(await readFile(join(f.run(started.runId),'state.json')),originalState);
});

test('a restart-required gate is visible in status instead of the cached executable startup state', {timeout:30000}, async t => {
  const f=await fixture(t,{mode:'execution-ready'}),started=await f.start();
  const input=await json(f.statusPath);
  input.mode='configuration-only';input.modelGate={phase:'requires-restart',reason:'critical-component-changed'};
  input.routeAvailability.main={available:false,reason:'runtime-restart-required'};
  input.routeAvailability.learn={available:false,reason:'runtime-restart-required'};input.issues=['runtime-restart-required'];
  await writeFile(f.statusPath,JSON.stringify(input));
  const status=await f.state();
  assert.equal(status.ownerHeld,true);assert.equal(status.runId,started.runId);
  assert.equal(status.mode,'configuration-only');assert.equal(status.modelGate.phase,'requires-restart');
  assert.equal(status.routeAvailability.main.available,false);assert.equal(status.routeAvailability.learn.available,false);
  assert.equal((await json(join(f.run(started.runId),'ready.json'))).mode,'execution-ready');
  assert.equal((await f.stop()).shutdownEvidence,'official-shutdown-returned');
});

test('failed malformed or stalled status reads remain unavailable but do not prevent owned stop', {timeout:30000}, async t => {
  const f=await fixture(t,{mode:'execution-ready'}),started=await f.start(),initial=await json(f.statusPath);
  for(const kind of ['fail','invalid','hang']) {
    await writeFile(f.statusPath,JSON.stringify({...initial,[kind]:true}));
    const status=await f.state();
    assert.equal(status.ownerHeld,true);assert.equal(status.runId,started.runId);
    assert.equal(status.mode,'configuration-only');assert.equal(status.routeAvailability.main.available,false);
    assert.equal(status.routeAvailability.learn.available,false);
    assert.equal(status.statusObservationError.code,kind==='hang'?'readiness_refresh_timeout':'readiness_refresh_failed');
    assert.equal(JSON.stringify(status).includes('private detail'),false);
  }
  assert.equal((await f.stop()).shutdownEvidence,'official-shutdown-returned');
});

test('a status observation completing after stop cannot restore ready or publish over shutdown', {timeout:30000}, async t => {
  const gates=await mkdtemp(join(tmpdir(),'arcfold-status-race-')),refreshGate=join(gates,'refresh'),shutdownGate=join(gates,'shutdown');
  const f=await fixture(t,{mode:'execution-ready',shutdownGate}),started=await f.start(),current=await f.record();
  const originalReady=await readFile(join(f.run(started.runId),'ready.json'));
  await writeFile(f.statusPath,JSON.stringify({...await json(f.statusPath),gate:refreshGate,onlyFirst:true}));
  // The ordinary one-second control deadline still applies. Only the first
  // metadata read waits; the stop command can verify its owner normally.
  const pending=f.api.runtimeControl(current,'status');void pending.catch(()=>{});
  await until(async()=> (await json(join(f.run(started.runId),'status-refresh-entered.json'))).gate===refreshGate,'status waiting on metadata');
  const stopped=f.stop();void stopped.catch(()=>{});
  await until(()=>exists(join(f.run(started.runId),'shutdown-calls.jsonl')),'public stop reached official teardown');
  const stopping=await f.api.runtimeControl(current,'status');
  assert.equal(stopping.phase,'stopping');assert.equal(stopping.mode,'configuration-only');
  await f.release(refreshGate);
  const observed=await pending;
  assert.equal((await json(join(f.run(started.runId),'status-refresh-returned.json'))).gate,refreshGate);
  assert.equal(observed.phase,'stopping');assert.equal(observed.mode,'configuration-only');
  assert.equal(observed.routeAvailability.main.available,false);assert.equal(observed.routeAvailability.learn.available,false);
  assert.deepEqual(await readFile(join(f.run(started.runId),'ready.json')),originalReady);
  await f.release(shutdownGate);
  assert.equal((await stopped).shutdownEvidence,'official-shutdown-returned');
  assert.equal((await f.record()).phase,'stopped');
});


test('actual main waits for the official resolver before importing a split-profile guard', {timeout:30000}, async t => {
  const f = await fixture(t,{separatedProfile:true});
  // A fresh child proves ordinary Node cannot see Cordis before profile boot.
  await assert.rejects(execFileAsync(process.execPath,['--input-type=module','-e',
    `await import(${JSON.stringify(pathToFileURL(join(f.directory,'src/runtime-guard.mjs')).href)})`],
    {cwd:f.plan.workspace,env:{...process.env,NODE_PATH:'',NODE_OPTIONS:''}}),
    error => error.code===1 && error.stderr.includes('ERR_MODULE_NOT_FOUND') && error.stderr.includes('@deepseek-ai/cordis'));
  const ready = await f.start();
  assert.equal(ready.phase,'ready');assert.equal(ready.ownerHeld,true);
  const directory=f.run(ready.runId);
  assert.deepEqual(await json(join(directory,'official-resolver-ready.json')),{profileDir:join(f.root,'profile')});
  assert.deepEqual(await json(join(directory,'readiness-import.json')),{guardImported:true});
  assert.equal((await f.state()).phase,'ready');
  assert.equal(await exists(join(directory,'status-refresh-returned.json')),true);
  assert.equal((await f.stop()).shutdownEvidence,'official-shutdown-returned');
  assert.equal((await f.state()).ownerHeld,false);
});

test('a deferred readiness import failure retains failure and tears down the owned split host', {timeout:30000}, async t => {
  const f=await fixture(t,{separatedProfile:true,readinessImportFailure:true});
  await assert.rejects(f.start(),{code:'fixture_readiness_import_failure'});
  const state=await f.state(),directory=f.run(state.runId);
  assert.equal(state.ownerHeld,false);assert.equal(state.shutdownEvidence,'official-shutdown-returned');
  assert.equal(state.lastError.code,'fixture_readiness_import_failure');
  assert.equal((await json(join(directory,'failure.json'))).bootStarted,true);
  assert.equal(await exists(join(directory,'official-resolver-ready.json')),true);
  assert.equal(await exists(join(directory,'readiness-import.json')),true);
  assert.equal(await exists(join(directory,'readiness-entered.json')),false);
  assert.equal(await exists(join(directory,'ready.json')),false);
  assert.deepEqual((await readFile(join(directory,'guard-and-close.jsonl'),'utf8')).trim().split('\n').map(JSON.parse),
    [{event:'guard-fail',code:'fixture_readiness_import_failure'},{event:'guard-close'},{event:'official-shutdown'}]);
});

test('failed split-profile boot never imports readiness or claims official shutdown', {timeout:30000}, async t => {
  const f=await fixture(t,{separatedProfile:true,startFailure:true});
  await assert.rejects(f.start(),{code:'fixture_start_failure'});
  const state=await f.state(),directory=f.run(state.runId);
  assert.equal(state.ownerHeld,false);assert.equal(state.shutdownEvidence,'unconfirmed');
  assert.equal(state.lastError.code,'fixture_start_failure');
  assert.equal(await exists(join(directory,'startup-cleaned.json')),true);
  assert.equal(await exists(join(directory,'readiness-import.json')),false);
  assert.equal(await exists(join(directory,'ready.json')),false);
});
