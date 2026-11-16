import test from 'node:test';
import assert from 'node:assert/strict';
import { bindNativeTurnSelection, captureNativeSelection, nativeAgentOptions, nativeModelConfig } from '../src/tree/native-models.mjs';

test('native model changes remain pending until the originating turn ends', () => {
  const events = [], first = { provider: 'synthetic-a', model: 'a', reasoningEffort: 'medium' };
  let selected = first;
  const original = { current: () => ({ ...selected }), select: value => { selected = value; } };
  const agent = { model: original, session: { snapshotEvents: () => events } }, dispose = bindNativeTurnSelection(agent);
  events.push({ type: 'turn/start', seq: 1 });
  assert.deepEqual(agent.model.current(), first);
  const next = { provider: 'synthetic-b', model: 'b' };
  agent.model.select(next);
  assert.deepEqual(selected, next, 'the native pending projection still sees the new choice');
  assert.deepEqual(agent.model.current(), first, 'later tool steps keep the same turn choice');
  events.push({ type: 'turn/end', seq: 2 });
  assert.deepEqual(agent.model.current(), next);
  events.push({ type: 'turn/start', seq: 3 });
  assert.deepEqual(agent.model.current(), next);
  dispose(); assert.equal(agent.model, original);
});

test('all native roles inherit arbitrary host efforts and explicit absence', async () => {
  const host = { llm: { prepareCall: async request => ({ config: { ...request, maxTokens: 4096 }, context: { contextWindow: 32768 } }) } };
  for (const reasoningEffort of [undefined, 'medium', 'xhigh']) {
    const source = await captureNativeSelection(host, { options: {}, session: {} }, { provider: 'synthetic', model: 'model', reasoningEffort });
    for (const role of ['main', 'attribution', 'learning', 'consolidation', 'verification', 'improvement', 'script_writer']) {
      const config = nativeModelConfig(role, source, '/synthetic/workspace');
      assert.equal(config.reasoningEffort, reasoningEffort ?? null);
      assert.equal(config.provider, 'synthetic');
      assert.equal(config.contextWindow, 32768);
      assert.equal(nativeAgentOptions(config).reasoningEffort, reasoningEffort);
      assert.equal(config.maxTokens, role === 'attribution' ? 2048 : 4096);
    }
  }
  assert.throws(() => nativeModelConfig('learning', undefined, '/synthetic/workspace'), { code: 'MODEL_SOURCE_MISSING' });
});

test('adapter-derived output defaults are re-resolved for the newly selected model', async () => {
  const requests = [], host = { llm: { prepareCall: async request => { requests.push(request); return { config: { ...request, maxTokens: 4096 } }; } } };
  await captureNativeSelection(host, { options: { maxTokens: 128000 }, session: { requestHeader: () => ({ config: { maxTokens: 128000 }, adapterDefaults: { maxTokens: true } }) } }, { provider: 'new', model: 'new' });
  assert.equal(Object.hasOwn(requests[0], 'maxTokens'), false);
  assert.equal(Object.hasOwn(requests[0], 'reasoningEffort'), false);
});
