import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeModelSettings } from '../src/runtime-model-settings.mjs';
import { BusinessStore } from '../src/business.mjs';
import { LearningDefaults } from '../src/learning-defaults.mjs';

const first = { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high', maxTokens: 64 };
const second = { provider: 'openai', model: 'gpt-6-astra', reasoningEffort: 'high' };
const policy = { maxOutputTokens: 128, requestMaxTokens: 64, reasoningEfforts: ['high'] };
function fixture(t, choices = [first, second]) {
  const business = new BusinessStore({ filename: ':memory:' }); t.after(() => business.close());
  const config = { schema: 'arcfold-local-v2', main: first, learn: first, transport: { artifactDirectory: '/fixture', routes: {
    'deepseek-official': { apiKeyRef: 'DS_FIXTURE', modelPolicies: Object.fromEntries(choices.filter(value=>value.provider==='deepseek-official').map(value=>[value.model,policy])) },
    openai: { apiKeyRef: 'OA_FIXTURE', modelPolicies: Object.fromEntries(choices.filter(value=>value.provider==='openai').map(value=>[value.model,policy])) },
  } } };
  let phase = 'ready', descriptionGate, catalogGate, modelCalls = 0, sessionCalls = 0;
  const guard = { snapshot: () => ({ phase }), assertReady() { if (phase !== 'ready') throw Object.assign(new Error('gate'), { code: 'ARCFOLD_RUNTIME_NOT_READY' }); } };
  const map = new Map();
  const host = { get: name => map.get(name),
    agents: { resolveAgent() { sessionCalls++; throw new Error('No session activation permitted'); } },
    sessionController: { async modelCatalog() { if (catalogGate) await catalogGate;
      const all=[...choices,{provider:'foreign',model:'foreign'}];
      return { groups: [...new Set(all.map(value=>value.provider))].map(provider=>({id:provider,
        models:all.filter(value=>value.provider===provider).map(value=>({id:value.model,name:value.model,
          reasoning:{efforts:[{id:'high'},{id:'forbidden'}]}}))})) }; } },
    llm: { async resolveCallConfig(selected) { return { ...selected, maxTokens: 64 }; }, stream() { modelCalls++; throw new Error('No model probes'); } },
    agentDefaultModel: { currentSelection: () => first },
    credentials: { async describe(ref) { if (descriptionGate) await descriptionGate; return { configured: ref === 'OA_FIXTURE' }; },
      resolve() { throw new Error('No secret reads'); } },
  };
  map.set('arcfoldMeteredTransport', { summary(provider) { return provider === 'openai'
    ? { scope: 'web-openai', requests: 2, unknownCount: 1, pendingCount: 0, promptTokens: 3, completionTokens: 4, cachedTokens: 1 }
    : { scope: 'web-unlimited', requests: 7, unknownCount: 1, spentCny: 0.4, reservedCny: 0.2, ceilingCny: null,
        allTime: { spentCny: 999 }, privatePath: '/not-public' }; } });
  const models = createRuntimeModelSettings(host, config, guard);
  const defaults = new LearningDefaults({ business, deployment: { ...first, preset: 'arcfold-learning', cwd: '/fixture' },
    assertSelection: models.assertLearningSelection });
  defaults.initialize(); map.set('arcfoldLearningDefaults', defaults);
  return { models, defaults, business, host, config, guard, map,
    phase(value) { phase = value; }, description(value) { descriptionGate = value; }, catalog(value) { catalogGate = value; },
    counts: () => ({ modelCalls, sessionCalls }) };
}
test('settings read uses no session, secret or model and publishes only owned catalog and scoped accounting', async t => {
  const f = fixture(t), before = f.business.storage.currentSequence(), view = await f.models.read();
  assert.equal(f.business.storage.currentSequence(), before);
  assert.deepEqual(view.routes.map(value => value.provider), ['deepseek-official', 'openai']);
  assert.deepEqual(view.routes[0].models[0].reasoningEfforts, ['high']);
  assert.equal(view.main.availability.reason, 'native-credential-not-configured');
  assert.equal(view.learning.availability.reason, 'native-credential-not-configured');
  assert.equal(view.routes[0].usage.spentCny, 0.4); assert.equal(view.routes[0].usage.ceilingCny, null);
  assert.equal(view.routes[1].usage.accounting, 'tokens_only');
  assert.equal(view.routes[1].usage.scope, 'web-openai');
  assert.equal(view.routes[1].usage.spentCny, undefined);
  assert.ok(!JSON.stringify(view).includes('999')); assert.ok(!JSON.stringify(view).includes('privatePath'));
  assert.deepEqual(f.counts(), { modelCalls: 0, sessionCalls: 0 });
});
test('an unavailable old default can be changed to another owned route, with synchronous revision and authority checks', async t => {
  const f = fixture(t), request = { expectedRevision: 1, ...second };
  assert.equal((await f.models.saveLearning(request)).revision, 2);
  assert.equal((await f.models.read()).learning.availability.available, true);
  await assert.rejects(f.models.saveLearning(request), { code: 'revision_conflict' });
  await assert.rejects(f.models.saveLearning({ ...request, expectedRevision: 2, maxTokens: 32 }), { code: 'invalid_learning_defaults' });
  await assert.rejects(f.models.saveLearning({ ...request, expectedRevision: 2, reasoningEffort: 'forbidden' }), { code: 'learning_configuration_unavailable' });
  assert.equal(f.defaults.read().revision, 2);
  const gate = Promise.withResolvers(); f.catalog(gate.promise);
  const pending = f.models.saveLearning({ expectedRevision: 2, ...second }); f.phase('closed'); gate.resolve();
  await assert.rejects(pending, { code: 'ARCFOLD_RUNTIME_NOT_READY' }); assert.equal(f.defaults.read().revision, 2);
});
test('a browser disconnect during catalog reading cannot later commit a learning edit', async t => {
  const f = fixture(t), gate = Promise.withResolvers(), abort = new AbortController(); f.catalog(gate.promise);
  const pending = f.models.saveLearning({ expectedRevision: 1, ...second }, () => abort.signal.throwIfAborted());
  abort.abort(new Error('fixture disconnect')); gate.resolve();
  await assert.rejects(pending, /fixture disconnect/); assert.equal(f.defaults.read().revision, 1);
});
test('readiness cannot pair a newly edited default with an availability result for the previous choice', async t => {
  const f = fixture(t), gate = Promise.withResolvers(); f.description(gate.promise);
  const pending = f.models.read(); await new Promise(resolve => setImmediate(resolve));
  f.defaults.save({ expectedRevision: 1, ...second }); gate.resolve();
  const view = await pending;
  assert.equal(view.learning.defaults.provider, 'openai'); assert.equal(view.learning.defaults.revision, 2);
  assert.equal(view.learning.availability.available, false);
  assert.equal(view.learning.availability.reason, 'learning-selection-changed-during-status');
  assert.equal((await f.models.read()).learning.availability.available, true);
});

test('both pickers share all four owned model choices while learning changes leave main unchanged', async t => {
  const flash={provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'high'};
  const sol={provider:'openai',model:'gpt-6.1-sol',reasoningEffort:'high'};
  const f=fixture(t,[first,flash,second,sol]), before=f.defaults.read();
  const view=await f.models.read();
  assert.deepEqual(view.routes.map(route=>route.models.map(model=>model.id)),
    [['deepseek-v4-pro','deepseek-flash'],['gpt-6-astra','gpt-6.1-sol']]);
  assert.deepEqual(f.defaults.read(),before);
  await f.models.assertMainSelection(null,sol);await f.models.assertMainSelection(null,flash);
  assert.equal((await f.models.saveLearning({expectedRevision:1,...sol})).revision,2);
  assert.equal((await f.models.saveLearning({expectedRevision:2,...flash})).revision,3);
  assert.deepEqual(f.host.agentDefaultModel.currentSelection(),first);
  assert.deepEqual(f.counts(),{modelCalls:0,sessionCalls:0});
  await assert.rejects(f.models.assertMainSelection(null,{...sol,model:'gpt-unowned'}));
  await assert.rejects(f.models.saveLearning({expectedRevision:3,...sol,reasoningEffort:'forbidden'}));
  assert.equal(f.defaults.read().revision,3);
});
