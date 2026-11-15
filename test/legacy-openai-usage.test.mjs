import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OpenAIUsageLedger } from '../src/openai-usage.mjs';
import { Store } from '../src/store.mjs';

const options = { scope: 'web-openai', webAuthorization: { authorizationRef: 'fixture-explicit-openai',
  authorizedAt: '2026-11-07T00:00:00Z', authorizationEvidence: 'Only the isolated OpenAI webpage fixture is authorized.' } };
function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), 'arcfold-legacy-openai-'));
  t.after(() => rmSync(dir, { recursive: true, force: true })); return dir;
}
// Exact legacy v2 table/body shape from the original Store/OpenAIUsageLedger;
// this is synthetic, not a copy of the user's production usage.
function fixture(filename) {
  const db = new DatabaseSync(filename);
  db.exec(`CREATE TABLE records(kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL,body TEXT NOT NULL CHECK(json_valid(body)),PRIMARY KEY(kind,id));
    CREATE INDEX records_by_kind_time ON records(kind,created_at,id);
    CREATE TABLE store_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO store_meta VALUES('schema_version','2'),('mutation_sequence','39');`);
  ['settled', 'unknown', 'dispatched', 'reserved', 'released'].forEach((status, i) => {
    const id = 'legacy-' + status;
    const row = { requestId: id, specification: { bodyHash: 'original-' + i, model: 'gpt-6-astra',
      maxOutputTokens: 64, inputTokenCeiling: 1024 }, status,
      dispatchedAt: ['settled', 'unknown', 'dispatched'].includes(status) ? '2026-11-01T00:00:00.000Z' : null,
      usage: status === 'settled' ? { promptTokens: 11, completionTokens: 5, cachedTokens: 3 } : null,
      ...(status === 'unknown' ? { reason: 'Original interrupted request, outcome unknown.' } : {}),
      id, revision: i + 2, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z',
      createdSequence: i + 1, updatedSequence: 31 + i, sequenceEstablishedBy: i === 0 ? 'legacy_snapshot' : 'native' };
    db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?)').run('openai_requests', id, row.revision,
      row.createdAt, row.updatedAt, JSON.stringify(row, null, 2));
  });
  db.close();
}
const originalRows = db => db.prepare("SELECT rowid,* FROM records WHERE kind='openai_requests' ORDER BY rowid").all();

test('legacy rows, byte bodies, revisions, ordering, unknowns and tokens summary remain unchanged', t => {
  const dir = directory(t), source = join(dir, 'sealed.sqlite'), filename = join(dir, 'isolated.sqlite');
  fixture(source); const sealedBytes = readFileSync(source); copyFileSync(source, filename);
  const db = new DatabaseSync(filename), before = originalRows(db); db.close();
  const value = new OpenAIUsageLedger(filename, options); t.after(() => value.close());
  assert.deepEqual(originalRows(value.db), before);
  assert.equal(value.store.currentSequence(), 40, 'only the explicit new authorization advances the original counter');
  assert.deepEqual(value.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(row => row.name),
    ['records', 'store_meta']);
  assert.deepEqual(value.summary(), { provider: 'openai', accounting: 'tokens_only', requests: 5,
    unknownCount: 1, pendingCount: 2, promptTokens: 11, completionTokens: 5, cachedTokens: 3 });
  for (const old of value.list()) {
    assert.equal(old.scope, 'legacy'); assert.equal(old.metadata, null);
    assert.equal(old.bodyHash, old.specification.bodyHash);
    for (const act of [() => value.assertScope(old.requestId), () => value.markDispatched(old.requestId),
      () => value.markUnknown(old.requestId), () => value.releaseUnsent(old.requestId),
      () => value.settle(old.requestId, { promptTokens: 11, completionTokens: 5, cachedTokens: 3 }),
      () => value.reserve({ requestId: old.requestId, ...old.specification,
        metadata: { transport: { version: 'test', ownerId: 'new-owner', artifactKey: old.requestId } } })])
      assert.throws(act, { code: 'usage_scope_conflict' });
  }
  assert.equal(value.store.currentSequence(), 40);
  const request = value.reserve({ requestId: 'new-dsh-step', bodyHash: 'new-body', model: 'gpt-6-astra',
    maxOutputTokens: 64, inputTokenCeiling: 1024, metadata: { role: 'learning',
      transport: { version: 'test', ownerId: 'new-owner', artifactKey: 'new-step' } } });
  assert.equal(request.createdSequence, 42); assert.equal(request.updatedSequence, 42);
  assert.equal(value.store.get('openai_request_authorities', 'new-dsh-step').createdSequence, 41);
  value.markDispatched(request.requestId); value.markUnknown(request.requestId, 'synthetic interrupted send');
  const sequence = value.store.currentSequence(); value.close();
  const reopened = new OpenAIUsageLedger(filename, options); t.after(() => reopened.close());
  assert.equal(reopened.store.currentSequence(), sequence);
  assert.deepEqual(originalRows(reopened.db).slice(0, before.length), before);
  assert.equal(reopened.get('legacy-unknown').status, 'unknown');
  assert.equal(reopened.get('new-dsh-step').status, 'unknown');
  assert.equal(reopened.summary().unknownCount, 2);
  assert.deepEqual(readFileSync(source), sealedBytes);
});

test('records-only mode rejects unknown schemas and corrupted ordering before changing the file', t => {
  for (const corrupt of ['schema', 'sequence', 'missing-meta']) {
    const filename = join(directory(t), corrupt + '.sqlite'); fixture(filename);
    const db = new DatabaseSync(filename);
    if (corrupt === 'schema') db.exec("UPDATE store_meta SET value='1' WHERE key='schema_version'");
    if (corrupt === 'sequence') db.exec("UPDATE store_meta SET value='0' WHERE key='mutation_sequence'");
    if (corrupt === 'missing-meta') db.exec('DROP TABLE store_meta');
    db.close(); const bytes = readFileSync(filename);
    assert.throws(() => new OpenAIUsageLedger(filename, options),
      { code: corrupt === 'sequence' ? 'invalid_sequence' : 'unsupported_ledger_schema' });
    assert.deepEqual(readFileSync(filename), bytes);
  }
});

test('records-only access neither requires budget tables nor weakens legacy budget or default business mode', t => {
  const filename = join(directory(t), 'records.sqlite'); fixture(filename);
  const store = new Store(filename, { mode: 'legacy-records-v2' }); t.after(() => store.close());
  assert.equal(store.currentSequence(), 39);
  assert.throws(() => new Store(filename, { mode: 'legacy-ledger-v2' }), { code: 'unsupported_ledger_schema' });
  const business = new Store(join(directory(t), 'business.sqlite')); t.after(() => business.close());
  const row = business.save('understandings', { id: 'one' });
  assert.equal(row.createdSequence, 1); assert.equal(Object.hasOwn(row, 'sequenceEstablishedBy'), false);
  assert.equal(business.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='store_meta'").get(), undefined);
  assert.equal(store.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='business_meta'").get(), undefined);
});


test('web summary separates legacy usage without discarding prior web authorizations or mutating history', t => {
  const filename = join(directory(t), 'mixed.sqlite'); fixture(filename);
  const first = new OpenAIUsageLedger(filename, options); t.after(() => first.close());
  assert.equal(first.scopeSummary().requests, 0);
  const other = new OpenAIUsageLedger(filename, { ...options, webAuthorization: {
    ...options.webAuthorization, authorizationRef: 'another-explicit-web-authorization' } });
  t.after(() => other.close());
  for (const [ledger, id] of [[first, 'web-first'], [other, 'web-other']]) {
    ledger.reserve({ requestId: id, bodyHash: id, model: 'gpt-6-astra', maxOutputTokens: 64,
      inputTokenCeiling: 1024, metadata: { transport: { version: 'test', ownerId: id, artifactKey: id } } });
    ledger.markDispatched(id);
  }
  first.settle('web-first', { promptTokens: 7, completionTokens: 2, cachedTokens: 1 });
  other.markUnknown('web-other', 'No response received.');
  const before = first.db.prepare('SELECT rowid,* FROM records ORDER BY rowid').all();
  const sequence = first.store.currentSequence();
  assert.deepEqual(first.scopeSummary(), { scope: 'web-openai', provider: 'openai', accounting: 'tokens_only',
    requests: 2, unknownCount: 1, pendingCount: 0, promptTokens: 7, completionTokens: 2, cachedTokens: 1 });
  assert.deepEqual(other.scopeSummary(), first.scopeSummary());
  assert.deepEqual(first.summary(), { provider: 'openai', accounting: 'tokens_only',
    requests: 7, unknownCount: 2, pendingCount: 2, promptTokens: 18, completionTokens: 7, cachedTokens: 4 });
  assert.equal(first.store.currentSequence(), sequence);
  assert.deepEqual(first.db.prepare('SELECT rowid,* FROM records ORDER BY rowid').all(), before);
  assert.equal(first.get('legacy-unknown').status, 'unknown');
});
