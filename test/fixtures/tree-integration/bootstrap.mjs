import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import Group from '@deepseek-ai/cordis-plugin-group';
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm';
import SessionStore from '@deepseek-ai/dsh-session';
import SessionProjections from '@deepseek-ai/dsh-session-projection';
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import * as Executor from '@deepseek-ai/dsh-tool-executor-native';
import Agents from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import Presets from '@deepseek-ai/dsh-agent-preset-registry';
import Policy from '@deepseek-ai/dsh-sandbox-policy';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import Subprocess from '@deepseek-ai/dsh-subprocess-local';
import Sandbox from '@deepseek-ai/dsh-sandbox-local';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment';
import Credentials from '@deepseek-ai/dsh-credentials-local';
import * as Business from '../../../src/index.mjs';
import * as Provider from '../../../src/deepseek-provider.mjs';
import * as DesktopProvider from '../../../src/desktop/provider.mjs';
import * as NativeDeepSeek from '@deepseek-ai/dsh-llm-deepseek-api-key';
import * as NativePiAi from '@deepseek-ai/dsh-llm-pi-ai';
import * as TreeHost from '../../../src/tree/host.mjs';
import * as OldBudget from '../../../src/deepseek-budget-plugin.mjs';
import * as OldLearning from '../../../src/learning-plugin.mjs';
import * as OldPreparation from '../../../src/preparation-plugin.mjs';
import { active, sse, budgetManifest, provider, model } from '../tree-model/native.mjs';
import { initializeOwnedWebBudget } from '../../../src/web-budget-recovery.mjs';
import { digest } from '../../../src/tree/contracts.mjs';

/** Actual entry points. Default is synthetic loopback only. The explicit real
 * branch is restricted to the single authorized experiment and native guards. */
export async function bootstrapFixture(t, script, { nativeHost = false, realExperiment = null, webOnly = false, webMainModel = null, desktop = false, nativeModels = false } = {}) {
  assert.ok(!(webOnly && realExperiment), 'Real test budget and live website accounting are distinct');
  assert.ok(!(desktop && realExperiment), 'Desktop fixture is synthetic only');
  assert.equal(realExperiment, null, 'Public test fixtures support synthetic loopback only');
  const root = realExperiment?.resumeRoot ? realpathSync(realExperiment.resumeRoot) : realpathSync(mkdtempSync(join(realExperiment?.workspaceParent ?? tmpdir(), 'tree-bootstrap-'))), ctx = new Context(); ctx.baseUrl = import.meta.url;
  const workspace = join(root, 'workspace'), privateRoot = realExperiment?.root ?? join(root, 'private'), runtimeRoot = join(root, 'processes');
  for (const path of [workspace, privateRoot, runtimeRoot]) mkdirSync(path, { recursive: true });
  const requests = [], handles = [];
  const server = createServer((req, res) => { void (async () => {
    const parts = []; for await (const chunk of req) parts.push(chunk); const body = JSON.parse(Buffer.concat(parts));
    let input;
    for (const message of body.messages) for (const block of message.content ?? []) if (block.type === 'text') {
      try { const value = JSON.parse(block.text); if (value.jobId && value.role) input = value; } catch {}
    }
    const row = { ordinal: requests.length + 1, role: input?.role ?? 'main', input, body, url: req.url }; requests.push(row);
    const result = await script(row, ctx.get('arcfoldTreeRuntime'));
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'synthetic-bootstrap-' + row.ordinal }); res.end(sse(body, result));
  })().catch(error => res.destroy(error)); });
  if (!realExperiment) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    const runtime = ctx.get('arcfoldTreeRuntime');
    await runtime?.idle();
    writeFileSync(join(root, realExperiment?.resumeRoot ? 'evidence-e01-resume.json' : 'evidence.json'), JSON.stringify({ kind: realExperiment ? 'actual-v3-entrypoints-native-loop-real-provider-shared-finite-ledger' : 'actual-v3-entrypoints-native-loop-synthetic-loopback-provider', requests,
      jobs: runtime?.repo.list('tree_jobs'), invocations: runtime?.repo.list('tree_invocations'), diagnostics: runtime?.repo.meta().runtimeDiagnostics,
      ledger: ctx.get('arcfoldDeepSeekTransport')?.summary(), nativeRecords: ctx.get('arcfoldNativeModelRecords')?.summary() }, null, 2), realExperiment?.resumeRoot ? { flag: 'wx' } : undefined);
    for (const handle of handles) await handle.dispose(); await ctx.fiber.dispose();
    if (server.listening) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  });
  t.diagnostic('Retained B7 bootstrap evidence: ' + root);
  await active(await ctx.plugin(Loader)); ctx.loader.builtins.group = Group;
  for (const plugin of [LlmRuntime, SessionStore, SessionProjections]) await active(await ctx.plugin(plugin));
  await active(await ctx.plugin(Persistence, { root: join(realExperiment?.phaseDirectory ?? privateRoot, 'sessions'), compression: 'none' }));
  for (const plugin of [SystemPrompt, Tools, Executor, Agents]) await active(await ctx.plugin(plugin));
  await active(await ctx.plugin(AgentLoop, { agents: [] }));
  await active(await ctx.plugin(Presets, { default: 'arcfold-main' }));
  await active(await ctx.plugin({ inject: ['agentPresets'], async *apply(child) {
    for (const id of ['arcfold-main', 'arcfold-tree-reader', 'arcfold-tree-writer']) yield await child.agentPresets.register({ id,
      plugins: id === 'arcfold-main' ? [{ id: 'arcfold-agent', name: new URL('../../../src/agent.mjs', import.meta.url).href }] : [] });
  } }));
  await active(await ctx.plugin({ apply(child) {
    if (!nativeHost) child.provide('workingDirectory', { get: () => workspace });
    if (!realExperiment) child.provide('credentials', { resolve: async () => ({ value: 'synthetic-key-never-real' }) });
    child.provide('launchEnvironment', realExperiment?.environment ?? createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]));
  } }));
  if (realExperiment) await active(await ctx.plugin(Credentials, { path: realExperiment.credentialPath, watch: false }));
  await active(await ctx.plugin(Policy, { mode: 'workspace-write', workspaceRoot: workspace }));
  const config = { enabled: true, privateRoot, runtimeRoot, workspace, treeFilename: join(realExperiment?.phaseDirectory ?? privateRoot, 'tree.sqlite'), userId: 'synthetic-owner', stage: realExperiment?.stage ?? 'smoke',
    tokenCounter: { python: process.env.ARCFOLD_TREE_ENCODING_PYTHON },
    models: Object.fromEntries(['main', 'attribution', 'learning', 'consolidation', 'verification', 'improvement', 'script_writer'].map(role => [role, { provider, model, reasoningEffort: 'off', maxTokens: 2048 }])),
    budget: { ledgerPath: join(privateRoot, 'test-ledger.sqlite'), artifactDirectory: join(privateRoot, 'requests'), authorizationRef: 'offline-synthetic-no-real-spend', manifest: budgetManifest, create: true,
      endpoint: realExperiment ? 'https://api.deepseek.com/anthropic/v1/messages' : `http://127.0.0.1:${server.address().port}/anthropic/v1/messages`, allowLocalTestEndpoint: !realExperiment, timeoutMs: 3000 } };
  if (realExperiment) {
    config.models = realExperiment.models;
    config.budget = { ledgerPath: join(privateRoot, 'test-ledger.sqlite'), artifactDirectory: join(privateRoot, 'requests'),
      authorizationRef: realExperiment.manifest.authorizationRef, manifest: realExperiment.manifest.budget, create: true,
      endpoint: 'https://api.deepseek.com/anthropic/v1/messages', allowLocalTestEndpoint: false, timeoutMs: 60000 };
  }
  if (webOnly) {
    const artifactDirectory = join(privateRoot, 'web-requests');
    const webAuthorization = { authorizationRef: 'synthetic-web-only-tree', authorizedAt: '2026-11-13T00:00:00.000Z', authorizationEvidence: 'Synthetic website accounting test, no real model spending.' };
    await initializeOwnedWebBudget({ artifactDirectory, webAuthorization });
    const priceVersion = digest(budgetManifest);
    config.budget = { mode: 'web-only', scope: 'web-unlimited', webAuthorization, artifactDirectory, ledgerPath: join(artifactDirectory, 'deepseek-web.sqlite'),
      modelPolicies: { [model]: { contextWindow: budgetManifest.inputBound, maxOutputTokens: 8192, requestMaxTokens: 8192, reasoningEfforts: ['off', 'low', 'high', 'max'], prices: budgetManifest.prices, priceVersion } },
      endpoint: `http://127.0.0.1:${server.address().port}/anthropic/v1/messages`, allowLocalTestEndpoint: true, timeoutMs: 3000 };
    config.stage = 'live';
    for (const selected of Object.values(config.models)) selected.modelVersion = budgetManifest.modelVersion;
    if (webMainModel) {
      config.models.main = { ...config.models.main, model: webMainModel, modelVersion: 'synthetic-pro-version', reasoningEffort: 'max' };
      config.budget.modelPolicies[webMainModel] = { ...config.budget.modelPolicies[model], priceVersion: 'synthetic-pro-price' };
    }
  }
  if (desktop) { config.adapter = 'desktop-private-v1'; config.followConversationModel = true; }
  const initialModel = nativeModels ? { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off' } : config.models.main;
  if (nativeModels) {
    delete config.models; delete config.budget; delete config.tokenCounter;
    Object.assign(config, { adapter: 'dsh-native-v1', followConversationModel: true,
      accounting: { artifactDirectory: join(privateRoot, 'requests'), authorization: { authorizationRef: 'synthetic-native-no-spend' } } });
    if (!nativeHost) await active(await ctx.plugin(TokenMeter));
  }
  await active(await ctx.plugin(Business, { filename: join(root, 'legacy.sqlite'), goalTreeV3: config }));
  if (nativeModels) {
    const base = `http://127.0.0.1:${server.address().port}`;
    await active(await ctx.plugin(NativeDeepSeek, { apiKeyEnv: 'SYNTHETIC_KEY_REFERENCE', baseURL: base + '/anthropic', maxTokens: 4096 }));
    await active(await ctx.plugin(NativePiAi, { providers: { 'synthetic-other': { api: 'anthropic-messages', baseURL: base + '/other',
      apiKeyEnv: 'SYNTHETIC_KEY_REFERENCE', models: [{ id: 'synthetic-other-model', name: 'Synthetic other model', contextWindow: 32000, maxTokens: 4096, reasoningEfforts: false }] } } }));
  } else await active(await ctx.plugin(desktop ? DesktopProvider : Provider, { apiKeyRef: realExperiment ? 'ARCFOLD_DEEPSEEK_API_KEY' : 'SYNTHETIC_KEY_REFERENCE', maxTokens: config.models.main.maxTokens, reasoningEffort: config.models.main.reasoningEffort }));
  if (nativeHost) {
    for (const plugin of [Subprocess, Sandbox, TokenMeter]) await active(await ctx.plugin(plugin));
    for (const component of ['filesystem', 'shell', 'compaction', 'goal']) await active(await ctx.plugin(TreeHost, { component, ...(component === 'shell' ? { timeoutMs: 60000 } : {}) }));
    await active(await ctx.plugin(WorkingDirectory, { defaultDirectory: workspace }));
    // The actual old root entries remain dependency-inactive in tree mode.
    for (const plugin of [OldBudget, OldLearning, OldPreparation]) await ctx.plugin(plugin, {});
  }
  const runtime = ctx.arcfoldTreeRuntime;
  // Existing offline fixtures replay old frozen replies. New real calls use
  // the production default and the dedicated compact-protocol fixture.
  if (!realExperiment) runtime.learning.outputProtocol = 'legacy-v3';
  if (realExperiment?.repairEvidence) {
    // Experiment provenance only: do not change input, permissions, result or
    // job identity. Every native request must justify use of the repair reserve.
    const enqueue = runtime.jobs.enqueue.bind(runtime.jobs);
    runtime.jobs.enqueue = spec => enqueue({ ...spec, trigger: { ...spec.trigger, repairEvidence: realExperiment.repairEvidence } });
  }
  async function main(id, setup = async () => {}, resume = false) {
    const handle = await (resume ? ctx.agents.resume.bind(ctx.agents) : ctx.agents.create.bind(ctx.agents))({ ...(resume ? { resumeSessionId: id } : { sessionId: id }), meta: { cwd: workspace, agentPreset: 'arcfold-main' }, agentOptions: initialModel,
      setup: async (owner, agent) => { await ctx.agentPresets.mount(owner, 'arcfold-main'); await setup(owner, agent); } }); handles.push(handle); return handle.agent;
  }
  async function turn(agent, text) {
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })); await agent.whenIdle(); await runtime.idle();
    const row = runtime.repo.list('tree_turns', t => t.sessionId === agent.session.id).at(-1);
    assert.ok(row, JSON.stringify(agent.session.snapshotEvents().at(-1))); return row;
  }
  return { root, workspace, privateRoot, runtimeRoot, ctx, runtime, repo: runtime.repo, requests, main, turn, config };
}
