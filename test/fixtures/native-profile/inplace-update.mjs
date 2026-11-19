// An Arcfold bundle updated in place by DSH's own plugin manager and HMR, the
// way the Desktop "update" button does it: remove the old bundle, then install
// the new one. Bundle packages are minimal stand-ins that use the real Desktop
// bootstrap and native setup; business work and the old provider only report
// whether they run. The package manager is ./fake-pnpm.mjs; no network.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Socket } from 'node:net';
import { boot, PluginPackages, createRuntimeResolution, loadProfileDirectory, readProfilePatches } from '@deepseek-ai/dsh-app-boot';
import ConfigEditor from '@deepseek-ai/dsh-config-editor';
import PluginManager from '@deepseek-ai/dsh-plugin-manager';
import Hmr from '@deepseek-ai/dsh-hmr';
import Timer from '@deepseek-ai/cordis-plugin-timer';

const [root, phase] = process.argv.slice(2);
assert.ok(root && ['create', 'update'].includes(phase));
const network = [];
globalThis.fetch = () => { network.push('fetch'); throw Error('Network is forbidden in the update fixture'); };
Socket.prototype.connect = function () { network.push('socket'); throw Error('Network is forbidden in the update fixture'); };
// The real bootstrap only manages setup inside the Desktop host; the bundle's
// Desktop expression keeps the old provider disabled there, as in 0.5.4/0.6.0.
Object.defineProperty(process.versions, 'electron', { value: '0.0.0-fixture', enumerable: true });
process.argv.push('--fixture-dsh-desktop-host');
globalThis.__arcfoldDesktopFixture = true;
const home = process.env.DSH_HOME, profileDir = join(root, 'profile'), patchPath = join(profileDir, 'cordis.patch.yml');
const bundle = version => {
  const dir = join(root, 'packages', version); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@arcfold/dsh', version, type: 'module',
    exports: { '.': './index.mjs', './desktop-bootstrap': './bootstrap.mjs', './deepseek': './legacy.mjs', './package.json': './package.json' },
    dsh: { bundle: { patch: ['./cordis.patch.yml'] } } }));
  writeFileSync(join(dir, 'cordis.patch.yml'), `- insert:
    - id: arcfold-desktop-bootstrap
      name: '@arcfold/dsh/desktop-bootstrap'
    - id: arcfold-business
      name: '@arcfold/dsh'
      inject: [arcfoldDesktopSetup]
      config: {}
    - id: arcfold-metered-provider
      disabled: !!js "globalThis.__arcfoldDesktopFixture === true"
      name: '@arcfold/dsh/deepseek'
      config: {}
`);
  writeFileSync(join(dir, 'bootstrap.mjs'), `export * from ${JSON.stringify(new URL('../../../src/desktop/bootstrap.mjs', import.meta.url).href)};\n`);
  writeFileSync(join(dir, 'index.mjs'), `export const name = 'arcfold-business';
export function apply(ctx, config = {}) {
  if (config.goalTreeV3?.enabled && ctx.get('arcfoldDesktopSetup')?.authorizes?.(config.goalTreeV3))
    for (const key of ['arcfoldTreeRuntime', 'arcfoldTreeV3', 'arcfoldTreeWeb', 'arcfoldNativeModelRecords']) ctx.provide(key, {});
}\n`);
  writeFileSync(join(dir, 'legacy.mjs'), "export function apply(ctx) { ctx.provide('fixtureLegacy', true); }\n");
  return 'file:' + dir;
};
if (phase === 'create') {
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'inplace-update-fixture', private: true, type: 'module', dependencies: {} }));
  writeFileSync(join(profileDir, 'cordis.yml'), '[]\n');
  writeFileSync(patchPath, JSON.stringify([{ insert: [{ id: 'hmr', name: 'cordis:fixture-hmr', config: { root: [] } },
    { id: 'timer', name: 'cordis:fixture-timer' }] }]) + '\n');
}
const installAnchor = fileURLToPath(new URL('../../../node_modules/@deepseek-ai/dsh/package.json', import.meta.url));
const resolution = await createRuntimeResolution({ installAnchor, profile: loadProfileDirectory('dsh', profileDir, installAnchor), home });
const profile = { name: 'desktop', dir: profileDir, home, patchPath, installAnchor, startedBundles: [], cwd: root, overlays: [],
  telemetryDisabledEnv: '1', packageManager: { command: process.execPath, args: [fileURLToPath(new URL('./fake-pnpm.mjs', import.meta.url))] } };
const ready = new Set();
const ctx = await boot('dsh', join(profileDir, 'cordis.yml'), readProfilePatches('dsh', profile), async owner => {
  owner.provide('profileContext', profile);
  owner.provide('appReady', { onReady(listener) { ready.add(listener); return () => ready.delete(listener); } });
  await owner.plugin(PluginPackages, { resolution });
  Object.assign(owner.loader.builtins, { 'fixture-hmr': Hmr, 'fixture-timer': Timer });
  await owner.plugin(ConfigEditor); await owner.plugin(PluginManager, {});
}, pathToFileURL(profileDir + '/').href);
const setup = () => ctx.get('arcfoldDesktopSetup');
const settled = async () => {
  for (let i = 0; i < 200; i++) {
    const s = setup()?.status();
    if (s && !s.busy && s.state !== 'configured') break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  await ctx.loader.await();
  const provider = [...ctx.loader.entries()].filter(row => row.options.id === 'arcfold-metered-provider');
  const s = setup()?.status();
  return { state: s?.state, activationError: s?.activationError ?? null, service: Boolean(ctx.get('arcfoldTreeWeb')),
    legacy: Boolean(ctx.get('fixtureLegacy')), provider: provider.map(row => ({ disabled: row.options.disabled, live: row.disabled })) };
};
const out = { phase, network };
try {
  for (const listener of ready) listener(); await ctx.hmr.operations; await ctx.loader.await();
  const manager = ctx.pluginManager;
  if (phase === 'create') {
    out.install = (await manager.installBundle(bundle('0.5.4'), { saveExact: true, enabled: true })).application;
    out.before = await settled();
    out.start = (await setup().start({ confirmed: true })).state;
    out.after = await settled();
  } else {
    out.restart = await settled();
    out.remove = (await manager.removeBundle('@arcfold/dsh')).application;
    out.install = (await manager.installBundle(bundle('0.6.0'), { saveExact: true, enabled: true })).application;
    out.after = await settled();
    out.version = JSON.parse(readFileSync(join(profileDir, 'node_modules/@arcfold/dsh/package.json'), 'utf8')).version;
  }
  out.patch = readFileSync(patchPath, 'utf8');
} finally { await ctx.fiber.dispose(); }
console.log(JSON.stringify(out));
