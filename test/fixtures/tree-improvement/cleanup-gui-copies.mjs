import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, cpSync, mkdirSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const base = dirname(fileURLToPath(import.meta.url));
for (const name of ['gui-run-1', 'gui-run-2', 'gui-run-3', 'gui-run-4', 'gui-run-5']) {
  const output = join(base, name), profile = join(output, 'profile'); if (!existsSync(profile)) continue;
  assert.equal(JSON.parse(readFileSync(join(output, 'shutdown.json'))).officialShutdownReturned, true);
  assert.ok(realpathSync(profile).startsWith(output + '/'));
  const manifest = JSON.parse(readFileSync(join(output, 'build.json'))); mkdirSync(join(output, 'compiled'), { recursive: true });
  for (const [entry, file, target] of [['gui-host.mjs', 'src/index.mjs', 'host.mjs'], ['gui-client.mjs', 'lib/client.js', 'client.js']]) {
    const actual = join(profile, 'node_modules/@arcfold/dsh-method-ui', file), bytes = readFileSync(actual); assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.hashes[entry].output); cpSync(actual, join(output, 'compiled', target));
  }
  rmSync(profile, { recursive: true }); writeFileSync(join(output, 'copy-cleanup.json'), JSON.stringify({ removedOnly: 'private copied profile after official shutdown', compiledBundlesPreserved: true }));
}
