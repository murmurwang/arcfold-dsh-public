import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { actualRuntimeFiber } from '../src/runtime-readiness.mjs';
import { boot, bundlePatchPaths, composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot';

const require = createRequire(import.meta.url);
const source = dirname(dirname(fileURLToPath(import.meta.url)));
const json = path => JSON.parse(readFileSync(path, 'utf8'));
function layer(directory) {
  return bundlePatchPaths(directory, json(join(directory, 'package.json')).dsh.bundle)
    .flatMap(path => loadOverlayPatches('arcfold-release-check', path));
}
const official = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
  .map(name => layer(dirname(require.resolve(`${name}/package.json`))));
const arcfold = layer(source);
function compose(layers) {
  const warnings = [], entries = composeEntries(layers, message => warnings.push(message));
  assert.deepEqual(warnings, [], 'Every patch target must exist in the real official composition');
  return new Map(entries.map(entry => [entry.id, entry]));
}

test('release patches compose over actual official bundles with one main bridge and tool-free Learn', () => {
  const rows = compose([...official, arcfold]);
  const core = [...rows.values()].filter(row => row.name?.startsWith('@arcfold/') && row.name !== '@arcfold/dsh/tree-host');
  const wrappers = [...rows.values()].filter(row => row.name === '@arcfold/dsh/tree-host');
  assert.deepEqual(wrappers.map(row => row.id).sort(), ['arcfold-tree-compaction', 'arcfold-tree-filesystem', 'arcfold-tree-shell']);
  for (const row of wrappers) assert.notEqual(row.disabled, true);
  for (const id of ['goal-round-driver', 'fs-sandbox', 'bash-sandbox', 'compaction-basic']) assert.deepEqual(rows.get(id).inject, ['arcfoldLegacyMode']);
  const active = ['arcfold-business', 'arcfold-desktop-bootstrap', 'arcfold-metered-budget', 'arcfold-metered-provider', 'arcfold-learning', 'arcfold-preparation', 'arcfold-ui'];
  const dormant = ['arcfold-shared-metered-host', 'arcfold-openai-provider'];
  assert.deepEqual(core.map(row => row.id).sort(), [...active, ...dormant].sort());
  assert.equal(new Set(core.map(row => row.name)).size, core.length);
  for (const id of active) assert.notEqual(rows.get(id).disabled, true);
  for (const id of dormant) {
    assert.equal(rows.get(id).disabled, true, 'A new provider cannot activate without explicit deployment configuration');
    assert.deepEqual(rows.get(id).config, {});
  }
  const main = rows.get('preset-arcfold-main').config;
  assert.equal(main.id, 'arcfold-main');
  assert.equal(main.plugins.filter(row => row.name === '@arcfold/dsh/agent').length, 1);
  const preparation = rows.get('preset-arcfold-preparation').config;
  assert.equal(preparation.id, 'arcfold-preparation');
  assert.deepEqual(preparation.plugins.map(row => row.name), ['@deepseek-ai/dsh-tool-executor-native', '@deepseek-ai/dsh-tool-fs']);
  assert.deepEqual(preparation.plugins[1].config, { read: true, readImage: false, write: true, edit: false, applyPatch: false,
    readLimit: 262144, readMaxLineLength: 262144, readMaxBytes: 262144 });
  const learning = rows.get('preset-arcfold-learning').config;
  assert.equal(rows.get('goal-round-driver').name, '@deepseek-ai/dsh-goal-round-driver');
  assert.equal(rows.get('goal-round-driver').disabled, false);
  assert.equal(main.plugins.find(row => row.id === 'tool-jobs').config.completionDelivery, 'quiet');
  assert.ok(!main.plugins.some(row => row.name === '@deepseek-ai/dsh-goal-round-driver'));
  assert.ok(!main.plugins.some(row => ['tool-goal', 'command-goal'].includes(row.id)), 'Arcfold owns stage mutations');
  assert.ok(!learning.plugins.some(row => row.name === '@deepseek-ai/dsh-goal-round-driver'));

  assert.equal(learning.id, 'arcfold-learning');
  assert.deepEqual(learning.plugins, []);
  assert.equal(rows.get('agent-preset-registry').config.default, main.id);
  for (const name of ['tool-fs', 'tool-fs-search', 'tool-bash', 'tool-jobs', 'tool-skill',
    'tool-ask-user', 'tool-todo', 'tool-web', 'present'])
    assert.ok(main.plugins.some(row => row.id === name), `Missing native capability: ${name}`);
  assert.equal(main.plugins.some(row => /subagent|workflow|compaction/.test(row.name)), false);
});

test('release preserves official permission and execution service settings while closing unsupported model routes', () => {
  const baseline = compose(official), rows = compose([...official, arcfold]);
  // Compare actual row objects: an omitted Arcfold permission patch must retain
  // all upstream settings, including expressions and schema-default inputs.
  const preserved = [...baseline.keys()].filter(id =>
    /approval|permission|authorization|sandbox|tool-executor|session-persistence|working-directory/.test(id));
  assert.ok(preserved.length >= 8);
  for (const id of preserved) {
    if (['fs-sandbox', 'bash-sandbox'].includes(id)) {
      assert.deepEqual({ ...rows.get(id), inject: baseline.get(id).inject }, { ...baseline.get(id), inject: baseline.get(id).inject }, id);
      assert.deepEqual(rows.get(id).inject, ['arcfoldLegacyMode']);
    } else assert.deepEqual(rows.get(id), baseline.get(id), id);
  }
  for (const id of ['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai',
    'deepseek-llm-api-extensions', 'session-log-deepseek', 'plugin-package-inventory-deepseek',
    'llm-retry', 'session-title-llm', 'schedule',
    'subagent-spawn-in-process', 'subagent-fork-in-process', 'web-search-deepseek', 'web-deepseek-api',
    'preset-standard', 'preset-minimal', 'preset-ptc', 'preset-cordis'])
    assert.equal(rows.get(id)?.disabled, true, `${id} is an unsupported alternate route`);
  // Native Loader/ConfigEditor execution in runtime-config.test verifies the
  // launcher default and explicit independent-plugin configuration, including
  // first-save service identity, dependent work and persisted saves.
  const defaults = rows.get('agent-default-model').config;
  assert.deepEqual(Object.keys(defaults).sort(), ['model', 'provider', 'reasoningEffort']);
  for (const field of ['provider', 'model', 'reasoningEffort'])
    assert.equal(typeof defaults[field].__jsExpr, 'string');
  assert.notDeepEqual(rows.get('agent-default-model').config, baseline.get('agent-default-model').config);
});

test('deployment config remains external and official later patches replace whole config rows', () => {
  const rows = compose([...official, arcfold]);
  for (const id of ['arcfold-business', 'arcfold-metered-budget', 'arcfold-metered-provider', 'arcfold-learning', 'arcfold-shared-metered-host', 'arcfold-openai-provider'])
    assert.deepEqual(rows.get(id).config, {});
  const config = { apiKeyRef: 'explicit-credential-reference', maxTokens: 8192, reasoningEffort: 'high' };
  const configured = compose([...official, arcfold, [{ id: 'arcfold-metered-provider', config }]]);
  assert.deepEqual(configured.get('arcfold-metered-provider').config, config);
  const partial = compose([...official, arcfold, [{ id: 'arcfold-metered-provider', config }],
    [{ id: 'arcfold-metered-provider', config: { maxTokens: 4096 } }]]);
  assert.deepEqual(partial.get('arcfold-metered-provider').config, { maxTokens: 4096 });
  // These are composition checks, not proof that an incomplete config can load.
  assert.equal(partial.get('arcfold-metered-provider').config.apiKeyRef, undefined);
});


test('release activates the single official observation policy and keeps disabled/unloaded readiness closed', async t => {
  const baseline = compose(official).get('fs-observation-policy');
  const row = compose([...official, arcfold]).get('fs-observation-policy');
  assert.equal(baseline.disabled, true, 'The actual official base leaves this opt-in policy disabled');
  assert.equal(row.disabled, false, 'The release must explicitly activate its required no-clobber policy');
  assert.deepEqual({ ...row, disabled: true }, baseline, 'Only activation changes; keep the original official module/config');
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'arcfold-release-fs-policy-')));
  t.diagnostic('Retained real composition/Loader fixture: ' + directory);
  const filename = join(directory, 'cordis.yml'); writeFileSync(filename, '[]\n');
  // Use the actual composed package row and original Loader; no direct
  // ctx.plugin(Observation) can bypass a disabled bundle entry here.
  const ctx = await boot('test', filename, [{ insert: [row] }], undefined, pathToFileURL(source + '/').href);
  t.after(async () => ctx.fiber.dispose());
  const entries = [...ctx.loader.entries()].filter(entry => entry.options.id === row.id);
  assert.equal(entries.length, 1);
  const fiber = actualRuntimeFiber(entries[0], ctx.root);
  const target = { targetKey: 'fixture-new-draft', displayPath: join(directory, 'draft.md') };
  const actor = { agent: { session: { id: 'fixture-session' } } };
  assert.deepEqual(await ctx.waterfall('fs/write-intent', target, actor, async () => undefined), { kind: 'createIfAbsent' });
  await fiber.dispose();
  assert.throws(() => actualRuntimeFiber(entries[0], ctx.root), /not active in this host/);
  const disabledFile = join(directory, 'disabled.yml'); writeFileSync(disabledFile, '[]\n');
  const disabled = await boot('test', disabledFile, [{ insert: [{ ...row, disabled: true }] }], undefined, pathToFileURL(source + '/').href);
  t.after(async () => disabled.fiber.dispose());
  const disabledEntry = [...disabled.loader.entries()].find(entry => entry.options.id === row.id);
  assert.ok(disabledEntry);
  assert.throws(() => actualRuntimeFiber(disabledEntry, disabled.root), /not active in this host/);
});
