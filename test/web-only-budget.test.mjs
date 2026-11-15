import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { BudgetLedger } from '../src/budget.mjs';
import { Store } from '../src/store.mjs';

const webAuthorization = { authorizationRef: 'synthetic-web-only', authorizedAt: '2026-11-07T00:00:00Z',
  authorizationEvidence: 'Synthetic fixture: authorize unlimited web use independently.' };
const options = { mode: 'web-only', scope: 'web-unlimited', webAuthorization };
const reservation = id => ({ requestId: id, bodyHash: 'body-' + id, model: 'deepseek-v4-pro',
  inputTokenCeiling: 1048576, maxOutputTokens: 16384, prices: { input: 9, output: 27, cachedInput: 0.3 } });
function file(t) {
  const directory = mkdtempSync(join(tmpdir(), 'arcfold-web-only-fixture-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'budget.sqlite');
}
function open(t, filename, extra = {}) {
  const ledger = new BudgetLedger(filename, { ...options, ...extra });
  t.after(() => ledger.close()); return ledger;
}
function snapshot(filename) {
  return Object.fromEntries(readdirSync(dirname(filename)).sort().map(name =>
    [name, readFileSync(join(dirname(filename), name))]));
}
function unchangedRefusal(filename, declared, code) {
  const before = snapshot(filename);
  assert.throws(() => new BudgetLedger(filename, declared), code ? { code } : undefined);
  assert.deepEqual(snapshot(filename), before);
}

test('pure web creation records one identity and no finite allowance; reopen does not write', t => {
  const filename = file(t);
  assert.throws(() => new BudgetLedger(filename, options), { code: 'ledger_missing' });
  assert.equal(existsSync(filename), false);
  const ledger = open(t, filename, { create: true });
  assert.equal(Object.hasOwn(ledger, 'authorization'), false);
  assert.equal(ledger.db.prepare('PRAGMA application_id').get().application_id, 0x41574631);
  assert.equal(readFileSync(filename).readUInt32BE(68), 0x41574631);
  assert.deepEqual(ledger.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(row => row.name),
    ['budget_requests', 'records', 'store_meta']);
  assert.equal(ledger.store.currentSequence(), 1);
  assert.deepEqual(ledger.summary(), {
    scope: 'web-unlimited', ceilingCny: null, spentCny: 0, reservedCny: 0, availableCny: null,
    unknownCount: 0, requests: 0, ceilingMicroCny: null, spentMicroCny: 0, reservedMicroCny: 0, availableMicroCny: null,
    allTime: { spentCny: 0, reservedCny: 0, spentMicroCny: 0, reservedMicroCny: 0, unknownCount: 0, requests: 0 }
  });
  const authority = ledger.store.get('budget_authorizations', ledger.webAuthorizationId);
  assert.equal(authority.revision, 1);
  assert.equal(authority.sequenceEstablishedBy, 'native');
  ledger.close();
  const before = snapshot(filename);
  const reopened = open(t, filename, { create: true });
  assert.deepEqual(reopened.store.get('budget_authorizations', reopened.webAuthorizationId), authority);
  assert.equal(reopened.store.currentSequence(), 1);
  reopened.close();
  assert.deepEqual(snapshot(filename), before);
});

test('interrupted initialization rolls all schema and authority changes back without reclaiming the file', t => {
  const filename = file(t);
  const fault = t.mock.method(Store.prototype, 'save', () => { throw new Error('synthetic initialization interruption'); });
  try {
    assert.throws(() => new BudgetLedger(filename, { ...options, create: true }), /synthetic initialization interruption/);
  } finally { fault.mock.restore(); }
  assert.equal(existsSync(filename), true);
  const db = new DatabaseSync(filename, { readOnly: true });
  assert.deepEqual(db.prepare('SELECT name FROM sqlite_schema').all(), []);
  assert.equal(db.prepare('PRAGMA application_id').get().application_id, 0);
  db.close();
  unchangedRefusal(filename, { ...options, create: true }, 'unsupported_ledger_schema');
});

test('web-only requires its explicit scope and authority and rejects every base allowance option before creation', t => {
  const invalid = [
    { ...options, scope: 'limited' },
    { mode: 'web-only', webAuthorization },
    { ...options, ceilingCny: 50 }, { ...options, ceilingCny: undefined },
    { ...options, authorizationRef: 'base' }, { ...options, authorizationRef: undefined },
    { ...options, mode: 'unknown' }, { ...options, webAuthorization: undefined },
    { ...options, webAuthorization: { ...webAuthorization, authorizedAt: 'not-a-date' } }
  ];
  for (const declared of invalid) {
    const filename = file(t);
    assert.throws(() => new BudgetLedger(filename, { ...declared, create: true }));
    assert.equal(existsSync(filename), false);
  }
});

test('new mode, wrong authority and changed evidence cannot claim an existing web ledger', t => {
  const filename = file(t), ledger = open(t, filename, { create: true });
  ledger.reserve(reservation('old'));
  ledger.markDispatched('old'); ledger.markUnknown('old');
  ledger.close();
  for (const declared of [
    { ...options, webAuthorization: { ...webAuthorization, authorizationRef: 'new-identity' } },
    { ...options, webAuthorization: { ...webAuthorization, authorizationEvidence: 'changed evidence' } },
    { ...options, webAuthorization: { ...webAuthorization, authorizedAt: '2026-11-08T00:00:00Z' } },
    { ...options, webAuthorization: undefined },
    { ...options, mode: 'unknown' },
    { ceilingCny: 150, authorizationRef: 'synthetic-limited' }
  ]) {
    unchangedRefusal(filename, { ...declared, create: true });
    unchangedRefusal(filename, declared);
  }
  const reopened = open(t, filename);
  assert.equal(reopened.get('old').status, 'unknown');
  assert.equal(reopened.summary().reservedMicroCny, 9879552);
});

test('two connections share integer accounting, preserve unknown usage and reject finite upgrades', t => {
  const filename = file(t), first = open(t, filename, { create: true }), second = open(t, filename);
  for (const id of ['settled', 'unknown', 'unsent']) assert.equal(first.reserve(reservation(id)).reservedMicroCny, 9879552);
  second.markDispatched('settled');
  assert.equal(second.settle('settled', { promptTokens: 100, completionTokens: 3, cachedTokens: 20 }).spentMicroCny, 807);
  first.markDispatched('unknown');
  assert.throws(() => second.settle('unknown', { promptTokens: 100 }), { code: 'invalid_usage' });
  const unknown = first.get('unknown');
  assert.equal(unknown.status, 'unknown');
  assert.deepEqual(second.reserve(reservation('unknown')), unknown);
  assert.throws(() => first.markDispatched('unknown'), { code: 'request_already_dispatched' });
  assert.throws(() => second.releaseUnsent('unknown'), { code: 'already_dispatched' });
  second.releaseUnsent('unsent');
  assert.throws(() => { first.scope = 'limited'; }, TypeError);
  assert.throws(() => first.db.exec("UPDATE budget_requests SET scope='limited'"), /CHECK constraint/);
  const summary = first.summary();
  assert.equal(summary.reservedMicroCny, 9879552); assert.equal(summary.spentMicroCny, 807);
  assert.equal(summary.unknownCount, 1); assert.equal(summary.ceilingCny, null);
  assert.equal(summary.allTime.spentMicroCny, summary.spentMicroCny);
  assert.equal(summary.allTime.reservedMicroCny, summary.reservedMicroCny);
  const before = first.list(), sequence = first.store.currentSequence();
  assert.throws(() => second.upgradeAuthorization(), { code: 'web_only_no_limited_budget' });
  assert.deepEqual(first.list(), before); assert.equal(first.store.currentSequence(), sequence);
  first.close(); second.close();
  const reopened = open(t, filename);
  assert.deepEqual(reopened.get('unknown'), unknown);
  assert.deepEqual(reopened.summary(), summary);
});

test('revoked or replaced authorization blocks reserve and final dispatch but retains already sent accounting', t => {
  for (const mutation of ['delete-authority', 'replace-evidence', 'replace-mode', 'replace-format']) {
    const filename = file(t), ledger = open(t, filename, { create: true }), other = open(t, filename);
    ledger.reserve(reservation('pending')); ledger.reserve(reservation('sent')); ledger.markDispatched('sent');
    const changed = { ...webAuthorization, authorizationEvidence: 'replacement authorization' };
    if (mutation === 'delete-authority') other.db.exec('DELETE FROM records');
    if (mutation === 'replace-evidence') {
      const old = other.store.get('budget_authorizations', other.webAuthorizationId);
      other.store.save('budget_authorizations', { ...old, specification: { ...changed, scope: 'web-unlimited' } }, { expectedRevision: old.revision });
    }
    if (mutation === 'replace-mode') other.db.exec("UPDATE store_meta SET value='{}' WHERE key='web_budget_mode'");
    if (mutation === 'replace-format') other.db.exec('PRAGMA application_id=0');
    const before = ledger.list();
    assert.throws(() => ledger.reserve(reservation('next')), { code: 'budget_authorization_stale' });
    assert.throws(() => ledger.markDispatched('pending'), { code: 'budget_authorization_stale' });
    assert.deepEqual(ledger.list(), before);
    assert.equal(ledger.settle('sent', { promptTokens: 100, completionTokens: 3, cachedTokens: 20 }).spentMicroCny, 807);
    ledger.close(); other.close();
    unchangedRefusal(filename, { ...options, create: true });
    if (mutation === 'replace-evidence')
      unchangedRefusal(filename, { ...options, webAuthorization: changed, create: true }, 'web_budget_identity_conflict');
  }
  const closed = open(t, file(t), { create: true }); closed.close();
  assert.throws(() => closed.reserve(reservation('closed')), { code: 'store_closed' });
});

test('damaged or unfinished existing web files are refused without reset or repair', t => {
  for (const sql of [
    'DROP TABLE records',
    "DELETE FROM store_meta WHERE key='web_budget_mode'",
    "UPDATE store_meta SET value='0' WHERE key='mutation_sequence'",
    "UPDATE store_meta SET value='99' WHERE key='schema_version'",
    "UPDATE records SET revision=2",
    "UPDATE records SET body=json_set(body,'$.updatedSequence',99)",
    "CREATE TABLE budget_settings (ceiling_micro INTEGER)",
    "CREATE TRIGGER unwanted AFTER INSERT ON budget_requests BEGIN DELETE FROM budget_requests; END",
    'PRAGMA journal_mode=WAL',
    'PRAGMA application_id=0',
    'PRAGMA application_id=1234'
  ]) {
    const filename = file(t), ledger = open(t, filename, { create: true }); ledger.close();
    const db = new DatabaseSync(filename); db.exec(sql); db.close();
    unchangedRefusal(filename, { ...options, create: true });
  }
  for (const bytes of ['', 'not a database']) {
    const filename = file(t); writeFileSync(filename, bytes);
    unchangedRefusal(filename, { ...options, create: true }, 'unsupported_ledger_schema');
  }
  const filename = file(t), ledger = open(t, filename, { create: true }); ledger.close();
  writeFileSync(filename + '-journal', 'unfinished synthetic journal');
  unchangedRefusal(filename, { ...options, create: true }, 'unsupported_ledger_schema');
});

test('a format marker alone cannot establish web authorization or a compatible schema', t => {
  const filename = file(t), db = new DatabaseSync(filename);
  db.exec('PRAGMA application_id=1096238641; CREATE TABLE unrelated(original TEXT)');
  db.close();
  unchangedRefusal(filename, { ...options, create: true }, 'unsupported_ledger_schema');
});

async function interruptedCreator() {
  const { Store } = await import(process.argv[2]);
  const { BudgetLedger } = await import(process.argv[2].replace('/store.mjs', '/budget.mjs'));
  Store.prototype.save = function () {
    if (process.argv[4] === 'spill') {
      this.db.exec('PRAGMA cache_size=1');
      const insert = this.db.prepare("INSERT INTO budget_requests VALUES(?,?,'reserved',1,0,?,'web-unlimited')");
      for (let i = 0; i < 100; i++)
        insert.run('partial-' + i, 'hash', JSON.stringify({ pad: 'x'.repeat(8192) }));
    }
    process.exit(0);
  };
  new BudgetLedger(process.argv[1], JSON.parse(process.argv[3]));
}
test('creation crash never establishes authorization; spilled format is only a conservative refusal marker', t => {
  for (const stage of ['before-spill', 'spill']) {
    const filename = file(t);
    execFileSync(process.execPath, ['-e', '(' + interruptedCreator.toString() + ')()', filename,
      new URL('../src/store.mjs', import.meta.url).href, JSON.stringify({ ...options, create: true }), stage]);
    const bytes = readFileSync(filename), marker = bytes.length >= 72 ? bytes.readUInt32BE(68) : 0;
    assert.ok(marker === 0 || marker === 0x41574631);
    if (stage === 'before-spill') assert.equal(marker, 0);
    if (stage === 'spill') {
      assert.ok(bytes.length > 0, 'forced dirty-page spill wrote the incomplete main file');
      assert.equal(readFileSync(filename + '-journal').subarray(0, 8).toString('hex'), 'd9d505f920a163d7');
    }
    t.diagnostic('Initial creation ' + stage + ': main bytes=' + bytes.length + ', application_id=' + marker);
    if (marker === 0x41574631) {
      const before = snapshot(filename);
      assert.throws(() => new Store(filename), { code: 'invalid_store_mode' });
      assert.deepEqual(snapshot(filename), before);
    }
    unchangedRefusal(filename, { ...options, create: true }, 'unsupported_ledger_schema');
    const recovered = file(t);
    for (const suffix of ['', '-journal'])
      if (existsSync(filename + suffix)) copyFileSync(filename + suffix, recovered + suffix);
    const recovery = new DatabaseSync(recovered);
    assert.deepEqual(recovery.prepare('SELECT name FROM sqlite_schema').all(), []);
    assert.equal(recovery.prepare('PRAGMA application_id').get().application_id, 0);
    recovery.close();
    unchangedRefusal(recovered, { ...options, create: true }, 'unsupported_ledger_schema');
  }
});

function interruptedWriter() {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(process.argv[1]);
  db.exec('PRAGMA cache_size=1; BEGIN IMMEDIATE');
  db.exec('UPDATE budget_requests SET reserved_micro=0');
  const insert = db.prepare("INSERT INTO budget_requests VALUES(?,?,'reserved',1,0,?,'web-unlimited')");
  for (let i = 0; i < 100; i++)
    insert.run('partial-' + i, 'hash', JSON.stringify({ pad: 'x'.repeat(8192) }));
  // Deliberately terminate this isolated fixture writer without COMMIT or close.
  process.exit(0);
}
test('a real hot journal remains untouched on refusal; SQLite recovers an owned private copy', t => {
  const filename = file(t), ledger = open(t, filename, { create: true });
  ledger.reserve(reservation('unknown')); ledger.markDispatched('unknown'); ledger.markUnknown('unknown');
  const unknown = ledger.get('unknown'); ledger.close();
  execFileSync(process.execPath, ['-e', '(' + interruptedWriter.toString() + ')()', filename]);
  assert.equal(readFileSync(filename + '-journal').subarray(0, 8).toString('hex'), 'd9d505f920a163d7');
  const before = snapshot(filename);
  const readonly = new DatabaseSync(filename, { readOnly: true });
  try {
    assert.throws(() => readonly.prepare('SELECT * FROM budget_requests').all(), error => error.errcode === 776);
  } finally { readonly.close(); }
  assert.deepEqual(snapshot(filename), before);
  unchangedRefusal(filename, options, 'unsupported_ledger_schema');
  unchangedRefusal(filename, { ...options, create: true }, 'unsupported_ledger_schema');

  // The child has exited: no writer can change this synthetic file set.
  // Preserve the original and let SQLite, not application repair code, roll back
  // the complete database + journal copy in a separate temporary directory.
  const recovered = file(t);
  copyFileSync(filename, recovered); copyFileSync(filename + '-journal', recovered + '-journal');
  const recovery = new DatabaseSync(recovered);
  assert.equal(recovery.prepare('SELECT COUNT(*) AS total FROM budget_requests').get().total, 1);
  recovery.close();
  const reopened = open(t, recovered);
  assert.deepEqual(reopened.get('unknown'), unknown);
  assert.equal(reopened.summary().reservedMicroCny, 9879552);
  assert.deepEqual(snapshot(filename), before);
});

async function creatorWorker() {
  const { parentPort, workerData } = require('node:worker_threads');
  const { BudgetLedger } = await import(workerData.module);
  parentPort.postMessage('ready');
  Atomics.wait(new Int32Array(workerData.gate), 0, 0);
  try {
    const ledger = new BudgetLedger(workerData.filename, workerData.options);
    ledger.reserve(workerData.reservation); ledger.close();
    parentPort.postMessage({ success: true, ref: workerData.options.webAuthorization.authorizationRef });
  } catch (error) { parentPort.postMessage({ success: false, code: error.code, message: error.message }); }
}
test('racing creators cannot overwrite or adopt the other authorization', async t => {
  const filename = file(t), gate = new SharedArrayBuffer(4);
  const contenders = ['creator-a', 'creator-b'].map(ref => {
    let readyResolve;
    const ready = new Promise(resolve => { readyResolve = resolve; });
    const worker = new Worker('(' + creatorWorker.toString() + ')()', { eval: true,
      workerData: { module: new URL('../src/budget.mjs', import.meta.url).href, filename, gate,
        options: { ...options, create: true, webAuthorization: { ...webAuthorization, authorizationRef: ref } },
        reservation: reservation(ref) } });
    const result = new Promise((resolve, reject) => {
      worker.on('message', value => { if (value === 'ready') readyResolve(); else resolve(value); });
      worker.on('error', reject);
      worker.on('exit', code => { if (code) reject(new Error('Worker exit ' + code)); });
    });
    t.after(() => worker.terminate());
    return { ready, result };
  });
  await Promise.all(contenders.map(item => item.ready));
  Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0);
  const results = await Promise.all(contenders.map(item => item.result));
  const winners = results.filter(result => result.success);
  assert.equal(winners.length, 1, JSON.stringify(results));
  const winner = winners[0].ref;
  const ledger = open(t, filename, { webAuthorization: { ...webAuthorization, authorizationRef: winner } });
  assert.equal(ledger.summary().requests, 1); assert.equal(ledger.list()[0].requestId, winner);
  assert.equal(ledger.store.currentSequence(), 1);
  ledger.close();
  unchangedRefusal(filename, { ...options, create: true,
    webAuthorization: { ...webAuthorization, authorizationRef: winner === 'creator-a' ? 'creator-b' : 'creator-a' } });
});
