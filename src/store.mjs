import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync, openSync, closeSync, readSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export class DomainError extends Error {
  constructor(code, message, status = 409, details) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = this.statusCode = status;
    if (details !== undefined) this.details = details;
  }
}

// Preserve the 3.0 JSON contract without its job, lease or execution machinery.
export function jsonClone(value) {
  const ancestors = new Set();
  function visit(item) {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || ancestors.has(item))
      throw new DomainError('invalid_record', 'Only finite, acyclic JSON values can be saved.', 400);
    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null)
      throw new DomainError('invalid_record', 'Only plain JSON objects can be saved.', 400);
    if (Reflect.ownKeys(item).some(key => typeof key === 'symbol'))
      throw new DomainError('invalid_record', 'Symbol keys cannot be saved.', 400);
    ancestors.add(item);
    if (Array.isArray(item)) {
      for (let i = 0; i < item.length; i++) {
        if (!Object.hasOwn(item, i)) throw new DomainError('invalid_record', 'Sparse arrays cannot be saved.', 400);
        visit(item[i]);
      }
    } else {
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(item))) {
        if (!Object.hasOwn(descriptor, 'value')) throw new DomainError('invalid_record', 'Accessors cannot be saved.', 400);
        visit(descriptor.value);
      }
    }
    ancestors.delete(item);
  }
  visit(value);
  return JSON.parse(JSON.stringify(value));
}

export function canonicalJson(value) {
  const item = jsonClone(value);
  function sorted(value) {
    if (Array.isArray(value)) return value.map(sorted);
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]));
    return value;
  }
  return JSON.stringify(sorted(item));
}

export function identity(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || value.includes('\0'))
    throw new DomainError('invalid_identity', `${label} must be a nonempty string of at most 512 characters.`, 400);
}

function filters(where = {}) {
  if (!where || typeof where !== 'object' || Array.isArray(where) || Object.getPrototypeOf(where) !== Object.prototype)
    throw new DomainError('invalid_filter', 'Filters must be a plain object.', 400);
  const clauses = [], parameters = [];
  for (const [field, value] of Object.entries(where)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field) ||
        (!['string', 'number', 'boolean'].includes(typeof value) && value !== null) ||
        (typeof value === 'number' && !Number.isFinite(value)))
      throw new DomainError('invalid_filter', 'Filters require safe field names and scalar values.', 400);
    clauses.push('json_extract(body,?) IS ?');
    parameters.push('$.' + field, typeof value === 'boolean' ? Number(value) : value);
  }
  return { sql: clauses.length ? ' AND ' + clauses.join(' AND ') : '', parameters };
}

const IMMUTABLE = new Set(['dsh_events', 'events', 'deliveries']);
const WEB_BUDGET_MODE = 'web-only-budget-v1';
const WEB_BUDGET_APPLICATION_ID = 0x41574631; // AWF1: format discriminator, never authorization.
const WEB_TABLES = {
  records: `CREATE TABLE records (
    kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    body TEXT NOT NULL CHECK(json_valid(body)), PRIMARY KEY(kind,id)
  )`,
  store_meta: 'CREATE TABLE store_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL)',
  budget_requests: `CREATE TABLE budget_requests (
    id TEXT PRIMARY KEY, body_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('reserved','dispatched','unknown','settled','released')),
    reserved_micro INTEGER NOT NULL CHECK(reserved_micro>=0),
    spent_micro INTEGER NOT NULL CHECK(spent_micro>=0),
    body TEXT NOT NULL CHECK(json_valid(body)),
    scope TEXT NOT NULL DEFAULT 'web-unlimited' CHECK(scope='web-unlimited')
  )`,
};
const normalizedSql = value => value.replace(/\s+/g, ' ').trim();

// Read only the application-owned format field, without opening SQLite. An
// absent/zero/different id does not prove ownership and retains old-mode behavior.
function fileApplicationId(filename) {
  const bytes = Buffer.alloc(4), descriptor = openSync(filename, 'r');
  try { return readSync(descriptor, bytes, 0, 4, 68) === 4 ? bytes.readUInt32BE(0) : null; }
  finally { closeSync(descriptor); }
}

// Pure web ledgers use rollback journaling. Refuse other/unfinished files before
// SQLite could recover a journal or create WAL sidecars while inspecting them.
export function assertWebBudgetFileFormat(filename) {
  const header = Buffer.alloc(20), descriptor = openSync(filename, 'r');
  let count;
  try { count = readSync(descriptor, header, 0, header.length, 0); }
  finally { closeSync(descriptor); }
  if (count !== 20 || header.subarray(0, 16).toString() !== 'SQLite format 3\0' ||
      header[18] !== 1 || header[19] !== 1 || fileApplicationId(filename) !== WEB_BUDGET_APPLICATION_ID)
    throw new DomainError('unsupported_ledger_schema', 'An intact, idle web-only ledger is required.', 409);
}

function assertWebFile(filename) {
  assertWebBudgetFileFormat(filename);
  if (['-journal', '-wal', '-shm'].some(suffix => existsSync(filename + suffix)))
    throw new DomainError('unsupported_ledger_schema', 'An intact, idle web-only ledger is required.', 409);
}

/** JSON business records; this store never claims or runs DSH work. */
export class Store {
  // Internal owned-recovery handoff: never a configuration bypass. Every
  // supplied connection is validated; the caller retains it on success.
  static fromWebBudgetConnection(db, { filename, webBudgetIdentity }) {
    if (!(db instanceof DatabaseSync)) throw new DomainError('invalid_connection', 'A native SQLite connection is required.');
    const store = Object.create(Store.prototype);
    Object.assign(store, { db, filename: resolve(filename), webBudget: true, legacyLedger: false,
      legacyRecords: true, metaTable: 'store_meta', closed: false, depth: 0, savepointSequence: 0 });
    const identity = jsonClone(webBudgetIdentity);
    if (!identity || Object.keys(identity).sort().join(',') !== 'id,specification' ||
        identity.specification?.scope !== 'web-unlimited')
      throw new DomainError('invalid_web_authorization', 'An explicit web budget identity is required.');
    store.webBudgetIdentity = Object.freeze({ id: identity.id, specification: Object.freeze(identity.specification) });
    const version = db.prepare('SELECT sqlite_version() AS version').get().version.split('.').map(Number);
    if (version[0] < 3 || version[0] === 3 && (version[1] < 51 || version[1] === 51 && version[2] < 3))
      throw new DomainError('unsupported_sqlite', 'Ledger accounting requires SQLite >= 3.51.3.', 500);
    store.assertWebBudgetSchema();
    return store;
  }
  constructor(filename, { mode = 'business', create = false, webBudgetIdentity } = {}) {
    if (typeof filename !== 'string' || !filename)
      throw new DomainError('invalid_path', 'A database filename is required.', 400);
    if (!['business', 'legacy-ledger-v2', 'legacy-records-v2', WEB_BUDGET_MODE].includes(mode) || typeof create !== 'boolean')
      throw new DomainError('invalid_store_mode', 'Unsupported store mode.', 400);
    this.webBudget = mode === WEB_BUDGET_MODE;
    if (this.webBudget) {
      const expected = jsonClone(webBudgetIdentity);
      if (!expected || Object.keys(expected).sort().join(',') !== 'id,specification' ||
          expected.specification?.scope !== 'web-unlimited')
        throw new DomainError('invalid_web_authorization', 'An explicit web budget identity is required.', 400);
      identity(expected.id, 'Web authorization id');
      this.webBudgetIdentity = Object.freeze({ id: expected.id, specification: Object.freeze(expected.specification) });
    }
    this.legacyLedger = mode === 'legacy-ledger-v2';
    this.legacyRecords = this.webBudget || this.legacyLedger || mode === 'legacy-records-v2';
    this.metaTable = this.legacyRecords ? 'store_meta' : 'business_meta';
    this.filename = filename === ':memory:' ? filename : resolve(filename);
    let existed = this.filename !== ':memory:' && existsSync(this.filename);
    let newWebFile = this.filename === ':memory:' && create;
    if (this.webBudget && this.filename !== ':memory:' && create) {
      mkdirSync(dirname(this.filename), { recursive: true, mode: 0o700 });
      try {
        const descriptor = openSync(this.filename, 'wx', 0o600);
        closeSync(descriptor); newWebFile = true; existed = false;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        existed = true;
      }
    }
    // A committed web format must be rejected by every other mode before any
    // SQLite handle/read can trigger recovery of the original hot journal.
    if (!this.webBudget && existed && fileApplicationId(this.filename) === WEB_BUDGET_APPLICATION_ID)
      throw new DomainError('invalid_store_mode', 'A web-only ledger requires its explicit mode and authorization.', 409);
    if (this.webBudget && existed) assertWebFile(this.filename);
    if (this.legacyRecords && !existed && !create)
      throw new DomainError('ledger_missing', 'An existing authorized ledger is required.', 409);
    if (this.filename !== ':memory:') mkdirSync(dirname(this.filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.filename);
    this.closed = false;
    this.depth = 0;
    this.savepointSequence = 0;
    try {
      if (this.webBudget) {
        this.db.exec('PRAGMA busy_timeout=30000; PRAGMA synchronous=FULL');
        const version = this.db.prepare('SELECT sqlite_version() AS version').get().version.split('.').map(Number);
        if (version[0] < 3 || version[0] === 3 && (version[1] < 51 || version[1] === 51 && version[2] < 3))
          throw new DomainError('unsupported_sqlite', 'Ledger accounting requires SQLite >= 3.51.3.', 500);
        this.transaction(() => {
          if (newWebFile) {
            if (this.db.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get())
              throw new DomainError('unsupported_ledger_schema', 'The exclusively created file must be empty.', 409);
            this.db.exec('PRAGMA main.application_id=' + WEB_BUDGET_APPLICATION_ID);
            for (const sql of Object.values(WEB_TABLES)) this.db.exec(sql);
            this.db.exec("CREATE INDEX records_by_kind_time ON records(kind,created_at,id); INSERT INTO store_meta VALUES ('schema_version','2'),('mutation_sequence','0')");
            this.db.prepare('INSERT INTO store_meta VALUES (?,?)').run('web_budget_mode',
              canonicalJson({ mode: WEB_BUDGET_MODE, authorization: this.webBudgetIdentity }));
            this.save('budget_authorizations', { ...this.webBudgetIdentity, appliedAt: new Date().toISOString() });
          }
          this.assertWebBudgetSchema();
        });
        return;
      }
      // Other Store modes must not mutate a separately authorized web ledger.
      if (this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='store_meta'").get() &&
          this.db.prepare("SELECT 1 FROM store_meta WHERE key='web_budget_mode'").get())
        throw new DomainError('invalid_store_mode', 'A web-only ledger requires its explicit mode and authorization.', 409);
      // Validate before any schema or journal write. Never re-establish old order
      // from rowid, and never create business_meta beside the legacy counter.
      if (this.legacyRecords && existed) {
        for (const table of ['records', 'store_meta', ...(this.legacyLedger ? ['budget_settings', 'budget_requests'] : [])]) {
          if (!this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table))
            throw new DomainError('unsupported_ledger_schema', 'The existing ledger is incomplete.', 409);
        }
        if (this.db.prepare("SELECT value FROM store_meta WHERE key='schema_version'").get()?.value !== '2')
          throw new DomainError('unsupported_ledger_schema', 'Only the established v2 ledger is supported.', 409);
        const sequence = this.currentSequence();
        for (const row of this.db.prepare('SELECT body FROM records').all()) {
          const value = JSON.parse(row.body);
          for (const field of ['createdSequence', 'updatedSequence']) {
            if (!Number.isSafeInteger(value[field]) || value[field] < 1 || value[field] > sequence)
              throw new DomainError('invalid_sequence', 'Existing records exceed the established ledger order.', 409);
          }
          if (value.createdSequence > value.updatedSequence)
            throw new DomainError('invalid_sequence', 'Existing record order is inconsistent.', 409);
        }
      }
      if (this.legacyRecords) {
        const version = this.db.prepare('SELECT sqlite_version() AS version').get().version.split('.').map(Number);
        if (version[0] < 3 || version[0] === 3 && (version[1] < 51 || version[1] === 51 && version[2] < 3))
          throw new DomainError('unsupported_sqlite', 'Ledger accounting requires SQLite >= 3.51.3.', 500);
      }
      this.db.exec(`
        PRAGMA busy_timeout=30000;
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS records (
          kind TEXT NOT NULL, id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK(revision > 0),
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          body TEXT NOT NULL CHECK(json_valid(body)), PRIMARY KEY(kind,id)
        );
        CREATE INDEX IF NOT EXISTS records_by_kind_time ON records(kind,created_at,id);
        CREATE TABLE IF NOT EXISTS ${this.metaTable} (key TEXT PRIMARY KEY,value TEXT NOT NULL);
        INSERT OR IGNORE INTO ${this.metaTable} VALUES ('schema_version','${this.legacyRecords ? '2' : '1'}');
        INSERT OR IGNORE INTO ${this.metaTable} VALUES ('mutation_sequence','0');
      `);
      if (this.db.prepare(`SELECT value FROM ${this.metaTable} WHERE key='schema_version'`).get().value !== (this.legacyRecords ? '2' : '1'))
        throw new DomainError('unsupported_store_schema', 'Unsupported business store schema.', 500);
      this.currentSequence();
      if (this.filename !== ':memory:') chmodSync(this.filename, 0o600);
    } catch (error) {
      this.db.close(); this.closed = true; throw error;
    }
  }

  assertWebBudgetIdentity() {
    this.assertOpen();
    const expected = this.webBudgetIdentity;
    if (this.db.prepare('PRAGMA main.application_id').get().application_id !== WEB_BUDGET_APPLICATION_ID)
      throw new DomainError('web_budget_identity_conflict', 'The web ledger format does not match.', 409);
    const marker = this.db.prepare("SELECT value FROM store_meta WHERE key='web_budget_mode'").get()?.value;
    if (!expected || marker !== canonicalJson({ mode: WEB_BUDGET_MODE, authorization: expected }))
      throw new DomainError('web_budget_identity_conflict', 'The declared web ledger identity does not match.', 409);
    const authority = this.get('budget_authorizations', expected.id);
    if (!authority || canonicalJson(authority.specification) !== canonicalJson(expected.specification))
      throw new DomainError('web_authorization_conflict', 'The explicit web authorization does not match.', 409);
  }

  assertWebBudgetSchema() {
    const schema = this.db.prepare("SELECT name,sql FROM sqlite_schema WHERE type IN ('table','view','trigger') ORDER BY name").all();
    if (schema.length !== Object.keys(WEB_TABLES).length ||
        schema.some(row => !WEB_TABLES[row.name] || normalizedSql(row.sql) !== normalizedSql(WEB_TABLES[row.name])) ||
        this.db.prepare("SELECT value FROM store_meta WHERE key='schema_version'").get()?.value !== '2')
      throw new DomainError('unsupported_ledger_schema', 'Only the explicit web-only ledger schema is supported.', 409);
    this.assertWebBudgetIdentity();
    const sequence = this.currentSequence();
    for (const row of this.db.prepare('SELECT kind,id,revision,body FROM records').all()) {
      const value = JSON.parse(row.body);
      if (row.kind !== 'budget_authorizations' || row.id !== this.webBudgetIdentity.id ||
          value.id !== row.id || value.revision !== row.revision)
        throw new DomainError('unsupported_ledger_schema', 'Unexpected web authorization records.', 409);
      if (['createdSequence', 'updatedSequence'].some(field =>
        !Number.isSafeInteger(value[field]) || value[field] < 1 || value[field] > sequence) ||
        value.createdSequence > value.updatedSequence)
        throw new DomainError('invalid_sequence', 'Existing authorization order is inconsistent.', 409);
    }
  }

  assertOpen() {
    if (this.closed) throw new DomainError('store_closed', 'The store is closed.', 503);
  }

  currentSequence() {
    this.assertOpen();
    const raw = this.db.prepare(`SELECT value FROM ${this.metaTable} WHERE key='mutation_sequence'`).get()?.value;
    const value = Number(raw);
    if (raw === undefined || !Number.isSafeInteger(value) || value < 0)
      throw new DomainError('invalid_sequence', 'The mutation sequence is invalid.', 500);
    return value;
  }

  transaction(fn) {
    this.assertOpen();
    if (typeof fn !== 'function' || fn.constructor?.name === 'AsyncFunction')
      throw new DomainError('async_transaction', 'Transactions require a synchronous callback.', 400);
    const nested = this.depth > 0, savepoint = `business_sp_${++this.savepointSequence}`;
    this.db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    this.depth++;
    try {
      const result = fn();
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).catch(() => {});
        throw new DomainError('async_transaction', 'Transactions cannot return a Promise.', 400);
      }
      this.db.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec(nested ? `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}` : 'ROLLBACK'); }
      catch (rollbackError) { error.rollbackError = rollbackError.message; }
      throw error;
    } finally { this.depth--; }
  }

  get(kind, id) {
    this.assertOpen(); identity(kind, 'Record kind'); identity(id, 'Record id');
    const row = this.db.prepare('SELECT body FROM records WHERE kind=? AND id=?').get(kind, id);
    return row ? JSON.parse(row.body) : null;
  }

  list(kind, { limit = 1000, offset = 0, order = 'asc', where = {} } = {}) {
    this.assertOpen(); identity(kind, 'Record kind');
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 100000 ||
        !Number.isSafeInteger(offset) || offset < 0 || !['asc', 'desc'].includes(order))
      throw new DomainError('invalid_pagination', 'Invalid offset, limit or ordering.', 400);
    const filter = filters(where), direction = order === 'asc' ? 'ASC' : 'DESC';
    return this.db.prepare(`SELECT body FROM records WHERE kind=?${filter.sql}
      ORDER BY rowid ${direction} LIMIT ? OFFSET ?`)
      .all(kind, ...filter.parameters, limit, offset).map(row => JSON.parse(row.body));
  }

  listAll(kind, { where = {}, maxRecords = 100000 } = {}) {
    identity(kind, 'Record kind');
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 100000)
      throw new DomainError('invalid_limit', 'Full scans allow 1 to 100000 records.', 400);
    return this.transaction(() => {
      const filter = filters(where);
      const count = this.db.prepare(`SELECT COUNT(*) AS total FROM records WHERE kind=?${filter.sql}`)
        .get(kind, ...filter.parameters).total;
      if (count > maxRecords)
        throw new DomainError('record_scan_capacity', 'No partial result was returned.', 409, { kind, count, maxRecords });
      return this.list(kind, { where, limit: count });
    });
  }

  save(kind, record, { expectedRevision = null } = {}) {
    this.assertOpen(); identity(kind, 'Record kind');
    const copy = jsonClone(record);
    if (!copy || typeof copy !== 'object' || Array.isArray(copy))
      throw new DomainError('invalid_record', 'A record must be a plain object.', 400);
    identity(copy.id, 'Record id');
    if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1))
      throw new DomainError('invalid_revision', 'An explicit positive revision is required.', 400);
    return this.transaction(() => {
      const existing = this.get(kind, copy.id);
      if (existing && IMMUTABLE.has(kind))
        throw new DomainError('immutable_record', 'Original sources and delivery references cannot be rewritten.');
      if ((expectedRevision === null && existing) ||
          (expectedRevision !== null && existing?.revision !== expectedRevision))
        throw new DomainError('revision_conflict', 'Record changed or creation identity already exists.');
      const now = new Date().toISOString(), sequence = this.currentSequence() + 1;
      if (!Number.isSafeInteger(sequence)) throw new DomainError('sequence_exhausted', 'Mutation sequence exhausted.', 500);
      this.db.prepare(`UPDATE ${this.metaTable} SET value=? WHERE key='mutation_sequence'`).run(String(sequence));
      const saved = { ...copy, revision: (existing?.revision ?? 0) + 1,
        createdAt: existing?.createdAt ?? now, updatedAt: now,
        createdSequence: existing?.createdSequence ?? sequence, updatedSequence: sequence,
        ...(this.legacyRecords ? { sequenceEstablishedBy: existing?.sequenceEstablishedBy || 'native' } : {}) };
      if (existing) {
        const result = this.db.prepare('UPDATE records SET revision=?,updated_at=?,body=? WHERE kind=? AND id=? AND revision=?')
          .run(saved.revision, now, JSON.stringify(saved), kind, saved.id, expectedRevision);
        if (result.changes !== 1) throw new DomainError('revision_conflict', 'Record changed before save.');
      } else this.db.prepare('INSERT INTO records VALUES (?,?,?,?,?,?)')
        .run(kind, saved.id, saved.revision, saved.createdAt, saved.updatedAt, JSON.stringify(saved));
      return jsonClone(saved);
    });
  }

  close() {
    if (!this.closed) { this.db.close(); this.closed = true; }
  }
}
