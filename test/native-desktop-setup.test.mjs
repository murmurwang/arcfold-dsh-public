import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeDesktopSetup } from '../src/desktop/native-setup.mjs';
import { createDesktopSetup } from '../src/desktop/setup-service.mjs';
import { activateNativeDesktop } from '../src/desktop/bootstrap.mjs';

function fixture(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'native-setup-'))), calls = [];
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const args = { home, activate: async result => { calls.push(result); } };
  return { home, args, calls, setup: createNativeDesktopSetup(args) };
}
test('native setup and restart need no Python, price directory or default model', async t => {
  const f = fixture(t);
  await assert.rejects(f.setup.start({ confirmed: false }), /确认/);
  assert.equal(existsSync(join(f.home, 'arcfold-desktop')), false);
  assert.equal((await f.setup.start({ confirmed: true })).state, 'ready');
  const tree = f.calls[0].tree;
  assert.equal(f.setup.authorizes(tree), true);
  assert.equal(f.setup.authorizes({ ...tree, userId: 'changed' }), false);
  for (const key of ['budget', 'models', 'tokenCounter']) assert.equal(Object.hasOwn(tree, key), false);
  const restarted = createNativeDesktopSetup(f.args);
  assert.equal(restarted.status().state, 'configured');
  assert.equal(restarted.authorizes(tree), true);
  assert.equal((await restarted.resume()).state, 'ready');
  assert.deepEqual(f.calls[1].tree, tree);
});
test('upgrade requires native-route consent and preserves old data, configuration and ledger identity', async t => {
  const f = fixture(t), installation = join(f.home, 'installation'); mkdirSync(installation);
  const policy = JSON.parse(readFileSync(new URL('../runtime/initial-policy.json', import.meta.url), 'utf8'));
  const old = createDesktopSetup({ home: f.home, installationFile: join(installation, 'package.json'), python: process.execPath,
    policy, activate: async () => {} });
  await old.start({ confirmed: true });
  const data = join(f.home, 'arcfold-desktop'), config = join(data, 'desktop-configuration.json');
  const ledger = join(data, 'requests/deepseek-web.sqlite'), inode = lstatSync(ledger).ino, before = readFileSync(config);
  const userData = join(data, 'synthetic-existing-note'); writeFileSync(userData, 'keep');
  const upgrade = createNativeDesktopSetup(f.args);
  assert.equal(upgrade.status().state, 'needs_upgrade');
  await upgrade.resume(); assert.equal(f.calls.length, 0);
  await assert.rejects(upgrade.start({ confirmed: false }), /确认/);
  await upgrade.start({ confirmed: true });
  assert.deepEqual(readFileSync(config), before); assert.equal(lstatSync(ledger).ino, inode);
  assert.equal(readFileSync(userData, 'utf8'), 'keep');
  assert.equal(f.calls[0].tree.userId, f.calls[0].previousTree.userId);
  const restarted = createNativeDesktopSetup(f.args); await restarted.resume();
  assert.deepEqual(f.calls[1], f.calls[0]);
});
test('a failed activation can resume its saved receipt without recreating data or consent', async t => {
  const f = fixture(t); let broken = true;
  const setup = createNativeDesktopSetup({ ...f.args, activate: async () => { if (broken) throw new Error('synthetic startup failure'); } });
  await assert.rejects(setup.start({ confirmed: true }), /startup/);
  assert.equal(setup.status().state, 'activation_failed'); broken = false;
  assert.equal((await setup.resume()).state, 'ready');
});
function activationFixture() {
  const rows = [], writes = [], persisted = new Map();
  for (const options of [
    { id: 'arcfold-business', name: '@arcfold/dsh', config: {} },
    { id: 'arcfold-metered-provider', name: '@arcfold/dsh/deepseek', config: {} },
    { id: 'arcfold-desktop-metered-provider', name: '@arcfold/dsh/desktop-deepseek', config: {} },
    { id: 'agent-default-model', config: { provider: 'synthetic', model: 'user-choice' } },
    { id: 'llm-pi-ai', config: { providers: { synthetic: { baseURL: 'https://example.test' } } } },
  ]) rows.push({ id: 'include:' + options.id, options });
  const editor = { configuration: () => rows.map(entry => ({ entry, override: persisted.get(entry.id) ?? {} })),
    edit: async (entry, change) => {
      const config = change(persisted.get(entry.id) ?? {});
      writes.push(entry.options.id); persisted.set(entry.id, structuredClone(config)); entry.options.config = config;
    } };
  const manager = { listPlugins: async () => rows.map(row => ({ entryId: row.id, moduleName: row.options.name,
    ...(row.unaddressable ? { readOnlyReason: 'unaddressable' } : { patchId: row.options.id }) })),
    setPluginEnabled: async id => {
    const row = rows.find(r => r.id === id); writes.push(row.options.id); row.options.disabled = true;
    return { application: 'applied' };
  } };
  const ctx = { loader: { entries: () => rows, await: async () => {} },
    get: key => key === 'configEditor' ? editor : key === 'pluginManager' ? manager : {} };
  return { rows, writes, persisted, editor, manager, ctx, result: { tree: { adapter: 'dsh-native-v1' } } };
}
test('native activation persists only owned entries and never changes native defaults or provider settings', async () => {
  const { rows, writes, ctx, result } = activationFixture();
  const untouched = structuredClone(rows.slice(3).map(r => r.options));
  await activateNativeDesktop(ctx, result); await activateNativeDesktop(ctx, result);
  assert.deepEqual(writes, ['arcfold-metered-provider', 'arcfold-desktop-metered-provider', 'arcfold-business',
    'arcfold-metered-provider', 'arcfold-desktop-metered-provider']);
  assert.deepEqual(rows.slice(3).map(r => r.options), untouched);
  rows[0].options.config = { filename: '/synthetic/foreign-data' };
  await assert.rejects(activateNativeDesktop(ctx, result), /不能自动覆盖/); assert.equal(writes.length, 5);
});
test('an already-live configuration must still be saved if the durable override is missing', async () => {
  const f = activationFixture();
  f.rows[0].options.config = { goalTreeV3: f.result.tree };
  await activateNativeDesktop(f.ctx, f.result);
  assert.deepEqual(f.persisted.get(f.rows[0].id), { goalTreeV3: f.result.tree });
});
test('activation rechecks ownership and disk configuration before replacing it', async () => {
  const f = activationFixture();
  f.rows[0].options.name = 'synthetic-foreign-owner';
  await assert.rejects(activateNativeDesktop(f.ctx, f.result), /归属/);
  assert.deepEqual(f.writes, []);
  f.rows[0].options.name = '@arcfold/dsh';
  f.persisted.set(f.rows[0].id, { filename: '/synthetic/user-setting' });
  await assert.rejects(activateNativeDesktop(f.ctx, f.result), /不能自动覆盖/);
  assert.deepEqual(f.persisted.get(f.rows[0].id), { filename: '/synthetic/user-setting' });
});
test('failed or overridden legacy disablement cannot proceed to native activation', async () => {
  const f = activationFixture();
  f.manager.setPluginEnabled = async () => ({ application: 'overridden' });
  await assert.rejects(activateNativeDesktop(f.ctx, f.result), /未能安全停用/);
  assert.deepEqual(f.writes, []);
});
function runtimeProviderFixture() {
  const f = activationFixture(), provider = f.rows[2];
  const tree = { ctx: { fiber: { entry: { id: 'include' } } }, config: { patches: [] },
    flush: async () => {}, refresh: async () => {},
    update: async (id, change) => {
      assert.equal(id, provider.options.id); assert.deepEqual(change, { disabled: true });
      f.writes.push('runtime-provider'); Object.assign(provider.options, change); provider.fiber = undefined;
    } };
  provider.parent = f.rows[0].parent = { tree };
  Object.defineProperty(provider, 'disabled', { get: () => provider.options.disabled === true });
  provider.fiber = { state: 2 }; provider.unaddressable = true;
  f.result.previousTree = { adapter: 'desktop-private-v1' };
  return { ...f, provider, tree };
}
test('a verified old Desktop connection uses its original owner before saving native settings', async () => {
  const f = runtimeProviderFixture();
  await activateNativeDesktop(f.ctx, f.result);
  assert.deepEqual(f.writes, ['arcfold-metered-provider', 'runtime-provider', 'arcfold-business']);
  assert.equal(f.provider.disabled, true);
  assert.deepEqual(f.persisted.get(f.rows[0].id), { goalTreeV3: f.result.tree });
});
test('unaddressable does not authorize modifying a foreign, duplicated or profile-overridden connection', async () => {
  for (const change of [
    f => { delete f.result.previousTree; },
    f => { f.provider.parent = { tree: f.tree }; },
    f => { f.tree.config.patches = [{ id: f.provider.options.id, disabled: false }]; },
    f => { f.rows.push({ ...f.provider }); },
    f => { f.provider.options.name = '@arcfold/dsh/deepseek'; },
  ]) {
    const f = runtimeProviderFixture(); change(f);
    await assert.rejects(activateNativeDesktop(f.ctx, f.result), /归属|未能安全停用/);
    assert.equal(f.writes.includes('runtime-provider'), false);
    assert.equal(f.persisted.has(f.rows[0].id), false);
  }
});
test('a failed owner write or a still-active old connection cannot start the native runtime', async () => {
  for (const change of [
    f => { f.tree.flush = async () => { throw Error('synthetic owner persistence failure'); }; },
    f => { f.tree.update = async () => { f.provider.options.disabled = true; }; },
    f => { f.tree.refresh = async () => { f.provider.options.name = 'foreign'; }; },
  ]) {
    const f = runtimeProviderFixture(); change(f);
    await assert.rejects(activateNativeDesktop(f.ctx, f.result));
    assert.equal(f.persisted.has(f.rows[0].id), false);
  }
});
test('ready reflects current services and recovery preserves the existing consent and data', async t => {
  const f = fixture(t); let active = false;
  const setup = createNativeDesktopSetup({ ...f.args, isActive: () => active,
    activate: async result => { f.calls.push(result); active = true; } });
  await setup.start({ confirmed: true });
  const config = join(f.home, 'arcfold-desktop/native-model-configuration.json'), before = readFileSync(config);
  assert.equal(setup.status().state, 'ready');
  active = false;
  assert.equal(setup.status().state, 'activation_failed');
  assert.match(setup.status().activationError, /服务当前不可用/);
  assert.equal((await setup.resume()).state, 'ready');
  assert.equal(f.calls.length, 2);
  assert.deepEqual(readFileSync(config), before);
});
