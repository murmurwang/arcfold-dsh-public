import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm';
import * as RuntimeGuard from '../src/runtime-guard.mjs';
import { BusinessStore } from '../src/business.mjs';
import { LearningService } from '../src/learning.mjs';
import { LearningRunner } from '../src/learning-runner.mjs';
import { nativeRequestIdentity } from '../src/deepseek-budget-plugin.mjs';
import { refreshRuntimeReadiness, runtimeMainAvailability } from '../src/runtime-readiness.mjs';

const provider = 'deepseek-official', mainModel = 'deepseek-v4-pro', learnModel = 'deepseek-v4-flash';
const selection = { provider, model: learnModel, reasoningEffort: 'off', maxTokens: 64 };
const modelPolicies = Object.fromEntries([mainModel, learnModel].map(model => [model, {
  reasoningEfforts: ['off', 'high'], maxOutputTokens: 128, requestMaxTokens: 64,
}]));
const config = { routeAvailability: { main: { available: true }, learn: { available: true } },
  learn: selection, modelPolicies };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const drain = async iterable => { const result = []; for await (const value of iterable) result.push(value); return result; };
// Official LlmRuntime turns adapter exceptions into one terminal error chunk.
const assertFinalFailure = (chunks, message) => {
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].type, 'finish');
  assert.equal(chunks[0].reason.kind, 'error');
  assert.match(chunks[0].reason.failure.message, message);
};
const request = (patch = {}) => Object.freeze({ provider, model: mainModel, reasoningEffort: 'off', maxTokens: 32,
  sessionId: 'main', messages: Object.freeze([]), ...patch });
const identifyRequest = options => {
  assert.equal(options.purpose, undefined, 'Additional model purposes are not permitted');
  assert.ok(['main', 'learning'].includes(options.sessionId), 'The request is not an owned Arcfold session');
  return { metadata: { role: options.sessionId, ...(options.sessionId === 'learning' ? { learningPendingId: 'fixture-learning', learningInputHash: 'fixture-input' } : {}) } };
};
class ScriptedAdapter extends LlmAdapter {
  constructor(onSend, defaultMaxTokens) { super(); this.onSend = onSend; this.defaultMaxTokens = defaultMaxTokens; }
  async resolveModel(route, id) {
    return { provider: route, id, name: id, inputModalities: ['text'], defaultMaxTokens: this.defaultMaxTokens,
      reasoning: { efforts: ['off', 'high'].map(id => ({ id, name: id })), defaultEffort: 'off' } };
  }
  async *stream(options) {
    this.onSend(options);
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

async function fixture(t, { configured = true, learn = true, configuration = config, defaultMaxTokens, identify = identifyRequest, learningGuard, business } = {}) {
  const ctx = new Context(), sends = [], criticalFibers = {};
  t.after(async () => { await ctx.fiber.dispose(); });
  const guardConfig = configured ? configuration : { routeAvailability: { main: { available: false }, learn: { available: false } }, learn: null, modelPolicies: {} };
  const gateFiber = await ctx.plugin(RuntimeGuard, guardConfig);
  criticalFibers.llm = await ctx.plugin(LlmRuntime);
  criticalFibers['arcfold-business'] = await ctx.plugin({ name: 'test-business', apply(child) { child.provide('arcfoldBusiness', business ?? { get: (kind, id) => kind === 'learning_runs' && id === 'fixture-learning'
      ? { id, sessionId: 'learning', inputHash: 'fixture-input', defaultsRevision: 1, executionConfig: { ...selection, preset: 'fixture', cwd: '/fixture-workspace' } } : null }); } });
  criticalFibers['preset-arcfold-main'] = await ctx.plugin({ name: 'test-main-preset', apply() {} });
  if (configured) {
    criticalFibers['arcfold-metered-budget'] = await ctx.plugin({ name: 'test-budget', inject: ['llm'], apply(child) {
      child.provide('arcfoldDeepSeekTransport', { configuration: { provider, modelPolicies: configuration.modelPolicies } });
    } });
    criticalFibers['arcfold-metered-provider'] = await ctx.plugin({ name: 'test-provider', inject: ['llm', 'arcfoldDeepSeekTransport'], apply(child) {
      child.llm.registerAdapter([provider], new ScriptedAdapter(options => {
        // Production checks this at the owned transport before any network send.
        RuntimeGuard.getRuntimeGuard(child).assertDispatch(options);
        sends.push(options);
      }, defaultMaxTokens));
    } });
  }
  if (configured && learn) {
    criticalFibers['arcfold-learning'] = await ctx.plugin({ name: 'test-learning', apply(child) {
      child.provide('arcfoldLearningDefaults', { read: () => ({ revision: 1, ...configuration.learn }) });
      if (learningGuard) child.on('llm/stream', learningGuard);
    } });
    criticalFibers['preset-arcfold-learning'] = await ctx.plugin({ name: 'test-learning-preset', apply() {} });
  }
  const guard = RuntimeGuard.getRuntimeGuard(ctx), expectedAdapterUpdates = guard.snapshot().adapterUpdates;
  return { ctx, guard, gateFiber, criticalFibers, sends,
    arm: () => guard.arm({ criticalFibers, identifyRequest: identify, expectedAdapterUpdates }),
    call: options => drain(ctx.llm.stream(options ?? request())) };
}

test('root gate waits for readiness, survives its profile fiber disposal, and closes with the host', async t => {
  const f = await fixture(t);
  const waiting = f.call();
  await Promise.resolve();
  assert.equal(f.sends.length, 0);
  f.arm();
  await waiting;
  assert.equal(f.sends.length, 1);
  await f.gateFiber.dispose();
  assert.equal(RuntimeGuard.getRuntimeGuard(f.ctx), f.guard);
  await f.call();
  assert.equal(f.sends.length, 2);
  await f.ctx.fiber.dispose();
  // Official root teardown can retire a pinned child before removing root effects.
  assert.throws(() => f.guard.assertDispatch(request()), error =>
    ['ARCFOLD_RUNTIME_NOT_READY', 'ARCFOLD_RUNTIME_RESTART_REQUIRED'].includes(error.code));
});

test('startup waiting is cancellable and a failed startup releases every waiter without sending', async t => {
  const f = await fixture(t);
  const abort = new AbortController(), waiting = f.call(request({ signal: abort.signal }));
  abort.abort(new Error('test-start-cancel'));
  await assert.rejects(waiting, /test-start-cancel/);
  const failed = f.call();
  f.guard.fail();
  await assert.rejects(failed, { code: 'ARCFOLD_RUNTIME_NOT_READY' });
  assert.equal(f.sends.length, 0);
  assert.throws(f.arm, { code: 'ARCFOLD_RUNTIME_ARM' });
});

test('unconfigured runtime can become ready but cannot dispatch any model request', async t => {
  const f = await fixture(t, { configured: false });
  assert.equal(f.arm().phase, 'ready');
  await assert.rejects(f.call(), { code: 'ARCFOLD_ROUTE_UNAVAILABLE' });
  assert.equal(f.sends.length, 0);
});

test('native main model selection stays editable within the catalog while learning remains independently fixed', async t => {
  const f = await fixture(t, { configuration: { ...config, routeAvailability: { main: { available: false }, learn: { available: true } } } });
  f.arm();
  await f.call(request({ model: learnModel, reasoningEffort: 'high', maxTokens: 64 }));
  await f.call(request({ ...selection, sessionId: 'learning' }));
  for (const options of [request({ provider: 'other' }), request({ model: 'unknown' }), request({ maxTokens: 65 }),
    request({ reasoningEffort: 'max' })])
    await assert.rejects(f.call(options), { code: 'ARCFOLD_ROUTE_UNAVAILABLE' });
  assertFinalFailure(await f.call(request({ model: mainModel, sessionId: 'learning' })), /independently configured model/);
  assert.equal(f.sends.length, 2);
});

test('unfrozen or unowned requests cannot use a native main identity', async t => {
  const f = await fixture(t); f.arm();
  await assert.rejects(f.call({ ...request() }), { code: 'ARCFOLD_RUNTIME_INPUT' });
  assertFinalFailure(await f.call(request({ purpose: 'title' })), /Additional model purposes are not permitted/);
  assertFinalFailure(await f.call(request({ sessionId: 'other' })), /not an owned Arcfold session/);
  assert.equal(f.sends.length, 0);
});

test('same-name provider replacement blocks both a captured old registration and the new route', async t => {
  const f = await fixture(t); f.arm();
  const prepared = await f.ctx.llm.prepareCall({ provider, model: mainModel, reasoningEffort: 'off', maxTokens: 32 });
  await f.criticalFibers['arcfold-metered-provider'].dispose();
  f.ctx.llm.registerAdapter([provider], new ScriptedAdapter(options => f.sends.push(options)));
  await assert.rejects(drain(prepared.stream(request())), { code: 'ARCFOLD_RUNTIME_RESTART_REQUIRED' });
  await assert.rejects(f.call(), { code: 'ARCFOLD_RUNTIME_RESTART_REQUIRED' });
  assert.equal(f.sends.length, 0);
  assert.throws(f.arm, { code: 'ARCFOLD_RUNTIME_ARM' });
});

test('global listener prevents an isolated LLM route from bypassing the root policy', async t => {
  const f = await fixture(t); f.arm();
  const isolated = f.ctx.isolate('llm');
  await isolated.plugin(LlmRuntime);
  isolated.llm.registerAdapter([provider], new ScriptedAdapter(options => f.sends.push(options)));
  await assert.rejects(drain(isolated.llm.stream(request())), { code: 'ARCFOLD_RUNTIME_RESTART_REQUIRED' });
  assert.equal(f.sends.length, 0);
});

test('an isolated LLM is rejected by actual service identity even before it registers any adapter', async t => {
  const f = await fixture(t); f.arm();
  const isolated = f.ctx.isolate('llm');
  await isolated.plugin(LlmRuntime);
  assert.equal(f.guard.snapshot().adapterUpdates, 1);
  await assert.rejects(drain(isolated.llm.stream(request())), { code: 'ARCFOLD_RUNTIME_RESTART_REQUIRED' });
  assert.equal(f.guard.snapshot().reason, 'llm-instance-changed');
  assert.equal(f.sends.length, 0);
});

test('a changed registration before readiness cannot be washed into an approved initial generation', async t => {
  const f = await fixture(t);
  const prepared = await f.ctx.llm.prepareCall({ provider, model: mainModel, reasoningEffort: 'off', maxTokens: 32 });
  const waiting = drain(prepared.stream(request()));
  await f.criticalFibers['arcfold-metered-provider'].dispose();
  f.criticalFibers['arcfold-metered-provider'] = await f.ctx.plugin({ name: 'test-replacement', inject: ['llm', 'arcfoldDeepSeekTransport'], apply(child) {
    child.llm.registerAdapter([provider], new ScriptedAdapter(options => f.sends.push(options)));
  } });
  assert.throws(f.arm, { code: 'ARCFOLD_RUNTIME_IDENTITY' });
  await assert.rejects(waiting, { code: 'ARCFOLD_RUNTIME_NOT_READY' });
  assert.equal(f.sends.length, 0);
});

test('an identity change during awaited middleware is refused by the final dispatch assertion', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  f.ctx.on('llm/stream', (options, next) => (async function* () {
    entered.resolve(); await release.promise;
    // The production budget callback invokes this same synchronous assertion at send.
    f.guard.assertDispatch(options);
    yield* next();
  })());
  f.arm();
  const waiting = f.call(); await entered.promise;
  f.ctx.llm.registerAdapter(['unmetered'], new ScriptedAdapter(options => f.sends.push(options)));
  release.resolve();
  await assert.rejects(waiting, { code: 'ARCFOLD_RUNTIME_RESTART_REQUIRED' });
  assert.equal(f.sends.length, 0);
});

test('critical-fiber replacement, guard reconfiguration and asynchronous identity checks fail closed', async t => {
  const f = await fixture(t); f.arm();
  await f.criticalFibers['preset-arcfold-main'].dispose();
  await assert.rejects(f.call(), { code: 'ARCFOLD_RUNTIME_RESTART_REQUIRED' });
  const second = await fixture(t); second.arm();
  await second.ctx.plugin({ ...RuntimeGuard, name: 'guard-remount' }, { ...config, learn: { ...selection, maxTokens: 63 } });
  await assert.rejects(second.call(), { code: 'ARCFOLD_RUNTIME_RESTART_REQUIRED' });
  const third = await fixture(t);
  third.guard.arm({ criticalFibers: third.criticalFibers, identifyRequest: async () => ({ metadata: { role: 'main' } }) });
  assertFinalFailure(await third.call(), /Native request identity must be checked synchronously/);
  assert.equal(f.sends.length + second.sends.length + third.sends.length, 0);
});

test('same active fiber cannot replace its accounting service value without invalidating readiness', async t => {
  const f = await fixture(t); f.arm();
  const fiber = f.criticalFibers['arcfold-metered-budget'];
  fiber.ctx.set('arcfoldDeepSeekTransport', { configuration: { provider, modelPolicies } });
  assert.equal(fiber.state, 2);
  assert.equal(f.guard.snapshot().phase, 'requires-restart');
  await assert.rejects(f.call(), { code: 'ARCFOLD_RUNTIME_RESTART_REQUIRED' });
  assert.equal(f.sends.length, 0);
});

test('an actual adapter default cannot silently lower the explicit main limit; learning remains independent', async t => {
  const f = await fixture(t, { configuration: { ...config, mainMaxTokens: 9999 }, defaultMaxTokens: 64 });
  f.arm();
  const requested = { provider, model: mainModel, reasoningEffort: 'off' };
  const resolved = await f.ctx.llm.resolveCallConfig(requested);
  assert.equal(resolved.maxTokens, 64);
  const runtimeConfig = { main: { ...requested, maxTokens: 9999 }, learn: selection,
    transport: { apiKeyRef: 'LOCAL_FIXTURE', modelPolicies } };
  assert.deepEqual(await runtimeMainAvailability(f.ctx.llm, runtimeConfig, requested), {
    available: false, reason: 'main-output-limit-unavailable', requestedMaxTokens: 9999, resolvedMaxTokens: 64,
  });
  assertFinalFailure(await f.call(request(resolved)), /cannot represent the explicitly configured main output limit/);
  assert.throws(() => f.guard.assertDispatch(request(resolved)), { code: 'ARCFOLD_ROUTE_UNAVAILABLE' });
  assert.equal(f.sends.length, 0);
  await f.call(request({ ...selection, sessionId: 'learning' }));
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].sessionId, 'learning');

  const supported = await fixture(t, { configuration: { ...config, mainMaxTokens: 64 }, defaultMaxTokens: 64 });
  supported.arm();
  for (const model of [mainModel, learnModel]) {
    const current = await supported.ctx.llm.resolveCallConfig({ provider, model, reasoningEffort: 'high' });
    await supported.call(request(current));
  }
  assert.equal(supported.sends.length, 2);
});

test('status reads the current selection and gate without re-arming or sending', async t => {
  const f = await fixture(t, { defaultMaxTokens: 32 }); f.arm();
  let selected = { provider, model: mainModel, reasoningEffort: 'off' };
  f.ctx.provide('agentDefaultModel', { currentSelection: () => ({ ...selected }) });
  f.ctx.provide('credentials', { describe: async () => ({ configured: true }) });
  const plan = { config: { main: { ...selected, maxTokens: 32 }, learn: selection,
    transport: { apiKeyRef: 'LOCAL_FIXTURE', modelPolicies } } };
  assert.equal((await refreshRuntimeReadiness(f.ctx, plan)).mode, 'execution-ready');
  selected = { provider: 'not-supported', model: 'keep-user-selection' };
  const changed = await refreshRuntimeReadiness(f.ctx, plan);
  assert.equal(changed.mode, 'configuration-only');
  assert.equal(changed.routeAvailability.main.reason, 'selected-route-not-supported');
  assert.equal(changed.routeAvailability.learn.available, true);
  assert.equal(selected.model, 'keep-user-selection');
  selected = { provider, model: learnModel, reasoningEffort: 'high' };
  assert.equal((await refreshRuntimeReadiness(f.ctx, plan)).mode, 'execution-ready');
  f.ctx.llm.registerAdapter(['unmetered'], new ScriptedAdapter(() => {}));
  const staleTopology = await refreshRuntimeReadiness(f.ctx, plan);
  assert.equal(staleTopology.mode, 'configuration-only');
  assert.equal(staleTopology.modelGate.phase, 'requires-restart');
  assert.equal(staleTopology.routeAvailability.main.available, false);
  assert.equal(staleTopology.routeAvailability.learn.available, false);
  assert.equal(staleTopology.routeAvailability.mainSelectionScope, 'native-default');
  assert.equal(f.sends.length, 0);
  assert.throws(f.arm, { code: 'ARCFOLD_RUNTIME_ARM' });
});

test('status cannot report ready after a topology change during an awaited metadata read', async t => {
  const f = await fixture(t, { defaultMaxTokens: 32 }); f.arm();
  const selected = { provider, model: mainModel, reasoningEffort: 'off' }, entered = deferred(), release = deferred();
  f.ctx.provide('agentDefaultModel', { currentSelection: () => ({ ...selected }) });
  f.ctx.provide('credentials', { describe: async () => { entered.resolve(); await release.promise; return { configured: true }; } });
  const plan = { config: { main: { ...selected, maxTokens: 32 }, learn: selection,
    transport: { apiKeyRef: 'LOCAL_FIXTURE', modelPolicies } } };
  const reading = refreshRuntimeReadiness(f.ctx, plan); await entered.promise;
  f.ctx.llm.registerAdapter(['unmetered'], new ScriptedAdapter(() => {})); release.resolve();
  const changed = await reading;
  assert.equal(changed.modelGate.phase, 'requires-restart');
  assert.equal(changed.mode, 'configuration-only');
  assert.equal(f.sends.length, 0);
});


test('actual learning middleware records one intent before the final native identity check', async t => {
  const business = new BusinessStore({ filename: ':memory:' });
  t.after(() => business.close());
  const blocks = value => [{ type: 'text', text: value }];
  const events = [
    ['turn/start', { turn: 1 }], ['step/start', { turn: 1, step: 1 }],
    ['user/message', { id: 'human', role: 'user', source: { kind: 'user' }, content: blocks('Read back the written file') }],
    ['assistant/message', { turn: 1, step: 1, stream: [], message: { id: 'reply', role: 'assistant',
      source: { kind: 'model', provider, model: mainModel }, content: blocks('Written and read back') } }],
    ['step/end', { turn: 1, step: 1 }], ['turn/end', { turn: 1, reason: { kind: 'completed' } }],
  ].map(([type, data], seq) => ({ type, data, seq, time: 1800000000000 + seq,
    ...(['user/message', 'assistant/message'].includes(type) ? { surfaceOp: 'append' } : {}) }));
  business.ingestSession({ sessionId: 'main', events });
  const id = business.settleTurn({ sessionId: 'main', turn: 1, events }).learning.id;
  const learning = new LearningService({ business }), input = learning.prepare(id);
  const message = { id: 'learning-message', role: 'user', source: { kind: 'arcfold/learning', pendingId: id, deliveryId: input.deliveryId },
    content: blocks(input.inputText) };
  const section = { name: 'working-directory:current', text: 'Current working directory: "/fixture-workspace".' };
  const context = { role: 'user', source: { kind: 'runtime-context', form: 'snapshot', sections: [section] },
    content: blocks('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n' + section.text) };
  business.storage.save('learning_runs', { id, sessionId: 'learning', deliveryId: input.deliveryId, inputHash: input.inputHash,
    state: 'submitted', dispatchCount: 0, message, hostCwd: '/fixture-workspace', hostContext: context,
    executionConfig: { ...selection, preset: 'arcfold-learning', cwd: '/fixture-workspace' }, defaultsRevision: 1 });
  // Fixed native event input for this middleware composition test; the installed
  // browser probe separately covers real Agent creation, persistence and tools.
  const session = { id: 'learning', snapshotEvents: () => events.slice(0, 2), requestHeader: () => ({ config: selection }) };
  const host = { sessions: { get: key => key === session.id ? session : null }, workingDirectory: { get: () => '/fixture-workspace' } };
  const runner = new LearningRunner({ business, learning, host, config: { preset: 'arcfold-learning', cwd: '/fixture-workspace', ...selection } });
  const f = await fixture(t, { business, identify: options => nativeRequestIdentity(business, host.sessions, options),
    learningGuard: (options, next) => runner.guardStream(options, next) });
  f.arm();
  const options = request({ ...selection, sessionId: 'learning', tools: [], messages: [
    { role: 'system', content: blocks(input.prompt) }, message, { id: 'native-context', ...context },
  ] });
  assert.throws(() => f.guard.assertDispatch(options), /has not passed its single-call guard/);
  assert.equal(f.sends.length, 0);
  await f.call(options);
  assert.equal(business.get('learning_runs', id).dispatchCount, 1);
  assert.equal(f.sends.length, 1);
  await assert.rejects(f.call(options), /single-call, no-tools, frozen-input contract/);
  assert.equal(f.sends.length, 1);
});

test('final gate uses each started learning snapshot even after the independent default changes', async t => {
  const business = new BusinessStore({ filename: ':memory:' }); t.after(() => business.close());
  const saved = business.storage.save('learning_runs', { id: 'fixture-learning', sessionId: 'learning', inputHash: 'fixture-input',
    defaultsRevision: 1, executionConfig: { ...selection, preset: 'fixture', cwd: '/fixture-workspace' } });
  const f = await fixture(t, { business }); f.arm();
  business.storage.save('learn_defaults', { id: 'web', provider, model: mainModel, reasoningEffort: 'high' });
  await f.call(request({ ...selection, sessionId: 'learning' })); assert.equal(f.sends.length, 1);
  assertFinalFailure(await f.call(request({ provider, model: mainModel, reasoningEffort: 'high', maxTokens: 64, sessionId: 'learning' })), /saved at start/);
  assert.equal(f.sends.length, 1);
  // A different started record can use a different saved model without changing
  // the runtime's original deployment Learn choice or rewriting the older run.
  business.storage.save('learning_runs', { ...saved, id: 'new-learning', defaultsRevision: 2,
    executionConfig: { ...saved.executionConfig, model: mainModel, reasoningEffort: 'high' } });
  const newer = await fixture(t, { business, identify: options => ({ metadata: { role: 'learning',
    learningPendingId: 'new-learning', learningInputHash: 'fixture-input' } }) }); newer.arm();
  await newer.call(request({ ...selection, model: mainModel, reasoningEffort: 'high', sessionId: 'learning' }));
  assert.equal(newer.sends.length, 1); assert.deepEqual(business.get('learning_runs', saved.id).executionConfig, saved.executionConfig);
});
test('final gate refuses an old learning record without a configuration snapshot', async t => {
  const business = new BusinessStore({ filename: ':memory:' }); t.after(() => business.close());
  business.storage.save('learning_runs', { id: 'fixture-learning', sessionId: 'learning', inputHash: 'fixture-input' });
  const f = await fixture(t, { business }); f.arm();
  assertFinalFailure(await f.call(request({ ...selection, sessionId: 'learning' })), /旧学习/);
  assert.equal(f.sends.length, 0);
});


test('preparation dispatch checks its saved route/input and stops after its pinned owner unloads', async t => {
  const run = { id: 'prep', sessionId: 'prep-session', inputHash: 'frozen', state: 'submitted', executionConfig: { ...selection } };
  const f = await fixture(t, { business: { get: (kind, id) => kind === 'preparation_runs' && id === 'prep' ? run : null },
    identify: () => ({ metadata: { role: 'preparation', preparationRunId: 'prep', preparationInputHash: 'frozen' } }) });
  const owner = await f.ctx.plugin({ name: 'preparation-owner-fixture', apply(ctx) { ctx.provide('arcfoldPreparation', { identity: 'fixture' }); } });
  f.criticalFibers['arcfold-preparation'] = owner; f.arm();
  await f.call(request({ ...selection, sessionId: 'prep-session' })); assert.equal(f.sends.length, 1);
  run.inputHash = 'changed'; assertFinalFailure(await f.call(request({ ...selection, sessionId: 'prep-session' })), /bounded native owner/); assert.equal(f.sends.length, 1);
  run.inputHash = 'frozen'; await owner.dispose();
  await assert.rejects(f.call(request({ ...selection, sessionId: 'prep-session' })), { code: 'ARCFOLD_RUNTIME_RESTART_REQUIRED' });
});
