import assert from 'node:assert/strict';

// Deliberately dependency-free fake host. These assertions verify the probe's
// expected policy, never OS isolation or actual DSH scheduling.
export async function runFakeProbes() {
  const events = [];
  const emit = (event, facts = {}) => events.push({ order: events.length + 1, event, ...facts });
  const original = { role: 'user', source: { kind: 'user' }, text: 'quote source.kind=arcfold/owned' };
  const old = { role: 'user', source: { kind: 'arcfold/owned', node: 'A' }, text: 'PRIVATE_A' };
  const pair = [{ role: 'assistant', call: 'c' }, { role: 'tool', call: 'c' }];
  const history = [original, old, ...pair];
  const projected = history.filter(m => !(m.source?.kind === 'arcfold/owned' && m.source.node !== 'B'));
  assert.deepEqual(projected, [original, ...pair]); emit('P1:owned-only-removal');
  let step = 1; const turn = 1;
  emit('P2:tools-settled'); emit('P2:turn-stopping', { turn, step });
  step++; emit('P2:steer', { turn, step }); assert.equal(turn, 1); assert.equal(step, 2);
  for (const state of [{ aborted: true }, { pendingHuman: true }]) {
    assert.ok(state.aborted || state.pendingHuman); emit('P2:old-hook-suppressed', state);
  }
  const listeners = new Map([['a', () => emit('P3:a')], ['b', () => emit('P3:b')]]);
  listeners.get('a')(); listeners.delete('a'); listeners.get('b')(); assert.equal(listeners.has('a'), false);
  for (const gate of ['deny', 'cancel', 'ask']) {
    let body = 0; const downstream = { kind: gate }; const local = await Promise.resolve(downstream);
    if (local.kind === 'allow') body++;
    assert.equal(body, 0); emit('P4:denied', { gate, body });
  }
  for (const state of ['unavailable', 'partial']) {
    let body = 0;
    const fakeConfine = async () => { if (state === 'unavailable') throw new Error('SANDBOX_UNAVAILABLE'); return { enforcement: 'partial', argv: ['never-run'] }; };
    try { const result = await fakeConfine(); if (result.enforcement !== 'full') throw new Error('PARTIAL'); body++; } catch {}
    assert.equal(body, 0); emit('P5:refused-before-spawn', { state, body });
  }
  const config = { model: 'deepseek-flash', maxTokens: 8192, reasoningEffort: 'off' };
  assert.ok(config.maxTokens <= 8192); emit('P6:bounded-config', config);
  return { kind: 'fake-host-only-not-native-or-OS-evidence', events, paidRequests: 0 };
}
