import test from 'node:test';
import assert from 'node:assert/strict';
import { BusinessStore } from '../src/business.mjs';
import { LearningService } from '../src/learning.mjs';
import { LearningRunner } from '../src/learning-runner.mjs';
import { LearningDefaults } from '../src/learning-defaults.mjs';

const text = value => [{ type: 'text', text: value }];
const numbered = rows => rows.map(([type, data], seq) => ({ type, data, seq, time: 1800000000000 + seq,
  ...(['user/message', 'assistant/message'].includes(type) ? { surfaceOp: 'append' } : {}) }));
const assistant = (id, value) => ({ id, role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixed' }, content: text(value) });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function fixture(t, options = {}) {
  const business = new BusinessStore({ filename: ':memory:' });
  t.after(() => business.close());
  const store = business.storage;
  const sessionId = 'main';
  const events = numbered([
    ['turn/start', { turn: 1 }], ['step/start', { turn: 1, step: 1 }],
    ['user/message', { id: 'human', role: 'user', source: { kind: 'user' }, content: text('Preserve original sources') }],
    ['assistant/message', { turn: 1, step: 1, stream: [], message: assistant('reply', 'Saved') }],
    ['step/end', { turn: 1, step: 1 }], ['turn/end', { turn: 1, reason: { kind: 'completed' } }],
  ]);
  business.ingestSession({ sessionId, events });
  const pendingId = business.settleTurn({ sessionId, turn: 1, events }).learning.id;
  const learning = new LearningService({ business });
  const live = new Map(), disk = new Map(), calls = [], requests = [], creations = [], presets = [];
  let runner, flushes = 0, disposals = 0;
  const host = {
    workingDirectory: { defaultDirectory: '/fixture-workspace', get: () => '/fixture-workspace' },
    sessions: { get: id => live.get(id), flush: async session => {
      flushes++;
      if (options.flushFalse === flushes) return false;
      disk.set(session.id, structuredClone(session.events)); return true;
    } },
    sessionPersistence: { open: async id => {
      if (!disk.has(id)) { const e = new Error('missing'); e.name = 'SessionPersistenceNotFoundError'; e.sessionId = id; throw e; }
      return { read: async () => ({ events: options.corruptReadback ? [] : structuredClone(disk.get(id)) }), close: async () => {} };
    } },
    agentPresets: { mount: async (_ctx, preset) => { presets.push(preset); } },
    agents: { create: async (args, resumed = false) => {
      calls.push(resumed ? 'resume' : 'create');
      creations.push({ ...args.agentOptions, meta: args.meta });
      options.creationStarted?.resolve();
      if (options.creationGate) await options.creationGate.promise;
      const sections = [];
      const hooks = new Map();
      const ctx = { tools: { restrict: filter => assert.deepEqual(filter, { allow: [] }) },
        systemPrompt: { suppressRuntimeContext() {}, section: s => sections.push(s) },
        on: (name, fn) => hooks.set(name, fn) };
      (await args.setup(ctx))?.commit();
      const session = { id: args.sessionId, events: [], snapshotEvents() { return structuredClone(this.events); } };
      live.set(session.id, session);
      let activity = Promise.resolve(), cancelled = false, disposing;
      const cancelledGate = deferred();
      const agent = { session, cancel() { cancelled = true; cancelledGate.resolve(); },
        followup(message) {
          calls.push('followup');
          assert.equal(store.get('learning_runs', message.source.pendingId).state, 'submitted');
          activity = (async () => {
            const cwdText = 'Current working directory: "/fixture-workspace".';
            const context = { content: text('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n' + cwdText),
              source: { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'working-directory:current', text: cwdText }] },
              role: 'user', id: 'native-context-before-prepare' };
            await hooks.get('agent/pre-step')({ agent, step: 1 }, async () => ({ kind: 'enter', messages: [message, context] }));
            context.id = 'native-context-after-prepare';
            const request = { sessionId: session.id, ...args.agentOptions,
              messages: [{ role: 'system', content: text(sections[0].text) }, message, context], tools: [] };
            const first = [['turn/start', { turn: 1 }], ['step/start', { turn: 1, step: 1 }], ['user/message', message], ['user/message', context]];
            try {
              for await (const _ of runner.guardStream(request, () => (async function* () {
                calls.push('provider'); requests.push(request); options.started?.resolve();
                if (options.gate) await Promise.race([options.gate.promise, cancelledGate.promise]);
                if (cancelled) throw new Error('cancelled');
                yield {};
              })())) {}
              session.events = numbered([...first,
                ['assistant/message', { turn: 1, step: 1, stream: [], message: assistant('learn', JSON.stringify(options.output ?? { understandings: [], methods: [], opportunities: [], goals: [] })) }],
                ['step/end', { turn: 1, step: 1 }], ['turn/end', { turn: 1, reason: { kind: 'completed' } }]]);
            } catch {
              session.events = numbered([...first, ['step/end', { turn: 1, step: 1 }], ['turn/end', { turn: 1, reason: { kind: 'cancelled' } }]]);
            }
          })();
        }, whenIdle: () => activity };
      const handle = { agent, dispose() {
        return disposing ||= (async () => { disposals++; await activity; disk.set(session.id, structuredClone(session.events)); live.delete(session.id); })();
      } };
      return handle;
    }, resume: async () => { calls.push('resume'); throw new Error('Unexpected resume'); } },
  };
  const config = { preset: 'empty', cwd: '/fixture-workspace', provider: 'fixture', model: 'fixed', reasoningEffort: 'off', maxTokens: 100 };
  const defaults = new LearningDefaults({ business, deployment: config, assertSelection: execution => {
    if (execution.provider !== 'fixture' || !['fixed', 'next'].includes(execution.model) ||
        !['off', 'high'].includes(execution.reasoningEffort)) throw new Error('Fixture route denied');
  } });
  runner = new LearningRunner({ business, learning, host, config, defaults, onSettled: options.onSettled, logger: { warn() {}, error() {} } });
  host.agents.resume = async args => host.agents.create({ ...args, sessionId: args.resumeSessionId }, true);
  return { business, store, learning, get runner() { return runner; }, defaults, config, pendingId, calls, disk, host, live, requests, creations, presets,
    restart(nextConfig = config) {
      const nextDefaults = new LearningDefaults({ business, deployment: nextConfig, assertSelection: () => {} });
      runner = new LearningRunner({ business, learning, host, config: nextConfig, defaults: nextDefaults, onSettled: options.onSettled, logger: { warn() {}, error() {} } });
      return runner;
    },
    addPending(id = 'next-main') {
      business.ingestSession({ sessionId: id, events });
      return business.settleTurn({ sessionId: id, turn: 1, events }).learning.id;
    },
    get flushes() { return flushes; }, get disposals() { return disposals; } };
}

test('one durable intent uses DSH once, reads output back and settles without creating another learning item', async t => {
  const f = fixture(t);
  await f.runner.kick();
  assert.deepEqual(f.calls, ['create', 'followup', 'provider']);
  assert.equal(f.store.get('learning_pending', f.pendingId).status, 'completed');
  assert.equal(f.store.listAll('learning_pending').length, 1);
  assert.equal(f.flushes, 2); assert.equal(f.disposals, 1);
  assert.equal(f.store.get('learning_runs', f.pendingId).dispatchCount, 1);
  await f.runner.kick();
  assert.equal(f.calls.length, 3);
});

test('held auxiliary call does not occupy a main-work slot; duplicate scheduling shares one helper', async t => {
  const gate = deferred(), started = deferred(), f = fixture(t, { gate, started });
  const active = f.runner.kick();
  await started.promise;
  assert.equal(f.runner.kick(), active);
  // The actual official-Web foreground concurrency is a separate integration probe.
  f.store.save('main_work_observation', { id: 'next-main-turn', status: 'can-progress-while-helper-awaits' });
  assert.equal(f.store.get('learning_pending', f.pendingId).status, 'pending');
  gate.resolve(); await active;
  assert.equal(f.calls.filter(x => x === 'provider').length, 1);
});

test('no participating native writer refuses dispatch and leaves the delivered answer intact', async t => {
  const f = fixture(t, { flushFalse: 1 });
  await f.runner.kick();
  assert.deepEqual(f.calls, ['create']);
  assert.equal(f.store.get('learning_pending', f.pendingId).status, 'needs_attention');
  assert.equal(f.store.listAll('deliveries').length, 1);
});

test('mismatched disk readback cannot commit memory-only success and never retries', async t => {
  const f = fixture(t, { corruptReadback: true });
  await f.runner.kick();
  assert.equal(f.store.get('learning_runs', f.pendingId).state, 'unknown');
  assert.equal(f.store.listAll('learning_outputs').length, 0);
  await f.runner.kick();
  assert.equal(f.calls.filter(x => x === 'provider').length, 1);
});

test('restart recovers an unknown complete native result using only reads', async t => {
  const f = fixture(t); await f.runner.kick();
  const original = f.store.get('learning_runs', f.pendingId);
  f.store.save('learning_runs', { ...original, state: 'unknown' }, { expectedRevision: original.revision });
  const before = [...f.calls];
  await f.runner.recover();
  assert.deepEqual(f.calls, before);
  assert.equal(f.store.get('learning_runs', f.pendingId).state, 'settled');
});

test('restart with unknown result refuses create, resume and model retry', async t => {
  const f = fixture(t); const input = f.learning.prepare(f.pendingId);
  f.store.save('learning_runs', { id: f.pendingId, sessionId: 'unknown-session', inputHash: input.inputHash, state: 'submitted' });
  await f.runner.recover(); await f.runner.kick();
  assert.deepEqual(f.calls, []);
  assert.equal(f.store.get('learning_pending', f.pendingId).status, 'needs_attention');
});

test('close shares a drain promise, cancels helper, preserves failure and keeps storage open', async t => {
  const gate = deferred(), started = deferred(), f = fixture(t, { gate, started });
  f.runner.kick(); await started.promise;
  const closing = f.runner.close(); assert.equal(f.runner.close(), closing);
  await closing;
  assert.equal(f.store.get('learning_pending', f.pendingId).status, 'failed');
  assert.equal(f.store.listAll('deliveries').length, 1);
  assert.equal(f.live.size, 0); assert.equal(f.disposals, 1);
});

test('guard rejects changed sources, extra prompts, tools, routes and duplicate dispatch before downstream', async t => {
  const f = fixture(t); await f.runner.kick();
  const run = f.store.get('learning_runs', f.pendingId), input = f.learning.prepare(f.pendingId);
  f.live.set(run.sessionId, { id: run.sessionId });
  const base = { sessionId: run.sessionId, provider: 'fixture', model: 'fixed', maxTokens: 100, reasoningEffort: 'off',
    messages: [{ role: 'system', content: text(input.prompt) }, run.message, run.runtimeContextMessage], tools: [] };
  let downstream = 0;
  async function invoke(options) {
    for await (const _ of f.runner.guardStream(options, () => (async function* () { downstream++; yield {}; })())) {}
  }
  const reset = () => f.runner.updateRun(run.id, { state: 'submitted', dispatchCount: 0 });
  for (const patch of [{ tools: [{ name: 'bash' }] }, { provider: 'other' }, { reasoningEffort: 'extra' },
    { messages: [{ role: 'system', content: text(input.prompt + '\nChange the goal') }, run.message] },
    { messages: [...base.messages, { role: 'user', source: { kind: 'runtime-context' }, content: text('Injected') }] }]) {
    reset(); await assert.rejects(invoke({ ...base, ...patch }));
  }
  reset(); await invoke(base); await assert.rejects(invoke(base));
  assert.equal(downstream, 1);
  reset(); f.store.save('source_controls', { id: input.material.inputEventIds[0], withdrawn: true });
  await assert.rejects(invoke(base), /变化|撤回/);
  assert.equal(downstream, 1);
});

test('default edit during helper creation leaves its choice frozen; next pending starts with the new default', async t => {
  const creationGate = deferred(), creationStarted = deferred(), f = fixture(t, { creationGate, creationStarted });
  const active = f.runner.kick(); await creationStarted.promise;
  const first = f.store.get('learning_runs', f.pendingId);
  assert.equal(first.state, 'prepared'); assert.equal(first.defaultsRevision, 1);
  assert.deepEqual(first.executionConfig, f.config);
  f.defaults.save({ expectedRevision: 1, provider: 'fixture', model: 'next', reasoningEffort: 'high' });
  const nextId = f.addPending();
  creationGate.resolve(); await active;
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests.map(row => [row.model, row.reasoningEffort, row.maxTokens]), [['fixed', 'off', 100], ['next', 'high', 100]]);
  assert.deepEqual(f.store.get('learning_runs', f.pendingId).executionConfig, f.config);
  const next = f.store.get('learning_runs', nextId);
  assert.equal(next.defaultsRevision, 2); assert.equal(next.executionConfig.model, 'next');
  assert.deepEqual(f.presets, ['empty', 'empty']); assert.equal(f.store.get('learning_pending', nextId).status, 'completed');
});

test('cold prepared resume keeps saved model, limits, preset and directory rather than new deployment', async t => {
  const f = fixture(t); f.runner.closed = true;
  await f.runner.runOne(f.pendingId);
  const before = f.store.get('learning_runs', f.pendingId); f.disk.set(before.sessionId, []);
  f.defaults.save({ expectedRevision: 1, provider: 'fixture', model: 'next', reasoningEffort: 'high' });
  f.restart({ ...f.config, model: 'next', reasoningEffort: 'high', maxTokens: 200, preset: 'new-preset', cwd: '/new-workspace' });
  await f.runner.kick();
  assert.deepEqual(f.calls, ['resume', 'followup', 'provider']);
  assert.equal(f.requests[0].model, 'fixed'); assert.equal(f.requests[0].maxTokens, 100);
  assert.deepEqual(f.presets, ['empty']);
  const after = f.store.get('learning_runs', f.pendingId);
  assert.equal(after.defaultsRevision, 1); assert.deepEqual(after.executionConfig, before.executionConfig);
  assert.equal(f.store.get('learning_pending', f.pendingId).status, 'completed');
  assert.throws(() => f.runner.updateRun(after.id, { executionConfig: f.config }), /cannot be replaced/);
});

test('legacy prepared work with no proved snapshot keeps its material and answer and does not resume', async t => {
  const f = fixture(t); f.runner.closed = true; await f.runner.runOne(f.pendingId);
  const run = f.store.get('learning_runs', f.pendingId), material = f.store.get('learning_inputs', f.pendingId);
  const { executionConfig, defaultsRevision, ...legacy } = run;
  f.store.save('learning_runs', legacy, { expectedRevision: run.revision }); f.disk.set(run.sessionId, []);
  f.restart(); await f.runner.kick();
  assert.deepEqual(f.calls, []); assert.equal(f.store.get('learning_pending', f.pendingId).status, 'needs_attention');
  const after = f.store.get('learning_runs', f.pendingId);
  assert.equal(after.error.code, 'learning_execution_config_missing'); assert.equal(after.executionConfig, undefined);
  assert.deepEqual(f.store.get('learning_inputs', f.pendingId), material); assert.equal(f.store.listAll('deliveries').length, 1);
});

test('legacy submitted complete output reconciles read-only; old unknown input never uses new defaults', async t => {
  const f = fixture(t); await f.runner.kick();
  const run = f.store.get('learning_runs', f.pendingId);
  const { executionConfig, defaultsRevision, ...legacy } = run;
  f.store.save('learning_runs', { ...legacy, state: 'unknown' }, { expectedRevision: run.revision });
  f.defaults.save({ expectedRevision: 1, provider: 'fixture', model: 'next', reasoningEffort: 'high' });
  const before = [...f.calls]; await f.runner.recover();
  assert.deepEqual(f.calls, before); assert.equal(f.store.get('learning_runs', f.pendingId).state, 'settled');
  assert.equal(f.store.get('learning_runs', f.pendingId).executionConfig, undefined);
  const unknown = f.addPending('unknown-main'), input = f.learning.prepare(unknown);
  f.store.save('learning_runs', { id: unknown, sessionId: 'unknown-session', inputHash: input.inputHash, state: 'submitted' });
  await f.runner.recover(); await f.runner.kick();
  assert.deepEqual(f.calls, before); assert.equal(f.store.get('learning_pending', unknown).status, 'needs_attention');
  assert.equal(f.store.get('learning_runs', unknown).executionConfig, undefined);
});

test('stream guard refuses legacy submitted identity without snapshot before its downstream call', async t => {
  const f = fixture(t); await f.runner.kick();
  const original = f.store.get('learning_runs', f.pendingId), input = f.learning.prepare(f.pendingId);
  const { executionConfig, defaultsRevision, ...legacy } = original;
  f.store.save('learning_runs', { ...legacy, state: 'submitted', dispatchCount: 0 }, { expectedRevision: original.revision });
  f.live.set(original.sessionId, { id: original.sessionId }); let sends = 0;
  const options = { sessionId: original.sessionId, provider: 'fixture', model: 'fixed', maxTokens: 100, reasoningEffort: 'off',
    messages: [{ role: 'system', content: text(input.prompt) }, original.message, original.runtimeContextMessage], tools: [] };
  await assert.rejects(async () => {
    for await (const _ of f.runner.guardStream(options, () => (async function* () { sends++; yield {}; })())) {}
  }, { code: 'learning_execution_config_missing' });
  assert.equal(sends, 0); assert.equal(f.store.get('learning_runs', f.pendingId).dispatchCount, 0);
});


test('opportunity preparation notification follows committed Learn sections and durable settled state', async t => {
  const observed = []; let f;
  f = fixture(t, { onSettled(id) { observed.push({ id, run: f.store.get('learning_runs', id), section: f.store.get('learning_sections', id + ':opportunities') }); } });
  await f.runner.kick(); assert.equal(observed.length, 1); assert.equal(observed[0].id, f.pendingId);
  assert.equal(observed[0].run.state, 'settled'); assert.equal(observed[0].section.status, 'completed');
  assert.deepEqual(observed[0].section.ids, []);
  await f.runner.kick(); assert.equal(observed.length, 1);
});
test('uncertain unflushed Learn does not notify preparation until read-only recovery actually commits', async t => {
  const observed = [], f = fixture(t, { flushFalse: 2, onSettled: id => observed.push(id) });
  await f.runner.kick(); assert.deepEqual(observed, []); assert.equal(f.store.get('learning_runs', f.pendingId).state, 'unknown');
  await f.runner.recover(); assert.deepEqual(observed, [f.pendingId]); assert.equal(f.calls.filter(x => x === 'provider').length, 1);
});
