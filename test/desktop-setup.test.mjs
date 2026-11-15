import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDesktopSetup } from '../src/desktop/setup-service.mjs';
import { desktopRequest } from '../packages/method-ui/src/desktop-setup-host.mjs';
import { activateDesktop } from '../src/desktop/bootstrap.mjs';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { DesktopModels } from '../packages/method-ui/src/DesktopModels.mjs';
import { openDesktopWorkspace } from '../packages/method-ui/src/desktop-workspace.mjs';
import * as Client from '../packages/method-ui/src/client.mjs';
import { Context, Service } from '@deepseek-ai/cordis';

const policy = JSON.parse(readFileSync(new URL('../runtime/initial-policy.json', import.meta.url), 'utf8'));
function fixture(t, activate = async () => {}) {
  const home = mkdtempSync(join(tmpdir(), 'arcfold-desktop-setup-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const installation = join(home, 'installation'); mkdirSync(installation);
  const args = { home, installationFile: join(installation, 'package.json'), python: process.execPath, policy, activate };
  return { home, args, setup: createDesktopSetup(args) };
}
test('first use requires explicit confirmation and survives restart without another authorization', async t => {
  const activated = [], f = fixture(t, async result => activated.push(result));
  assert.equal(f.setup.status().state, 'needs_setup');
  await assert.rejects(() => f.setup.start({ confirmed: false }), /确认/);
  assert.equal(existsSync(join(f.home, 'arcfold-desktop')), false);
  assert.equal((await f.setup.start({ confirmed: true })).state, 'ready');
  assert.equal(activated[0].tree.models.main.model, 'deepseek-v4-pro');
  assert.equal(activated[0].tree.models.learning.reasoningEffort, 'high');
  const restarted = createDesktopSetup(f.args); assert.equal(restarted.status().state, 'configured');
  assert.equal((await restarted.resume()).state, 'ready');
  assert.equal(activated[1].created, false);
  assert.deepEqual(activated[0].tree.budget.webAuthorization, activated[1].tree.budget.webAuthorization);
});
test('first use refuses an existing unowned workspace', async t => {
  const f = fixture(t), workspace = join(f.home, 'arcfold-workspace');
  mkdirSync(workspace);
  const existing = join(workspace, 'keep.txt');
  writeFileSync(existing, 'existing work');
  await assert.rejects(() => f.setup.start({ confirmed: true }), /已经存在/);
  assert.equal(f.setup.status().state, 'interrupted');
  assert.equal(createDesktopSetup(f.args).status().state, 'interrupted');
  assert.equal(readFileSync(existing, 'utf8'), 'existing work');
  assert.equal(existsSync(join(f.home, 'arcfold-desktop')), false);
});

test('first use can retry after a validation failure before creating Desktop data', async t => {
  const f = fixture(t);
  let python = join(f.home, 'missing-python');
  const setup = createDesktopSetup({ ...f.args, preparePython: () => python });
  await assert.rejects(() => setup.start({ confirmed: true }), { code: 'ENOENT' });
  const after = setup.status();
  assert.equal(after.state, 'needs_setup');
  assert.equal(after.busy, false);
  assert.equal(existsSync(after.workspace), false);
  assert.equal(existsSync(after.dataRoot), false);
  python = f.args.python;
  assert.equal((await setup.start({ confirmed: true })).state, 'ready');
});

test('restart switches to the bundled interpreter while preserving the setup receipt and ledger', async t => {
  const calls = [];
  const f = fixture(t, async (result, previousPython) => calls.push({ result, previousPython }));
  await f.setup.start({ confirmed: true });
  const first = calls[0].result;
  const before = readFileSync(first.configPath);
  const ledger = first.tree.budget.ledgerPath, inode = lstatSync(ledger).ino;
  const replacement = realpathSync('/usr/bin/true');
  const upgraded = createDesktopSetup({ ...f.args, preparePython: () => replacement });
  assert.equal((await upgraded.resume()).state, 'ready');
  const resumed = calls[1];
  assert.equal(resumed.previousPython, f.args.python);
  assert.equal(resumed.result.tree.tokenCounter.python, replacement);
  assert.deepEqual(resumed.result.tree.budget, first.tree.budget);
  assert.equal(resumed.result.tree.userId, first.tree.userId);
  assert.deepEqual(readFileSync(first.configPath), before);
  assert.equal(lstatSync(ledger).ino, inode);
});

test('first use opens the isolated directory through native DSH workspace navigation', async () => {
  const calls = [];
  const workspaces = { create: async input => { calls.push(['create', input]); return { workspaceId: 'synthetic-workspace' }; } };
  const navigation = { openWorkspace: async (...args) => calls.push(['open', ...args]) };
  await openDesktopWorkspace(workspaces, navigation, '/synthetic/isolated-workspace');
  assert.deepEqual(calls, [['create', { path: '/synthetic/isolated-workspace' }], ['open', 'synthetic-workspace', undefined, { agentPreset: 'arcfold-main' }]]);
  await assert.rejects(() => openDesktopWorkspace(undefined, navigation, '/synthetic/isolated-workspace'), /尚未就绪/);
});

test('failed activation is visible and never creates a second data set', async t => {
  const f = fixture(t, async () => { throw new Error('synthetic activation failure'); });
  await assert.rejects(() => f.setup.start({ confirmed: true }), /synthetic activation failure/);
  assert.equal(f.setup.status().state, 'activation_failed');
  assert.ok(existsSync(f.setup.status().workspace));
  await assert.rejects(() => f.setup.start({ confirmed: true }), /状态/);
  const restarted = createDesktopSetup(f.args);
  assert.equal((await restarted.resume()).state, 'activation_failed');
});
test('setup only accepts the active authenticated Desktop owner', async () => {
  const peer = { principal: { kind: 'owner' }, interactions: 'answer', signal: new AbortController().signal };
  let starts = 0; const setup = { status: () => ({ state: 'needs_setup' }), start: async () => { starts++; return { state: 'ready' }; } };
  const connection = { browserPeer: peer }, signal = new AbortController().signal;
  await assert.rejects(() => desktopRequest({ setup, connection }, 'start', { confirmed: true }, signal, { ...peer }), /认证/);
  await assert.rejects(() => desktopRequest({ setup, connection }, 'start', { confirmed: false }, signal, peer), /确认/);
  assert.equal(starts, 0);
  assert.equal((await desktopRequest({ setup, connection }, 'start', { confirmed: true }, signal, peer)).state, 'ready');
  assert.equal(starts, 1);
});

test('activation uses the owning root and refuses to replace pre-existing product configuration', async () => {
  const calls = [], rows = [];
  const tree = { async update(id, options) { calls.push(['update', id]); Object.assign(rows.find(x => x.options.id === id).options, options); },
    async create(options, group) { calls.push(['create', options.id, group]); rows.push({ options, parent }); } };
  const parent = { tree, ctx: { fiber: { entry: { id: 'include' } } } }; tree.root = parent;
  for (const [id, config] of [['arcfold-business', {}], ['arcfold-metered-provider', {}],
    ['agent-default-model', { provider: { __jsExpr: 'default' }, model: { __jsExpr: 'default' } }]])
    rows.push({ options: { id, config }, parent });
  const ctx = { loader: { entries: () => rows, await: async () => {} }, get: () => ({}) };
  const result = { tree: { models: { main: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' } } },
    patches: [{ insert: [{ id: 'arcfold-desktop-metered-provider', name: '@arcfold/dsh/desktop-deepseek', config: { apiKeyRef: 'KEY' } }] }] };
  await activateDesktop(ctx, result);
  assert.deepEqual(calls.find(call => call[0] === 'create'), ['create', 'arcfold-desktop-metered-provider', null]);
  assert.equal(rows.find(x => x.options.id === 'agent-default-model').options.config.model, 'deepseek-v4-pro');
  await activateDesktop(ctx, result); assert.equal(calls.filter(call => call[0] === 'create').length, 1);
  const business = rows.find(x => x.options.id === 'arcfold-business').options;
  const home = '/synthetic/home', previousPython = '/legacy/python', newPython = '/bundled/python';
  business.config = { goalTreeV3: { tokenCounter: { python: previousPython }, ...result.tree } };
  const upgraded = { ...result, tree: { ...result.tree, tokenCounter: { python: newPython } } };
  await activateDesktop(ctx, upgraded, { home, previousPython });
  assert.deepEqual(business.config, { goalTreeV3: upgraded.tree });
  business.config.goalTreeV3 = { ...result.tree, tokenCounter: { python: join(home, 'arcfold-desktop-counter', 'a'.repeat(64), 'python/bin/python3.12') } };
  await activateDesktop(ctx, upgraded, { home, previousPython });
  assert.deepEqual(business.config, { goalTreeV3: upgraded.tree });
  rows.find(x => x.options.id === 'arcfold-business').options.config = { filename: '/other/user/data' };
  const before = calls.length;
  await assert.rejects(() => activateDesktop(ctx, result), /不能自动覆盖/);
  assert.equal(calls.length, before);
});

test('Desktop credential setting sends the secret only to the native credential service', async t => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1/' });
  const previous = Object.fromEntries(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const calls = [], rpc = { async call(_channel, method, payload) { calls.push({ method, payload });
    if (method === 'credentials/describe') return { ok: true, value: { DEEPSEEK_API_KEY: { configured: calls.some(x => x.method === 'credentials/set'), writable: true } } };
    if (method === 'credentials/set') return { ok: true };
    throw new Error('unexpected endpoint'); } };
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  t.after(async () => { await act(() => root.unmount()); dom.window.close();
    for (const [key, descriptor] of Object.entries(previous)) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]; });
  await act(async () => { root.render(React.createElement(DesktopModels, { rpc })); });
  assert.match(document.body.textContent, /尚未配置/);
  const input = document.querySelector('input[type="password"]'), save = [...document.querySelectorAll('button')].find(button => button.textContent === '保存密钥');
  assert.equal(save.disabled, true);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'synthetic-fixture-key'); input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  assert.equal(save.disabled, false);
  await act(async () => { save.click(); });
  assert.deepEqual(calls.find(row => row.method === 'credentials/set').payload, { args: { ref: 'DEEPSEEK_API_KEY', value: 'synthetic-fixture-key' } });
  assert.equal(input.value, ''); assert.match(document.body.textContent, /已配置/);
  assert.equal(calls.some(row => row.method.startsWith('arcfold')), false);
});

test('Desktop contributes the shared credential control to the existing DSH Models page', async t => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
  const ctx = new Context(), entries = [];
  class Slots extends Service {
    constructor(owner) { super(owner, 'slots'); }
    inject(_name, callback) { return this.ctx.effect(callback); }
    register(options, component) { const row = { options, component }; entries.push(row); return () => entries.splice(entries.indexOf(row), 1); }
  }
  new Slots(ctx);
  ctx.provide('connection', { rpc: { async call(_channel, method) {
    if (method === 'arcfoldDesktop/status') return { ok: true, value: { state: 'ready' } };
    if (method === 'arcfoldMode/current') return { ok: true, value: { goalTreeV3: true } };
    throw new Error('Unexpected read while mounting');
  } } });
  ctx.provide('locale', {}); ctx.provide('fileUpload', {});
  t.after(async () => { await ctx.fiber.dispose(); dom.window.close(); prior ? Object.defineProperty(globalThis, 'document', prior) : delete globalThis.document; });
  await ctx.plugin(Client).await();
  assert.ok(entries.some(row => row.options.name === 'settings.models.footer' && row.options.id === 'arcfold-deepseek-credential'));
  assert.ok(!entries.some(row => row.options.name === 'settings.section' && row.options.id === 'arcfold-desktop-models'));
});
