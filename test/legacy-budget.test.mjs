import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { BudgetLedger } from '../src/budget.mjs';
import { Store } from '../src/store.mjs';

const finite = { ceilingCny: 150, authorizationRef: 'synthetic-development-150' };
const webAuthorization = { authorizationRef: 'synthetic-web', authorizedAt: '2026-11-07T00:00:00Z',
  authorizationEvidence: 'Synthetic independent unlimited web decision.' };
const webOnly = { mode: 'web-only', scope: 'web-unlimited', webAuthorization };
const reservation = id => ({ requestId: id, bodyHash: 'body-' + id, model: 'deepseek-v4-pro',
  inputTokenCeiling: 1048576, maxOutputTokens: 16384, prices: { input: 9, cachedInput: 0.3, output: 27 } });
function file(t) {
  const directory = mkdtempSync(join(tmpdir(), 'arcfold-legacy-budget-fixture-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'budget.sqlite');
}
function snapshot(filename) {
  return Object.fromEntries(readdirSync(dirname(filename)).sort().map(name => [name, readFileSync(join(dirname(filename), name))]));
}

test('pure web cannot claim legacy limited, mixed, business or unknown databases even with create', t => {
  for (const kind of ['limited', 'mixed', 'business', 'unknown', 'damaged-legacy']) {
    const filename = file(t);
    if (kind === 'business') { const store = new Store(filename); store.save('understandings', { id: 'original' }); store.close(); }
    else if (kind === 'unknown') { const db = new DatabaseSync(filename); db.exec('CREATE TABLE unrelated (original TEXT)'); db.close(); }
    else {
      const ledger = new BudgetLedger(filename, { ...finite, create: true,
        ...(kind === 'mixed' ? { scope: 'web-unlimited', webAuthorization } : {}) });
      ledger.reserve(reservation('original')); ledger.markDispatched('original'); ledger.markUnknown('original');
      if (kind === 'damaged-legacy') ledger.db.exec('DROP TABLE budget_settings');
      ledger.close();
    }
    const before = snapshot(filename);
    assert.throws(() => new BudgetLedger(filename, { ...webOnly, create: true }));
    assert.deepEqual(snapshot(filename), before);
  }
});

test('ordinary budget and Store modes cannot turn a pure web ledger into a finite or business database', t => {
  const filename = file(t), ledger = new BudgetLedger(filename, { ...webOnly, create: true });
  ledger.reserve(reservation('original')); ledger.markDispatched('original'); ledger.markUnknown('original'); ledger.close();
  const before = snapshot(filename);
  for (const action of [
    () => new BudgetLedger(filename, finite),
    () => new BudgetLedger(filename, { ...finite, scope: 'web-unlimited', webAuthorization }),
    () => new Store(filename),
    () => new Store(filename, { mode: 'legacy-records-v2', create: true }),
    () => new Store(filename, { mode: 'legacy-ledger-v2', create: true })
  ]) {
    assert.throws(action, { code: 'invalid_store_mode' });
    assert.deepEqual(snapshot(filename), before);
  }
});

function interruptedWrite(filename) {
  const child = function () {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA cache_size=1; BEGIN IMMEDIATE; UPDATE budget_requests SET reserved_micro=0');
    const insert = db.prepare("INSERT INTO budget_requests VALUES(?,?,'reserved',1,0,?,'web-unlimited')");
    for (let i = 0; i < 100; i++)
      insert.run('partial-' + i, 'hash', JSON.stringify({ pad: 'x'.repeat(8192) }));
    process.exit(0);
  };
  execFileSync(process.execPath, ['-e', '(' + child.toString() + ')()', filename]);
}
function fileHashes(filename) {
  return Object.fromEntries(Object.entries(snapshot(filename)).map(([name, bytes]) =>
    [name, createHash('sha256').update(bytes).digest('hex')]));
}
test('every wrong Store and budget mode refuses a real web hot journal without recovery', t => {
  const openers = [
    filename => new Store(filename),
    filename => new Store(filename, { mode: 'legacy-records-v2', create: true }),
    filename => new Store(filename, { mode: 'legacy-ledger-v2', create: true }),
    filename => new BudgetLedger(filename, finite),
    filename => new BudgetLedger(filename, { ...finite, scope: 'web-unlimited', webAuthorization })
  ];
  for (const opener of openers) {
    const filename = file(t), ledger = new BudgetLedger(filename, { ...webOnly, create: true });
    ledger.reserve(reservation('original')); ledger.markDispatched('original'); ledger.markUnknown('original'); ledger.close();
    interruptedWrite(filename);
    assert.equal(readFileSync(filename + '-journal').subarray(0, 8).toString('hex'), 'd9d505f920a163d7');
    assert.equal(readFileSync(filename).readUInt32BE(68), 0x41574631);
    const before = fileHashes(filename);
    assert.throws(() => opener(filename), { code: 'invalid_store_mode' });
    assert.deepEqual(fileHashes(filename), before, 'wrong mode must not recover the main file or remove its journal');
  }
});

test('unmarked limited and mixed ledgers retain normal SQLite rollback and WAL recovery', t => {
  for (const kind of ['limited', 'mixed']) for (const journalMode of ['DELETE', 'WAL']) {
    const filename = file(t), declared = { ...finite,
      ...(kind === 'mixed' ? { scope: 'web-unlimited', webAuthorization } : {}) };
    const ledger = new BudgetLedger(filename, { ...declared, create: true });
    ledger.reserve(reservation('original')); ledger.markDispatched('original'); ledger.markUnknown('original');
    const original = ledger.get('original'), summary = ledger.summary();
    const authorityRows = ledger.db.prepare('SELECT * FROM records ORDER BY rowid').all();
    const sequence = ledger.store.currentSequence(); ledger.close();
    const setup = new DatabaseSync(filename);
    assert.equal(setup.prepare('PRAGMA application_id').get().application_id, 0);
    setup.exec('PRAGMA journal_mode=' + journalMode); setup.close();
    interruptedWrite(filename);
    assert.equal(readFileSync(filename).readUInt32BE(68), 0);
    if (journalMode === 'DELETE')
      assert.equal(readFileSync(filename + '-journal').subarray(0, 8).toString('hex'), 'd9d505f920a163d7');
    else assert.ok(readFileSync(filename + '-wal').length > 32);
    const reopened = new BudgetLedger(filename, declared); t.after(() => reopened.close());
    assert.deepEqual(reopened.get('original'), original);
    assert.deepEqual(reopened.summary(), summary);
    assert.deepEqual(reopened.db.prepare('SELECT * FROM records ORDER BY rowid').all(), authorityRows);
    assert.equal(reopened.store.currentSequence(), sequence);
    assert.equal(reopened.db.prepare('PRAGMA application_id').get().application_id, 0);
    assert.equal(reopened.list().length, 1);
  }
});

test('original limited upgrades and mixed allTime totals retain existing records and order', t => {
  const filename = file(t);
  const limited = new BudgetLedger(filename, { ...finite, create: true }); t.after(() => limited.close());
  const web = new BudgetLedger(filename, { ...finite, scope: 'web-unlimited', webAuthorization }); t.after(() => web.close());
  const oldAuth = web.store.get('budget_authorizations', web.webAuthorizationId);
  limited.reserve(reservation('limited-unknown')); limited.markDispatched('limited-unknown'); limited.markUnknown('limited-unknown');
  web.reserve(reservation('web-settled')); web.markDispatched('web-settled');
  web.settle('web-settled', { promptTokens: 100, completionTokens: 3, cachedTokens: 20 });
  const oldRows = limited.db.prepare('SELECT * FROM budget_requests ORDER BY id').all();
  const upgrade = limited.upgradeAuthorization({ expectedCeilingCny: 150, expectedAuthorizationRef: finite.authorizationRef,
    ceilingCny: 200, authorizationRef: 'synthetic-development-200', authorizedAt: '2026-11-07T01:00:00Z',
    authorizationEvidence: 'Synthetic finite upgrade, independent of web authority.' });
  assert.equal(upgrade.createdSequence, oldAuth.updatedSequence + 1);
  assert.deepEqual(web.store.get('budget_authorizations', web.webAuthorizationId), oldAuth);
  assert.deepEqual(limited.db.prepare('SELECT * FROM budget_requests ORDER BY id').all(), oldRows);
  assert.equal(limited.summary().ceilingCny, 200); assert.equal(limited.summary().spentMicroCny, 0);
  assert.equal(limited.summary().reservedMicroCny, 9879552);
  assert.equal(web.summary().ceilingCny, null); assert.equal(web.summary().spentMicroCny, 807);
  assert.deepEqual(limited.summary().allTime, web.summary().allTime);
  assert.equal(web.summary().allTime.requests, 2); assert.equal(web.summary().allTime.unknownCount, 1);
  limited.close(); web.close();
  const reopened = new BudgetLedger(filename, { ceilingCny: 200, authorizationRef: 'synthetic-development-200' });
  t.after(() => reopened.close());
  assert.deepEqual(reopened.db.prepare('SELECT * FROM budget_requests ORDER BY id').all(), oldRows);
  assert.equal(reopened.store.currentSequence(), upgrade.updatedSequence);
});
