import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { boot, initProfile, readProfilePatches, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot';
import ConfigEditor from '@deepseek-ai/dsh-config-editor';
import DefaultModel from '@deepseek-ai/dsh-agent-default-model';
import Settings from '@deepseek-ai/dsh-settings';
import { initializeRuntimeConfig, createInitialRuntimeConfig, loadRuntimeIdentity, validateRuntimeConfig, runtimeRouteAvailability,
  runtimeDeploymentPatches, runtimeProviderDefaults, runtimeTransport } from '../src/runtime-config.mjs';
import { runtimeMainAvailability } from '../src/runtime-readiness.mjs';
import * as RuntimeGuard from '../src/runtime-guard.mjs';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'arcfold-runtime-config-')));
  mkdirSync(join(root, 'workspace'));
  const config = { schema: 'arcfold-local-v1', installationFile: join(root, 'code/installation.json'),
    dataRoot: join(root, 'data'), workspace: join(root, 'workspace'), listen: { host: '127.0.0.1', port: 0 },
    main: null, learn: null, transport: null };
  return { root, config };
}
function configured() {
  const { config } = fixture();
  config.main = { provider: 'deepseek-official', model: 'fixture-model', reasoningEffort: 'off', maxTokens: 512 };
  config.learn = { ...config.main, reasoningEffort: 'high', maxTokens: 1024 };
  config.transport = { apiKeyRef: 'NATIVE_CREDENTIAL_REF', ledgerPath: join(config.dataRoot, 'existing-ledger.sqlite'),
    artifactDirectory: join(config.dataRoot, 'receipts'), scope: 'limited', ceilingCny: 150, authorizationRef: 'original-authority',
    endpoint: 'https://api.deepseek.com/anthropic/v1/messages', modelPolicies: { 'fixture-model': {
      reasoningEfforts: ['off', 'high'], maxOutputTokens: 2048, requestMaxTokens: 1024,
    } } };
  return config;
}

test('legacy v1 configuration fixture has no model, secret or new budget, and refuses overwrite', () => {
  const { root, config } = fixture(), configPath = join(root, 'arcfold.json');
  initializeRuntimeConfig({ configPath, installationFile: config.installationFile, dataRoot: config.dataRoot, workspace: config.workspace });
  const original = readFileSync(configPath, 'utf8');
  const saved = JSON.parse(original); assert.equal(saved.main, null); assert.equal(saved.learn, null); assert.equal(saved.transport, null);
  assert.throws(() => initializeRuntimeConfig({ configPath, ...config }), /EEXIST/);
  assert.equal(readFileSync(configPath, 'utf8'), original);
});

test('status/stop can still locate their owner when the model configuration is invalid', () => {
  const { root, config } = fixture(), file = join(root, 'arcfold.json');
  writeFileSync(file, JSON.stringify({ ...config, main: { broken: true }, transport: 'invalid' }));
  assert.deepEqual(loadRuntimeIdentity(file), { configPath: file, dataRoot: config.dataRoot, runtimeDirectory: join(config.dataRoot, 'runtime') });
  assert.throws(() => validateRuntimeConfig(JSON.parse(readFileSync(file))), /unsupported fields/);
});

test('aliases of one existing data ancestor cannot create different owner identities', () => {
  const { root, config } = fixture(); mkdirSync(config.dataRoot); symlinkSync(config.dataRoot, join(root, 'alias'));
  const a = join(root, 'a.json'), b = join(root, 'b.json');
  writeFileSync(a, JSON.stringify({ ...config, dataRoot: join(config.dataRoot, 'future') }));
  writeFileSync(b, JSON.stringify({ ...config, dataRoot: join(root, 'alias/future') }));
  assert.equal(loadRuntimeIdentity(a).dataRoot, loadRuntimeIdentity(b).dataRoot);
});

test('workspace and installed code cannot contain each other or alias the same directory', () => {
  const { root, config } = fixture(), code = join(root, 'code'); mkdirSync(code);
  symlinkSync(code, join(root, 'code-alias'));
  for (const workspace of [code, join(code, 'project'), root, join(root, 'code-alias')])
    assert.throws(() => validateRuntimeConfig({ ...config, workspace }), /Keep workspace separate from installed code/);
  assert.doesNotThrow(() => validateRuntimeConfig(config));
});

test('configuration keeps main and Learn independent, and leaves unsupported choices explicit', () => {
  const config = configured(), saved = validateRuntimeConfig(config), before = structuredClone(saved.learn);
  saved.main = { ...saved.main, provider: 'another-provider', model: 'unavailable' };
  const status = runtimeRouteAvailability(saved);
  assert.equal(status.main.available, false); assert.equal(status.learn.available, true);
  assert.equal(runtimeProviderDefaults(saved).maxTokens, 512);
  assert.deepEqual(saved.learn, before); assert.equal(saved.main.provider, 'another-provider');
  assert.equal(config.main.provider, 'deepseek-official');
});

test('only the existing Messages endpoint and explicit local synthetic endpoint are supported', () => {
  const config = configured(); assert.doesNotThrow(() => validateRuntimeConfig(config));
  for (const endpoint of ['https://api.deepseek.com/v1/messages', 'https://example.com/anthropic/v1/messages',
    'https://api.deepseek.com/anthropic/v1/messages?api_key=secret'])
    assert.throws(() => validateRuntimeConfig({ ...config, transport: { ...config.transport, endpoint } }));
  assert.doesNotThrow(() => validateRuntimeConfig({ ...config, transport: { ...config.transport,
    endpoint: 'http://127.0.0.1:12345/anthropic/v1/messages', allowLocalTestEndpoint: true } }));
  assert.throws(() => validateRuntimeConfig({ ...config, transport: { ...config.transport, apiKey: 'secret' } }), /credential references/);
});

test('the runtime overlay gates LLM initialization, preserves ask, and separates provider and learning controls', () => {
  const config = configured(), plan = { config, workspace: config.workspace, businessFilename: join(config.dataRoot, 'business.sqlite') };
  const patches = runtimeDeploymentPatches(plan), row = id => patches.find(item => item.id === id);
  assert.equal(patches.find(row => row.id === 'goal-round-driver').disabled, false);
  assert.deepEqual(row('llm').inject, ['arcfoldRuntimeGuard']);
  assert.deepEqual(row('agent-default-model').inject, ['arcfoldRuntimeGuard']);
  assert.deepEqual(row('web-runtime').inject, ['webStartup', 'arcfoldRuntimeWorkspace']);
  assert.equal(row('agent-default-model').disabled, false);
  assert.equal(Object.hasOwn(row('agent-default-model'), 'config'), false);
  assert.deepEqual(row('approval').config, { policy: 'ask' });
  assert.equal(row('llm-pi-ai').disabled, true);
  assert.equal(row('arcfold-metered-provider').config.maxTokens, 512);
  assert.equal(row('arcfold-learning').config.maxTokens, 1024);
  assert.equal(row('arcfold-learning').config.reasoningEffort, 'high');
  assert.deepEqual(row('arcfold-preparation').config, { preset: 'arcfold-preparation', maxTokens: 8192, cwd: plan.workspace });
  assert.equal(Object.hasOwn(row('arcfold-metered-budget').config, 'apiKeyRef'), false);
});

test('unsupported requested controls do not break provider defaults or silently replace the saved selection', () => {
  const config = configured();
  config.main.maxTokens = 9999; config.learn = null;
  const before = structuredClone(config.main);
  config.transport.modelPolicies['second-model'] = { reasoningEfforts: ['off'], maxOutputTokens: 128, requestMaxTokens: 64 };
  const defaults = runtimeProviderDefaults(config);
  assert.deepEqual(defaults, { available: true, maxTokens: 64, reasoningEffort: 'off' });
  assert.equal(runtimeRouteAvailability(config).main.available, false);
  const patches = runtimeDeploymentPatches({ config, workspace: config.workspace, businessFilename: join(config.dataRoot, 'business.sqlite') });
  assert.deepEqual(patches.find(row => row.id === 'arcfold-metered-provider').config,
    { apiKeyRef: 'NATIVE_CREDENTIAL_REF', maxTokens: 64, reasoningEffort: 'off' });
  assert.deepEqual(config.main, before);
  config.transport.modelPolicies['second-model'].reasoningEfforts = ['max'];
  assert.equal(runtimeProviderDefaults(config).reason, 'model-catalog-has-no-common-controls');
  const unavailable = runtimeDeploymentPatches({ config, workspace: config.workspace, businessFilename: join(config.dataRoot, 'business.sqlite') });
  assert.equal(unavailable.find(row => row.id === 'arcfold-metered-provider').disabled, true);
  assert.equal(unavailable.find(row => row.id === 'arcfold-metered-budget').disabled, true);
  assert.equal(unavailable.find(row => row.id === 'agent-default-model').disabled, false);
});

// Real official Loader + ConfigEditor + Settings + default-model save path. This
// does not create a browser, Agent, network listener or model request.
function nativeSettingsFixture(t, initialMain = null, { observeLifetime = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'arcfold-native-settings-')));
  const home = join(root, 'native'); mkdirSync(home);
  const patchPath = join(home, 'arcfold.patch.yml'); writeFileSync(patchPath, '[]\n');
  const actualBaseline = loadOverlayPatches('test', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))
    .find(row => row.id === 'agent-default-model');
  assert.ok(actualBaseline?.config, 'Exercise the shipped bundle configuration, not a test copy');
  const lifetime = { consumerStarts: 0, consumerDisposals: 0, workStarts: 0, workCancellations: 0, works: [] };
  const start = async (version, initial = initialMain, { launcher = true } = {}) => {
    const installation = join(root, version), dir = join(installation, 'profile');
    mkdirSync(installation, { recursive: true });
    writeFileSync(join(installation, 'package.json'), JSON.stringify({ name: `fixture-${version}` }));
    initProfile(dir, ['fixture-runtime-bundle']);
    writeFileSync(join(dir, 'cordis.yml'), '[]\n');
    const bundle = join(dir, 'node_modules/fixture-runtime-bundle'); mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'fixture-runtime-bundle', version: '1.0.0',
      dsh: { bundle: { patch: 'cordis.patch.yml' } } }));
    writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
      { id: 'config-editor', name: 'cordis:editor' }, { id: 'settings', name: 'cordis:settings' },
      { id: 'agent-default-model', name: 'cordis:model', config: { provider: 'upstream', model: 'must-not-leak' } },
      { id: 'unrelated', name: 'cordis:preference', config: { count: 1 } },
      ...(observeLifetime ? [{ id: 'default-consumer', name: 'cordis:consumer' },
        { id: 'held-work', name: 'cordis:held' }] : []),
    ] }, actualBaseline]));
    const overlays = launcher ? [
      { id: 'agent-default-model', inject: ['arcfoldRuntimeGuard'] },
      { insert: [{ id: 'arcfold-runtime-guard', name: 'cordis:guard', config: { initialMain: initial } }] },
    ] : [];
    const profile = { name: version, startedBundles: ['fixture-runtime-bundle'], dir, patchPath,
      installAnchor: join(installation, 'package.json'), cwd: root, home, overlays, telemetryDisabledEnv: undefined };
    const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), owner => {
      owner.provide('profileContext', profile);
      Object.assign(owner.loader.builtins, { editor: ConfigEditor, settings: Settings, model: DefaultModel, guard: RuntimeGuard,
        preference: { Config: z.object({ count: z.natural().volatile() }), apply() {} },
        // Actual Cordis dependency lifetimes; the waiting work is a local
        // cancellation probe, not a native Agent, Learn result or model request.
        consumer: { inject: ['agentDefaultModel'], apply(child) {
          lifetime.consumerStarts++;
          child.provide('nativeDefaultConsumer', Object.freeze({
            defaults: RuntimeGuard.serviceIdentity(child.agentDefaultModel),
          }));
          child.effect(() => () => { lifetime.consumerDisposals++; });
        } },
        held: { inject: ['nativeDefaultConsumer'], apply(child) {
          lifetime.workStarts++;
          const abort = new AbortController(), settled = Promise.withResolvers();
          const work = { signal: abort.signal, result: settled.promise, completed: false,
            release() { work.completed = true; settled.resolve('completed'); } };
          abort.signal.addEventListener('abort', () => {
            if (!work.completed) { lifetime.workCancellations++; settled.resolve('cancelled'); }
          }, { once: true });
          lifetime.works.push(work);
          child.provide('heldDefaultWork', work);
          child.effect(() => () => { abort.abort(new Error('Native default dependency was disposed')); });
        } } });
    });
    t.after(async () => ctx.fiber.dispose());
    return ctx;
  };
  return { start, root, home, patchPath, lifetime };
}

test('native default-model save persists outside versioned code and survives unrelated settings and a changed version default', async t => {
  const firstDefault = { provider: 'deepseek-official', model: 'initial-model', reasoningEffort: 'off' };
  const f = nativeSettingsFixture(t, firstDefault), first = await f.start('version-one');
  assert.deepEqual(first.agentDefaultModel.currentSelection(), firstDefault);
  const chosen = { provider: 'deepseek-official', model: 'chosen-model', reasoningEffort: 'high' };
  const originalFiber = [...first.loader.entries()].find(row => row.options.id === 'agent-default-model').fiber;
  await first.agentDefaultModel.saveSelection(chosen);
  assert.deepEqual(first.agentDefaultModel.currentSelection(), chosen);
  assert.equal([...first.loader.entries()].find(row => row.options.id === 'agent-default-model').fiber, originalFiber);
  await first.settings.update('unrelated', { count: 2 });
  assert.deepEqual(first.agentDefaultModel.currentSelection(), chosen);
  const persisted = readFileSync(f.patchPath, 'utf8'); assert.match(persisted, /chosen-model/);
  await first.fiber.dispose();
  const restored = await f.start('version-two', { ...firstDefault, model: 'new-version-default' });
  assert.deepEqual(restored.agentDefaultModel.currentSelection(), chosen);
  assert.equal(readFileSync(f.patchPath, 'utf8'), persisted);
});

test('first native default save preserves raw service/provision and actual dependent held work', async t => {
  const f = nativeSettingsFixture(t, { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'off' },
    { observeLifetime: true });
  const ctx = await f.start('first-native-save');
  const entry = [...ctx.loader.entries()].find(row => row.options.id === 'agent-default-model');
  const raw = RuntimeGuard.serviceIdentity(ctx.agentDefaultModel);
  const provision = [...entry.fiber.ctx.fiber.provisions].find(value => value.name === 'agentDefaultModel');
  const consumer = RuntimeGuard.serviceIdentity(ctx.nativeDefaultConsumer), work = f.lifetime.works[0];
  assert.equal(provision.value, raw);
  const selected = { provider: 'openai', model: 'gpt-6-astra' };
  await ctx.agentDefaultModel.saveSelection(selected);
  await ctx.loader.await();
  const view = () => ({ consumerStarts: f.lifetime.consumerStarts, consumerDisposals: f.lifetime.consumerDisposals,
    workStarts: f.lifetime.workStarts, workCancellations: f.lifetime.workCancellations,
    sameService: RuntimeGuard.serviceIdentity(ctx.agentDefaultModel) === raw,
    sameProvision: entry.fiber.ctx.fiber.provisions.has(provision),
    sameConsumer: RuntimeGuard.serviceIdentity(ctx.nativeDefaultConsumer) === consumer,
    heldCancelled: work.signal.aborted });
  t.diagnostic(JSON.stringify({ afterFirstNativeSave: view() }));
  assert.deepEqual(view(), { consumerStarts: 1, consumerDisposals: 0, workStarts: 1, workCancellations: 0,
    sameService: true, sameProvision: true, sameConsumer: true, heldCancelled: false });
  assert.deepEqual(raw.currentSelection(), selected);
  assert.deepEqual(loadOverlayPatches('test', f.patchPath).find(row => row.id === 'agent-default-model').config, selected);
  const next = { ...selected, reasoningEffort: 'high' };
  await ctx.agentDefaultModel.saveSelection(next); await ctx.loader.await();
  assert.deepEqual(raw.currentSelection(), next);
  assert.deepEqual(view(), { consumerStarts: 1, consumerDisposals: 0, workStarts: 1, workCancellations: 0,
    sameService: true, sameProvision: true, sameConsumer: true, heldCancelled: false });
  work.release(); assert.equal(await work.result, 'completed');
});

test('unconfigured native default service remains editable, and an unsupported stored selection is never substituted', async t => {
  const f = nativeSettingsFixture(t), ctx = await f.start('unconfigured');
  assert.deepEqual(ctx.agentDefaultModel.currentSelection(), { provider: '', model: '' });
  const unsupported = { provider: 'not-supported', model: 'keep-exact-model', reasoningEffort: 'future' };
  await ctx.agentDefaultModel.saveSelection(unsupported);
  assert.deepEqual(ctx.agentDefaultModel.currentSelection(), unsupported);
  await ctx.fiber.dispose();
  const restored = await f.start('other-version', { provider: 'deepseek-official', model: 'must-not-substitute', reasoningEffort: 'off' });
  assert.deepEqual(restored.agentDefaultModel.currentSelection(), unsupported);
  const config = configured();
  assert.equal((await runtimeMainAvailability(null, config, unsupported)).reason, 'selected-route-not-supported');
});

test('the bundle still accepts explicit independent-plugin configuration without any launcher guard', async t => {
  const f = nativeSettingsFixture(t), explicit = { provider: 'standalone', model: 'explicit' };
  writeFileSync(f.patchPath, JSON.stringify([{ id: 'agent-default-model', config: explicit }]));
  const ctx = await f.start('standalone', null, { launcher: false });
  assert.equal(ctx.get('arcfoldRuntimeGuard'), undefined);
  assert.deepEqual(ctx.agentDefaultModel.currentSelection(), explicit);
});

test('readiness obtains true default controls from the official LLM runtime without probing unknown routes or sending', async t => {
  const ctx = new Context(); t.after(async () => ctx.fiber.dispose());
  await ctx.plugin(LlmRuntime);
  let resolutions = 0, sends = 0;
  class LocalCapabilities extends LlmAdapter {
    async resolveModel(provider, model) {
      resolutions++;
      return { provider, id: model, name: model, defaultMaxTokens: 32,
        reasoning: { efforts: [{ id: 'off', name: 'Off' }], defaultEffort: 'off' } };
    }
    async *stream() { sends++; throw new Error('A readiness check must not dispatch'); }
  }
  ctx.llm.registerAdapter(['deepseek-official'], new LocalCapabilities());
  const config = configured();
  config.main.maxTokens = 32;
  const actual = await runtimeMainAvailability(ctx.llm, config, { provider: 'deepseek-official', model: 'fixture-model' });
  assert.deepEqual(actual, { available: true, provider: 'deepseek-official', model: 'fixture-model', reasoningEffort: 'off', maxTokens: 32 });
  assert.equal(resolutions, 1); assert.equal(sends, 0);
  for (const selection of [{ provider: 'other', model: 'fixture-model' }, { provider: 'deepseek-official', model: 'unknown' }, { provider: '', model: '' }])
    assert.equal((await runtimeMainAvailability(ctx.llm, config, selection)).available, false);
  assert.equal(resolutions, 1); assert.equal(sends, 0);
  assert.equal(config.main.maxTokens, 32); assert.equal(config.learn.maxTokens, 1024);
});

function dualConfig() {
  const legacy = configured(), { artifactDirectory, ...deepseek } = legacy.transport;
  const config = { ...legacy, schema: 'arcfold-local-v2', transport: { artifactDirectory, routes: {
    'deepseek-official': { ...deepseek, kind: 'deepseek', network: { mode: 'direct' }, modelPolicies: { 'fixture-model': {
      ...deepseek.modelPolicies['fixture-model'], contextWindow: 65536, priceVersion: 'synthetic', prices: { input: 1, output: 2, cachedInput: 0.1 },
    } } },
    openai: { kind: 'openai', apiKeyRef: 'FIXTURE_OPENAI', ledgerPath: join(legacy.dataRoot, 'original-openai.sqlite'),
      scope: 'web-openai', webAuthorization: { authorizationRef: 'explicit-openai-web', authorizedAt: '2026-11-07T00:00:00Z', authorizationEvidence: 'Synthetic explicit web authority.' },
      endpoint: 'https://api.openai.com/v1/responses', network: { mode: 'proxy', url: 'http://127.0.0.1:12345/' },
      modelPolicies: { 'gpt-6-astra': { contextWindow: 100000, maxOutputTokens: 2048, requestMaxTokens: 1024, reasoningEfforts: ['high'] } },
    },
  } } };
  config.learn = { provider: 'openai', model: 'gpt-6-astra', reasoningEffort: 'high', maxTokens: 1024 };
  return config;
}
test('v2 retains one explicit route map; v1 projection never rewrites its schema, authorization or caller object', () => {
  const legacy = configured(), original = JSON.stringify(legacy), projected = runtimeTransport(legacy);
  assert.equal(projected.routes['deepseek-official'].ceilingCny, 150);
  assert.equal(projected.routes['deepseek-official'].authorizationRef, 'original-authority');
  projected.routes['deepseek-official'].ceilingCny = 999; assert.equal(JSON.stringify(legacy), original);
  const config = dualConfig(), copy = validateRuntimeConfig(config);
  assert.deepEqual(copy, config); assert.deepEqual(runtimeTransport(config), config.transport);
  const availability = runtimeRouteAvailability(config); assert.equal(availability.main.available, true); assert.equal(availability.learn.available, true);
  const patches = runtimeDeploymentPatches({ config, workspace: config.workspace, businessFilename: join(config.dataRoot, 'business.sqlite') });
  const row = id => patches.find(item => item.id === id);
  assert.equal(row('arcfold-metered-budget').disabled, true);
  assert.equal(row('arcfold-shared-metered-host').disabled, false);
  assert.equal(row('arcfold-openai-provider').disabled, false);
  assert.equal(row('arcfold-metered-provider').disabled, false);
  assert.deepEqual(row('arcfold-shared-metered-host').config, config.transport);
  assert.equal(row('arcfold-openai-provider').config.maxTokens, 512);
  assert.equal(row('arcfold-learning').config.maxTokens, 1024);
  assert.equal(Object.hasOwn(row('agent-default-model'), 'config'), false);
});
test('v2 rejects secret-bearing/implicit network and fee routes without substituting unsupported selections', () => {
  for (const change of [
    c => { c.transport.routes.openai.apiKey = 'not-a-real-key'; },
    c => { delete c.transport.routes.openai.network; },
    c => { c.transport.routes.openai.network = { mode: 'proxy', url: 'http://user:password@127.0.0.1:1234/' }; },
    c => { c.transport.routes.openai.scope = 'limited'; },
    c => { c.transport.routes.openai.webAuthorization.authorizationEvidence = ''; },
    c => { c.transport.routes.openai.modelPolicies['gpt-6-astra'].reasoningEfforts = ['unsupported-effort']; },
    c => { c.transport.routes.openai.modelPolicies['gpt-6-astra'].apiKey = 'not-a-real-key'; },
    c => { c.transport.routes.other = c.transport.routes.openai; },
  ]) { const config = dualConfig(); change(config); assert.throws(() => validateRuntimeConfig(config)); }
  const config = dualConfig(); config.main = { provider: 'unavailable', model: 'retained', reasoningEffort: 'future', maxTokens: 500 };
  assert.equal(runtimeRouteAvailability(validateRuntimeConfig(config)).main.available, false);
  assert.equal(runtimeRouteAvailability(config).learn.available, true); assert.equal(config.main.model, 'retained');
});
test('v2 stop/status identity survives invalid route settings and does not need a supported model', () => {
  const config = dualConfig(), file = join(config.dataRoot, '..', 'v2.json');
  writeFileSync(file, JSON.stringify({ ...config, transport: { invalid: true } }));
  assert.equal(loadRuntimeIdentity(file).dataRoot, config.dataRoot);
});

test('explicit web-only v2 config uses its fixed evidence-root path and has no finite authorization',()=>{
  const base=configured(),legacy=base.transport,{artifactDirectory,...old}=legacy;
  const {ceilingCny,authorizationRef,...other}=old;
  const route={...other,mode:'web-only',kind:'deepseek',scope:'web-unlimited',network:{mode:'direct'},
    ledgerPath:join(artifactDirectory,'deepseek-web.sqlite'),
    webAuthorization:{authorizationRef:'fixture-web-only',authorizedAt:'2026-11-07T00:00:00Z',authorizationEvidence:'fixture'},
    modelPolicies:{'fixture-model':{contextWindow:1024,maxOutputTokens:2048,requestMaxTokens:1024,
      prices:{input:1,output:2,cachedInput:0.1},priceVersion:'fixture',reasoningEfforts:['off','high']}}};
  const config={...base,schema:'arcfold-local-v2',transport:{artifactDirectory,routes:{'deepseek-official':route}}};
  assert.doesNotThrow(()=>validateRuntimeConfig(config));
  for(const patch of [{ceilingCny:150},{authorizationRef:'old'},{scope:'limited'},{mode:'other'},
    {ledgerPath:join(artifactDirectory,'elsewhere.sqlite')}])
    assert.throws(()=>validateRuntimeConfig({...config,transport:{...config.transport,routes:{'deepseek-official':{...route,...patch}}}}));
  const overlay=runtimeDeploymentPatches({config,workspace:config.workspace,businessFilename:join(config.dataRoot,'business.sqlite')});
  assert.deepEqual(overlay.find(row=>row.id==='arcfold-shared-metered-host').config,config.transport);
});

const initialPolicy=JSON.parse(readFileSync(new URL('../runtime/initial-policy.json',import.meta.url),'utf8'));
test('first-use fixed policy builds separate real routes and copies Learn only once',()=>{
  const {config}=fixture(),credentialRefs={'deepseek-official':'DS_NATIVE',openai:'OA_NATIVE'};
  const webAuthorizations=Object.fromEntries(['deepseek-official','openai'].map(p=>[p,{
    authorizationRef:'fixture-'+p,authorizedAt:'2026-11-07T00:00:00.000Z',authorizationEvidence:'fixture'}]));
  const args={...config,policy:initialPolicy,credentialRefs,webAuthorizations};
  const saved=createInitialRuntimeConfig({...args,main:undefined,learn:undefined});
  assert.deepEqual(saved.main,{provider:'deepseek-official',model:'deepseek-v4-pro',reasoningEffort:'high',maxTokens:128000});
  assert.deepEqual(saved.learn,saved.main);assert.notEqual(saved.learn,saved.main);
  const ds=saved.transport.routes['deepseek-official'];
  assert.equal(ds.mode,'web-only');assert.equal(ds.ceilingCny,undefined);assert.equal(ds.authorizationRef,undefined);
  assert.deepEqual(ds.modelPolicies['deepseek-v4-pro'].prices,{input:9,output:27,cachedInput:0.3});
  assert.match(ds.modelPolicies['deepseek-v4-pro'].priceVersion,/conservative-estimate/);
  assert.equal(saved.transport.routes.openai.modelPolicies['gpt-6-astra'].contextWindow,272000);
  assert.deepEqual(Object.keys(saved.transport.routes.openai.modelPolicies),['gpt-6-astra','gpt-6.1-sol']);
  assert.deepEqual(ds.modelPolicies['deepseek-flash'].prices,{input:2,output:8,cachedInput:0.04});
  assert.equal(saved.transport.routes.openai.modelPolicies['gpt-6.1-sol'].reasoningEfforts.at(-1),'max');
  saved.main={provider:'openai',model:'gpt-6-astra',reasoningEffort:'high',maxTokens:128000};
  assert.equal(saved.learn.model,'deepseek-v4-pro');
  const independent=createInitialRuntimeConfig({...args,main:undefined,learn:{provider:'deepseek-official',model:'deepseek-v4-pro',reasoningEffort:'off'}});
  assert.equal(independent.learn.reasoningEffort,'off');
  assert.equal(independent.main.model,'deepseek-v4-pro');
  for(const patch of [{learn:{provider:'openai',model:'gpt-6-astra',reasoningEffort:'off'}},
    {main:{provider:'other',model:'x',reasoningEffort:'high'}},{network:{mode:'proxy',url:'http://user:secret@localhost:9000/'}}])
    assert.throws(()=>createInitialRuntimeConfig({...args,main:undefined,learn:undefined,...patch}));
});
