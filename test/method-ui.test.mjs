// Local transport/DOM contracts; the official Loader/Web visibility probe is separate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import * as OfficialConnection from '@deepseek-ai/dsh-client-connection';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import TypertGateway from '@deepseek-ai/dsh-api-gateway';
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access';
import { Context, Service } from '@deepseek-ai/cordis';
import React, { act, useSyncExternalStore } from 'react';
import { JSDOM } from 'jsdom';
import * as Host from '../packages/method-ui/src/index.mjs';
import * as Client from '../packages/method-ui/src/client.mjs';
import { createMethodSource, callMethod } from '../packages/method-ui/src/method-source.mjs';
import { installConnection } from '@deepseek-ai/dsh-client-connection/client';
import { MethodDock } from '../packages/method-ui/src/MethodDock.mjs';
import { zh } from '../packages/method-ui/src/locales.mjs';

const live = () => new AbortController().signal;
const peer = () => ({ id: 'fixture-browser', principal: { kind: 'owner' }, interactions: 'answer', signal: live() });
const decision = () => ({ methodId: 'm1', expectedRevision: 2, contentHash: 'hash-current', action: 'continue', requestId: 'request-1' });
const notices = () => ({ items: [{ id: 'n1', methodId: 'm1', methodVersion: 1, status: 'unread', title: '方法暂停', message: '试用到期', reason: 'trial_limit', createdAt: '2026-11-06' }],
  total: 1, unreadCount: 1, offset: 0, nextOffset: null });
const detail = (revision = 2) => ({ notifications: notices(), method: { id: 'm1', revision, version: 1, status: 'paused', title: '先核原件',
  guidance: '完整指导\n保留不同作者的原话。 <script>never execute</script>', appliesTo: '有多位作者时', doesNotApplyTo: '仅需转写时' },
  contentHash: `hash-${revision}`, usage: { trialUses: 3, maxTrialUses: 3, remaining: 0 }, reason: '三次试用用完，等待决定',
  activation: { allowed: true }, needsDecision: true, successors: [],
  sources: [{ id: 'source-1', revision: 1, role: 'user', occurredAt: '2026-11-06T10:00:00Z',
    content: '请先保留原件，再下判断。', provenance: { kind: 'user', sessionId: 'another-discussion' } }] });
const state = () => ({ loading: false, error: null, items: [{ ...detail(), notificationCount: 1, unreadCount: 1 }],
  total: 1, decisionCount: 1, nextOffset: null, offset: 0, unreadCount: 1 });
const request = (handler, endpoint, payload, p) => handler(endpoint, payload, live(), p);

function hostFixture(t) {
  const ctx = new Context(), calls = [], handlers = new Map();
  class Connection extends Service {
    browserPeer = peer();
    constructor(ctx) { super(ctx, 'connection'); }
    get rpc() { const owner = this.ctx; return { handle(channel, handler) {
      return owner.effect(() => { handlers.set(channel, handler); return () => handlers.delete(channel); });
    } }; }
  }
  const connection = new Connection(ctx);
  const methods = Object.fromEntries(['listDecisions', 'details', 'listCards', 'cardDetails', 'notifications', 'acknowledgeNotification', 'decide']
    .map(name => [name, (value, options) => { const result = { name, value, ...(options ? { options } : {}) }; calls.push(result); return result; }]));
  ctx.provide('arcfoldMethods', methods); ctx.provide('webServer', {});
  t.after(() => ctx.fiber.dispose());
  return { ctx, calls, connection, handlers };
}

test('method handler derives decision identity from its exact browser peer', async t => {
  const f = hostFixture(t);
  const handler = Host.createMethodHandler({ methods: f.ctx.arcfoldMethods, connection: f.connection });
  const reply = await request(handler, 'decide', decision(), f.connection.browserPeer);
  assert.equal(reply.ok, true);
  assert.deepEqual(f.calls, [{ name: 'decide', value: { ...decision(), userIdentity: 'browser:fixture-browser' } }]);
});

test('a different owner, cancelled peer, and client actor fields cannot reach a business mutation', async t => {
  const f = hostFixture(t), handler = Host.createMethodHandler({ methods: f.ctx.arcfoldMethods, connection: f.connection });
  for (const p of [undefined, peer(), { ...f.connection.browserPeer, principal: { kind: 'viewer' } }]) {
    assert.equal((await request(handler, 'decide', decision(), p)).error.code, 'trusted_browser_required');
  }
  for (const extra of [{ confirmed: true }, { userIdentity: 'user:pretend' }, { sessionId: 'pretend' }])
    assert.equal((await request(handler, 'decide', { ...decision(), ...extra }, f.connection.browserPeer)).error.code, 'invalid_method_request');
  const abort = new AbortController(); abort.abort();
  assert.equal((await handler('decide', decision(), abort.signal, f.connection.browserPeer)).error.code, 'trusted_browser_required');
  assert.equal(f.calls.length, 0);
});

test('notification acknowledgement and exact pagination remain separate from user decisions', async t => {
  const f = hostFixture(t), handler = Host.createMethodHandler({ methods: f.ctx.arcfoldMethods, connection: f.connection });
  assert.equal((await request(handler, 'acknowledge', { notificationId: 'n1' }, f.connection.browserPeer)).ok, true);
  assert.equal((await request(handler, 'list', { offset: 20, limit: 20 }, f.connection.browserPeer)).ok, true);
  assert.equal((await request(handler, 'list', { offset: -1 }, f.connection.browserPeer)).ok, false);
  assert.deepEqual(f.calls.map(row => row.name), ['acknowledgeNotification', 'listDecisions']);
});

test('read source refresh/reconnect recovers pages and never sends a decision', async t => {
  const calls = [], resets = new Set();
  const rpc = { async call(channel, endpoint, payload) {
    assert.equal(channel, '/api');
    const operation = endpoint.replace('arcfoldMethods/', ''), request = payload.args.request;
    calls.push({ channel, endpoint: operation, payload: request });
    return { ok: true, value: { items: [detail()], total: 41, decisionCount: 1, unreadCount: 2, nextOffset: request.offset + 20 } };
  } };
  const source = createMethodSource({ rpc, intervalMs: 60000,
    subscribeReset: fn => { resets.add(fn); return () => resets.delete(fn); } });
  t.after(() => source.dispose());
  const unsubscribe = source.subscribe(() => {});
  await source.refresh(20);
  assert.equal(source.getSnapshot().offset, 20); assert.equal(source.getSnapshot().decisionCount, 1);
  for (const reset of resets) reset();
  await source.refresh();
  assert.equal(calls.some(row => row.endpoint !== 'cards'), false);
  assert.equal(source.getSnapshot().total, 41);
  unsubscribe(); assert.equal(resets.size, 0); source.dispose();
});

test('card/history endpoints validate pages and require the same authenticated browser', async t => {
  const f = hostFixture(t), handler = Host.createMethodHandler({ methods: f.ctx.arcfoldMethods, connection: f.connection });
  assert.equal((await request(handler, 'cards', { offset: 0 }, peer())).error.code, 'trusted_browser_required');
  for (const payload of [{}, { methodId: 'm1', offset: -1 }, { methodId: 'm1', limit: 101 },
    { methodId: 'm1', confirmed: true }, { methodId: 'm1', unread: true }])
    assert.equal((await request(handler, 'cardDetails', payload, f.connection.browserPeer)).error.code, 'invalid_method_request');
  assert.equal(f.calls.length, 0);
  const reply = await request(handler, 'cardDetails', { methodId: 'm1', offset: 20, limit: 20 }, f.connection.browserPeer);
  assert.deepEqual(reply.value, { name: 'cardDetails', value: 'm1', options: { offset: 20, limit: 20 } });
});

async function domFixture(t, overrides = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1/' });
  const prior = Object.fromEntries(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')), listeners = new Set(), calls = [];
  let snapshot = state();
  const useMethods = selector => selector(useSyncExternalStore(fn => { listeners.add(fn); return () => listeners.delete(fn); }, () => snapshot));
  const props = { useMethods, t: key => zh[key], onDetails: async id => { calls.push({ type: 'details', id }); return detail(); },
    onDecide: async value => { calls.push({ type: 'decide', value }); return {}; },
    onAcknowledge: async id => { calls.push({ type: 'acknowledge', id }); },
    onRefresh: async () => { calls.push({ type: 'refresh' }); }, onPage: async (...args) => { calls.push({ type: 'page', args }); }, ...overrides };
  await act(async () => root.render(React.createElement(MethodDock, props)));
  t.after(async () => {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of Object.entries(prior)) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
  });
  const buttons = label => [...document.querySelectorAll('button')].filter(node => node.textContent === label);
  async function click(label, index = 0) {
    const target = buttons(label)[index]; assert.ok(target, `Missing button: ${label}`);
    await act(async () => target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  }
  return { dom, root, calls, buttons, click,
    async update(next) { await act(async () => { snapshot = next; for (const listener of listeners) listener(); }); },
    async open() { await click(zh.open); await click(zh.reviewDecision); },
    async history() { await act(async () => { document.querySelector('details[aria-label="' + zh.history + '"]').open = true; }); },
  };
}

test('full evidence is text, reading/acknowledging is not continuing, and the displayed version is submitted', async t => {
  const f = await domFixture(t); await f.open();
  for (const value of [detail().method.guidance, detail().method.appliesTo, detail().method.doesNotApplyTo,
    detail().sources[0].content, detail().sources[0].occurredAt, 'another-discussion', detail().reason])
    assert.ok(document.body.textContent.includes(value), value);
  assert.equal(document.querySelectorAll('script').length, 0);
  await f.history();
  await f.click(zh.acknowledge);
  assert.equal(f.calls.filter(row => row.type === 'decide').length, 0);
  const newer = state(); newer.items = [detail(7)]; await f.update(newer);
  await f.click(zh.continue);
  const sent = f.calls.find(row => row.type === 'decide').value;
  assert.equal(sent.expectedRevision, 2); assert.equal(sent.contentHash, 'hash-2');
  assert.equal(typeof sent.requestId, 'string'); assert.equal(Object.hasOwn(sent, 'userIdentity'), false);
});

test('a version conflict refreshes detail without resending and only a second click uses the new version', async t => {
  const sent = []; let current = 2;
  const f = await domFixture(t, { onDetails: async () => detail(current), onDecide: async value => {
    sent.push(value); if (sent.length === 1) { current = 3; throw Object.assign(new Error('已变化'), { code: 'revision_conflict', remote: true }); }
  } });
  await f.open(); await f.click(zh.continue);
  assert.equal(sent.length, 1); assert.ok(document.body.textContent.includes(zh.conflict));
  assert.ok(document.body.textContent.includes(`${zh.revision} 3`));
  await f.click(zh.continue);
  assert.equal(sent.length, 2); assert.equal(sent[1].expectedRevision, 3);
});

test('an uncertain transport result keeps its request ID for manual retry', async t => {
  const sent = [];
  const f = await domFixture(t, { onDecide: async value => { sent.push(value); if (sent.length === 1) throw new Error('连接中断'); } });
  await f.open(); await f.click(zh.continue);
  assert.equal(sent.length, 1); assert.ok(document.body.textContent.includes(zh.unknown));
  await f.click(zh.continue);
  assert.equal(sent.length, 2); assert.equal(sent[0].requestId, sent[1].requestId);
});

test('unavailable sources show the reason and cannot be continued', async t => {
  const f = await domFixture(t, { onDetails: async () => ({ ...detail(), activation: { allowed: false, message: '原件已经撤回' } }) });
  await f.open(); assert.ok(document.body.textContent.includes('原件已经撤回'));
  assert.equal(f.buttons(zh.continue)[0].disabled, true);
  await f.click(zh.continue); assert.equal(f.calls.some(row => row.type === 'decide'), false);
});

test('one method is one card; its history lives only in collapsed details and keep-paused is explicit', async t => {
  const f = await domFixture(t); await f.click(zh.open);
  const panel = document.querySelector('.arcfold-methods .detail');
  assert.equal(panel.querySelectorAll(':scope > ul > li').length, 1);
  assert.ok(panel.textContent.includes(zh.decisionPrompt));
  assert.equal(panel.textContent.includes('方法暂停'), false);
  await f.click(zh.reviewDecision);
  assert.equal(panel.querySelectorAll(':scope > ul > li').length, 1);
  assert.equal(panel.querySelectorAll('article').length, 1);
  const history = panel.querySelector('details'); assert.equal(history.open, false);
  assert.equal(history.querySelectorAll('li').length, 1);
  assert.equal(f.calls.some(row => row.type === 'decide' || row.type === 'acknowledge'), false);
  await f.click(zh.keepPaused);
  assert.equal(f.calls.find(row => row.type === 'decide').value.action, 'pause');
  await f.click(zh.backToMethods);
  assert.equal(panel.querySelectorAll('article, details').length, 0);
  assert.equal(panel.querySelectorAll(':scope > ul > li').length, 1);
});

test('history pages and acknowledgement keep the complete displayed decision version', async t => {
  const reads = [], decisions = []; let revision = 2;
  const f = await domFixture(t, { onDetails: async (id, offset = 0) => {
    reads.push({ id, offset });
    const result = detail(revision); result.notifications = { ...notices(), offset,
      total: 21, nextOffset: offset === 0 ? 20 : null, items: [{ ...notices().items[0], id: `n-${offset}` }] };
    return result;
  }, onDecide: async request => decisions.push(request) });
  await f.open(); await f.history(); revision = 7;
  await f.click(zh.next);
  assert.deepEqual(reads.at(-1), { id: 'm1', offset: 20 });
  await f.click(zh.acknowledge);
  assert.deepEqual(reads.at(-1), { id: 'm1', offset: 20 });
  await f.click(zh.continue);
  assert.equal(decisions[0].expectedRevision, 2); assert.equal(decisions[0].contentHash, 'hash-2');
});

test('a late history page cannot overwrite another method selected after returning to the list', async t => {
  let finish;
  const other = { ...detail(5), method: { ...detail(5).method, id: 'm2', title: '另一个方法' } };
  const f = await domFixture(t, { onDetails: async (id, offset = 0) => {
    if (id === 'm2') return other;
    if (offset === 20) return await new Promise(resolve => { finish = resolve; });
    return { ...detail(), notifications: { ...notices(), total: 21, nextOffset: 20 } };
  } });
  const value = state(); value.items.push(other); value.total = 2; await f.update(value);
  await f.open(); await f.history(); await f.click(zh.next);
  await f.click(zh.backToMethods); await f.click(zh.reviewDecision, 1);
  await act(async () => finish({ ...detail(9), notifications: notices() }));
  assert.equal(document.querySelector('article').getAttribute('aria-label'), '另一个方法');
  await f.click(zh.continue);
  const sent = f.calls.find(row => row.type === 'decide').value;
  assert.equal(sent.methodId, 'm2'); assert.equal(sent.expectedRevision, 5);
});

test('active method does not become paused by history and missing records have no decision controls', async t => {
  const active = { ...detail(), needsDecision: false, reason: '已继续采用', activation: { allowed: false },
    method: { ...detail().method, status: 'active' } };
  let value = active;
  const f = await domFixture(t, { onDetails: async () => value });
  const snapshot = state(); snapshot.items = [active]; snapshot.decisionCount = 0; await f.update(snapshot);
  await f.click(zh.open); await f.click(zh.viewDetails);
  assert.equal(document.querySelector('details').open, false);
  assert.ok(document.querySelector('article > .meta').textContent.includes(zh.stateActive));
  assert.equal(document.querySelector('article > .meta').textContent.includes(zh.statePaused), false);
  value = { ...detail(), method: { id: 'm1', title: '记录暂不可用', status: 'unavailable' },
    needsDecision: false, activation: { allowed: false }, usage: null };
  await f.click(zh.retry);
  assert.equal(f.buttons(zh.continue)[0].disabled, true); assert.equal(f.buttons(zh.pause)[0].disabled, true);
  assert.equal(document.body.textContent.includes('undefined'), false);
});

test('built browser factory uses the host React and exports only its plugin face', async () => {
  const source = await readFile(new URL('../packages/method-ui/lib/client.js', import.meta.url), 'utf8');
  let registration;
  runInNewContext(source, { window: { __ModuleLoader__: { load(value) { registration = value; } } } });
  assert.equal(registration.id, '@arcfold/dsh-method-ui');
  const requested = [];
  const plugin = registration.factory(name => { requested.push(name); assert.equal(name, 'react'); return React; });
  assert.equal(typeof plugin.apply, 'function'); assert.deepEqual([...plugin.inject], Client.inject);
  assert.deepEqual(Object.keys(plugin).sort(), ['apply', 'inject']);
  // Multiple components may import the same external host instance.
  assert.deepEqual([...new Set(requested)], ['react']);
});


test('client slot, locale and style contributions follow their Cordis plugin lifetime', async t => {
  await domFixture(t);
  const ctx = new Context(), entries = [], dictionaries = new Map();
  class Slots extends Service {
    constructor(ctx) { super(ctx, 'slots'); }
    inject(name, install) { assert.ok(['conversation.input.dock', 'conversation.view', 'conversation.hero.options', 'settings.section'].includes(name)); return this.ctx.effect(install); }
    register(options, component) {
      const entry = { options, component }; entries.push(entry);
      return () => entries.splice(entries.indexOf(entry), 1);
    }
  }
  new Slots(ctx);
  ctx.provide('connection', { rpc: { call(_channel, method) {
    if (method === 'arcfoldDesktop/status') return Promise.resolve({ ok: true, value: { state: 'not_desktop' } });
    if (method === 'arcfoldMode/current') return Promise.resolve({ ok: true, value: { goalTreeV3: false } });
    throw new Error('Unmounted sources must not read');
  } } });
  ctx.provide('fileUpload', { upload() { throw new Error('No upload expected in this fixture'); } });
  ctx.provide('locale', { register(name, copy) { dictionaries.set(name, copy); return () => dictionaries.delete(name); } });
  t.after(() => ctx.fiber.dispose());
  const fiber = ctx.plugin(Client); await fiber.await();
  assert.equal(entries.length, 4);
  const dock = entries.find(entry => entry.options.id === 'arcfold' && entry.options.name === 'conversation.view');
  const settings = entries.find(entry => entry.options.id === 'arcfold-models');
  assert.equal(settings.options.name, 'settings.section');
  assert.equal(typeof settings.options.inject().hooks.models.getSnapshot, 'function');
  assert.equal(typeof dock.component, 'function');
  const face = dock.options.inject('fixture-session');
  assert.equal(typeof face.hooks.methods.getSnapshot, 'function');
  assert.equal(typeof face.onDecide, 'function');
  assert.equal(dictionaries.size, 1);
  assert.equal(document.querySelectorAll('style[data-plugin="@arcfold/dsh-method-ui"]').length, 1);
  await fiber.dispose();
  assert.equal(entries.length, 0); assert.equal(dictionaries.size, 0);
  assert.equal(document.querySelectorAll('style[data-plugin="@arcfold/dsh-method-ui"]').length, 0);
});


test('official Connection parsing preserves a business conflict and rejects the old incomplete error shape', async t => {
  const browserPeer = peer(), connection = { browserPeer };
  const methods = { decide() { throw Object.assign(new Error('方法已变化'), { code: 'revision_conflict' }); } };
  const handler = Host.createMethodHandler({ methods, connection });
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  let stripDetails = false;
  installConnection(ctx, { interactions: 'none', location: { hostname: '127.0.0.1' }, transport: {
    async fetch(_route, init) {
      const envelope = JSON.parse(init.body);
      const result = await handler(envelope.method.replace('arcfoldMethods/', ''), envelope.payload.args.request, init.signal || live(), browserPeer);
      if (stripDetails) delete result.error.details;
      return new Response(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result }),
        { headers: { 'content-type': 'application/json' } });
    },
  } });
  await assert.rejects(callMethod(ctx.connection.rpc, 'decide', decision()), error =>
    error.code === 'revision_conflict' && error.remote === true && error.message === '方法已变化');
  stripDetails = true;
  await assert.rejects(callMethod(ctx.connection.rpc, 'decide', decision()), error => error.remote !== true);
});


test('allocated final trials and their pending native work remain visible before settlement', async t => {
  const pending = { id: 'pending-adoption', sessionId: 'other-native-session', turn: 4, startSeq: 27, callIds: ['call-last'], state: 'reserved' };
  const value = { ...detail(), pendingAdoptionCount: 1, pendingAdoptions: [pending] };
  value.notifications.items[0] = { ...value.notifications.items[0], kind: 'method_trial_allocated', message: '名额已全部领取；部分结果仍待核对。' };
  const f = await domFixture(t, { onDetails: async () => value });
  await f.open(); await f.history();
  assert.ok(document.body.textContent.includes('名额已全部领取；部分结果仍待核对。'));
  assert.ok(document.body.textContent.includes(`${zh.pendingAdoptions} 1`));
  assert.ok(document.body.textContent.includes('other-native-session'));
  assert.ok(document.body.textContent.includes('pending-adoption'));
  await f.click(zh.acknowledge);
  assert.equal(f.calls.some(row => row.type === 'decide'), false);
});


// Real official Connection provider scope, Gateway registry and HTTP bridge;
// only the socket carrier and credential storage are memory fixtures.
test('official Gateway mounts method endpoints without the broken dedicated Connection route and preserves identity/errors/unload', async t => {
  const ctx = new Context(), routes = [], upgrades = [], calls = [];
  let credentialRecord, conflict = false;
  ctx.provide('credentials', { readRecord: async () => credentialRecord,
    async modifyRecord(_key, mutate) { credentialRecord = await mutate(credentialRecord); return credentialRecord; },
    async deleteRecord() { credentialRecord = undefined; } });
  const register = collection => route => {
    assert.equal(collection.some(row => row.path === route.path && row.kind === route.kind), false);
    collection.push(route); return () => collection.splice(collection.indexOf(route), 1);
  };
  // The official host supplies its carrier from a sibling plugin. A root
  // provision would accidentally let Connection's definition scope inherit it.
  await ctx.plugin({ name: 'fixture-web-carrier', apply(owner) {
    owner.provide('webServer', { host: '127.0.0.1', protocol: 'http:', port: 3080,
      register: register(routes), registerUpgrade: register(upgrades), tapIndex: () => () => {} });
  } }).await();
  const methods = Object.fromEntries(['listDecisions', 'details', 'listCards', 'cardDetails', 'notifications', 'acknowledgeNotification', 'decide'].map(name => [name, value => {
    if (name === 'decide' && conflict) throw Object.assign(new Error('current version changed'), { code: 'revision_conflict' });
    calls.push({ name, value }); return { name, value };
  }]));
  ctx.provide('arcfoldMethods', methods);
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(OfficialConnection).await();
  await ctx.plugin(TypertRegistry).await();
  await ctx.plugin(RemoteAccessService).await();
  await ctx.plugin(TypertGateway).await();
  const connection = ctx.get('connection');
  const broken = ctx.plugin({ inject: [...Host.inject, 'webServer'], apply(owner) {
    owner.connection.rpc.handle('/fixture-old-method-path', async () => ({ ok: true, value: null }));
  } });
  await assert.rejects(broken.await(), /cannot get property "webServer" without inject/);
  await broken.dispose();
  assert.equal(routes.some(row => row.path === '/fixture-old-method-path'), false);
  const beforeRoutes = [...routes], beforeUpgrades = [...upgrades], fiber = ctx.plugin(Host);
  await fiber.await(); assert.equal(fiber.state, 2);
  assert.deepEqual(routes, beforeRoutes); assert.deepEqual(upgrades, beforeUpgrades);
  assert.equal(ctx.typert.local.get('arcfoldMethods/decide').service, 'arcfoldMethodWeb');
  const responseFixture = () => {
    const state = {}, chunks = [];
    const response = Object.assign(new EventEmitter(), { writableEnded: false,
      writeHead(code, headers) { state.status = code; state.headers = headers; return this; },
      write(value) { chunks.push(Buffer.from(value)); return true; },
      end(value) { if (value !== undefined) chunks.push(Buffer.from(value)); this.writableEnded = true;
        state.body = Buffer.concat(chunks).toString('utf8'); return this; } });
    return { state, response };
  };
  const boot = new URL(connection.authenticatedUrl('http://127.0.0.1:3080/')), auth = responseFixture();
  connection.authorizeIndex({ url: boot.pathname + boot.search, method: 'GET', headers: { host: boot.host } }, auth.response);
  assert.equal(auth.state.status, 303); const cookie = auth.state.headers['set-cookie'].split(';', 1)[0];
  const route = routes.find(row => row.path === '/api'); assert.ok(route);
  const invoke = async (operation, payload, authenticated = true) => {
    const envelope = { type: 'client-request', rpcId: 'fixture-' + operation, method: 'arcfoldMethods/' + operation, payload: { args: { request: payload } } };
    const request = Object.assign(Readable.from([Buffer.from(JSON.stringify(envelope))]), { url: '/api/' + envelope.method,
      method: 'POST', headers: { host: boot.host, 'content-type': 'application/json', ...(authenticated ? { cookie } : {}) } });
    const result = responseFixture(); await route.handler(request, result.response); return result.state;
  };
  assert.equal((await invoke('decide', decision(), false)).status, 401); assert.equal(calls.length, 0);
  const accepted = await invoke('decide', decision()); assert.equal(accepted.status, 200);
  const acceptedBody = JSON.parse(accepted.body); assert.equal(acceptedBody.result.ok, true);
  assert.equal(acceptedBody.result.value.name, 'decide'); // no double success envelope
  assert.equal(calls[0].value.userIdentity, 'browser:' + connection.browserPeer.id);
  const otherOwner = connection.createPeer({ principal: { kind: 'owner' }, interactions: 'answer' });
  await assert.rejects(ctx.typertGateway.invoke({ namespace: 'arcfoldMethods', method: 'decide',
    args: { request: decision() }, peer: otherOwner }), error => error.code === 'trusted_browser_required');
  assert.equal(calls.length, 1); await otherOwner.dispose();
  conflict = true;
  const failed = JSON.parse((await invoke('decide', decision())).body);
  assert.equal(failed.result.ok, false); assert.equal(failed.result.error.code, 'revision_conflict');
  assert.deepEqual(failed.result.error.details, {}); assert.equal(calls.length, 1);
  assert.equal(JSON.parse((await invoke('cards', { offset: 0, limit: 20 })).body).result.value.name, 'listCards');
  assert.equal(JSON.parse((await invoke('cardDetails', { methodId: 'm1', offset: 20 })).body).result.value.name, 'cardDetails');
  assert.equal(calls.length, 3);
  await fiber.dispose(); assert.equal(ctx.typert.local.get('arcfoldMethods/decide'), undefined);
  assert.deepEqual(routes, beforeRoutes); assert.deepEqual(upgrades, beforeUpgrades);
  assert.equal(ctx.get('connection').browserPeer, connection.browserPeer);
  const withdrawn = JSON.parse((await invoke('decide', decision())).body);
  assert.equal(withdrawn.result.ok, false); assert.equal(calls.length, 3);
});


test('DOM uses corrected notification display text while retaining its original message in the response',async t=>{
  const value=detail();
  value.notifications.items[0]={...value.notifications.items[0],reason:'import_batch_withdrawn',
    message:'“旧通知的方法名”：学习提出暂停：import_batch_withdrawn',displayMessage:'“旧通知的方法名”：你已撤销这批导入；方法依赖的来源已停止作为依据，因此暂停。原记录保留。'};
  value.notifications.items.push({...value.notifications.items[0],id:'new-correct',displayMessage:undefined,
    message:'“新通知的方法名”：你已撤销这批导入；方法依赖的来源已停止作为依据，因此暂停。原记录保留。'});
  const bytes=JSON.stringify(value), f=await domFixture(t,{onDetails:async()=>value});await f.open();await f.history();
  assert.ok(document.body.textContent.includes(value.notifications.items[0].displayMessage));
  assert.ok(document.body.textContent.includes(value.notifications.items[1].message));
  assert.equal(document.body.textContent.includes(value.notifications.items[0].message),false);
  assert.equal(JSON.stringify(value),bytes);assert.equal(f.calls.length,0);
});
