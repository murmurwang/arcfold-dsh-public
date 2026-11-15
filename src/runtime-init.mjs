import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { BudgetLedger, webBudgetIdentity } from './budget.mjs';
import { OpenAIUsageLedger } from './openai-usage.mjs';
import { canonicalJson } from './store.mjs';
import { readInstallation } from './runtime-installation.mjs';
import { acquireRuntimeLease } from './runtime-lifecycle.mjs';
import { ownEvidenceDirectory, assertEvidenceOwnership } from './evidence-ownership.mjs';
import { openOwnedWebBudget } from './web-budget-recovery.mjs';
import { canonicalRuntimePath, createInitialRuntimeConfig } from './runtime-config.mjs';

const SCHEMA = 'arcfold-initialization-v1';
const sha = value => createHash('sha256').update(value).digest('hex');
const within = (parent, child) => child === parent || child.startsWith(parent + sep);
const disjoint = (a, b) => !within(a, b) && !within(b, a);
const present = path => { try { fs.lstatSync(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
function syncDirectory(path) { const fd = fs.openSync(path, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function privateFile(path, links = [1]) {
  const stat = fs.lstatSync(path);
  assert.ok(stat.isFile() && stat.uid === process.getuid() && !(stat.mode & 0o077) && links.includes(stat.nlink),
    'Initialization files must be private regular files with their explained link count');
  return stat;
}
function signature(path, links = [1]) {
  const st = privateFile(path, links), bytes = fs.readFileSync(path);
  return { dev: st.dev, ino: st.ino, bytes: bytes.length, sha256: sha(bytes) };
}
function json(path) { privateFile(path, [1, 2]); return JSON.parse(fs.readFileSync(path, 'utf8')); }
function writeNew(path, value) {
  const body = typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n';
  const temporary = join(dirname(path), '.init-write-' + randomUUID());
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, body); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  // No rename-overwrite: every fixed receipt is published exactly once.
  fs.linkSync(temporary, path); syncDirectory(dirname(path));
  fs.unlinkSync(temporary); syncDirectory(dirname(path));
}
function authority(initId, provider, authorizedAt) {
  return { authorizationRef: 'arcfold-init:' + initId + ':' + provider, authorizedAt,
    authorizationEvidence: 'Explicit public init --web-unlimited confirmation for this independent installation; ' +
      (provider === 'openai' ? 'OpenAI token-only accounting.' : 'DeepSeek web accounting without a local spending cap.') };
}
function expectedAuthority(provider, authorization) {
  return provider === 'deepseek-official' ? webBudgetIdentity(authorization) : {
    id: 'openai-web-' + sha(authorization.authorizationRef),
    specification: { scope: 'web-openai', provider: 'openai', accounting: 'tokens_only', ...authorization },
  };
}
function ledgerSnapshot(path, provider, authorization) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assert.deepEqual(db.prepare('PRAGMA integrity_check').all().map(r => r.integrity_check), ['ok']);
    const records = db.prepare('SELECT * FROM records ORDER BY kind,id').all().map(r => ({ ...r }));
    const meta = db.prepare('SELECT * FROM store_meta ORDER BY key').all().map(r => ({ ...r }));
    const expected = expectedAuthority(provider, authorization), kind = provider === 'openai' ? 'openai_authorizations' : 'budget_authorizations';
    assert.equal(records.length, 1, 'A fresh ledger may contain only its initial authorization');
    assert.equal(records[0].kind, kind); assert.equal(records[0].id, expected.id);
    assert.equal(records[0].revision, 1);
    const body = JSON.parse(records[0].body);
    assert.deepEqual(body.specification, expected.specification); assert.equal(body.createdSequence, 1); assert.equal(body.updatedSequence, 1);
    assert.equal(meta.find(r => r.key === 'schema_version')?.value, '2');
    assert.equal(meta.find(r => r.key === 'mutation_sequence')?.value, '1');
    if (provider !== 'openai') {
      assert.equal(db.prepare('PRAGMA application_id').get().application_id, 0x41574631);
      assert.equal(db.prepare('SELECT count(*) AS n FROM budget_requests').get().n, 0);
      assert.deepEqual(JSON.parse(meta.find(r => r.key === 'web_budget_mode').value).authorization, expected);
    } else assert.equal(db.prepare('PRAGMA application_id').get().application_id, 0);
    return { schema: db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all().map(r => ({ ...r })),
      records, meta, authorizationId: expected.id };
  } finally { db.close(); }
}
function noSidecars(path) {
  for (const suffix of ['-wal', '-shm', '-journal'])
    assert.ok(!present(path + suffix), 'A newly published ledger cannot depend on unpublished sidecars');
}
function createStagedLedger(path, provider, authorization) {
  assert.ok(!present(path), 'A new attempt never reuses a failed stage');
  const ledger = provider === 'openai'
    ? new OpenAIUsageLedger(path, { create: true, webAuthorization: authorization })
    : new BudgetLedger(path, { mode: 'web-only', scope: 'web-unlimited', create: true, webAuthorization: authorization });
  try {
    // Only a brand-new, privately owned database is changed to a self-contained
    // rollback file. Running-ledger recovery keeps its separate existing policy.
    if (provider === 'openai') {
      assert.equal(ledger.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy, 0);
      assert.equal(ledger.db.prepare('PRAGMA journal_mode=DELETE').get().journal_mode, 'delete');
    }
  } finally { ledger.close(); }
  noSidecars(path); const snapshot = ledgerSnapshot(path, provider, authorization);
  const copy = path + '.standalone-check';
  fs.copyFileSync(path, copy, fs.constants.COPYFILE_EXCL); fs.chmodSync(copy, 0o600);
  assert.deepEqual(ledgerSnapshot(copy, provider, authorization), snapshot, 'Main file alone must contain the whole initialized ledger');
  const fd = fs.openSync(path, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDirectory(dirname(path)); return snapshot;
}
function loadIntent(path, { plan, name, target, attempts }) {
  const intent = json(path);
  assert.equal(intent.schema, 'arcfold-init-publication-v1'); assert.equal(intent.initId, plan.initId);
  assert.equal(intent.name, name); assert.equal(intent.target, target);
  assert.match(intent.attempt, /^[0-9a-f-]{36}$/);
  assert.equal(intent.staged, join(attempts, intent.attempt, name));
  assert.equal(canonicalRuntimePath(intent.staged), intent.staged, 'Staging path cannot be an alias');
  return intent;
}
/** Fixed three-file publication, not a general transaction/recovery engine. */
function publish(intent, intentPath, owner, artifactDirectory, validate) {
  assertEvidenceOwnership(owner, artifactDirectory);
  for (const path of [intent.staged, intent.target])
    assert.equal(canonicalRuntimePath(path), path, 'Publication paths cannot be aliases');
  const staged = present(intent.staged), target = present(intent.target);
  if (target) {
    assert.deepEqual(signature(intent.target, staged ? [2] : [1]), intent.file, 'Published file does not match its exact prior intent');
    if (staged) assert.deepEqual(signature(intent.staged, [2]), intent.file, 'Unexplained staging link');
  } else {
    assert.ok(staged, 'The unpublished stage is missing');
    assert.deepEqual(signature(intent.staged), intent.file, 'The staged file changed');
  }
  validate(target ? intent.target : intent.staged);
  if (!target) { fs.linkSync(intent.staged, intent.target); syncDirectory(dirname(intent.target)); }
  if (present(intent.staged)) {
    assert.deepEqual(signature(intent.staged, [2]), intent.file);
    assert.deepEqual(signature(intent.target, [2]), intent.file);
    fs.unlinkSync(intent.staged); syncDirectory(dirname(intent.staged));
  }
  assert.deepEqual(signature(intent.target), intent.file);
  const completed = intentPath + '.completed';
  if (present(completed)) assert.deepEqual(json(completed), { initId: intent.initId, intentHash: sha(canonicalJson(intent)) });
  else writeNew(completed, { initId: intent.initId, intentHash: sha(canonicalJson(intent)) });
}
function configIntent(path, plan, input) {
  const intent = json(path);
  assert.equal(intent.schema, 'arcfold-init-publication-v1');
  assert.equal(intent.initId, plan.initId); assert.equal(intent.target, input.configPath);
  assert.equal(intent.name, 'config'); assert.match(intent.attempt, /^[0-9a-f-]{36}$/);
  assert.equal(intent.staged, join(dirname(input.configPath), '.arcfold-init-' + plan.initId + '-' + intent.attempt));
  return intent;
}
function emptyFirstUse(dataRoot, runtimeDirectory, artifactDirectory, receipts) {
  for (const name of fs.readdirSync(dataRoot))
    assert.ok(['runtime', 'requests'].includes(name), 'An existing data directory cannot be claimed by first init');
  for (const name of fs.readdirSync(runtimeDirectory))
    assert.ok(name === 'owner.lock' || name === 'initialization', 'Existing runtime records cannot be claimed by first init');
  for (const name of fs.readdirSync(artifactDirectory))
    assert.equal(name, 'owner.lock', 'Existing request evidence or ledger cannot be claimed by first init');
  for (const name of fs.readdirSync(receipts))
    assert.match(name, /^\.init-write-[0-9a-f-]{36}$/, 'Unexplained initialization evidence');
}

/** Only called after full installation verification, from that actual installed core. */
export async function initializeRuntimeDeployment(options) {
  assert.ok(options && typeof options === 'object' && !Array.isArray(options));
  assert.ok(Object.keys(options).every(k => ['installationFile','configPath','dataRoot','workspace','port',
    'webUnlimited','main','learn','network','credentialRefs'].includes(k)), 'Unsupported init options');
  assert.equal(options.webUnlimited, true, 'Explicit --web-unlimited confirmation is required');
  const installation = readInstallation(options.installationFile);
  assert.deepEqual(Object.keys(installation.providers ?? {}).sort(), ['deepseek-official', 'openai'], 'First use requires both actual provider proofs');
  assert.ok(installation.modelSelection, 'First use requires the actual native model-selection proof');
  assert.equal(fileURLToPath(import.meta.url), join(installation.coreRoot, 'src/runtime-init.mjs'), 'Initialization must run in the verified installed core');
  const policyPath = join(installation.coreRoot, 'runtime/initial-policy.json'), policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  const input = { installationFile: installation.installationFile, installationHash: sha(fs.readFileSync(installation.installationFile)),
    policyHash: sha(fs.readFileSync(policyPath)), configPath: canonicalRuntimePath(options.configPath),
    dataRoot: canonicalRuntimePath(options.dataRoot), workspace: canonicalRuntimePath(options.workspace),
    port: options.port ?? 4381, main: options.main ?? policy.initialMain, learn: options.learn ?? options.main ?? policy.initialMain,
    network: options.network ?? { mode: 'direct' }, credentialRefs: options.credentialRefs ??
      { 'deepseek-official': 'ARCFOLD_DEEPSEEK_API_KEY', openai: 'ARCFOLD_OPENAI_API_KEY' } };
  assert.ok(fs.lstatSync(input.workspace).isDirectory(), 'The workspace must already exist');
  assert.ok(disjoint(input.dataRoot, installation.installationDir) && disjoint(input.workspace, installation.installationDir) &&
    disjoint(input.dataRoot, input.workspace), 'Keep user data, workspace and installed code separate');
  const runtimeDirectory = join(input.dataRoot, 'runtime'), artifactDirectory = join(input.dataRoot, 'requests');
  for (const path of [runtimeDirectory, artifactDirectory, join(runtimeDirectory, 'initialization')])
    assert.equal(canonicalRuntimePath(path), path, 'Initialization subdirectories cannot be aliases');
  assert.ok(!within(input.workspace, input.configPath) && !within(installation.installationDir, input.configPath) &&
    !within(runtimeDirectory, input.configPath) && !within(artifactDirectory, input.configPath), 'Config cannot replace runtime, workspace or installed files');
  // Validate all choices before creating a data directory or taking a write lock.
  createInitialRuntimeConfig({ ...input, policy, webAuthorizations: {
    'deepseek-official': authority('validation', 'deepseek-official', '2026-11-07T00:00:00.000Z'),
    openai: authority('validation', 'openai', '2026-11-07T00:00:00.000Z'),
  } });
  const runtimeOwner = await acquireRuntimeLease(runtimeDirectory); let owner;
  try {
    owner = await ownEvidenceDirectory(artifactDirectory);
    const receipts = join(runtimeDirectory, 'initialization'); fs.mkdirSync(receipts, { recursive: true, mode: 0o700 });
    syncDirectory(input.dataRoot); syncDirectory(runtimeDirectory); syncDirectory(artifactDirectory);
    const planPath = join(receipts, 'identity.json');
    let plan;
    if (present(planPath)) {
      plan = json(planPath); assert.equal(plan.schema, SCHEMA);
      assert.deepEqual(plan.input, input, 'Retry requires the exact original initialization input');
      assert.match(plan.initId, /^[0-9a-f-]{36}$/);
      for (const provider of ['deepseek-official', 'openai'])
        assert.deepEqual(plan.authorizations[provider], authority(plan.initId, provider, plan.authorizedAt));
    } else {
      assert.ok(!present(input.configPath), 'First init cannot replace an existing configuration');
      emptyFirstUse(input.dataRoot, runtimeDirectory, artifactDirectory, receipts);
      const initId = randomUUID(), authorizedAt = new Date().toISOString();
      plan = { schema: SCHEMA, initId, input, authorizedAt, authorizations: Object.fromEntries(
        ['deepseek-official', 'openai'].map(provider => [provider, authority(initId, provider, authorizedAt)])) };
      writeNew(planPath, plan);
    }
    const config = createInitialRuntimeConfig({ ...input, policy, webAuthorizations: plan.authorizations });
    const configBody = JSON.stringify(config, null, 2) + '\n', completionPath = join(receipts, 'completed.json');
    const attempts = join(artifactDirectory, 'initialization', plan.initId);
    assert.equal(canonicalRuntimePath(attempts), attempts, 'Staging ancestry must stay inside the owned requests directory');
    const result = created => ({ configPath: input.configPath, initId: plan.initId, created,
      initialization: 'completed', runtimeChecked: false, mode: 'configuration-only',
      ledgerPaths: Object.fromEntries(Object.entries(config.transport.routes).map(([p,r]) => [p,r.ledgerPath])) });
    if (present(input.configPath)) {
      // Config publication is the completion boundary. The ledger may already
      // have legitimate requests, so verify ownership, not its initial contents.
      for (const [provider, route] of Object.entries(config.transport.routes)) {
        const name = provider === 'openai' ? 'openai-web.sqlite' : 'deepseek-web.sqlite';
        const intentPath = join(receipts, name + '.intent.json');
        const intent = loadIntent(intentPath, { plan, name, target: route.ledgerPath, attempts });
        assert.equal(intent.authorizationId, expectedAuthority(provider, plan.authorizations[provider]).id);
        assert.deepEqual(json(intentPath + '.completed'), { initId: plan.initId, intentHash: sha(canonicalJson(intent)) });
        assert.ok(!present(intent.staged), 'Ledger publication was not completed before config');
        const current = privateFile(route.ledgerPath);
        assert.deepEqual({ dev: current.dev, ino: current.ino }, { dev: intent.file.dev, ino: intent.file.ino },
          'A completed initialization cannot claim a replacement ledger');
      }
      const path = join(receipts, 'config.intent.json'), intent = configIntent(path, plan, input);
      publish(intent, path, owner, artifactDirectory, file => assert.equal(fs.readFileSync(file, 'utf8'), configBody));
      const completed = { initId: plan.initId, configHash: sha(configBody) };
      if (present(completionPath)) assert.deepEqual(json(completionPath), completed);
      else writeNew(completionPath, completed);
      // No SQLite constructor/recovery or authorization write after publication.
      return result(false);
    }
    assert.ok(!present(completionPath), 'The completed configuration is missing');
    fs.mkdirSync(attempts, { recursive: true, mode: 0o700 });
    syncDirectory(artifactDirectory); syncDirectory(dirname(attempts)); syncDirectory(attempts);
    const attempt = randomUUID(), stage = join(attempts, attempt); fs.mkdirSync(stage, { mode: 0o700 }); syncDirectory(attempts);
    for (const provider of ['deepseek-official', 'openai']) {
      const name = provider === 'openai' ? 'openai-web.sqlite' : 'deepseek-web.sqlite';
      const target = config.transport.routes[provider].ledgerPath, intentPath = join(receipts, name + '.intent.json');
      let intent;
      if (present(intentPath)) intent = loadIntent(intentPath, { plan, name, target, attempts });
      else {
        assert.ok(!present(target), 'Canonical ledger has no initialization publication intent');
        for (const suffix of ['-wal','-shm','-journal']) assert.ok(!present(target + suffix), 'Unexplained canonical ledger sidecar');
        const staged = join(stage, name), snapshot = createStagedLedger(staged, provider, plan.authorizations[provider]);
        intent = { schema: 'arcfold-init-publication-v1', initId: plan.initId, attempt, name, target, staged,
          file: signature(staged), snapshotHash: sha(canonicalJson(snapshot)), authorizationId: snapshot.authorizationId };
        writeNew(intentPath, intent);
      }
      publish(intent, intentPath, owner, artifactDirectory, path => {
        noSidecars(path);
        const snapshot = ledgerSnapshot(path, provider, plan.authorizations[provider]);
        assert.equal(snapshot.authorizationId, intent.authorizationId); assert.equal(sha(canonicalJson(snapshot)), intent.snapshotHash);
      });
      if (provider === 'deepseek-official') {
        const { ledger } = openOwnedWebBudget({ artifactDirectory, ledgerPath: target, webAuthorization: plan.authorizations[provider], owner });
        ledger.close();
      }
      assert.deepEqual(signature(target), intent.file, 'Validation must not rewrite the initialized ledger');
    }
    fs.mkdirSync(dirname(input.configPath), { recursive: true, mode: 0o700 });
    // Config staging is on its destination filesystem, even when dataRoot is elsewhere.
    const intentPath = join(receipts, 'config.intent.json'); let intent;
    if (present(intentPath)) {
      intent = configIntent(intentPath, plan, input);
    } else {
      assert.ok(!present(input.configPath), 'Existing config has no publication intent');
      const staged = join(dirname(input.configPath), '.arcfold-init-' + plan.initId + '-' + attempt);
      writeNew(staged, configBody);
      intent = { schema: 'arcfold-init-publication-v1', initId: plan.initId, attempt, name: 'config',
        target: input.configPath, staged, file: signature(staged) };
      writeNew(intentPath, intent);
    }
    publish(intent, intentPath, owner, artifactDirectory, path => assert.equal(fs.readFileSync(path, 'utf8'), configBody));
    writeNew(completionPath, { initId: plan.initId, configHash: sha(configBody) });
    return result(true);
  } finally { try { await owner?.close(); } finally { await runtimeOwner.close(); } }
}
