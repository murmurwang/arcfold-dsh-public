// Official tool pipeline and batch settlement with deterministic native-session fixtures.
// No Agent loop, provider, model or host server is started by these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import ToolsService, { defineTool } from '@deepseek-ai/dsh-tools';
import { ToolExecutionPipeline, executeToolBatch } from '@deepseek-ai/dsh-tools/pipeline';
import { contextMessage } from '../src/context-material.mjs';
import { METHOD_TOOL, methodContextMessage } from '../src/method-context.mjs';
import { resolveNativeMethodCall, apply, inject } from '../src/method-tool.mjs';

const selection = () => ({ id: 'm1', revision: 1, contentHash: 'content-hash', reason: 'The shown condition matches this task.', sourceIds: ['s1'] });
const call = (id = 'method-call', name = METHOD_TOOL, args = { selections: [selection()] }) =>
  ({ type: 'tool-call', id, name, arguments: JSON.stringify(args) });
const live = () => new AbortController();

function fixture(blocks = [call()]) {
  const controller = live(), f = { bound: true, reserved: [], deferred: [], onFlush: null };
  const material = { version: 'arcfold-context-v1', sessionId: 'native-main', turn: 1,
    cutoffSequence: 5, inputMessageIds: ['u1'], understandings: [], methods: [selection()], coverage: {} };
  f.message = contextMessage(material);
  f.snapshot = { id: 'frozen-context', sessionId: 'native-main', turn: 1, material, contextMessageId: f.message.id };
  f.events = [];
  function append(type, data) { const event = { seq: f.events.length, type, data: structuredClone(data), time: 1800000000000 + f.events.length }; f.events.push(event); return event; }
  append('turn/start', { turn: 1 }); append('step/start', { turn: 1, step: 1 }); append('user/message', f.message);
  f.assistant = { id: 'assistant-1', role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' }, content: blocks };
  append('assistant/message', { turn: 1, step: 1, message: f.assistant, stream: [] });
  f.surface = [f.message, f.assistant];
  f.session = { id: 'native-main', append, snapshotEvents: () => structuredClone(f.events), deriveMessages: () => structuredClone(f.surface) };
  f.agent = { id: 'native-main', status: 'running', session: f.session };
  f.initiator = f.agent;
  f.boundary = { openTurnStartSeq: 0, lastStepStartSeq: 1, lastStepBoundary: { kind: 'start', seq: 1 }, lastTurn: 1 };
  f.registry = { get: id => id === f.agent.id ? f.agent : undefined, currentInitiator: () => f.initiator,
    turnBoundaryOf: () => ({ ...f.boundary }) };
  f.bridge = { isBound: id => f.bound && id === f.session.id, maxContextCharacters: 24000,
    storage: { listAll(kind, { where }) { assert.equal(kind, 'context_snapshots');
      return f.snapshot && Object.entries(where).every(([key, value]) => f.snapshot[key] === value) ? [structuredClone(f.snapshot)] : []; } },
    async durablePrefix(session) { assert.equal(session, f.session); const prefix = session.snapshotEvents(); await f.onFlush?.(); return prefix; } };
  f.receipt = { adoptionIds: ['adoption-1'], methods: [{ id: 'm1', revision: 1, version: 1, contentHash: 'content-hash', adoptionId: 'adoption-1' }], authority: 'selection-receipt-only' };
  f.bundle = { version: 'arcfold-adopted-methods-v1', sessionId: f.session.id, turn: 1, startSeq: 0,
    methods: [{ adoptionId: 'adoption-1', method: { id: 'm1', guidance: 'FULL METHOD GUIDANCE' }, sources: [], selection: selection() }], authority: 'program-provided' };
  f.methods = { reserve(value) { f.reserved.push(structuredClone(value)); f.onReserve?.(); return { receipt: f.receipt, bundle: f.bundle }; } };
  f.ctx = { agents: f.registry, arcfoldBridge: f.bridge, arcfoldMethods: f.methods };
  f.execution = block => {
    append('tool/call', { turn: 1, step: 1, callId: block.id, name: block.name, arguments: block.arguments });
    return { agent: f.agent, name: block.name, callId: block.id, rootCallId: block.id,
      arguments: JSON.parse(block.arguments), signal: controller.signal, deferContext: value => f.deferred.push(value) };
  };
  f.controller = controller;
  return f;
}

async function runtime(t, f) {
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  ctx.provide('systemPrompt', { tools() { return () => {}; } });
  ctx.provide('agents', f.registry); ctx.provide('arcfoldBridge', f.bridge); ctx.provide('arcfoldMethods', f.methods);
  await ctx.plugin(ToolsService).await(); await ctx.plugin({ apply, inject }).await();
  const pipeline = new ToolExecutionPipeline(ctx);
  return { ctx, pipeline, definition: ctx.tools.get(METHOD_TOOL),
    batch: blocks => executeToolBatch({ calls: blocks, signal: f.controller.signal, agent: f.agent, log: { turn: 1, step: 1 }, maxParallelToolCalls: 4 }, pipeline, () => 4) };
}

test('method call identity derives only from the live driver, durable call and current original catalog', async () => {
  const f = fixture(), exec = f.execution(call());
  const result = await resolveNativeMethodCall(f.ctx, exec);
  assert.equal(result.sessionId, 'native-main'); assert.equal(result.turn, 1); assert.equal(result.startSeq, 0);
  assert.equal(result.contextSnapshotId, 'frozen-context'); assert.equal(result.contextMessageId, f.message.id);
  assert.equal(result.batch.length, 1); assert.equal(f.reserved.length, 0);
});

test('non-native, unbound, inactive and changed driver identities are refused', async () => {
  const edits = [
    (f, exec) => { exec.parent = Symbol('PTC'); },
    (f, exec) => { exec.rootCallId = 'outer-run-code'; },
    f => { f.bound = false; },
    f => { f.agent.status = 'idle'; },
    f => { f.initiator = {}; },
    (f, exec) => { exec.agent = { ...f.agent }; },
    f => { f.boundary.openTurnStartSeq = null; },
    f => { f.onFlush = () => { f.boundary.lastStepStartSeq = 7; }; },
    f => { f.onFlush = () => { f.controller.abort(); }; },
  ];
  for (const edit of edits) {
    const f = fixture(), exec = f.execution(call()); edit(f, exec);
    await assert.rejects(resolveNativeMethodCall(f.ctx, exec)); assert.equal(f.reserved.length, 0);
  }
});

test('missing/changed/late catalog originals and mismatching or already settled call records are refused', async () => {
  const edits = [
    f => { f.surface = [f.assistant]; },
    f => { f.snapshot.material.cutoffSequence++; },
    f => { f.events[2].data.content[0].text = 'fabricated context'; },
    f => { f.events[2].seq = 5; },
    f => { f.events[3].data.interrupted = true; },
    (f, exec) => { exec.arguments = { selections: [] }; },
    f => { f.session.append('tool/result', { turn: 1, step: 1, message: { toolCallId: 'method-call', isError: false } }); },
  ];
  for (const edit of edits) {
    const f = fixture(), exec = f.execution(call()); edit(f, exec);
    await assert.rejects(resolveNativeMethodCall(f.ctx, exec));
  }
});

test('official pipeline refuses tool-call blocks without an actual model assistant source', async t => {
  for (const change of [
    message => { message.role = 'user'; },
    message => { message.source.kind = 'program'; },
    message => { message.source.kind = 'user'; },
    message => { delete message.source.kind; },
  ]) {
    const blocks = [call()], f = fixture(blocks), r = await runtime(t, f);
    change(f.events[3].data.message);
    const output = await r.batch(blocks);
    assert.equal(output.results[0].result.isError, true);
    assert.equal(f.reserved.length, 0); assert.equal(f.deferred.length, 0);
    assert.deepEqual(output.additionalContexts, []);
  }
});

test('official native batch refuses every action when method selection is mixed, in either order or duplicated', async t => {
  for (const blocks of [[call('write', 'write', {}), call()], [call(), call('write', 'write', {})], [call('one'), call('two')]]) {
    const f = fixture(blocks), r = await runtime(t, f); let actions = 0;
    r.ctx.tools.register(defineTool({ name: 'write', description: 'Fixture side effect', parameters: {},
      output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: 'done' }] },
      async execute() { actions++; return {}; } }));
    const output = await r.batch(blocks);
    assert.equal(actions, 0); assert.equal(f.reserved.length, 0);
    assert.equal(output.results.length, 2); assert.equal(output.results.every(row => row.result.isError), true);
    assert.equal(f.events.filter(event => event.type === 'tool/result').length, 2);
  }
});

test('a batch without method selection follows the ordinary native path', async t => {
  const blocks = [call('write', 'write', {})], f = fixture(blocks), r = await runtime(t, f); let actions = 0;
  r.ctx.tools.register(defineTool({ name: 'write', description: 'Fixture side effect', parameters: {},
    output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: 'done' }] },
    async execute() { actions++; return {}; } }));
  const output = await r.batch(blocks);
  assert.equal(actions, 1); assert.equal(output.results[0].result.isError, false); assert.equal(f.reserved.length, 0);
});

test('official native result is a plain receipt; full guidance only enters deferred program context', async t => {
  const blocks = [call()], f = fixture(blocks), r = await runtime(t, f);
  const output = await r.batch(blocks);
  assert.equal(f.reserved.length, 1); assert.equal(output.results[0].result.isError, false);
  const result = f.events.find(event => event.type === 'tool/result').data.message;
  assert.deepEqual(JSON.parse(result.content[0].text), f.receipt);
  assert.equal(JSON.stringify(result).includes('FULL METHOD GUIDANCE'), false);
  assert.deepEqual(output.additionalContexts, [methodContextMessage(f.bundle)]);
  assert.deepEqual(f.reserved[0], { sessionId: 'native-main', turn: 1, startSeq: 0, callId: 'method-call',
    contextSnapshotId: 'frozen-context', contextMessageId: f.message.id, selections: [selection()], maxCharacters: 24000 });
});

test('defer failure or cancellation after reserve never refunds or issues a replacement reservation', async t => {
  for (const mode of ['defer-error', 'cancel-after-reserve']) {
    const f = fixture(), r = await runtime(t, f), exec = f.execution(call());
    if (mode === 'defer-error') exec.deferContext = () => { throw new Error('defer failed'); };
    else f.onReserve = () => f.controller.abort();
    await assert.rejects(r.definition.execute({ selections: [selection()] }, exec));
    assert.equal(f.reserved.length, 1); assert.equal(f.deferred.length, 0);
  }
});

test('model-supplied actor, snapshot and confirmation fields are rejected before reservation', async t => {
  for (const extra of [{ confirmed: true }, { contextSnapshotId: 'chosen-by-model' }, { sessionId: 'chosen-by-model' }]) {
    const args = { selections: [selection()], ...extra }, block = call('method-call', METHOD_TOOL, args);
    const f = fixture([block]), r = await runtime(t, f), output = await r.batch([block]);
    assert.equal(output.results[0].result.isError, true); assert.equal(f.reserved.length, 0);
  }
});
