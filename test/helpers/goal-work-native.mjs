import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import Group from '@deepseek-ai/cordis-plugin-group';
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm';
import SessionStore from '@deepseek-ai/dsh-session';
import SessionProjections from '@deepseek-ai/dsh-session-projection';
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry';
import GoalService from '@deepseek-ai/dsh-goal';
import { TYPERT as GoalTypert } from '@deepseek-ai/dsh-goal/typert';
import * as Connection from '@deepseek-ai/dsh-client-connection';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import TypertGateway from '@deepseek-ai/dsh-api-gateway';
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access';
import Commands from '@deepseek-ai/dsh-commands';
import LocalJobs from '@deepseek-ai/dsh-jobs-local';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox';
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy';
import * as BusinessPlugin from '../../src/index.mjs';
import * as LearnPlugin from '../../src/learning-plugin.mjs';

const response = text => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', reason: { kind: 'stop' } },
];
async function active(fiber) {
  const deadline = Date.now() + 5000;
  for (;;) {
    await fiber.await(); if (fiber.state === 2) return fiber;
    assert.ok([0, 1].includes(fiber.state) && Date.now() < deadline, 'Official plugin must activate');
    await delay(1);
  }
}
async function bounded(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' timed out')), 10000);
  })]); } finally { clearTimeout(timer); }
}
class ScriptedAdapter extends LlmAdapter {
  requests = [];
  constructor(script) { super(); this.script = script; }
  async resolveModel(provider, id) {
    return { provider, id, name: id, inputModalities: ['text'], defaultMaxTokens: 64,
      reasoning: { efforts: [{ id: 'off', name: 'off' }], defaultEffort: 'off' } };
  }
  async * stream(options) {
    await this.beforeSend?.(options);
    this.requests.push(options);
    const entry = await this.script(options, this.requests.length);
    assert.ok(Array.isArray(entry), 'No implicit extra fixture model call');
    yield* entry;
  }
}
async function nativeFixture(t, script, { business = false, learning = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'arcfold-native-continuation-')));
  t.diagnostic('Retained native continuation fixture: ' + root);
  const ctx = new Context();
  ctx.baseUrl = import.meta.url;
  const handles = [];
  t.after(async () => {
    for (const handle of handles) await handle.dispose();
    await ctx.get('arcfoldLearning')?.close();
    writeFileSync(join(root, 'native-at-teardown.json'), JSON.stringify(handles.map(handle => ({
      sessionId: handle.agent.id, events: handle.agent.session.snapshotEvents() })), null, 2));
    const business = ctx.get('arcfoldBusiness');
    if (business) writeFileSync(join(root, 'business-at-teardown.json'), JSON.stringify(
      ['deliveries', 'context_snapshots', 'learning_runs', 'learning_pending', 'bridge_failures',
        'execution_stages', 'stage_decisions', 'goal_works', 'goal_work_controls'].flatMap(kind =>
        business.listAll(kind).map(body => ({ kind, body }))), null, 2));
    await ctx.fiber.dispose();
  });
  await active(await ctx.plugin(Loader)); ctx.loader.builtins.group = Group;
  for (const plugin of [LlmRuntime, SessionStore, SessionProjections]) await active(await ctx.plugin(plugin));
  await active(await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions'), compression: 'none' }));
  await active(await ctx.plugin(SystemPrompt, { personaPrefix: 'Only execute the explicit native fixture delegation.' }));
  for (const plugin of [ToolRuntime, NativeToolExecutor, AgentRegistry, GoalService, Commands]) await active(await ctx.plugin(plugin));
  await active(await ctx.plugin(AgentLoop, { agents: [] }));
  await active(await ctx.plugin(AgentPresets, { default: 'main' }));
  await active(await ctx.plugin(LocalJobs));
  const driverEntry = ctx.loader.resolve(await ctx.loader.create({ id: 'goal-round-driver', name: '@deepseek-ai/dsh-goal-round-driver' }));
  const driver = await active(driverEntry.fiber);
  const adapter = new ScriptedAdapter(script); ctx.llm.registerAdapter(['fixture'], adapter);
  if (business) {
    await active(await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: root }));
    await active(await ctx.plugin(SandboxedFileSystem, { cwd: root }));
    await active(await ctx.plugin(WorkingDirectory, { defaultDirectory: root }));
    await active(await ctx.plugin(BusinessPlugin, { filename: join(root, 'business.sqlite') }));
  }
  const mainPlugins = [
    ...(business ? [{ name: new URL('../../src/agent.mjs', import.meta.url).href }] : [
      { name: import.meta.resolve('@deepseek-ai/dsh-command-goal') },
      { name: import.meta.resolve('@deepseek-ai/dsh-tool-goal') },
    ]),
    { name: import.meta.resolve('@deepseek-ai/dsh-tool-jobs'), config: { completionDelivery: 'quiet' } },
  ];
  async function declare(id, plugins) {
    return active(await ctx.plugin({ inject: ['agentPresets'], async * apply(owner) {
      yield await owner.agentPresets.register({ id, plugins });
    } }));
  }
  const declaration = await declare('main', mainPlugins);
  await declare('learn', []);
  if (learning) await active(await ctx.plugin(LearnPlugin, { preset: 'learn', cwd: root,
    provider: 'fixture', model: 'fixture', reasoningEffort: 'off', maxTokens: 64 }));
  async function agent(id, preset = 'main', setup = async () => {}) {
    const handle = await ctx.agents.create({ sessionId: id, meta: { cwd: root },
      agentOptions: { provider: 'fixture', model: 'fixture', maxTokens: 64 },
      setup: async owner => { await ctx.agentPresets.mount(owner, preset); await setup(owner); } });
    handles.push(handle); return handle.agent;
  }
  return { ctx, root, driver, driverEntry, adapter, agent, declare, declaration, mainPlugins,
    release: agent => handles.find(handle => handle.agent === agent).dispose(),
    async resume(id) {
      const handle = await ctx.agents.resume({ resumeSessionId: id,
        agentOptions: { provider: 'fixture', model: 'fixture', maxTokens: 64 },
        setup: async owner => { await ctx.agentPresets.mount(owner, 'main'); } });
      handles.push(handle); return handle.agent;
    } };
}

const callResponse = (id, name, args) => [
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) } },
  { type: 'finish', reason: { kind: 'tool-calls' } },
];
const emptyLearning = JSON.stringify({ understandings: [], methods: [], opportunities: [], goals: [] });
async function waitGate(gate, signal) {
  signal?.throwIfAborted();
  if (!signal) return gate.promise;
  const cancellation = Promise.withResolvers();
  const abort = () => cancellation.reject(signal.reason ?? new Error('aborted'));
  signal.addEventListener('abort', abort, { once: true });
  try { await Promise.race([gate.promise, cancellation.promise]); }
  finally { signal.removeEventListener('abort', abort); }
}
async function eventually(fn, label) {
  const deadline = Date.now() + 10000;
  while (!fn()) { assert.ok(Date.now() < deadline, label); await delay(2); }
}

async function nativeRemote(f) {
  let record;
  f.ctx.provide('credentials', { readRecord: async () => record,
    async modifyRecord(_key, change) { record = await change(record); return record; } });
  await active(await f.ctx.plugin({ apply(owner) {
    owner.provide('webServer', { host: '127.0.0.1', protocol: 'http:', port: 0,
      register: () => () => {}, registerUpgrade: () => () => {}, tapIndex: () => () => {} });
  } }));
  for (const plugin of [Connection, TypertRegistry, RemoteAccess, TypertGateway]) await active(await f.ctx.plugin(plugin));
  f.ctx.typert.register(GoalTypert);
  return (method, agent, ref, request) => f.ctx.typertGateway.invoke({ namespace: 'goals', method,
    args: { agentId: agent.id, ref, ...(request ? { request } : {}) }, peer: f.ctx.connection.browserPeer });
}


export { nativeFixture, nativeRemote, response, callResponse, bounded, eventually, waitGate, emptyLearning };
