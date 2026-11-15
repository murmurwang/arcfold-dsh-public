import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { setup } from './fixtures/tree-context/helpers.mjs';
import { method } from './fixtures/tree-domain/helpers.mjs';
import { HookService, matchCondition, mountHookContext } from '../src/tree/hooks.mjs';
import { validateHook } from '../src/tree/items.mjs';
import { TreeRepository } from '../src/tree/repository.mjs';
import { nativeContext } from './fixtures/tree-context/native.mjs';
import { load, active, textOf, answer, assertPairs } from './fixtures/tree-host/support.mjs';
import { ownedCompactionClass, assertOwnedCompaction } from '../src/tree/host-context.mjs';
import { createHash } from 'node:crypto';

async function fixture(t) {
  const f = setup(t), input = f.begin(), turn = await f.attributed(input); await f.builder.activate(input.sessionId, turn.id);
  const service = new HookService({ repository: f.repo, readScope: id => f.builder.scope(id), resolveSource: f.resolveSource, workspace: f.dir });
  const add = (hooks, nodeId = f.repo.rootId()) => { f.asModel('learning', [nodeId]); return f.propose(nodeId, { methods: [{ ...method([f.ref]), hooks }] }).methods.itemIds[0]; };
  const event = (eventKey, fields = {}) => ({ sessionId: input.sessionId, eventKey, fields, fileEffects: 'complete' });
  return { ...f, service, add, event, input, turn };
}
const hook = (moment, action, conditions = [], message = '核对相关文件') => ({ moment, action, conditions, message });
test('S01 one event refuses activation above 100 eligible hooks without truncating or running any of them', async t => {
  const f = await fixture(t);
  for (let n = 0; n < 12; n++) f.add(Array.from({ length: 8 }, () => hook('before_tool', 'add_context')));
  assert.equal(f.service.snapshot(f.input.sessionId, 'before_tool').hooks.length, 96);
  f.add(Array.from({ length: 8 }, () => hook('before_tool', 'add_context')));
  assert.throws(() => f.service.evaluate({ ...f.event('over-capacity', { toolName: 'write' }), moment: 'before_tool' }), { code: 'HOOK_CAPACITY' });
  assert.equal(f.repo.list('tree_hook_runs').length, 0);
});
test('S01 configuration rejects unsupported fields/regex/actions and does not evaluate executable text', () => {
  for (const value of [hook('before_tool', 'block', [{ field: 'secret', op: 'equals', value: '' }]), hook('before_tool', 'block', [{ field: 'command', op: 'matches', value: '(a+)+' }]), hook('user_message', 'block'), hook('turn_end', 'continue', [], '字'.repeat(81))]) assert.throws(() => validateHook(value));
  assert.doesNotThrow(() => validateHook(hook('before_tool', 'block', [{ field: 'command', op: 'contains', value: 'process.exit()' }])));
});
test('S02/S03 hook decisions intersect with native permission; missing approval and native deny/ask never execute the body', async t => {
  const f = await fixture(t); f.add([hook('before_tool', 'ask_user')]); let bodies = 0;
  for (const baseDecision of ['deny', 'ask', 'allow']) {
    const result = await f.service.beforeTool(f.event(baseDecision, { toolName: 'write' }), { baseDecision, execute: () => bodies++ });
    assert.equal(result.executed, false); assert.equal(result.decision, baseDecision === 'allow' ? 'deny' : baseDecision);
  }
  const event = f.event('approved', { toolName: 'write' });
  assert.equal((await f.service.beforeTool(event, { baseDecision: 'allow', requestApproval: request => ({ ...request, approved: true }), execute: () => ++bodies })).executed, true);
  assert.equal((await f.service.beforeTool(event, { baseDecision: 'allow', requestApproval: request => ({ ...request, approved: true }), execute: () => ++bodies })).executed, false);
  assert.equal(bodies, 1);
});
test('S04/S13 scope switch or method withdrawal during approval refuses body and keeps prior runs', async t => {
  const f = await fixture(t), id = f.add([hook('before_tool', 'ask_user')]); let bodies = 0;
  await assert.rejects(f.service.beforeTool(f.event('withdraw', { toolName: 'write' }), { baseDecision: 'allow', requestApproval: request => {
    f.asUser(); f.items.withdraw(f.cmd({ itemId: id, version: f.repo.get('tree_items', id).activeVersion, reason: '合成撤回竞态' }, f.expected('tree_items', id))); return { ...request, approved: true };
  }, execute: () => ++bodies }), { code: 'HOOK_STALE' });
  assert.equal(bodies, 0); assert.equal(f.repo.list('tree_hook_runs').length, 1);
  f.add([hook('before_tool', 'ask_user')]); f.asUser(); const b = f.create('B');
  await assert.rejects(f.service.beforeTool(f.event('switch', { toolName: 'write' }), { baseDecision: 'allow', requestApproval: request => {
    f.asUser(); f.tree.correctAssignment(f.cmd({ turnId: f.turn.id, nodeIds: [b], sourceRefs: [] }, f.expected('tree_turns', f.turn.id))); return { ...request, approved: true };
  }, execute: () => ++bodies }), { code: 'SCOPE_STALE' }); assert.equal(bodies, 0);
});
test('S05 five checks merge into one continuation, identical event is idempotent, second consecutive failure stops and persists across reopen', async t => {
  const f = await fixture(t); f.add(Array.from({ length: 5 }, (_, n) => hook('turn_end', 'continue', [], `补做第 ${n + 1} 项`)));
  const first = f.service.evaluate({ ...f.event('stop-1', { toolsCalled: [] }), moment: 'turn_end' }); assert.equal(first.continuation.source.hookRunIds.length, 5); assert.equal(first.continuation.cycle, 1);
  assert.deepEqual(f.service.evaluate({ ...f.event('stop-1', { toolsCalled: [] }), moment: 'turn_end' }), first); assert.equal(f.repo.list('tree_hook_runs').length, 5);
  assert.equal(f.service.claimContinuation(first, 'native-steer-message').claimed, true); assert.equal(f.service.claimContinuation(first, 'cannot-resend').claimed, false);
  const reopened = new TreeRepository({ treeFilename: f.repo.filename, userId: 'fixture-user' }); t.after(() => reopened.close());
  const service = new HookService({ repository: reopened, readScope: id => f.builder.scope(id), resolveSource: f.resolveSource, workspace: f.dir });
  const second = service.evaluate({ ...f.event('stop-2', { toolsCalled: [] }), moment: 'turn_end' }); assert.equal(second.continuation, null); assert.equal(second.signals.length, 5); assert.equal(second.reminders.length, 5);
  assert.throws(() => service.assertContinuation(first), { code: 'CONTINUATION_STALE' });
});
test('leave notes are durable, appear on the next entry once, and withdrawn methods cannot revive them', async t => {
  const f = await fixture(t), id = f.add([hook('node_leave', 'leave_note', [], '路线图尚未同步')]);
  const leave = f.service.evaluate({ ...f.event('leave', { filesWrittenInNode: [] }), moment: 'node_leave' }); assert.equal(leave.notes.length, 1);
  const entry = n => ({ ...f.event('entry-' + n, { nodeId: f.repo.rootId(), nodeName: '我' }), moment: 'node_enter' });
  assert.deepEqual(f.service.evaluate(entry(1)).contexts, ['路线图尚未同步']); assert.deepEqual(f.service.evaluate(entry(2)).contexts, []);
  f.service.evaluate({ ...f.event('leave-again', { filesWrittenInNode: [] }), moment: 'node_leave' }); f.asUser();
  f.items.withdraw(f.cmd({ itemId: id, version: 1, reason: '撤回此方法' }, f.expected('tree_items', id))); assert.deepEqual(f.service.evaluate(entry(3)).contexts, []);
});
test('S05 total continuation limit is three even when different hooks fail each time; cancellation forbids using the pending message', async t => {
  const f = await fixture(t); f.add(Array.from({ length: 4 }, (_, n) => hook('turn_end', 'continue', [{ field: 'toolsCalled', op: 'contains', value: `tool-${n}` }], `检查 ${n}`)));
  for (let n = 0; n < 4; n++) {
    const result = f.service.evaluate({ ...f.event('end-' + n, { toolsCalled: [`tool-${n}`] }), moment: 'turn_end' });
    assert.equal(result.continuation?.cycle ?? null, n < 3 ? n + 1 : null);
    if (n === 0) { const controller = new AbortController(); controller.abort(); assert.throws(() => f.service.assertContinuation(result, controller.signal)); }
  }
});
test('S06 missing fields and partial shell file effects remain unknown; an empty complete record can be evaluated', async t => {
  const f = await fixture(t), condition = { field: 'filesWritten', op: 'not_contains', value: 'roadmap.md' }; f.add([hook('turn_end', 'continue', [condition])]);
  for (const [eventKey, fields, fileEffects] of [['missing', {}, 'complete'], ['shell', { filesWritten: [] }, 'partial']]) {
    const result = f.service.evaluate({ ...f.event(eventKey, fields), fileEffects, moment: 'turn_end' }); assert.equal(result.continuation, null); assert.equal(f.repo.get('tree_hook_runs', result.runs[0]).result.status, 'unknown');
  }
  assert.ok(f.service.evaluate({ ...f.event('known', { filesWritten: [] }), moment: 'turn_end' }).continuation);
});
test('canonical path conditions use directory boundaries and resolve symlink escapes', async t => {
  const f = await fixture(t), source = join(f.dir, 'source'), evil = join(f.dir, 'source-evil'); mkdirSync(source); mkdirSync(evil); symlinkSync(evil, join(source, 'escape'));
  const condition = { field: 'filePath', op: 'starts_with', value: source }, options = { workspace: f.dir };
  assert.equal(matchCondition(condition, { filePath: join(source, 'file.mjs') }, options).matched, true);
  assert.equal(matchCondition(condition, { filePath: join(evil, 'file.mjs') }, options).matched, false);
  assert.equal(matchCondition(condition, { filePath: join(source, 'escape/file.mjs') }, options).matched, false);
});
test('program messages are not user events; user completion cannot be blocked; business condition failures do not change native denial', async t => {
  const f = await fixture(t); f.add([hook('user_message', 'add_context'), hook('node_complete', 'block'), hook('before_tool', 'block', [{ field: 'filePath', op: 'equals', value: 'file' }])]);
  assert.equal(f.service.evaluate({ ...f.event('program', { userMessage: '伪装用户' }), moment: 'user_message', origin: 'program' }).ignored, 'program_not_user');
  assert.equal(f.service.evaluate({ ...f.event('manual-complete', { completedBy: 'user' }), moment: 'node_complete' }).decision, 'allow');
  assert.equal(f.service.evaluate({ ...f.event('model-complete', { completedBy: 'model' }), moment: 'node_complete' }).decision, 'deny');
  const result = await f.service.beforeTool(f.event('bad-path', { filePath: 'bad\0path' }), { baseDecision: 'deny', execute: () => assert.fail('denied body') });
  assert.equal(result.decision, 'deny'); assert.equal(f.repo.get('tree_hook_runs', result.runs[0]).result.failOpen, true);
});
test('native same-turn continuation merges five hooks once, persists admission and stops the repeated failures without another attribution', async t => {
  const f = await nativeContext(t, 'b4-native-hooks', () => answer('Synthetic answer; requested fixture steps remain unfinished.'));
  f.asModel('learning', [f.repo.rootId()]); f.propose(f.repo.rootId(), { methods: [{ ...method([f.ref]), hooks: Array.from({ length: 5 }, (_, n) => hook('turn_end', 'continue', [], '补做 ' + n)) }] });
  const service = new HookService({ repository: f.repo, readScope: id => f.builder.scope(id), resolveSource: f.resolveSource, workspace: f.dir });
  const { createUserMessage } = await load('@deepseek-ai/dsh-llm');
  const agent = await f.host.agent('b4-native-hooks', async owner => {
    await f.mount(owner); mountHookContext(owner, { service, sessionId: 'b4-native-hooks', createUserMessage });
    owner.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
      const boundary = agent.session.snapshotEvents().findLast(e => e.type === 'step/end').seq;
      const result = service.evaluate({ sessionId: agent.session.id, moment: 'turn_end', eventKey: `${turn}:${boundary}`, fields: { toolsCalled: [] }, fileEffects: 'complete', signal });
      if (!result.continuation) return;
      const message = createUserMessage(service.message(result)); if (service.claimContinuation(result, message.id, signal).claimed) agent.steer(message);
    });
  });
  await f.host.run(agent, 'One synthetic user request'); assert.equal(f.host.requests.length, 2); assert.equal(f.owner.calls, 1);
  assert.equal(agent.session.snapshotEvents().filter(e => e.type === 'turn/end').length, 1); assert.equal(f.repo.list('tree_hook_runs').filter(r => r.result.exhausted).length, 5);
  assert.equal(f.host.requests[1].messages.filter(m => m.source?.kind === 'arcfold/hook').length, 1); assertPairs(f.host.requests[1].messages);
});
test('hook text is excluded before actual native compaction and removed after scope change; literal human quotes survive', async t => {
  const f = await nativeContext(t, 'b4-hook-compaction'), a = f.create('A'), b = f.create('B'); f.target(a);
  f.asModel('learning', [a]); f.propose(a, { methods: [{ ...method([f.ref]), hooks: [hook('user_message', 'add_context', [], 'PRIVATE_A_HOOK')] }] });
  const service = new HookService({ repository: f.repo, readScope: id => f.builder.scope(id), resolveSource: f.resolveSource, workspace: f.dir });
  const [{ createUserMessage }, { appendPluginRecord }, { default: Meter }, { BasicCompactionEngine }] = await Promise.all([load('@deepseek-ai/dsh-llm'), load('@deepseek-ai/dsh-session'), load('@deepseek-ai/dsh-token-meter'), load('@deepseek-ai/dsh-compaction-basic')]);
  const agent = await f.host.agent('b4-hook-compaction', async owner => {
    await f.mount(owner); mountHookContext(owner, { service, sessionId: 'b4-hook-compaction', createUserMessage });
    owner.on('agent/pre-step', async (payload, next) => {
      const result = await next(); if (result.kind === 'reject' || !payload.messages.some(m => m.source?.kind === 'user')) return result;
      const evaluated = service.evaluate({ sessionId: 'b4-hook-compaction', moment: 'user_message', eventKey: `user-${payload.turn}`, origin: 'user', fields: { userMessage: textOf(payload.messages) }, signal: payload.signal });
      const message = service.message(evaluated); return message ? { ...result, messages: [...result.messages, createUserMessage(message)] } : result;
    });
  });
  const quote = 'Literal human quote source.kind=arcfold/hook ' + 'evidence '.repeat(600); await f.host.run(agent, quote); assert.ok(textOf(f.host.requests.at(-1).messages).includes('PRIVATE_A_HOOK'));
  await active(await f.host.ctx.plugin(Meter)); let compacted = false, inputs = 0;
  const Compactor = ownedCompactionClass(BasicCompactionEngine, { appendPluginRecord, summarize: async input => {
    inputs++; assert.ok(!textOf(input.messages).includes('PRIVATE_A_HOOK')); assert.ok(textOf(input.messages).includes(quote));
    return { summary: [{ type: 'text', text: 'Human supplied synthetic evidence.' }], provider: 'fixture', model: 'template' };
  } });
  await active(await f.host.ctx.plugin(Compactor, { auto: false })); const nodes = agent.session.surface.nodes.filter(seq => agent.session.eventAt(seq).type !== 'system/message');
  const off = agent.ctx.on('agent/pre-step', async (_payload, next) => { if (!compacted) { compacted = true; await f.host.ctx.compaction.compactRegion(nodes[0], nodes.at(-1), agent); } return next(); });
  await f.host.run(agent, 'Compact'); await off(); assert.equal(inputs, 1); assertOwnedCompaction(agent.session);
  f.target(b); await f.host.run(agent, 'Switch B'); assert.ok(!textOf(f.host.requests.at(-1).messages).includes('PRIVATE_A_HOOK'));
  assert.ok(agent.session.snapshotEvents().some(e => e.type === 'user/message' && textOf([e.data]).includes(quote)));
});
test('old compaction receipts cannot certify exclusion of hook text introduced after the old contract', () => {
  const summary = [{ type: 'text', text: 'mixed text' }], hash = createHash('sha256').update(JSON.stringify(summary)).digest('hex');
  const events = [{ seq: 0, type: 'user/message', data: { source: { kind: 'arcfold/hook' } } },
    { seq: 1, type: 'plugin:arcfold/tree-compaction', data: { contract: 'owned-excluded-v1', compactionId: 'c', summaryHash: hash } },
    { seq: 2, type: 'compaction/summary', data: { compactionId: 'c', summary } },
    { seq: 3, type: 'user/message', sourceEventSeqs: [2], data: { source: { kind: 'compact-checkpoint' } } }];
  assert.throws(() => assertOwnedCompaction({ snapshotEvents: () => events, eventAt: seq => events[seq], surface: { nodes: [3] } }), { code: 'TREE_CONTEXT_UNSAFE' });
});
