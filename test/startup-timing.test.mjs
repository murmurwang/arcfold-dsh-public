import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StartupTiming, STARTUP_TIMING_FILE, STARTUP_TIMING_LIMIT } from '../src/startup-timing.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'arcfold-startup-timing-'));
  t.after(() => { try { chmodSync(root, 0o700); } catch {} rmSync(root, { recursive: true, force: true }); });
  return root;
}
function clock(values) { let i = 0; return () => values[Math.min(i++, values.length - 1)]; }
const lines = root => readFileSync(join(root, STARTUP_TIMING_FILE), 'utf8').trim().split('\n').map(line => JSON.parse(line));

test('a successful startup appends one line with every step and the host uptime', async t => {
  const root = fixture(t), logged = [];
  const timing = new StartupTiming({ directory: root, version: '9.9.9', now: clock([1000, 1000, 1200, 1200, 1700, 1750]),
    uptimeMs: () => 42000, logger: { info: message => logged.push(message) } });
  assert.equal(timing.step('open-tree', () => 'repo'), 'repo');
  assert.equal(await timing.step('recover', async () => 'done'), 'done');
  timing.finish();
  const [entry] = lines(root);
  assert.equal(entry.version, '9.9.9');
  assert.equal(entry.startedAt, new Date(1000).toISOString());
  assert.equal(entry.hostUptimeMs, 42000);
  assert.deepEqual(entry.steps, [{ name: 'open-tree', ms: 200 }, { name: 'recover', ms: 500 }]);
  assert.equal(entry.totalMs, 750);
  assert.equal(entry.result, 'ok');
  assert.equal(entry.failedStep, undefined);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /750/);
});

test('a failing step is recorded with its code and the original error still propagates', async t => {
  const root = fixture(t), timing = new StartupTiming({ directory: root, version: '1.0.0' });
  const error = Object.assign(new Error('A different learning epoch already advanced: secret conversation text'), { code: 'JOB_STALE' });
  timing.step('open-tree', () => null);
  await assert.rejects(() => timing.step('recover-replay-committed', async () => { throw error; }), error);
  timing.finish(error);
  const [entry] = lines(root);
  assert.equal(entry.result, 'failed');
  assert.equal(entry.failedStep, 'recover-replay-committed');
  assert.equal(entry.errorCode, 'JOB_STALE');
  assert.deepEqual(entry.steps.map(s => s.name), ['open-tree', 'recover-replay-committed']);
  assert.doesNotMatch(readFileSync(join(root, STARTUP_TIMING_FILE), 'utf8'), /secret conversation text/);
});

test('a synchronous throw is recorded the same way', t => {
  const root = fixture(t), timing = new StartupTiming({ directory: root, version: '1.0.0' });
  assert.throws(() => timing.step('open-tree', () => { throw new TypeError('bad'); }), TypeError);
  timing.finish(new TypeError('bad'));
  const [entry] = lines(root);
  assert.equal(entry.failedStep, 'open-tree');
  assert.equal(entry.errorCode, 'TypeError');
});

test('only the latest entries are kept', t => {
  const root = fixture(t);
  for (let i = 0; i < STARTUP_TIMING_LIMIT + 5; i++) {
    const timing = new StartupTiming({ directory: root, version: `0.0.${i}` });
    timing.step('open-tree', () => null); timing.finish();
  }
  const entries = lines(root);
  assert.equal(entries.length, STARTUP_TIMING_LIMIT);
  assert.equal(entries[0].version, '0.0.5');
  assert.equal(entries.at(-1).version, `0.0.${STARTUP_TIMING_LIMIT + 4}`);
});

test('an unwritable directory never breaks startup', { skip: process.getuid?.() === 0 }, t => {
  const root = fixture(t), directory = join(root, 'locked'), warned = [];
  mkdirSync(directory); chmodSync(directory, 0o500);
  const timing = new StartupTiming({ directory, version: '1.0.0', logger: { warn: message => warned.push(message) } });
  assert.equal(timing.step('open-tree', () => 7), 7);
  assert.doesNotThrow(() => timing.finish());
  assert.equal(existsSync(join(directory, STARTUP_TIMING_FILE)), false);
  assert.equal(warned.length, 1);
});

test('a damaged earlier file is replaced rather than blocking the record', t => {
  const root = fixture(t);
  writeFileSync(join(root, STARTUP_TIMING_FILE), 'not json\n{"version":"0.1.0"}\n');
  const timing = new StartupTiming({ directory: root, version: '1.0.0' });
  timing.finish();
  assert.deepEqual(lines(root).map(e => e.version), ['0.1.0', '1.0.0']);
});

test('finish records once even if called again', t => {
  const root = fixture(t), timing = new StartupTiming({ directory: root, version: '1.0.0' });
  timing.finish(); timing.finish(new Error('later'));
  assert.equal(lines(root).length, 1);
});

test('a real native-model tree runtime startup records each step', async t => {
  const { bootstrapFixture } = await import('./fixtures/tree-integration/bootstrap.mjs');
  const fixture = await bootstrapFixture(t, () => '合成回复', { nativeModels: true });
  const [entry] = lines(fixture.privateRoot);
  assert.equal(entry.result, 'ok');
  assert.equal(entry.version, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  assert.ok(Number.isInteger(entry.hostUptimeMs) && entry.hostUptimeMs >= 0);
  assert.deepEqual(entry.steps.map(step => step.name), ['evidence-lease', 'open-tree', 'model-adapter', 'create-runtime', 'model-records',
    'recover-read-sessions', 'recover-model-owner', 'recover-cancel-prepared', 'recover-settle-turns',
    'recover-learning-pressure', 'recover-replay-committed', 'recover-kick', 'start-workers']);
  assert.ok(entry.steps.every(step => Number.isInteger(step.ms) && step.ms >= 0));
});
