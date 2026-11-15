import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, existsSync, openSync, readSync, closeSync, chmodSync, realpathSync, statSync, lstatSync, copyFileSync, writeFileSync, fsyncSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { SCHEMA, SCHEMA_VERSION, IMMUTABLE_KINDS, canonicalJson, jsonClone, digest, fail, text, integer, shape, validateRecord } from './contracts.mjs';
const APPLICATION_ID = 0x41544633;
const TABLES = [
  "CREATE TABLE schema_meta (format TEXT PRIMARY KEY,version INTEGER NOT NULL,user_id TEXT NOT NULL)",
  "CREATE TABLE migrations (version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)",
  "CREATE TABLE records (kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,body TEXT NOT NULL CHECK(json_valid(body)),PRIMARY KEY(kind,id))",
  "CREATE UNIQUE INDEX turn_native_identity ON records(json_extract(body,'$.sessionId'),json_extract(body,'$.nativeTurn')) WHERE kind='tree_turns'",
  "CREATE UNIQUE INDEX hook_run_identity ON records(json_extract(body,'$.eventKey'),json_extract(body,'$.hookId'),json_extract(body,'$.version')) WHERE kind='tree_hook_runs'",
  "CREATE UNIQUE INDEX learning_node_identity ON records(json_extract(body,'$.nodeId')) WHERE kind='tree_learning_sessions'",
];
const schemaHash = digest(TABLES);
export const recordKey = (kind, id) => `${kind}:${id}`;
function inventory(filename) {
  return ['', '-journal'].map(suffix => {
    const path = filename + suffix; if (!existsSync(path)) return { suffix, missing: true };
    const before = lstatSync(path); if (!before.isFile()) fail('RECOVERY_PATH', 'Recovery source must be a regular file');
    const hash = createHash('sha256'), bytes = Buffer.alloc(65536), fd = openSync(path, 'r'); let size;
    try { while ((size = readSync(fd, bytes, 0, bytes.length, null))) hash.update(bytes.subarray(0, size)); } finally { closeSync(fd); }
    const after = lstatSync(path);
    if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail('RECOVERY_BUSY', 'Database changed during recovery inspection');
    return { suffix, sha256: hash.digest('hex'), size: after.size, dev: after.dev, ino: after.ino, mtimeMs: after.mtimeMs };
  });
}
function durableJson(filename, data) {
  const fd = openSync(filename, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(data, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
}
const recordsHash = db => digest(db.prepare('SELECT kind,id,revision,body FROM records ORDER BY kind,id').all().map(r => ({ ...r })));

export class TreeRepository {
  #db; #depth = 0; #changes = new Map(); #closed = false; #nodeIndexes = new Map();
  constructor({ treeFilename, userId, legacyFilename, now = () => new Date().toISOString() }) {
    text(userId, 'userId', 512); text(treeFilename, 'treeFilename', 4096);
    if (treeFilename !== ':memory:' && !treeFilename.startsWith('/')) fail('DATABASE_PATH', 'Explicit absolute treeFilename required');
    this.filename = treeFilename; this.userId = userId; this.now = now; this.metaId = digest(['tree_meta', userId]);
    if (legacyFilename && treeFilename !== ':memory:') {
      if (resolve(legacyFilename) === resolve(treeFilename) || existsSync(treeFilename) && existsSync(legacyFilename) &&
        (realpathSync(treeFilename) === realpathSync(legacyFilename) || statSync(treeFilename).ino === statSync(legacyFilename).ino && statSync(treeFilename).dev === statSync(legacyFilename).dev))
        fail('LEGACY_DATABASE', 'New tree database must not alias the old database');
    }
    const existing = treeFilename !== ':memory:' && existsSync(treeFilename);
    if (existing) {
      const header = Buffer.alloc(100), fd = openSync(treeFilename, 'r'); let bytes;
      try { bytes = readSync(fd, header, 0, 100, 0); } finally { closeSync(fd); }
      if (bytes < 100 || header.subarray(0, 16).toString() !== 'SQLite format 3\0' || header.readUInt32BE(68) !== APPLICATION_ID || header.readUInt32BE(60) !== SCHEMA_VERSION || header[18] !== 1 || header[19] !== 1)
        fail('UNKNOWN_SCHEMA', 'Existing file is not an owned goal-tree database');
      const inspection = new DatabaseSync(treeFilename, { readOnly: true });
      let hotJournal = false;
      try { inspection.exec('PRAGMA busy_timeout=10000'); this.#inspect(inspection); }
      catch (e) { if (e.errcode === 776) hotJournal = true; else throw e; }
      finally { inspection.close(); }
      if (hotJournal) this.recovery = this.#inspectRecoveryCopy();
    } else if (treeFilename !== ':memory:') {
      mkdirSync(dirname(treeFilename), { recursive: true, mode: 0o700 });
      closeSync(openSync(treeFilename, 'wx', 0o600));
    }
    this.#db = new DatabaseSync(treeFilename);
    try {
      this.#db.exec('PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;');
      if (!existing) this.transaction(() => {
        this.#db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION}; ${TABLES.join(';')};`);
        this.#db.prepare('INSERT INTO schema_meta VALUES (?,?,?)').run(SCHEMA, SCHEMA_VERSION, userId);
        this.#db.prepare('INSERT INTO migrations VALUES (?,?,?)').run(1, schemaHash, this.now());
        const root = randomUUID();
        this.save('tree_nodes', { id: root, parentId: null, name: '我', status: 'active', statusOrigin: 'user', sourceRefs: [], lastOwnTurnAt: null, lastSummaryWatermark: null });
        this.save('tree_meta', { id: this.metaId, schemaVersion: SCHEMA_VERSION, userId, rootNodeId: root, treeRevision: 1, lastEventOrdinal: 0 });
      });
      this.#inspect(this.#db); this.assertTree();
      if (this.recovery) {
        if (recordsHash(this.#db) !== this.recovery.recordsHash) fail('RECOVERY_CHANGED', 'Recovered original differs from inspected copy; stop and inspect');
        durableJson(join(this.recovery.directory, 'completed.json'), { recordsHash: this.recovery.recordsHash, at: this.now() });
      }
      if (treeFilename !== ':memory:') chmodSync(treeFilename, 0o600);
    } catch (e) { this.#db.close(); throw e; }
  }
  #inspectRecoveryCopy() {
    if (['-wal', '-shm'].some(s => existsSync(this.filename + s))) fail('UNKNOWN_SCHEMA', 'Unexpected journal mode');
    const original = inventory(this.filename), directory = join(dirname(this.filename), `.tree-recovery-${randomUUID()}`), working = join(directory, 'working.sqlite');
    mkdirSync(directory, { mode: 0o700 }); durableJson(join(directory, 'original.json'), { userId: this.userId, files: original });
    for (const file of original.filter(f => !f.missing)) { copyFileSync(this.filename + file.suffix, working + file.suffix); chmodSync(working + file.suffix, 0o600); }
    if (canonicalJson(original) !== canonicalJson(inventory(this.filename))) fail('RECOVERY_BUSY', 'Original changed while copying');
    const copied = inventory(working);
    for (const file of original) { const copy = copied.find(f => f.suffix === file.suffix); if (file.sha256 !== copy.sha256 || file.missing !== copy.missing) fail('RECOVERY_COPY', 'Copy differs from original bytes'); }
    const inspection = new DatabaseSync(working); let hash;
    try {
      inspection.exec('PRAGMA synchronous=FULL; PRAGMA busy_timeout=10000'); this.#inspect(inspection);
      if (inspection.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') fail('RECOVERY_CORRUPT', 'Recovered copy failed integrity check');
      hash = recordsHash(inspection);
    } finally { inspection.close(); }
    durableJson(join(directory, 'validated.json'), { recordsHash: hash, at: this.now() });
    if (canonicalJson(original) !== canonicalJson(inventory(this.filename))) fail('RECOVERY_BUSY', 'Original changed after copy validation');
    return { directory, recordsHash: hash };
  }
  #inspect(db) {
    const schema = db.prepare('SELECT * FROM schema_meta').all(), migrations = db.prepare('SELECT * FROM migrations ORDER BY version').all();
    if (db.prepare('PRAGMA user_version').get().user_version !== SCHEMA_VERSION || schema.length !== 1 || schema[0].format !== SCHEMA ||
        schema[0].version !== SCHEMA_VERSION || schema[0].user_id !== this.userId || migrations.length !== 1 || migrations[0].version !== 1 ||
        migrations[0].checksum !== schemaHash) fail('UNKNOWN_SCHEMA', 'Unknown schema, owner, or incomplete migration history');
    const sql = db.prepare('SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL').all().map(r => r.sql).sort();
    if (canonicalJson(sql) !== canonicalJson([...TABLES].sort())) fail('UNKNOWN_SCHEMA', 'Unexpected schema definition');
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(r => r.name);
    if (canonicalJson(tables) !== canonicalJson(['migrations', 'records', 'schema_meta'])) fail('UNKNOWN_SCHEMA', 'Unexpected database tables');
    const indexes = db.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND sql IS NOT NULL ORDER BY name").all().map(r => r.name);
    if (canonicalJson(indexes) !== canonicalJson(['hook_run_identity', 'learning_node_identity', 'turn_native_identity'])) fail('UNKNOWN_SCHEMA', 'Incomplete uniqueness constraints');
  }
  transaction(fn) {
    if (this.#closed) fail('STORE_CLOSED', 'Tree repository is closed');
    if (typeof fn !== 'function' || fn.constructor.name === 'AsyncFunction') fail('ASYNC_TRANSACTION', 'Transactions must be synchronous');
    const nested = this.#depth > 0, name = `tree_sp_${this.#depth}`, changes = new Map(this.#changes);
    this.#db.exec(nested ? `SAVEPOINT ${name}` : 'BEGIN IMMEDIATE'); this.#depth++;
    try {
      const result = fn();
      if (result?.then) { Promise.resolve(result).catch(() => {}); fail('ASYNC_TRANSACTION', 'No model, file-copy or network operation inside transactions'); }
      this.#db.exec(nested ? `RELEASE ${name}` : 'COMMIT'); return result;
    } catch (e) { this.#db.exec(nested ? `ROLLBACK TO ${name}; RELEASE ${name}` : 'ROLLBACK'); this.#changes = changes; this.#nodeIndexes.clear(); throw e; }
    finally { this.#depth--; }
  }
  get(kind, id) { const row = this.#db.prepare('SELECT body FROM records WHERE kind=? AND id=?').get(kind, id); return row ? JSON.parse(row.body) : null; }
  list(kind, predicate = () => true) { return this.#db.prepare('SELECT body FROM records WHERE kind=? ORDER BY created_at,id').all(kind).map(r => JSON.parse(r.body)).filter(predicate); }
  listByNodeIds(kind, nodeIds, predicate = () => true) {
    if (!Array.isArray(nodeIds) || nodeIds.some(id => typeof id !== 'string')) fail('INVALID_FIELD', 'Node ids must be strings');
    const ids = [...new Set(nodeIds)];
    if (!ids.length) return [];
    // This derived in-memory index avoids changing the on-disk schema. Own
    // writes maintain it, rollback clears it, and other connections invalidate
    // it via SQLite's data_version. Retry rather than return a mixed snapshot.
    for (let attempt = 0; attempt < 3; attempt++) {
      const version = this.#db.prepare('PRAGMA data_version').get().data_version;
      let index = this.#nodeIndexes.get(kind);
      if (!index || index.version !== version) {
        const nodes = new Map();
        for (const row of this.#db.prepare("SELECT id,json_extract(body,'$.nodeId') AS node_id FROM records WHERE kind=?").all(kind)) {
          if (typeof row.node_id !== 'string') continue;
          if (!nodes.has(row.node_id)) nodes.set(row.node_id, new Set());
          nodes.get(row.node_id).add(row.id);
        }
        index = { version, nodes };
        this.#nodeIndexes.set(kind, index);
      }
      const selected = [...new Set(ids.flatMap(id => [...(index.nodes.get(id) ?? [])]))];
      const rows = [];
      for (let offset = 0; offset < selected.length; offset += 500) {
        const batch = selected.slice(offset, offset + 500);
        const placeholders = batch.map(() => '?').join(',');
        rows.push(...this.#db.prepare(`SELECT body,created_at,id FROM records WHERE kind=? AND id IN (${placeholders})`).all(kind, ...batch));
      }
      if (this.#db.prepare('PRAGMA data_version').get().data_version !== version) { this.#nodeIndexes.delete(kind); continue; }
      rows.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
      return rows.map(row => JSON.parse(row.body)).filter(predicate);
    }
    fail('QUERY_BUSY', 'Records changed repeatedly while reading; retry the read');
  }
  meta() { return this.get('tree_meta', this.metaId); }
  rootId() { return this.meta().rootNodeId; }
  save(kind, record, expectedRevision = null) {
    if (!this.#depth) fail('TRANSACTION_REQUIRED', 'Writes require a domain transaction');
    const copy = jsonClone(record); validateRecord(kind, copy);
    const old = this.get(kind, copy.id);
    if (old && IMMUTABLE_KINDS.has(kind)) fail('IMMUTABLE_RECORD', 'Historical evidence and versions cannot be replaced');
    if (expectedRevision === null ? old !== null : old?.revision !== expectedRevision) fail('REVISION_CONFLICT', 'Record changed');
    const immutableFields = {
      tree_turns: ['sessionId', 'nativeTurn', 'logicalTurnId', 'sourceRefs', 'userSourceRefs', 'startedAt'],
      tree_links: ['turnId', 'nodeId', 'assignmentRevision', 'sourceRefs'],
      tree_signals: ['eventId', 'subjectRefs', 'dimension', 'subitem', 'category', 'polarity', 'evidenceKind', 'sourceRefs', 'confidence', 'correctionOf'],
      tree_script_artifacts: ['scriptId', 'methodId', 'version', 'language', 'entry', 'files', 'argSchema', 'dryRunSupport', 'buildRunId'],
      tree_hooks: ['hookId', 'methodId', 'version', 'moment', 'conditions', 'action', 'message'],
      tree_nodes: ['sourceRefs'],
    }[kind] ?? [];
    if (old && immutableFields.some(k => canonicalJson(old[k] ?? null) !== canonicalJson(copy[k] ?? null))) fail('IMMUTABLE_SOURCE', 'Original source and version content cannot be replaced');
    for (const field of ['reviews', 'exportAudit']) if (old?.[field] && canonicalJson(copy[field]?.slice(0, old[field].length) ?? null) !== canonicalJson(old[field])) fail('IMMUTABLE_HISTORY', 'History must be append-only');
    const at = this.now(); if (new Date(at).toISOString() !== at) fail('CLOCK_INVALID', 'Host UTC timestamp required');
    const saved = { ...copy, revision: old ? old.revision + 1 : 1, createdAt: old?.createdAt ?? at, updatedAt: at };
    this.#db.prepare('INSERT INTO records VALUES (?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at,body=excluded.body')
      .run(kind, saved.id, saved.revision, saved.createdAt, saved.updatedAt, canonicalJson(saved));
    const index = this.#nodeIndexes.get(kind);
    if (index) {
      if (typeof old?.nodeId === 'string') index.nodes.get(old.nodeId)?.delete(saved.id);
      if (typeof saved.nodeId === 'string') {
        if (!index.nodes.has(saved.nodeId)) index.nodes.set(saved.nodeId, new Set());
        index.nodes.get(saved.nodeId).add(saved.id);
      }
    }
    const key = recordKey(kind, saved.id), previous = this.#changes.get(key);
    this.#changes.set(key, { kind, id: saved.id, before: previous?.before ?? old?.revision ?? 0, after: saved.revision });
    return saved;
  }
  requireExpected(command, kind, id) {
    if (!Object.hasOwn(command.expected, recordKey(kind, id))) fail('EXPECTED_REQUIRED', 'A current version is required for this command');
  }
  command(type, command, actor, mutate) {
    shape(command, ['requestId', 'expected', 'input'], ['actor']); text(command.requestId, 'requestId', 512);
    for (const value of [command.expected, command.input]) if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_SHAPE', 'Expected and input must be objects', 400);
    jsonClone(command);
    shape(actor, ['kind', 'id'], ['role']); text(actor.id, 'actor id', 512);
    if (!['user', 'model', 'program'].includes(actor.kind) || command.actor && canonicalJson(command.actor) !== canonicalJson(actor)) fail('ACTOR_MISMATCH', 'Actor comes from trusted host context');
    const inputHash = digest({ type, input: command.input, expected: command.expected, actor });
    return this.transaction(() => {
      const receiptId = digest(['receipt', command.requestId]), prior = this.get('tree_receipts', receiptId);
      if (prior) { if (prior.inputHash !== inputHash) fail('IDEMPOTENCY_CONFLICT', 'Request id already identifies different input'); return prior; }
      for (const [key, expected] of Object.entries(command.expected)) {
        integer(expected, 'expected revision'); const split = key.indexOf(':');
        if (split < 1 || this.get(key.slice(0, split), key.slice(split + 1))?.revision !== expected) fail('REVISION_CONFLICT', 'Frozen input changed');
      }
      this.#changes = new Map();
      const result = jsonClone(mutate());
      this.assertTree();
      const meta = this.meta(), ordinal = meta.lastEventOrdinal + 1;
      this.save('tree_meta', { ...meta, lastEventOrdinal: ordinal }, meta.revision);
      const changes = [...this.#changes.values()], eventId = digest(['change', command.requestId]);
      this.save('tree_change_events', { id: eventId, ordinal, commandType: type, actor, entityIds: changes.map(c => recordKey(c.kind, c.id)),
        beforeVersions: changes.map(c => c.before), afterVersions: changes.map(c => c.after), sourceRefs: command.input.sourceRefs ?? [], receiptId });
      return this.save('tree_receipts', { id: receiptId, requestId: command.requestId, inputHash, result,
        revisions: Object.fromEntries(changes.map(c => [recordKey(c.kind, c.id), c.after])), eventIds: [eventId] });
    });
  }
  ancestors(id) {
    const path = [], seen = new Set(); let node = this.get('tree_nodes', id);
    while (node) {
      if (node.deleted || seen.has(node.id)) fail('TREE_CYCLE', 'Invalid tree path'); seen.add(node.id); path.unshift(node);
      if (node.parentId === null) break;
      node = this.get('tree_nodes', node.parentId); if (!node) fail('NODE_NOT_FOUND', 'Missing parent');
    }
    if (!path.length || path[0].id !== this.rootId()) fail('NODE_NOT_FOUND', 'Node is not in this tree'); return path;
  }
  assertTree() {
    const meta = this.meta(); if (!meta) return;
    const nodes = this.list('tree_nodes', n => !n.deleted), roots = nodes.filter(n => n.parentId === null);
    if (roots.length !== 1 || roots[0].id !== meta.rootNodeId || roots[0].status !== 'active') fail('ROOT_INVARIANT', 'One permanent active root required');
    for (const node of nodes) this.ancestors(node.id);
  }
  close() { if (!this.#closed) this.#db.close(); this.#closed = true; }
}
