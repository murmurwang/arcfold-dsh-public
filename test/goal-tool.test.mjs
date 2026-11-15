// Exercise the official tool pipeline against deterministic native session evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import ToolsService, { defineTool } from '@deepseek-ai/dsh-tools';
import { ToolExecutionPipeline, executeToolBatch } from '@deepseek-ai/dsh-tools/pipeline';
import { contextMessage } from '../src/context-material.mjs';
import { GOAL_TOOL, goalContextMessage } from '../src/goal-context.mjs';
import { apply, inject } from '../src/goal-tool.mjs';

const selection = () => ({ id: 'g1', revision: 2, definitionVersion: 1, contentHash: 'goal-hash',
  reason: 'This work supports the shown intended outcome.', sourceIds: ['s1'] });
const call = (id = 'goal-call', name = GOAL_TOOL, args = { selection: selection() }) =>
  ({ type: 'tool-call', id, name, arguments: JSON.stringify(args) });
function fixture(blocks = [call()]) {
  const f = { bound: true, linked: [], events: [], controller: new AbortController() };
  const material = { version: 'arcfold-context-v1', sessionId: 'main', turn: 1, cutoffSequence: 5,
    inputMessageIds: ['u1'], understandings: [], methods: [], goals: [selection()], coverage: {} };
  f.message = contextMessage(material);
  f.snapshot = { id: 'snapshot', sessionId: 'main', turn: 1, material, contextMessageId: f.message.id };
  const append = (type, data) => {
    const event = { type, data: structuredClone(data), seq: f.events.length, time: 1800000000000 + f.events.length };
    f.events.push(event); return event;
  };
  append('turn/start', { turn: 1 }); append('step/start', { turn: 1, step: 1 }); append('user/message', f.message);
  f.assistant = { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' }, content: blocks };
  append('assistant/message', { turn: 1, step: 1, message: f.assistant, stream: [] });
  f.surface = [f.message, f.assistant];
  f.session = { id: 'main', append, snapshotEvents: () => structuredClone(f.events), deriveMessages: () => structuredClone(f.surface) };
  f.agent = { id: 'main', status: 'running', session: f.session };
  f.registry = { get: id => id === 'main' ? f.agent : undefined, currentInitiator: () => f.agent,
    turnBoundaryOf: () => ({ openTurnStartSeq: 0, lastStepStartSeq: 1, lastStepBoundary: { kind: 'start', seq: 1 }, lastTurn: 1 }) };
  f.bridge = { isBound: () => f.bound, maxContextCharacters: 24000,
    storage: { listAll: (kind, { where }) => kind === 'context_snapshots' &&
      Object.entries(where).every(([key, value]) => f.snapshot[key] === value) ? [structuredClone(f.snapshot)] : [] },
    async durablePrefix(session) { const events = session.snapshotEvents(); await f.onFlush?.(); return events; } };
  f.receipt = { linkId: 'link-1', goal: { id: 'g1', revision: 2, definitionVersion: 1, contentHash: 'goal-hash' }, authority: 'interpretation-only' };
  f.bundle = { version: 'arcfold-linked-goal-v1', sessionId: 'main', turn: 1, startSeq: 0,
    links: [{ linkId: 'link-1', goal: { id: 'g1', outcome: 'FULL GOAL OUTCOME' }, relatedGoals: [], sources: [], coverage: {}, selection: selection() }] };
  f.goals = { link(value) { f.linked.push(structuredClone(value)); f.onLink?.(); return { receipt: f.receipt, bundle: f.bundle }; } };
  return f;
}
async function runtime(t, f) {
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  ctx.provide('systemPrompt', { tools: () => () => {} }); ctx.provide('agents', f.registry);
  ctx.provide('arcfoldBridge', f.bridge); ctx.provide('arcfoldGoals', f.goals);
  await ctx.plugin(ToolsService).await(); await ctx.plugin({ apply, inject }).await();
  const pipeline = new ToolExecutionPipeline(ctx);
  return { ctx, batch: blocks => executeToolBatch({ calls: blocks, signal: f.controller.signal,
    agent: f.agent, log: { turn: 1, step: 1 }, maxParallelToolCalls: 4 }, pipeline, () => 4) };
}

test('native goal tool links the displayed version and defers full context separately from the receipt', async t => {
  const blocks = [call()], f = fixture(blocks), r = await runtime(t, f), output = await r.batch(blocks);
  assert.equal(output.results[0].result.isError, false);
  assert.deepEqual(f.linked, [{ sessionId: 'main', turn: 1, startSeq: 0, callId: 'goal-call',
    contextSnapshotId: 'snapshot', contextMessageId: f.message.id, selection: selection(), maxCharacters: 24000 }]);
  const result = f.events.find(event => event.type === 'tool/result').data.message;
  assert.deepEqual(JSON.parse(result.content[0].text), f.receipt);
  assert.equal(JSON.stringify(result).includes('FULL GOAL OUTCOME'), false);
  assert.deepEqual(output.additionalContexts, [goalContextMessage(f.bundle)]);
});

test('goal selection cannot share a native batch with actions, method selection or another goal call', async t => {
  for (const blocks of [[call(), call('write', 'write', {})], [call('write', 'write', {}), call()],
    [call(), call('method', 'arcfold_use_methods', {})], [call('one'), call('two')]]) {
    const f = fixture(blocks), r = await runtime(t, f); let actions = 0;
    for (const name of ['write', 'arcfold_use_methods']) r.ctx.tools.register(defineTool({ name, description: 'Fixture action', parameters: {},
      output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: 'done' }] }, execute() { actions++; return {}; } }));
    const output = await r.batch(blocks);
    assert.equal(actions, 0); assert.equal(f.linked.length, 0);
    assert.equal(output.results.length, blocks.length); assert.equal(output.results.every(row => row.result.isError), true);
  }
});

test('goal tool never accepts user authority, binding mode, chosen native identity or extra selection fields', async t => {
  for (const args of [{ selection: selection(), confirmed: true }, { selection: selection(), sessionId: 'helper' },
    { selection: { ...selection(), mode: 'repair' } }, { selection: { ...selection(), userIdentity: 'pretend' } }]) {
    const blocks = [call('bad', GOAL_TOOL, args)], f = fixture(blocks), r = await runtime(t, f), output = await r.batch(blocks);
    assert.equal(output.results[0].result.isError, true); assert.equal(f.linked.length, 0);
  }
});

test('unbound helper and changed original catalog cannot acquire a business goal link', async t => {
  for (const change of [f => { f.bound = false; }, f => { f.events[2].data.content[0].text = 'changed'; },
    f => { f.assistant.source.kind = 'user'; f.events[3].data.message.source.kind = 'user'; },
    f => { f.onFlush = () => f.controller.abort(); }]) {
    const blocks = [call()], f = fixture(blocks); change(f); const r = await runtime(t, f);
    await r.batch(blocks).catch(error => { assert.equal(f.controller.signal.aborted, true); });
    assert.equal(f.linked.length, 0);
  }
});

test('cancellation after the business link cannot expose an unconfirmed full goal context', async t => {
  const blocks = [call()], f = fixture(blocks); f.onLink = () => f.controller.abort();
  const r = await runtime(t, f), deferred = [];
  f.session.append('tool/call', { turn: 1, step: 1, callId: 'goal-call', name: GOAL_TOOL, arguments: blocks[0].arguments });
  await assert.rejects(r.ctx.tools.get(GOAL_TOOL).execute({ selection: selection() }, {
    agent: f.agent, name: GOAL_TOOL, callId: 'goal-call', rootCallId: 'goal-call', arguments: { selection: selection() },
    signal: f.controller.signal, deferContext: message => deferred.push(message),
  }));
  assert.equal(f.linked.length, 1); assert.deepEqual(deferred, []);
});
