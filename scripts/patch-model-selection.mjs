#!/usr/bin/env node
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createExactPackagePatch, runExactPatchCLI } from './exact-package-patch.mjs';

export const patchSpecPath = resolve(dirname(fileURLToPath(import.meta.url)), '../patches/session-controller-0.2.2-rc.1-model-selection.json');
const patch = createExactPackagePatch(patchSpecPath, { strictReceiptParent: true });
export const { patchSpec } = patch;
export const inspectModelSelectionPatch = patch.inspect;
export const applyModelSelectionPatch = patch.apply;
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runExactPatchCLI(patch, process.argv.slice(2)); }
  catch (error) { console.error(JSON.stringify({ completed: false, error: error.message })); process.exitCode = 1; }
}
