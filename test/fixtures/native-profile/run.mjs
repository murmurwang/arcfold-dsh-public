import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Socket } from 'node:net';
import { boot, PluginPackages, createRuntimeResolution, loadProfileDirectory, readProfilePatches, reconcileProfilePatches } from '@deepseek-ai/dsh-app-boot';
import ConfigEditor from '@deepseek-ai/dsh-config-editor';
import PluginManager from '@deepseek-ai/dsh-plugin-manager';
import Hmr from '@deepseek-ai/dsh-hmr';
import Timer from '@deepseek-ai/cordis-plugin-timer';
import { activateNativeDesktop } from '../../../src/desktop/bootstrap.mjs';
import { createNativeDesktopSetup } from '../../../src/desktop/native-setup.mjs';

const [root, mode, phase] = process.argv.slice(2);
assert.ok(root && ['memory-control', 'candidate', 'runtime-candidate'].includes(mode) && ['create', 'restart'].includes(phase));
const network = [];
globalThis.fetch = () => { network.push('fetch'); throw Error('Network is forbidden in the persistence fixture'); };
Socket.prototype.connect = function () { network.push('socket'); throw Error('Network is forbidden in the persistence fixture'); };
const profileDir = join(root, 'profile'), home = join(root, 'home');
const patchPath = join(profileDir, 'cordis.patch.yml');
if (phase === 'create') {
  mkdirSync(profileDir, { mode: 0o700 }); mkdirSync(home, { mode: 0o700 });
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'native-profile-fixture', private: true, type: 'module', dependencies: { '@arcfold/dsh': '0.5.4' } }));
  const pkg = join(profileDir, 'node_modules/@arcfold/dsh'); mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@arcfold/dsh', version: '0.5.4', type: 'module',
    exports: { '.': './index.mjs', './desktop-deepseek': './legacy.mjs' } }));
  // Keep a real package identity and the real Loader/config editor. Only the
  // business implementation is a stand-in: this tests configuration, not chat.
  writeFileSync(join(pkg, 'index.mjs'), `export function apply(ctx, config = {}) {
    ctx.provide('fixtureConfig', config);
    if (config.goalTreeV3?.enabled && ctx.get('arcfoldDesktopSetup').authorizes(config.goalTreeV3))
      for (const key of ['arcfoldTreeRuntime', 'arcfoldTreeV3', 'arcfoldTreeWeb', 'arcfoldNativeModelRecords']) ctx.provide(key, {});
  }\n`);
  writeFileSync(join(pkg, 'legacy.mjs'), "export function apply(ctx) { ctx.provide('fixtureLegacy', true); }\n");
  writeFileSync(join(profileDir, 'cordis.yml'), '[]\n');
  writeFileSync(patchPath, JSON.stringify([{ insert: [
    { id: 'hmr', name: 'cordis:fixture-hmr', config: { root: [] } },
    { id: 'timer', name: 'cordis:fixture-timer' },
    ...(mode === 'runtime-candidate' ? [] : [{ id: 'arcfold-desktop-metered-provider', name: '@arcfold/dsh/desktop-deepseek' }]),
    { id: 'arcfold-business', name: '@arcfold/dsh' },
  ] }]) + '\n');
}
const installAnchor = fileURLToPath(new URL('../../../node_modules/@deepseek-ai/dsh/package.json', import.meta.url));
const loaded = loadProfileDirectory('dsh', profileDir, installAnchor);
const resolution = await createRuntimeResolution({ installAnchor, profile: loaded, home });
const profile = { name: 'desktop', dir: profileDir, home, patchPath, installAnchor, startedBundles: [], cwd: root, overlays: [], telemetryDisabledEnv: '1' };
let ctx;
const ready = new Set();
const setup = createNativeDesktopSetup({ home, isActive: () => Boolean(ctx?.get('arcfoldTreeWeb')),
  activate: async result => {
    // This fixture isolates Loader ownership. The separate setup tests verify
    // the old receipt; the release preflight also upgrades the actual old pack.
    if (mode === 'runtime-candidate') return activateNativeDesktop(ctx,
      { ...result, previousTree: { adapter: 'desktop-private-v1' } }, { home });
    if (mode === 'candidate') return activateNativeDesktop(ctx, result, { home });
    const entry = [...ctx.loader.entries()].find(row => row.options.id === 'arcfold-business');
    await entry.parent.tree.update(entry.options.id, { config: { goalTreeV3: result.tree } });
    await entry.parent.tree.flush(); await ctx.loader.await();
  } });
ctx = await boot('dsh', join(profileDir, 'cordis.yml'), readProfilePatches('dsh', profile), async owner => {
  owner.provide('profileContext', profile); owner.provide('arcfoldDesktopSetup', setup);
  owner.provide('appReady', { onReady(listener) { ready.add(listener); return () => ready.delete(listener); } });
  await owner.plugin(PluginPackages, { resolution });
  Object.assign(owner.loader.builtins, { 'fixture-hmr': Hmr, 'fixture-timer': Timer });
}, pathToFileURL(profileDir + '/').href);
try {
  await ctx.plugin(ConfigEditor); await ctx.plugin(PluginManager, {});
  for (const listener of ready) listener(); await ctx.hmr.operations; await ctx.loader.await();
  if (mode === 'runtime-candidate' && phase === 'create') {
    const business = [...ctx.loader.entries()].find(row => row.options.id === 'arcfold-business');
    await business.parent.tree.create({ id: 'arcfold-desktop-metered-provider', name: '@arcfold/dsh/desktop-deepseek' });
    await business.parent.tree.flush(); await ctx.loader.await();
    const row = (await ctx.pluginManager.listPlugins()).find(row => row.entryId === 'include:arcfold-desktop-metered-provider');
    assert.equal(row.readOnlyReason, 'unaddressable'); assert.equal(row.enabled, true);
  }
  const before = { service: Boolean(ctx.get('arcfoldTreeWeb')), state: setup.status().state, legacy: Boolean(ctx.get('fixtureLegacy')) };
  if (mode === 'candidate' && phase === 'create') {
    // The previous activation could disable a provider only in memory. A live
    // disabled flag must not prevent the candidate from saving that choice.
    const old = [...ctx.loader.entries()].find(row => row.options.id === 'arcfold-desktop-metered-provider');
    await old.parent.tree.update(old.options.id, { disabled: true }); await old.parent.tree.flush(); await ctx.loader.await();
    assert.equal(ctx.get('fixtureLegacy'), undefined);
  }
  const activation = phase === 'create' ? await setup.start({ confirmed: true }) : await setup.resume();
  const activated = Boolean(ctx.get('arcfoldTreeWeb'));
  const patch = readFileSync(patchPath, 'utf8');
  await reconcileProfilePatches(ctx, readProfilePatches('dsh', profile), 'dsh'); await ctx.loader.await();
  console.log(JSON.stringify({ before, activation: activation.state, activated,
    afterRefresh: Boolean(ctx.get('arcfoldTreeWeb')), status: setup.status().state,
    persisted: patch.includes('goalTreeV3'), legacyAfterRefresh: Boolean(ctx.get('fixtureLegacy')), network,
    boundary: 'Actual DSH profile composition/configuration and actual native setup; minimal business stand-in, no chat or GUI claim.' }));
} finally { await ctx.fiber.dispose(); }
