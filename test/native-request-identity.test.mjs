import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeRequestIdentity } from '../src/deepseek-budget-plugin.mjs';

function fixture() {
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'step/start', data: { turn: 1, step: 1 } },
    { seq: 2, type: 'user/message', data: { content: [{ type: 'text', text: 'original user input' }] } },
  ];
  const options = { sessionId: 'native-main', provider: 'deepseek-official', model: 'deepseek-v4-pro', maxTokens: 128, reasoningEffort: 'off' };
  const state = { main: true, helpers: [], config: { ...options } };
  const session = { id: options.sessionId, snapshotEvents: () => structuredClone(events), requestHeader: () => ({ config: state.config }) };
  const sessions = { get: id => id === session.id ? session : undefined };
  const business = { get: (_kind, id) => state.main && id === session.id ? { role: 'main' } : undefined,
    listAll: (kind, { where }) => (kind === 'learning_runs' ? state.helpers : state.preparations ?? []).filter(row => row.sessionId === where.sessionId) };
  return { events, options, state, session, run: input => nativeRequestIdentity(business, sessions, input ?? options) };
}

test('request identity belongs to one native step and preserves its observed prefix', () => {
  const f = fixture(), first = f.run();
  assert.match(first.requestId, /^dsh-messages-[0-9a-f]{64}$/);
  assert.deepEqual(f.run(), first);
  f.events.push({ seq: 3, type: 'request/header', data: { additional: true } });
  const later = f.run();
  assert.equal(later.requestId, first.requestId, 'Additional metadata cannot give the same native step a second paid identity');
  assert.notEqual(later.metadata.nativePrefixHash, first.metadata.nativePrefixHash);
  assert.equal(later.metadata.nativeThroughSeq, 3);
  f.events.push({ seq: 4, type: 'step/end', data: { turn: 1, step: 1 } },
    { seq: 5, type: 'step/start', data: { turn: 1, step: 2 } });
  assert.notEqual(f.run().requestId, first.requestId);
});

test('only a single owned main or already guarded learning request can acquire an identity', () => {
  const f = fixture();
  assert.throws(() => f.run({ ...f.options, purpose: 'background-extra' }));
  assert.throws(() => f.run({ ...f.options, sessionId: 'unrelated' }));
  f.state.main = false; assert.throws(() => f.run());
  const helper = { id: 'pending-1', sessionId: f.session.id, inputHash: 'frozen-learning', state: 'submitted', dispatchCount: 0 };
  f.state.helpers.push(helper); assert.throws(() => f.run());
  helper.dispatchCount = 1;
  assert.equal(f.run().metadata.learningInputHash, 'frozen-learning');
  f.state.main = true; assert.throws(() => f.run());
  f.state.main = false; helper.state = 'unknown'; assert.throws(() => f.run());
});

test('completed or attempted steps and configuration drift cannot be paid again', () => {
  for (const type of ['assistant/message', 'assistant/attempt', 'step/end', 'turn/end']) {
    const f = fixture(); f.events.push({ seq: 3, type, data: {} });
    assert.throws(() => f.run());
  }
  for (const change of [{ model: 'different' }, { provider: 'different' }, { maxTokens: 129 }, { reasoningEffort: 'high' }]) {
    const f = fixture(); assert.throws(() => f.run({ ...f.options, ...change }));
  }
  const f = fixture(); f.events[0].data.turn = 2; assert.throws(() => f.run());
});


test('preparation is a third unique submitted native owner with the exact admitted step, not main or Learn', () => {
  const f = fixture(); f.state.main = false;
  const run = { id: 'preparation', sessionId: f.session.id, inputHash: 'frozen', state: 'submitted', requests: [{ stepStartSeq: 1 }] };
  f.state.preparations = [run]; assert.equal(f.run().metadata.role, 'preparation');
  assert.equal(f.run().metadata.preparationInputHash, 'frozen');
  f.state.main = true; assert.throws(() => f.run()); f.state.main = false;
  f.state.helpers.push({ sessionId: f.session.id, state: 'submitted', dispatchCount: 1 }); assert.throws(() => f.run()); f.state.helpers = [];
  run.requests = []; assert.throws(() => f.run()); run.requests = [{ stepStartSeq: 1 }];
  run.state = 'unknown'; assert.throws(() => f.run());
});
