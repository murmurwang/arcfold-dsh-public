import { assertPreparationComposition, PREPARATION_TOOL_CONFIG } from '../src/preparation-plugin.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Context } from '@deepseek-ai/cordis';
import { boot } from '@deepseek-ai/dsh-app-boot';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import SessionStore from '@deepseek-ai/dsh-session';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import GoalService from '@deepseek-ai/dsh-goal';
import * as GoalDriver from '@deepseek-ai/dsh-goal-round-driver';
import SessionProjections from '@deepseek-ai/dsh-session-projection';
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment';
import * as Business from '../src/index.mjs';
import * as Host from '../src/metered-provider-host.mjs';
import * as OpenAI from '../src/openai-provider.mjs';
import * as DeepSeek from '../src/deepseek-provider.mjs';
import { BudgetLedger } from '../src/budget.mjs';
import { OpenAIUsageLedger } from '../src/openai-usage.mjs';
import { nativeRequestIdentity } from '../src/native-request-authority.mjs';
import { runtimeDeploymentPatches } from '../src/runtime-config.mjs';
import { actualRuntimeFiber, inspectNativeContinuationDriver, inspectRuntimeProviders, refreshRuntimeReadiness } from '../src/runtime-readiness.mjs';
import * as RuntimeGuard from '../src/runtime-guard.mjs';

test('real Loader handles normalize to the exact service-owning Fiber before guard arm', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'arcfold-readiness-loader-')));
  const filename = join(root, 'cordis.yml'); writeFileSync(filename, '[]\n');
  // The real official Loader and LLM service are mounted. The two inert entries
  // supply only the business/preset ownership boundaries required by this guard;
  // this is not a full business or Web-host acceptance test.
  const patches = [{ insert: [
    { id: 'arcfold-runtime-guard', name: 'cordis:guard' },
    { id: 'llm', name: 'cordis:llm', inject: ['arcfoldRuntimeGuard'] },
    { id: 'arcfold-business', name: 'cordis:business' },
    { id: 'preset-arcfold-main', name: 'cordis:main-preset' },
  ] }];
  const ctx = await boot('test', filename, patches, owner => {
    Object.assign(owner.loader.builtins, {
      guard: RuntimeGuard, llm: LlmRuntime,
      business: { apply(child) { child.provide('arcfoldBusiness', {}); } },
      'main-preset': { apply() {} },
    });
  });
  t.after(async () => ctx.fiber.dispose());
  const entries = [...ctx.loader.entries()];
  const entry = id => entries.find(row => row.options.id === id);
  const llm = entry('llm'), raw = llm.fiber.ctx.fiber;
  assert.notEqual(llm.fiber, raw, 'The real Loader retains the non-awaited registry handle');
  assert.equal(Object.getPrototypeOf(llm.fiber), raw);
  const provision = [...raw.provisions].find(record => record.name === 'llm');
  assert.ok(provision);
  assert.equal(provision.ctx.fiber, raw);
  assert.notEqual(provision.ctx.fiber, llm.fiber, 'This exact mismatch caused the installed startup failure');
  const criticalFibers = Object.fromEntries(['llm', 'arcfold-business', 'preset-arcfold-main']
    .map(id => [id, actualRuntimeFiber(entry(id), ctx.root)]));
  assert.equal(criticalFibers.llm, raw);
  const otherRoot = new Context(); t.after(async () => otherRoot.fiber.dispose());
  assert.throws(() => actualRuntimeFiber(llm, otherRoot), /not active in this host/);
  const guard = RuntimeGuard.getRuntimeGuard(ctx);
  assert.equal(guard.arm({ criticalFibers }).phase, 'ready');
  assert.equal(ctx.llm.listProviders().length, 0);
  // Actual status events name the raw Fiber too; its teardown must invalidate
  // the same strict owner that arm pinned, without any model request.
  await raw.dispose();
  assert.equal(guard.snapshot().phase, 'requires-restart');
  assert.throws(() => actualRuntimeFiber(llm, ctx.root), /not active in this host/);
});

async function settled(fiber) {
  const until = Date.now() + 5000;
  while (true) { await fiber.await(); if (fiber.state === 2) return fiber.ctx.fiber;
    assert.ok([0,1].includes(fiber.state) && Date.now() < until, 'real plugin must activate'); await delay(1); }
}
async function dualFixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'arcfold-dual-identity-'))), ctx = new Context();
  t.diagnostic('Retained real dual-provider identity fixture: ' + directory);
  t.after(async () => ctx.fiber.dispose());
  const authority = { authorizationRef: 'fixture-openai', authorizedAt: '2026-11-07T00:00:00Z', authorizationEvidence: 'Synthetic local ownership fixture.' };
  const original = { ceilingCny: 150, authorizationRef: 'fixture-original', create: true };
  const dsPath = join(directory, 'original-deepseek.sqlite'), oaPath = join(directory, 'original-openai.sqlite');
  new BudgetLedger(dsPath, original).close(); new OpenAIUsageLedger(oaPath, { create: true, webAuthorization: authority }).close();
  const policy = { contextWindow: 100000, maxOutputTokens: 128, requestMaxTokens: 64, reasoningEfforts: ['high'] };
  const config = { schema: 'arcfold-local-v2', dataRoot: directory, workspace: directory, listen: { host: '127.0.0.1', port: 0 },
    main: { provider: 'openai', model: 'gpt-6-astra', maxTokens: 64, reasoningEffort: 'high' }, learn: null,
    transport: { artifactDirectory: join(directory, 'receipts'), routes: {
      'deepseek-official': { kind: 'deepseek', apiKeyRef: 'SYNTHETIC_DEEPSEEK', ledgerPath: dsPath, scope: 'limited', ceilingCny: 150,
        authorizationRef: 'fixture-original', network: { mode: 'direct' }, endpoint: 'https://api.deepseek.com/anthropic/v1/messages',
        modelPolicies: { 'deepseek-v4-pro': { ...policy, prices: { input: 1, output: 2, cachedInput: 0.1 }, priceVersion: 'fixture' } } },
      openai: { kind: 'openai', apiKeyRef: 'SYNTHETIC_OPENAI', ledgerPath: oaPath, scope: 'web-openai', webAuthorization: authority,
        network: { mode: 'direct' }, endpoint: 'https://api.openai.com/v1/responses', modelPolicies: { 'gpt-6-astra': policy } },
    } } };
  const source = dirname(dirname(fileURLToPath(import.meta.url))), paths = {
    'deepseek-official': dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-llm-deepseek/package.json'))),
    openai: dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-llm-pi-ai/package.json'))),
  };
  const proofs = Object.fromEntries(Object.entries(paths).map(([provider, path]) => {
    const report = join(source, provider === 'openai' ? 'pi-ai-patch-receipt/report.json' : 'provider-patch-receipt/report.json');
    const spec = JSON.parse(readFileSync(join(source, provider === 'openai' ? 'patches/pi-ai-0.2.2-rc.1-transport.json' : 'patches/deepseek-0.2.2-rc.1-transport.json')));
    return [provider, { path, patchId: spec.id, receipt: report, receiptSHA256: createHash('sha256').update(readFileSync(report)).digest('hex') }];
  }));
  const plan = { config, workspace: directory, businessFilename: join(directory, 'business.sqlite'),
    installation: { coreRoot: source, providers: proofs, provider: proofs['deepseek-official'] } };
  const patches = runtimeDeploymentPatches(plan), guardConfig = patches.flatMap(p => p.insert ?? []).find(p => p.id === 'arcfold-runtime-guard').config;
  await ctx.plugin(RuntimeGuard, { ...guardConfig, modelSelectionRequired: false });
  const criticalFibers = { llm: await settled(await ctx.plugin(LlmRuntime)), session: await settled(await ctx.plugin(SessionStore)) };
  await ctx.plugin(SessionProjections); await ctx.plugin(JsonlPersistence, { root: join(directory, 'native'), compression: 'none' });
  let secretReads = 0; const configured = { openai: true, 'deepseek-official': true };
  criticalFibers.credentials = await settled(await ctx.plugin({ name: 'fixture-credentials', apply(child) {
    child.provide('credentials', { resolve() { secretReads++; throw new Error('Identity checks must not resolve a secret'); },
      async describe(ref) { return { configured: configured[ref === 'SYNTHETIC_OPENAI' ? 'openai' : 'deepseek-official'] }; } });
    child.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]));
    // Receipt fixture only: paths are obtained from the exact installed modules,
    // not an installed-product claim. The installer branch proves this resolver.
    child.provide('pluginPackages', { packageOf(name) { return { dir: paths[name.endsWith('pi-ai') ? 'openai' : 'deepseek-official'] }; } });
    child.provide('agentDefaultModel', { currentSelection: () => ({ provider: config.main.provider, model: config.main.model, reasoningEffort: config.main.reasoningEffort }) });
  } }));
  criticalFibers['arcfold-business'] = await settled(await ctx.plugin(Business, { filename: plan.businessFilename }));
  criticalFibers['arcfold-shared-metered-host'] = await settled(await ctx.plugin(Host, config.transport));
  criticalFibers['arcfold-metered-provider'] = await settled(await ctx.plugin(DeepSeek, { apiKeyRef: 'SYNTHETIC_DEEPSEEK', maxTokens: 64, reasoningEffort: 'high' }));
  criticalFibers['arcfold-openai-provider'] = await settled(await ctx.plugin(OpenAI, { apiKeyRef: 'SYNTHETIC_OPENAI', maxTokens: 64, reasoningEffort: 'high' }));
  // This fixture verifies provider ownership, not the full installed preset roster.
  criticalFibers['preset-arcfold-main'] = await settled(await ctx.plugin({ name: 'main-preset-ownership-fixture', apply() {} }));
  const guard = RuntimeGuard.getRuntimeGuard(ctx), expectedAdapterUpdates = guard.snapshot().adapterUpdates;
  return { ctx, guard, config, configured, criticalFibers, plan, secretReads: () => secretReads,
    check: () => inspectRuntimeProviders(ctx, plan, criticalFibers),
    arm: () => guard.arm({ criticalFibers, expectedAdapterUpdates,
      identifyRequest: options => nativeRequestIdentity(ctx.arcfoldBusiness, ctx.sessions, options) }) };
}
test('actual dual wrappers, shared transport and native pi-ai child arm after exact receipt checks without reading credentials', async t => {
  const f = await dualFixture(t); assert.deepEqual(await f.check(), ['deepseek-official', 'openai']);
  const child = f.ctx.arcfoldOpenAIProviderIdentity.nativeFiber;
  assert.equal(child.parent.fiber, f.criticalFibers['arcfold-openai-provider']); assert.equal(child.entry, undefined);
  assert.equal(Object.isFrozen(child), false); assert.equal(Object.isFrozen(f.ctx.arcfoldOpenAIProviderIdentity.configuration.providers.openai), true);
  assert.equal(f.arm().phase, 'ready'); assert.ok(f.guard.snapshot().adapterUpdates >= 3, 'directory updates are not guessed as provider counts');
  assert.equal((await refreshRuntimeReadiness(f.ctx, f.plan)).mode, 'execution-ready');
  f.configured.openai = false;
  const missing = await refreshRuntimeReadiness(f.ctx, f.plan);
  assert.equal(missing.mode, 'configuration-only'); assert.equal(missing.routeAvailability.main.credentialConfigured, false);
  assert.equal(missing.routeAvailability.providers['deepseek-official'].credentialConfigured, true);
  assert.equal(f.secretReads(), 0);
});
test('old single-provider proof and foreign consuming path never establish OpenAI readiness', async t => {
  const f = await dualFixture(t), original = f.plan.installation.providers.openai;
  delete f.plan.installation.providers.openai; await assert.rejects(f.check(), /no actual consuming-copy proof/);
  f.plan.installation.providers.openai = { ...original, path: f.plan.installation.provider.path };
  await assert.rejects(f.check(), /unverified copy/);
  f.plan.installation.providers.openai = { ...original, receiptSHA256: '0'.repeat(64) };
  await assert.rejects(f.check(), /receipt changed/); assert.equal(f.secretReads(), 0); assert.equal(f.guard.snapshot().armed, false);
});
test('missing wrong or foreign actual native child fails before arm', async t => {
  const f = await dualFixture(t), wrapper = f.criticalFibers['arcfold-openai-provider'];
  const original = f.ctx.arcfoldOpenAIProviderIdentity, foreign = await dualFixture(t);
  for (const nativeFiber of [undefined, wrapper, foreign.ctx.arcfoldOpenAIProviderIdentity.nativeFiber]) {
    wrapper.ctx.set('arcfoldOpenAIProviderIdentity', Object.freeze({ ...original, nativeFiber }));
    await assert.rejects(f.check(), /actual OpenAI child/);
  }
  wrapper.ctx.set('arcfoldOpenAIProviderIdentity', original);
  await f.check(); assert.equal(f.secretReads(), 0);
});
test('an armed actual native child or wrapper unload invalidates readiness', async t => {
  const f = await dualFixture(t); await f.check(); f.arm();
  await f.ctx.arcfoldOpenAIProviderIdentity.nativeFiber.dispose();
  assert.equal(f.guard.snapshot().phase, 'requires-restart');
  const other = await dualFixture(t); await other.check(); other.arm();
  const identity = other.ctx.arcfoldOpenAIProviderIdentity;
  await other.criticalFibers['arcfold-openai-provider'].dispose();
  assert.equal(identity.transportHookActive(), false);
  assert.equal(other.guard.snapshot().phase, 'requires-restart');
  assert.throws(() => other.guard.assertDispatch(Object.freeze({ provider: 'openai' })), { code: 'ARCFOLD_RUNTIME_RESTART_REQUIRED' });
  assert.equal(f.secretReads() + other.secretReads(), 0);
});

test('the existing runtime guard pins the actual root native driver and main preset; unload requires restart', async t => {
  for (const target of ['goal-round-driver', 'preset-arcfold-main']) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'arcfold-readiness-continuation-')));
    const filename = join(root, 'cordis.yml'); writeFileSync(filename, '[]\n');
    symlinkSync(join(dirname(dirname(fileURLToPath(import.meta.url))), 'node_modules'), join(root, 'node_modules'), 'dir');
    const modules = { guard: RuntimeGuard, llm: LlmRuntime, session: SessionStore, projections: SessionProjections,
      agents: AgentRegistry, goal: GoalService,
      business: { apply(child) { child.provide('arcfoldBusiness', {}); } },
      preset: { apply() {} } };
    const entries = [
      { id: 'guard', name: 'cordis:guard' }, { id: 'llm', name: 'cordis:llm', inject: ['arcfoldRuntimeGuard'] },
      ...['session', 'projections', 'agents', 'goal'].map(id => ({ id, name: 'cordis:' + id })),
      { id: 'arcfold-business', name: 'cordis:business' }, { id: 'preset-arcfold-main', name: 'cordis:preset' },
      { id: 'goal-round-driver', name: '@deepseek-ai/dsh-goal-round-driver' },
    ];
    const ctx = await boot('test', filename, [{ insert: entries }], owner => {
      owner.baseUrl = import.meta.url; Object.assign(owner.loader.builtins, modules);
    });
    t.after(() => ctx.fiber.dispose());
    const all = [...ctx.loader.entries()], byId = id => all.find(entry => entry.options.id === id);
    const driver = await inspectNativeContinuationDriver(ctx, all, []);
    assert.equal(byId('goal-round-driver').moduleNamespace.apply, GoalDriver.apply);
    const criticalFibers = Object.fromEntries(['llm', 'arcfold-business', 'preset-arcfold-main', 'goal']
      .map(id => [id, actualRuntimeFiber(byId(id), ctx.root)]));
    criticalFibers['goal-round-driver'] = driver;
    const guard = RuntimeGuard.getRuntimeGuard(ctx); assert.equal(guard.arm({ criticalFibers }).phase, 'ready');
    await actualRuntimeFiber(byId(target), ctx.root).dispose();
    assert.equal(guard.snapshot().phase, 'requires-restart');
    assert.throws(() => guard.assertReady(), { code: 'ARCFOLD_RUNTIME_RESTART_REQUIRED' });
  }
});


test('preparation composition refuses extra native execution paths and missing exact full-read caps', () => {
  const plugins = [{ name: '@deepseek-ai/dsh-tool-executor-native' }, { name: '@deepseek-ai/dsh-tool-fs', config: { ...PREPARATION_TOOL_CONFIG } }];
  const composition = { id: 'arcfold-preparation', leakedServices: [], modules: plugins.map(p => ({ moduleName: p.name })) };
  assertPreparationComposition(composition, plugins);
  for (const name of ['@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-tool-executor-ptc', '@deepseek-ai/dsh-goal-round-driver'])
    assert.throws(() => assertPreparationComposition({ ...composition, modules: [...composition.modules, { moduleName: name }] }, plugins));
  for (const field of ['readLimit', 'readMaxLineLength', 'readMaxBytes']) {
    const changed = structuredClone(plugins); changed[1].config[field] = 2000; assert.throws(() => assertPreparationComposition(composition, changed));
  }
  assert.throws(() => assertPreparationComposition({ ...composition, leakedServices: ['tools'] }, plugins));
});
