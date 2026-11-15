import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });

export function createExactPackagePatch(patchSpecPath, { strictReceiptParent = true } = {}) {
  const patchSpec = JSON.parse(readFileSync(patchSpecPath, 'utf8'));
  function exactFile(packageDir, relativePath) {
    assert.ok(!isAbsolute(relativePath) && !relativePath.split(/[\\/]/u).includes('..'));
    let current = packageDir;
    for (const part of relativePath.split('/')) {
      current = join(current, part);
      assert.equal(lstatSync(current).isSymbolicLink(), false, `Refusing symlink: ${current}`);
    }
    assert.equal(lstatSync(current).isFile(), true);
    return current;
  }

  /** Verify all bytes before any write. Unknown/mixed versions are never repaired. */
  function inspect(packageDirectory) {
    assert.equal(typeof packageDirectory, 'string');
    const packageDir = resolve(packageDirectory);
    assert.equal(realpathSync(packageDir), packageDir, 'Package path must not traverse a symlink');
    const metadata = JSON.parse(readFileSync(exactFile(packageDir, 'package.json'), 'utf8'));
    assert.equal(metadata.name, patchSpec.package); assert.equal(metadata.version, patchSpec.version);
    const files = patchSpec.files.map(file => {
      const bytes = readFileSync(exactFile(packageDir, file.path)), actualSha256 = sha256(bytes);
      const state = actualSha256 === file.beforeSha256 ? 'original' : actualSha256 === file.afterSha256 ? 'patched' : 'unknown';
      assert.notEqual(state, 'unknown', `Unrecognized package bytes: ${file.path} (${actualSha256})`);
      return { path: file.path, actualSha256, state };
    });
    assert.equal(new Set(files.map(file => file.state)).size, 1, 'Mixed/partial patch state; preserve and inspect the prior receipt');
    return { patchId: patchSpec.id, packageDir, package: metadata.name, version: metadata.version,
      patchSpecSha256: sha256(readFileSync(patchSpecPath)), state: files[0].state, files };
  }

  function transformed(bytes, file) {
    let text = bytes.toString('utf8');
    assert.equal(sha256(bytes), file.beforeSha256);
    for (const edit of file.edits) {
      assert.equal(text.split(edit.before).length, 2, `Patch anchor must occur once: ${file.path}`);
      text = text.replace(edit.before, edit.after);
    }
    assert.equal(sha256(text), file.afterSha256, `Patch output differs: ${file.path}`);
    return text;
  }

  /** Back up original bytes first; emit an exclusive receipt for success or failure. */
  function apply({ packageDir, receiptDir }) {
    const before = inspect(packageDir);
    const destination = resolve(receiptDir);
    if (strictReceiptParent) assert.equal(realpathSync(dirname(destination)), dirname(destination), 'Receipt parent must not traverse a symlink');
    assert.ok(destination !== before.packageDir && !destination.startsWith(before.packageDir + sep), 'Receipt must be outside the package');
    const changes = before.state === 'original' ? patchSpec.files.map(file => {
      const path = exactFile(before.packageDir, file.path), bytes = readFileSync(path);
      return { file, path, bytes, after: transformed(bytes, file), mode: lstatSync(path).mode & 0o777 };
    }) : [];
    mkdirSync(destination, { mode: 0o700 }); // Existing evidence is never overwritten.
    save(join(destination, 'before.json'), before);
    const changedFiles = [];
    try {
      for (const change of changes) {
        const backup = join(destination, 'original', change.file.path);
        mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
        writeFileSync(backup, change.bytes, { flag: 'wx', mode: 0o600 });
      }
      // Recheck all input bytes after backups and before the first replacement.
      assert.deepEqual(inspect(before.packageDir), before);
      for (const change of changes) {
        assert.equal(sha256(readFileSync(change.path)), change.file.beforeSha256);
        const temporary = join(dirname(change.path), `.${basename(change.path)}.arcfold-patch-${randomUUID()}.tmp`);
        writeFileSync(temporary, change.after, { flag: 'wx', mode: change.mode });
        renameSync(temporary, change.path);
        changedFiles.push(change.file.path);
      }
      const after = inspect(before.packageDir); assert.equal(after.state, 'patched');
      const report = { completed: true, applied: changes.length > 0, changedFiles, before, after };
      save(join(destination, 'report.json'), report);
      return report;
    } catch (error) {
      save(join(destination, 'failure.json'), { completed: false, changedFiles,
        error: { name: error.name, message: error.message }, recovery: 'Do not auto-retry or roll back a partial install; inspect the preserved original bytes and receipt.' });
      throw error;
    }
  }

  return { patchSpec, inspect, apply };
}

export function runExactPatchCLI({ inspect, apply: applyPatch }, args) {
  let packageDir, receiptDir, apply = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--apply') { apply = true; continue; }
    assert.ok(['--package-dir', '--receipt-dir'].includes(flag), `Unknown option ${flag}`);
    const value = args[++index]; assert.ok(value && !value.startsWith('--'));
    if (flag === '--package-dir') packageDir = value; else receiptDir = value;
  }
  assert.ok(packageDir, 'Pass --package-dir for the new isolated npm package; no default installation is selected');
  if (apply) assert.ok(receiptDir, '--apply requires a new --receipt-dir');
  else assert.equal(receiptDir, undefined, '--receipt-dir requires --apply');
  console.log(JSON.stringify(apply ? applyPatch({ packageDir, receiptDir }) : inspect(packageDir), null, 2));
}
