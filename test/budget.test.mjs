import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetLedger } from '../src/budget.mjs';
import { Store } from '../src/store.mjs';

const prices = { input: 9, output: 27, cachedInput: 0.3 };
const authorization = { ceilingCny: 150, authorizationRef: 'fixture-150' };
const reservation = id => ({ requestId: id, bodyHash: `body-${id}`, model: 'deepseek-v4-pro',
  inputTokenCeiling: 1048576, maxOutputTokens: 16384, prices });
function file(t) {
  const directory = mkdtempSync(join(tmpdir(), 'arcfold-budget-fixture-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'budget.sqlite');
}
function ledger(t, filename = file(t), extra = {}) {
  const value = new BudgetLedger(filename, { ...authorization, create: true, ...extra });
  t.after(() => value.close()); return value;
}

test('missing canonical ledger is rejected without creating a fresh balance', t => {
  const filename = file(t);
  assert.throws(() => new BudgetLedger(filename, authorization), { code: 'ledger_missing' });
  assert.equal(existsSync(filename), false);
});

test('legacy sequence and every old row remain byte-identical after opening and reusing authority', t => {
  const filename = file(t), db = new DatabaseSync(filename);
  db.exec(`CREATE TABLE records(kind TEXT,id TEXT,revision INTEGER,created_at TEXT,updated_at TEXT,body TEXT,PRIMARY KEY(kind,id));
    CREATE TABLE store_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO store_meta VALUES('schema_version','2'),('mutation_sequence','4');
    CREATE TABLE budget_settings(singleton INTEGER PRIMARY KEY,schema_version INTEGER,ceiling_micro INTEGER,authorization_ref TEXT,created_at TEXT);
    INSERT INTO budget_settings VALUES(1,1,150000000,'fixture-150','2026-11-01T00:00:00Z');
    CREATE TABLE budget_requests(id TEXT PRIMARY KEY,body_hash TEXT,status TEXT,reserved_micro INTEGER,spent_micro INTEGER,body TEXT,scope TEXT DEFAULT 'limited');`);
  for (let i = 1; i <= 4; i++) db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?)').run('budget_authorizations', `old-${i}`, 1, 'old', 'old',
    JSON.stringify({ id: `old-${i}`, revision: 1, createdAt: 'old', updatedAt: 'old', createdSequence: i,
      updatedSequence: i, sequenceEstablishedBy: 'native', specification: { historical: i } }));
  for (let i = 1; i <= 6; i++) db.prepare('INSERT INTO budget_requests VALUES(?,?,?,?,?,?,?)').run(`old-unknown-${i}`, `hash-${i}`, 'unknown', i, 0,
    JSON.stringify({ requestId: `old-unknown-${i}`, status: 'unknown', originalEvidence: `verbatim-${i}` }), 'limited');
  const oldRows = db.prepare('SELECT * FROM budget_requests ORDER BY id').all();
  const oldRecords = db.prepare('SELECT * FROM records ORDER BY id').all(); db.close();
  const value = new BudgetLedger(filename, authorization); t.after(() => value.close());
  assert.equal(value.store.currentSequence(), 4);
  assert.deepEqual(value.db.prepare('SELECT * FROM budget_requests ORDER BY id').all(), oldRows);
  assert.deepEqual(value.db.prepare('SELECT * FROM records ORDER BY id').all(), oldRecords);
  assert.equal(value.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='business_meta'").get(), undefined);
  const next = value.store.save('budget_authorizations', { id: 'next-authorization', specification: { explicit: true } });
  assert.equal(next.createdSequence, 5); assert.equal(next.updatedSequence, 5); assert.equal(next.sequenceEstablishedBy, 'native');
  const reopened = new BudgetLedger(filename, authorization); t.after(() => reopened.close());
  assert.equal(reopened.store.currentSequence(), 5);
  assert.deepEqual(reopened.db.prepare('SELECT * FROM budget_requests ORDER BY id').all(), oldRows);
});

test('corrupted legacy order is rejected without repairing or creating new metadata', t => {
  const filename = file(t), original = ledger(t, filename);
  original.store.save('budget_authorizations', { id: 'old' });
  original.db.prepare("UPDATE store_meta SET value='0' WHERE key='mutation_sequence'").run();
  assert.throws(() => new BudgetLedger(filename, authorization), { code: 'invalid_sequence' });
  assert.equal(original.db.prepare("SELECT value FROM store_meta WHERE key='mutation_sequence'").get().value, '0');
  assert.equal(original.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='business_meta'").get(), undefined);
});

test('default business store retains its own schema and record shape', t => {
  const value = new Store(file(t)); t.after(() => value.close());
  const record = value.save('understandings', { id: 'business' });
  assert.equal(record.createdSequence, 1);
  assert.equal(Object.hasOwn(record, 'sequenceEstablishedBy'), false);
  assert.equal(value.db.prepare("SELECT value FROM business_meta WHERE key='schema_version'").get().value, '1');
  assert.equal(value.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='store_meta'").get(), undefined);
});

test('verified integer arithmetic, unknown reservations and dispatch gate survive reopen', t => {
  const filename = file(t), value = ledger(t, filename);
  assert.equal(value.reserve(reservation('first')).reservedMicroCny, 9879552);
  value.markDispatched('first'); value.markUnknown('first', 'incomplete');
  const before = value.get('first');
  const reopened = new BudgetLedger(filename, authorization); t.after(() => reopened.close());
  assert.deepEqual(reopened.reserve(reservation('first')), before);
  assert.throws(() => reopened.markDispatched('first'), { code: 'request_already_dispatched' });
  assert.throws(() => reopened.releaseUnsent('first'), { code: 'already_dispatched' });
  const settled = reopened.settle('first', { promptTokens: 100, completionTokens: 3, cachedTokens: 20 });
  assert.equal(settled.spentMicroCny, 807); assert.equal(settled.reservedMicroCny, 0);
  assert.deepEqual(reopened.settle('first', settled.usage), settled);
});

test('separate connections cannot overspend the same limited balance or change SQL scope', t => {
  const filename = file(t), value = ledger(t, filename, { ceilingCny: 10 });
  const other = new BudgetLedger(filename, { ...authorization, ceilingCny: 10 }); t.after(() => other.close());
  value.reserve(reservation('only-affordable'));
  assert.throws(() => other.reserve(reservation('too-much')), { code: 'budget_exceeded' });
  const web = new BudgetLedger(filename, { ...authorization, ceilingCny: 10, scope: 'web-unlimited',
    webAuthorization: { authorizationRef: 'web-fixture', authorizedAt: '2026-11-06T00:00:00Z', authorizationEvidence: 'Explicit fixture unlimited authorization.' } });
  t.after(() => web.close());
  assert.throws(() => web.reserve(reservation('only-affordable')), { code: 'budget_scope_conflict' });
  web.reserve(reservation('web')); assert.equal(web.summary().ceilingCny, null);
  assert.equal(value.summary().reservedMicroCny, 9879552);
  assert.equal(web.summary().reservedMicroCny, 9879552);
});

test('invalid authoritative usage stays unknown rather than silently exceeding bounds', t => {
  const value = ledger(t); value.reserve(reservation('invalid')); value.markDispatched('invalid');
  assert.throws(() => value.settle('invalid', { promptTokens: 1048577, completionTokens: 1, cachedTokens: 0 }), { code: 'invalid_usage' });
  assert.equal(value.get('invalid').status, 'unknown'); assert.equal(value.summary().reservedMicroCny, 9879552);
});
