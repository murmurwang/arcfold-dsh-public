import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import * as Cordis from '@deepseek-ai/cordis';
import React from 'react';
import * as ReactDOM from 'react-dom';
import * as JSX from 'react/jsx-runtime';
import { watchNativeModelReadback, installNativeModelReadback } from '../packages/method-ui/src/native-model-readback.mjs';

const require = createRequire(import.meta.url);
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
// Only the observable store/transport are test doubles. Selection and the
// baseline receiver/seq arbitration below execute the installed DSH client code.
function store(initial) {
  let state = initial;
  const listeners = new Set();
  const api = { getSnapshot: () => state, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    set(next) { state = next; for (const fn of [...listeners]) fn(); },
    update(fn) { const next = { ...state }; fn(next); api.set(next); } };
  return api;
}
function nativeClient(name, expose = '') {
  let module;
  const path = join(dirname(require.resolve(name + '/package.json')), 'lib/client.js');
  const source = readFileSync(path, 'utf8').replace('return module.exports;', expose + '\nreturn module.exports;');
  runInNewContext(source, { window: { __ModuleLoader__: { load: row => { module = row; } } },
    console, queueMicrotask, setTimeout, clearTimeout, AbortController });
  return module.factory(id => {
    if (id === '@deepseek-ai/cordis') return Cordis;
    if (id === '@deepseek-ai/dsh-client-store') return { createSnapshotStore: store,
      notifySubscribers: listeners => { for (const fn of [...listeners]) fn(); } };
    if (id === '@deepseek-ai/dsh-api-gateway/client') return { RemoteJournalStream: class {}, RemoteSnapshotStream: class {} };
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {};
    if (id === 'react') return React;
    if (id === 'react-dom') return ReactDOM;
    if (id === 'react/jsx-runtime') return JSX;
    throw new Error('Unexpected native client dependency: ' + id);
  });
}
const { TestSessionManager } = nativeClient('@deepseek-ai/dsh-api-session-controller', 'exports.TestSessionManager = SessionManager;');
const { ModelDirectory } = nativeClient('@deepseek-ai/dsh-client-ui-model-selection');
const old = { provider: 'synthetic-old', model: 'old' };
const next = { provider: 'synthetic-new', model: 'new', reasoningEffort: 'medium' };
const newer = { provider: 'synthetic-new', model: 'later', reasoningEffort: 'high' };
function fixture(t, { select, projections, watch = true } = {}) {
  let seq = 24, values = { modelSelection: { next: old, lastUsed: old }, agentPreset: 'arcfold-main' }, bound;
  const calls = [], errors = [], generation = store(1), manager = new TestSessionManager({});
  const remote = {
    async selectModel(request) {
      if (select) return select(request);
      const { sessionId, ...choice } = request;
      values = { modelSelection: { next: choice, lastUsed: old }, agentPreset: 'arcfold-main' }; seq++;
      return { ok: true, value: { selected: choice } };
    },
    async projections(request, signal) {
      const result = { ok: true, value: { kind: 'sequenced', asOfSeq: seq, values } };
      calls.push({ request, signal }); return projections ? projections(result, calls.length) : result;
    },
  };
  manager.handleControlFrame({ type: 'baseline', value: { projections: { main: { asOfSeq: seq, values } } } });
  const projected = manager.projectionStore('main').faceOf('modelSelection');
  bound = { session: { projections: manager.projectionStore('main') } };
  const catalog = { store: store({ status: 'ready', value: { default: old, groups: [
    { id: old.provider, models: [{ id: old.model }] }, { id: next.provider, models: [{ id: next.model }, { id: newer.model }] },
  ] }, error: null }), reasoningFor: () => undefined, load: async () => {} };
  const directory = new ModelDirectory(remote, 'main', () => true, catalog, projected, () => false);
  const binding = bound;
  const sessions = { binding: () => bound, handleControlFrame: frame => manager.handleControlFrame(frame) };
  const stop = watch ? watchNativeModelReadback({ directory, sessionId: 'main', sessions, remote, generation,
    isCurrent: () => bound === binding, onError: code => errors.push(code) }) : () => {};
  t.after(() => { stop(); directory.dispose(); });
  return { directory, manager, projected, remote, sessions, generation, calls, errors, stop,
    unbind: () => { bound = undefined; }, binding,
    push(choice, seq = 40) { manager.handleControlFrame({ type: 'projection', sessionId: 'main', seq,
      changes: [{ key: 'modelSelection', val: { next: choice, lastUsed: old } }] }); } };
}

test('native client reproduces saved selection with stale UI; success readback repairs its actual shared projection', async t => {
  const original = fixture(t, { watch: false });
  assert.equal((await original.directory.select(next)).ok, true); await tick();
  assert.equal(original.directory.store.getSnapshot().current.model, old.model);
  const f = fixture(t);
  await f.directory.select(next); await tick();
  assert.deepEqual(f.calls.map(c => c.request), [{ sessionId: 'main' }]);
  assert.equal(f.directory.store.getSnapshot().current.model, next.model);
  assert.equal(f.projected.getSnapshot().next.reasoningEffort, 'medium');
  assert.equal(f.manager.projectionStore('main').seqOf('modelSelection'), 25);
  await f.directory.load(); await tick(); assert.equal(f.calls.length, 1, 'ready notifications are not new selections');
});

test('failed native selection and initial ready state never trigger readback', async t => {
  const f = fixture(t, { select: async () => ({ ok: false, error: { code: 'session/agent-busy', message: 'busy' } }) });
  await f.directory.load(); assert.equal(f.calls.length, 0);
  assert.equal((await f.directory.select(next)).ok, false); await tick();
  assert.equal(f.calls.length, 0); assert.equal(f.directory.store.getSnapshot().status, 'error');
});

test('native receiver rejects a late readback older than a live pushed selection', async t => {
  const read = deferred(), f = fixture(t, { projections: result => { read.result = result; return read.promise; } });
  await f.directory.select(next); f.push(newer, 40); await tick();
  read.resolve(read.result); await tick();
  assert.equal(f.directory.store.getSnapshot().current.model, newer.model);
  assert.equal(f.manager.projectionStore('main').seqOf('modelSelection'), 40);
});

test('a newer selection aborts an old read even when the transport delivers its reply later', async t => {
  const reads = [deferred(), deferred()];
  const f = fixture(t, { projections: (result, n) => { reads[n - 1].result = result; return reads[n - 1].promise; } });
  await f.directory.select(next); await f.directory.select(newer);
  assert.equal(f.calls[0].signal.aborted, true); reads[1].resolve(reads[1].result); await tick();
  reads[0].resolve(reads[0].result); await tick();
  assert.equal(f.directory.store.getSnapshot().current.model, newer.model); assert.equal(f.calls.length, 2);
});

for (const reason of ['generation', 'binding', 'dispose']) test(reason + ' change discards a late readback', async t => {
  const read = deferred(), f = fixture(t, { projections: result => { read.result = result; return read.promise; } });
  await f.directory.select(next);
  if (reason === 'generation') f.generation.set(2);
  if (reason === 'binding') f.unbind();
  if (reason === 'dispose') f.stop();
  read.resolve(read.result); await tick();
  assert.equal(f.projected.getSnapshot().next.model, old.model);
  assert.deepEqual(f.errors, []);
});

test('reset while native selection is pending cannot be mistaken for success', async t => {
  const selected = deferred(), f = fixture(t, { select: () => selected.promise });
  const operation = f.directory.select(next);
  f.directory.resetConnected(); f.generation.set(2);
  selected.resolve({ ok: true, value: {} }); await operation; await tick();
  assert.equal(f.calls.length, 0);
});

for (const failure of ['error', 'missing', 'unsequenced']) test(failure + ' readback preserves the real view and reports one fixed diagnostic', async t => {
  const f = fixture(t, { projections: async () => {
    if (failure === 'error') throw new Error('synthetic-secret-not-for-diagnostics');
    if (failure === 'missing') return { ok: false, error: { code: 'unavailable' } };
    return { ok: true, value: { kind: 'migration-required', values: { modelSelection: { next } } } };
  } });
  await f.directory.select(next); await tick();
  assert.equal(f.directory.store.getSnapshot().current.model, old.model);
  assert.deepEqual(f.errors, ['NATIVE_MODEL_READBACK_FAILED']); assert.equal(f.calls.length, 1);
});

test('Cordis integration attaches late native services and retires replaced session bindings', async t => {
  const f = fixture(t, { watch: false }), ctx = new Cordis.Context(); t.after(() => ctx.fiber.dispose());
  ctx.provide('connection', { generation: f.generation });
  let watch;
  const plugin = ctx.plugin(owner => { watch = installNativeModelReadback(owner); }); await plugin.await();
  watch('main'); watch('main');
  ctx.provide('remote', { session: f.remote }); ctx.provide('remote.session', f.remote);
  ctx.provide('modelDirectories', { directoryFor: () => f.directory });
  const list = store({});
  ctx.provide('sessions', { ...f.sessions, list, subagentAddress: () => undefined });
  await ctx.loader?.await(); await tick();
  await f.directory.select(next); await tick(); assert.equal(f.calls.length, 1);
  f.manager.handleControlFrame({ type: 'projection', sessionId: 'main', seq: 50,
    changes: [{ key: 'agentPreset', val: 'standard' }] }); list.set({}); await tick();
  await f.directory.select(newer); await tick(); assert.equal(f.calls.length, 1, 'standard preset is excluded');
  f.unbind(); list.set({}); await tick();
  await f.directory.select(newer); await tick(); assert.equal(f.calls.length, 1);
  await plugin.dispose();
});
