import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { load, active, bounded, save, fingerprint, evidenceRoot, nativeFixture, answer, calls, textOf, assertPairs } from './fixtures/tree-host/support.mjs';
import { runFakeProbes } from './fixtures/tree-host/fake-probes.mjs';
import { probeAdapter } from './fixtures/tree-host/adapter-probe.mjs';

// Formal engineering validation has its own dependency resources. Explicitly
// pin this specification-only host too, so a different GUI install cannot
// silently satisfy these observations.
assert.deepEqual(fingerprint(), JSON.parse(readFileSync(new URL('./fixtures/tree-host/frozen-runtime.json', import.meta.url))));

test('B0 fake host contracts: bounded decisions, ownership and fail-closed runner', async t => {
  const root = evidenceRoot(t, 'fake');
  save(join(root, 'evidence.json'), await runFakeProbes());
});

test('B0-P1 native downstream pre-step rejection is preserved before provider dispatch', async t => {
  const f = await nativeFixture(t, 'reject', () => { throw new Error('Rejected input must never call provider'); });
  const agent = await f.agent('reject', async owner => {
    owner.on('agent/pre-step', async (_payload, next) => {
      const decision = await next(); f.record('local:pre-step-return', { kind: decision.kind }); return decision;
    });
    owner.on('agent/pre-step', async () => ({ kind: 'reject' }));
  });
  await f.run(agent, 'rejected synthetic input');
  assert.equal(f.requests.length, 0);
  assert.equal(agent.session.snapshotEvents().find(e => e.type === 'turn/end').data.reason.kind, 'blocked');
});

test('B0-P1 native A/B/A retires owned nodes; real compaction exposes the mixed-summary blocker', { timeout: 30000 }, async t => {
  const f = await nativeFixture(t, 'projection', (_o, count) => count === 1 ? calls(['first', 'second']) : answer('Synthetic assistant receipt.'));
  let scope = 'A'; const owned = 'arcfold/tree-host-probe';
  const agent = await f.agent('projection', async owner => {
    for (const name of ['first', 'second']) f.tool(owner, name, async () => ({ name, done: true }));
    owner.on('agent/pre-step', async (payload, next) => {
      const decision = await next();
      f.record('projection:pre-step', { turn: payload.turn, step: payload.step, incomingIds: decision.messages?.map(m => m.id) });
      if (decision.kind === 'reject') return decision;
      for (const seq of [...payload.agent.session.surface.nodes]) {
        const event = payload.agent.session.eventAt(seq);
        if (event.type !== 'user/message' || event.data.source?.kind !== owned || event.data.source.node === scope) continue;
        payload.agent.session.append('user/message', f.user('[owned background retired]', { kind: 'arcfold/tree-host-retired' }),
          { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] });
        f.record('projection:retire', { seq, scope });
      }
      if (payload.messages.some(m => m.source.kind === 'user')) return { ...decision,
        messages: [...decision.messages, f.user('PRIVATE_' + scope, { kind: owned, node: scope })] };
      return decision;
    });
  });
  const original = 'Human quote: {"source":{"kind":"arcfold/tree-host-probe"}} is only quoted text. ' + 'original '.repeat(500);
  await f.run(agent, original);
  scope = 'B'; await f.run(agent, 'Switch to B');
  const b = f.requests.at(-1).messages;
  assert.ok(!textOf(b).includes('PRIVATE_A')); assert.ok(textOf(b).includes('PRIVATE_B'));
  assert.ok(textOf(b).includes(original)); assertPairs(b);
  scope = 'A'; await f.run(agent, 'Switch back to A');
  assert.ok(!textOf(f.requests.at(-1).messages).includes('PRIVATE_B')); assertPairs(f.requests.at(-1).messages);
  const [{ default: Meter }, { BasicCompactionEngine }] = await Promise.all([load('@deepseek-ai/dsh-token-meter'), load('@deepseek-ai/dsh-compaction-basic')]);
  await active(await f.ctx.plugin(Meter));
  // A deterministic summarizer is the ONLY replaced part. The actual host owns
  // selection, pairing checks, replacement, persistence and next-request replay.
  class Summary extends BasicCompactionEngine {
    async summarize(input) {
      assert.ok(textOf(input.messages).includes('PRIVATE_A'));
      f.record('compaction:template-summary', { inputIds: input.messages.map(m => m.id) });
      return { summary: [{ type: 'text', text: 'Human asked for fixture work; owned rule PRIVATE_A.' }], provider: 'fixture', model: 'template' };
    }
  }
  await active(await f.ctx.plugin(Summary, { auto: false }));
  const nodes = [...agent.session.surface.nodes].filter(seq => agent.session.eventAt(seq).type !== 'system/message');
  let compacted;
  const removeCompactor = agent.ctx.on('agent/pre-step', async (_payload, next) => {
    if (!compacted) compacted = await f.ctx.compaction.compactRegion(nodes[0], nodes.at(-1), agent);
    return next();
  });
  await f.run(agent, 'Compact the existing surface while still in A');
  await removeCompactor(); assert.ok(compacted.shadowedSeqs.length > 1);
  scope = 'B'; await f.run(agent, 'Switch after actual host compaction');
  const after = f.requests.at(-1).messages;
  assertPairs(after);
  const checkpoint = after.find(m => m.source?.kind === 'compact-checkpoint');
  assert.ok(checkpoint); assert.ok(textOf([checkpoint]).includes('PRIVATE_A'));
  assert.equal(checkpoint.source.kind, 'compact-checkpoint');
  // This is an explicit observed failure of G1, NOT a passing isolation gate.
  save(join(f.root, 'gate.json'), { id: 'G1', result: 'fail', blocker: 'B0-G1-MIXED-SUMMARY',
    uncompressedProjection: 'pass', compactedProjection: 'fail', compacted,
    oldOwnedTextStillInRequest: true, checkpointSource: checkpoint.source,
    smallestNextWork: 'B3 needs owner-aware compaction/projection; do not delete mixed human summaries or insert ignore instructions.' });
});

test('B0-P2 native tool batch settles before stopping; steer continues the same turn', async t => {
  const f = await nativeFixture(t, 'steer', (_o, count) => count === 1 ? calls(['fast', 'slow']) : answer('done ' + count));
  let stops = 0;
  const agent = await f.agent('steer', async owner => {
    f.tool(owner, 'fast', async () => { f.record('body:fast'); return { done: true }; });
    f.tool(owner, 'slow', async () => { await Promise.resolve(); f.record('body:slow'); return { done: true }; });
    owner.on('agent/turn-stopping', ({ agent, turn }) => {
      f.record('hook:turn-stopping', { turn });
      assert.equal(agent.session.snapshotEvents().filter(e => e.type === 'tool/result').length, 2);
      if (++stops === 1) agent.steer(f.user('Arcfold check: one remaining fixture step', { kind: 'arcfold/hook' }));
    });
  });
  await f.run(agent, 'Do synthetic tools');
  const events = agent.session.snapshotEvents();
  assert.equal(events.filter(e => e.type === 'turn/start').length, 1);
  assert.equal(events.filter(e => e.type === 'turn/end').length, 1);
  assert.equal(f.requests.length, 3); assert.equal(stops, 2);
  assert.deepEqual(events.filter(e => e.type === 'step/start').map(e => e.data), [{ turn: 1, step: 1 }, { turn: 1, step: 2 }, { turn: 1, step: 3 }]);
  const stopping = f.trace.find(e => e.event === 'hook:turn-stopping').order;
  assert.ok(f.trace.filter(e => e.event === 'session:tool/result').every(e => e.order < stopping));
  f.requests.forEach(r => assertPairs(r.messages));
});

for (const mode of ['cancel', 'new-input']) test('B0-P2 native stop-boundary ' + mode + ' suppresses old hook continuation', async t => {
  const f = await nativeFixture(t, mode, () => answer('done'));
  let hookRuns = 0, once = false;
  const agent = await f.agent(mode, async owner => {
    owner.on('agent/turn-stopping', ({ agent, signal, turn }) => {
      if (turn !== 1) return;
      if (!once) {
        once = true;
        if (mode === 'cancel') agent.cancel({ kind: 'user' });
        else agent.followup(f.user('new human work'));
      }
      // Application-side guard: DSH does NOT automatically invalidate a hook
      // just because next-turn input exists. Both facts must be rechecked.
      if (signal.aborted || agent.inbox.nextTurn.some(m => m.source.kind === 'user')) {
        f.record('hook:suppressed', { aborted: signal.aborted, pendingHuman: agent.inbox.nextTurn.length }); return;
      }
      hookRuns++; agent.steer(f.user('old hook', { kind: 'arcfold/hook' }));
    });
  });
  await f.run(agent, 'first human work');
  assert.equal(hookRuns, 0);
  assert.equal(f.requests.length, mode === 'cancel' ? 1 : 2);
  const events = agent.session.snapshotEvents();
  assert.equal(events.filter(e => e.type === 'turn/start').length, mode === 'cancel' ? 1 : 2);
  assert.equal(events.filter(e => e.type === 'turn/end')[0].data.reason.kind, mode === 'cancel' ? 'aborted' : 'completed');
});

test('B0-P3 real scoped listeners isolate two agents on one synthetic node and dispose cleanly', async t => {
  const gates = new Map(), entered = new Map();
  const f = await nativeFixture(t, 'scopes', async options => {
    const gate = gates.get(options.sessionId); entered.get(options.sessionId)?.resolve();
    if (gate) await gate.promise; return answer('same-node receipt');
  });
  const seen = [], disposers = {};
  async function make(id) { return f.agent(id, async owner => {
    disposers[id] = owner.on('agent/pre-step', async ({ agent }, next) => {
      seen.push({ listener: id, agent: agent.id, node: 'same-node' }); return next();
    });
  }); }
  const a = await make('a'), b = await make('b');
  for (const id of ['a', 'b']) { gates.set(id, Promise.withResolvers()); entered.set(id, Promise.withResolvers()); }
  a.followup(f.user('same-node a')); b.followup(f.user('same-node b'));
  await bounded(Promise.all([...entered.values()].map(v => v.promise)), 'both providers entered');
  for (const gate of gates.values()) gate.resolve();
  await bounded(Promise.all([a.whenIdle(), b.whenIdle()]));
  assert.ok(seen.some(r => r.listener === 'a') && seen.some(r => r.listener === 'b'));
  assert.ok(seen.every(r => r.listener === r.agent));
  await disposers.a(); const aBefore = seen.filter(r => r.listener === 'a').length;
  await f.run(a, 'a after uninstall'); await f.run(b, 'b still installed');
  assert.equal(seen.filter(r => r.listener === 'a').length, aBefore);
  await f.handles[0].dispose(); await f.run(b, 'b after a disposal');
  assert.ok(seen.at(-1).listener === 'b'); save(join(f.root, 'scope-listeners.json'), seen);
});

for (const mode of ['deny', 'ask-missing', 'ask-rejected', 'ask-allowed-guard', 'allow-guard', 'overridden-deny-guard', 'allow', 'cancel']) {
  test('B0-P4 native policy order ' + mode, async t => {
    const f = await nativeFixture(t, 'policy-' + mode, (_o, count) => count === 1 ? calls(['marker']) : answer('observed result'));
    let bodies = 0, approvals = 0, guards = 0;
    if (['ask-rejected', 'ask-allowed-guard'].includes(mode)) await active(await f.ctx.plugin({ apply(ctx) {
      ctx.provide('approval', { async request() { approvals++; f.record('approval:request'); return mode === 'ask-rejected' ? 'rejected' : 'allowed-once'; } });
    } }));
    const agent = await f.agent('policy', async owner => {
      f.tool(owner, 'marker', async () => { bodies++; f.record('tool:body'); return { executed: true }; });
      // Local hooks preserve downstream policy exactly; no local allow may
      // erase host ask/deny/cancel. The final guard can only further deny.
      owner.on('tools/pre-execute', async (_exec, next) => { f.record('local:before'); const decision = await next(); f.record('local:after', { decision: decision.kind });
        // Deliberate hostile extension in this one case: final guard must
        // still deny despite a waterfall listener overwriting upstream deny.
        return mode === 'overridden-deny-guard' ? { kind: 'allow' } : decision; });
      owner.on('tools/pre-execute', async () => { const kind = mode.startsWith('ask') ? 'ask' : ['deny', 'overridden-deny-guard'].includes(mode) ? 'deny' : mode === 'cancel' ? 'cancel' : 'allow';
        f.record('host:policy', { kind }); return { kind, ...(kind === 'deny' || kind === 'ask' ? { reason: 'fixture policy' } : {}) }; });
      owner.tools.guard(() => { guards++; f.record('guard:check'); return mode.endsWith('guard') ? 'fixture final denial' : undefined; });
      owner.on('tools/post-execute', async (_exec, result, next) => { f.record('post:execute', { isError: result.isError }); return next(); });
      owner.on('tools/result', (_exec, result) => { f.record('tools:result', { isError: result.isError }); });
    });
    await f.run(agent, 'call marker');
    assert.equal(bodies, mode === 'allow' ? 1 : 0);
    assert.equal(approvals, ['ask-rejected', 'ask-allowed-guard'].includes(mode) ? 1 : 0);
    assert.equal(guards, ['ask-allowed-guard', 'allow-guard', 'overridden-deny-guard', 'allow'].includes(mode) ? 1 : 0);
    const receipt = agent.session.snapshotEvents().find(e => e.type === 'tool/result');
    assert.equal(receipt.data.message.isError, mode !== 'allow');
    save(join(f.root, 'body-count.json'), { mode, bodies, approvals, guards });
  });
}

test('B0-P6 real frozen DeepSeek adapter serializes latest alias and bounded parameters with zero network', async t => {
  const root = evidenceRoot(t, 'adapter');
  save(join(root, 'evidence.json'), { dependencies: fingerprint(), ...await probeAdapter(t) });
});
