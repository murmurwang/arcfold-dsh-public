import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeSources } from '../src/tree/experience.mjs';
import { digest } from '../src/tree/contracts.mjs';

const SESSION = 'session-a';
function log(count) {
  return Array.from({ length: count }, (_, seq) => seq % 2
    ? { seq, type: 'assistant/message', time: 1000 + seq, data: { message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: `回答 ${seq}` }] } } }
    : { seq, type: 'user/message', time: 1000 + seq, data: { id: `m${seq}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `问题 ${seq}` }] } });
}
const refOf = (events, seq) => ({ sessionId: SESSION, seq, ...(events[seq].type === 'user/message' ? { messageId: events[seq].data.id } : {}), sha256: digest(events[seq]) });

function harness(events, { revoked = () => false } = {}) {
  const state = { events, reads: 0 };
  const sources = new NativeSources({ isRevoked: revoked, readSession: id => { state.reads++; return { sessionId: id, durable: true, events: state.events }; } });
  return { sources, state };
}

test('many lookups in one log copy the log once', () => {
  const events = log(1000), { sources } = harness(events);
  const copy = sources.events(SESSION);
  assert.notEqual(copy, events);
  const started = performance.now();
  for (let seq = 0; seq < 100; seq++) assert.ok(sources.resolve(refOf(events, seq)));
  sources.resolveMany([refOf(events, 5), refOf(events, 6)]);
  assert.equal(sources.events(SESSION), copy);
  assert.ok(performance.now() - started < 1000, 'lookups reuse the copy instead of re-copying the log');
});

test('a re-frozen log is copied again and its new events resolve', () => {
  const first = log(10), { sources, state } = harness(first);
  const before = sources.events(SESSION);
  assert.ok(sources.resolve(refOf(first, 3)));
  const second = log(12);
  state.events = second;
  const after = sources.events(SESSION);
  assert.notEqual(after, before);
  assert.equal(after.length, 12);
  assert.ok(sources.resolve(refOf(second, 11)));
  assert.equal(sources.events(SESSION), after);
});

test('results equal the uncached projection and mismatches still resolve to nothing', () => {
  const events = log(20), { sources } = harness(events, { revoked: ref => ref.seq === 7 });
  const user = sources.resolve(refOf(events, 4)), model = sources.resolve(refOf(events, 5));
  assert.equal(user.role, 'user'); assert.equal(user.text, '问题 4');
  assert.equal(model.role, 'assistant'); assert.equal(model.text, '回答 5');
  assert.deepEqual(sources.resolve(refOf(events, 4)), user);
  assert.equal(sources.resolve({ ...refOf(events, 4), sha256: 'a'.repeat(64) }), null);
  assert.equal(sources.resolve({ ...refOf(events, 4), messageId: 'other' }), null);
  assert.equal(sources.resolve(refOf(events, 7)), null);
  assert.equal(sources.resolve({ ...refOf(events, 4), seq: 40 }), null);
});

test('a broken sequence is still refused and is not cached as valid', () => {
  const events = log(5); events[2] = { ...events[2], seq: 9 };
  const { sources } = harness(events);
  assert.throws(() => sources.events(SESSION), { code: 'NATIVE_LOG_INVALID' });
  assert.throws(() => sources.events(SESSION), { code: 'NATIVE_LOG_INVALID' });
});

test('callers cannot change what the next lookup sees', () => {
  const events = log(6), { sources } = harness(events);
  const copy = sources.events(SESSION);
  assert.throws(() => { copy[0].data.content[0].text = 'changed'; }, TypeError);
  assert.throws(() => { sources.resolve(refOf(events, 0)).content[0].text = 'changed'; }, TypeError);
  assert.equal(sources.resolve(refOf(events, 0)).text, '问题 0');
  events[0].data.content[0].text = 'host changed its own array';
  assert.equal(sources.events(SESSION)[0].data.content[0].text, '问题 0');
});

test('an append to the same log array is seen by the next lookup', () => {
  const events = log(4), { sources } = harness(events);
  const before = sources.events(SESSION);
  events.push({ seq: 4, type: 'user/message', time: 2000, data: { id: 'm4', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '追加' }] } });
  assert.equal(sources.resolve(refOf(events, 4)).text, '追加');
  assert.notEqual(sources.events(SESSION), before);
  events[4] = { ...events[4], data: { ...events[4].data, content: [{ type: 'text', text: '替换末尾' }] } };
  assert.equal(sources.resolve(refOf(events, 4)).text, '替换末尾');
});
