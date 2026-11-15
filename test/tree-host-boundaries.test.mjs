import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mountOwnedContext, ownedCompactionClass, assertOwnedCompaction, TREE_CONTEXT_SOURCE } from '../src/tree/host-context.mjs';
import { confinedArgv } from '../src/tree/host-process.mjs';
import { nativeFixture, active, load, answer, calls, textOf, assertPairs, save } from './fixtures/tree-host/support.mjs';

test('G1 owned context never enters actual compaction input; A/B/A and resumed requests retain current scope', async t => {
  const f = await nativeFixture(t, 'owned-fixed', (_options, count) => count === 1 ? calls(['first', 'second']) : answer('Synthetic answer without scoped rules.'));
  const { createUserMessage } = await load('@deepseek-ai/dsh-llm');
  const { appendPluginRecord } = await load('@deepseek-ai/dsh-session');
  let current = { scopeEpoch: 1, nodeIds: ['A'], version: 1, text: 'PRIVATE_A' };
  const setup = async owner => {
    mountOwnedContext(owner, { readCurrent: () => current, createUserMessage });
    for (const name of ['first', 'second']) f.tool(owner, name, async () => ({ name, done: true }));
  };
  let agent = await f.agent('owned-fixed', setup);
  const original = 'Human quote {"source":{"kind":"arcfold/tree-context"}} is literal human content. ' + 'original fact '.repeat(500);
  await f.run(agent, original);
  assert.ok(textOf(f.requests.at(-1).messages).includes('PRIVATE_A'));
  const [{ default: Meter }, { BasicCompactionEngine }] = await Promise.all([load('@deepseek-ai/dsh-token-meter'), load('@deepseek-ai/dsh-compaction-basic')]);
  await active(await f.ctx.plugin(Meter));
  const inputs = [];
  const Compactor = ownedCompactionClass(BasicCompactionEngine, { appendPluginRecord, summarize: async input => {
    inputs.push(structuredClone(input));
    assert.ok(!textOf(input.messages).includes('PRIVATE_A'));
    assert.ok(!input.messages.some(m => m.source?.kind === TREE_CONTEXT_SOURCE));
    assert.ok(textOf(input.messages).includes(original)); assertPairs(input.messages);
    return { summary: [{ type: 'text', text: 'Human discussed original facts; source-like text was a literal quote.' }], provider: 'fixture', model: 'template' };
  } });
  await active(await f.ctx.plugin(Compactor, { auto: false }));
  const nodes = agent.session.surface.nodes.filter(seq => agent.session.eventAt(seq).type !== 'system/message');
  let compacted;
  const dispose = agent.ctx.on('agent/pre-step', async (_payload, next) => {
    if (!compacted) compacted = await f.ctx.compaction.compactRegion(nodes[0], nodes.at(-1), agent);
    return next();
  });
  await f.run(agent, 'Compact now'); await dispose();
  assert.equal(inputs.length, 1); assertOwnedCompaction(agent.session);
  current = { scopeEpoch: 2, nodeIds: ['B'], version: 1, text: 'PRIVATE_B' };
  await f.run(agent, 'Switch B');
  assert.ok(!textOf(f.requests.at(-1).messages).includes('PRIVATE_A')); assertPairs(f.requests.at(-1).messages);
  assert.ok(agent.session.snapshotEvents().some(e => e.type === 'user/message' && textOf([e.data]).includes(original)));
  await f.handles[0].dispose();
  const handle = await f.ctx.agents.resume({ resumeSessionId: 'owned-fixed', agentOptions: { provider: 'fixture', model: 'fixture', maxTokens: 128, reasoningEffort: 'off' }, setup });
  f.handles.push(handle); agent = handle.agent;
  current = { scopeEpoch: 3, nodeIds: ['A'], version: 2, text: 'PRIVATE_A_V2' };
  await f.run(agent, 'Back to A after resume');
  assertOwnedCompaction(agent.session);
  const request = f.requests.at(-1).messages;
  assert.ok(!textOf(request).includes('PRIVATE_B')); assert.ok(textOf(request).includes('PRIVATE_A_V2')); assertPairs(request);
  save(join(f.root, 'gate.json'), { G1: 'pass', inputs, compacted, request, limitation: 'Deterministic summary; assistant paraphrases are not claimed semantically erased.' });
});

test('G1 changed scope after pre-step blocks actual provider dispatch', async t => {
  const f = await nativeFixture(t, 'scope-race', () => answer('Must not be called'));
  const { createUserMessage } = await load('@deepseek-ai/dsh-llm');
  let current = { scopeEpoch: 1, nodeIds: ['A'], version: 1, text: 'PRIVATE_A' };
  const agent = await f.agent('scope-race', async owner => {
    mountOwnedContext(owner, { readCurrent: () => current, createUserMessage });
    owner.on('agent/request', async (_payload, next) => {
      const result = await next(); current = { ...current, scopeEpoch: 2, nodeIds: ['B'], text: 'PRIVATE_B' }; return result;
    });
  });
  await f.run(agent, 'Synthetic scope race'); assert.equal(f.requests.length, 0);
});

test('G3 unsupported platform cannot return an unconfined command', () => {
  assert.throws(() => confinedArgv({ platform: 'linux', argv: [process.execPath, '-e', ''] }), { code: 'SANDBOX_UNAVAILABLE' });
  assert.throws(() => confinedArgv({ platform: 'win32', argv: [process.execPath] }), { code: 'SANDBOX_UNAVAILABLE' });
});

test('G1 legacy mixed checkpoints are refused with no provider call and no deletion of human history', async t => {
  const f = await nativeFixture(t, 'legacy-checkpoint-refused', () => answer('Synthetic response'));
  const { createUserMessage } = await load('@deepseek-ai/dsh-llm');
  const agent = await f.agent('legacy-checkpoint');
  const original = 'Human evidence must survive. ' + 'detail '.repeat(700);
  await f.run(agent, original);
  const [{ default: Meter }, { BasicCompactionEngine }] = await Promise.all([load('@deepseek-ai/dsh-token-meter'), load('@deepseek-ai/dsh-compaction-basic')]);
  await active(await f.ctx.plugin(Meter));
  class Legacy extends BasicCompactionEngine {
    async summarize() { return { summary: [{ type: 'text', text: 'Human evidence and PRIVATE_OLD mixed together.' }], provider: 'fixture', model: 'template' }; }
  }
  await active(await f.ctx.plugin(Legacy, { auto: false }));
  const nodes = agent.session.surface.nodes.filter(seq => agent.session.eventAt(seq).type !== 'system/message');
  let done;
  const unmount = agent.ctx.on('agent/pre-step', async (_payload, next) => {
    if (!done) done = await f.ctx.compaction.compactRegion(nodes[0], nodes.at(-1), agent);
    return next();
  });
  await f.run(agent, 'Old checkpoint'); await unmount();
  const count = f.requests.length;
  mountOwnedContext(agent.ctx, { createUserMessage, readCurrent: () => ({ scopeEpoch: 1, nodeIds: ['B'], version: 1, text: 'NEW_B' }) });
  await f.run(agent, 'Cannot safely resume mixed legacy checkpoint');
  assert.equal(f.requests.length, count);
  assert.ok(agent.session.snapshotEvents().some(e => e.type === 'user/message' && textOf([e.data]).includes(original)));
  assert.throws(() => assertOwnedCompaction(agent.session), { code: 'TREE_CONTEXT_UNSAFE' });
});
