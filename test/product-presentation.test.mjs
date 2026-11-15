import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import * as Cordis from '@deepseek-ai/cordis';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import * as Client from '../packages/method-ui/src/client.mjs';
import { BrandMark, BrandName, installBrand } from '../packages/method-ui/src/Brand.mjs';
import { zh, en, presentationLabel } from '../packages/method-ui/src/locales.mjs';
import { goalZh, goalEn } from '../packages/method-ui/src/goal-locales.mjs';
import { understandingZh, understandingEn } from '../packages/method-ui/src/understanding-locales.mjs';
import { MethodDock } from '../packages/method-ui/src/MethodDock.mjs';
import { GoalDock } from '../packages/method-ui/src/GoalDock.mjs';
import { UnderstandingDock } from '../packages/method-ui/src/UnderstandingDock.mjs';

const require = createRequire(import.meta.url);
const holes = ['sidebar.brand.mark', 'sidebar.brand.name', 'conversation.hero.brand.mark'];
const BrandPlugin = { inject: ['slots'], apply: installBrand };
const dictionaries = { zh: { ...zh, ...goalZh, ...understandingZh }, en: { ...en, ...goalEn, ...understandingEn } };
const translate = language => key => { assert.ok(Object.hasOwn(dictionaries[language], key), key); return dictionaries[language][key]; };

async function realRegistry() {
  const source = fileURLToPath(new URL('./fixtures/dsh-ui-slots/', import.meta.url));
  const expected = {
    'index.ts': '43989fb355e1e85316caa70b28de3294f9d6e7b179199a4e429dcd1ef73f2e24',
    'renderer.ts': '43ba3492fff724ffbe71d0b4bcfca410ab695d019aa2e163d2c8dd56cab1a849',
    'store.ts': '4233ae32911848aa771910286e5f41b4c683e8c5b16da190935082ac4249cca0',
  };
  for (const [name, digest] of Object.entries(expected))
    assert.equal(createHash('sha256').update(readFileSync(join(source, name))).digest('hex'), digest);
  const built = await build({ entryPoints: [join(source, 'index.ts')], bundle: true, format: 'cjs', platform: 'node', write: false, metafile: true });
  assert.equal(Object.values(built.metafile.outputs).flatMap(row => row.imports).length, 0);
  const core = { exports: {} };
  runInNewContext(built.outputFiles[0].text, { module: core, exports: core.exports, queueMicrotask });
  let registration;
  runInNewContext(readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-renderer/client'), 'utf8'),
    { queueMicrotask, window: { __ModuleLoader__: { load(value) { registration = value; } } } });
  assert.equal(registration.id, '@deepseek-ai/dsh-client-ui-renderer');
  return registration.factory(name => {
    if (name === '@deepseek-ai/dsh-client-ui-slots') return core.exports;
    if (name === '@deepseek-ai/cordis') return Cordis;
    assert.ok(['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'].includes(name), name);
    return require(name);
  }).SlotRegistry;
}

test('actual official slots wait for declarations, reattach once and retract on unload', async t => {
  const Registry = await realRegistry();
  const ctx = new Cordis.Context(); t.after(() => ctx.fiber.dispose());
  await ctx.plugin(Registry).await();
  const slots = ctx.get('slots');
  const fiber = ctx.plugin(BrandPlugin); await fiber.await();
  const count = expected => { for (const name of holes) assert.equal(slots.entries(name).length, expected, name); };
  count(0);
  const declare = () => slots.register({ name: 'root', children: Object.fromEntries(holes.map(name => [name, { kind: 'single', scope: 'root' }])) }, () => null);
  const retract = declare(); await Promise.resolve(); count(1);
  let duplicate;
  await assert.rejects(async () => { duplicate = ctx.plugin(BrandPlugin); await duplicate.await(); }, /already has a registration/);
  await duplicate?.dispose(); count(1);
  retract(); await Promise.resolve(); count(0);
  const retractAgain = declare(); await Promise.resolve(); count(1);
  await fiber.dispose(); count(0);
  retractAgain();
  const next = ctx.plugin(BrandPlugin); await next.await(); count(0);
  const last = declare(); await Promise.resolve(); count(1);
  await next.dispose(); count(0); last();
});

async function dom(t) {
  const page = new JSDOM('<!doctype html><html><head><title>Native title</title></head><body><div id="app"></div></body></html>', { url: 'http://localhost/' });
  const names = ['window','document','HTMLElement','IS_REACT_ACT_ENVIRONMENT'];
  const prior = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries({ window: page.window, document: page.window.document, HTMLElement: page.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true }))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('app'));
  t.after(async () => { await act(() => root.unmount()); page.window.close(); for (const name of names) {
    const descriptor = prior.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
  } });
  return { render: element => act(async () => { root.render(element); }), click: async (label, index = 0) => {
    const button = [...document.querySelectorAll('button')].filter(node => node.textContent === label)[index];
    assert.ok(button, label); await act(async () => { button.click(); });
  } };
}

test('marks respect native 24/34 sizes, theme color and class without owning navigation or title', async t => {
  const f = await dom(t);
  await f.render(React.createElement(React.Fragment, null,
    React.createElement(BrandMark, { size: 24, className: 'native-sidebar' }),
    React.createElement(BrandName), React.createElement(BrandMark, { size: 34, className: 'native-hero' })));
  const marks = [...document.querySelectorAll('svg')];
  assert.deepEqual(marks.map(mark => [mark.getAttribute('width'), mark.getAttribute('height')]), [['24','24'],['34','34']]);
  assert.equal(marks[1].getAttribute('class'), 'native-hero');
  assert.equal(marks[0].querySelector('path').getAttribute('stroke'), 'currentColor');
  assert.equal(document.querySelectorAll('button,a').length, 0);
  assert.equal(document.body.textContent, 'Arcfold');
  assert.equal(document.title, 'Native title');
});

test('finite labels work in both native locales and unknown values never masquerade as known state', () => {
  for (const language of ['zh', 'en']) {
    const t = translate(language);
    for (const [group, value] of [['method','paused'],['adoption','reserved'],['role','program'],['outcome','completed'],['admission','accepted'],['understandingAction','correct'],['understanding','withdrawn'],['goal','tracking'],['relation','derived_from'],['claim','user_statement']])
      assert.notEqual(presentationLabel(group, value, t), t('presentationUnknown'));
    for (const value of ['unrecognized-internal-code', '__proto__', 'constructor', undefined])
      assert.equal(presentationLabel('method', value, t), t('presentationUnknown'));
    assert.equal(presentationLabel('claim', 'new-kind', t), t('presentationUnknown'));
  }
});

test('rendered cards translate state only and keep authored text, reasons, notices and identity exact', async t => {
  const f = await dom(t), tr = translate('zh');
  const original = '原话 paused / completed <img src=x onerror=bad()> & 引号“保留”';
  const method = { id: 'm-original', revision: 2, version: 1, status: 'paused', title: '方法原题',
    guidance: original, appliesTo: original, doesNotApplyTo: original };
  const detail = { method, contentHash: 'h', reason: original, usage: { trialUses: 2, maxTrialUses: 3, remaining: 1 },
    pendingAdoptionCount: 1, pendingAdoptions: [{ id:'adopt', sessionId:'session', turn:1, state:'reserved' }],
    sources: [{ id:'source-original', revision:1, role:'user', content:original, provenance:{kind:'user'} }],
    successors: [], activation: { allowed:false, message:original },
    notifications: { items:[{id:'notice',title:'原历史标题',message:original,reason:'unchanged-reason',status:'read'}],
      total:1,unreadCount:0,offset:0,nextOffset:null } };
  const originalNotice = JSON.stringify(detail.notifications.items[0]);
  await f.render(React.createElement(MethodDock, { t:tr, useMethods:fn=>fn({ total:1,decisionCount:0,unreadCount:0,items:[detail],offset:0,nextOffset:null }),
    onDetails:async()=>detail,onRefresh:async()=>{},onPage:async()=>{} }));
  await f.click(zh.open); await f.click(zh.viewDetails);
  assert.ok(document.querySelector('article').textContent.includes('状态 已暂停'));
  assert.ok(document.body.textContent.includes('已领取，待核对'));
  assert.ok(document.body.textContent.includes('作者角色: 用户'));
  assert.ok([...document.querySelectorAll('.text')].some(node=>node.textContent===original));
  const history = document.querySelector('details[aria-label="' + zh.history + '"]');
  assert.equal(history.open, false);
  assert.ok(history.textContent.includes('原历史标题'));
  assert.equal(history.querySelector('.text').textContent, original);
  assert.equal(JSON.stringify(detail.notifications.items[0]), originalNotice);
  assert.equal(document.querySelectorAll('img').length,0);

  const goalDetail = { goal:{id:'g',revision:1,definitionVersion:1,status:'tracking',title:'目标原题',outcome:original},
    availability:{allowed:true},controls:{resumeAllowed:false},sources:[],relations:[],
    links:[{id:'link',sessionId:'session',turn:1,definitionVersion:1,outcome:{outcome:'completed'},contribution:{available:true,reason:original}}],
    discussions:[{id:'discussion',requestId:'request-original',admission:{state:'accepted'},content:[{type:'text',text:original}]}] };
  await f.render(React.createElement(GoalDock,{t:tr,useGoals:fn=>fn({total:1,items:[goalDetail],offset:0,nextOffset:null,canDiscuss:false}),
    onGoalDetails:async()=>goalDetail,onGoalRefresh:async()=>{},onGoalPage:async()=>{} }));
  await f.click(goalZh.goalOpen);
  assert.equal(document.querySelectorAll('.goal-card').length, 1);
  assert.equal([...document.querySelectorAll('.goal-card button')].some(node => node.textContent === goalZh.goalOpen || node.textContent === goalZh.goalWorkReadGoal), false);
  assert.ok(document.body.textContent.includes('本轮已完成'));
  assert.ok(document.body.textContent.includes('原生入口已受理'));
  assert.ok(document.querySelector('.goal-card-evidence').textContent.includes('request-original'));
  assert.ok([...document.querySelectorAll('.text')].some(node=>node.textContent===original));

  const understanding = { understanding:{id:'u',revision:1,version:1,status:'withdrawn',claimType:'inference',content:original},
    availability:{allowed:false,message:original},controls:{},sources:[{id:'source-original',revision:1,role:'user',author:'原作者姓名',available:false,content:original}],
    successors:[],commands:[{id:'c',action:'correct',requestId:'request-original',admission:{state:'unknown'},request:{text:original}}] };
  await f.render(React.createElement(UnderstandingDock,{t:tr,useUnderstandings:fn=>fn({total:1,items:[understanding],offset:0,nextOffset:null}),
    onUnderstandingDetails:async()=>understanding,onUnderstandingRefresh:async()=>{},onUnderstandingPage:async()=>{} }));
  await f.click(understandingZh.understandingOpen); await f.click(understandingZh.understandingOpen);
  assert.ok(document.body.textContent.includes('已停止采用'));
  assert.ok(document.body.textContent.includes('提交逐字纠正'));
  assert.ok(document.body.textContent.includes('提交结果未知'));
  assert.ok(document.body.textContent.includes('原作者姓名'));
  assert.ok(document.body.textContent.includes(original));
  assert.equal(document.querySelectorAll('img').length,0);
});

test('official conversation registrations share sources, preserve trajectory, and survive tab remounts', async t => {
  await dom(t);
  const Registry = await realRegistry(), ctx = new Cordis.Context(), calls = [];
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(Registry).await();
  const slots = ctx.get('slots');
  ctx.provide('locale', { register: () => () => {}, bind: () => key => key });
  ctx.provide('fileUpload', { upload() { throw new Error('Browsing must not upload'); } });
  ctx.provide('connection', { rpc: { async call(_channel, method, payload) {
    if (method === 'arcfoldDesktop/status') return { ok: true, value: { state: 'not_desktop' } };
    if (method === 'arcfoldMode/current') return { ok: true, value: { goalTreeV3: false } };
    calls.push({ method, request: payload.args.request });
    return { ok: true, value: { items: [], total: 0, nextOffset: null } };
  } } });
  const fiber = ctx.plugin(Client); await fiber.await();
  assert.equal(slots.entries('conversation.view').length, 0);
  const declarations = { ...Object.fromEntries(holes.map(name => [name, { kind: 'single', scope: 'root' }])),
    'settings.section': { kind: 'list', scope: 'root' },
    'conversation.view': { kind: 'list', scope: 'session' },
    'conversation.hero.options': { kind: 'list', scope: 'session' },
    'conversation.input.dock': { kind: 'list', scope: 'session' } };
  const retract = slots.register({ name: 'root', children: declarations }, () => null);
  await Promise.resolve();
  const trajectory = slots.register({ name: 'conversation.view', id: 'trajectory', order: 10 }, () => null);
  assert.deepEqual(Array.from(slots.entries('conversation.view'), row => row.options.id), ['trajectory', 'arcfold']);
  const nativeGoal = () => 'native goal control';
  const retractNativeGoal = slots.register({ name: 'conversation.input.dock', id: 'goal', order: 10 }, nativeGoal);
  const goalEntries = slots.entries('conversation.input.dock');
  assert.equal(goalEntries.length, 2, 'The original native registration remains available');
  const selectedGoal = slots.entriesOfSlot('conversation.input.dock');
  assert.equal(selectedGoal.length, 1);
  assert.equal(selectedGoal[0].options.priority, -1);
  assert.equal(selectedGoal[0].component(), null, 'Only the composer control is removed through the native slot contract');
  const view = slots.entries('conversation.view').find(row => row.options.id === 'arcfold');
  const hero = slots.entries('conversation.hero.options')[0], settings = slots.entries('settings.section')[0];
  const first = view.inject('session-a'), blank = hero.inject('session-a'), second = view.inject('session-b');
  assert.equal(first, blank);
  assert.equal(first.hooks.models, settings.inject().hooks.models);
  assert.equal(second.hooks.models, first.hooks.models);
  assert.notEqual(first.hooks.goals, second.hooks.goals);
  assert.equal(calls.length, 0);
  const off = first.hooks.goals.subscribe(() => {}); await Promise.resolve();
  assert.deepEqual(calls.map(row => row.request.sessionId), ['session-a']);
  off();
  const offAgain = blank.hooks.goals.subscribe(() => {}); await Promise.resolve(); offAgain();
  assert.deepEqual(calls.map(row => row.request.sessionId), ['session-a', 'session-a']);
  const offSecond = second.hooks.goals.subscribe(() => {}); await Promise.resolve(); offSecond();
  assert.equal(calls.at(-1).request.sessionId, 'session-b');
  assert.ok(calls.every(row => row.method === 'arcfoldGoals/list'));
  await fiber.dispose();
  assert.equal(slots.entriesOfSlot('conversation.input.dock')[0].component, nativeGoal,
    'Removing Arcfold restores the original native goal control');
  assert.deepEqual(Array.from(slots.entries('conversation.view'), row => row.options.id), ['trajectory']);
  assert.equal(slots.entries('conversation.hero.options').length, 0);
  const count = calls.length, disposed = first.hooks.goals.subscribe(() => {});
  await first.onGoalRefresh(); disposed(); assert.equal(calls.length, count);
  retractNativeGoal(); trajectory(); retract();
});
