import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BusinessStore } from '../src/business.mjs';
import { SessionBridge } from '../src/session-bridge.mjs';

const input = { id: 'input-one', role: 'user', source: { kind: 'user', rpcId: 'request-one' }, content: [{ type: 'text', text: '保留这句原话' }] };
const record = (seq, type, data, extra = {}) => ({ seq, type, time: 1793957945000 + seq, data, ...extra });
function setup(t, flush = async () => true) {
  const business = new BusinessStore({ filename: ':memory:' });
  const events = [record(0, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [input] }), record(1, 'turn/start', { turn: 1 }), record(2, 'step/start', { turn: 1, step: 1 })];
  const session = { id: 'session-main', snapshotEvents: () => [...events], surface: { nodes: [] }, eventAt: seq => events[seq] };
  session.append = (type, data, extra) => {
    const event = record(events.length, type, data, extra); events.push(event);
    if (extra.surfaceOp === 'append') session.surface.nodes.push(event.seq);
    else session.surface.nodes.splice(session.surface.nodes.indexOf(extra.surfaceOp.startSeq), 1, event.seq);
    return event;
  };
  const bridge = new SessionBridge({ business, sessions: { flush, get: () => session }, persistence: {}, logger: { warn() {} } });
  t.after(() => bridge.close());
  return { bridge, business, session, events, payload: { agent: { session }, messages: [input], turn: 1, step: 1, signal: new AbortController().signal }, decision: { kind: 'enter', messages: [input] } };
}
test('rejected step has no persistence or business side effect', async t => {
  let flushed = false;
  const { bridge, payload, business } = setup(t, async () => { flushed = true; return true; });
  assert.deepEqual(await bridge.prepare(payload, { kind: 'reject' }), { kind: 'reject' });
  assert.equal(flushed, false); assert.equal(business.listAll('host_bindings').length, 0);
});
test('flush without a persistence listener cannot establish a business binding', async t => {
  const { bridge, payload, decision, business } = setup(t, async () => false);
  await assert.rejects(bridge.prepare(payload, decision), /durable session writer/);
  assert.equal(business.listAll('host_bindings').length, 0);
});
test('only the prefix captured before flush is asserted durable', async t => {
  const fixture = setup(t, async () => { fixture.events.push(record(3, 'session/title', { title: 'later' })); return true; });
  assert.equal((await fixture.bridge.durablePrefix(fixture.session)).length, 3);
  assert.equal(fixture.events.length, 4);
});
test('pre-step preserves human identity and emits only program-authored context', async t => {
  const { bridge, payload, decision, business } = setup(t);
  const accepted = await bridge.prepare(payload, decision);
  assert.deepEqual(accepted.messages[0], input);
  assert.equal(accepted.messages[1].source.kind, 'arcfold/context');
  assert.equal(business.listAll('host_bindings').length, 1);
  assert.equal(business.listAll('learning_pending').length, 0);
});
test('obsolete personal background is replaced on the surface, not merely disclaimed', async t => {
  const { bridge, payload, decision, session, events } = setup(t);
  const old = session.append('user/message', { id: 'old-context', role: 'user', source: { kind: 'arcfold/context' }, content: [{ type: 'text', text: 'WITHDRAWN_PRIVATE_SENTINEL' }] }, { surfaceOp: 'append' });
  const accepted = await bridge.prepare(payload, decision);
  const visible = session.surface.nodes.map(seq => session.eventAt(seq).data).concat(accepted.messages);
  assert.equal(JSON.stringify(visible).includes('WITHDRAWN_PRIVATE_SENTINEL'), false);
  assert.equal(events[old.seq].data.content[0].text, 'WITHDRAWN_PRIVATE_SENTINEL');
});
test('settlement sees the full prefix including fork inheritance evidence', t => {
  const { bridge, business } = setup(t);
  const prefix = [record(0, 'turn/end', { turn: 1, reason: { kind: 'completed' } }), record(1, 'session/end-seed', { inherited: true })];
  let observed;
  business.settleTurn = ({ events }) => { observed = events; return { status: 'not_deliverable', reason: 'inherited_turn' }; };
  bridge.ingestAndSettle('session-fork', prefix);
  assert.equal(observed, prefix);
});
test('withdrawal while request preparation waits prevents adapter dispatch', async t => {
  const { bridge, payload, decision, business, session } = setup(t);
  const source = business.storage.save('events', { id: 'prior-original', role: 'user', content: 'PRIVATE_CONTEXT_SENTINEL' });
  business.storage.save('understandings', { id: 'prior-understanding', status: 'active', content: '已有认识', sourceIds: [source.id], dependencies: [{ kind: 'events', id: source.id, revision: 1 }] });
  const accepted = await bridge.prepare(payload, decision);
  let resume;
  const preparation = new Promise(resolve => { resume = resolve; });
  let dispatched = 0;
  const attempt = (async () => {
    await preparation;
    const stream = bridge.guardStream({ sessionId: session.id, messages: accepted.messages }, () => {
      dispatched++; return (async function* () { yield { type: 'finish' }; })();
    });
    for await (const _ of stream) { /* consume the actual guarded boundary */ }
  })();
  business.storage.save('source_controls', { id: source.id, useProhibited: true });
  resume();
  await assert.rejects(attempt, error => error.code === 'ARCFOLD_CONTEXT_CHANGED');
  assert.equal(dispatched, 0);
});
