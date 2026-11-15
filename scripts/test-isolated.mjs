import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { applyModelSelectionPatch } from './patch-model-selection.mjs';
import { applyPiAiPatch } from './patch-pi-ai-transport.mjs';
import { applyDeepSeekPatch } from './patch-deepseek-transport.mjs';

// Every check runs a private copy of this exact source and the declared frozen
// dependencies. Nothing is installed, downloaded or patched in the source host.
const source = dirname(dirname(fileURLToPath(import.meta.url)));
assert.ok(process.env.ARCFOLD_PATCH_TEST_INSTALLATION, 'A frozen dependency installation is required');
const lock = readFileSync(join(source, 'package-lock.json'));
// An explicitly declared second frozen installation lets concurrent branches
// use different dependency locks without weakening exact lock verification.
const installations = [process.env.ARCFOLD_PATCH_TEST_INSTALLATION, process.env.ARCFOLD_PATCH_TEST_INSTALLATION_ALTERNATE]
  .filter(Boolean).map(path => resolve(path));
const installation = installations.find(path => existsSync(join(path, 'package-lock.json')) &&
  lock.equals(readFileSync(join(path, 'package-lock.json'))));
assert.ok(installation, 'A declared dependency resource must match the candidate lockfile');
// macOS can expose its temporary directory through a symlink.
const temp = realpathSync(tmpdir());
const directory = mkdtempSync(join(temp, 'arcfold-metered-suite-'));
for (const path of ['src', 'test', 'scripts', 'patches', 'packages', 'presets', 'docs',
  'cordis.patch.yml', 'README.md', 'package.json', 'package-lock.json'])
  cpSync(join(source, path), join(directory, path), { recursive: true, errorOnExist: true, force: false });
for (const path of ['runtime', 'bin']) if (existsSync(join(source, path)))
  cpSync(join(source, path), join(directory, path), { recursive: true, errorOnExist: true, force: false });
if (process.platform === 'darwin')
  execFileSync('/bin/cp', ['-cR', join(installation, 'node_modules'), join(directory, 'node_modules')]);
else cpSync(join(installation, 'node_modules'), join(directory, 'node_modules'), { recursive: true });
applyDeepSeekPatch({ packageDir: join(directory, 'node_modules/@deepseek-ai/dsh-llm-deepseek'),
  receiptDir: join(directory, 'provider-patch-receipt') });
applyPiAiPatch({ packageDir: join(directory, 'node_modules/@deepseek-ai/dsh-llm-pi-ai'),
  receiptDir: join(directory, 'pi-ai-patch-receipt') });
applyModelSelectionPatch({ packageDir: join(directory, 'node_modules/@deepseek-ai/dsh-api-session-controller'),
  receiptDir: join(directory, 'model-selection-patch-receipt') });
execFileSync(process.execPath, ['packages/method-ui/build.mjs'], { cwd: directory, env: process.env, stdio: 'inherit' });
console.log(`Isolated test source and evidence: ${directory}`);
const files = process.argv.slice(2);
const child = spawnSync(process.execPath, ['--test', ...(files.length ? files : ['test/*.test.mjs'])], {
  cwd: directory, env: { ...process.env, TMPDIR: temp, ARCFOLD_PATCH_TEST_INSTALLATION: installation }, stdio: 'inherit',
});
if (child.error) throw child.error;
if (child.signal) throw new Error(`The test process ended with ${child.signal}`);
process.exitCode = child.status;
