import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.mjs';
import { collectContext, contextMessage, refreshContext } from '../src/context-material.mjs';

function fixture() {
  const store = new Store(':memory:');
  const source = store.save('events', { id: 'source-one', role: 'user', content: '请保留完整原文', conversationId: 'session-a', occurredAt: '2026-11-06T00:00:00Z' });
  const understanding = store.save('understandings', { id: 'understanding-one', status: 'active', content: '此讨论要求原文完整可查', scope: { conversationId: 'session-a' }, sourceIds: [source.id], dependencies: [{ kind: 'events', id: source.id, revision: source.revision }], claimType: 'user_statement' });
  return { store, source, understanding };
}
test('paraphrase is inference; full original and version enter the material', t => {
  const { store } = fixture(); t.after(() => store.close());
  const material = collectContext(store, { sessionId: 'session-a', turn: 1 });
  assert.equal(material.understandings[0].claimType, 'inference');
  assert.equal(material.understandings[0].evidence[0].content, '请保留完整原文');
  assert.equal(collectContext(store, { sessionId: 'session-b', turn: 1 }).understandings.length, 0);
});
test('late learning is not added to the current frozen turn', t => {
  const { store, source } = fixture(); t.after(() => store.close());
  const material = collectContext(store, { sessionId: 'session-a', turn: 1 });
  store.save('understandings', { id: 'late', status: 'active', content: '新认识', sourceIds: [source.id], dependencies: [{ kind: 'events', id: source.id, revision: 1 }] });
  assert.equal(refreshContext(store, material).understandings.length, 1);
  assert.equal(collectContext(store, { sessionId: 'session-a', turn: 2 }).understandings.length, 2);
});
test('source control withdraws current use without rewriting the original', t => {
  const { store, source } = fixture(); t.after(() => store.close());
  const material = collectContext(store, { sessionId: 'session-a', turn: 1 });
  store.save('source_controls', { id: source.id, useProhibited: true });
  assert.equal(refreshContext(store, material).understandings.length, 0);
  assert.deepEqual(store.get('events', source.id), source);
});
test('derived understanding carries recursively supporting originals', t => {
  const { store, source, understanding } = fixture(); t.after(() => store.close());
  const second = store.save('events', { id: 'second', role: 'assistant', content: '我会保留原件' });
  store.save('understandings', { id: 'derived', status: 'active', content: '后续输出需可回查', sourceIds: [second.id], dependencies: [{ kind: 'understandings', id: understanding.id, revision: 1 }, { kind: 'events', id: second.id, revision: 1 }] });
  const derived = collectContext(store, { sessionId: 'session-a', turn: 1 }).understandings.find(row => row.id === 'derived');
  assert.deepEqual(new Set(derived.evidence.map(row => row.id)), new Set([source.id, second.id]));
});
test('large unavailable inventory cannot overrun the actual serialized message', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  for (let i = 0; i < 100; i++) store.save('understandings', { id: 'invalid-' + i, status: 'active', content: '不可用', sourceIds: ['missing'] });
  const material = collectContext(store, { sessionId: 'session-a', turn: 1, maxCharacters: 1000 });
  assert.equal(material.coverage.omitted.unavailable, 100);
  assert.ok(contextMessage(material).content[0].text.length <= 1000);
});

test('literal user background and assistant interpretation keep separate authorship without action authority', t => {
  const { store, source, understanding } = fixture(); t.after(() => store.close());
  store.save('understandings', { id: 'literal', status: 'active', content: source.content, claimType: 'user_statement',
    scope: understanding.scope, sourceIds: [source.id], dependencies: [{ kind: 'events', id: source.id, revision: source.revision }] });
  const material = collectContext(store, { sessionId: 'session-a', turn: 1 });
  assert.equal(material.understandings.find(row => row.id === 'literal').claimType, 'user_statement');
  assert.equal(material.understandings.find(row => row.id === understanding.id).claimType, 'inference');
  assert.match(material.authority, /verbatim user text/); assert.match(material.authority, /neither is proof of truth or action permission/);
});
