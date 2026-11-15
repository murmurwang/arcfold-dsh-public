import test from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeOwnedWebBudget } from '../src/web-budget-recovery.mjs';
import { desktopConfiguration, initializeDesktop } from '../src/desktop/configuration.mjs';

const roles = ['main', 'attribution', 'learning', 'consolidation', 'verification', 'improvement', 'script_writer'];
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'desktop-config-fixture-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, 'data'), workspace = join(root, 'workspace'), installed = join(root, 'installed'), evidence = join(data, 'requests');
  for (const path of [data, workspace, installed]) mkdirSync(path, { mode: 0o700 });
  const authority = { authorizationRef: 'synthetic-desktop-authorization', authorizedAt: '2026-01-01T00:00:00.000Z', authorizationEvidence: 'synthetic fixture only' };
  const account = await initializeOwnedWebBudget({ artifactDirectory: evidence, webAuthorization: authority });
  const model = { provider: 'deepseek-official', model: 'synthetic-model', reasoningEffort: 'off', maxTokens: 32 };
  const policy = { contextWindow: 1024, maxOutputTokens: 64, requestMaxTokens: 32, reasoningEfforts: ['off'], prices: { input: 1, output: 2, cachedInput: 0 }, priceVersion: 'synthetic-only' };
  const local = { schema: 'arcfold-local-v2', installationFile: join(installed, 'installation.json'), dataRoot: data, workspace,
    listen: { host: '127.0.0.1', port: 0 }, main: model, learn: model,
    transport: { artifactDirectory: evidence, routes: { 'deepseek-official': { kind: 'deepseek', mode: 'web-only', scope: 'web-unlimited',
      apiKeyRef: 'SYNTHETIC_KEY', ledgerPath: account.ledgerPath, webAuthorization: authority, endpoint: 'https://api.deepseek.com/anthropic/v1/messages',
      network: { mode: 'direct' }, modelPolicies: { 'synthetic-model': policy } } } } };
  const options = { local, runtimeRoot: join(root, 'workers'), python: process.execPath, userId: 'synthetic-user',
    models: Object.fromEntries(roles.map(role => [role, { ...model, modelVersion: 'synthetic-v1' }])) };
  return { root, data, evidence, account, options };
}

test('projects explicit authorized configuration without touching data or credentials', async t => {
  const { data, evidence, account, options } = await fixture(t);
  const before = readFileSync(account.ledgerPath), names = readdirSync(evidence).sort();
  const { tree, patches } = desktopConfiguration(options);
  assert.deepEqual(readFileSync(account.ledgerPath), before); assert.deepEqual(readdirSync(evidence).sort(), names);
  assert.deepEqual(readdirSync(data).sort(), ['requests']);
  assert.equal(tree.adapter, 'desktop-private-v1'); assert.equal(tree.followConversationModel, true); assert.equal(tree.budget.webAuthorization.authorizationRef, 'synthetic-desktop-authorization');
  assert.equal(tree.models.learning.modelVersion, 'synthetic-v1');
  assert.equal(patches.find(p => p.id === 'arcfold-metered-provider').disabled, true);
  assert.equal(patches.find(p => p.insert).insert[0].name, '@arcfold/dsh/desktop-deepseek');
  assert.equal(JSON.stringify(patches).includes('synthetic-fixture-key'), false);
});

test('refuses missing authorization, missing roles and overlapping directories', async t => {
  const { options } = await fixture(t);
  const invalid = structuredClone(options); delete invalid.local.transport.routes['deepseek-official'].webAuthorization;
  assert.throws(() => desktopConfiguration(invalid), /webAuthorization|explicitly authorized/);
  const missing = structuredClone(options); delete missing.models.verification;
  assert.throws(() => desktopConfiguration(missing), /seven/);
  assert.throws(() => desktopConfiguration({ ...options, runtimeRoot: join(options.local.dataRoot, 'workers') }), /separate/);
  const mismatch = structuredClone(options); mismatch.models.main.maxTokens = 12;
  assert.throws(() => desktopConfiguration(mismatch), /must match/);
});

test('first use requires explicit confirmation and a new independent directory; exact retry is read-only', async t => {
  const { root, options } = await fixture(t);
  const fresh = structuredClone(options), data = join(root, 'fresh-desktop'), evidence = join(data, 'requests');
  fresh.local.dataRoot = data; fresh.local.transport.artifactDirectory = evidence;
  fresh.local.transport.routes['deepseek-official'].ledgerPath = join(evidence, 'deepseek-web.sqlite');
  await assert.rejects(() => initializeDesktop(fresh, { confirmed: false }), /confirmation/);
  assert.throws(() => lstatSync(data), { code: 'ENOENT' });
  const result = await initializeDesktop(fresh, { confirmed: true });
  assert.equal(result.created, true); assert.equal(result.tree.privateRoot, data);
  const ledger = result.tree.budget.ledgerPath, before = readFileSync(ledger), names = readdirSync(evidence).sort();
  const again = await initializeDesktop(fresh, { confirmed: true });
  assert.equal(again.created, false); assert.deepEqual(readFileSync(ledger), before); assert.deepEqual(readdirSync(evidence).sort(), names);
  const changed = structuredClone(fresh); changed.userId = 'different-user';
  await assert.rejects(() => initializeDesktop(changed, { confirmed: true }), /same original configuration/);
  const unexplained = structuredClone(fresh); unexplained.local.dataRoot = join(root, 'existing-unknown');
  unexplained.local.transport.artifactDirectory = join(unexplained.local.dataRoot, 'requests');
  unexplained.local.transport.routes['deepseek-official'].ledgerPath = join(unexplained.local.transport.artifactDirectory, 'deepseek-web.sqlite');
  mkdirSync(unexplained.local.dataRoot, { mode: 0o700 });
  await assert.rejects(() => initializeDesktop(unexplained, { confirmed: true }), /not owned/);
});
