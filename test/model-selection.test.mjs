import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import SessionStore from '@deepseek-ai/dsh-session';
import SessionProjections from '@deepseek-ai/dsh-session-projection';
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModelSelectionHandler } from '../src/model-selection.mjs';
const first = Object.freeze({ provider: 'fixture', model: 'one', reasoningEffort: 'off' });
const second = Object.freeze({ provider: 'fixture', model: 'two', reasoningEffort: 'off' });
class Adapter extends LlmAdapter {
  async resolveModel(provider, id) { return { provider, id, name: id, defaultMaxTokens: 64,
    reasoning: { efforts: [{ id: 'off', name: 'Off' }], defaultEffort: 'off' } }; }
  async *stream() { throw new Error('This native maintenance fixture never authorizes model streaming'); }
}
async function harness(t, { preStep, save, flush, validate } = {}) {
  const ctx = new Context(); let handle, selectedDefault = { ...first }, saveCount = 0;
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'native-model-save-'));
  t.after(async () => { await handle?.dispose(); await ctx.fiber.dispose(); });
  for (const plugin of [LlmRuntime, SessionStore, SessionProjections]) await ctx.plugin(plugin);
  await ctx.plugin(JsonlPersistence, { root, compression: 'none' });
  await ctx.plugin(SystemPrompt, { personaPrefix: '' });
  for (const plugin of [ToolRuntime, NativeToolExecutor, AgentRegistry]) await ctx.plugin(plugin);
  await ctx.plugin(AgentLoop, { agents: [] });
  ctx.llm.registerAdapter(['fixture'], new Adapter());
  handle = await ctx.agents.create({ sessionId: 'native-model-save', agentOptions: { ...first, maxTokens: 64 },
    setup: async agentCtx => { agentCtx.tools.restrict({ allow: [] });
      agentCtx.on('agent/pre-step', preStep ?? (async () => ({ kind: 'reject' }))); } });
  const agent = handle.agent;
  const defaults = { async saveSelection(value) { saveCount++; await save?.(value); selectedDefault = { ...value }; },
    currentSelection() { return { ...selectedDefault }; } };
  const sessions = { get: id => ctx.sessions.get(id), flush: flush ?? (session => ctx.sessions.flush(session)) };
  const handler = createModelSelectionHandler({ sessions, defaults, assertSelection: validate ?? (async (actual, choice) => {
    assert.equal(actual, agent); assert.deepEqual(choice, second);
  }) });
  return { ctx, agent, handler, defaults, saves: () => saveCount };
}
test('native idle maintenance waits for save and durable selection before success', async t => {
  const gate = Promise.withResolvers(), entered = Promise.withResolvers();
  const f = await harness(t, { save: async () => { entered.resolve(); await gate.promise; } });
  let done = false; const result = f.handler({ agent: f.agent, selected: second }).then(value => { done = true; return value; });
  await entered.promise; assert.equal(done, false); assert.equal(f.agent.model.current().model, 'one');
  gate.resolve(); assert.deepEqual(await result, { selected: second });
  assert.equal(f.agent.model.current().model, 'two'); assert.equal(f.defaults.currentSelection().model, 'two');
  const reader = await f.ctx.sessionPersistence.open(f.agent.id, 'read');
  try { const read = await reader.read(0); assert.ok(read.events.some(e => e.type === 'model/selection' && e.data.model === 'two')); }
  finally { await reader.close(); }
});
test('active native turn refuses model change without default or session writes', async t => {
  const gate = Promise.withResolvers(), entered = Promise.withResolvers();
  const f = await harness(t, { preStep: async () => { entered.resolve(); await gate.promise; return { kind: 'reject' }; } });
  f.agent.followup(createUserMessage('fixture active turn')); await entered.promise;
  await assert.rejects(f.handler({ agent: f.agent, selected: second }), { code: 'model_selection_busy' });
  assert.equal(f.saves(), 0); assert.equal(f.agent.model.current().model, 'one');
  gate.resolve(); await f.agent.whenIdle();
});
test('input arriving during native save stays in native inbox until maintenance ends', async t => {
  const gate = Promise.withResolvers(), entered = Promise.withResolvers(), driven = Promise.withResolvers(); let steps = 0;
  const f = await harness(t, { save: async () => { entered.resolve(); await gate.promise; },
    preStep: async () => { steps++; driven.resolve(); return { kind: 'reject' }; } });
  const saved = f.handler({ agent: f.agent, selected: second }); await entered.promise;
  f.agent.followup(createUserMessage('fixture queued input')); assert.equal(steps, 0);
  gate.resolve(); await saved; await driven.promise; await f.agent.whenIdle();
  assert.equal(steps, 1); assert.equal(f.agent.model.current().model, 'two');
});
test('default-save failure leaves session unchanged; later writer failure preserves actual partial state', async t => {
  const a = await harness(t, { save: async () => { throw new Error('fixture default failure'); } });
  await assert.rejects(a.handler({ agent: a.agent, selected: second }), /fixture default failure/);
  assert.equal(a.agent.model.current().model, 'one'); assert.equal(a.defaults.currentSelection().model, 'one');
  const b = await harness(t, { flush: async () => false });
  await assert.rejects(b.handler({ agent: b.agent, selected: second }), { code: 'model_selection_not_durable' });
  assert.equal(b.agent.model.current().model, 'two'); assert.equal(b.defaults.currentSelection().model, 'two');
});
test('current route invalidation after default save prevents session commit and reports failure', async t => {
  let checks = 0;
  const f = await harness(t, { validate: async () => { if (++checks === 2) throw new Error('fixture route withdrawn'); } });
  await assert.rejects(f.handler({ agent: f.agent, selected: second }), /fixture route withdrawn/);
  assert.equal(f.defaults.currentSelection().model, 'two'); assert.equal(f.agent.model.current().model, 'one');
});
