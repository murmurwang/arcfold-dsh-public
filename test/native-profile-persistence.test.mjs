import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function run(root, mode, phase) {
  const result = spawnSync(process.execPath, ['--expose-internals', fileURLToPath(new URL('./fixtures/native-profile/run.mjs', import.meta.url)), root, mode, phase], {
    encoding: 'utf8', timeout: 20000, env: { PATH: process.env.PATH, DSH_TELEMETRY_DISABLED: '1' },
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  const observed = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.deepEqual(observed.network, []);
  return observed;
}
function profile(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'arcfold-persistence-')));
  t.after(() => rmSync(root, { recursive: true, force: true })); return root;
}
test('stock DSH recomposition removes the in-memory-only activation control', t => {
  const observed = run(profile(t), 'memory-control', 'create');
  assert.equal(observed.activated, true);
  assert.equal(observed.persisted, false);
  assert.equal(observed.afterRefresh, false);
});
test('native profile configuration survives stock recomposition and a separate process restart', t => {
  const root = profile(t), created = run(root, 'candidate', 'create');
  assert.deepEqual(created.before, { service: false, state: 'needs_setup', legacy: true });
  assert.equal(created.activation, 'ready'); assert.equal(created.persisted, true);
  assert.equal(created.afterRefresh, true); assert.equal(created.status, 'ready');
  const restarted = run(root, 'candidate', 'restart');
  assert.equal(created.legacyAfterRefresh, false);
  assert.deepEqual(restarted.before, { service: true, state: 'configured', legacy: false });
  assert.equal(restarted.activation, 'ready'); assert.equal(restarted.afterRefresh, true);
  assert.equal(restarted.legacyAfterRefresh, false);
});
