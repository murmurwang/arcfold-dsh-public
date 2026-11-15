import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyModelSelectionPatch, inspectModelSelectionPatch, patchSpec } from '../scripts/patch-model-selection.mjs';

const deps = realpathSync(process.env.ARCFOLD_PATCH_TEST_INSTALLATION);
const source = join(deps, 'node_modules/@deepseek-ai/dsh-api-session-controller');
const evidence = mkdtempSync(join(realpathSync(tmpdir()), 'native-selection-patch-'));
symlinkSync(join(deps, 'node_modules'), join(evidence, 'node_modules'), 'dir');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(label) {
  const root = mkdtempSync(join(evidence, label + '-')), packageDir = join(root, 'controller');
  cpSync(source, packageDir, { recursive: true });
  assert.equal(inspectModelSelectionPatch(packageDir).state, 'original');
  return { root, packageDir };
}
async function commandFixture(t) {
  const { root, packageDir } = fixture('command');
  applyModelSelectionPatch({ packageDir, receiptDir: join(root, 'receipt') });
  const loaded = await import(pathToFileURL(join(packageDir, 'lib/index.js')).href);
  assert.equal(loaded.SessionController.modelSelectionSeam, 'session-model-selection-commit-v1');
  assert.equal(Object.getOwnPropertyDescriptor(loaded.SessionController, 'modelSelectionSeam').writable, false);
  // A test-only extra export exposes the unchanged command class in the exact
  // loaded bundle. No method/validation/event code is replaced by this harness.
  const exposed = join(packageDir, 'lib/command-test.mjs');
  writeFileSync(exposed, readFileSync(join(packageDir, 'lib/index.js'), 'utf8') + '\nexport { SessionCommandController };\n');
  const { SessionCommandController } = await import(pathToFileURL(exposed).href);
  const ctx = new Context(), writes = [], saves = [];
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin({ name: 'selection-fixture-services', apply(child) {
    child.provide('llm', { listProviders: () => [{ id: 'fixture' }], async listModels() { return [{ id: 'two' }]; },
      async resolveCallConfig(value) { return value; } });
    child.provide('agentDefaultModel', { saveSelection(value) { saves.push(value); return Promise.resolve(); } });
  } });
  const agent = { id: 'fixture-session', model: { select(value) { writes.push(value); } } };
  const native = new SessionCommandController(ctx, { async resolveAgent(id) { assert.equal(id, agent.id); return { agent }; },
    serializeImageAdmission(a, callback) { assert.equal(a, agent); return callback(); } }, root);
  const request = { sessionId: agent.id, provider: 'fixture', model: 'two', reasoningEffort: 'high' };
  return { ctx, native, request, agent, writes, saves };
}
test('controller exact patch preserves originals and no-hook native commit behavior', async t => {
  const f = await commandFixture(t), value = await f.native.selectModel(f.request);
  assert.deepEqual(value, { selected: { provider: 'fixture', model: 'two', reasoningEffort: 'high' } });
  assert.deepEqual(f.writes, [value.selected]); assert.deepEqual(f.saves, [value.selected]);
});
test('controller sends real immutable selection payload once and awaits hook, without default commit', async t => {
  const f = await commandFixture(t); let calls = 0; const gate = Promise.withResolvers();
  f.ctx.on('session/select-model', async (payload) => {
    calls++; assert.equal(payload.agent, f.agent); assert.ok(Object.isFrozen(payload)); assert.ok(Object.isFrozen(payload.selected));
    await gate.promise; return { selected: { ...payload.selected } };
  });
  let finished = false; const result = f.native.selectModel(f.request).then(value => { finished = true; return value; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false); assert.equal(calls, 1);
  assert.equal(f.writes.length, 0); gate.resolve(); await result;
  assert.equal(f.saves.length, 0);
});
test('controller hook async refusal reaches existing error boundary with zero commits', async t => {
  const f = await commandFixture(t);
  f.ctx.on('session/select-model', async () => { await Promise.resolve(); throw new Error('explicit fixture refusal'); });
  await assert.rejects(f.native.selectModel(f.request), /explicit fixture refusal/);
  assert.equal(f.writes.length, 0); assert.equal(f.saves.length, 0);
});
test('all controller patch inputs checked before any write; mixed state and old cached class fail capability', async () => {
  const a = fixture('bad'), first = join(a.packageDir, patchSpec.files[0].path), before = readFileSync(first);
  writeFileSync(join(a.packageDir, patchSpec.files[1].path), 'unknown');
  assert.throws(() => applyModelSelectionPatch({ packageDir: a.packageDir, receiptDir: join(a.root, 'receipt') }), /Unrecognized/);
  assert.deepEqual(readFileSync(first), before); assert.equal(existsSync(join(a.root, 'receipt')), false);
  const b = fixture('cached'), old = await import(pathToFileURL(join(b.packageDir, 'lib/index.js')).href);
  assert.equal(old.SessionController.modelSelectionSeam, undefined);
  const receipt = applyModelSelectionPatch({ packageDir: b.packageDir, receiptDir: join(b.root, 'receipt') });
  assert.equal(receipt.completed, true); assert.equal(inspectModelSelectionPatch(b.packageDir).state, 'patched');
  assert.equal((await import(pathToFileURL(join(b.packageDir, 'lib/index.js')).href)).SessionController.modelSelectionSeam, undefined);
  for (const file of patchSpec.files) assert.equal(sha(readFileSync(join(b.root, 'receipt/original', file.path))), file.beforeSha256);
  cpSync(join(b.root, 'receipt/original', patchSpec.files[1].path), join(b.packageDir, patchSpec.files[1].path));
  assert.throws(() => inspectModelSelectionPatch(b.packageDir), /Mixed/);
});
