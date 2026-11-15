import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import Group from '@deepseek-ai/cordis-plugin-group';
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import SessionStore from '@deepseek-ai/dsh-session';
import SessionProjections from '@deepseek-ai/dsh-session-projection';
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry';
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox';
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy';
import * as Observation from '@deepseek-ai/dsh-fs-observation-policy';
import * as BusinessPlugin from '../src/index.mjs';
import * as LearnPlugin from '../src/learning-plugin.mjs';
import * as Preparation from '../src/preparation-plugin.mjs';
import { nativeRequestIdentity, assertNativeRequestCurrent } from '../src/native-request-authority.mjs';

const response = text => [{ type: 'block-start', index: 0, blockType: 'text' },
  { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }];
const tool = (id, name, args) => [{ type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) } },
  { type: 'finish', reason: { kind: 'tool-calls' } }];
async function active(fiber) {
  const deadline = Date.now() + 5000;
  for (;;) { await fiber.await(); if (fiber.state === 2) return fiber;
    assert.ok([0, 1].includes(fiber.state) && Date.now() < deadline, 'Official plugin must activate'); await delay(1); }
}
class Adapter extends LlmAdapter {
  requests = [];
  constructor(script) { super(); this.script = script; }
  async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: ['text'], defaultMaxTokens: 64,
    reasoning: { efforts: [{ id: 'off', name: 'off' }], defaultEffort: 'off' } }; }
  async *stream(options) {
    this.before?.(options); this.requests.push(options);
    const result = await this.script(options, this.requests.length); assert.ok(Array.isArray(result), 'No extra implicit model request'); yield* result;
  }
}
async function fixture(t, script, { observation = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'arcfold-native-preparation-')));
  t.diagnostic('Retained real native preparation fixture: ' + root);
  const ctx = new Context(); ctx.baseUrl = import.meta.url;
  t.after(async () => {
    await ctx.get('arcfoldPreparation')?.close();
    const business = ctx.get('arcfoldBusiness');
    if (business && !business.storage.closed) writeFileSync(join(root, 'preparation-evidence.json'), JSON.stringify(
      ['preparation_runs', 'preparation_artifacts', 'notifications'].flatMap(kind => business.listAll(kind).map(body => ({ kind, body }))), null, 2));
    await ctx.fiber.dispose();
  });
  await active(await ctx.plugin(Loader)); ctx.loader.builtins.group = Group;
  for (const plugin of [LlmRuntime, SessionStore, SessionProjections]) await active(await ctx.plugin(plugin));
  await active(await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions'), compression: 'none' }));
  await active(await ctx.plugin(SystemPrompt));
  for (const plugin of [ToolRuntime, NativeExecutor, AgentRegistry]) await active(await ctx.plugin(plugin));
  await active(await ctx.plugin(AgentLoop, { agents: [] }));
  await active(await ctx.plugin(AgentPresets, { default: Preparation.PREPARATION_PRESET }));
  await active(await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: root }));
  await active(await ctx.plugin(SandboxedFileSystem, { cwd: root }));
  await active(await ctx.plugin(WorkingDirectory, { defaultDirectory: root }));
  if (observation) await active(await ctx.plugin(Observation));
  ctx.on('tools/result', (exec, result) => { if (exec.name === 'write') writeFileSync(join(root, 'actual-write-result.json'), JSON.stringify({ name: exec.name, result }, null, 2)); });
  const adapter = new Adapter(script); ctx.llm.registerAdapter(['fixture'], adapter);
  await active(await ctx.plugin(AgentDefaultModel, { provider: 'fixture', model: 'fixture', reasoningEffort: 'off' }));
  await active(await ctx.plugin(BusinessPlugin, { filename: join(root, 'business.sqlite') }));
  await active(await ctx.plugin({ inject: ['agentPresets'], async *apply(owner) {
    yield await owner.agentPresets.register({ id: Preparation.PREPARATION_PRESET, plugins: [
      { name: '@deepseek-ai/dsh-tool-executor-native' },
      { name: '@deepseek-ai/dsh-tool-fs', config: Preparation.PREPARATION_TOOL_CONFIG },
    ] });
  } }));
  await active(await ctx.plugin(Preparation, { cwd: root, maxTokens: 64 }));
  const service = ctx.arcfoldOpportunities, store = ctx.arcfoldBusiness.storage, runner = ctx.arcfoldPreparation;
  store.save('host_bindings', { id: 'main', role: 'main' });
  const source = store.save('events', { id: 'source', conversationId: 'main', role: 'user', content: '先准备一份新稿让我审阅。' });
  service.savePermission({ sessionId: 'main', enabled: true, extraSourceIds: [], files: [], expectedRevision: 0,
    requestId: 'permission', userIdentity: 'browser:owner' });
  const opportunity = store.save('opportunities', { id: 'opportunity', conversationId: 'main', learnedFromRunId: 'learn',
    sourceIds: [source.id], dependencies: [{ kind: 'events', id: source.id, revision: 1 }],
    status: 'pending', description: '准备稿件', rationale: '用户希望先审阅', suggestedPreparation: '新建一页文字稿' });
  store.save('learning_sections', { id: 'learn:opportunities', status: 'completed', ids: [opportunity.id] });
  adapter.before = options => { const identity = nativeRequestIdentity(ctx.arcfoldBusiness, ctx.sessions, options);
    assert.ok(['main', 'learning', 'preparation'].includes(identity.metadata.role)); assertNativeRequestCurrent(ctx, options); };
  return { ctx, root, service, store, runner, adapter, opportunity, source,
    start: () => runner.kick(), run: () => store.listAll('preparation_runs')[0] };
}

test('real native Agent creates one draft, reads full long Unicode/CRLF text and publishes once with no main binding', async t => {
  const content = '完整长行😀'.repeat(600) + '\r\n\ntruncated 是正常原文。'; let f;
  f = await fixture(t, (_options, count) => count === 1 ? tool('write-draft', 'write', { file_path: f.run().artifact.path, content })
    : count === 2 ? tool('read-draft', 'read', { file_path: f.run().artifact.path }) : response('已准备好，请审阅。'));
  await f.start(); const run = f.run();
  assert.equal(run.state, 'settled', JSON.stringify(run.error));
  assert.equal(f.adapter.requests.length, 3); assert.equal(readFileSync(run.artifact.path, 'utf8'), content);
  assert.equal(f.store.listAll('preparation_artifacts').length, 1); assert.equal(f.store.listAll('notifications').length, 1);
  assert.equal(f.store.get('host_bindings', run.sessionId), null); assert.equal(f.store.listAll('learning_pending').length, 0);
  assert.equal(run.requests.length, 3); assert.equal(run.tools.length, 2);
  const before = f.adapter.requests.length; await f.runner.recover(); await f.runner.kick(); assert.equal(f.adapter.requests.length, before);
});
test('native missing createIfAbsent policy refuses write; no fake artifact success', async t => {
  let f; f = await fixture(t, (_options, count) => count === 1 ? tool('write', 'write', { file_path: f.run().artifact.path, content: 'draft' }) : response('写入未获准。'), { observation: false });
  await f.start(); assert.notEqual(f.run().state, 'settled'); assert.equal(f.store.listAll('preparation_artifacts').length, 0);
});


test('source withdrawn in an awaited native tool policy is denied after policy resolves, before write body', async t => {
  let f; const entered = Promise.withResolvers(), release = Promise.withResolvers();
  f = await fixture(t, (_options, count) => count === 1 ? tool('write', 'write', { file_path: f.run().artifact.path, content: 'never written' }) : response('Stopped'));
  f.ctx.on('tools/pre-execute', async (exec, next) => { if (exec.name === 'write') { entered.resolve(exec); await release.promise; } return next(); });
  const active = f.start(); const exec = await entered.promise;
  assert.equal(exec.signal.aborted, false);
  f.store.save('source_controls', { id: f.source.id, withdrawn: true }); release.resolve(); await active;
  assert.equal(existsSync(f.run().artifact.path), false); assert.equal(f.store.listAll('preparation_artifacts').length, 0);
  assert.equal(f.adapter.requests.length, 1); const before = f.adapter.requests.length;
  await f.runner.recover(); await f.runner.kick(); assert.equal(f.adapter.requests.length, before);
});
test('late source withdrawal at the final native request check prevents the adapter request', async t => {
  const f = await fixture(t, () => response('must not run')); const original = f.adapter.before;
  f.adapter.before = options => { f.store.save('source_controls', { id: f.source.id, withdrawn: true }); original(options); };
  await f.start(); assert.equal(f.adapter.requests.length, 0); assert.equal(f.run().requests.length, 1);
  assert.equal(f.run().state, 'unknown'); assert.equal(f.store.listAll('preparation_artifacts').length, 0);
});
test('native final flush false does not publish; later recovery reads the completed original without create/resume/resend', async t => {
  let f, restore; f = await fixture(t, (_options, count) => {
    if (count === 1) return tool('write', 'write', { file_path: f.run().artifact.path, content: '可恢复的原稿' });
    if (count === 2) return tool('read', 'read', { file_path: f.run().artifact.path });
    const service = f.ctx.sessions; restore = service.flush; service.flush = async () => false; return response('完成。');
  });
  await f.start(); assert.equal(f.run().state, 'unknown'); assert.equal(f.store.listAll('preparation_artifacts').length, 0);
  f.ctx.sessions.flush = restore;
  await f.runner.recover(); assert.equal(f.run().state, 'settled'); assert.equal(f.adapter.requests.length, 3);
  assert.equal(f.store.listAll('preparation_artifacts')[0].availableAtPublication, true);
  await f.runner.recover(); assert.equal(f.adapter.requests.length, 3); assert.equal(f.store.listAll('notifications').length, 1);
});
test('the fifth model request is denied and failed read tool calls consume the same bounded turn', async t => {
  let f; f = await fixture(t, (_options, count) => tool('read-' + count, 'read', { file_path: f.run().artifact.path }));
  await f.start(); assert.equal(f.adapter.requests.length, 4); assert.equal(f.run().requests.length, 4);
  assert.equal(f.store.listAll('preparation_artifacts').length, 0); assert.notEqual(f.run().state, 'settled');
});
test('manual prepare returns the frozen admission while its sole native owner is held; close drains it', async t => {
  let f; const entered = Promise.withResolvers();
  f = await fixture(t, async options => {
    entered.resolve(); await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
    options.signal.throwIfAborted();
  });
  const run = await f.runner.prepare({ opportunityId: f.opportunity.id, expectedRevision: f.opportunity.revision,
    permissionRevision: f.service.permission('main').revision });
  assert.equal(run.state, 'prepared'); await entered.promise;
  assert.ok(f.runner.active); const closing = f.runner.close(); assert.equal(f.runner.close(), closing); await closing;
  assert.equal(f.adapter.requests.length, 1); assert.equal(f.run().state, 'unknown');
  assert.equal(f.store.closed, false); assert.equal(f.store.listAll('preparation_artifacts').length, 0);
});


test('held preparation does not prevent a real main Agent answer and its real Learn from completing', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); let prepCalls = 0, f;
  f = await fixture(t, async options => {
    if (options.messages.some(message => message.source?.kind === 'arcfold/learning')) return response(JSON.stringify({ understandings: [], methods: [], opportunities: [], goals: [] }));
    if (!options.messages.some(message => message.source?.kind === 'arcfold/preparation')) return response('主会话已经完成。');
    prepCalls++;
    if (prepCalls === 1) { entered.resolve(); await Promise.race([release.promise, new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }))]); options.signal.throwIfAborted(); return tool('write', 'write', { file_path: f.run().artifact.path, content: '并行准备' }); }
    if (prepCalls === 2) return tool('read', 'read', { file_path: f.run().artifact.path });
    return response('准备结束。');
  });
  const activePrep = f.start(); await entered.promise;
  await active(await f.ctx.plugin({ inject: ['agentPresets'], async *apply(owner) {
    yield await owner.agentPresets.register({ id: 'main-parallel', plugins: [{ name: new URL('../src/agent.mjs', import.meta.url).href }] });
    yield await owner.agentPresets.register({ id: 'learn-parallel', plugins: [] });
  } }));
  await active(await f.ctx.plugin(LearnPlugin, { preset: 'learn-parallel', provider: 'fixture', model: 'fixture', maxTokens: 64, reasoningEffort: 'off', cwd: f.root }));
  const main = await f.ctx.agents.create({ sessionId: 'real-main', meta: { cwd: f.root },
    agentOptions: { provider: 'fixture', model: 'fixture', reasoningEffort: 'off', maxTokens: 64 },
    setup: async ctx => { await f.ctx.agentPresets.mount(ctx, 'main-parallel'); } });
  t.after(() => main.dispose());
  main.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '请回答这句话。' }] }));
  await main.agent.whenIdle(); await f.ctx.arcfoldBridge.pending.get(main.agent.id); await f.ctx.arcfoldLearning.kick();
  assert.equal(f.store.listAll('deliveries').length, 1); assert.equal(f.store.listAll('learning_runs')[0].state, 'settled');
  assert.ok(f.runner.active); assert.equal(prepCalls, 1); assert.equal(f.run().state, 'submitted');
  release.resolve(); await activePrep; assert.equal(f.run().state, 'settled');
});

test('an over-limit model batch retains all denied original requests but executes no tool body', async t => {
  let f; f = await fixture(t, (_options, count) => {
    if (count > 1) return response('Stopped');
    return Array.from({ length: 7 }, (_, index) => [
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'block-end', index, block: { type: 'tool-call', id: 'too-many-' + index, name: 'write',
        arguments: JSON.stringify({ file_path: f.run().artifact.path, content: 'must never write' }) } },
    ]).flat().concat([{ type: 'finish', reason: { kind: 'tool-calls' } }]);
  });
  await f.start(); assert.equal(existsSync(f.run().artifact.path), false); assert.equal(f.run().tools.length, 0);
  assert.equal(f.adapter.requests.length, 2); assert.equal(f.store.listAll('preparation_artifacts').length, 0);
  const events = await f.runner.readSession(f.run().sessionId);
  assert.equal(events.filter(event => event.type === 'tool/call').length, 7);
  assert.equal(events.filter(event => event.type === 'tool/result' && event.data.message.isError).length, 7);
});


test('late withdrawal after actual final and durable read preserves the artifact fact but blocks availability', async t => {
  let f; f = await fixture(t, (_options, count) => count === 1 ? tool('write', 'write', { file_path: f.run().artifact.path, content: '先于撤回实际写出的稿件' })
    : count === 2 ? tool('read', 'read', { file_path: f.run().artifact.path }) : response('已完成。'));
  const read = f.runner.readSession.bind(f.runner);
  f.runner.readSession = async (...args) => { const events = await read(...args); if (events?.some(e => e.type === 'turn/end')) f.store.save('source_controls', { id: f.source.id, withdrawn: true }); return events; };
  await f.start(); const artifact = f.store.listAll('preparation_artifacts')[0];
  assert.equal(f.run().state, 'settled'); assert.equal(artifact.availableAtPublication, false);
  assert.equal(artifact.evidence.text, '先于撤回实际写出的稿件'); assert.equal(existsSync(artifact.evidence.path), true);
  assert.equal(f.service.details(f.opportunity.id).available, false); assert.equal(f.adapter.requests.length, 3);
});
test('publication transaction failure retains disk/native originals and read-only recovery publishes exactly once', async t => {
  let f; f = await fixture(t, (_options, count) => count === 1 ? tool('write', 'write', { file_path: f.run().artifact.path, content: '原生文件完成，登记待恢复' })
    : count === 2 ? tool('read', 'read', { file_path: f.run().artifact.path }) : response('已完成。'));
  const save = f.store.save.bind(f.store); f.store.save = (kind, ...args) => { if (kind === 'notifications') throw new Error('injected publication failure'); return save(kind, ...args); };
  await f.start(); assert.equal(f.run().state, 'unknown'); assert.equal(f.store.listAll('preparation_artifacts').length, 0);
  assert.equal(existsSync(f.run().artifact.path), true); f.store.save = save;
  await f.runner.recover(); assert.equal(f.run().state, 'settled'); assert.equal(f.store.listAll('notifications').length, 1); assert.equal(f.adapter.requests.length, 3);
  await f.runner.recover(); assert.equal(f.store.listAll('notifications').length, 1);
});
test('actual host disposal cancels and drains held native preparation before business storage closes', async t => {
  const entered = Promise.withResolvers(); let f;
  f = await fixture(t, async options => { entered.resolve(); await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true })); options.signal.throwIfAborted(); });
  const running = f.start(); await entered.promise; await f.ctx.fiber.dispose(); await running;
  assert.equal(f.store.closed, true); assert.equal(f.adapter.requests.length, 1);
});


test('an extra required runtime fact fails the actual native preparation before any adapter request', async t => {
  const f = await fixture(t, () => response('must not run'));
  f.ctx.systemPrompt.context({ name: 'unexpected:preparation', order: 10, required: true, interpolate: false, text: 'Not selected material' });
  await f.start(); assert.equal(f.adapter.requests.length, 0); assert.equal(f.store.listAll('preparation_artifacts').length, 0);
  assert.equal(f.run().state, 'unknown');
});


test('denied original intents do not consume the six admitted body actions or hide native evidence', async t => {
  let f; f = await fixture(t, (_options, count) => {
    if (count === 1) return Array.from({ length: 5 }, (_, index) => [
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'block-end', index, block: { type: 'tool-call', id: 'denied-' + index, name: 'read', arguments: JSON.stringify({ file_path: join(f.root, 'not-selected.txt') }) } },
    ]).flat().concat([{ type: 'finish', reason: { kind: 'tool-calls' } }]);
    if (count === 2) return tool('allowed-write', 'write', { file_path: f.run().artifact.path, content: '拒绝意图不冒充执行' });
    if (count === 3) return tool('allowed-read', 'read', { file_path: f.run().artifact.path });
    return response('已完成。');
  });
  await f.start(); const events = await f.runner.readSession(f.run().sessionId);
  assert.equal(f.run().state, 'settled', JSON.stringify(f.run().error)); assert.equal(f.adapter.requests.length, 4);
  assert.equal(f.run().tools.length, 2); assert.equal(events.filter(e => e.type === 'tool/call').length, 7);
  assert.equal(events.filter(e => e.type === 'tool/result' && e.data.message.isError).length, 5);
  assert.equal(f.store.listAll('preparation_artifacts').length, 1);
});


test('dismissing another candidate in the same conversation does not cancel held preparation', async t => {
  const entered = Promise.withResolvers(); let f, actualSignal;
  f = await fixture(t, async options => { actualSignal = options.signal; entered.resolve(); await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true })); options.signal.throwIfAborted(); });
  const active = f.start(); await entered.promise;
  const other = f.store.save('opportunities', { ...f.opportunity, id: 'other-opportunity', description: '另一机会' });
  const section = f.store.get('learning_sections', 'learn:opportunities');
  f.store.save('learning_sections', { ...section, ids: [f.opportunity.id, other.id] }, { expectedRevision: section.revision });
  f.service.dismiss({ opportunityId: other.id, expectedRevision: other.revision, requestId: 'dismiss-other', userIdentity: 'browser:owner' });
  await delay(0); assert.equal(actualSignal.aborted, false); assert.equal(f.run().state, 'submitted');
  f.service.dismiss({ opportunityId: f.opportunity.id, expectedRevision: f.opportunity.revision, requestId: 'dismiss-current', userIdentity: 'browser:owner' });
  await active; assert.equal(actualSignal.aborted, true); assert.equal(f.adapter.requests.length, 1);
});


test('final native send check rejects material changed after stream admission without calling the adapter', async t => {
  const f = await fixture(t, () => response('must not run')), original = f.adapter.before;
  f.adapter.before = options => {
    options.messages.push({ id: 'late-extra', role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'unselected late material' }] });
    original(options);
  };
  await f.start(); assert.equal(f.adapter.requests.length, 0); assert.equal(f.run().requests.length, 1);
  assert.equal(f.run().state, 'unknown'); assert.equal(f.store.listAll('preparation_artifacts').length, 0);
});


test('failed dismiss COMMIT rolls back the decision and does not cancel the actual held preparation', async t => {
  const entered = Promise.withResolvers(); let f, actualSignal;
  f = await fixture(t, async options => { actualSignal = options.signal; entered.resolve(); await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true })); options.signal.throwIfAborted(); });
  const running = f.start(); await entered.promise;
  const before = f.store.currentSequence(), exec = f.store.db.exec.bind(f.store.db);
  f.store.db.exec = sql => { if (sql === 'COMMIT') throw new Error('injected COMMIT failure'); return exec(sql); };
  const request = { opportunityId: f.opportunity.id, expectedRevision: f.opportunity.revision, requestId: 'dismiss-once', userIdentity: 'browser:owner' };
  try { assert.throws(() => f.service.dismiss(request), /COMMIT failure/); } finally { f.store.db.exec = exec; }
  assert.equal(f.store.get('opportunity_controls', f.opportunity.id), null); assert.equal(f.store.currentSequence(), before);
  await delay(0); assert.equal(actualSignal.aborted, false); assert.equal(f.run().state, 'submitted');
  f.service.dismiss(request); await running;
  assert.equal(f.store.get('opportunity_controls', f.opportunity.id).dismissed, true); assert.equal(actualSignal.aborted, true);
});

test('replayed old and current permission requests do not cancel held preparation; a new saved revision does', async t => {
  const entered = Promise.withResolvers(); let f, actualSignal;
  f = await fixture(t, async options => { actualSignal = options.signal; entered.resolve(); await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true })); options.signal.throwIfAborted(); });
  const original = { sessionId: 'main', enabled: true, extraSourceIds: [], files: [], expectedRevision: 0, requestId: 'permission', userIdentity: 'browser:owner' };
  const second = { ...original, expectedRevision: 1, requestId: 'permission-next' };
  const saved = f.service.savePermission(second); assert.equal(saved.revision, 2);
  await f.runner.prepare({ opportunityId: f.opportunity.id, expectedRevision: f.opportunity.revision, permissionRevision: 2 });
  await entered.promise; const running = f.runner.active, before = f.store.currentSequence();
  assert.equal(f.service.savePermission(original).revision, 1); assert.equal(f.service.savePermission(second).revision, 2);
  await delay(0); assert.equal(actualSignal.aborted, false); assert.equal(f.run().state, 'submitted');
  assert.equal(f.store.currentSequence(), before); assert.equal(f.service.permission('main').revision, 2);
  f.service.savePermission({ ...original, enabled: false, expectedRevision: 2, requestId: 'new-revocation' });
  await running; assert.equal(actualSignal.aborted, true); assert.equal(f.service.permission('main').revision, 3);
  assert.equal(f.adapter.requests.length, 1);
});


async function creationWaitCase(t, reason) {
  const f = await fixture(t, () => response('must not send')), entered = Promise.withResolvers(), release = Promise.withResolvers();
  let createSignal, owner;
  const create = f.ctx.agents.create.bind(f.ctx.agents), mount = f.ctx.agentPresets.mount.bind(f.ctx.agentPresets);
  f.ctx.agents.create = options => { createSignal = options.signal; return create(options); };
  f.ctx.agentPresets.mount = async (ctx, preset) => {
    await mount(ctx, preset);
    if (preset === Preparation.PREPARATION_PRESET) { owner = ctx; entered.resolve(); await release.promise; }
  };
  if (reason === 'deadline') {
    const freeze = f.service.freeze.bind(f.service);
    f.service.freeze = async (...args) => { const result = await freeze(...args);
      // Test-only shorter clock, preserving the same production deadline path.
      result.run = f.service.update(result.run.id, { deadline: Date.now() + 2000 }); return result; };
  }
  const running = f.start();
  try {
    await Promise.race([entered.promise, running.then(() => { throw new Error('Create ended before the controlled setup wait'); })]);
    assert.equal(f.ctx.agents.get(f.run().sessionId), undefined);
    if (reason === 'deadline') await delay(Math.max(1, f.run().deadline - Date.now() + 25));
    else f.service.stop({ runId: f.run().id, expectedRevision: f.run().revision, requestId: 'stop-creating', userIdentity: 'browser:owner' });
    assert.equal(createSignal.aborted, true, 'The real native create must receive cancellation before setup returns');
  } finally { release.resolve(); await running; }
  // The original factory must unwind the late setup. No second executor or
  // artificial registry deletion is used to obtain this cleanup result.
  await delay(0);
  assert.equal(owner.fiber.state, 4); assert.equal(f.ctx.agents.get(f.run().sessionId), undefined);
  assert.equal(f.ctx.sessions.get(f.run().sessionId), undefined); assert.equal(f.adapter.requests.length, 0);
  assert.equal(f.run().state, 'stopped'); assert.equal(f.runner.active, null);
}
test('deadline covers actual native Agent setup waiting and disposes its late scope without sending', t => creationWaitCase(t, 'deadline'));
test('user stop cancels actual native Agent creation before a handle returns and leaves no owner', t => creationWaitCase(t, 'user-stop'));
