import test from 'node:test';
import assert from 'node:assert/strict';
import * as Retry from '@deepseek-ai/dsh-llm-retry';
import * as Bash from '@deepseek-ai/dsh-tool-bash';
import * as Files from '@deepseek-ai/dsh-tool-fs';
import * as Search from '@deepseek-ai/dsh-tool-fs-search';
import * as Shell from '@deepseek-ai/dsh-shell-env';
import { nativeFixture, active } from './fixtures/tree-model/native.mjs';
import { minimal } from './fixtures/tree-model/contracts.mjs';
import { nativePosition } from '../src/tree/model-owner.mjs';
const retryPolicy = { mode: 'normal', maxRetries: 5, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } };

for (const role of ['main', 'learning']) test(`native ${role} retries a dropped connection with one invocation and retained attempts`, async t => {
  const f = await nativeFixture(t, row => {
    if (row.ordinal <= 2) throw new Error('synthetic connection reset');
    return minimal[role] ?? '恢复后的合成回答';
  }, { nativeModels: true, retryPolicy });
  await active(await f.ctx.plugin(Retry));
  const result = role === 'main' ? await f.runMain() : await f.owner.run(f.enqueue(role).id);
  assert.equal(result.status, 'committed', JSON.stringify(result.error));
  assert.equal(f.requests.length, 3);
  assert.equal(result.invocationIds.length, 1);
  for (const request of f.requests.slice(1)) assert.deepEqual(f.requests[0].body, request.body, 'every retry sends identical content');
  const row = f.nativeRecords.summary().records[0];
  assert.equal(row.retryCount, 2); assert.equal(row.attemptHistory.length, 2);
  assert.equal(row.attemptHistory[0].status, 'failed');
  assert.equal(row.status, 'response_received'); assert.equal(row.cost, null);
  assert.equal(f.nativeRecords.summary().attempts, 3);

});

const base = () => [
  { seq: 0, type: 'turn/start', data: { turn: 1 } },
  { seq: 1, type: 'step/start', data: { turn: 1, step: 1 } },
  { seq: 2, type: 'assistant/attempt', data: { turn: 1, step: 1, stream: [{ type: 'chunk', time: 0, chunk: { type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT' } } } }] } },
  { seq: 3, type: 'llm/retry', data: { turn: 1, step: 1, retryId: 'retry-1', retry: 1, mode: 'normal', maxRetries: 5, failure: { code: 'TRANSPORT' } } },
  { seq: 4, type: 'llm/retry-started', data: { turn: 1, step: 1, retryId: 'retry-1', retry: 1 } },
];
test('retry requires exact host events and rejects output, ended steps, wrong turns and missing retry evidence', () => {
  assert.equal(nativePosition({ snapshotEvents: base }, true).retryCount, 1);
  assert.throws(() => nativePosition({ snapshotEvents: base }), { code: 'NATIVE_STEP' });
  for (const mutate of [
    e => e.push({ seq: 5, type: 'assistant/message', data: {} }),
    e => e.push({ seq: 5, type: 'step/end', data: {} }),
    e => e.push({ seq: 5, type: 'turn/end', data: {} }),
    e => e[4].data.turn++, e => e[4].data.retryId = 'other', e => e.splice(4, 1),
    e => e[2].data.stream.unshift({ type: 'text-chunks', texts: ['partial'], dt: [], time0: 0, index: 0 }),
    e => e[2].data.stream[0].chunk.reason.kind = 'stop',
    e => { delete e[2].data.stream[0].chunk.reason.failure; delete e[3].data.failure; },
    e => { delete e[3].data.retryId; delete e[4].data.retryId; },
  ]) {
    const events = base(); mutate(events);
    assert.throws(() => nativePosition({ snapshotEvents: () => events }, true), { code: 'NATIVE_STEP' });
  }
});

test('changing the request on a native retry is rejected before a second send', async t => {
  const f = await nativeFixture(t, () => { throw new Error('synthetic connection reset'); }, { nativeModels: true, retryPolicy });
  await active(await f.ctx.plugin(Retry));
  const original = f.owner.assertProjection.bind(f.owner);
  f.owner.assertProjection = (job, options) => {
    if (f.ctx.sessions.get(options.sessionId).snapshotEvents().some(e => e.type === 'llm/retry-started')) {
      options.messages = [...options.messages, { role: 'developer', content: [{ type: 'text', text: 'changed request' }] }];
    }
    return original(job, options);
  };
  await assert.rejects(() => f.runMain(), { code: 'RESULT_UNKNOWN' });
  assert.equal(f.requests.length, 1);
  assert.equal(f.repo.list('tree_invocations').length, 1);
});

test('actual main retry retains the native header tool list', async t => {
  const { bootstrapFixture } = await import('./fixtures/tree-integration/bootstrap.mjs');
  const f = await bootstrapFixture(t, row => {
    if (row.role === 'attribution') return { actions: [{ action: 'continue', nodeId: row.input.scope.nodeIds[0] }], statusChanges: [] };
    if (row.role === 'learning') return minimal.learning;
    if (row.role === 'main' && !f.requests.slice(0, -1).some(r => r.role === 'main')) throw new Error('synthetic reset');
    return '合成重试完成';
  }, { nativeModels: true, nativeHost: true });
  await active(await f.ctx.plugin(Retry));
  const agent = await f.main('native-retry-tools', async ctx => {
    await active(await ctx.plugin(Shell, { dshHome: f.privateRoot }));
    await active(await ctx.plugin(Bash));
    await active(await ctx.plugin(Files, { read: true, readImage: false, write: true, edit: true, applyPatch: false }));
    await active(await ctx.plugin(Search, { sampleOverCapGlobResults: false }));
  });
  const turn = await f.turn(agent, '合成断线重试');
  assert.equal(turn.status, 'settled');
  assert.equal(agent.session.snapshotEvents().findLast(e => e.type === 'turn/end').data.reason.kind, 'completed');
  const requests = f.requests.filter(r => r.role === 'main');
  assert.equal(requests.length, 2);
  const header = agent.session.requestHeader().tools.map(t => t.name).sort();
  for (const name of ['bash', 'read', 'write', 'edit', 'glob', 'grep']) assert.ok(header.includes(name), name);
  for (const request of requests) assert.deepEqual(request.body.tools.map(t => t.name).sort(), header);
});
