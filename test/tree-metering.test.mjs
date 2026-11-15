import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { TreeTestLedger, TEST_STAGE_CNY } from '../src/tree/experiment-budget.mjs';
import { nativeFixture } from './fixtures/tree-model/native.mjs';
import { manifest, authorizationRef, reservation } from './fixtures/tree-model/budget.mjs';

function setup(t, policy = manifest) {
  const dir = mkdtempSync(join(tmpdir(), 'tree-budget-')), filename = join(dir, 'test-ledger.sqlite');
  let ledger = new TreeTestLedger({ filename, manifest: policy, authorizationRef, create: true });
  t.after(() => { ledger.close(); rmSync(dir, { recursive: true, force: true }); });
  return { filename, get ledger() { return ledger; }, restart() { ledger.close(); ledger = new TreeTestLedger({ filename, manifest: policy, authorizationRef }); return ledger; } };
}
test('T-B01/T-B07: two real processes race for the last shared CNY; one wins across all stages and restart', async t => {
  // Synthetic one-CNY pricing makes an exact 150 boundary possible without
  // writing ledger internals. Production peak-price arithmetic is tested below.
  const policy = { ...manifest, prices: { input: 1, output: 0, cachedInput: 0 } }, f = setup(t, policy);
  for (const [stage, ceiling] of Object.entries(TEST_STAGE_CNY)) for (let i = 0; i < ceiling - (stage === 'roles' ? 1 : 0); i++) f.ledger.reserve(reservation(`${stage}-${i}`, stage, policy));
  f.ledger.markDispatched('smoke-0'); f.ledger.markUnknown('smoke-0', 'Synthetic timeout');
  assert.equal(f.ledger.summary().reservedCny, 149);
  const workers = [1, 2].map(n => {
    const child = fork(new URL('./fixtures/tree-model/budget-worker.mjs', import.meta.url), [f.filename, JSON.stringify(policy), `race-${n}`], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    t.after(() => { if (!child.killed && child.exitCode === null) child.kill(); });
    let ready; const started = new Promise(r => { ready = r; }), result = new Promise((resolve, reject) => {
      child.on('message', m => m.ready ? ready() : resolve(m)); child.on('error', reject);
      child.on('exit', code => { if (code) reject(new Error(`Budget worker exited ${code}`)); });
    }); return { child, started, result };
  });
  await Promise.all(workers.map(w => w.started)); workers.forEach(w => w.child.send('reserve'));
  const results = await Promise.all(workers.map(w => w.result)); assert.equal(results.filter(r => r.ok).length, 1); assert.equal(results.find(r => !r.ok).code, 'budget_exceeded');
  assert.equal(f.restart().summary().availableMicroCny, 0); assert.equal(f.ledger.summary().unknownMicroCny, 1000000); assert.equal(f.ledger.summary().reservedMicroCny, 150000000);
});
test('T-B02/T-B03/T-B05/T-B06: unknown keeps its full reservation; late usage settles once and missing cache means miss', t => {
  const f = setup(t), spec = reservation('uncertain'); f.ledger.reserve(spec); f.ledger.markDispatched(spec.requestId);
  assert.throws(() => f.ledger.settle(spec.requestId, undefined), { code: 'invalid_usage' });
  const unknown = f.restart().get(spec.requestId); assert.equal(unknown.status, 'unknown'); assert.equal(unknown.reservedMicroCny, 2065536);
  assert.throws(() => f.ledger.releaseUnsent(spec.requestId), { code: 'already_dispatched' });
  assert.throws(() => f.ledger.markDispatched(spec.requestId), { code: 'request_already_dispatched' });
  const usage = { promptTokens: 100, completionTokens: 10 }; f.ledger.settle(spec.requestId, usage); f.ledger.settle(spec.requestId, usage);
  assert.equal(f.ledger.summary().spentMicroCny, 280); assert.equal(f.ledger.get(spec.requestId).usage.cachedTokens, 0); assert.equal(f.ledger.summary().reservedMicroCny, 0);
  assert.throws(() => f.ledger.settle(spec.requestId, { ...usage, completionTokens: 11 }), { code: 'usage_conflict' });
});
test('T-B04/T-B11: immutable peak prices, full 1M miss input, finite output and repair gate', t => {
  const f = setup(t), spec = reservation('peak'); assert.equal(f.ledger.reserve(spec).reservedMicroCny, 2065536);
  for (const change of [{ prices: { input: 1, output: 4, cachedInput: 0.02 } }, { inputTokenCeiling: 100 }, { maxOutputTokens: 384000 }, { model: 'different' }]) assert.throws(() => f.ledger.reserve({ ...spec, ...change }), { code: 'TEST_RESERVATION' });
  assert.throws(() => { f.ledger.manifest.prices.input = 1; }, TypeError);
  assert.throws(() => f.ledger.reserve({ ...spec, metadata: { ...spec.metadata, priceVersion: 'old-price' } }), { code: 'TEST_RESERVATION' });
  assert.throws(() => new TreeTestLedger({ filename: f.filename, manifest: { ...manifest, modelVersion: 'changed' }, authorizationRef }), { code: 'TEST_MANIFEST_CONFLICT' });
  const repair = reservation('repair', 'repair'); delete repair.metadata.failureId;
  assert.throws(() => f.ledger.reserve(repair), { code: 'TEST_REPAIR' });
  const unowned = reservation('unowned'); delete unowned.metadata.treeInvocationId;
  assert.throws(() => f.ledger.reserve(unowned), { code: 'TEST_OWNER' });
});
test('all seven roles share two in-flight request slots and one writer slot, atomically', t => {
  const f = setup(t);
  for (const [id, role] of [['writer-1', 'script_writer'], ['writer-2', 'script_writer'], ['main', 'main'], ['third', 'verification']]) {
    const spec = reservation(id, 'roles'); spec.metadata.role = role; f.ledger.reserve(spec);
  }
  f.ledger.markDispatched('writer-1'); assert.throws(() => f.ledger.markDispatched('writer-2'), { code: 'TEST_CONCURRENCY' });
  f.ledger.markDispatched('main'); assert.throws(() => f.ledger.markDispatched('third'), { code: 'TEST_CONCURRENCY' });
  f.ledger.markUnknown('main', 'Synthetic completed transport timeout'); f.ledger.markDispatched('third'); assert.equal(f.ledger.get('third').status, 'dispatched');
  assert.equal(f.ledger.get('writer-2').dispatchedAt, null);
});
test('T-B08: an exhausted stage rejects the actual native provider path before HTTP body runs', async t => {
  const f = await nativeFixture(t); for (let i = 0; i < 2; i++) f.ledger.reserve(reservation(`held-${i}`));
  const result = await f.owner.run(f.enqueue('learning').id); assert.equal(result.status, 'unknown'); assert.equal(f.requests.length, 0); assert.equal(f.ledger.list().length, 2);
});
test('T-B09/T-B10: real native request evidence excludes transport credential and binds its ledger identity', async t => {
  const f = await nativeFixture(t); const result = await f.owner.run(f.enqueue('learning').id); assert.equal(result.status, 'committed');
  const row = f.ledger.list()[0]; assert.equal(row.metadata.treeJobId, result.id); assert.equal(row.metadata.treeInvocationId, result.invocationIds[0]);
  for (const name of readdirSync(join(f.root, 'requests'), { recursive: true })) {
    if (!/\.(json|bin)$/.test(name)) continue;
    const value = readFileSync(join(f.root, 'requests', name), 'utf8'); assert.equal(value.includes('synthetic-key-never-real'), false);
  }
});
