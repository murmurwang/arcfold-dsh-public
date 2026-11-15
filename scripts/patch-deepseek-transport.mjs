#!/usr/bin/env node
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createExactPackagePatch, runExactPatchCLI } from './exact-package-patch.mjs';

export const patchSpecPath = resolve(dirname(fileURLToPath(import.meta.url)), '../patches/deepseek-0.2.2-rc.1-transport.json');
const patch = createExactPackagePatch(patchSpecPath, { strictReceiptParent: false });
export const { patchSpec } = patch;
export const inspectDeepSeekPatch = patch.inspect;
export const applyDeepSeekPatch = patch.apply;
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runExactPatchCLI(patch, process.argv.slice(2)); }
  catch (error) { console.error(JSON.stringify({ completed: false, error: error.message })); process.exitCode = 1; }
}
