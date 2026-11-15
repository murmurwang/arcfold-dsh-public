import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { BusinessStore, eventId, messageText } from '../src/business.mjs';
import { Store, canonicalJson } from '../src/store.mjs';

const sessionId = 'session-main';
const text = value => ({ type: 'text', text: value });
const model = { kind: 'model', provider: 'fake', model: 'fixture' };
const message = (id, role, source, content) => ({ id, role, source, content });
const event = (type, data, surfaceOp) => ({ type, data, ...(surfaceOp ? { surfaceOp } : {}) });
const numbered = values => values.map((item, seq) => ({ ...item, seq, time: 1800000000000 + seq }));
function replyEvents({ reason = { kind: 'completed' }, content = [text('已为你整理。')], interrupted = false } = {}) {
  return numbered([
    event('turn/start', { turn: 1 }),
    event('step/start', { turn: 1, step: 1 }),
    event('user/message', message('u1', 'user', { kind: 'user' }, [text('帮我理清想法')]), 'append'),
    event('request/header', { header: { system: 'not copied: '.repeat(2000) }, reason: 'fixture' }),
    event('assistant/message', { turn: 1, step: 1,
      message: message('a1', 'assistant', model, content), stream: [{ opaque: 'raw stream '.repeat(2000) }],
      ...(interrupted ? { interrupted: true } : {}) }, 'append'),
    event('step/end', { turn: 1, step: 1 }),
    event('turn/end', { turn: 1, reason }),
  ]);
}
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'arcfold-business-'));
  const filename = join(dir, 'business.sqlite');
  let business = new BusinessStore({ filename });
  t.after(() => { business.close(); rmSync(dir, { recursive: true, force: true }); });
  return { get business() { return business; }, reopen() {
    business.close(); business = new BusinessStore({ filename }); return business;
  } };
}
const hasCode = code => error => error.code === code;
const hash = value => createHash('sha256').update(canonicalJson(value)).digest('hex');

function inboxReplyEvents() {
  const input = message('claimed-u1', 'user', { kind: 'user', rpcId: 'browser-request-1' }, [text('围绕暂停的目标讨论，不恢复它。')]);
  const reply = replyEvents();
  reply[2].data = input;
  return numbered([
    event('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [input] }),
    reply[0],
    event('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
    ...reply.slice(1),
  ]);
}

test('claimed input keeps the exact durable inbox source, one body and stable identity through formal admission and delivery', t => {
  const f = fixture(t), events = inboxReplyEvents(), input = events[0].data.inserted[0], prefix = events.slice(0, 3);
  const [ref] = f.business.ingestClaimedInputs({ sessionId, events: prefix, messages: [input] });
  assert.deepEqual(ref, { messageId: input.id, sourceId: `dsh-inbox:${hash([sessionId, 0, 0])}`,
    inboxRef: { sessionId, seq: 0, type: 'agent/inbox/spliced', sha256: hash(events[0]), index: 0 }, messageHash: hash(input) });
  const source = f.business.get('events', ref.sourceId);
  assert.deepEqual(source.message, input); assert.equal(source.role, 'user'); assert.equal(source.author, 'user');
  assert.equal(source.occurredAt, new Date(events[0].time).toISOString());
  assert.deepEqual(source.provenance.sourceRef, ref.inboxRef); assert.equal(source.surfaceOp, null);
  assert.equal(f.business.listAll('events').length, 1);
  assert.equal(f.business.listAll('deliveries').length, 0); assert.equal(f.business.listAll('learning_pending').length, 0);
  assert.equal(f.business.settleTurn({ sessionId, turn: 1, events: prefix }).reason, 'incomplete_turn');
  const beforeReplay = f.business.storage.currentSequence();
  const reordered = Object.fromEntries(Object.entries(input).reverse());
  assert.deepEqual(f.reopen().ingestClaimedInputs({ sessionId, events: prefix, messages: [reordered] }), [ref]);
  assert.equal(f.business.storage.currentSequence(), beforeReplay);
  const result = f.business.settleTurn({ sessionId, turn: 1, events });
  assert.equal(result.status, 'delivered'); assert.equal(result.delivery.throughSeq, events.at(-1).seq);
  assert.deepEqual(result.delivery.inputEventIds, [ref.sourceId]);
  assert.deepEqual(result.delivery.sourceEventIds, [ref.sourceId, eventId(sessionId, 6)]);
  assert.deepEqual(result.learning.sourceEventIds, result.delivery.sourceEventIds);
  assert.deepEqual(f.business.get('events', ref.sourceId), source);
  assert.equal(f.business.get('events', eventId(sessionId, 4)), null);
  assert.equal(f.business.get('dsh_events', eventId(sessionId, 4)).sha256, hash(events[4]));
  assert.equal(f.business.listAll('events').filter(row => row.message.id === input.id).length, 1);
  const settledSequence = f.business.storage.currentSequence();
  assert.deepEqual(f.reopen().settleTurn({ sessionId, turn: 1, events }).delivery, result.delivery);
  assert.equal(f.business.storage.currentSequence(), settledSequence);
});

test('formal native sources already saved keep their old ID and still return the exact inbox position', t => {
  const { business } = fixture(t), events = inboxReplyEvents(), input = events[0].data.inserted[0];
  business.ingestSession({ sessionId, events });
  const old = business.get('events', eventId(sessionId, 4)), sequence = business.storage.currentSequence();
  const [ref] = business.ingestClaimedInputs({ sessionId, events: events.slice(0, 3), messages: [input] });
  assert.equal(ref.sourceId, old.id); assert.equal(ref.inboxRef.seq, 0); assert.equal(ref.inboxRef.index, 0);
  assert.equal(ref.inboxRef.sha256, hash(events[0])); assert.deepEqual(business.get('events', old.id), old);
  assert.equal(business.storage.currentSequence(), sequence);
  assert.deepEqual(business.settleTurn({ sessionId, turn: 1, events }).delivery.inputEventIds, [old.id]);
});

test('official queue editing selects the last insertion, but cannot rewrite an already frozen source', t => {
  const { business } = fixture(t), original = inboxReplyEvents(), old = original[0].data.inserted[0];
  // SessionController.updateQueue(edit) keeps id/source and inbox.replace emits
  // one canceled replacement splice before the driver claims the edited input.
  const edited = { ...structuredClone(old), content: [text('改为只讨论新的目标边界，不恢复追踪。')] };
  const prefix = numbered([
    original[0],
    event('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1,
      inserted: [edited], outcome: 'canceled' }),
    original[1], original[2],
  ]);
  business.ingestSession({ sessionId, events: prefix.slice(0, 2) });
  assert.equal(business.listAll('events').length, 0);
  assert.throws(() => business.ingestClaimedInputs({ sessionId, events: prefix, messages: [old] }), hasCode('source_identity_conflict'));
  const [ref] = business.ingestClaimedInputs({ sessionId, events: prefix, messages: [edited] });
  assert.deepEqual(ref.inboxRef, { sessionId, seq: 1, type: 'agent/inbox/spliced', sha256: hash(prefix[1]), index: 0 });
  assert.equal(ref.messageHash, hash(edited));
  assert.deepEqual(business.get('events', ref.sourceId).message, edited);
  assert.equal(business.get('dsh_events', eventId(sessionId, 0)).sha256, hash(prefix[0]));
  const changed = { ...structuredClone(edited), content: [text('已经冻结后又换掉正文')] };
  const later = numbered([...prefix,
    event('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [changed] }),
    event('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
  ]);
  const frozenSequence = business.storage.currentSequence();
  assert.throws(() => business.ingestClaimedInputs({ sessionId, events: later, messages: [changed] }), hasCode('source_identity_conflict'));
  assert.equal(business.storage.currentSequence(), frozenSequence);
  assert.deepEqual(business.get('events', ref.sourceId).message, edited);
  const suffix = structuredClone(original.slice(3)); suffix[1].data = edited;
  const complete = numbered([...prefix, ...suffix]);
  const delivery = business.settleTurn({ sessionId, turn: 1, events: complete }).delivery;
  assert.deepEqual(delivery.inputEventIds, [ref.sourceId]);
  assert.equal(business.listAll('events').filter(row => row.message.id === edited.id).length, 1);
});

test('a prepared original cannot become a different formal message or fall back to a second source', t => {
  const { business } = fixture(t), events = inboxReplyEvents(), prefix = events.slice(0, 3);
  const [ref] = business.ingestClaimedInputs({ sessionId, events: prefix, messages: [events[0].data.inserted[0]] });
  const sequence = business.storage.currentSequence();
  for (const change of [message => { message.content[0].text = '换掉原话'; },
    message => { message.source.rpcId = 'another-request'; },
    message => { message.source.principal = { kind: 'agent', id: 'other' }; },
    message => { message.source = { kind: 'runtime-context' }; }]) {
    const copy = structuredClone(events); change(copy[4].data);
    assert.throws(() => business.ingestSession({ sessionId, events: copy }), hasCode('source_identity_conflict'));
    assert.equal(business.storage.currentSequence(), sequence);
    assert.equal(business.listAll('events').length, 1); assert.equal(business.listAll('dsh_events').length, prefix.length);
    assert.equal(business.get('events', eventId(sessionId, 4)), null);
  }
  assert.deepEqual(business.get('events', ref.sourceId).message, events[0].data.inserted[0]);
});

test('claimed input validates full owner original and rolls back all imported facts if source persistence fails', t => {
  const { business } = fixture(t), prefix = inboxReplyEvents().slice(0, 3), input = prefix[0].data.inserted[0];
  for (const malformed of [
    { ...input, id: 'not-in-native-inbox' },
    { ...input, source: { ...input.source, principal: { kind: 'agent', id: 'other' } } },
    { ...input, source: { kind: 'runtime-context' } },
  ]) {
    assert.throws(() => business.ingestClaimedInputs({ sessionId, events: prefix, messages: [malformed] }), hasCode('invalid_claimed_input'));
    assert.equal(business.storage.currentSequence(), 0);
  }
  const altered = structuredClone(input); altered.content.push(text('额外文字'));
  assert.throws(() => business.ingestClaimedInputs({ sessionId, events: prefix, messages: [altered] }), hasCode('source_identity_conflict'));
  assert.throws(() => business.ingestClaimedInputs({ sessionId, events: prefix.slice(1), messages: [input] }), hasCode('incomplete_history'));
  assert.throws(() => business.ingestClaimedInputs({ sessionId, events: prefix, messages: [input, input] }), hasCode('invalid_claimed_input'));
  const save = business.storage.save.bind(business.storage);
  business.storage.save = (kind, ...args) => {
    if (kind === 'events') throw new Error('source snapshot write failed');
    return save(kind, ...args);
  };
  assert.throws(() => business.ingestClaimedInputs({ sessionId, events: prefix, messages: [input] }), /source snapshot write failed/);
  assert.equal(business.storage.currentSequence(), 0); assert.deepEqual(business.listAll('dsh_events'), []);
  business.storage.save = save;
  const second = { ...structuredClone(input), id: 'claimed-u2', source: { kind: 'user', rpcId: 'browser-request-2' } };
  const two = structuredClone(prefix); two[0].data.inserted.push(second); two[2].data.removedCount = 2;
  const refs = business.ingestClaimedInputs({ sessionId, events: two, messages: [input, second] });
  assert.equal(refs[1].inboxRef.index, 1); assert.equal(refs[1].inboxRef.sha256, hash(two[0]));
  assert.notEqual(refs[0].sourceId, refs[1].sourceId);
  assert.equal(business.listAll('events').length, 2);
});

test('original authors survive same text; runtime-context and relays do not gain user authority', t => {
  const { business } = fixture(t);
  const same = [text('我认可这个目标')];
  const events = numbered([
    event('user/message', message('u', 'user', { kind: 'user' }, same), 'append'),
    event('user/message', message('runtime', 'user', { kind: 'runtime-context', form: 'snapshot', sections: [] }, same), 'append'),
    event('user/message', message('relay', 'user', { kind: 'arcfold', form: 'relay' }, same), 'append'),
    event('assistant/message', { turn: 1, step: 1, message: message('a', 'assistant', model, same), stream: [] }, 'append'),
    event('tool/result', { turn: 1, step: 1, message: {
      ...message('t', 'tool', { kind: 'tool', callId: 'c' }, same), toolCallId: 'c' } }, 'append'),
  ]);
  const first = business.ingestSession({ sessionId, events });
  assert.equal(first.inserted, 5);
  const sources = business.listAll('events');
  assert.deepEqual(sources.map(row => row.role), ['user', 'program', 'program', 'assistant', 'tool']);
  assert.equal(new Set(sources.map(row => row.id)).size, 5);
  assert.deepEqual(sources.map(row => messageText(row.message)), Array(5).fill('我认可这个目标'));
  for (const source of sources) {
    assert.equal(source.conversationId, sessionId);
    assert.equal(source.message.source.kind, source.provenance.source.kind);
    assert.equal(source.occurredAt, new Date(events[source.provenance.sourceRef.seq].time).toISOString());
    assert.equal(Object.hasOwn(source, 'text'), false);
  }
  assert.equal(sources[1].message.role, 'user');
  const sequence = business.storage.currentSequence();
  const reorderedKeys = JSON.parse(JSON.stringify(events), (key, value) => value && !Array.isArray(value) && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse()) : value);
  assert.equal(business.ingestSession({ sessionId, events: reorderedKeys }).reused, 5);
  assert.equal(business.storage.currentSequence(), sequence);
  assert.throws(() => business.storage.save('events', sources[0], { expectedRevision: 1 }), hasCode('immutable_record'));
});

test('stable event identity rejects changed content or metadata and leaves the original intact', t => {
  const { business } = fixture(t), events = replyEvents();
  business.ingestSession({ sessionId, events });
  const before = business.storage.currentSequence();
  for (const change of [e => { e[2].data.content[0].text = '换掉原话'; },
    e => { e[3].data.header.system = 'different unseen header'; },
    e => { e[4].data.stream = []; }, e => { e[2].time++; }]) {
    const copy = structuredClone(events); change(copy);
    assert.throws(() => business.ingestSession({ sessionId, events: copy }), hasCode('source_identity_conflict'));
    assert.equal(business.storage.currentSequence(), before);
  }
  assert.equal(messageText(business.get('events', eventId(sessionId, 2)).message), '帮我理清想法');
  business.ingestSession({ sessionId: 'another-session', events });
  assert.notEqual(eventId(sessionId, 2), eventId('another-session', 2));
});

test('partial batches continue in original order; gaps and a malformed later message roll back the entire batch', t => {
  const { business } = fixture(t), events = replyEvents();
  assert.throws(() => business.ingestSession({ sessionId, events: events.slice(2) }), hasCode('event_sequence_gap'));
  assert.equal(business.listAll('dsh_events').length, 0);
  business.ingestSession({ sessionId, events: events.slice(0, 3) });
  const before = business.storage.currentSequence();
  const broken = structuredClone(events.slice(3)); broken[1].data.message.role = 'user';
  assert.throws(() => business.ingestSession({ sessionId, events: broken }), hasCode('invalid_message_role'));
  assert.equal(business.storage.currentSequence(), before);
  assert.equal(business.listAll('dsh_events').length, 3);
  business.ingestSession({ sessionId, events: events.slice(3) });
  assert.equal(business.listAll('dsh_events').length, events.length);
});

test('settlement stores only indexes and message snapshots, atomically links a reply to pending learning, and replays after restart', t => {
  const f = fixture(t), events = replyEvents();
  const result = f.business.settleTurn({ sessionId, turn: 1, events });
  assert.equal(result.status, 'delivered');
  assert.equal(result.delivery.kind, 'formal_reply');
  assert.equal(result.delivery.taskOutcome, 'not_assessed');
  assert.equal(result.delivery.eventId, eventId(sessionId, 4));
  assert.deepEqual(result.delivery.inputEventIds, [eventId(sessionId, 2)]);
  assert.equal(result.learning.deliveryId, result.delivery.id);
  assert.equal(result.learning.status, 'pending');
  assert.equal(Object.hasOwn(result.delivery, 'text'), false);
  assert.equal(f.business.listAll('events').length, 2);
  const serialized = JSON.stringify(f.business.listAll('dsh_events'));
  assert.equal(serialized.includes('not copied:'), false);
  assert.equal(serialized.includes('raw stream'), false);
  assert.equal(f.business.listAll('events').some(source => JSON.stringify(source).includes('raw stream')), false);
  const sequence = f.business.storage.currentSequence();
  const again = f.reopen().settleTurn({ sessionId, turn: 1, events });
  assert.equal(again.reused, true);
  assert.deepEqual(again.delivery, result.delivery);
  assert.equal(f.business.storage.currentSequence(), sequence);
  assert.equal(f.business.listAll('deliveries').length, 1);
  assert.equal(f.business.listAll('learning_pending').length, 1);
  // A future consumer may settle learning; replay must not reset it to pending.
  f.business.storage.save('learning_pending', { ...again.learning, status: 'applied' }, { expectedRevision: 1 });
  assert.equal(f.business.settleTurn({ sessionId, turn: 1, events }).learning.status, 'applied');
});

test('failed, cancelled, interrupted, blocked and token-limited turns preserve sources without formal delivery', t => {
  const { business } = fixture(t);
  for (const kind of ['error', 'aborted', 'interrupted', 'blocked', 'max-tokens', 'forked', 'plugin-unknown']) {
    const id = `session-${kind}`, events = replyEvents({ reason: { kind } });
    const result = business.settleTurn({ sessionId: id, turn: 1, events });
    assert.equal(result.status, 'not_deliverable');
    assert.equal(result.reason, `turn_${kind}`);
    assert.equal(business.list('dsh_events', { where: { sessionId: id } }).length, events.length);
  }
  assert.equal(business.listAll('deliveries').length, 0);
  assert.equal(business.listAll('learning_pending').length, 0);
});

test('no final text, interrupted text, final tool calls and incomplete step cannot masquerade as a complete reply', t => {
  const { business } = fixture(t);
  const cases = [
    [replyEvents({ content: [{ type: 'reasoning', text: 'thinking only' }] }), 'empty_reply'],
    [replyEvents({ content: [text('  \n')] }), 'empty_reply'],
    [replyEvents({ interrupted: true }), 'no_complete_assistant'],
    [replyEvents({ content: [text('我会去做'), { type: 'tool-call', id: 'c', name: 'bash', arguments: '{}' }] }), 'final_tool_call'],
    [numbered(replyEvents().filter(e => e.type !== 'step/end')), 'incomplete_step'],
    [numbered(replyEvents().filter(e => e.type !== 'turn/end')), 'incomplete_turn'],
  ];
  cases.forEach(([events, reason], i) => {
    assert.equal(business.settleTurn({ sessionId: `bad-${i}`, turn: 1, events }).reason, reason);
  });
  assert.equal(business.listAll('deliveries').length, 0);
});

function toolEvents(withResult = true) {
  return numbered([
    event('turn/start', { turn: 1 }), event('step/start', { turn: 1, step: 1 }),
    event('user/message', message('u', 'user', { kind: 'user' }, [text('请检查')]), 'append'),
    event('assistant/message', { turn: 1, step: 1, message: message('a-call', 'assistant', model,
      [{ type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{}' }]), stream: [] }, 'append'),
    event('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'read_file', arguments: '{}' }),
    ...(withResult ? [event('tool/result', { turn: 1, step: 1, message: {
      ...message('result', 'tool', { kind: 'tool', callId: 'call-1' }, [text('文件原文')]), toolCallId: 'call-1' } }, 'append')] : []),
    event('step/end', { turn: 1, step: 1 }), event('step/start', { turn: 1, step: 2 }),
    event('assistant/message', { turn: 1, step: 2, message: message('a-final', 'assistant', model, [text('检查结果')]), stream: [] }, 'append'),
    event('step/end', { turn: 1, step: 2 }), event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]);
}

test('tool results must correspond to actual calls before the final reply', t => {
  const { business } = fixture(t);
  assert.equal(business.settleTurn({ sessionId: 'tools-ok', turn: 1, events: toolEvents() }).status, 'delivered');
  assert.equal(business.settleTurn({ sessionId: 'tools-missing', turn: 1, events: toolEvents(false) }).reason, 'unresolved_tools');
  const mismatch = toolEvents(); mismatch.find(e => e.type === 'tool/result').data.message.source.callId = 'different';
  assert.equal(business.settleTurn({ sessionId: 'tools-wrong', turn: 1, events: mismatch }).reason, 'invalid_tool_trace');
});

test('background work remains an explicit observation and never turns a formal reply into task success', t => {
  const { business } = fixture(t), raw = replyEvents();
  raw.splice(3, 0,
    event('job/registered', { jobId: 'running', owner: sessionId, kind: 'shell', label: 'server', startedAt: 1 }),
    event('job/registered', { jobId: 'done', owner: sessionId, kind: 'shell', label: 'check', startedAt: 1 }),
    event('job/settled', { jobId: 'done', owner: sessionId, status: 'completed', producerReported: true, finishedAt: 2 }),
    event('subagent/catalog', { childId: 'child-1', childCreatedAt: 1, version: 0, mode: 'one-shot' }));
  const result = business.settleTurn({ sessionId, turn: 1, events: numbered(raw) });
  assert.equal(result.status, 'delivered');
  assert.equal(result.delivery.taskOutcome, 'not_assessed');
  assert.deepEqual(result.delivery.backgroundAtTurnEnd, { unsettledJobIds: ['running'],
    observedSubagentIds: ['child-1'], subagentCompletion: 'not_determined_by_parent_catalog' });
});

test('later history never enters an earlier delivery; later replacement preserves old raw sources', t => {
  const { business } = fixture(t), one = replyEvents();
  const later = replyEvents().map(e => ({ ...e, data: {
    ...e.data, ...(e.data.turn !== undefined ? { turn: 2 } : {}) } }));
  later[2].data.content = [text('后来用户纠正')];
  later[2].data.id = 'u2';
  const all = numbered([...one, ...later]);
  const result = business.settleTurn({ sessionId, turn: 1, events: all });
  assert.equal(result.delivery.throughSeq, 6);
  assert.ok(result.learning.sourceEventIds.every(id => business.get('events', id).provenance.sourceRef.seq < 6));
  assert.equal(business.settleTurn({ sessionId, turn: 2, events: all }).status, 'delivered');
  assert.throws(() => business.settleTurn({ sessionId, turn: 1, events: all.slice(1) }), hasCode('incomplete_history'));
});

test('same-turn replacement, new unanswered user input and inherited turns do not publish stale replies', t => {
  const { business } = fixture(t);
  const replaced = replyEvents();
  replaced.splice(5, 0, event('user/message', message('summary', 'user', { kind: 'compaction', form: 'recall' }, [text('summary')]),
    { op: 'replace', startSeq: 4, endSeq: 4 }));
  assert.equal(business.settleTurn({ sessionId: 'replaced', turn: 1, events: numbered(replaced) }).reason, 'reply_replaced');
  const unanswered = replyEvents();
  unanswered.splice(5, 0, event('user/message', message('new', 'user', { kind: 'user' }, [text('不是这个意思')]), 'append'));
  assert.equal(business.settleTurn({ sessionId: 'unanswered', turn: 1, events: numbered(unanswered) }).reason, 'unanswered_user_input');
  const inherited = numbered([...replyEvents(), event('session/end-seed', { inherited: true })]);
  assert.equal(business.settleTurn({ sessionId: 'fork', turn: 1, events: inherited }).reason, 'inherited_turn');
});

test('failure writing the pending learning record rolls back delivery and all newly imported sources', t => {
  const { business } = fixture(t), save = business.storage.save.bind(business.storage);
  business.storage.save = (kind, ...args) => {
    if (kind === 'learning_pending') throw new Error('simulated disk failure at business write');
    return save(kind, ...args);
  };
  assert.throws(() => business.settleTurn({ sessionId, turn: 1, events: replyEvents() }), /simulated disk failure/);
  assert.equal(business.storage.currentSequence(), 0);
  for (const kind of ['dsh_events', 'events', 'deliveries', 'learning_pending']) assert.deepEqual(business.listAll(kind), []);
  business.storage.save = save;
  assert.equal(business.settleTurn({ sessionId, turn: 1, events: replyEvents() }).status, 'delivered');
});

test('generic business records retain revision/sequence guards and synchronous nested transactions, without execution APIs', t => {
  const { business } = fixture(t), store = business.storage;
  const first = store.save('understandings', { id: 'u', summary: '旧认识', sourceIds: [] });
  const second = store.save('understandings', { ...first, summary: '修订认识' }, { expectedRevision: 1 });
  assert.equal(second.revision, 2); assert.equal(second.createdSequence, first.createdSequence);
  assert.ok(second.updatedSequence > first.updatedSequence);
  assert.throws(() => store.save('understandings', first, { expectedRevision: 1 }), hasCode('revision_conflict'));
  const seq = store.currentSequence();
  assert.throws(() => store.transaction(() => {
    store.save('goals', { id: 'g', status: 'paused', userControl: { kind: 'user' } });
    throw new Error('rollback');
  }), /rollback/);
  assert.equal(store.get('goals', 'g'), null); assert.equal(store.currentSequence(), seq);
  assert.throws(() => store.transaction(async () => {}), hasCode('async_transaction'));
  assert.throws(() => store.transaction(() => {
    store.save('methods', { id: 'm' }); return Promise.resolve();
  }), hasCode('async_transaction'));
  assert.equal(store.get('methods', 'm'), null);
  assert.throws(() => store.save('methods', { id: 'bad', content: undefined }), hasCode('invalid_record'));
  store.save('methods', { id: 'm1' }); store.save('methods', { id: 'm2' });
  assert.throws(() => store.listAll('methods', { maxRecords: 1 }), hasCode('record_scan_capacity'));
  assert.equal(store.list('methods', { offset: 1, limit: 1 })[0].id, 'm2');
  assert.equal(typeof Store.prototype.claimJob, 'undefined');
  assert.equal(typeof Store.prototype.learningGate, 'undefined');
});
