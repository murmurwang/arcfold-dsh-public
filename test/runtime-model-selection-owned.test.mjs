import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, initProfile, PluginPackages, readProfilePatches } from '@deepseek-ai/dsh-app-boot';
import ConfigEditor from '@deepseek-ai/dsh-config-editor';
import DefaultModel from '@deepseek-ai/dsh-agent-default-model';
import Settings from '@deepseek-ai/dsh-settings';
import SessionController from '@deepseek-ai/dsh-api-session-controller';
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access';
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm';
import SessionStore from '@deepseek-ai/dsh-session';
import SessionProjections from '@deepseek-ai/dsh-session-projection';
import SessionQuery from '@deepseek-ai/dsh-session-query';
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import { parse } from 'yaml';
import { BusinessStore } from '../src/business.mjs';
import * as RuntimeGuard from '../src/runtime-guard.mjs';
import * as RuntimeModels from '../src/runtime-model-settings.mjs';
import { actualRuntimeFiber, inspectRuntimeModelSelection } from '../src/runtime-readiness.mjs';
import { runtimeDeploymentPatches } from '../src/runtime-config.mjs';
import { nativeRequestIdentity } from '../src/native-request-authority.mjs';

const SOURCE = dirname(dirname(fileURLToPath(import.meta.url)));
const first = { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'off' };
const second = { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' };
const policies = Object.fromEntries([first.model, second.model].map(model => [model,
  { reasoningEfforts: ['off', 'high'], requestMaxTokens: 64, maxOutputTokens: 128 }]));
const sha = value => createHash('sha256').update(value).digest('hex');
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const drain = async iterable => { const chunks = []; for await (const chunk of iterable) chunks.push(chunk); return chunks; };

class Catalog extends LlmAdapter {
  constructor(sent) { super(); this.sent = sent; }
  async listModels(provider) { return [first, second].map(({ model }) => ({ provider, id: model, name: model })); }
  async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: ['text'], defaultMaxTokens: 64,
    reasoning: { efforts: ['off', 'high'].map(id => ({ id, name: id })), defaultEffort: 'off' } }; }
  async *stream() { this.sent.push('unexpected'); throw new Error('This settings fixture never authorizes a model request'); }
}
// The real query superclass supplies live/durable point reads. Search is outside this fixture.
class PointQuery extends SessionQuery {
  async searchSessions() { throw new Error('Search is not configured in the settings fixture'); }
  async searchEvents() { throw new Error('Search is not configured in the settings fixture'); }
}

async function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(SOURCE, 'arcfold-model-selection-owned-')));
  const profileDir = join(directory, 'profile'), nativeHome = join(directory, 'native-home');
  mkdirSync(nativeHome); initProfile(profileDir, ['settings-owned-fixture']);
  const bundle = join(profileDir, 'node_modules/settings-owned-fixture'); mkdirSync(bundle, { recursive: true });
  // Profile lies under the isolated installation. Official native Node package
  // lookup and Loader import reach its real ancestor node_modules, without a symlink.
  save(join(directory, 'package.json'), { name: 'settings-owned-installation' });
  save(join(bundle, 'package.json'), { name: 'settings-owned-fixture', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } });
  writeFileSync(join(profileDir, 'cordis.yml'), '[]\n');
  const config = { schema: 'arcfold-local-v1', main: { ...first, maxTokens: 64 }, learn: null,
    transport: { modelPolicies: policies, apiKeyRef: 'SYNTHETIC_UNUSED', endpoint: 'https://api.deepseek.com/anthropic/v1/messages' } };
  const plan = { config, nativeHome, workspace: directory, businessFilename: join(directory, 'business.sqlite'),
    installation: { coreRoot: SOURCE, profileDir } };
  const guardConfig = runtimeDeploymentPatches(plan).flatMap(row => row.insert ?? []).find(row => row.id === 'arcfold-runtime-guard').config;
  const rows = [
    { id: 'arcfold-runtime-guard', name: 'cordis:guard', config: guardConfig },
    { id: 'config-editor', name: 'cordis:editor' }, { id: 'settings', name: 'cordis:settings' },
    { id: 'agent-default-model', name: 'cordis:defaults', config: first },
    { id: 'llm', name: 'cordis:llm', inject: ['arcfoldRuntimeGuard'] },
    { id: 'session', name: 'cordis:session' }, { id: 'projections', name: 'cordis:projections' },
    { id: 'persistence', name: 'cordis:persistence', config: { root: join(directory, 'sessions'), compression: 'none' } },
    { id: 'system-prompt', name: 'cordis:prompt', config: { personaPrefix: '' } },
    { id: 'tools', name: 'cordis:tools' }, { id: 'tool-executor', name: 'cordis:executor' },
    { id: 'agents', name: 'cordis:agents' }, { id: 'agent-loop', name: 'cordis:loop', config: { agents: [] } },
    { id: 'session-query', name: 'cordis:query' }, { id: 'remote-access', name: 'cordis:access' },
    { id: 'session-controller', name: '@deepseek-ai/dsh-api-session-controller', config: { nativeOpen: false } },
    { id: 'arcfold-business', name: 'cordis:business' }, { id: 'preset-arcfold-main', name: 'cordis:preset' },
    { id: 'arcfold-metered-budget', name: 'cordis:budget' }, { id: 'arcfold-metered-provider', name: 'cordis:provider' },
    { id: 'arcfold-runtime-model-settings', name: 'cordis:models', config: { runtime: config } },
  ];
  save(join(bundle, 'cordis.patch.yml'), [{ insert: rows }]);
  const profile = { name: 'test', startedBundles: ['settings-owned-fixture'], dir: profileDir,
    patchPath: join(nativeHome, 'arcfold.patch.yml'), installAnchor: join(directory, 'package.json'),
    cwd: directory, home: nativeHome, overlays: [], telemetryDisabledEnv: undefined };
  const sent = [], handles = [], roots = [], secretReads = [];
  t.after(async () => { for (const handle of handles.reverse()) await handle.dispose();
    for (const ctx of roots.reverse()) await ctx.fiber.dispose(); });
  const start = async () => {
    const ctx = await boot('test', join(profileDir, 'cordis.yml'), readProfilePatches('test', profile), owner => {
      owner.provide('profileContext', profile);
      owner.provide('appReady', { onReady(listener) { listener(); return () => {}; } });
      // Inert peripherals satisfy the real controller's unrelated upload/remote
      // display dependencies; no Gateway authorization or complete Web boot is claimed.
      const noop = () => () => {};
      owner.provide('typert', { lookups: { configure: noop }, contexts: { configureHost: noop }, resources: { register: noop } });
      owner.provide('typertGateway', { getPendingRemoteEvents: () => [] });
      owner.provide('attachments', { imageLimits: { maxImageBytes: 1, maxImagesPerMessage: 1, maxMessageImageBytes: 1,
        maxImagePixels: 1, maxImageDimension: 1, mediaTypes: ['image/png'] } });
      owner.provide('fileUploads', { registerAgentResolver: noop });
      owner.provide('fs', {}); owner.provide('workspaceRegistry', { archivedSessionIds: [] });
      owner.provide('credentials', { describe: async () => ({ configured: false }), resolve() { secretReads.push('unexpected'); throw new Error('No credential access'); } });
      owner.plugin(PluginPackages);
      Object.assign(owner.loader.builtins, { guard: RuntimeGuard, editor: ConfigEditor, settings: Settings,
        defaults: DefaultModel, llm: LlmRuntime, session: SessionStore, projections: SessionProjections,
        persistence: JsonlPersistence, prompt: SystemPrompt, tools: ToolRuntime, executor: NativeToolExecutor,
        agents: AgentRegistry, loop: AgentLoop, query: PointQuery, access: RemoteAccess, models: RuntimeModels,
        business: { apply(child) { const store = new BusinessStore({ filename: plan.businessFilename });
          child.provide('arcfoldBusiness', store); child.effect(() => () => store.close()); } },
        preset: { apply() {} },
        budget: { inject: ['llm'], apply(child) { child.provide('arcfoldDeepSeekTransport',
          { configuration: { provider: first.provider, modelPolicies: policies } }); } },
        provider: { inject: ['llm', 'arcfoldDeepSeekTransport'], apply(child) { child.llm.registerAdapter([first.provider], new Catalog(sent)); } },
      });
    });
    roots.push(ctx); return ctx;
  };
  const ctx = await start();
  const entries = [...ctx.loader.entries()];
  const criticalFibers = Object.fromEntries(['llm', 'arcfold-business', 'preset-arcfold-main', 'session', 'session-controller',
    'agent-default-model', 'config-editor', 'arcfold-metered-budget', 'arcfold-metered-provider', 'arcfold-runtime-model-settings']
    .map(id => [id, actualRuntimeFiber(entries.find(row => row.options.id === id), ctx.root)]));
  const path = realpathSync(dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-api-session-controller/package.json'))));
  const receipt = join(SOURCE, 'model-selection-patch-receipt/report.json');
  plan.installation.modelSelection = { path, receipt, receiptSHA256: sha(readFileSync(receipt)),
    patchId: JSON.parse(readFileSync(join(SOURCE, 'patches/session-controller-0.2.2-rc.1-model-selection.json'))).id };
  const guard = RuntimeGuard.getRuntimeGuard(ctx);
  const arm = () => guard.arm({ criticalFibers, expectedAdapterUpdates: guard.snapshot().adapterUpdates,
    identifyRequest: options => nativeRequestIdentity(ctx.arcfoldBusiness, ctx.sessions, options) });
  const createAgent = async (host = ctx, id = 'settings-main') => {
    const handle = await host.agents.create({ sessionId: id, meta: { cwd: directory },
      agentOptions: { ...host.agentDefaultModel.currentSelection(), maxTokens: 64 },
      setup: async child => { child.tools.restrict({ allow: [] }); child.on('agent/pre-step', async () => ({ kind: 'reject' })); } });
    handles.push(handle); return handle.agent;
  };
  const evidence = value => save(join(directory, 'evidence.json'), value);
  t.diagnostic('Retained actual Loader/default/controller save fixture: ' + directory);
  return { ctx, guard, arm, plan, profile, criticalFibers, createAgent, start, roots, handles, sent, secretReads, evidence };
}

test('actual native controller saves through profile editor, retains guard and survives a cold default read', async t => {
  const f = await fixture(t);
  await inspectRuntimeModelSelection(f.ctx, f.plan, f.criticalFibers);
  assert.equal(RuntimeGuard.serviceIdentity(f.ctx.sessionController).constructor, SessionController);
  assert.equal(f.criticalFibers['session-controller'].runtime.callback, SessionController);
  assert.equal(f.arm().phase, 'ready');
  const agent = await f.createAgent(), originalFiber = f.criticalFibers['agent-default-model'];
  const defaultService = RuntimeGuard.serviceIdentity(f.ctx.agentDefaultModel);
  const identity = f.ctx.arcfoldRuntimeModels.identity;
  assert.equal(identity.fiber, f.criticalFibers['arcfold-runtime-model-settings']);
  assert.equal(identity.hookActive(), true);
  assert.equal(identity.controller, RuntimeGuard.serviceIdentity(f.ctx.sessionController));
  const updates = [];
  f.ctx.on('loader/volatile-update', function (paths) { updates.push({ fiber: this.fiber, paths }); }, { global: true });
  assert.deepEqual(await f.ctx.sessionController.selectModel({ sessionId: agent.id, ...second }), { selected: second });
  assert.deepEqual(agent.model.current(), second);
  assert.deepEqual(f.ctx.agentDefaultModel.currentSelection(), second);
  assert.equal(RuntimeGuard.serviceIdentity(f.ctx.agentDefaultModel), defaultService);
  assert.equal(originalFiber.state, 2); assert.equal(f.guard.snapshot().phase, 'ready');
  assert.ok(updates.some(row => row.fiber === originalFiber && row.paths.some(path => path.join('.') === 'model')));
  const persisted = parse(readFileSync(f.profile.patchPath, 'utf8'));
  assert.deepEqual(persisted.find(row => row.id === 'agent-default-model').config, second);
  const reader = await f.ctx.sessionPersistence.open(agent.id, 'read');
  let events; try { events = (await reader.read(0)).events; } finally { await reader.close(); }
  assert.equal(events.filter(row => row.type === 'model/selection' && row.data.model === second.model).length, 1);
  await f.handles.pop().dispose(); await f.roots.pop().fiber.dispose();
  const cold = await f.start();
  assert.deepEqual(cold.agentDefaultModel.currentSelection(), second);
  const next = await f.createAgent(cold, 'after-restart'); assert.deepEqual(next.model.current(), second);
  assert.deepEqual(f.sent, []); assert.deepEqual(f.secretReads, []);
  f.evidence({ saved: second, patchPath: f.profile.patchPath, nativeSelectionEvents: 1, coldDefault: cold.agentDefaultModel.currentSelection(),
    newAgentSelection: next.model.current(), controllerCapability: SessionController.modelSelectionSeam, modelRequests: f.sent.length, secretReads: f.secretReads.length });
});

test('missing controller proof and a default entry outside the editable profile cannot establish readiness', async t => {
  const f = await fixture(t);
  await assert.rejects(inspectRuntimeModelSelection(f.ctx, { ...f.plan, installation: { ...f.plan.installation, modelSelection: undefined } }, f.criticalFibers), /no native model-selection patch proof/);
  // A separately mounted real default plugin has no persistent Include entry.
  const detached = await f.ctx.isolate('agentDefaultModel').plugin(DefaultModel, first);
  try { await assert.rejects(inspectRuntimeModelSelection(f.ctx, f.plan,
    { ...f.criticalFibers, 'agent-default-model': detached.ctx.fiber }), /persistent profile editor/); }
  finally { await detached.dispose(); }
  assert.deepEqual(f.sent, []); assert.deepEqual(f.secretReads, []);
});

test('required handler disposal invalidates the real guard before adapter streaming', async t => {
  const f = await fixture(t); await inspectRuntimeModelSelection(f.ctx, f.plan, f.criticalFibers); f.arm();
  const identity = f.ctx.arcfoldRuntimeModels.identity;
  await f.criticalFibers['arcfold-runtime-model-settings'].dispose();
  assert.equal(identity.hookActive(), false); assert.equal(f.guard.snapshot().phase, 'requires-restart');
  const request = Object.freeze({ ...first, maxTokens: 64, sessionId: 'settings-main', messages: Object.freeze([]) });
  await assert.rejects(drain(f.ctx.llm.stream(request)), { code: 'ARCFOLD_RUNTIME_RESTART_REQUIRED' });
  assert.deepEqual(f.sent, []); assert.deepEqual(f.secretReads, []);
});
