import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { packageRelease } from '../scripts/package-release.mjs';

const sourceRoot = process.env.ARCFOLD_DESKTOP_PACKAGE_SOURCE;
const dependencyRoot = process.env.ARCFOLD_DESKTOP_PACKAGE_DEPENDENCIES;
const pythonArchive = process.env.ARCFOLD_DESKTOP_PYTHON_ARCHIVE;

test('Desktop release requires a stable number, and the local build keeps the source version', async () => {
  for (const version of [undefined, '0.3.0-beta.1', '00.3.0', '0.3.0+build']) {
    await assert.rejects(packageRelease({ target: 'desktop', version }), /stable --version/);
  }
  await assert.rejects(packageRelease({ version: '0.3.0' }), /Desktop distribution only/);
});

test('Desktop distribution builds an installable pair with a working offline counter', {
  skip: sourceRoot || dependencyRoot ? false : 'Requires the pinned Desktop source and matching frozen dependencies',
}, async t => {
  assert.ok(sourceRoot && dependencyRoot && pythonArchive, 'Supply the Desktop source, frozen dependencies and verified Python archive');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'arcfold-desktop-package-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outputDir = join(root, 'output');
  const desktopBuilder = await import(pathToFileURL(join(sourceRoot, 'scripts/package-release.mjs')));
  const release = await desktopBuilder.packageRelease({ sourceRoot, dependencyRoot, outputDir, sourceKind: 'candidate',
    target: 'desktop', version: '0.3.0', pythonArchive });
  assert.equal(release.target, 'desktop');
  assert.equal(release.host.dsh, '0.2.2-rc.1');
  assert.equal(release.version, '0.3.0');
  assert.equal(release.source.kind, 'candidate');
  assert.deepEqual(release.packages.map(pkg => pkg.name), ['@arcfold/dsh', '@arcfold/dsh-method-ui']);
  for (const [index, kind] of ['core', 'ui'].entries()) {
    const pkg = release.packages[index];
    assert.equal(pkg.version, release.version);
    const archive = join(outputDir, pkg.file);
    assert.equal(createHash('sha256').update(readFileSync(archive)).digest('hex'), pkg.sha256);
    const unpacked = join(root, kind);
    mkdirSync(unpacked);
    execFileSync('/usr/bin/tar', ['-xf', archive, '-C', unpacked]);
    const unpackedRoot = join(unpacked, 'package');
    const actual = desktopBuilder.validateReleasePackage(unpackedRoot, kind, [], 'desktop');
    assert.deepEqual(actual.files, pkg.files);
    assert.equal(actual.metadata.private, undefined);
    for (const notice of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
      assert.deepEqual(readFileSync(join(unpackedRoot, notice)), readFileSync(join(sourceRoot, notice)));
    }
    if (kind === 'core') {
      assert.equal(actual.metadata.dependencies['@arcfold/dsh-method-ui'], release.version);
      assert.equal(actual.metadata.dependencies['@deepseek-ai/dsh-llm-pi-ai'], undefined);
      const noticesRoot = join(unpackedRoot, 'src/desktop/third-party');
      const noticeManifestPath = join(noticesRoot, 'manifest.json');
      const noticeManifestBytes = readFileSync(noticeManifestPath);
      const noticeManifest = JSON.parse(noticeManifestBytes);
      assert.equal(noticeManifest.recipe.components.length, 332);
      assert.equal(noticeManifest.python.version, '3.12.14');
      const wheelPath = join(unpackedRoot, noticeManifest.recipe.archive.path);
      const wheelEntry = entry => execFileSync('/usr/bin/unzip', ['-p', wheelPath, entry], { maxBuffer: 2 * 1024 * 1024 });
      const sbomBytes = wheelEntry(noticeManifest.recipe.sbom.entry);
      assert.equal(createHash('sha256').update(sbomBytes).digest('hex'), noticeManifest.recipe.sbom.sha256);
      const sbom = JSON.parse(sbomBytes);
      const components = rows => rows.map(row => ({ name: row.name, version: row.version, licenses: row.licenses,
        sha256: row.archive_sha256 || row.hashes?.find(hash => hash.alg === 'SHA-256')?.content || null,
      })).sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
      assert.deepEqual(components(noticeManifest.recipe.components), components(sbom.components));
      for (const notice of noticeManifest.recipe.embedded_notices)
        assert.deepEqual(readFileSync(join(noticesRoot, notice.notice)), wheelEntry(notice.entry));
      // Exercise the actual unpacked tarball, including each independent notice source.
      for (const group of ['python/', 'cargo/', 'recipe/', 'rust/']) {
        const notice = noticeManifest.files.find(file => file.path.startsWith(group));
        assert.ok(notice, `Missing notice group ${group}`);
        const path = join(noticesRoot, notice.path), original = readFileSync(path);
        renameSync(path, path + '.held');
        assert.throws(() => desktopBuilder.validateReleasePackage(unpackedRoot, 'core', [], 'desktop'), /Missing or changed third-party notice/);
        renameSync(path + '.held', path);
        writeFileSync(path, Buffer.concat([original, Buffer.from('\nchanged\n')]));
        assert.throws(() => desktopBuilder.validateReleasePackage(unpackedRoot, 'core', [], 'desktop'), /Missing or changed third-party notice/);
        writeFileSync(path, original);
      }
      noticeManifest.recipe.components.pop();
      writeFileSync(noticeManifestPath, JSON.stringify(noticeManifest, null, 2) + '\n');
      assert.throws(() => desktopBuilder.validateReleasePackage(unpackedRoot, 'core', [], 'desktop'), /notice inventory differs/);
      writeFileSync(noticeManifestPath, noticeManifestBytes);
      assert.deepEqual(desktopBuilder.validateReleasePackage(unpackedRoot, 'core', [], 'desktop').files, actual.files);
      assert.doesNotMatch(readFileSync(join(unpackedRoot, 'cordis.patch.yml'), 'utf8'), /@arcfold\/dsh\/openai/u);
      const description = readFileSync(join(unpackedRoot, 'README.md'), 'utf8');
      assert.match(description, /Add plugin/u);
      assert.match(description, /model and reasoning setting chosen for that turn/u);
      assert.doesNotMatch(description, /Arcfold selects DeepSeek V4 Pro/u);
      const patch = readFileSync(join(unpackedRoot, 'cordis.patch.yml'), 'utf8');
      for (const id of ['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'agent-default-model'])
        assert.doesNotMatch(patch, new RegExp('^- id: ' + id + '$', 'm'), 'Desktop retains native ' + id);
      const { desktopPython, prepareBundledDesktopPython } = await import(pathToFileURL(join(unpackedRoot, 'src/desktop/python-runtime.mjs')));
      assert.deepEqual(release.desktopPython, desktopPython);
      const home = join(root, 'home');
      mkdirSync(home, { mode: 0o700 });
      const archivePath = join(unpackedRoot, desktopPython.path);
      const held = archivePath + '.held';
      renameSync(archivePath, held);
      assert.throws(() => prepareBundledDesktopPython(unpackedRoot, home), /缺少/);
      const corrupt = readFileSync(held);
      corrupt[0] ^= 1;
      writeFileSync(archivePath, corrupt);
      assert.throws(() => prepareBundledDesktopPython(unpackedRoot, home), /校验失败/);
      renameSync(held, archivePath);
      const python = prepareBundledDesktopPython(unpackedRoot, home);
      const counter = join(unpackedRoot, 'src/tree/token-counter.py'), modules = join(home, 'tokenizer');
      const run = (mode, input) => JSON.parse(execFileSync(python, ['-I', '-B', counter, mode, modules], {
        encoding: 'utf8', input, timeout: 30000, env: { TOKENIZERS_PARALLELISM: 'false' },
      }));
      assert.deepEqual(run('initialize'), { initialized: true });
      for (const [model, tokens] of [['deepseek-v4-pro', 90], ['deepseek-flash', 37]]) {
        const request = { model, max_tokens: 64, messages: [{ role: 'user',
          content: [{ type: 'text', text: '这是一条合成的离线计数消息。' }] }] };
        assert.deepEqual(run('count', JSON.stringify(request)), { tokens });
      }
      const inode = lstatSync(python).ino;
      assert.equal(prepareBundledDesktopPython(unpackedRoot, home), python);
      assert.equal(lstatSync(python).ino, inode, 'Resume reuses the existing executable');
      const dependency = join(home, 'arcfold-desktop-counter', desktopPython.sha256, 'python/lib/python3.12/json/__init__.py');
      for (const path of [python, dependency]) {
        const original = readFileSync(path);
        const changed = Buffer.from(original);
        changed[0] ^= 1;
        writeFileSync(path, changed);
        assert.throws(() => prepareBundledDesktopPython(unpackedRoot, home), /缓存校验失败/);
        writeFileSync(path, original);
      }
      assert.equal(prepareBundledDesktopPython(unpackedRoot, home), python);
    }
  }
});
