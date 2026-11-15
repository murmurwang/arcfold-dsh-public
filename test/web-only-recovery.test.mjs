import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { BudgetLedger } from '../src/budget.mjs';
import { Store } from '../src/store.mjs';
import { ownEvidenceDirectory, assertEvidenceOwnership } from '../src/evidence-ownership.mjs';
import { initializeOwnedWebBudget, openOwnedWebBudget, preflightWebBudget, validateOwnedWebBudgetCopy } from '../src/web-budget-recovery.mjs';
const authority = { authorizationRef: 'fixture-owned-web', authorizedAt: '2026-11-07T00:00:00Z',
  authorizationEvidence: 'Synthetic explicit independent web permission.' };
const reserve = id => ({ requestId: id, bodyHash: 'hash-' + id, model: 'deepseek-v4-pro',
  inputTokenCeiling: 100, maxOutputTokens: 32, prices: { input: 1, output: 2, cachedInput: 0.1 } });
const roots = () => fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'arcfold-owned-web-')));
function bytes(path) {
  return Object.fromEntries(['', '-journal', '-wal', '-shm'].map(suffix =>
    [suffix, fs.existsSync(path + suffix) ? fs.readFileSync(path + suffix) : null]));
}
async function fixture() {
  const artifactDirectory = roots(), result = await initializeOwnedWebBudget({ artifactDirectory, webAuthorization: authority });
  const ledger = new BudgetLedger(result.ledgerPath, { mode: 'web-only', scope: 'web-unlimited', webAuthorization: authority });
  ledger.reserve(reserve('unknown')); ledger.markDispatched('unknown'); ledger.markUnknown('unknown');
  ledger.reserve(reserve('pending'));
  const before = ledger.list(); ledger.close();
  return { artifactDirectory, ledgerPath: result.ledgerPath, webAuthorization: authority, before };
}
function crash(filename) {
  execFileSync(process.execPath, ['-e', `
    const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA cache_size=1; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
    const insert=db.prepare("INSERT INTO budget_requests VALUES(?,?,'reserved',1,0,?,'web-unlimited')");
    for(let i=0;i<160;i++)insert.run('uncommitted-'+i,'h',JSON.stringify({pad:'x'.repeat(8192)}));
    process.exit(0);
  `, filename], { stdio: 'pipe' });
  assert.equal(fs.readFileSync(filename + '-journal').subarray(0, 8).toString('hex'), 'd9d505f920a163d7',
    'The child must leave an actual hot rollback journal');
}
async function owner(t, f) {
  const held = await ownEvidenceDirectory(f.artifactDirectory);
  t.after(() => held.close()); return held;
}
test('owned creation is idempotent and refuses orphan logs and wrong fixed paths', async t => {
  const f = await fixture(), before = bytes(f.ledgerPath);
  assert.equal((await initializeOwnedWebBudget(f)).created, false); assert.deepEqual(bytes(f.ledgerPath), before);
  assert.throws(() => preflightWebBudget({ ...f, ledgerPath: join(f.artifactDirectory, 'other.sqlite') }), /fixed canonical/);
  const other = roots(); fs.writeFileSync(join(other, 'deepseek-web.sqlite-journal'), 'orphan', { mode: 0o600 });
  await assert.rejects(initializeOwnedWebBudget({ artifactDirectory: other, webAuthorization: authority }), /cannot reclaim/);
  assert.equal(fs.existsSync(join(other, 'deepseek-web.sqlite')), false);
  assert.equal(fs.readFileSync(join(other, 'deepseek-web.sqlite-journal'), 'utf8'), 'orphan');
  await assert.rejects(initializeOwnedWebBudget({ artifactDirectory: roots(), webAuthorization: {} }));
});
test('real hot-journal recovery preserves committed unknown/reserved rows and reuses the validated original connection', async t => {
  const f = await fixture(); crash(f.ledgerPath); const original = bytes(f.ledgerPath);
  const held = await owner(t, f);
  const { ledger, recoveryDirectory } = openOwnedWebBudget({ ...f, owner: held });
  t.after(() => ledger.close());
  assert.deepEqual(ledger.list(), f.before); assert.equal(ledger.get('unknown').status, 'unknown');
  assert.equal(ledger.db, ledger.store.db); assert.equal(ledger.filename, f.ledgerPath);
  assert.throws(() => ledger.markDispatched('unknown'), { code: 'request_already_dispatched' });
  assert.throws(() => ledger.releaseUnsent('unknown'), { code: 'already_dispatched' });
  assert.deepEqual(bytes(join(recoveryDirectory, 'original/deepseek-web.sqlite')), original);
  assert.ok(fs.existsSync(join(recoveryDirectory, 'completed.json')));
  ledger.reserve(reserve('later')); assert.ok(ledger.get('later')); ledger.close();
});
test('copy-only version validation recovers no original bytes; wrong authorization leaves hot originals exact', async t => {
  const f = await fixture(); crash(f.ledgerPath); const before = bytes(f.ledgerPath), held = await owner(t, f);
  const result = validateOwnedWebBudgetCopy({ ...f, owner: held });
  assert.deepEqual(bytes(f.ledgerPath), before);
  assert.ok(fs.existsSync(join(result.recoveryDirectory, 'validated-copy.json')));
  assert.throws(() => openOwnedWebBudget({ ...f, owner: held,
    webAuthorization: { ...authority, authorizationEvidence: 'different' } }), { code: 'web_budget_identity_conflict' });
  assert.deepEqual(bytes(f.ledgerPath), before);
});
test('cold journal presence is accepted after actual SQLite and complete identity checks', async t => {
  const f = await fixture(); fs.writeFileSync(f.ledgerPath + '-journal', Buffer.alloc(1024), { mode: 0o600 });
  const held = await owner(t, f), { ledger } = openOwnedWebBudget({ ...f, owner: held });
  assert.deepEqual(ledger.list(), f.before);
  ledger.reserve(reserve('cold-next')); ledger.close();
});
test('wrong mode, WAL/SHM, symlinks and hardlinks cannot evade the single fixed owner', async t => {
  for (const kind of ['wal', 'shm', 'symlink', 'hardlink', 'mode']) {
    const f = await fixture();
    if (kind === 'wal' || kind === 'shm') fs.writeFileSync(f.ledgerPath + '-' + kind, 'unexpected', { mode: 0o600 });
    if (kind === 'hardlink') fs.linkSync(f.ledgerPath, join(f.artifactDirectory, 'alias'));
    if (kind === 'symlink') { fs.renameSync(f.ledgerPath, f.ledgerPath + '.real'); fs.symlinkSync(f.ledgerPath + '.real', f.ledgerPath); }
    if (kind === 'mode') { const fd = fs.openSync(f.ledgerPath, 'r+'); fs.writeSync(fd, Buffer.alloc(4), 0, 4, 68); fs.closeSync(fd); }
    const changed = bytes(f.ledgerPath), held = await owner(t, f);
    assert.throws(() => openOwnedWebBudget({ ...f, owner: held }));
    assert.deepEqual(bytes(f.ledgerPath), changed);
  }
});
test('fake/closed lease is rejected, live owner blocks initialization and aliases share one lock', async t => {
  const f = await fixture(), held = await owner(t, f);
  assert.throws(() => openOwnedWebBudget({ ...f, owner: { directory: f.artifactDirectory, exclusive: true } }), /live evidence/);
  await assert.rejects(initializeOwnedWebBudget(f));
  const alias = join(roots(), 'alias'); fs.symlinkSync(f.artifactDirectory, alias);
  await assert.rejects(ownEvidenceDirectory(alias)); assertEvidenceOwnership(held, alias);
  await held.close(); assert.throws(() => openOwnedWebBudget({ ...f, owner: held }), /live evidence/);
  const next = await ownEvidenceDirectory(f.artifactDirectory); await next.close();
});
test('copy failure preserves originals; changed source after copy validation is refused', async t => {
  const f = await fixture(); crash(f.ledgerPath); const held = await owner(t, f), before = bytes(f.ledgerPath);
  const copy = fs.copyFileSync;
  const fault = t.mock.method(fs, 'copyFileSync', (...args) => {
    if (args[1].includes('/working/')) throw new Error('fixture copy failure'); return copy(...args);
  });
  assert.throws(() => openOwnedWebBudget({ ...f, owner: held }), /fixture copy failure/);
  fault.mock.restore(); assert.deepEqual(bytes(f.ledgerPath), before);
  const factory = Store.fromWebBudgetConnection;
  const mutate = t.mock.method(Store, 'fromWebBudgetConnection', (db, options) => {
    const result = factory.call(Store, db, options);
    if (options.filename.includes('/working/')) fs.appendFileSync(f.ledgerPath, Buffer.from([0]));
    return result;
  });
  assert.throws(() => openOwnedWebBudget({ ...f, owner: held }), /changed after copy validation/); mutate.mock.restore();
  for (const name of fs.readdirSync(join(f.artifactDirectory, 'web-budget-recovery'))) {
    const failure = JSON.parse(fs.readFileSync(join(f.artifactDirectory, 'web-budget-recovery', name, 'failure.json')));
    assert.equal(failure.originalRecoveryStarted, false);
  }
});
test('post-original recovery failure is recorded; next owned start validates rather than resets', async t => {
  const f = await fixture(); crash(f.ledgerPath); const held = await owner(t, f);
  const fault = t.mock.method(BudgetLedger, 'fromWebBudgetStore', () => { throw new Error('fixture post-recovery interruption'); });
  assert.throws(() => openOwnedWebBudget({ ...f, owner: held }), /post-recovery interruption/); fault.mock.restore();
  const name = fs.readdirSync(join(f.artifactDirectory, 'web-budget-recovery'))[0];
  assert.equal(JSON.parse(fs.readFileSync(join(f.artifactDirectory, 'web-budget-recovery', name, 'failure.json'))).originalRecoveryStarted, true);
  const { ledger } = openOwnedWebBudget({ ...f, owner: held }); assert.deepEqual(ledger.list(), f.before); ledger.close();
});

test('a real process exit after original recovery releases the kernel lease; reopening retains all committed rows',async t=>{
  const f=await fixture();crash(f.ledgerPath);
  const child=spawnSync(process.execPath,['--input-type=module','-e',`
    const {BudgetLedger}=await import(process.argv[1]);
    const {ownEvidenceDirectory}=await import(process.argv[2]);
    const {openOwnedWebBudget}=await import(process.argv[3]);
    const options=JSON.parse(process.argv[4]),owner=await ownEvidenceDirectory(options.artifactDirectory);
    BudgetLedger.fromWebBudgetStore=()=>process.exit(86);
    openOwnedWebBudget({...options,owner});
  `,new URL('../src/budget.mjs',import.meta.url).href,new URL('../src/evidence-ownership.mjs',import.meta.url).href,
    new URL('../src/web-budget-recovery.mjs',import.meta.url).href,JSON.stringify(f)],{encoding:'utf8'});
  assert.equal(child.status,86,child.stderr);
  const recovery=fs.readdirSync(join(f.artifactDirectory,'web-budget-recovery'))[0];
  assert.ok(fs.existsSync(join(f.artifactDirectory,'web-budget-recovery',recovery,'original-recovery-started.json')));
  assert.equal(fs.existsSync(join(f.artifactDirectory,'web-budget-recovery',recovery,'completed.json')),false);
  const held=await owner(t,f),{ledger}=openOwnedWebBudget({...f,owner:held});
  assert.deepEqual(ledger.list(),f.before);ledger.close();
});

test('normal owned recovery refuses existing and dangling archive-directory symlinks before any external write',async t=>{
  for(const dangling of [false,true]) {
    const f=await fixture(),outside=join(roots(),'external-recovery'),path=join(f.artifactDirectory,'web-budget-recovery');
    if(!dangling){fs.mkdirSync(outside);fs.writeFileSync(join(outside,'original'),'retained',{mode:0o600});}
    fs.symlinkSync(outside,path);
    const original=bytes(f.ledgerPath),held=await owner(t,f);
    for(const operation of [openOwnedWebBudget,validateOwnedWebBudgetCopy]) {
      assert.throws(()=>operation({...f,owner:held}),{code:'web_budget_recovery_refused'});
      assert.deepEqual(bytes(f.ledgerPath),original);
      if(dangling)assert.equal(fs.existsSync(outside),false);
      else{assert.deepEqual(fs.readdirSync(outside),['original']);assert.equal(fs.readFileSync(join(outside,'original'),'utf8'),'retained');}
      assert.equal(fs.lstatSync(path).isSymbolicLink(),true,'Keep the refused path unchanged');
    }
  }
});
