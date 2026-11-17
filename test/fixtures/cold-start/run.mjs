import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Socket } from 'node:net';
import Module from 'node:module';

// Run in a fresh process: neither Node's module cache nor the real DSH HMR
// service may inherit the imports made by another test.
const networkAttempts = [];
globalThis.fetch = () => { networkAttempts.push('fetch'); throw new Error('No network in startup fixture'); };
Socket.prototype.connect = function() { networkAttempts.push('socket'); throw new Error('No network in startup fixture'); };
const source = fileURLToPath(new URL('../../../', import.meta.url));
const sdkRoot = process.argv[3] ? resolve(process.argv[3]) : source;
const mode = process.argv[2];
assert.ok(['candidate', 'late-control'].includes(mode));
const sdk = name => pathToFileURL(join(sdkRoot, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href;
const { boot, PluginPackages, createRuntimeResolution, loadProfileDirectory } = await import(sdk('dsh-app-boot'));
const { default: Hmr } = await import(sdk('dsh-hmr'));
const { default: Timer } = await import(sdk('cordis-plugin-timer'));
const directory = realpathSync(mkdtempSync(join(tmpdir(), 'arcfold-cold-start-')));
const profileDir = join(directory, 'profile'), fixtureHome = join(directory, 'home');
const core = join(profileDir, 'node_modules/@arcfold/dsh');
mkdirSync(core, { recursive: true }); mkdirSync(fixtureHome);
cpSync(join(source, 'src'), join(core, 'src'), { recursive: true });
cpSync(join(source, 'package.json'), join(core, 'package.json'));
for (const name of ['undici', 'stream-json', 'stream-chain']) {
  const installed = realpathSync(join(source, 'node_modules', name));
  cpSync(installed, join(profileDir, 'node_modules', name), { recursive: true });
}
if (mode === 'late-control') cpSync(new URL('./late-entry.mjs', import.meta.url), join(core, 'src/index.mjs'));
writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'cold-start-fixture', private: true,
  type: 'module', dependencies: { '@arcfold/dsh': JSON.parse(readFileSync(join(core, 'package.json'))).version } }));
writeFileSync(join(profileDir, 'probe.mjs'), `
import * as Business from './node_modules/@arcfold/dsh/src/index.mjs';
export const inject = ['probeGate'];
export async function apply(ctx) {
  // Invalid paths stop the real runtime before storage/workers can start.
  // Reaching TREE_CONFIG proves its import completed; an import failure must
  // propagate instead of being mistaken for a successful runtime activation.
  try { await Business.apply(ctx, { goalTreeV3: { enabled: true } }); }
  catch (error) { if (error.code !== 'TREE_CONFIG') throw error; ctx.provide('probeImported', true); return; }
  throw new Error('The deliberately incomplete runtime configuration was accepted');
}
`);
const patches = [{ insert: [
  { id: 'hmr', name: 'cordis:fixture-hmr', config: { root: [] } },
  { id: 'timer', name: 'cordis:fixture-timer' },
  { id: 'probe', name: './probe.mjs' },
] }];
writeFileSync(join(profileDir, 'cordis.yml'), '[]\n');
writeFileSync(join(profileDir, 'cordis.patch.yml'), JSON.stringify(patches) + '\n');
const installAnchor = join(sdkRoot, 'node_modules/@deepseek-ai/dsh/package.json');
const profile = loadProfileDirectory('fixture', profileDir, installAnchor);
const resolution = await createRuntimeResolution({ installAnchor, profile, home: fixtureHome });
const ready = new Set();
const prematureEvictions = [];
const originalCache = Module._cache;
const watched = join(profileDir, 'node_modules/undici/index.js');
let releaseReady;
Module._cache = new Proxy(originalCache, { set(target, key, value) {
  const result = Reflect.set(target, key, value);
  if (key === watched && releaseReady) queueMicrotask(releaseReady);
  return result;
}, deleteProperty(target, key) {
  if (key === watched && target[key]?.loaded === false)
    prematureEvictions.push('undici/index.js');
  return Reflect.deleteProperty(target, key);
} });
let ctx;
try {
  ctx = await boot('fixture', join(profileDir, 'cordis.yml'), patches, async owner => {
    owner.provide('profileContext', { name: 'fixture', dir: profileDir, home: fixtureHome,
      patchPath: profile.patchPath, installAnchor, startedBundles: [], cwd: directory, overlays: [], telemetryDisabledEnv: '1' });
    owner.provide('appReady', { onReady(listener) { ready.add(listener); return () => ready.delete(listener); } });
    await owner.plugin(PluginPackages, { resolution });
    Object.assign(owner.loader.builtins, { 'fixture-hmr': Hmr, 'fixture-timer': Timer });
  }, pathToFileURL(profileDir + '/').href);
  // The native config watcher queues its initial refresh until appReady.
  // Reproduce the observed ordering without relying on wall-clock sleeps:
  // release readiness when CJS translation starts, or immediately if eager
  // linking already finished. The actual HMR performs any cache eviction.
  const released = Promise.withResolvers();
  releaseReady = () => { for (const listener of ready) listener(); released.resolve(); };
  ctx.provide('probeGate', {});
  if (originalCache[watched]?.loaded) releaseReady();
  await released.promise;
  await ctx.hmr.operations;
  await ctx.loader.await();
  const limit = Date.now() + 5000;
  let entry;
  do {
    entry = [...ctx.loader.entries()].find(e => e.options.id === 'probe');
    if ([2, 3].includes(entry?.fiber?.state)) break;
    await delay(10);
  } while (Date.now() < limit);
  const error = entry?.fiber?._error;
  const result = { mode, node: process.versions.node, electron: process.versions.electron,
    hmrState: [...ctx.loader.entries()].find(e => e.options.id === 'hmr')?.fiber?.state,
    state: entry?.fiber?.state, reachedRuntimeValidation: ctx.get('probeImported') === true,
    error: error ? { code: error.code, message: error.message } : null, prematureEvictions, networkAttempts };
  // Exercise consent and missing legacy configuration after eager linking.
  if (mode === 'candidate') {
    const Business = await import(pathToFileURL(join(core, 'src/index.mjs')));
    const provided = {};
    await Business.apply({ get: key => key === 'arcfoldDesktopSetup' ? {
      status: () => ({ state: 'needs_setup', modelRouting: 'dsh-native-v1' }), authorizes: () => false,
    } : undefined, provide: (key, value) => { provided[key] = value; } }, { goalTreeV3: { enabled: true } });
    assert.deepEqual(provided, { arcfoldTreeMode: { enabled: false } });
    await assert.rejects(Business.apply({ get: () => undefined, provide() {} }, {}), /explicit Arcfold business database path/);
    result.unconfirmedSetupBlocked = true;
    result.legacyRequiresExplicitStorage = true;
  }
  console.log(JSON.stringify(result));
} finally {
  await ctx?.fiber.dispose();
  Module._cache = originalCache;
  rmSync(directory, { recursive: true, force: true });
}
