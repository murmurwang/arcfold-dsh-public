import test from 'node:test';
import assert from 'node:assert/strict';
import { Context, Service } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import Group from '@deepseek-ai/cordis-plugin-group';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import SessionStore from '@deepseek-ai/dsh-session';
import SessionProjections from '@deepseek-ai/dsh-session-projection';
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import * as OfficialConnection from '@deepseek-ai/dsh-client-connection';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import TypertGateway from '@deepseek-ai/dsh-api-gateway';
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access';
import { SessionController } from '@deepseek-ai/dsh-api-session-controller';
import { Store } from '../src/store.mjs';
import { OpportunityService } from '../src/opportunities.mjs';
import { createOpportunityHandler } from '../packages/method-ui/src/opportunity-host.mjs';
import { createOpportunitySource } from '../packages/method-ui/src/opportunity-source.mjs';
import { OpportunityDock } from '../packages/method-ui/src/OpportunityDock.mjs';
import { opportunitiesZh } from '../packages/method-ui/src/opportunity-locales.mjs';
import { zh } from '../packages/method-ui/src/locales.mjs';
import * as Host from '../packages/method-ui/src/index.mjs';
import React, { act, useSyncExternalStore } from 'react';
import { JSDOM } from 'jsdom';
const signal = () => new AbortController().signal;
const owner = () => ({ id: 'owner', principal: { kind: 'owner' }, interactions: 'answer', signal: signal() });
function fixture(t) {
  const store = new Store(':memory:'); t.after(() => store.close()); const opportunities = new OpportunityService({ business: store });
  store.save('host_bindings', { id: 'main', role: 'main' });
  const opportunity = store.save('opportunities', { id: 'opportunity', conversationId: 'main', learnedFromRunId: 'learn', sourceIds: [], dependencies: [], description: '机会原文' });
  store.save('learning_sections', { id: 'learn:opportunities', status: 'completed', ids: [opportunity.id] });
  const peer = owner(), connection = { browserPeer: peer }, calls = [], preparation = { async prepare(value) { calls.push(value); return { id: 'run' }; } };
  // Small handler-unit fixture; actual Registry/Preset coverage is below.
  const main = { id: 'main', ctx: {} }, live = new Map([['main', main]]);
  return { store, opportunities, opportunity, peer, connection, calls, preparation, main, live,
    agents: { get: id => live.get(id) }, agentPresets: { composedPreset: () => 'arcfold-main' } };
}
const request = { sessionId: 'main', opportunityId: 'opportunity', expectedRevision: 1, requestId: 'stable-user-prompt', text: '这是我的完整新原话。' };

test('opportunity reads require the exact authenticated browser and never start preparation or prompt', async t => {
  const f = fixture(t), handler = createOpportunityHandler({ ...f, prompt() { throw new Error('No prompt on read'); } });
  assert.equal((await handler('list', { sessionId: 'main' }, signal(), f.peer)).ok, true);
  assert.equal((await handler('list', { sessionId: 'main' }, signal(), owner())).error.code, 'trusted_browser_required');
  assert.equal((await handler('list', { sessionId: 'main', confirmed: true }, signal(), f.peer)).ok, false);
  assert.equal(f.calls.length, 0); assert.equal(f.store.listAll('preparation_runs').length, 0);
});
test('unknown continuation and concurrent duplicates keep one exact official prompt and never resend', async t => {
  const f = fixture(t), release = Promise.withResolvers(); let count = 0;
  const handler = createOpportunityHandler({ ...f, prompt: async value => { count++; assert.deepEqual(value.content, [{ type: 'text', text: request.text }]); await release.promise; throw new Error('lost response'); } });
  const first = handler('continue', request, signal(), f.peer); await Promise.resolve();
  const second = handler('continue', request, signal(), f.peer); release.resolve();
  const [a,b] = await Promise.all([first,second]); assert.equal(count, 1); assert.equal(a.value.binding.state, 'unknown'); assert.equal(b.value.binding.state, 'unknown');
  assert.equal((await handler('continue', request, signal(), f.peer)).value.created, false); assert.equal(count, 1);
  assert.equal((await handler('continue', { ...request, text: '换原话' }, signal(), f.peer)).ok, false);
});
test('refresh, reconnect and stale reads only use list; no permission write or automatic prepare', async t => {
  const calls = [], reset = new Set(); let release;
  const rpc = { async call(_channel, method, value) { calls.push({ method, value }); return { ok: true, value: { items: [], total: 0, nextOffset: null } }; } };
  const source = createOpportunitySource({ rpc, sessionId: 'main', subscribeReset: fn => { reset.add(fn); return () => reset.delete(fn); }, intervalMs: 100000 });
  t.after(() => source.dispose()); const stop = source.subscribe(() => {});
  await source.refresh(); for (const fn of reset) fn(); await source.refresh(20);
  assert.equal(calls.every(call => call.method === 'arcfoldOpportunities/list' && call.value.args.request.sessionId === 'main'), true);
  stop(); assert.equal(reset.size, 0);
});
async function nativeRegistry(ctx, t) {
  ctx.baseUrl = import.meta.url;
  const active = async fiber => { for (let n = 0; n < 100; n++) { await fiber.await(); if (fiber.state === 2) return;
    assert.ok([0, 1].includes(fiber.state)); await new Promise(resolve => setImmediate(resolve)); } assert.fail('Native registry did not activate'); };
  await active(ctx.plugin(Loader)); ctx.loader.builtins.group = Group;
  for (const plugin of [LlmRuntime, SessionStore, SessionProjections]) await active(ctx.plugin(plugin));
  const root = mkdtempSync(join(tmpdir(), 'arcfold-opportunity-admission-'));
  t.diagnostic('Retained real opportunity Agent/Preset registry: ' + root);
  await active(ctx.plugin(JsonlPersistence, { root, compression: 'none' }));
  await active(ctx.plugin(SystemPrompt));
  for (const plugin of [ToolRuntime, NativeExecutor, AgentRegistry]) await active(ctx.plugin(plugin));
  await active(ctx.plugin(AgentLoop, { agents: [] })); await active(ctx.plugin(AgentPresets, { default: 'arcfold-main' }));
  for (const id of ['arcfold-main', 'arcfold-learning', 'unrelated'])
    await active(ctx.plugin({ inject: ['agentPresets'], async *apply(owner) { yield await owner.agentPresets.register({ id, plugins: [] }); } }));
  const handles = [], detach = new Map(), enter = ctx.agents.enter.bind(ctx.agents);
  // Observe the original ordered native detach capability, without altering it.
  ctx.agents.enter = (agent, owner) => { const remove = enter(agent, owner); detach.set(agent.id, remove); return remove; };
  const create = async (id, preset = 'arcfold-main') => { const handle = await ctx.agents.create({ sessionId: id, agentOptions: {},
    setup: async owner => { await ctx.agentPresets.mount(owner, preset); } }); handles.push(handle); return handle; };
  t.after(async () => { for (const handle of handles) await handle.dispose(); });
  return { create, detach, main: await create('main'), helper: await create('helper', 'arcfold-learning'), other: await create('other', 'unrelated') };
}
async function gatewayFixture(t) {
  const f = fixture(t), ctx = new Context(), native = []; let credentials;
  ctx.provide('credentials', { readRecord: async () => credentials, async modifyRecord(_key, mutate) { credentials = await mutate(credentials); return credentials; }, async deleteRecord() {} });
  ctx.provide('webServer', { host: '127.0.0.1', protocol: 'http:', port: 3080, register: () => () => {}, registerUpgrade: () => () => {}, tapIndex: () => () => {} });
  ctx.provide('arcfoldMethods', {}); ctx.provide('arcfoldOpportunities', f.opportunities); ctx.provide('arcfoldPreparation', f.preparation);
  class Controller extends Service {
    constructor(owner) { super(owner, 'sessionController'); }
    get commands() { const invocation = this.ctx.invocation; return { prompt(request, source) {
      native.push({ request, source, peer: invocation.peer, signal: invocation.signal }); return { accepted: true }; } }; }
    prompt(request, signal) { return SessionController.prototype.prompt.call(this, request, signal); }
  }
  new Controller(ctx);
  const registry = await nativeRegistry(ctx, t);
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(OfficialConnection).await(); await ctx.plugin(TypertRegistry).await();
  await ctx.plugin(RemoteAccess).await(); await ctx.plugin(TypertGateway).await();
  const fiber = ctx.plugin(Host); await fiber.await(); const peer = ctx.connection.browserPeer;
  return { ...f, ctx, native, fiber, peer, registry, invoke: (method, payload, actor = peer) => ctx.typertGateway.invoke({ namespace: 'arcfoldOpportunities', method, args: { request: payload }, peer: actor }) };
}
test('actual Gateway invokes original SessionController prompt with owner signal, source user, rpcId and literal text', async t => {
  const { ctx, native, fiber, peer } = await gatewayFixture(t);
  const value = await ctx.typertGateway.invoke({ namespace: 'arcfoldOpportunities', method: 'continue', args: { request }, peer });
  assert.equal(value.binding.state, 'accepted'); assert.equal(native.length, 1); assert.equal(native[0].peer, peer);
  assert.deepEqual(native[0].source, { kind: 'user', rpcId: request.requestId });
  assert.deepEqual(native[0].request.content, [{ type: 'text', text: request.text }]);
  const other = ctx.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'answer' });
  await assert.rejects(ctx.typertGateway.invoke({ namespace: 'arcfoldOpportunities', method: 'continue', args: { request }, peer: other }), error => error.code === 'trusted_browser_required');
  await other.dispose(); await fiber.dispose(); assert.equal(ctx.typert.local.get('arcfoldOpportunities/continue'), undefined);
});

async function dom(t, overrides = {}) {
  const browser = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://127.0.0.1/' });
  const keys = ['window','document','IS_REACT_ACT_ENVIRONMENT'], prior = Object.fromEntries(keys.map(key => [key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  Object.defineProperty(globalThis,'window',{ value: browser.window, configurable: true }); Object.defineProperty(globalThis,'document',{ value: browser.window.document, configurable: true }); globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import('react-dom/client'), root = createRoot(document.getElementById('root'));
  const listeners = new Set(), calls = [], item = { opportunity: { id: 'o', revision: 2, description: '可审阅的机会 <script>x</script>', rationale: '依据', suggestedPreparation: '先准备', sourceIds: [] }, run: null, eligible: true, originals: [] };
  let state = { items: [item], total: 1, offset: 0, nextOffset: null, workspace: '/workspace', permission: { revision: 2, enabled: false, files: [], extraSourceIds: [] }, canPrepare: true, canContinue: true };
  const useOpportunities = select => select(useSyncExternalStore(fn => { listeners.add(fn); return () => listeners.delete(fn); }, () => state));
  const text = { ...zh,...opportunitiesZh };
  const props = { useOpportunities, t: key => text[key] ?? key, onOpportunityDetails: async () => item,
    onOpportunityAct: async (endpoint, value) => { calls.push({ endpoint, value }); return {}; }, onOpportunityRefresh: async () => {}, onOpportunityPage: async () => {}, ...overrides };
  await act(async () => root.render(React.createElement(OpportunityDock, props)));
  t.after(async () => { await act(async () => root.unmount()); browser.window.close(); for (const key of keys) { if (prior[key]) Object.defineProperty(globalThis,key,prior[key]); else delete globalThis[key]; } });
  const buttons = label => [...document.querySelectorAll('button')].filter(node => node.textContent === label);
  const click = async (label, index = 0) => { await act(async () => buttons(label)[index].click()); };
  return { item, calls, buttons, click, update: async changes => { await act(async () => { state = {...state,...changes}; for (const listener of listeners) listener(); }); },
    type: async value => { const node = document.querySelector('article textarea'); await act(async () => {
      Object.getOwnPropertyDescriptor(browser.window.HTMLTextAreaElement.prototype,'value').set.call(node,value); node.dispatchEvent(new browser.window.Event('input',{bubbles:true})); }); } };
}
test('opportunities render readable cards with complete details and no internal action controls', async t => {
  const reads = [], f = await dom(t, { onOpportunityDetails: async id => { reads.push(id); return f.item; } });
  assert.deepEqual(reads, []);
  await f.click(opportunitiesZh.opportunityOpen);
  assert.deepEqual(reads, ['o']);
  const card = document.querySelector('.opportunity-card');
  assert.ok(card.textContent.includes(f.item.opportunity.description));
  assert.ok(card.textContent.includes('依据')); assert.ok(card.textContent.includes('先准备'));
  assert.equal(document.querySelectorAll('.opportunity-content button,.opportunity-content input,.opportunity-content textarea').length, 0);
  assert.equal(document.querySelectorAll('script').length, 0);
  assert.deepEqual(f.calls, []); assert.equal(document.querySelector('nav'), null);
  await f.update({ permission: { revision: 7, enabled: true } });
  assert.ok(document.body.textContent.includes(opportunitiesZh.opportunityOn));
  assert.deepEqual(f.calls, []);
});

test('card details keep the full draft and original evidence without marking notices read', async t => {
  const f = await dom(t, { onOpportunityDetails: async () => ({ ...f.item,
    run: { id: 'run', revision: 1, state: 'settled', input: { original: '原始材料 <script>保留为文本</script>' } },
    notice: { status: 'unread' }, available: true,
    artifact: { evidence: { path: '/workspace/draft.txt', text: '完整准备稿\n第二段' } },
  }) });
  await f.click(opportunitiesZh.opportunityOpen);
  assert.ok(document.querySelector('.opportunity-draft').textContent.includes('完整准备稿\n第二段'));
  assert.ok(document.querySelector('.opportunity-evidence').textContent.includes('原始材料'));
  assert.ok(document.querySelector('.opportunity-status').textContent.includes(opportunitiesZh.opportunityOff));
  assert.ok(document.querySelector('.opportunity-card').textContent.includes(opportunitiesZh.opportunityUnread));
  assert.equal(document.querySelectorAll('script').length, 0); assert.deepEqual(f.calls, []);
});

test('late detail cannot cross a connection reset, and a disposed source cannot issue actions', async t => {
  const pending = Promise.withResolvers(), resets = new Set(), calls = [];
  const rpc = { async call(_channel, method) { calls.push(method); return method.endsWith('/details') ? pending.promise : { ok: true, value: { items: [], total: 0, nextOffset: null } }; } };
  const source = createOpportunitySource({ rpc, sessionId: 'main', intervalMs: 100000, subscribeReset: fn => { resets.add(fn); return () => resets.delete(fn); } });
  t.after(() => source.dispose()); source.subscribe(() => {});
  const detail = source.details('opportunity'); for (const reset of resets) reset();
  pending.resolve({ ok: true, value: { stale: true } }); await assert.rejects(detail, error => error.code === 'opportunity_view_reset');
  source.dispose(); const count = calls.length;
  await assert.rejects(source.act('continue', request), error => error.code === 'opportunity_view_disposed');
  assert.equal(calls.length, count); assert.equal(resets.size, 0);
});
test('reconnect discards old card details and ignores an older late response', async t => {
  const held = Promise.withResolvers(); let reads = 0;
  const f = await dom(t, { onOpportunityDetails: () => ++reads === 1 ? held.promise : Promise.resolve({ ...f.item,
    artifact: { evidence: { path: '/new', text: '新连接的准备稿' } }, available: true }) });
  await f.click(opportunitiesZh.opportunityOpen);
  await f.update({ resetVersion: 1 });
  await act(async () => held.resolve({ ...f.item, artifact: { evidence: { path: '/old', text: '过期准备稿' } }, available: true }));
  assert.ok(document.body.textContent.includes('新连接的准备稿'));
  assert.equal(document.body.textContent.includes('过期准备稿'), false); assert.deepEqual(f.calls, []);
  await f.click(opportunitiesZh.opportunityHide); assert.equal(document.querySelector('article'), null);
});
test('concurrent manual preparations bind one versioned request; a lost response never dispatches it again', async t => {
  const f = fixture(t), held = Promise.withResolvers(); let entered = 0;
  f.opportunities.workspace = '/fixture';
  f.store.save('events', { id: 'original', conversationId: 'main', role: 'user', content: '先准备材料。' });
  f.opportunity = f.store.save('opportunities', { ...f.opportunity, sourceIds: ['original'], dependencies: [{ kind: 'events', id: 'original', revision: 1 }] }, { expectedRevision: f.opportunity.revision });
  f.opportunities.savePermission({ sessionId: 'main', enabled: true, extraSourceIds: [], files: [], expectedRevision: 0, requestId: 'permission', userIdentity: 'browser:owner' });
  const payload = { opportunityId: f.opportunity.id, expectedRevision: f.opportunity.revision, permissionRevision: f.opportunities.permission('main').revision, requestId: 'manual-once' };
  const handler = createOpportunityHandler({ ...f, preparation: { async prepare() { entered++; await held.promise; throw new Error('Lost admission response'); } } });
  const a = handler('prepare', payload, signal(), f.peer); const b = handler('prepare', payload, signal(), f.peer); held.resolve();
  const results = await Promise.all([a, b]); assert.equal(entered, 1); assert.equal(results[0].value.binding.state, 'failed');
  assert.equal(results[1].value.binding.id, results[0].value.binding.id);
  assert.equal((await handler('prepare', payload, signal(), f.peer)).value.created, false); assert.equal(entered, 1);
});


test('real Registry and Preset reject cold, helper, foreign and disposed sessions despite historical main bindings', async t => {
  const f = await gatewayFixture(t);
  for (const id of ['cold', 'helper', 'other']) {
    f.store.save('host_bindings', { id, role: 'main' });
    const opportunity = f.store.save('opportunities', { ...f.opportunity, id: 'opportunity-' + id, conversationId: id });
    const section = f.store.get('learning_sections', 'learn:opportunities');
    f.store.save('learning_sections', { ...section, ids: [...section.ids, opportunity.id] }, { expectedRevision: section.revision });
    await assert.rejects(f.invoke('continue', { ...request, sessionId: id, opportunityId: opportunity.id, requestId: 'continue-' + id }), error => error.code === 'opportunity_session_denied');
    assert.equal(f.native.length, 0); assert.equal(f.store.listAll('opportunity_continuations').length, 0);
  }
  await f.registry.main.dispose();
  await assert.rejects(f.invoke('continue', request), error => error.code === 'opportunity_session_denied');
  assert.equal(f.native.length, 0); assert.equal(f.ctx.agents.get('cold'), undefined);
  assert.equal(f.registry.helper.agent.session.snapshotEvents().some(e => e.type === 'turn/start'), false);
});

test('actual native unregister after durable binding prevents prompt and consumes failed admission without retry', async t => {
  const f = await gatewayFixture(t), bind = f.opportunities.bindContinuation.bind(f.opportunities);
  f.opportunities.bindContinuation = value => { const bound = bind(value); f.registry.detach.get('main')(); return bound; };
  const result = await f.invoke('continue', request);
  assert.equal(result.binding.state, 'failed'); assert.equal(f.native.length, 0); assert.equal(f.ctx.agents.get('main'), undefined);
  assert.equal(f.store.listAll('opportunity_continuations').length, 1);
  await assert.rejects(f.invoke('continue', request), error => error.code === 'opportunity_session_denied');
  assert.equal(f.native.length, 0);
});

test('same-id replacement between bind and prompt is refused even when its preset name still matches', async t => {
  const f = fixture(t); let calls = 0;
  const bind = f.opportunities.bindContinuation.bind(f.opportunities);
  f.opportunities.bindContinuation = value => { const bound = bind(value); f.live.set('main', { id: 'main', ctx: {} }); return bound; };
  const handler = createOpportunityHandler({ ...f, prompt: async () => { calls++; return { accepted: true }; } });
  const first = await handler('continue', request, signal(), f.peer);
  assert.equal(first.value.binding.state, 'failed'); assert.equal(calls, 0);
  assert.equal((await handler('continue', request, signal(), f.peer)).value.created, false); assert.equal(calls, 0);
});


test('historical cards remain readable without a live main Agent and refresh only reads', async t => {
  let reads = 0, refreshes = 0;
  const f = await dom(t, { onOpportunityDetails: async () => { reads++; return f.item; }, onOpportunityRefresh: async () => { refreshes++; } });
  await f.update({ canPrepare: false, canContinue: false });
  await f.click(opportunitiesZh.opportunityOpen);
  assert.ok(document.body.textContent.includes(f.item.opportunity.description));
  await f.click(zh.refresh);
  assert.equal(reads, 2); assert.equal(refreshes, 1); assert.deepEqual(f.calls, []);
  assert.equal(document.querySelectorAll('.opportunity-content button').length, 0);
});

for (const kind of ['rejected', 'unknown', 'stopped']) {
  test(`read-only cards preserve the recorded outcome: ${kind}`, async t => {
    const outcome = kind === 'rejected' ? { rejection: { error: { message: '材料检查拒绝原因' } } }
      : kind === 'unknown' ? { run: { id: 'run', state: 'unknown', revision: 2, error: { message: '原请求结果未知' } } }
      : { run: { id: 'run', state: 'settled', revision: 3 }, stopped: true, available: false,
        artifact: { evidence: { path: '/old', text: '仍保留的历史准备稿' } } };
    const f = await dom(t, { onOpportunityDetails: async () => ({ ...f.item, ...outcome }) });
    await f.click(opportunitiesZh.opportunityOpen);
    const expected = { rejected: opportunitiesZh.opportunityRejected, unknown: opportunitiesZh.opportunityUncertain, stopped: opportunitiesZh.opportunityStopped }[kind];
    assert.ok(document.querySelector('.opportunity-card').textContent.includes(expected));
    if (kind === 'stopped') assert.ok(document.body.textContent.includes('仍保留的历史准备稿'));
    await f.click(zh.refresh); assert.deepEqual(f.calls, []);
  });
}

test('a failed detail read retains the suggestion and shows the error in its own card', async t => {
  const f = await dom(t, { onOpportunityDetails: async () => { throw new Error('详情暂时不可用'); } });
  await f.click(opportunitiesZh.opportunityOpen);
  const card = document.querySelector('.opportunity-card');
  assert.ok(card.textContent.includes(f.item.opportunity.description));
  assert.equal(card.querySelector('[role=alert]').textContent, '详情暂时不可用');
  assert.deepEqual(f.calls, []);
});
