import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { CollaborationView, CollaborationHero } from '../packages/method-ui/src/CollaborationView.mjs';
import { zh } from '../packages/method-ui/src/locales.mjs';
import { goalZh } from '../packages/method-ui/src/goal-locales.mjs';
import { understandingZh } from '../packages/method-ui/src/understanding-locales.mjs';
import { importsZh } from '../packages/method-ui/src/import-locales.mjs';
import { opportunitiesZh } from '../packages/method-ui/src/opportunity-locales.mjs';
import { modelsZh } from '../packages/method-ui/src/model-settings-locales.mjs';

async function fixture(t) {
  const page = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' });
  const values = { window: page.window, document: page.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const prior = Object.fromEntries(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  // JSDOM does not implement native dialog behavior. This test covers content
  // and cancel handlers; installed browser checks cover focus/top-layer layout.
  page.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  page.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const { createRoot } = await import('react-dom/client'), root = createRoot(document.getElementById('root'));
  t.after(async () => {
    await act(() => root.unmount()); page.window.close();
    for (const [key, descriptor] of Object.entries(prior))
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
  });
  const copy = { ...zh, ...goalZh, ...understandingZh, ...importsZh, ...opportunitiesZh, ...modelsZh };
  const calls = [], reads = [];
  const state = { loading: false, error: null, total: 0, items: [], offset: 0, nextOffset: null,
    unreadCount: 0, notifications: [], notificationOffset: 0, notificationNextOffset: null, readEpoch: 0, resetVersion: 0 };
  const props = { t: key => { assert.ok(copy[key], key); return copy[key]; },
    opportunitySessionId: 'one', understandingSessionId: 'one', importSessionId: 'one',
    onModelsRefresh: async () => { calls.push('model-refresh'); },
    onRefresh: async () => { calls.push('method-refresh'); } };
  for (const name of ['Methods', 'Goals', 'Understandings', 'Imports', 'Opportunities'])
    props['use' + name] = select => { reads.push(name); return select(state); };
  props.useModels = select => { reads.push('Models'); return select({ loading: false, data: null, error: null }); };
  return { props, calls, reads, render: (component, overrides = {}) => act(async () => root.render(React.createElement(component, { ...props, ...overrides }))),
    click: async (label, scope = document) => {
      const button = [...scope.querySelectorAll('button')].find(node => node.textContent === label);
      assert.ok(button, label); await act(async () => button.click());
    },
    cancel: async () => act(async () => document.querySelector('dialog').dispatchEvent(new page.window.Event('cancel', { bubbles: false, cancelable: true }))),
  };
}

test('blank entry is compact, mounts shared content only on demand and uses one model dialog', async t => {
  const f = await fixture(t); await f.render(CollaborationHero);
  assert.equal(document.querySelectorAll('button').length, 2);
  assert.equal(document.querySelectorAll('section,dialog').length, 0);
  assert.deepEqual(f.reads, []); assert.deepEqual(f.calls, []);
  await f.click('Arcfold');
  assert.equal(document.querySelectorAll('dialog').length, 1);
  const labels = [...document.querySelectorAll('section.arcfold-methods')].map(node => node.getAttribute('aria-label'));
  assert.deepEqual(labels, [opportunitiesZh.opportunityTitle, zh.title, goalZh.goalTitle, understandingZh.understandingTitle, importsZh.importTitle]);
  for (const label of [opportunitiesZh.opportunityOpen, zh.open, goalZh.goalOpen, understandingZh.understandingOpen, importsZh.importOpen]) await f.click(label);
  assert.deepEqual(f.calls, []); // viewing never submits a business decision
  await f.click(modelsZh.modelsTitle);
  assert.equal(document.querySelectorAll('dialog').length, 1);
  assert.equal(document.querySelectorAll('.arcfold-model-settings').length, 1);
  assert.equal(document.querySelectorAll('section.arcfold-methods').length, 1);
  await f.click(modelsZh.modelsRefresh); assert.deepEqual(f.calls, ['model-refresh']);
  await f.cancel(); assert.equal(document.querySelectorAll('dialog').length, 0);
  await f.click(modelsZh.modelsTitle); assert.equal(document.querySelectorAll('.arcfold-model-settings').length, 1);
  await f.render(CollaborationHero, { opportunitySessionId: 'two', understandingSessionId: 'two', importSessionId: 'two' });
  assert.equal(document.querySelectorAll('dialog').length, 0);
});

test('existing tab reuses panels and resets expanded session details when session changes', async t => {
  const f = await fixture(t); await f.render(CollaborationView);
  assert.equal(document.querySelectorAll('section.arcfold-methods').length, 5);
  assert.equal(f.reads.includes('Models'), false);
  await f.click(understandingZh.understandingOpen);
  assert.ok(document.body.textContent.includes(understandingZh.understandingHide));
  await f.render(CollaborationView, { opportunitySessionId: 'two', understandingSessionId: 'two', importSessionId: 'two' });
  assert.ok(document.body.textContent.includes(understandingZh.understandingOpen));
  assert.ok(!document.body.textContent.includes(understandingZh.understandingHide));
  await f.click(modelsZh.modelsTitle); await f.click(modelsZh.modelsRefresh);
  assert.deepEqual(f.calls, ['model-refresh']);
  await f.cancel(); assert.equal(document.querySelectorAll('dialog').length, 0);
  assert.equal(document.querySelectorAll('section.arcfold-methods').length, 5);
});
