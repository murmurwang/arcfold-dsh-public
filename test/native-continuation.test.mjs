import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import Group from '@deepseek-ai/cordis-plugin-group';
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import SessionStore from '@deepseek-ai/dsh-session';
import SessionProjections from '@deepseek-ai/dsh-session-projection';
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools';
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
import * as GoalDriver from '@deepseek-ai/dsh-goal-round-driver';
import LocalJobs from '@deepseek-ai/dsh-jobs-local';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox';
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy';
import * as BusinessPlugin from '../src/index.mjs';
import * as LearnPlugin from '../src/learning-plugin.mjs';
import { LearningService } from '../src/learning.mjs';
import { assertNativeContinuationStored, freezeNativeContinuation } from '../src/native-continuation.mjs';
import { canonicalJson } from '../src/store.mjs';
import { inspectNativeContinuationDriver } from '../src/runtime-readiness.mjs';

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
    ...(business ? [{ name: new URL('../src/agent.mjs', import.meta.url).href }] : [
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

test('real Commands and durable native driver expose the first round source timing without synthetic goal messages', async t => {
  let f;
  const first = Promise.withResolvers();
  f = await nativeFixture(t, (options, count) => {
    first.resolve({ options, count }); return response('Delegated round reached the model.');
  });
  const agent = await f.agent('command-origin');
  const preSteps = [];
  f.ctx.on('agent/pre-step', async ({ agent: owner, messages }, next) => {
    if (owner === agent && messages.some(message => message.source.kind === 'goal' && message.source.round > 0)) {
      const events = owner.session.snapshotEvents();
      assert.equal(await f.ctx.sessions.flush(owner.session), true);
      preSteps.push(events);
    }
    return next();
  });
  // Observe the very first official goal continuation. Stop by the public native
  // pause command after its request, not by fabricating or directly following up
  // a goal message. No scheduling delay is inserted into command execution.
  const execution = await f.ctx.commands.execute(agent, '/goal Perform the explicitly delegated fixture work', [], new AbortController().signal);
  assert.equal(execution.result.kind, 'success');
  await bounded(first.promise, 'first native continuation');
  await f.ctx.commands.execute(agent, '/goal pause', [], new AbortController().signal);
  await bounded(agent.whenIdle(), 'paused Agent');
  const events = agent.session.snapshotEvents();
  writeFileSync(join(f.root, 'command-timing.json'), JSON.stringify({ execution, preSteps, events }, null, 2));
  assert.ok(preSteps.length > 0);
  const prefix = preSteps[0];
  const run = prefix.find(event => event.type === 'command/run' && event.data.commandId === execution.commandId);
  const change = prefix.find(event => event.type === 'goal/change' && event.data.operation === 'create');
  const done = prefix.find(event => event.type === 'command/done' && event.data.commandId === execution.commandId);
  assert.ok(run && change);
  assert.ok(run.seq < change.seq);
  t.diagnostic(JSON.stringify({ commandRunSeq: run.seq, createSeq: change.seq, firstPreStepDoneSeq: done?.seq ?? null,
    fullDoneSeq: events.find(event => event.type === 'command/done' && event.data.commandId === execution.commandId)?.seq }));
  assert.ok(done, 'The actual first durable pre-step has the completed /goal command');
  assert.equal(done.data.kind, 'success');
  assert.equal(f.ctx.goals.get(agent).phase, 'paused');
});


test('one root driver covers two real main scopes, no-goal Learn, and retained preset generations', async t => {
  const gates = new Map(), entered = new Map();
  const f = await nativeFixture(t, async options => {
    if (options.sessionId === 'auxiliary') return response('one auxiliary output');
    entered.get(options.sessionId).resolve();
    await gates.get(options.sessionId).promise;
    return response('one delegated round');
  });
  const a = await f.agent('main-a'), b = await f.agent('main-b'), learn = await f.agent('auxiliary', 'learn');
  for (const agent of [a, b]) {
    entered.set(agent.id, Promise.withResolvers()); gates.set(agent.id, Promise.withResolvers());
    await f.ctx.commands.execute(agent, '/goal Explicitly continue this isolated work', [], new AbortController().signal);
  }
  await bounded(Promise.all([...entered.values()].map(value => value.promise)), 'both main requests');
  learn.followup(createUserMessage({ content: [{ type: 'text', text: 'Frozen fixture input' }], source: { kind: 'arcfold/learning' } }));
  await bounded(learn.whenIdle(), 'auxiliary output');
  const check = () => inspectNativeContinuationDriver(f.ctx, [...f.ctx.loader.entries()], f.ctx.agentPresets.inspectCompositions());
  assert.equal(await check(), f.driver.ctx.fiber);
  assert.equal(f.ctx.goals.get(learn), undefined);
  assert.deepEqual(f.adapter.requests.map(row => row.sessionId).sort(), ['auxiliary', 'main-a', 'main-b']);
  for (const agent of [a, b]) {
    assert.equal(f.ctx.goals.get(agent).roundsStarted, 1);
    assert.equal(f.ctx.goals.get(agent).activation, 'armed');
  }
  // Retiring a declaration keeps its generation alive for already joined Agents.
  // A replacement definition must not mount another global driver or disarm them.
  await f.declaration.dispose();
  const replacement = await f.declare('main', f.mainPlugins.map(row => row.config ? { ...row, config: { ...row.config, waitTimeoutMs: 100 } } : row));
  const c = await f.agent('main-c');
  assert.equal(await check(), f.driver.ctx.fiber);
  assert.equal(f.ctx.agentPresets.inspectCompositions().filter(row => row.id === 'main').length, 2);
  assert.equal(f.ctx.goals.get(a).activation, 'armed');
  assert.equal(f.ctx.goals.get(b).activation, 'armed');
  assert.equal(f.ctx.goals.get(c), undefined);
  await assert.rejects(inspectNativeContinuationDriver(f.ctx, [], []), /one root/);
  await assert.rejects(inspectNativeContinuationDriver(f.ctx, [f.driverEntry, f.driverEntry], []), /one root/);
  await assert.rejects(inspectNativeContinuationDriver(f.ctx, [f.driverEntry],
    [{ modules: [{ moduleName: '@deepseek-ai/dsh-goal-round-driver' }] }]), /preset/);
  for (const agent of [a, b]) {
    await f.ctx.commands.execute(agent, '/goal pause', [], new AbortController().signal);
    gates.get(agent.id).resolve();
  }
  await bounded(Promise.all([a.whenIdle(), b.whenIdle()]), 'paused main owners');
  await f.driver.ctx.fiber.dispose();
  await assert.rejects(check(), /not active/);
  assert.equal(f.adapter.requests.length, 3);
  await replacement.dispose();
});

test('quiet completion leaves an idle ordinary owner asleep and the next real input receives the original notice', async t => {
  const f = await nativeFixture(t, () => response('ordinary response'));
  const agent = await f.agent('ordinary-job');
  const done = Promise.withResolvers(), notified = Promise.withResolvers();
  f.ctx.on('agent/inbox/inserted', ({ agent: owner, message }) => {
    if (owner === agent && message.source.kind === 'tool-jobs') notified.resolve(message);
  });
  const id = f.ctx.jobs.start({ kind: 'bash', label: 'actual registry gated fixture', owner: agent.id,
    run(job) { job.append('completed fixture output'); return { done: done.promise, cancel() { done.resolve({ status: 'killed' }); } }; } });
  done.resolve({ status: 'completed' });
  const notice = await bounded(notified.promise, 'native quiet job notice');
  assert.equal(agent.status, 'idle'); assert.equal(f.adapter.requests.length, 0);
  assert.equal(f.ctx.jobs.get(id, agent.id).status, 'completed');
  assert.ok(agent.inbox.nextStep.some(message => message.id === notice.id));
  assert.equal(agent.inbox.nextTurn.length, 0);
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Now review the completed job.' }], source: { kind: 'user' } }));
  await bounded(agent.whenIdle(), 'ordinary followup');
  assert.equal(f.adapter.requests.length, 1);
  assert.ok(f.adapter.requests[0].messages.some(message => message.id === notice.id && message.source.kind === 'tool-jobs'));
});


const callResponse = (id, name, args) => [
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) } },
  { type: 'finish', reason: { kind: 'tool-calls' } },
];
const emptyLearning = JSON.stringify({ understandings: [], methods: [], opportunities: [], goals: [] });
const ownerMessage = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
const stageSpec = (objective, max = 3) => ({ objective, max_goal_rounds: max,
  doneWhen: '本次明确委托的核对工作已完成，结果已保存并检查。',
  boundaries: '只完成当前阶段；出现需要用户决定的新方向时等待。' });
const decision = (goal, action) => ({ goal_id: goal.id, revision: goal.revision, action,
  reason: action === 'continue' ? '当前阶段仍有可独立完成的核对工作。' : '当前阶段的完成条件已经满足。',
  stageDone: action === 'complete', needsUserDecision: action === 'wait',
  nextStep: action === 'continue' ? '完成当前阶段内的下一项核对并检查保存结果。' : '' });
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

test('actual Arcfold stage and two permitted driver rounds retain one delegation through tools, delivery and frozen Learn', async t => {
  let f, primary, mainCalls = 0, writes = 0, helperCalls = 0;
  const learnStarted = Promise.withResolvers(), releaseLearn = Promise.withResolvers();
  const secondRound = Promise.withResolvers();
  const objective = 'Continue the two explicitly delegated fixture rounds and verify each file.';
  f = await nativeFixture(t, async (options) => {
    const input = options.messages.find(message => message.source?.kind === 'arcfold/learning');
    if (input) {
      helperCalls++;
      assert.equal(options.tools?.length ?? 0, 0); assert.equal(options.messages.length, 3);
      assert.equal(options.messages.filter(message => message.source?.kind === 'goal').length, 0);
      if (helperCalls === 1) { learnStarted.resolve(); await waitGate(releaseLearn, options.signal); }
      return response(emptyLearning);
    }
    if (options.sessionId === 'parallel-main') return response('The independent ordinary answer completed.');
    mainCalls++;
    if (mainCalls === 1) return callResponse('create-original', 'arcfold_start_work', stageSpec(objective, 2));
    if (mainCalls === 2) return callResponse('permit-first', 'arcfold_decide_work', decision(f.ctx.goals.get(primary), 'continue'));
    if (mainCalls === 3) return response('The explicit continuing work is registered.');
    if (mainCalls === 4) { await bounded(learnStarted.promise, 'first Learn overlaps continuation'); return callResponse('write-one', 'fixture_write', { value: 'round one' }); }
    if (mainCalls === 5) return callResponse('permit-second', 'arcfold_decide_work', decision(f.ctx.goals.get(primary), 'continue'));
    if (mainCalls === 6) return response('Round one wrote its file.');
    if (mainCalls === 7) { secondRound.resolve(); return callResponse('write-two', 'fixture_write', { value: 'round two' }); }
    if (mainCalls === 8) {
      const goal = f.ctx.goals.get(primary);
      return callResponse('complete-original', 'arcfold_decide_work', decision(goal, 'complete'));
    }
    if (mainCalls === 9) return response('Round two verified its file; the delegated work is complete.');
    assert.fail('Unexpected main request');
  }, { business: true, learning: true });
  primary = await f.agent('delegated-main', 'main', async owner => {
    owner.tools.register(defineTool({ name: 'fixture_write', description: 'Write the explicit fixture round file',
      parameters: { value: { type: 'string', required: true } },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute(args, exec) {
        exec.signal.throwIfAborted(); const file = join(f.root, 'round-' + (++writes) + '.txt');
        writeFileSync(file, args.value, { flag: 'wx' });
        return { value: readFileSync(file, 'utf8') };
      } }));
  });
  const input = createUserMessage({ content: [{ type: 'text', text: objective }], source: { kind: 'user' } });
  primary.followup(input);
  await bounded(secondRound.promise, 'second actual automatic round while Learn is held');
  assert.equal(helperCalls, 1, 'Root driver must not wake the held no-goal helper');
  const parallel = await f.agent('parallel-main');
  parallel.followup(createUserMessage({ content: [{ type: 'text', text: 'Please answer this independent ordinary input.' }], source: { kind: 'user' } }));
  await bounded(parallel.whenIdle(), 'independent main');
  releaseLearn.resolve();
  await eventually(() => f.ctx.goals.get(primary)?.phase === 'complete' && primary.status === 'idle', 'native goal completes');
  await f.ctx.arcfoldBridge.pending.get(primary.id);
  await eventually(() => f.ctx.arcfoldBusiness.listAll('learning_pending').length === 4 &&
    f.ctx.arcfoldBusiness.listAll('learning_pending').every(row => row.status === 'completed'), 'all actual helpers settle');
  const store = f.ctx.arcfoldBusiness.storage, events = primary.session.snapshotEvents();
  writeFileSync(join(f.root, 'native-delegated-rounds.json'), JSON.stringify(events, null, 2));
  writeFileSync(join(f.root, 'business-rows.json'), JSON.stringify(['context_snapshots', 'deliveries', 'learning_pending', 'learning_inputs', 'learning_runs']
    .flatMap(kind => store.listAll(kind).map(body => ({ kind, body }))), null, 2));
  assert.equal(mainCalls, 9); assert.equal(writes, 2); assert.equal(helperCalls, 4);
  const deliveries = store.listAll('deliveries', { where: { sessionId: primary.id } });
  assert.equal(deliveries.length, 3);
  const automatic = deliveries.filter(row => row.nativeContinuation);
  assert.equal(automatic.length, 2);
  const initialId = deliveries.find(row => !row.nativeContinuation).inputEventIds[0];
  for (const delivery of automatic) {
    assert.deepEqual(delivery.inputEventIds, []);
    assert.deepEqual(delivery.nativeContinuation.initialDelegation.sourceIds, [initialId]);
    assert.equal(delivery.nativeContinuation.initialDelegation.kind, 'native-goal-tool');
    assert.equal('arguments' in delivery.nativeContinuation.initialDelegation, false);
    const snapshot = store.listAll('context_snapshots', { where: { sessionId: primary.id, turn: delivery.turn } })[0];
    const pending = store.listAll('learning_pending', { where: { deliveryId: delivery.id } })[0];
    const learned = store.get('learning_inputs', pending.id);
    assert.deepEqual(snapshot.material.nativeContinuation, delivery.nativeContinuation);
    assert.deepEqual(learned.material.nativeContinuation, delivery.nativeContinuation);
    assert.deepEqual(learned.material.inputEventIds, []);
    assert.equal(learned.material.inputEventId, null);
    assert.ok(learned.material.sources.some(source => source.id === initialId));
    assertNativeContinuationStored(store, delivery.nativeContinuation);
    const proof = delivery.nativeContinuation;
    assert.throws(() => assertNativeContinuationStored(store, { ...proof, sessionId: 'foreign' }), /changed/);
    const prefix = events.filter(event => event.seq <= proof.cutoff.throughSeq);
    const originalMessage = prefix.find(event => event.type === 'agent/inbox/spliced' &&
      event.seq === proof.inboxRef.seq).data.inserted[proof.inboxRef.index];
    const current = { ...proof.currentDefinition, activation: 'armed', roundsStarted: proof.round - 1 };
    const freeze = changes => freezeNativeContinuation({ store, sessionId: primary.id, turn: delivery.turn,
      messages: [originalMessage], events: prefix, goal: current, ...changes });
    assert.throws(() => freeze({ events: prefix.filter(event => event.type !== 'tool/result') }), /delegation/);
    assert.throws(() => freeze({ events: prefix.filter(event => event.type !== 'goal/change') }), /chain/);
    assert.throws(() => freeze({ goal: { ...current, revision: current.revision + 1 } }), /current/);
    assert.throws(() => freeze({ sessionId: 'other-session' }), /missing|durable/);
    assert.throws(() => freeze({ messages: [{ ...originalMessage, source: { ...originalMessage.source, round: current.roundsStarted + 2 } }] }), /current/);
    const sentinel = new Error('rollback negative source mutation');
    assert.throws(() => store.transaction(() => {
      store.save('source_controls', { id: initialId, withdrawn: true });
      assert.throws(() => assertNativeContinuationStored(store, proof), /withdrawn/);
      throw sentinel;
    }), error => error === sentinel);
    assertNativeContinuationStored(store, proof);
    const roundSource = store.listAll('events', { where: { sessionId: primary.id } })
      .find(row => row.message.id === delivery.nativeContinuation.messageId);
    assert.equal(roundSource.role, 'program'); assert.equal(roundSource.message.source.kind, 'goal');
  }
  const before = f.adapter.requests.length;
  await f.ctx.arcfoldLearning.recover(); await f.ctx.arcfoldLearning.kick();
  assert.equal(f.adapter.requests.length, before, 'Settled helpers and completed goal are never resent');
});

// The same generated Remote descriptor and exact-reference methods used by the
// official GoalBar. This is an in-process Gateway test, not a browser assertion.
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

test('native pause before a tool body, quiet late job, ordinary input, exact Remote edits and Arcfold browser resume share the original delegation', async t => {
  let f, agent, calls = 0, bodies = 0;
  const beforeTool = Promise.withResolvers(), releaseTool = Promise.withResolvers();
  const objective = 'Continue the explicitly delegated fixture work';
  const finalObjective = 'The same delegated work with the final clarified native definition.';
  f = await nativeFixture(t, () => {
    calls++;
    if (calls === 1) return callResponse('start-native-pause', 'arcfold_start_work', stageSpec(objective));
    if (calls === 2) return callResponse('permit-before-pause', 'arcfold_decide_work', decision(f.ctx.goals.get(agent), 'continue'));
    if (calls === 3) return response('The current stage is registered.');
    if (calls === 4) return callResponse('paused-body', 'fixture_mutate', {});
    if (calls === 5) return response('An ordinary answer while the goal remains paused.');
    if (calls === 6) {
      const goal = f.ctx.goals.get(agent);
      return callResponse('clarify-native-edits', 'arcfold_revise_work', {
        goal_id: goal.id, revision: goal.revision, ...stageSpec(finalObjective) });
    }
    if (calls === 7) return response('The same stage is clarified and remains paused.');
    if (calls === 8) return callResponse('finish-resumed', 'arcfold_decide_work', decision(f.ctx.goals.get(agent), 'complete'));
    if (calls === 9) return response('The explicitly resumed delegated work is complete.');
    assert.fail('No autonomous extra request after pause or completion');
  }, { business: true });
  agent = await f.agent('paused-native', 'main', async owner => {
    owner.tools.register(defineTool({ name: 'fixture_mutate', description: 'Test the real tool dispatch boundary', parameters: {},
      output: { schema: { type: 'json' }, render: () => [] }, execute() { bodies++; return {}; } }));
  });
  f.ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name === 'fixture_mutate') { beforeTool.resolve(); await waitGate(releaseTool, exec.signal); }
    return next();
  });
  const remote = await nativeRemote(f);
  const original = ownerMessage(objective); agent.followup(original);
  await bounded(beforeTool.promise, 'native tool pre-execute');
  const first = f.ctx.goals.get(agent);
  await remote('pause', agent, { id: first.id, revision: first.revision });
  releaseTool.resolve(); await bounded(agent.whenIdle(), 'paused before tool body');
  assert.equal(bodies, 0); assert.equal(calls, 4);
  const done = Promise.withResolvers(), notice = Promise.withResolvers();
  f.ctx.on('agent/inbox/inserted', ({ agent: owner, message }) => {
    if (owner === agent && message.source.kind === 'tool-jobs') notice.resolve(message);
  });
  const job = f.ctx.jobs.start({ kind: 'bash', label: 'already running at pause', owner: agent.id,
    run() { return { done: done.promise, cancel() { done.resolve({ status: 'killed' }); } }; } });
  done.resolve({ status: 'completed' }); await bounded(notice.promise, 'late job notice');
  assert.equal(f.ctx.jobs.get(job, agent.id).status, 'completed');
  assert.equal(agent.status, 'idle'); assert.equal(calls, 4); assert.equal(bodies, 0);
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Answer only this ordinary question.' }], source: { kind: 'user' } }));
  await bounded(agent.whenIdle(), 'ordinary paused input');
  assert.equal(calls, 5); assert.equal(f.ctx.goals.get(agent).phase, 'paused');
  const paused = f.ctx.goals.get(agent), oldRef = { id: paused.id, revision: paused.revision };
  const supersededObjective = 'INTERMEDIATE_NATIVE_DEFINITION_NOT_COPIED_IN_PROOF';
  await remote('edit', agent, oldRef, { objective: supersededObjective });
  assert.equal(f.ctx.goals.get(agent).phase, 'paused');
  await assert.rejects(remote('resume', agent, oldRef), /revision|conflict|stale/i);
  const intermediate = f.ctx.goals.get(agent);
  await remote('edit', agent, { id: intermediate.id, revision: intermediate.revision }, { objective: finalObjective });
  assert.equal(f.ctx.goals.get(agent).activation, 'disarmed');
  const nativeEdited = f.ctx.goals.get(agent), store = f.ctx.arcfoldBusiness.storage;
  const browserControl = (goal, requestId) => ({ sessionId: agent.id,
    workId: store.listAll('goal_works', { where: { sessionId: agent.id } })[0].id,
    nativeGoalId: goal.id, nativeRevision: goal.revision, requestId,
    userIdentity: 'fixture-browser-owner', action: 'resume', agent });
  await assert.rejects(f.ctx.arcfoldGoals.controlWork(browserControl(nativeEdited, 'native-edit-needs-stage')),
    /重新明确|变化/);
  agent.followup(ownerMessage('Clarify the same current stage with the final definition; keep it paused for my browser decision.'));
  await bounded(agent.whenIdle(), 'Arcfold stage clarification stays stopped');
  assert.equal(calls, 7); assert.equal(f.ctx.goals.get(agent).phase, 'paused');
  assert.equal(f.ctx.goals.get(agent).activation, 'disarmed');
  const edited = f.ctx.goals.get(agent);
  const receipt = await f.ctx.arcfoldGoals.controlWork(browserControl(edited, 'browser-resume-clarified-stage'));
  assert.equal(receipt.state, 'applied');
  await eventually(() => f.ctx.goals.get(agent).phase === 'complete' && agent.status === 'idle', 'resumed round finishes');
  await f.ctx.arcfoldBridge.pending.get(agent.id);
  assert.equal(calls, 9); assert.equal(bodies, 0);
  const delivery = store.listAll('deliveries', { where: { sessionId: agent.id } }).find(row => row.nativeContinuation);
  assert.ok(delivery); assert.deepEqual(delivery.inputEventIds, []);
  const proof = delivery.nativeContinuation;
  assert.equal(proof.initialDelegation.kind, 'native-goal-tool');
  assert.deepEqual(proof.definitionChain.map(row => row.operation), ['create', 'pause', 'edit', 'edit', 'edit', 'resume']);
  assert.deepEqual(proof.currentDefinition, { id: edited.id, revision: edited.revision + 1,
    objective: finalObjective, phase: 'active', maxGoalRounds: edited.maxGoalRounds });
  assert.equal(JSON.stringify(proof).includes(supersededObjective), false);
  assert.equal(proof.definitionChain.some(row => 'change' in row || 'objective' in row), false);
  for (const link of proof.definitionChain) {
    const original = agent.session.snapshotEvents().find(row => row.seq === link.seq);
    assert.equal(original.data.goal.id, link.goalId); assert.equal(original.data.goal.revision, link.revision);
    assert.equal(original.data.operation, link.operation);
    assert.ok(proof.nativeEvents.some(row => row.seq === original.seq && row.type === 'goal/change'));
  }
  assert.ok(agent.session.snapshotEvents().some(row => row.type === 'goal/change' && row.data.goal.objective === supersededObjective));
  assert.ok(proof.definitionChain.slice(1).every(row => row.actor === 'unrecorded' && row.attribution === 'native_control'));
  assert.equal(proof.initialDelegation.sourceIds.length, 1);
  assert.deepEqual(store.get('events', proof.initialDelegation.sourceIds[0]).message, original);
  assert.equal(agent.session.snapshotEvents().filter(row => row.type === 'command/run').length, 0,
    'Remote edits and the browser decision are not fabricated slash commands or user originals');
  assert.equal(store.get('goal_work_controls', receipt.decisionId).state, 'applied');
  writeFileSync(join(f.root, 'remote-control-proof.json'), JSON.stringify({ proof, events: agent.session.snapshotEvents() }, null, 2));
});

test('final send rechecks a paused native round and durable flush failure never reaches the adapter', async t => {
  let httpRequests = 0;
  const server = createServer((_req, res) => { httpRequests++; res.end('unexpected send'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = 'http://127.0.0.1:' + server.address().port;
  let f, agent;
  f = await nativeFixture(t, async (_options, count) => {
    if (count === 1) return callResponse('start-send-boundary', 'arcfold_start_work', stageSpec('Explicit fixture work'));
    if (count === 2) return callResponse('permit-send-boundary', 'arcfold_decide_work', decision(f.ctx.goals.get(agent), 'continue'));
    if (count === 3) return response('Current stage ready for its next work.');
    await fetch(endpoint); return response('must not dispatch');
  }, { business: true });
  agent = await f.agent('paused-before-send');
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), remote = await nativeRemote(f);
  f.adapter.beforeSend = async options => {
    if (!options.messages.some(message => message.source?.kind === 'goal')) return;
    entered.resolve(); await release.promise;
    f.ctx.arcfoldBridge.assertRequestCurrent(options);
    options.signal.throwIfAborted();
  };
  agent.followup(ownerMessage('Explicit fixture work'));
  await bounded(entered.promise, 'final fixture send boundary');
  assert.equal(f.adapter.requests.length, 3, 'Only the stage setup reached the adapter');
  const goal = f.ctx.goals.get(agent);
  await remote('pause', agent, { id: goal.id, revision: goal.revision });
  release.resolve(); await bounded(agent.whenIdle(), 'paused request');
  assert.equal(f.adapter.requests.length, 3, 'The paused automatic request never reaches the adapter');
  assert.equal(f.ctx.goals.get(agent).phase, 'paused');
  f.adapter.beforeSend = undefined;
  const second = await f.agent('false-flush');
  t.mock.method(f.ctx.sessions, 'flush', async () => false);
  second.followup(createUserMessage({ content: [{ type: 'text', text: 'This cannot dispatch without a durable prefix.' }], source: { kind: 'user' } }));
  await bounded(second.whenIdle(), 'false durable flush');
  assert.equal(f.adapter.requests.length, 3, 'The non-durable ordinary request never reaches the adapter');
  assert.equal(httpRequests, 0);
});

test('a still-live host disarms after a failed or truncated native round and recovery does not resend', async t => {
  for (const kind of ['error', 'max-tokens']) {
    let f, agent;
    f = await nativeFixture(t, (_options, count) => {
      if (count === 1) return callResponse('start-failed-stage', 'arcfold_start_work', stageSpec('Explicit fixture work'));
      if (count === 2) return callResponse('permit-failed-stage', 'arcfold_decide_work', decision(f.ctx.goals.get(agent), 'continue'));
      if (count === 3) return response('Current stage registered.');
      assert.equal(count, 4, 'An unknown or truncated automatic request cannot be resent');
      if (kind === 'error') throw new Error('Synthetic dispatch outcome unknown');
      return [{ type: 'finish', reason: { kind: 'max-tokens' } }];
    }, { business: true });
    agent = await f.agent('failure-' + kind);
    agent.followup(ownerMessage('Explicit fixture work'));
    await eventually(() => f.adapter.requests.length === 4 && agent.status === 'idle', 'failed native round settles');
    assert.equal(f.ctx.goals.get(agent).activation, 'disarmed');
    await f.ctx.arcfoldBridge.recover();
    assert.equal(f.adapter.requests.length, 4);
    const deliveries = f.ctx.arcfoldBusiness.listAll('deliveries');
    assert.equal(deliveries.length, 1, 'The real stage registration remains delivered');
    assert.equal(deliveries.filter(row => row.nativeContinuation).length, 0, 'The failed automatic turn is not a delivery');
    const status = f.ctx.goals.get(agent);
    assert.equal(status.phase, 'active', 'Disarmed is native execution state, not a second Arcfold pause record');
    const original = agent.session.snapshotEvents();
    await f.ctx.sessions.flush(agent.session); await f.release(agent);
    const recovered = await f.resume(agent.id);
    assert.equal(f.ctx.goals.get(recovered).activation, 'disarmed');
    assert.equal(f.ctx.goals.get(recovered).id, status.id);
    assert.deepEqual(recovered.session.snapshotEvents().slice(0, original.length), original);
    await f.ctx.arcfoldBridge.recover(); assert.equal(f.adapter.requests.length, 4);
  }
});

test('automatic terminal wrap-up refuses a mixed completion batch and every later tool, but still delivers final text', async t => {
  for (const mixed of [false, true]) {
    let f, agent, count = 0, writes = 0;
    f = await nativeFixture(t, () => {
      count++;
      if (count === 1) return callResponse('start-terminal-stage', 'arcfold_start_work', stageSpec('Carry out the original bounded work'));
      if (count === 2) return callResponse('permit-terminal-stage', 'arcfold_decide_work', decision(f.ctx.goals.get(agent), 'continue'));
      if (count === 3) return response('Current stage registered.');
      const goal = f.ctx.goals.get(agent);
      const finish = callResponse('complete-' + count, 'arcfold_decide_work', decision(goal, 'complete'));
      if (mixed && count === 4) return [...finish.slice(0, -1),
        { type: 'block-start', index: 1, blockType: 'tool-call' },
        { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'same-batch-write', name: 'review_write', arguments: '{}' } },
        { type: 'finish', reason: { kind: 'tool-calls' } }];
      if (count === (mixed ? 5 : 4)) return finish;
      if (count === (mixed ? 6 : 5)) return callResponse('after-complete-write', 'review_write', {});
      if (count === (mixed ? 7 : 6)) return response('Only the final explanation after completion.');
      assert.fail('No new autonomous round after completion');
    }, { business: true });
    agent = await f.agent('terminal-' + mixed, 'main', async owner => {
      owner.tools.register(defineTool({ name: 'review_write', description: 'Would write after terminal',
        parameters: {}, output: { schema: { type: 'json' }, render: () => [] },
        execute() { writes++; writeFileSync(join(f.root, 'unexpected-terminal-write'), 'unexpected'); return {}; } }));
    });
    agent.followup(ownerMessage('Carry out the original bounded work'));
    await eventually(() => f.ctx.goals.get(agent)?.phase === 'complete' && agent.status === 'idle', 'terminal explanation');
    await f.ctx.arcfoldBridge.pending.get(agent.id);
    assert.equal(writes, 0);
    const deliveries = f.ctx.arcfoldBusiness.listAll('deliveries');
    assert.equal(deliveries.length, 2);
    assert.equal(deliveries.filter(row => row.nativeContinuation).length, 1);
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result');
    assert.equal(results.find(event => event.data.message.toolCallId === 'after-complete-write').data.message.isError, true);
    if (mixed) for (const id of ['complete-4', 'same-batch-write'])
      assert.equal(results.find(event => event.data.message.toolCallId === id).data.message.isError, true);
    writeFileSync(join(f.root, 'terminal-results.json'), JSON.stringify({ writes, count, results }, null, 2));
  }
});

test('source withdrawal before first business settlement or later replay preserves facts and permits a new ordinary input', async t => {
  for (const timing of ['before-first-settle', 'after-delivery']) {
    let f, agent, calls = 0, withdrawnId;
    f = await nativeFixture(t, () => {
      calls++;
      if (calls === 1) return callResponse('create-delegation', 'arcfold_start_work', stageSpec('The explicitly delegated fixture task', 1));
      if (calls === 2) return callResponse('permit-delegated-task', 'arcfold_decide_work', decision(f.ctx.goals.get(agent), 'continue'));
      if (calls === 3) return response('Registered the delegated task.');
      if (calls === 4) {
        const goal = f.ctx.goals.get(agent);
        return callResponse('complete-task', 'arcfold_decide_work', decision(goal, 'complete'));
      }
      if (calls === 5) return response('The actual automatic answer happened.');
      if (calls === 6) return response('The independent new ordinary answer.');
      assert.fail('No replay of the prior automatic request');
    }, { business: true });
    agent = await f.agent('withdraw-' + timing);
    const store = f.ctx.arcfoldBusiness.storage;
    const withdraw = proof => {
      withdrawnId = proof.initialDelegation.sourceIds[0]; assert.ok(withdrawnId);
      store.save('source_controls', { id: withdrawnId, useProhibited: true, actor: 'user',
        reason: 'fixture-authoritative-source-withdrawal' });
    };
    f.ctx.on('session/event', (session, event) => {
      if (timing !== 'before-first-settle' || withdrawnId || session.id !== agent.id || event.type !== 'turn/end') return;
      const saved = store.listAll('context_snapshots', { where: { sessionId: agent.id, turn: event.data.turn } })[0];
      if (!saved?.material.nativeContinuation) return;
      assert.equal(store.listAll('deliveries', { where: { sessionId: agent.id, turn: event.data.turn } }).length, 0);
      withdraw(saved.material.nativeContinuation);
    });
    const original = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Please continue this explicitly delegated task.' }] });
    agent.followup(original);
    await eventually(() => f.ctx.goals.get(agent)?.phase === 'complete' && agent.status === 'idle', 'actual completed native turn');
    await f.ctx.arcfoldBridge.pending.get(agent.id);
    const delivery = store.listAll('deliveries', { where: { sessionId: agent.id } }).find(row => row.nativeContinuation);
    assert.ok(delivery, 'The original completed native answer remains a formal delivery even when its source was just withdrawn');
    const before = structuredClone(delivery);
    if (timing === 'after-delivery') withdraw(delivery.nativeContinuation);
    assert.throws(() => assertNativeContinuationStored(store, delivery.nativeContinuation), /withdrawn/);
    const pending = store.listAll('learning_pending', { where: { deliveryId: delivery.id } })[0];
    const learning = new LearningService({ business: f.ctx.arcfoldBusiness });
    assert.throws(() => learning.prepare(pending.id), /withdrawn/);
    assert.deepEqual(store.get('events', withdrawnId).message, original);
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'A new independent ordinary question.' }] }));
    await bounded(agent.whenIdle(), 'ordinary input after withdrawal');
    await f.ctx.arcfoldBridge.pending.get(agent.id);
    assert.equal(calls, 6); assert.deepEqual(store.get('deliveries', delivery.id), before);
    assert.equal(store.listAll('deliveries', { where: { sessionId: agent.id } }).length, 3);
  }
});

test('a real preset-mounted official driver through a file URL is rejected as a second driver', async t => {
  const f = await nativeFixture(t, () => { assert.fail('No model needed for topology inspection'); });
  await f.declaration.dispose();
  const alias = import.meta.resolve('@deepseek-ai/dsh-goal-round-driver');
  await f.declare('main', [...f.mainPlugins, { name: alias }]);
  await f.agent('alias-main');
  const entries = [...f.ctx.loader.entries()], compositions = f.ctx.agentPresets.inspectCompositions();
  writeFileSync(join(f.root, 'composition-alias.json'), JSON.stringify({
    rootEntries: entries.map(entry => ({ id: entry.options.id, name: entry.options.name })), compositions, alias }, null, 2));
  assert.ok(compositions.some(row => row.modules.some(module => module.moduleName === alias)));
  await assert.rejects(async () => inspectNativeContinuationDriver(f.ctx, entries, compositions), /preset|one root/);
  assert.equal(f.adapter.requests.length, 0);
});
