#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepareRuntimeSupply } from '../src/runtime-installation.mjs';

const options = {};
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i], value = process.argv[++i];
  assert.ok(['--release-dir', '--output', '--offline-store'].includes(flag) && value && !value.startsWith('--'));
  const key = { '--release-dir': 'releaseDir', '--output': 'outputDir', '--offline-store': 'offlineStore' }[flag];
  assert.equal(options[key], undefined, 'Duplicate option');
  options[key] = flag === '--offline-store' ? JSON.parse(readFileSync(value, 'utf8')) : value;
}
assert.ok(options.releaseDir && options.outputDir, 'Pass --release-dir and an entirely new --output directory');
const controller = new AbortController();
process.once('SIGINT', () => controller.abort(new Error('Preparation interrupted')));
process.once('SIGTERM', () => controller.abort(new Error('Preparation stopped')));
try { console.log(JSON.stringify(await prepareRuntimeSupply({ ...options, signal: controller.signal }))); }
catch (error) { console.error(JSON.stringify({ completed: false, error: error.message })); process.exitCode = 1; }
