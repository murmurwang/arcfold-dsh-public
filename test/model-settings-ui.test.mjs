// Local source/DOM and official credential wire checks; no live Web or model claims.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { CredentialsController } from '@deepseek-ai/dsh-api-settings-controller';
import { TYPERT_REMOTE } from '@deepseek-ai/dsh-api-settings-controller/remote';
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol';
import { installConnection } from '@deepseek-ai/dsh-client-connection/client';
import React, { act, useSyncExternalStore } from 'react';
import { JSDOM } from 'jsdom';
import { createModelSettingsSource } from '../packages/method-ui/src/model-settings-source.mjs';
import { ModelSettings } from '../packages/method-ui/src/ModelSettings.mjs';
import { modelsZh as copy, modelsEn as englishCopy } from '../packages/method-ui/src/model-settings-locales.mjs';
const clone = value => structuredClone(value);
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function data() {
  return { gate: { phase: 'ready', reason: null },
    main: { defaultSelection: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' }, availability: { available: true } },
    learning: { enabled: true, defaults: { revision: 1, provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'low' }, availability: { available: true } },
    routes: [
      { provider: 'deepseek-official', label: 'DeepSeek', apiKeyRef: 'DEPLOYED_DS_KEY',
        models: [{ id: 'deepseek-v4-pro', label: 'DeepSeek Pro', reasoningEfforts: ['low', 'high'] }],
        usage: { accounting: 'cny', scope: 'web-unlimited', requests: 3, unknownCount: 1, spentCny: 0.12, reservedCny: 0.03, ceilingCny: null } },
      { provider: 'openai', label: 'OpenAI', apiKeyRef: 'DEPLOYED_OA_KEY',
        models: [{ id: 'gpt-6-astra', label: 'GPT Astra', reasoningEfforts: ['low', 'high'] }],
        usage: { accounting: 'tokens_only', scope: 'web-openai', requests: 2, unknownCount: 1, promptTokens: 123, completionTokens: 45, cachedTokens: 67, pendingCount: 1 } },
    ] };
}
function fixture(t, overrides = {}) {
  const calls = [], resets = new Set(); let current = data();
  const rpc = { async call(channel, endpoint, payload, signal) {
    assert.equal(channel, '/api'); calls.push({ endpoint, payload: clone(payload), signal });
    if (overrides[endpoint]) return overrides[endpoint](payload, signal);
    if (endpoint === 'arcfoldModels/read') return { ok: true, value: clone(current) };
    if (endpoint === 'credentials/describe') return { ok: true, value: Object.fromEntries(payload.args.refs.map(ref =>
      [ref, { configured: true, writable: true, source: 'local', unexpectedSecret: 'must-not-be-retained' }])) };
    if (endpoint === 'arcfoldModels/saveLearning') {
      const request = payload.args.request;
      if (request.expectedRevision !== current.learning.defaults.revision)
        return { ok: false, error: { code: 'revision_conflict', message: 'raw error', details: {} } };
      current.learning.defaults = { revision: request.expectedRevision + 1, provider: request.provider,
        model: request.model, reasoningEffort: request.reasoningEffort };
    }
    return { ok: true };
  } };
  const source = createModelSettingsSource({ rpc, subscribeReset: fn => { resets.add(fn); return () => resets.delete(fn); } });
  t.after(() => source.dispose());
  return { source, calls, resets, setData(next) { current = clone(next); },
    async open() { const off = source.subscribe(() => {}); await tick(); return off; } };
}
const selection = (expectedRevision = 1) => ({ expectedRevision, provider: 'openai', model: 'gpt-6-astra', reasoningEffort: 'high' });

test('unopened and closed settings never read; active reads use no session and reconnect never mutates', async t => {
  const f = fixture(t);
  await f.source.refresh(); assert.equal(f.calls.length, 0);
  const off = await f.open();
  assert.deepEqual(f.calls.map(row => row.endpoint), ['arcfoldModels/read', 'credentials/describe']);
  assert.deepEqual(f.calls[0].payload, { args: { request: {} } });
  assert.deepEqual(f.calls[1].payload, { args: { refs: ['DEPLOYED_DS_KEY', 'DEPLOYED_OA_KEY'] } });
  assert.ok(!JSON.stringify(f.source.getSnapshot()).includes('must-not-be-retained'));
  for (const reset of f.resets) reset(); await tick();
  assert.equal(f.calls.length, 4); off();
  assert.equal(f.resets.size, 0); await f.source.refresh(); await tick(); assert.equal(f.calls.length, 4);
});

test('close and a newer read ignore obsolete results even when transport ignores cancellation', async t => {
  const first = deferred(), second = deferred(); let reads = 0;
  const f = fixture(t, { 'arcfoldModels/read': () => (++reads === 1 ? first.promise : second.promise) });
  const off = f.source.subscribe(() => {});
  const refresh = f.source.refresh();
  const next = data(); next.learning.defaults.revision = 9;
  second.resolve({ ok: true, value: next }); await refresh;
  first.resolve({ ok: true, value: data() }); await tick();
  assert.equal(f.source.getSnapshot().data.learning.defaults.revision, 9);
  off(); assert.equal(f.calls[0].signal.aborted, true);
  assert.equal(f.resets.size, 0);
});

test('learning saves only displayed revision and choice; stale writes refresh without retry; hidden controls refuse', async t => {
  const f = fixture(t); await f.open();
  assert.equal((await f.source.saveLearning(selection())).status, 'saved');
  assert.equal(f.source.getSnapshot().data.learning.defaults.revision, 2);
  assert.deepEqual(f.calls.find(row => row.endpoint.endsWith('/saveLearning')).payload, { args: { request: selection() } });
  assert.equal((await f.source.saveLearning(selection())).code, 'conflict');
  for (const request of [{ ...selection(2), maxTokens: 1 }, { ...selection(2), provider: 'other' }])
    assert.equal((await f.source.saveLearning(request)).status, 'refused');
  for (const reset of f.resets) reset(); await tick();
  assert.equal(f.calls.filter(row => row.endpoint.endsWith('/saveLearning')).length, 2);
});

test('known successful save with failed readback differs from an unknown write, and neither is resent', async t => {
  let readFail = false, unknown = false;
  const f = fixture(t, {
    'arcfoldModels/read': () => readFail ? Promise.reject(new Error('read failed')) : { ok: true, value: data() },
    'arcfoldModels/saveLearning': () => { if (unknown) throw new Error('transport lost'); readFail = true; return { ok: true }; },
  });
  await f.open();
  assert.deepEqual(await f.source.saveLearning(selection()), { status: 'saved', refreshed: false });
  readFail = false; await f.source.refresh(); unknown = true;
  assert.equal((await f.source.saveLearning(selection())).status, 'unknown');
  for (const reset of f.resets) reset(); await tick();
  assert.equal(f.calls.filter(row => row.endpoint.endsWith('/saveLearning')).length, 2);
});

test('official Connection plus generated codecs and actual CredentialsController accept exact credential wire', async t => {
  const ctx = new Context(), calls = [], records = new Map();
  t.after(() => ctx.fiber.dispose());
  ctx.provide('credentials', {
    describe: async ref => ({ configured: records.has(ref), writable: true, source: 'memory' }),
    set: async (ref, value) => { records.set(ref, value); }, unset: async ref => { records.delete(ref); },
  });
  const controller = new CredentialsController(ctx);
  installConnection(ctx, { interactions: 'none', location: { hostname: '127.0.0.1' }, transport: {
    async fetch(_route, init) {
      const envelope = JSON.parse(init.body); calls.push(envelope);
      let result;
      try {
        if (envelope.method === 'arcfoldModels/read') result = { ok: true, value: data() };
        else {
          const descriptor = TYPERT_REMOTE.methods[envelope.method];
          const args = descriptor.input({ strict: true }).create().parse(envelope.payload.args);
          result = { ok: true, value: await descriptor.invoke({ credentials: controller }, args) };
        }
      } catch (error) { result = { ok: false, error: remoteErrorOf(error) || { code: 'bad-wire', message: 'invalid wire', details: {} } }; }
      return new Response(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result }), { headers: { 'content-type': 'application/json' } });
    },
  } });
  const source = createModelSettingsSource({ rpc: ctx.connection.rpc, subscribeReset: () => () => {} });
  t.after(() => source.dispose()); source.subscribe(() => {}); await tick();
  assert.equal((await source.storeCredential('openai', 'fixture-only-key')).status, 'saved');
  assert.deepEqual(calls.find(row => row.method === 'credentials/set').payload, { args: { ref: 'DEPLOYED_OA_KEY', value: 'fixture-only-key' } });
  assert.equal(source.getSnapshot().credentials.DEPLOYED_OA_KEY.configured, true);
  assert.equal((await source.removeCredential('openai')).status, 'saved'); assert.equal(records.size, 0);
  assert.deepEqual(calls.find(row => row.method === 'credentials/unset').payload, { args: { ref: 'DEPLOYED_OA_KEY' } });
  assert.ok(!JSON.stringify(source.getSnapshot()).includes('fixture-only-key'));
});

test('no routes/defaults and disabled learning stay unavailable without invented credential refs', async t => {
  const f = fixture(t), next = data(); next.routes = []; next.learning = { enabled: false, defaults: null, availability: { available: false } };
  f.setData(next); await f.open();
  assert.equal((await f.source.saveLearning(selection())).status, 'refused');
  assert.equal((await f.source.storeCredential('openai', 'never-sent')).status, 'refused');
  assert.deepEqual(f.calls.map(row => row.endpoint), ['arcfoldModels/read']);
});

async function dom(t, f, labels = copy) {
  const documentHost = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1/' });
  const prior = Object.fromEntries(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, 'window', { value: documentHost.window, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'document', { value: documentHost.window.document, configurable: true, writable: true });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  const useModels = selector => selector(useSyncExternalStore(f.source.subscribe, f.source.getSnapshot));
  const props = { useModels, t: key => labels[key], onRefresh: f.source.refresh, onSaveLearning: f.source.saveLearning,
    onStoreCredential: f.source.storeCredential, onRemoveCredential: f.source.removeCredential };
  await act(async () => { root.render(React.createElement(ModelSettings, props)); await tick(); });
  t.after(async () => {
    await act(async () => root.unmount()); documentHost.window.close();
    for (const [key, descriptor] of Object.entries(prior)) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
  });
  return {
    async click(label, index = 0) {
      const button = [...document.querySelectorAll('button')].filter(node => node.textContent === label)[index];
      assert.ok(button, label); assert.equal(button.disabled, false, label);
      await act(async () => { button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await tick(); });
    },
    async change(node, value) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(node.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype, 'value').set.call(node, value);
        node.dispatchEvent(new window.Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
        await tick();
      });
    },
  };
}

test('settings DOM changes the three learning fields and preserves truthful scoped usage', async t => {
  const f = fixture(t), next = data();
  next.learning.availability = { available: false, reason: 'native-credential-not-configured' };
  f.setData(next);
  const ui = await dom(t, f);
  assert.ok(document.body.textContent.includes(copy.modelsReasonCredential));
  const selects = [...document.querySelectorAll('select')]; assert.equal(selects.length, 3);
  await ui.change(selects[0], 'openai'); assert.equal(selects[1].value, '');
  await ui.change(selects[1], 'gpt-6-astra'); assert.equal(selects[2].value, '');
  await ui.change(selects[2], 'high'); await ui.click(copy.modelsSave);
  assert.deepEqual(f.calls.find(row => row.endpoint.endsWith('/saveLearning')).payload.args.request, selection());
  assert.ok(document.body.textContent.includes(copy.modelsSaved));
  assert.ok(document.body.textContent.includes(copy.modelsMainScope));
  assert.ok(document.body.textContent.includes(copy.modelsScopeWeb));
  const openaiUsage = [...document.querySelectorAll('.model-card')].find(node => node.textContent.includes(copy.modelsPrompt));
  assert.ok(openaiUsage.textContent.includes('123')); assert.ok(!openaiUsage.textContent.includes('¥'));
  assert.equal(document.querySelectorAll('input[type=number]').length, 0);
});

test('stale DOM save reports refusal, reads newer choice and never resends without a new click', async t => {
  const f = fixture(t), ui = await dom(t, f);
  const next = data(); next.learning.defaults.revision = 4; f.setData(next);
  await ui.click(copy.modelsSave);
  assert.ok(document.body.textContent.includes(copy.modelsConflict));
  assert.ok(document.body.textContent.includes(copy.modelsRevision + ': 4'));
  await act(async () => { for (const reset of f.resets) reset(); await tick(); });
  assert.equal(f.calls.filter(row => row.endpoint.endsWith('/saveLearning')).length, 1);
});

test('credential error including supplied secret is never rendered/retained; input clears on submit and cancel', async t => {
  const secret = 'fixture-secret-must-never-display', response = deferred();
  const f = fixture(t, { 'credentials/set': () => response.promise }), ui = await dom(t, f);
  const input = document.querySelector('input[type=password]');
  await ui.change(input, secret);
  await ui.click(copy.modelsCredentialSave);
  assert.equal(input.value, '');
  await act(async () => { response.resolve({ ok: false, error: { code: secret, message: secret, details: { secret } } }); await tick(); });
  assert.ok(document.body.textContent.includes(copy.modelsCredentialFailed));
  assert.ok(!document.body.innerHTML.includes(secret)); assert.ok(!JSON.stringify(f.source.getSnapshot()).includes(secret));
  await ui.change(input, secret); await ui.click(copy.modelsCredentialCancel); assert.equal(input.value, '');
  await act(async () => { for (const reset of f.resets) reset(); await tick(); });
  assert.equal(f.calls.filter(row => row.endpoint === 'credentials/set').length, 1);
});

test('null usage, defaults and main default render as unavailable instead of zero or fallback', async t => {
  const f = fixture(t), next = data();
  next.main = { defaultSelection: null, availability: { available: false } };
  next.learning = { enabled: false, defaults: null, availability: { available: false } };
  next.routes.forEach(route => { route.usage = null; }); f.setData(next);
  await dom(t, f);
  assert.ok(document.body.textContent.includes(copy.modelsLearnDisabled));
  assert.ok(document.body.textContent.includes(copy.modelsUsageMissing));
  assert.equal([...document.querySelectorAll('button')].find(node => node.textContent === copy.modelsSave).disabled, true);
});

test('visible status/reason/effort labels are localized; unknown internals never reach the page', async t => {
  for (const [language, labels] of [['zh', copy], ['en', englishCopy]]) await t.test(language, async t => {
    const f = fixture(t); await dom(t, f, labels);
    const phases = [['ready', 'modelsPhaseReady'], ['starting', 'modelsPhaseStarting'],
      ['requires-restart', 'modelsPhaseRestart'], ['failed', 'modelsPhaseFailed'], ['closed', 'modelsPhaseClosed']];
    const reasons = [['main-not-configured', 'modelsReasonNoModel'], ['native-credential-not-configured', 'modelsReasonCredential'],
      ['selection-outside-model-policy', 'modelsReasonUnsupported'], ['learning-selection-changed-during-status', 'modelsReasonChanged'],
      ['runtime-not-ready', 'modelsReasonNotReady']];
    for (let index = 0; index < phases.length; index++) {
      const next = data(), [phase, phaseLabel] = phases[index], [reason, reasonLabel] = reasons[index];
      next.gate = { phase, reason };
      next.main.availability = next.learning.availability = { available: false, reason };
      f.setData(next); await act(async () => { await f.source.refresh(); });
      assert.ok(document.body.textContent.includes(labels[phaseLabel]));
      assert.ok(document.body.textContent.includes(labels[reasonLabel]));
      assert.ok(!document.body.textContent.includes(reason));
    }
    const unknown = data(); unknown.gate = { phase: 'INTERNAL_PHASE_ONLY', reason: 'INTERNAL_REASON_ONLY' };
    unknown.main.availability = unknown.learning.availability = { available: false, reason: 'INTERNAL_AVAILABILITY_ONLY' };
    f.setData(unknown); await act(async () => { await f.source.refresh(); });
    assert.ok(document.body.textContent.includes(labels.modelsReasonUnknown));
    assert.ok(!document.body.textContent.includes('INTERNAL_'));
    const efforts = [...document.querySelectorAll('select')][2];
    assert.equal(efforts.querySelector('option[value=low]').textContent, labels.modelsEffortLow);
    assert.equal(efforts.querySelector('option[value=high]').textContent, labels.modelsEffortHigh);
    assert.equal(efforts.value, 'low');
  });
});
