import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
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
import Tools, { defineTool } from '@deepseek-ai/dsh-tools';
import * as Executor from '@deepseek-ai/dsh-tool-executor-native';
import Agents from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import Presets from '@deepseek-ai/dsh-agent-preset-registry';
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment';
import { TreeRepository } from '../../../src/tree/repository.mjs';
import { TreeJobs } from '../../../src/tree/jobs.mjs';
import { TreeModelOwner } from '../../../src/tree/model-owner.mjs';
import { TreeTestLedger, TREE_TEST_SCOPE } from '../../../src/tree/experiment-budget.mjs';
import { DeepSeekTransport } from '../../../src/deepseek-transport.mjs';
import * as Provider from '../../../src/deepseek-provider.mjs';
import { registerTreeRequestAuthority, nativeRequestIdentity, assertNativeRequestCurrent } from '../../../src/native-request-authority.mjs';
import { digest } from '../../../src/tree/contracts.mjs';
import { minimal, envelope } from './contracts.mjs';

export const model = 'deepseek-flash', provider = 'deepseek-official';
export const budgetManifest = { budgetScope: TREE_TEST_SCOPE, ceilingCny: 150, model, modelVersion: 'synthetic-offline-fixture-not-live-version-proof', prices: { input: 2, output: 8, cachedInput: 0.04 }, inputBound: 1000000, outputCap: 8192, verification: { at: '2026-11-12T00:00:00.000Z', urls: ['https://example.test/synthetic-offline-pricing'], contentHashes: [digest('synthetic-only')], adapterVersion: 'deepseek-messages-create-transport-v1' } };
export async function active(fiber) { const deadline = Date.now() + 5000; for (;;) { await fiber.await(); if (fiber.state === 2) return; assert.ok([0, 1].includes(fiber.state) && Date.now() < deadline, 'Native plugin activates'); await new Promise(r => setTimeout(r, 1)); } }
const event = (type, fields = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
export function sse(body, result, { usage = true, terminal = true, stopReason, reasoningOnly = false } = {}) {
  const tool = result.tool, final = typeof result === 'string' ? result : JSON.stringify(result.output ?? result);
  return event('message_start', { message: { id: 'synthetic-receipt', model: body.model, role: 'assistant', content: [], usage: { input_tokens: 100, output_tokens: 0 } } }) +
    event('content_block_start', { index: 0, content_block: tool ? { type: 'tool_use', id: tool.id ?? 'call-fixture', name: tool.name, input: {} } : reasoningOnly ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' } }) +
    event('content_block_delta', { index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(tool.args ?? {}) } : reasoningOnly ? { type: 'thinking_delta', thinking: final } : { type: 'text_delta', text: final } }) + event('content_block_stop', { index: 0 }) +
    event('message_delta', { delta: { stop_reason: stopReason ?? (tool ? 'tool_use' : 'end_turn') }, ...(usage ? { usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } : {}) }) + (terminal ? event('message_stop') : '');
}
export async function nativeFixture(t, script = ({ role }) => minimal[role] ?? '主助手的合成答复', fixtureOptions = {}) {
  const root = fixtureOptions.root ?? realpathSync(mkdtempSync(join(tmpdir(), 'tree-model-native-'))), ctx = new Context(); ctx.baseUrl = import.meta.url;
  const repo = new TreeRepository({ treeFilename: join(root, 'tree.sqlite'), userId: 'fixture-user' });
  const jobs = new TreeJobs({ repository: repo, assertSources: sources => sources.every(s => s.ref?.sha256?.length === 64) });
  const ledger = new TreeTestLedger({ filename: join(root, 'test-ledger.sqlite'), authorizationRef: 'offline-fixture-150-not-real-spend', manifest: budgetManifest, create: true });
  const business = { get: () => null, listAll: () => [] }, requests = [], handles = [], toolRuns = [];
  const server = createServer((req, res) => { void (async () => {
    const parts = []; for await (const chunk of req) parts.push(chunk); const body = JSON.parse(Buffer.concat(parts).toString());
    let input;
    for (const message of body.messages) for (const block of message.content ?? []) if (block.type === 'text') { try { const v = JSON.parse(block.text); if (v.jobId && v.role) input = v; } catch {} }
    const role = input?.role ?? 'main', row = { ordinal: requests.length + 1, role, body, input }; requests.push(row);
    const result = await script(row, { ctx, jobs, repo, ledger, requests });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': `synthetic-${row.ordinal}` }); res.end(sse(body, result, fixtureOptions.sseOptions));
  })().catch(e => res.destroy(e)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const endpoint = `http://127.0.0.1:${server.address().port}/anthropic/v1/messages`;
  const owner = new TreeModelOwner({ jobs, host: ctx, createUserMessage, timers: fixtureOptions.timers, ledgerLookup: id => ledger.get(id), verifyMainInput: (job, options) => job.role === 'main' && options.messages.some(m => m.source?.kind === 'user'),
    mountWriterTools: async agentCtx => { for (const name of ['writer_read', 'writer_finish']) agentCtx.tools.register(defineTool({ name, description: 'Synthetic broker marker; no filesystem access', parameters: {}, output: { schema: { type: 'json' }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] }, execute: async () => { toolRuns.push(name); return { ok: true }; } })); } });
  const unregister = registerTreeRequestAuthority(business, owner);
  const transport = new DeepSeekTransport({ ledger, artifactDirectory: join(root, 'requests'), provider, modelPolicies: { [model]: ledger.modelPolicy() }, endpoint, allowLocalTestEndpoint: true, timeoutMs: 3000, requestIdentity: options => nativeRequestIdentity(business, ctx.sessions, options), beforeDispatch: options => assertNativeRequestCurrent(ctx, options) });
  let closing;
  const shutdown = () => closing ??= (async () => {
    try { await owner.close(); for (const handle of handles) await handle.dispose();
      writeFileSync(join(root, fixtureOptions.evidenceName ?? 'evidence.json'), JSON.stringify({ kind: 'real-native-agent-patched-adapter-loopback-provider-synthetic-receipts', requests, jobs: repo.list('tree_jobs'), invocations: repo.list('tree_invocations'), ledger: ledger.summary(), toolRuns }, null, 2));
      await ctx.fiber.dispose(); await transport.close();
    } finally { unregister(); ledger.close(); repo.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
  })();
  t.after(shutdown);
  t.diagnostic('Retained B2 native evidence: ' + root);
  await active(await ctx.plugin(Loader)); ctx.loader.builtins.group = Group;
  for (const plugin of [LlmRuntime, SessionStore, SessionProjections]) await active(await ctx.plugin(plugin));
  await active(await ctx.plugin(Persistence, { root: join(root, 'sessions'), compression: 'none' }));
  await active(await ctx.plugin(SystemPrompt));
  for (const plugin of [Tools, Executor, Agents]) await active(await ctx.plugin(plugin));
  await active(await ctx.plugin(AgentLoop, { agents: [] })); await active(await ctx.plugin(Presets, { default: 'tree-fixture' }));
  await active(await ctx.plugin({ inject: ['agentPresets'], async *apply(child) { yield await child.agentPresets.register({ id: 'tree-fixture', plugins: [] }); } }));
  await active(await ctx.plugin({ apply(child) {
    child.provide('arcfoldBusiness', business); child.provide('workingDirectory', { get: () => root });
    child.provide('credentials', { resolve: async () => ({ value: 'synthetic-key-never-real' }) });
    child.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]));
    child.provide('arcfoldDeepSeekTransport', { configuration: { provider, endpoint, modelPolicies: { [model]: ledger.modelPolicy() } }, createTransport: options => transport.createTransport(options) });
    child.on('llm/stream', (options, next) => owner.guardStream(options, next));
  } }));
  await active(await ctx.plugin(Provider, { apiKeyRef: 'SYNTHETIC_KEY_REFERENCE', maxTokens: 1024, reasoningEffort: 'off' }));
  let sequence = 0;
  function enqueue(role, override = {}) {
    const input = envelope(role, [repo.rootId()]); input.scope.ancestorPaths = [[repo.rootId()]]; input.scope.treeRevision = repo.meta().treeRevision; input.allowedIds.nodeIds = [repo.rootId()]; input.knownItems = [];
    const kinds = { main: 'user_turn', attribution: 'human_input', learning: 'settled_main_turn', consolidation: 'leave_timeout', verification: 'window', improvement: 'repair_group', script_writer: 'explicit_script_request' };
    const trigger = { ...input.trigger, kind: kinds[role], producerRole: ['main', 'attribution'].includes(role) ? 'user' : role === 'learning' ? 'main' : 'program', origin: 'user', status: 'settled', ordinal: ++sequence, nativeSessionId: 'real-main', nativeTurn: 1, ...override.trigger };
    const config = { provider, model, reasoningEffort: 'off', maxTokens: 1024, preset: 'tree-fixture', cwd: root, modelVersion: budgetManifest.modelVersion, priceVersion: ledger.manifestHash, budgetScope: TREE_TEST_SCOPE, stage: 'smoke' };
    return jobs.enqueue({ role, key: `${role}-${sequence}`, nodeIds: [repo.rootId()], input, revisionSet: {}, config, ...override, trigger });
  }
  async function runMain() {
    const job = enqueue('main'); jobs.prepare(job.id); jobs.submit(job.id);
    const handle = await ctx.agents.create({ sessionId: job.trigger.nativeSessionId, agentOptions: { provider, model, reasoningEffort: 'off', maxTokens: 1024 }, setup: agentCtx => owner.attachMain(agentCtx) }); handles.push(handle);
    handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '这是合成用户轮，请给一个简短答复。' }] })); await handle.agent.whenIdle(); assert.equal(await ctx.sessions.flush(handle.agent.session), true);
    return owner.consume(job.id, await owner.readEvents(handle.agent.session.id, handle));
  }
  return { root, ctx, repo, jobs, owner, ledger, transport, business, requests, toolRuns, enqueue, runMain, handles, shutdown };
}
