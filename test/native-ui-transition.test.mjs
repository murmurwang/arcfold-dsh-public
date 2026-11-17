import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { Context, Service } from '@deepseek-ai/cordis';
import * as Client from '../packages/method-ui/src/client.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, { navigation, readReady } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  const prior = Object.fromEntries(['window', 'document', 'location', 'IS_REACT_ACT_ENVIRONMENT']
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const calls = [], entries = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { reload() { calls.push('page-reload'); } } });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const ctx = new Context();
  class Slots extends Service {
    constructor(owner) { super(owner, 'slots'); }
    inject(_name, callback) { return this.ctx.effect(callback); }
    register(options, component) {
      const row = { options, component }; entries.push(row);
      return () => { entries.splice(entries.indexOf(row), 1); calls.push(`dispose:${options.id}`); };
    }
  }
  new Slots(ctx);
  let state = 'needs_upgrade';
  const status = () => ({ state, modelRouting: 'dsh-native-v1', workspace: '/synthetic/workspace', dataRoot: '/synthetic/data' });
  ctx.provide('connection', { rpc: { async call(_channel, method) {
    calls.push(method);
    if (method === 'arcfoldDesktop/status') { if (state === 'ready') await readReady?.(); return { ok: true, value: status() }; }
    if (method === 'arcfoldDesktop/start') { state = 'ready'; return { ok: true, value: status() }; }
    if (method === 'arcfoldMode/current') return { ok: true, value: { goalTreeV3: true } };
    throw new Error(`Unexpected RPC: ${method}`);
  } } });
  ctx.provide('locale', {}); ctx.provide('fileUpload', {});
  ctx.provide('workspaces', { async create(input) { calls.push(['create', input]); return { workspaceId: 'workspace-1' }; } });
  ctx.provide('uiWorkspace', { async openWorkspace(...args) { calls.push(['navigate', ...args]); await navigation?.(); } });
  let hostStarts = 0, hostStops = 0;
  const host = ctx.plugin(owner => { hostStarts++; owner.effect(() => () => { hostStops++; }); });
  await host.await();
  const fiber = ctx.plugin(Client); await fiber.await();
  const setup = entries.find(row => row.options.name === 'settings.section');
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  t.after(async () => {
    await act(() => root.unmount()); await ctx.fiber.dispose(); dom.window.close();
    for (const [key, descriptor] of Object.entries(prior))
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
  });
  return { ctx, fiber, calls, entries, setup, root,
    ready() { state = 'ready'; },
    hostState: () => ({ state: host.state, starts: hostStarts, stops: hostStops }),
    async click(label) {
      const button = [...document.querySelectorAll('button')].find(node => node.textContent === label);
      assert.ok(button, `Missing button: ${label}`); await act(() => button.click());
    } };
}

test('setup awaits native navigation and its own UI activation without reloading the host page', async t => {
  const navigated = deferred(), ready = deferred();
  const f = await fixture(t, { navigation: () => navigated.promise, readReady: () => ready.promise });
  let completed = false;
  const props = f.setup.options.inject();
  await act(() => f.root.render(React.createElement(f.setup.component, { ...props,
    openWorkspace: async path => { await props.openWorkspace(path); completed = true; } })));
  await f.click('确认：模型调用可能产生费用，本机不设消费上限');
  await f.click('确认并启用');
  assert.deepEqual(f.calls.find(row => row[0] === 'navigate'), ['navigate', 'workspace-1', undefined, { agentPreset: 'arcfold-main' }]);
  assert.equal(f.entries.filter(row => row.options.id === 'arcfold-desktop-setup').length, 2);
  assert.equal(completed, false);
  await act(() => navigated.resolve());
  assert.equal(f.entries.length, 0);
  assert.equal(completed, false, 'await the fresh registrations, not just navigation');
  await act(() => ready.resolve());
  assert.equal(completed, true);
  assert.equal(f.fiber.state, 2);
  assert.equal(f.entries.filter(row => row.options.id === 'arcfold-tree-v3').length, 3);
  assert.equal(f.entries.some(row => row.options.id === 'arcfold-desktop-setup'), false);
  assert.equal(document.querySelectorAll('style[data-plugin="arcfold-desktop-setup"]').length, 1);
  assert.equal(document.querySelectorAll('style[data-plugin="arcfold-tree-v3"]').length, 1);
  assert.equal(f.calls.includes('page-reload'), false);
  assert.equal(f.calls.filter(row => row === 'arcfoldDesktop/start').length, 1);
  assert.deepEqual(f.hostState(), { state: 2, starts: 1, stops: 0 });
});

test('navigation failure leaves setup mounted and reports a retry without resubmitting setup', async t => {
  const f = await fixture(t, { navigation: () => { throw new Error('navigation unavailable'); } });
  await act(() => f.root.render(React.createElement(f.setup.component, f.setup.options.inject())));
  await f.click('确认：模型调用可能产生费用，本机不设消费上限');
  await f.click('确认并启用');
  assert.match(document.body.textContent, /设置已完成，但工作区未能打开/);
  assert.equal(f.entries.filter(row => row.options.id === 'arcfold-desktop-setup').length, 2);
  await f.click('打开 Arcfold 工作区');
  assert.equal(f.calls.filter(row => row === 'arcfoldDesktop/start').length, 1);
  assert.equal(f.calls.includes('page-reload'), false);
});

test('a failed fresh activation is propagated instead of being reported ready', async t => {
  const f = await fixture(t);
  f.ready();
  const rpc = f.ctx.get('connection').rpc;
  const original = rpc.call;
  rpc.call = (...args) => { if (args[1] === 'arcfoldMode/current') throw new Error('mode unavailable'); return original(...args); };
  await assert.rejects(() => f.setup.options.inject().openWorkspace('/synthetic/workspace'), /mode unavailable/);
  assert.notEqual(f.fiber.state, 2);
  assert.equal(f.entries.some(row => row.options.id === 'arcfold-tree-v3'), false);
  assert.equal(f.calls.includes('page-reload'), false);
  assert.deepEqual(f.hostState(), { state: 2, starts: 1, stops: 0 });
});

test('a disposed UI cannot use its former callback to restart the host', async t => {
  const f = await fixture(t), open = f.setup.options.inject().openWorkspace;
  await f.fiber.dispose();
  await assert.rejects(() => open('/synthetic/workspace'));
  assert.deepEqual(f.hostState(), { state: 2, starts: 1, stops: 0 });
});
