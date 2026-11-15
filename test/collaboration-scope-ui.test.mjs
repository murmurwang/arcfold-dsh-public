import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act, useSyncExternalStore } from 'react';
import { JSDOM } from 'jsdom';
import { createBrowseScopeSource } from '../packages/method-ui/src/browse-source.mjs';
import { createMethodSource } from '../packages/method-ui/src/method-source.mjs';
import { createGoalSource } from '../packages/method-ui/src/goal-source.mjs';
import { createUnderstandingSource } from '../packages/method-ui/src/understanding-source.mjs';
import { createOpportunitySource } from '../packages/method-ui/src/opportunity-source.mjs';
import { createImportSource } from '../packages/method-ui/src/import-source.mjs';
import { CollaborationView } from '../packages/method-ui/src/CollaborationView.mjs';
import { GoalDock } from '../packages/method-ui/src/GoalDock.mjs';
import { zh } from '../packages/method-ui/src/locales.mjs';
import { goalZh } from '../packages/method-ui/src/goal-locales.mjs';
import { understandingZh } from '../packages/method-ui/src/understanding-locales.mjs';
import { importsZh } from '../packages/method-ui/src/import-locales.mjs';
import { opportunitiesZh } from '../packages/method-ui/src/opportunity-locales.mjs';
import { modelsZh } from '../packages/method-ui/src/model-settings-locales.mjs';

const factories = { methods: createMethodSource, goals: createGoalSource, understandings: createUnderstandingSource,
  opportunities: createOpportunitySource, imports: createImportSource };
const result = value => ({ ok: true, value });
const page = item => ({ items: item ? [item] : [], total: item ? 1 : 0, works: [], decisionCount: 0, unreadCount: 0, nextOffset: null });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const details = (name, source) => source.details(name === 'imports' ? { batchId: 'record' } : 'record');
const create = (name, rpc, extra = {}) => factories[name]({ rpc, sessionId: 'chat-a', viewScope: 'all',
  intervalMs: 60000, subscribeReset: () => () => {}, ...extra });

for (const name of Object.keys(factories)) {
  test(`${name}: scope switch clears the previous page and rejects late list and detail reads`, async t => {
    const reads = [];
    const source = create(name, { call(channel, method, payload, signal) {
      const pending = deferred(); reads.push({ method, request: payload.args.request, signal, ...pending }); return pending.promise;
    } });
    t.after(() => source.dispose());
    const first = source.refresh(20), oldDetail = details(name, source);
    const rejectedDetail = assert.rejects(oldDetail);
    assert.equal(reads[0].request.viewScope, 'all');
    assert.equal(reads[0].request.sessionId, 'chat-a');
    assert.equal(reads[1].request.viewScope, 'all');
    source.setViewScope('current');
    assert.equal(source.getSnapshot().offset, 0);
    assert.deepEqual(source.getSnapshot().items, []);
    assert.equal(source.getSnapshot().loading, true);
    assert.equal(reads[0].signal.aborted, true);
    assert.equal(reads[1].signal.aborted, true);
    const next = source.refresh();
    assert.equal(reads[2].request.viewScope, 'current');
    assert.equal(reads[2].request.offset, 0);
    reads[2].resolve(result(page({ id: 'current' }))); await next;
    reads[0].resolve(result(page({ id: 'obsolete' }))); reads[1].resolve(result({ id: 'obsolete-detail' }));
    await Promise.all([first, rejectedDetail]);
    assert.deepEqual(source.getSnapshot().items, [{ id: 'current' }]);
    assert.throws(() => source.setViewScope('other'), TypeError);
    assert.throws(() => source.setViewScope(undefined), TypeError);
  });
}

test('the shared selector defaults to all; hidden sources reset without requests and keep writes unchanged', async t => {
  const calls = [], resets = new Set(), sources = new Set();
  const rpc = { async call(_channel, method, payload) {
    calls.push({ method, request: payload.args.request }); return result(page());
  } };
  const caches = Object.fromEntries(Object.keys(factories).map(name => {
    const source = create(name, rpc, { subscribeReset: listener => { resets.add(listener); return () => resets.delete(listener); } });
    sources.add(source); return [name, source];
  }));
  const browse = createBrowseScopeSource(sources); t.after(() => { browse.dispose(); for (const source of sources) source.dispose(); });
  assert.equal(browse.getSnapshot().viewScope, 'all');
  const stops = [...sources].map(source => source.subscribe(() => {}));
  await Promise.all([...sources].map(source => source.refresh(20)));
  const start = calls.length; browse.setViewScope('current'); await Promise.resolve();
  assert.equal(calls.length - start, 5);
  assert.ok(calls.slice(start).every(row => row.request.viewScope === 'current' && row.request.offset === 0));
  for (const reset of resets) reset(); await Promise.resolve();
  assert.ok(calls.slice(-5).every(row => row.request.viewScope === 'current' && row.request.offset === 0));
  stops.forEach(stop => stop());
  const stoppedCalls = calls.length; browse.setViewScope('all');
  assert.equal(calls.length, stoppedCalls);
  const off = caches.goals.subscribe(() => {}); await Promise.resolve(); off();
  assert.equal(calls.at(-1).request.viewScope, 'all');

  await caches.methods.decide({ requestId: 'method-choice' });
  await caches.goals.discuss({ requestId: 'goal-discussion' });
  await caches.understandings.correct({ requestId: 'understanding-correction' });
  await caches.opportunities.act('continue', { requestId: 'opportunity-continuation' });
  await caches.imports.confirm({ requestId: 'import-confirmation' });
  const writes = calls.filter(row => row.request.requestId);
  assert.equal(writes.length, 5);
  assert.ok(writes.every(row => !Object.hasOwn(row.request, 'viewScope')));
  assert.ok(writes.filter(row => !row.method.startsWith('arcfoldMethods/')).every(row => row.request.sessionId === 'chat-a'));
});

test('import capability waits for explicit owner reads and legacy reconnects keep their original behavior', async t => {
  for (const viewScope of ['all', undefined]) {
    let reset;
    const source = create('imports', { async call() { return result({ ...page(),
      ...(viewScope === undefined ? {} : { canImport: true }) }); } },
      { viewScope, subscribeReset: callback => { reset = callback; return () => {}; } });
    t.after(() => source.dispose());
    assert.equal(source.getSnapshot().canImport, viewScope === undefined ? undefined : false);
    const stop = source.subscribe(() => {}); await source.refresh();
    assert.equal(source.getSnapshot().canImport, viewScope === undefined ? undefined : true);
    reset();
    assert.equal(source.getSnapshot().canImport, viewScope === undefined ? undefined : false);
    await source.refresh();
    assert.equal(source.getSnapshot().canImport, viewScope === undefined ? undefined : true);
    stop();
  }
});

test('legacy source callers omit viewScope and methods keep their existing unscoped payload', async t => {
  const calls = [], sources = [];
  const rpc = { async call(_channel, method, payload) { calls.push({ method, request: payload.args.request }); return result(page()); } };
  for (const name of Object.keys(factories)) { const source = create(name, rpc, { viewScope: undefined }); sources.push(source); await source.refresh(); await details(name, source); }
  t.after(() => sources.forEach(source => source.dispose()));
  assert.ok(calls.every(row => !Object.hasOwn(row.request, 'viewScope')));
  assert.deepEqual(calls[0].request, { offset: 0, limit: 20 });
});

async function uiDom(t) {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'http://localhost/' });
  const prior = new Map(['window', 'document', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true }))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client'); const root = createRoot(document.getElementById('app'));
  t.after(async () => {
    await act(() => root.unmount()); dom.window.close();
    for (const [name, descriptor] of prior) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; }
  });
  return { dom, root };
}

test('the visible selector switches read scope and drops open detail state', async t => {
  const { root } = await uiDom(t);
  const scope = createBrowseScopeSource(new Set()), changes = []; t.after(() => scope.dispose());
  const empty = { ...page(), offset: 0, loading: false, readEpoch: 0, resetVersion: 0 };
  const dictionary = { ...zh, ...goalZh, ...understandingZh, ...importsZh, ...opportunitiesZh, ...modelsZh };
  const tLabel = key => { assert.ok(Object.hasOwn(dictionary, key), key); return dictionary[key]; };
  const props = { t: tLabel, opportunitySessionId: 'chat-a',
    useBrowseScope: selector => selector(useSyncExternalStore(scope.subscribe, scope.getSnapshot)),
    onViewScopeChange: value => { changes.push(value); scope.setViewScope(value); },
    useGoals: selector => selector(empty), useMethods: selector => selector(empty), useUnderstandings: selector => selector(empty),
    useImports: selector => selector(empty), useOpportunities: selector => selector(empty) };
  const click = async label => {
    const button = [...document.querySelectorAll('button')].find(node => node.textContent === label);
    assert.ok(button, label); await act(() => button.click());
  };
  await act(() => root.render(React.createElement(CollaborationView, props)));
  assert.equal(document.querySelector('.arcfold-view-scope [aria-pressed="true"]').textContent, zh.collaborationAll);
  await click(goalZh.goalOpen);
  assert.equal(document.querySelector('.arcfold-goals .detail').hidden, false);
  await click(zh.collaborationCurrent);
  assert.deepEqual(changes, ['current']);
  assert.equal(document.querySelector('.arcfold-view-scope [aria-pressed="true"]').textContent, zh.collaborationCurrent);
  assert.equal(document.querySelector('.arcfold-goals .detail').hidden, true);
  await click(goalZh.goalOpen);
  await act(() => root.render(React.createElement(CollaborationView, { ...props, opportunitySessionId: 'chat-b' })));
  assert.equal(document.querySelector('.arcfold-goals .detail').hidden, true);
  assert.equal(document.querySelector('.arcfold-view-scope [aria-pressed="true"]').textContent, zh.collaborationCurrent);
  await click(zh.collaborationAll);
  assert.equal(document.querySelector('.arcfold-view-scope [aria-pressed="true"]').textContent, zh.collaborationAll);
});

test('goal reconnect keeps an unsent discussion and a changed revision blocks its submission', async t => {
  const { root, dom } = await uiDom(t), resets = new Set(), response = deferred();
  const row = { goal: { id: 'goal', revision: 1, definitionVersion: 1, title: '长期目标', outcome: '形成可核对的成果', status: 'tracking' },
    availability: { allowed: true }, controls: { resumeAllowed: false }, sources: [], relations: [], links: [], works: [] };
  let calls = 0, submitted = 0;
  const source = create('goals', { call() {
    calls++; return calls === 1 ? Promise.resolve(result({ ...page(row), canDiscuss: true })) : response.promise;
  } }, { subscribeReset: listener => { resets.add(listener); return () => resets.delete(listener); } });
  t.after(() => source.dispose());
  const props = { t: key => ({ ...zh, ...goalZh })[key],
    useGoals: selector => selector(useSyncExternalStore(source.subscribe, source.getSnapshot)),
    onGoalDiscuss: async () => { submitted++; }, onGoalRefresh: () => source.refresh(), onGoalPage: offset => source.refresh(offset) };
  await act(async () => root.render(React.createElement(GoalDock, props)));
  const button = label => [...document.querySelectorAll('button')].find(node => node.textContent === label);
  await act(() => button(goalZh.goalOpen).click());
  const field = document.querySelector('textarea');
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set.call(field, '保留未发送的目标讨论');
    field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  assert.equal(button(goalZh.goalDiscuss).disabled, false);
  await act(() => { for (const reset of resets) reset(); });
  assert.equal(document.querySelector('textarea'), field);
  assert.equal(field.value, '保留未发送的目标讨论');
  assert.equal(source.getSnapshot().loading, true);
  await act(async () => response.resolve(result({ ...page({ ...row, goal: { ...row.goal, revision: 2 } }), canDiscuss: true })));
  assert.equal(document.querySelector('textarea'), field);
  assert.equal(field.value, '保留未发送的目标讨论');
  assert.equal(button(goalZh.goalDiscuss).disabled, true);
  assert.equal(submitted, 0);
});
