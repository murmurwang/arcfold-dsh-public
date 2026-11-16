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
test('native activation disables only owned legacy routes and never changes native defaults or provider settings', async () => {
  const rows = [], writes = [], parent = { tree: { update: async (id, value) => { writes.push(id); Object.assign(rows.find(r => r.options.id === id).options, value); } } };
  for (const options of [
    { id: 'arcfold-business', config: {} },
    { id: 'arcfold-metered-provider', name: '@arcfold/dsh/deepseek', config: {} },
    { id: 'arcfold-desktop-metered-provider', name: '@arcfold/dsh/desktop-deepseek', config: {} },
    { id: 'agent-default-model', config: { provider: 'synthetic', model: 'user-choice' } },
    { id: 'llm-pi-ai', config: { providers: { synthetic: { baseURL: 'https://example.test' } } } },
  ]) rows.push({ options, parent });
  const untouched = structuredClone(rows.slice(3).map(r => r.options));
  const ctx = { loader: { entries: () => rows, await: async () => {} }, get: () => ({}) }, result = { tree: { adapter: 'dsh-native-v1' } };
  await activateNativeDesktop(ctx, result); await activateNativeDesktop(ctx, result);
  assert.deepEqual(writes, ['arcfold-metered-provider', 'arcfold-desktop-metered-provider', 'arcfold-business']);
  assert.deepEqual(rows.slice(3).map(r => r.options), untouched);
  rows[0].options.config = { filename: '/synthetic/foreign-data' };
  await assert.rejects(activateNativeDesktop(ctx, result), /不能自动覆盖/); assert.equal(writes.length, 3);
});
