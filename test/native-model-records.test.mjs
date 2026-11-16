import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TreeRepository } from '../src/tree/repository.mjs';
import { NativeModelRecords } from '../src/tree/native-model-records.mjs';
import { nativeFixture } from './fixtures/tree-model/native.mjs';
import { minimal } from './fixtures/tree-model/contracts.mjs';

test('native request records distinguish response, usage and billing, and never replay an attempt', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-receipts-')));
  let repo = new TreeRepository({ treeFilename: join(root, 'tree.sqlite'), userId: 'synthetic-owner' });
  t.after(() => { repo.close(); rmSync(root, { recursive: true, force: true }); });
  const cases = [
    ['reported', [{ type: 'usage', usage: { inputTokens: 8, outputTokens: 2, secret: 'discard' } }, { type: 'finish', reason: { kind: 'stop' } }], 'response_received', 'reported'],
    ['missing', [{ type: 'finish', reason: { kind: 'stop' } }], 'response_received', 'missing'],
    ['invalid', [{ type: 'usage', usage: { inputTokens: -1, outputTokens: 2 } }, { type: 'finish', reason: { kind: 'stop' } }], 'response_received', 'invalid'],
    ['zero', [{ type: 'usage', usage: { inputTokens: 8, outputTokens: 0 } }, { type: 'finish', reason: { kind: 'stop' } }], 'response_received', 'unconfirmed'],
    ['failed', [{ type: 'finish', reason: { kind: 'error' } }], 'failed', 'missing'],
    ['cancelled', [{ type: 'finish', reason: { kind: 'aborted' } }], 'cancelled', 'missing'],
    ['partial', [{ type: 'text-delta', delta: 'partial' }], 'unknown', 'missing'],
  ];
  const owner = { assertRequest: options => ({ requestId: options.sessionId }) };
  let records = new NativeModelRecords(repo, owner), sends = 0;
  for (const [id, chunks, status, usageStatus] of cases) {
    repo.transaction(() => repo.save('tree_invocations', { id, jobId: id, role: 'main', nativeSessionId: id, ordinal: 1,
      modelConfigHash: 'synthetic', promptHash: 'synthetic', inputHash: 'synthetic', allowedTools: [], state: 'admitted', ledgerRequestId: id }));
    const options = { sessionId: id, provider: 'synthetic', model: 'synthetic', signal: new AbortController().signal };
    const next = async function* () { sends++; yield* chunks; };
    for await (const _chunk of records.stream(options, next)) {}
    const receipt = records.get(id);
    assert.equal(receipt.status, status); assert.equal(receipt.usageStatus, usageStatus);
    assert.equal(receipt.cost, null); assert.equal(receipt.priceStatus, 'unknown');
    assert.equal(receipt.usage?.secret, undefined);
    if (usageStatus !== 'reported') assert.equal(receipt.usage, null);
    await assert.rejects(async () => { for await (const _chunk of records.stream(options, next)) {} }, { code: 'INVOCATION_REPLAY' });
  }
  assert.equal(sends, cases.length);
  records.write('partial', { status: 'started' });
  repo.close(); repo = new TreeRepository({ treeFilename: join(root, 'tree.sqlite'), userId: 'synthetic-owner' });
  records = new NativeModelRecords(repo, owner); records.recover();
  assert.equal(records.get('partial').status, 'unknown'); assert.equal(sends, cases.length);
  assert.equal(records.get('reported').usage.inputTokens, 8);
});

test('all seven roles validate and commit through the unmodified native adapter, with no billing fiction', async t => {
  const f = await nativeFixture(t, ({ role, input }) => role === 'attribution'
    ? { actions: [{ action: 'continue', nodeId: input.scope.nodeIds[0] }], statusChanges: [] } : minimal[role] ?? '合成答复', { nativeModels: true });
  for (const role of ['attribution', 'learning', 'consolidation', 'verification', 'improvement', 'script_writer']) {
    const result = await f.owner.run(f.enqueue(role).id);
    assert.equal(result.status, 'committed', JSON.stringify(result.error));
  }
  assert.equal((await f.runMain()).status, 'committed');
  assert.equal(f.requests.length, 7); assert.equal(f.nativeRecords.summary().complete, 7);
  assert.equal(f.ledger.list().length, 0);
  await f.owner.recover(); assert.equal(f.requests.length, 7);
});

test('native invalid JSON and output limits preserve originals without retrying or accepting partial output', async t => {
  for (const limited of [false, true]) await t.test(limited ? 'output limit' : 'invalid JSON', async t => {
    const f = await nativeFixture(t, () => limited ? minimal.verification : '{"broken":',
      { nativeModels: true, ...(limited ? { sseOptions: { stopReason: 'max_tokens' } } : {}) });
    const job = f.enqueue('verification'), result = await f.owner.run(job.id);
    assert.equal(result.status, 'invalid_output'); assert.ok(result.rawMessage);
    if (limited) assert.equal(result.error.code, 'OUTPUT_LIMIT');
    await f.owner.run(job.id); await f.owner.recover(); assert.equal(f.requests.length, 1);
    assert.equal(f.nativeRecords.summary().complete, 1);
  });
});

test('a native adapter default zero for missing output usage stays unconfirmed while the valid result is retained', async t => {
  const f = await nativeFixture(t, () => minimal.verification, { nativeModels: true, sseOptions: { usage: false } });
  const result = await f.owner.run(f.enqueue('verification').id);
  assert.equal(result.status, 'committed');
  const receipt = f.nativeRecords.summary().records[0];
  assert.equal(receipt.adapterUsage.inputTokens, 100); assert.equal(receipt.adapterUsage.outputTokens, 0);
  assert.equal(receipt.usage, null); assert.equal(receipt.usageStatus, 'unconfirmed'); assert.equal(receipt.cost, null);
  await f.owner.recover(); assert.equal(f.requests.length, 1);
});
