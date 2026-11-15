import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BudgetLedger, webBudgetIdentity } from './budget.mjs';
import { Store, canonicalJson, assertWebBudgetFileFormat } from './store.mjs';
import { assertEvidenceOwnership, canonicalEvidenceDirectory, ownEvidenceDirectory } from './evidence-ownership.mjs';

export const WEB_BUDGET_RECOVERY_VERSION = 'web-only-recovery-v1';
const suffixes = ['', '-journal', '-wal', '-shm'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function present(path) {
  try { fs.lstatSync(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
const fail = message => Object.assign(new Error(message), { code: 'web_budget_recovery_refused' });

export function webBudgetPath(artifactDirectory, ledgerPath) {
  const directory = canonicalEvidenceDirectory(artifactDirectory), filename = join(directory, 'deepseek-web.sqlite');
  if (ledgerPath !== undefined && (!isAbsolute(ledgerPath) || resolve(ledgerPath) !== filename))
    throw fail('The web-only ledger must use the fixed canonical evidence-directory path');
  return filename;
}
function regular(path) {
  const info = fs.lstatSync(path);
  if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid() || (info.mode & 0o077))
    throw fail('Web-only ledger files must be private, single-link regular files');
  return info;
}
export function preflightWebBudget({ artifactDirectory, ledgerPath }) {
  const filename = webBudgetPath(artifactDirectory, ledgerPath);
  regular(filename); assertWebBudgetFileFormat(filename);
  for (const suffix of suffixes.slice(1)) {
    if (!present(filename + suffix)) continue;
    regular(filename + suffix);
    if (suffix !== '-journal') throw fail('The web-only rollback format cannot contain WAL/SHM files');
  }
  return filename;
}
function inventory(filename) {
  return suffixes.map(suffix => {
    const path = filename + suffix;
    if (!present(path)) return { suffix, missing: true };
    const info = regular(path), bytes = fs.readFileSync(path);
    const after = regular(path);
    if (info.ino !== after.ino || info.dev !== after.dev || info.size !== after.size || info.mtimeMs !== after.mtimeMs)
      throw fail('The original ledger changed while being copied');
    return { suffix, size: bytes.length, sha256: sha(bytes), dev: info.dev, ino: info.ino,
      mode: info.mode, uid: info.uid, mtimeMs: info.mtimeMs };
  });
}
function syncDirectory(path) {
  const fd = fs.openSync(path, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function save(path, value) {
  const fd = fs.openSync(path, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  syncDirectory(join(path, '..'));
}
function copySet(filename, directory, manifest) {
  fs.mkdirSync(directory, { mode: 0o700 });
  const target = join(directory, 'deepseek-web.sqlite');
  for (const item of manifest) {
    if (item.missing) continue;
    fs.copyFileSync(filename + item.suffix, target + item.suffix, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target + item.suffix, 0o600);
    assert.equal(sha(fs.readFileSync(target + item.suffix)), item.sha256, 'Copied ledger bytes differ');
    const fd = fs.openSync(target + item.suffix, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  syncDirectory(directory); return target;
}
function records(db) {
  return {
    applicationId: db.prepare('PRAGMA application_id').get().application_id,
    schema: db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all().map(row => ({ ...row })),
    records: db.prepare('SELECT * FROM records ORDER BY kind,id').all().map(row => ({ ...row })),
    meta: db.prepare('SELECT * FROM store_meta ORDER BY key').all().map(row => ({ ...row })),
    requests: db.prepare('SELECT * FROM budget_requests ORDER BY id').all().map(row => ({ ...row })),
  };
}
function recoveredConnection(filename, identity) {
  let db;
  try {
    db = new DatabaseSync(filename);
    db.exec('PRAGMA busy_timeout=30000; PRAGMA synchronous=FULL');
    const integrity = db.prepare('PRAGMA integrity_check').all();
    assert.deepEqual(integrity.map(row => row.integrity_check), ['ok'], 'The recovered ledger failed SQLite integrity validation');
    const store = Store.fromWebBudgetConnection(db, { filename, webBudgetIdentity: identity });
    return { store, snapshot: records(db) };
  } catch (error) { db?.close(); throw error; }
}

/** Both entry points below require the real held lease; no config bypass flag. */
function inspectCopy({ artifactDirectory, ledgerPath, webAuthorization, owner }) {
  assertEvidenceOwnership(owner, artifactDirectory);
  const filename = preflightWebBudget({ artifactDirectory, ledgerPath }), identity = webBudgetIdentity(webAuthorization);
  const evidenceRoot = canonicalEvidenceDirectory(artifactDirectory);
  const recoveryRoot = join(evidenceRoot, 'web-budget-recovery');
  // lstat also detects dangling symlinks. No archive mkdir or original SQLite
  // recovery is allowed through a redirected fixed child of the held owner.
  if (present(recoveryRoot) && !fs.lstatSync(recoveryRoot).isDirectory())
    throw fail('The recovery archive root must be a real directory within its owned evidence root');
  if (canonicalEvidenceDirectory(recoveryRoot) !== recoveryRoot)
    throw fail('The recovery archive root cannot be an alias');
  const recoveryDirectory = join(recoveryRoot, randomUUID());
  fs.mkdirSync(recoveryDirectory, { recursive: true, mode: 0o700 });
  syncDirectory(join(recoveryDirectory, '..'));
  syncDirectory(canonicalEvidenceDirectory(artifactDirectory));
  let originalRecoveryStarted = false;
  const failure = error => {
    save(join(recoveryDirectory, 'failure.json'), { code: error.code ?? 'recovery_failed',
      message: error.message, originalRecoveryStarted });
  };
  try {
    const manifest = inventory(filename);
    save(join(recoveryDirectory, 'original.json'), { filename, manifest });
    const archive = copySet(filename, join(recoveryDirectory, 'original'), manifest);
    assert.deepEqual(inventory(filename), manifest, 'Original ledger changed during archival');
    const working = copySet(archive, join(recoveryDirectory, 'working'), manifest);
    const copy = recoveredConnection(working, identity);
    let snapshot;
    try { snapshot = copy.snapshot; save(join(recoveryDirectory, 'recovered-records.json'), snapshot); }
    finally { copy.store.close(); }
    const assertOriginal = () => {
      assertEvidenceOwnership(owner, artifactDirectory);
      assert.deepEqual(inventory(filename), manifest, 'Original ledger changed after copy validation');
    };
    assertOriginal();
    return { filename, identity, recoveryDirectory, snapshot, assertOriginal, failure,
      beginOriginal() { originalRecoveryStarted = true;
        save(join(recoveryDirectory, 'original-recovery-started.json'), { filename, at: new Date().toISOString() }); } };
  } catch (error) { failure(error); throw error; }
}
export function validateOwnedWebBudgetCopy(options) {
  const inspected = inspectCopy(options);
  save(join(inspected.recoveryDirectory, 'validated-copy.json'), { mode: WEB_BUDGET_RECOVERY_VERSION,
    originalModified: false, recordsHash: sha(canonicalJson(inspected.snapshot)) });
  return { recoveryDirectory: inspected.recoveryDirectory, recordsHash: sha(canonicalJson(inspected.snapshot)) };
}
export function openOwnedWebBudget(options) {
  const inspected = inspectCopy(options); let original;
  try {
    inspected.assertOriginal(); inspected.beginOriginal();
    original = recoveredConnection(inspected.filename, inspected.identity);
    assert.deepEqual(original.snapshot, inspected.snapshot, 'Original recovery differs from the validated copy');
    assertEvidenceOwnership(options.owner, options.artifactDirectory);
    const ledger = BudgetLedger.fromWebBudgetStore(original.store, options.webAuthorization);
    save(join(inspected.recoveryDirectory, 'completed.json'), { mode: WEB_BUDGET_RECOVERY_VERSION,
      recordsHash: sha(canonicalJson(original.snapshot)), authorizationId: inspected.identity.id });
    return { ledger, recoveryDirectory: inspected.recoveryDirectory };
  } catch (error) {
    original?.store.close(); inspected.failure(error); throw error;
  }
}

/** Called from a verified installed core, never by importing native peers in the unpacked CLI. */
export async function initializeOwnedWebBudget({ artifactDirectory, ledgerPath, webAuthorization }) {
  const filename = webBudgetPath(artifactDirectory, ledgerPath), identity = webBudgetIdentity(webAuthorization);
  const owner = await ownEvidenceDirectory(artifactDirectory); let ledger;
  try {
    const created = !present(filename);
    if (created) {
      for (const suffix of suffixes.slice(1))
        if (present(filename + suffix)) throw fail('A missing database cannot reclaim existing recovery files');
      ledger = new BudgetLedger(filename, { mode: 'web-only', scope: 'web-unlimited', webAuthorization, create: true });
    } else ({ ledger } = openOwnedWebBudget({ artifactDirectory, ledgerPath: filename, webAuthorization, owner }));
    return { ledgerPath: filename, created, authorizationId: identity.id };
  } finally { try { ledger?.close(); } finally { await owner.close(); } }
}

export async function validateWebBudgetVersion(routes, artifactDirectory) {
  const selected = Object.values(routes).filter(route => route.mode === 'web-only');
  if (!selected.length) return [];
  const owner = await ownEvidenceDirectory(artifactDirectory);
  try { return selected.map(route => validateOwnedWebBudgetCopy({ artifactDirectory,
    ledgerPath: route.ledgerPath, webAuthorization: route.webAuthorization, owner })); }
  finally { await owner.close(); }
}
