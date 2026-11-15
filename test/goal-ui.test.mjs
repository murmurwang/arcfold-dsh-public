// UI/official Gateway contracts only; no host process or model is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Context, Service } from '@deepseek-ai/cordis';
import * as OfficialConnection from '@deepseek-ai/dsh-client-connection';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import TypertGateway from '@deepseek-ai/dsh-api-gateway';
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access';
import { SessionController } from '@deepseek-ai/dsh-api-session-controller';
import React, { act, useSyncExternalStore } from 'react';
import { JSDOM } from 'jsdom';
import * as Host from '../packages/method-ui/src/index.mjs';
import * as Client from '../packages/method-ui/src/client.mjs';
import { createGoalHandler } from '../packages/method-ui/src/goal-host.mjs';
import { createGoalSource } from '../packages/method-ui/src/goal-source.mjs';
import { GoalDock } from '../packages/method-ui/src/GoalDock.mjs';
import { zh } from '../packages/method-ui/src/locales.mjs';
import { goalZh } from '../packages/method-ui/src/goal-locales.mjs';

const live = () => new AbortController().signal;
const browser = () => ({ id: 'browser-owner', principal: { kind: 'owner' }, interactions: 'answer', signal: live() });
const submission = (extra = {}) => ({ sessionId: 'main', goalId: 'g1', expectedRevision: 2, definitionVersion: 1,
  mode: 'discuss', text: '请检查这次工作怎样支持长期目标。', requestId: 'submit-one', ...extra });
function businessFixture() {
  const bindings = new Map(), calls = [], hooks = {};
  const goals = {
    list(value) { calls.push({ name: 'list', value }); return { items: [], total: 0, nextOffset: null }; },
    details(id, scope) { calls.push({ name: 'details', value: { id, scope } }); return {}; },
    decide(value) { calls.push({ name: 'decide', value }); return value; },
    bindDiscussion(value) {
      calls.push({ name: 'bind', value: structuredClone(value) });
      const id = JSON.stringify([value.sessionId, value.requestId]), old = bindings.get(id);
      if (old && JSON.stringify(old.request) !== JSON.stringify(value))
        throw Object.assign(new Error('same identity changed'), { code: 'discussion_identity_conflict' });
      const binding = old || { id, requestId: value.requestId, request: structuredClone(value) };
      bindings.set(id, binding); hooks.onBind?.(); return { binding: structuredClone(binding), goalRef: { id: value.goalId }, created: !old };
    },
    recordDiscussionAdmission({ bindingId, state }) {
      const next = { ...bindings.get(bindingId), admission: { state } }; bindings.set(bindingId, next);
      calls.push({ name: 'admission', value: { bindingId, state } }); return structuredClone(next);
    },
  };
  return { goals, bindings, calls, hooks };
}
function handlerFixture(prompt = async () => ({ accepted: true })) {
  const f = businessFixture(), peer = browser(), connection = { browserPeer: peer };
  f.bound = true;
  const agent = { id: 'main', ctx: {} };
  const agents = { get: id => f.bound && id === 'main' ? agent : undefined };
  const agentPresets = { composedPreset: context => context === agent.ctx ? 'arcfold-main' : undefined };
  const handler = createGoalHandler({ goals: f.goals, connection, agents, agentPresets, prompt });
  return { ...f, agents, agentPresets, setBound: value => { f.bound = value; }, peer, connection, handler,
    invoke: (endpoint, value, p = peer) => handler(endpoint, value, live(), p) };
}

test('goal controls derive browser identity and never enqueue a prompt', async () => {
  let prompts = 0; const f = handlerFixture(() => { prompts++; });
  for (const action of ['pause', 'resume', 'close']) {
    const reply = await f.invoke('decide', { goalId: 'g1', expectedRevision: 2, definitionVersion: 1, action, requestId: action });
    assert.equal(reply.ok, true); assert.equal(reply.value.userIdentity, 'browser:browser-owner');
  }
  assert.equal(prompts, 0); assert.equal(f.bindings.size, 0);
  const invalid = await f.invoke('decide', { goalId: 'g1', expectedRevision: 2, definitionVersion: 1,
    action: 'resume', requestId: 'bad', confirmed: true });
  assert.equal(invalid.error.code, 'invalid_goal_request');
  assert.equal((await f.invoke('list', { sessionId: 'main' }, browser())).error.code, 'trusted_browser_required');
});

test('explicit discussion is bound before one official admission; concurrent retries coalesce and later reads never resend', async () => {
  let resolve, count = 0; const sent = [];
  const f = handlerFixture(async value => { count++; sent.push(value); return new Promise(done => { resolve = done; }); });
  const first = f.invoke('discuss', submission());
  await Promise.resolve(); const second = f.invoke('discuss', submission());
  assert.equal(count, 1); assert.equal(f.bindings.size, 1);
  assert.deepEqual(sent[0], { sessionId: 'main', requestId: 'submit-one', mode: 'queue', content: [{ type: 'text', text: submission().text }] });
  assert.equal(f.calls[0].name, 'bind'); assert.equal(f.calls[0].value.userIdentity, 'browser:browser-owner');
  resolve({ accepted: true });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.value.binding.admission.state, 'accepted'); assert.equal(b.value.binding.admission.state, 'accepted');
  assert.equal((await f.invoke('discuss', submission())).value.created, false); assert.equal(count, 1);
  const changed = await f.invoke('discuss', submission({ text: 'other tab reused an identity' }));
  assert.equal(changed.error.code, 'discussion_identity_conflict'); assert.equal(count, 1);
});

test('uncertain admission and a fresh handler retain the binding without a second prompt', async () => {
  let count = 0; const f = handlerFixture(async () => { count++; throw new Error('connection lost after admission'); });
  const reply = await f.invoke('discuss', submission());
  assert.equal(reply.ok, true); assert.equal(reply.value.binding.admission.state, 'unknown');
  const restarted = createGoalHandler({ goals: f.goals, connection: f.connection, agents: f.agents, agentPresets: f.agentPresets, prompt() { count++; } });
  const read = await restarted('discuss', submission(), live(), f.peer);
  assert.equal(read.value.created, false); assert.equal(read.value.binding.admission.state, 'unknown'); assert.equal(count, 1);
});

test('helper and absent sessions are refused before binding; losing the current main stops before admission', async () => {
  let prompts = 0; const f = handlerFixture(async () => { prompts++; return { accepted: true }; });
  assert.equal((await f.invoke('discuss', submission({ sessionId: 'learn-helper' }))).error.code, 'goal_main_session_required');
  f.setBound(false);
  assert.equal((await f.invoke('discuss', submission())).error.code, 'goal_main_session_required');
  assert.equal(f.bindings.size, 0); assert.equal(prompts, 0);
  f.setBound(true); const pending = f.invoke('discuss', submission()); f.setBound(false);
  assert.equal((await pending).value.binding.admission.state, 'failed'); assert.equal(prompts, 0);
});

test('goal read cache is scoped to its dock session; refresh and reconnect do not submit decisions or prompts', async t => {
  const calls = [], resets = new Set();
  const source = createGoalSource({ sessionId: 'exact-dock-session', intervalMs: 60000,
    subscribeReset: listener => { resets.add(listener); return () => resets.delete(listener); },
    rpc: { async call(channel, method, payload) {
      calls.push({ channel, method, request: payload.args.request });
      return { ok: true, value: { items: [], total: 0, nextOffset: null, canDiscuss: false } };
    } } });
  t.after(() => source.dispose()); const stop = source.subscribe(() => {});
  await source.refresh(); for (const reset of resets) reset(); await source.refresh(20);
  assert.equal(calls.every(row => row.method === 'arcfoldGoals/list' && row.request.sessionId === 'exact-dock-session'), true);
  stop(); assert.equal(resets.size, 0);
});

test('actual Gateway preserves its invocation when goal discussion calls the official SessionController prompt method', async t => {
  const ctx = new Context(), routes = [], f = businessFixture(), native = []; let credentials;
  ctx.provide('credentials', { readRecord: async () => credentials,
    async modifyRecord(_key, mutate) { credentials = await mutate(credentials); return credentials; }, async deleteRecord() {} });
  await ctx.plugin({ name: 'fixture-web-carrier', apply(owner) {
    owner.provide('webServer', { host: '127.0.0.1', protocol: 'http:', port: 3080,
      register(route) { routes.push(route); return () => routes.splice(routes.indexOf(route), 1); },
      registerUpgrade: () => () => {}, tapIndex: () => () => {} });
  } }).await();
  ctx.provide('arcfoldMethods', {}); ctx.provide('arcfoldGoals', f.goals);
  // Gateway invocation fixture; real native registry coverage is in understanding-ui.
  const main = { id: 'main', ctx: {} };
  ctx.provide('agents', { get: id => id === 'main' ? main : undefined });
  ctx.provide('agentPresets', { composedPreset: context => context === main.ctx ? 'arcfold-main' : undefined });
  class Controller extends Service {
    constructor(owner) { super(owner, 'sessionController'); }
    get commands() { const invocation = this.ctx.invocation; return { prompt(request, source) {
      native.push({ request, source, peer: invocation?.peer, signal: invocation?.signal }); return { accepted: true };
    } }; }
    prompt(request, signal) { return SessionController.prototype.prompt.call(this, request, signal); }
  }
  new Controller(ctx); t.after(() => ctx.fiber.dispose());
  await ctx.plugin(OfficialConnection).await(); await ctx.plugin(TypertRegistry).await();
  await ctx.plugin(RemoteAccessService).await(); await ctx.plugin(TypertGateway).await();
  const fiber = ctx.plugin(Host); await fiber.await();
  const peer = ctx.connection.browserPeer;
  const result = await ctx.typertGateway.invoke({ namespace: 'arcfoldGoals', method: 'discuss', args: { request: submission() }, peer });
  assert.equal(result.binding.admission.state, 'accepted'); assert.equal(native.length, 1);
  assert.equal(native[0].peer, peer); assert.deepEqual(native[0].source, { kind: 'user', rpcId: 'submit-one' });
  assert.deepEqual(native[0].request.content, [{ type: 'text', text: submission().text }]);
  const other = ctx.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'answer' });
  await assert.rejects(ctx.typertGateway.invoke({ namespace: 'arcfoldGoals', method: 'discuss',
    args: { request: submission({ requestId: 'not-browser' }) }, peer: other }), error => error.code === 'trusted_browser_required');
  await other.dispose(); assert.equal(native.length, 1);
  await fiber.dispose(); assert.equal(ctx.typert.local.get('arcfoldGoals/discuss'), undefined);
  assert.equal(ctx.connection.browserPeer, peer);
});

const detail = (revision = 2, allowed = true) => ({ goal: { id: 'g1', title: allowed ? '形成长期研究方向' : undefined,
  outcome: allowed ? '保留不同分叉和它们的依据 <script>never execute</script>' : undefined,
  revision, definitionVersion: 1, status: 'paused', progress: null },
  availability: { allowed, message: allowed ? undefined : '旧依据已撤回' }, repairAllowed: !allowed,
  controls: { resumeAllowed: allowed }, sources: [], relations: [{ type: 'part_of', targetId: 'g-parent', state: 'needs_review' }],
  links: [{ id: 'link-1', sessionId: 'main', turn: 1, definitionVersion: 1, outcome: { outcome: 'completed' } }],
  discussions: [], discussionsTotal: 0 });
async function domFixture(t, overrides = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1/' });
  const keys = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'];
  const prior = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')), listeners = new Set(), calls = [];
  let state = { items: [overrides.initialDetail ?? detail()], total: 1, offset: 0, nextOffset: null, canDiscuss: true };
  const useGoals = selector => selector(useSyncExternalStore(fn => { listeners.add(fn); return () => listeners.delete(fn); }, () => state));
  const copy = { ...zh, ...goalZh };
  const props = { useGoals, t: key => copy[key], onGoalDetails: async () => detail(),
    onGoalDecide: async value => { calls.push({ kind: 'decide', value }); },
    onGoalDiscuss: async value => { calls.push({ kind: 'discuss', value }); return { binding: { admission: { state: 'accepted' } } }; },
    onGoalRefresh: async () => {}, onGoalPage: async () => {}, ...overrides };
  await act(async () => root.render(React.createElement(GoalDock, props)));
  t.after(async () => { await act(async () => root.unmount()); dom.window.close();
    for (const key of keys) { if (prior[key]) Object.defineProperty(globalThis, key, prior[key]); else delete globalThis[key]; } });
  const buttons = label => [...document.querySelectorAll('button')].filter(node => node.textContent === label);
  const click = async (label, index = 0) => { await act(async () => buttons(label)[index].click()); };
  const type = async (value, index = 0) => { const node = document.querySelectorAll('textarea')[index];
    await act(async () => {
      // Use the browser's input setter, avoiding React's own value tracker.
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set.call(node, value);
      node.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    }); };
  return { calls, buttons, click, type, open: async () => { await click(goalZh.goalOpen); },
    update: async next => { await act(async () => { state = { ...state, ...next }; for (const listener of listeners) listener(); }); } };
}

test('goal panel shows interpretation boundaries and corrections use the displayed version, without sending on view', async t => {
  const f = await domFixture(t); await f.open();
  assert.equal(f.calls.length, 0); assert.equal(document.querySelectorAll('script').length, 0);
  assert.ok(document.body.textContent.includes(goalZh.goalRelationReview));
  assert.ok(document.body.textContent.includes(goalZh.goalUnassessed));
  assert.equal(f.buttons(goalZh.goalPause).length, 0); assert.equal(f.buttons(goalZh.goalResume).length, 0);
  assert.equal(f.buttons(goalZh.goalClose).length, 0);
  await f.update({ items: [detail(8)] }); await f.type('请按这次原话纠正'); await f.click(goalZh.goalDiscuss);
  assert.equal(f.calls[0].value.expectedRevision, 8); assert.equal(f.calls[0].value.definitionVersion, 1);
  assert.equal(Object.hasOwn(f.calls[0].value, 'userIdentity'), false);
  assert.equal(f.calls[0].kind, 'discuss'); assert.equal(f.calls[0].value.text, '请按这次原话纠正');
  assert.equal(f.calls.some(row => row.kind === 'decide'), false);
});

test('goal details show no linked work only when both current work and historical contributions are absent', async t => {
  let current = { ...detail(), links: [], works: [{ id: 'work-1', sessionId: 'main', nativeGoalId: 'native-1',
    nativeRevision: 1, objective: '核对当前研究的原始材料', phase: 'active', activation: 'armed',
    roundsStarted: 1, maxGoalRounds: 4, provenance: 'verified-native-delegation', canStop: false,
    relation: { goalId: 'g1', definitionVersion: 1, state: 'current', reason: '为研究目标核对依据。' } }] };
  const f = await domFixture(t, { initialDetail: current }); await f.open();
  assert.ok(document.querySelector('article').textContent.includes(current.works[0].objective));
  assert.ok(document.querySelector('article').textContent.includes(goalZh.goalStageReview));
  assert.equal(document.querySelector('article').textContent.includes(goalZh.goalWorkEnabled), false,
    'a legacy active native goal without an Arcfold stage requires clarification');
  assert.equal(document.querySelector('article').textContent.includes(goalZh.goalNoLinks), false);
  current = { ...current, works: [], links: [{ ...detail().links[0],
    contribution: { available: true, reason: '以前这轮工作为目标核对了另一份原件。' } }] };
  await f.update({ items: [current] });
  assert.ok(document.querySelector('article').textContent.includes(current.links[0].contribution.reason));
  assert.equal(document.querySelector('article').textContent.includes(goalZh.goalNoLinks), false);
  current = { ...current, links: [] }; await f.update({ items: [current] });
  assert.ok(document.querySelector('article').textContent.includes(goalZh.goalNoLinks));
  assert.equal(f.calls.length, 0);
});

test('goal discussion sends literal draft only after click and retains its request identity after an unknown result', async t => {
  const submitted = [];
  const f = await domFixture(t, { onGoalDiscuss: async value => { submitted.push(value); throw new Error('lost response'); } });
  await f.open(); await f.type('我的新原话'); assert.equal(submitted.length, 0);
  await f.click(goalZh.goalDiscuss); assert.equal(submitted.length, 1); assert.equal(submitted[0].text, '我的新原话');
  assert.equal(submitted[0].mode, 'discuss'); assert.ok(document.body.textContent.includes(goalZh.goalUnknown));
  await f.click(goalZh.goalDiscuss); assert.equal(submitted.length, 2); assert.equal(submitted[0].requestId, submitted[1].requestId);
});

test('switching goals never carries an unsent correction into another goal', async t => {
  const second = { ...detail(), goal: { ...detail().goal, id: 'g2', title: '另一个目标' } };
  const f = await domFixture(t, { onGoalDetails: async id => id === 'g2' ? second : detail() });
  await f.update({ items: [detail(), second], total: 2 }); await f.open();
  await f.type('只属于第一个目标的纠正');
  const cards = document.querySelectorAll('.goal-card');
  assert.equal(cards.length, 2);
  assert.equal(cards[1].getAttribute('aria-label'), '另一个目标');
  assert.equal(cards[0].querySelector('textarea').value, '只属于第一个目标的纠正');
  assert.equal(cards[1].querySelector('textarea').value, '');
  assert.equal(f.buttons(goalZh.goalDiscuss)[1].disabled, true); assert.equal(f.calls.length, 0);
});

test('source withdrawal exposes only repair and unavailable main sessions cannot submit a goal discussion', async t => {
  const f = await domFixture(t, { initialDetail: detail(3, false) });
  await f.open(); assert.ok(document.body.textContent.includes('旧依据已撤回'));
  assert.equal(f.buttons(goalZh.goalResume).length, 0); assert.equal(f.buttons(goalZh.goalDiscuss).length, 0);
  await f.type('重新澄清'); await f.update({ canDiscuss: false });
  assert.equal(f.buttons(goalZh.goalRepair)[0].disabled, true); await f.click(goalZh.goalRepair);
  assert.equal(f.calls.length, 0); assert.ok(document.body.textContent.includes(goalZh.goalMainRequired));
});

test('goal details distinguish invalid progress and historical AI contribution without exposing unavailable wording', async t => {
  let current = { ...detail(), coverage: { progressUnavailable: 1 },
    relations: [{ type: 'derived_from', targetId: 'older-goal', state: 'needs_review' }],
    links: [{ ...detail().links[0], contribution: { available: true, reason: '先完成小文件回读，为当时的研究目标提供可核对材料。' } }] };
  const f = await domFixture(t, { initialDetail: current }); await f.open();
  assert.ok(document.body.textContent.includes(goalZh.goalDerived));
  assert.ok(document.body.textContent.includes(goalZh.goalProgressUnavailable));
  assert.equal(document.body.textContent.includes(goalZh.goalNoProgress), false);
  assert.ok(document.body.textContent.includes(goalZh.goalContribution));
  assert.ok(document.body.textContent.includes(current.links[0].contribution.reason));
  current = { ...current, links: [{ ...current.links[0], contribution: { available: false, reason: 'INVALID_OLD_CONTRIBUTION' } }] };
  await f.update({ items: [current] });
  assert.ok(document.body.textContent.includes(goalZh.goalContributionUnavailable));
  assert.equal(document.body.textContent.includes('INVALID_OLD_CONTRIBUTION'), false);
  assert.equal(f.calls.length, 0);
});

test('existing single dock contributes both read sources bound to its exact session and disposes them together', async t => {
  await domFixture(t); const ctx = new Context(), entries = [];
  class Slots extends Service {
    constructor(owner) { super(owner, 'slots'); }
    inject(_name, install) { return this.ctx.effect(install); }
    register(options, component) { const entry = { options, component }; entries.push(entry); return () => entries.splice(entries.indexOf(entry), 1); }
  }
  new Slots(ctx); const calls = [];
  ctx.provide('connection', { rpc: { async call(_channel, method, payload) {
    if (method === 'arcfoldDesktop/status') return { ok: true, value: { state: 'not_desktop' } };
    if (method === 'arcfoldMode/current') return { ok: true, value: { goalTreeV3: false } };
    calls.push({ method, request: payload.args.request });
    return { ok: true, value: { items: [], total: 0, nextOffset: null } }; } } });
  ctx.provide('fileUpload', { upload() { throw new Error('No upload expected in this fixture'); } });
  ctx.provide('locale', { register: () => () => {} }); t.after(() => ctx.fiber.dispose());
  const fiber = ctx.plugin(Client); await fiber.await(); assert.equal(entries.length, 4);
  assert.equal(entries.find(entry => entry.options.id === 'arcfold-models').options.name, 'settings.section');
  const face = entries.find(entry => entry.options.id === 'arcfold' && entry.options.name === 'conversation.view').options.inject('native-slot-session');
  assert.ok(face.hooks.methods); assert.ok(face.hooks.goals);
  await face.onGoalRefresh(); assert.equal(calls[0].request.sessionId, 'native-slot-session');
  await fiber.dispose(); assert.equal(entries.length, 0);
  await face.onGoalRefresh(); assert.equal(calls.length, 1);
});

test('goal same-id replacement before native prompt is failed and durable replay cannot attach to later input',async()=>{
  const f=businessFixture(),peer=browser();let current={id:'main',ctx:{}},sent=0;
  const agents={get:id=>id==='main'?current:undefined},agentPresets={composedPreset:()=> 'arcfold-main'};
  const handler=createGoalHandler({goals:f.goals,connection:{browserPeer:peer},agents,agentPresets,
    prompt(){sent++;return {accepted:true};}});
  f.hooks.onBind=()=>{current={id:'main',ctx:{}};};
  const result=await handler('discuss',submission(),live(),peer);
  assert.equal(result.value.binding.admission.state,'failed');assert.equal(sent,0);
  f.hooks.onBind=null;assert.equal((await handler('discuss',submission(),live(),peer)).value.created,false);assert.equal(sent,0);
});


test('one goal card contains work, progress and blockers without duplicate goal navigation or detail fetches', async t => {
  const related = { id: 'work-current', objective: '完整执行委托', phase: 'blocked', roundsStarted: 3, maxGoalRounds: 3,
    blockedReason: { code: 'round-limit', message: 'Goal reached its configured limit of 3 rounds.' },
    relation: { goalId: 'g1', state: 'current', reason: '整理主张与证据对照表' }, provenance: 'verified-native-delegation' };
  const initialDetail = { ...detail(), goal: { ...detail().goal, progress: { content: '已核对岗位要求。' } }, works: [related] };
  const f = await domFixture(t, { initialDetail, onGoalDetails: () => { throw new Error('No duplicate detail read'); } });
  await f.open();
  const card = document.querySelector('.goal-card');
  assert.equal(document.querySelectorAll('.goal-card').length, 1);
  assert.equal(document.querySelectorAll('.goal-work').length, 1);
  assert.ok(card.querySelector('.goal-work').textContent.includes(related.relation.reason));
  assert.ok(card.querySelector('.goal-progress').textContent.includes('已核对岗位要求。'));
  assert.ok(card.querySelector('.goal-work-blocker').textContent.includes(goalZh.goalBlockRoundLimit));
  assert.equal(f.buttons(goalZh.goalOpen).length, 0);
  assert.equal(f.buttons(goalZh.goalWorkReadGoal).length, 0);
  assert.equal(document.querySelector('nav'), null);
  assert.equal(document.querySelector('.goal-other-work'), null);
  await f.update({ works: [{ ...related, relation: { ...related.relation, state: 'needs_review' } }] });
  assert.equal(card.querySelector('.goal-work'), null);
  assert.ok(document.querySelector('.goal-other-work').textContent.includes(goalZh.goalWorkRelationReview));
  assert.equal(document.querySelectorAll('.goal-card').length, 1);
  assert.equal(f.calls.length, 0);
});

test('a changed goal preserves an unsent draft but cannot submit it against a different version silently', async t => {
  const f = await domFixture(t); await f.open(); await f.type('保留我的草稿');
  await f.update({ items: [detail(9)] });
  assert.equal(document.querySelector('textarea').value, '保留我的草稿');
  assert.equal(f.buttons(goalZh.goalDiscuss)[0].disabled, true);
  assert.ok(document.body.textContent.includes(goalZh.goalDraftChanged));
  await f.click(goalZh.goalDiscuss); assert.equal(f.calls.length, 0);
  await f.type('保留我的草稿，按新内容调整'); await f.click(goalZh.goalDiscuss);
  assert.equal(f.calls[0].value.expectedRevision, 9);
  await f.click(goalZh.goalHide); await f.click(goalZh.goalOpen);
  assert.equal(document.querySelector('textarea').value, '保留我的草稿，按新内容调整');
});
