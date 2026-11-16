import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function start(mode) {
  const child = spawnSync(process.execPath, ['--expose-internals', fileURLToPath(new URL('./fixtures/cold-start/run.mjs', import.meta.url)), mode], {
    encoding: 'utf8', timeout: 20000, env: { PATH: process.env.PATH, DSH_TELEMETRY_DISABLED: '1' },
  });
  assert.equal(child.status, 0, child.stderr || String(child.error));
  const result = JSON.parse(child.stdout.trim().split('\n').at(-1));
  assert.equal(result.hmrState, 2, 'the actual DSH HMR must be running');
  assert.deepEqual(result.networkAttempts, []);
  return result;
}

test('cold-start control reproduces the 0.5.1 late-import failure during native profile refresh', () => {
  const result = start('late-control');
  assert.equal(result.state, 3);
  assert.equal(result.reachedRuntimeValidation, false);
  assert.equal(result.error.code, 'ERR_INTERNAL_ASSERTION');
  assert.deepEqual(result.prematureEvictions, ['undici/index.js']);
});

test('the actual entry links before native refresh while consent and legacy storage checks remain', () => {
  const result = start('candidate');
  assert.equal(result.state, 2);
  assert.equal(result.reachedRuntimeValidation, true);
  assert.equal(result.error, null);
  assert.deepEqual(result.prematureEvictions, []);
  assert.equal(result.unconfirmedSetupBlocked, true);
  assert.equal(result.legacyRequiresExplicitStorage, true);
});
