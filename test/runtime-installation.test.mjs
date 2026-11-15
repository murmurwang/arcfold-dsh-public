import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import { PluginPackages, bundlePatchPaths, loadOverlayPatches, composeEntries, mountRootInclude } from '@deepseek-ai/dsh-app-boot';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installRelease, readInstallation, inspectNativeComponents, inspectBusinessSchema, materializeFrozenRuntime, freezeRuntimeSupply } from '../src/runtime-installation.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const bootstrap = JSON.parse(readFileSync(join(ROOT, 'runtime/bootstrap.json')));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (path, object) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(object, null, 2) + '\n'); };
const stamp = path => { const bytes = readFileSync(path); return { sha256: sha(bytes), bytes: bytes.length }; };
const fresh = () => realpathSync(mkdtempSync(join(tmpdir(), 'arcfold-installation-unit-')));

// Deliberately synthetic guard fixtures. No npm package is installed or supplied by these tests.
function releaseFixture(root) {
  const releaseDir = join(root, 'release'); mkdirSync(releaseDir);
  const packages = ['@arcfold/dsh', '@arcfold/dsh-method-ui'].map((name, index) => {
    const file = 'synthetic-' + index + '.tgz', bytes = Buffer.from('not an archive ' + index);
    writeFileSync(join(releaseDir, file), bytes);
    return { name, file, ...stamp(join(releaseDir, file)), integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') };
  });
  const manifest = { schema: 'arcfold-release-v1', source: { commit: 'a'.repeat(40) }, packages };
  save(join(releaseDir, 'manifest.json'), manifest);
  const supplyDir = join(root, 'supply'), files = [];
  for (const path of ['host/package.json', 'host/pnpm-lock.yaml', 'host/pnpm-workspace.yaml', 'profile/package.json', 'profile/pnpm-lock.yaml', 'profile/pnpm-workspace.yaml', 'packages.json']) {
    const full = join(supplyDir, path); save(full, {}); files.push({ path, ...stamp(full) });
  }
  save(join(supplyDir, 'supply.json'), { schema: 'arcfold-runtime-supply-v1', ready: true, bootstrap, sourceCommit: manifest.source.commit,
    releaseManifestSHA: stamp(join(releaseDir, 'manifest.json')).sha256, files });
  return { releaseDir, supplyManifest: join(supplyDir, 'supply.json') };
}

test('archive identity failure happens before stage creation or network', async t => {
  const root = fresh(), input = releaseFixture(root), destination = join(root, 'installation'); let requests = 0;
  t.mock.method(globalThis, 'fetch', () => { requests++; throw new Error('Network forbidden in guard test'); });
  writeFileSync(join(input.releaseDir, 'synthetic-0.tgz'), 'changed');
  await assert.rejects(installRelease({ ...input, installationDir: destination }));
  assert.equal(existsSync(destination), false); assert.equal(requests, 0);
});

test('an existing failed stage is preserved and never retried or overwritten', async t => {
  const root = fresh(), input = releaseFixture(root), destination = join(root, 'installation'); mkdirSync(destination);
  const original = '{"failed":"preserve this attempt"}\n'; writeFileSync(join(destination, 'failure.json'), original);
  let requests = 0; t.mock.method(globalThis, 'fetch', () => { requests++; throw new Error('Network forbidden'); });
  await assert.rejects(installRelease({ ...input, installationDir: destination }), /EEXIST/);
  assert.equal(readFileSync(join(destination, 'failure.json'), 'utf8'), original); assert.equal(requests, 0);
});

test('a substituted companion lock is rejected before creating installation state', async () => {
  const root = fresh(), input = releaseFixture(root), destination = join(root, 'installation');
  writeFileSync(join(root, 'supply/host/pnpm-lock.yaml'), 'different lock');
  await assert.rejects(installRelease({ ...input, installationDir: destination })); assert.equal(existsSync(destination), false);
});

test('bad offline pnpm input leaves a failed stage and never falls back to public download', async t => {
  const root = fresh(), input = releaseFixture(root), destination = join(root, 'installation');
  const storeDir = join(root, 'store-input'), cacheDir = join(root, 'metadata-input'), pnpmArchive = join(root, 'bad-pnpm.tgz');
  mkdirSync(storeDir); mkdirSync(cacheDir); writeFileSync(pnpmArchive, 'bad'); writeFileSync(join(cacheDir, 'metadata.json'), '{"original":true}\n');
  let requests = 0; t.mock.method(globalThis, 'fetch', () => { requests++; throw new Error('Network forbidden'); });
  await assert.rejects(installRelease({ ...input, installationDir: destination, offlineStore: { storeDir, cacheDir, pnpmArchive } }));
  assert.equal(JSON.parse(readFileSync(join(destination, 'failure.json'))).stage, 'bootstrap'); assert.equal(requests, 0);
  assert.equal(readFileSync(pnpmArchive, 'utf8'), 'bad');
  assert.equal(readFileSync(join(cacheDir, 'metadata.json'), 'utf8'), '{"original":true}\n');
  assert.equal(readFileSync(join(destination, 'cache/metadata.json'), 'utf8'), '{"original":true}\n');
});

function installationFixture(dual = false, selection = false) {
  const root = fresh(), profile = 'bootstrap-home/profiles/arcfold';
  const paths = ['host/node_modules/host-package/package.json', 'host/node_modules/host-package/bin.mjs',
    profile + '/node_modules/@arcfold/dsh/package.json', profile + '/node_modules/@arcfold/dsh/src/index.mjs',
    profile + '/node_modules/@arcfold/dsh-method-ui/package.json', profile + '/node_modules/provider/package.json',
    'tooling/package/bin/pnpm.mjs'];
  if (dual) paths.push(profile + '/node_modules/pi-ai/package.json');
  const controllerPrefix = 'host/node_modules/controller/';
  if (selection) paths.push(controllerPrefix + 'package.json', controllerPrefix + 'lib/index.js', controllerPrefix + 'lib/types/index.d.ts',
    profile + '/node_modules/@arcfold/dsh/patches/session-controller-0.2.2-rc.1-model-selection.json');
  const rows = [];
  for (const path of paths.sort()) {
    const full = join(root, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, 'synthetic installed bytes\n', { mode: 0o600 });
    if (dual && /node_modules\/(?:provider|pi-ai)\/package.json$/.test(path))
      save(full, { name: path.includes('/pi-ai/') ? '@deepseek-ai/dsh-llm-pi-ai' : '@deepseek-ai/dsh-llm-deepseek', version: '0.2.2-rc.1' });
    if (selection && path.startsWith(controllerPrefix)) cpSync(join(ROOT, 'node_modules/@deepseek-ai/dsh-api-session-controller', path.slice(controllerPrefix.length)), full);
    if (selection && path.endsWith('/patches/session-controller-0.2.2-rc.1-model-selection.json')) cpSync(join(ROOT, 'patches/session-controller-0.2.2-rc.1-model-selection.json'), full);
    rows.push({ path, ...stamp(full), executable: 0 });
  }
  // Match the installer's three complete tree inventories, then its explicitly bound configuration files.
  const ordered = ['host/node_modules/', profile + '/node_modules/', 'tooling/package/'].flatMap(prefix => rows.filter(row => row.path.startsWith(prefix)));
  for (const path of ['host/package.json', 'host/pnpm-lock.yaml', 'host/pnpm-workspace.yaml', profile + '/package.json', profile + '/pnpm-lock.yaml', profile + '/pnpm-workspace.yaml', profile + '/cordis.patch.yml']) {
    const full = join(root, path); writeFileSync(full, '{}\n'); ordered.push({ path, ...stamp(full) });
  }
  ordered.sort((a, b) => a.path.localeCompare(b.path)); save(join(root, 'installation-files.json'), ordered);
  save(join(root, 'dependency-consumers.json'), [{ owner: { name: 'synthetic-package', scope: 'host' }, requires: [] }]);
  const receipt = { schema: 'arcfold-installation-v1', installationDir: root, hostRoot: join(root, 'host'),
    installAnchor: join(root, 'host/node_modules/host-package/package.json'), cliPath: join(root, 'host/node_modules/host-package/bin.mjs'), profileDir: join(root, profile), profileName: 'arcfold',
    coreRoot: join(root, profile, 'node_modules/@arcfold/dsh'), uiRoot: join(root, profile, 'node_modules/@arcfold/dsh-method-ui'),
    provider: { path: join(root, profile, 'node_modules/provider') }, compatibility: { businessSchema: 1, nativeFormat: 4 },
    packageManager: { command: process.execPath, args: [join(root, 'tooling/package/bin/pnpm.mjs')] },
    identities: { bootstrap, node: { path: process.execPath, ...stamp(process.execPath) },
      consumers: { path: 'dependency-consumers.json', ...stamp(join(root, 'dependency-consumers.json')), count: 1 },
      fileManifest: { path: 'installation-files.json', ...stamp(join(root, 'installation-files.json')), count: ordered.length } } };
  if (dual) {
    receipt.providers = {};
    for (const [key, folder, patchFolder] of [['deepseek-official', 'provider', 'provider-patch'], ['openai', 'pi-ai', 'pi-ai-patch']]) {
      const entry = { path: join(root, profile, 'node_modules', folder), patchId: 'synthetic-' + key, receipt: join(root, patchFolder, 'report.json') };
      save(entry.receipt, { completed: true, after: { state: 'patched', packageDir: entry.path, patchId: entry.patchId } });
      entry.receiptSHA256 = stamp(entry.receipt).sha256; receipt.providers[key] = entry;
    }
    receipt.provider = receipt.providers['deepseek-official'];
  }
  if (selection) {
    const manifest = join(receipt.coreRoot, 'patches/session-controller-0.2.2-rc.1-model-selection.json');
    const spec = JSON.parse(readFileSync(manifest));
    const entry = { path: join(root, 'host/node_modules/controller'), patchId: spec.id, receipt: join(root, 'model-selection-patch/report.json') };
    save(entry.receipt, { completed: true, after: { state: 'patched', packageDir: entry.path, patchId: spec.id, patchSpecSha256: stamp(manifest).sha256 } });
    entry.receiptSHA256 = stamp(entry.receipt).sha256; receipt.modelSelection = entry;
  }
  save(join(root, 'installation.json'), receipt); return { root, receipt, path: join(root, 'installation.json') };
}

test('read-only installation check binds complete code trees and rejects newly shadowing files', () => {
  const fixture = installationFixture();
  assert.equal(readInstallation(fixture.path).compatibility.nativeFormat, 4);
  const extra = join(fixture.root, 'host/node_modules/host-package/new-dependency.mjs'); writeFileSync(extra, 'unrecorded');
  assert.throws(() => readInstallation(fixture.path), /Installed code or profile assets changed/);
});

test('read-only check rejects changed code and unsupported native-format claims', () => {
  const fixture = installationFixture();
  writeFileSync(join(fixture.receipt.coreRoot, 'src/index.mjs'), 'modified');
  assert.throws(() => readInstallation(fixture.path), /Installed code or profile assets changed/);
  const other = installationFixture(); other.receipt.compatibility.nativeFormat = 3; save(other.path, other.receipt);
  assert.throws(() => readInstallation(other.path));
});

test('old receipts stay readable without inventing OpenAI proof; dual receipts bind both paths and patch receipts', () => {
  assert.equal(readInstallation(installationFixture().path).providers, undefined);
  const fixture = installationFixture(true), read = readInstallation(fixture.path);
  assert.deepEqual(read.provider, read.providers['deepseek-official']);
  assert.equal(read.providers.openai.patchId, 'synthetic-openai');
  writeFileSync(read.providers.openai.receipt, '{}\n');
  assert.throws(() => readInstallation(fixture.path), /patch receipt changed/);
});

test('partial, divergent and escaped dual proofs are rejected', () => {
  for (const mutate of [
    receipt => { delete receipt.providers.openai; },
    receipt => { receipt.provider = { ...receipt.provider, patchId: 'different' }; },
    receipt => { receipt.providers.openai.path = receipt.hostRoot; },
    receipt => { receipt.providers.openai.receipt = join(fresh(), 'report.json'); },
  ]) {
    const fixture = installationFixture(true); mutate(fixture.receipt); save(fixture.path, fixture.receipt);
    assert.throws(() => readInstallation(fixture.path));
  }
});

test('complete dual manifests reject changed pi-ai bytes and newly shadowing nested copies', () => {
  const changed = installationFixture(true);
  writeFileSync(join(changed.receipt.providers.openai.path, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm-pi-ai', version: '0.2.2-rc.1', altered: true }));
  assert.throws(() => readInstallation(changed.path), /Installed code or profile assets changed/);
  const nested = installationFixture(true);
  save(join(nested.receipt.coreRoot, 'node_modules/@deepseek-ai/dsh-llm-pi-ai/package.json'), { name: '@deepseek-ai/dsh-llm-pi-ai' });
  assert.throws(() => readInstallation(nested.path), /Installed code or profile assets changed/);
});

const nativeDefinitions = [
  { key: 'deepseek-official', name: 'dsh-llm-deepseek', wrapper: 'deepseek-provider', script: 'patch-deepseek-transport',
    spec: 'deepseek-0.2.2-rc.1-transport.json' },
  { key: 'openai', name: 'dsh-llm-pi-ai', wrapper: 'openai-provider', script: 'patch-pi-ai-transport',
    spec: 'pi-ai-0.2.2-rc.1-transport.json' },
  { key: 'modelSelection', name: 'dsh-api-session-controller', script: 'patch-model-selection',
    spec: 'session-controller-0.2.2-rc.1-model-selection.json' },
];
function restoreOriginal(directory, spec) {
  for (const item of spec.files) {
    const path = join(directory, item.path); let text = readFileSync(path, 'utf8');
    assert.equal(sha(text), item.afterSha256, 'The isolated test harness supplies patched dependencies');
    for (const edit of [...item.edits].reverse()) {
      assert.equal(text.split(edit.after).length, 2); text = text.replace(edit.after, edit.before);
    }
    assert.equal(sha(text), item.beforeSha256); writeFileSync(path, text);
  }
}
function nativeFixture() {
  const installationDir = fresh(), profileDir = join(installationDir, 'profile'), modules = join(profileDir, 'node_modules');
  mkdirSync(join(modules, '@deepseek-ai'), { recursive: true });
  // Real package bytes and their real dependencies; only packageOf's already-established resolver is a seam.
  for (const name of readdirSync(join(ROOT, 'node_modules'))) {
    if (name === '@deepseek-ai') {
      for (const entry of readdirSync(join(ROOT, 'node_modules', name))) {
        const from = join(ROOT, 'node_modules', name, entry), to = join(modules, name, entry);
        if (nativeDefinitions.some(row => row.name === entry)) cpSync(from, to, { recursive: true });
        else symlinkSync(from, to);
      }
    } else symlinkSync(join(ROOT, 'node_modules', name), join(modules, name));
  }
  const coreRoot = join(modules, '@arcfold/dsh'); mkdirSync(coreRoot, { recursive: true });
  // Copy the patchers' real local helper closure, including a shared helper when present.
  cpSync(join(ROOT, 'scripts'), join(coreRoot, 'scripts'), { recursive: true });
  const targets = {}, specs = {}, resolutions = [];
  for (const row of nativeDefinitions) {
    for (const path of ['patches/' + row.spec, ...(row.wrapper ? ['src/' + row.wrapper + '.mjs'] : [])]) {
      mkdirSync(dirname(join(coreRoot, path)), { recursive: true }); cpSync(join(ROOT, path), join(coreRoot, path));
    }
    targets[row.key] = join(modules, '@deepseek-ai', row.name);
    specs[row.key] = JSON.parse(readFileSync(join(coreRoot, 'patches', row.spec)));
    restoreOriginal(targets[row.key], specs[row.key]);
  }
  const api = { packageOf(name, parent) {
    const row = nativeDefinitions.find(row => '@deepseek-ai/' + row.name === name); assert.ok(row);
    assert.equal(parent, row.wrapper ? pathToFileURL(join(coreRoot, 'src', row.wrapper + '.mjs')).href : pathToFileURL(profileDir).href + '/');
    resolutions.push({ name, parent }); return { dir: targets[row.key] };
  } };
  const require = createRequire(import.meta.url);
  const layers = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'].map(name => {
    const root = dirname(require.resolve(name + '/package.json')), manifest = JSON.parse(readFileSync(join(root, 'package.json')));
    return bundlePatchPaths(root, manifest.dsh.bundle).flatMap(path => loadOverlayPatches('controller-install-fixture', path));
  });
  const profileEntries = composeEntries(layers);
  return { installationDir, profileDir, coreRoot, api, targets, specs, resolutions, profileEntries };
}
function assertOriginal(fixture, key) {
  for (const item of fixture.specs[key].files) assert.equal(stamp(join(fixture.targets[key], item.path)).sha256, item.beforeSha256);
}

test('all three actual consuming packages are inspected before patching, with separate receipts and loaded capabilities', async t => {
  const fixture = nativeFixture(); t.diagnostic('Retained real-package installation seam: ' + fixture.installationDir);
  const dry = await inspectNativeComponents(fixture);
  assert.deepEqual(Object.keys(dry.providers), ['deepseek-official', 'openai']);
  assert.equal(dry.providers.openai.receipt, undefined); assert.equal(dry.modelSelection.receipt, undefined);
  for (const key of Object.keys(fixture.targets)) assertOriginal(fixture, key);
  const result = await inspectNativeComponents({ ...fixture, patch: true });
  const patched = { ...result.providers, modelSelection: result.modelSelection };
  for (const key of Object.keys(patched)) {
    assert.equal(patched[key].path, fixture.targets[key]);
    assert.equal(patched[key].patchId, fixture.specs[key].id);
    assert.equal(patched[key].receiptSHA256, stamp(patched[key].receipt).sha256);
    const report = JSON.parse(readFileSync(patched[key].receipt));
    assert.equal(report.changedFiles.length, key === 'modelSelection' ? 2 : 3); assert.equal(report.before.state, 'original'); assert.equal(report.after.state, 'patched');
    const loaded = await import(pathToFileURL(join(patched[key].path, 'lib/index.js')));
    const capability = fixture.specs[key].runtimeCapability;
    assert.equal(loaded[capability.export][capability.property], capability.value);
  }
  const originalReceipt = readFileSync(patched.openai.receipt);
  await assert.rejects(inspectNativeComponents({ ...fixture, patch: true }), /exact original/);
  assert.deepEqual(readFileSync(patched.openai.receipt), originalReceipt);
});

test('missing, host-copy, resolver mismatch, mixed and unknown pi-ai fail before the first patch write', async () => {
  for (const failure of ['missing', 'host-copy', 'resolver-mismatch', 'mixed', 'unknown']) {
    const fixture = nativeFixture(), pi = fixture.targets.openai;
    if (failure === 'missing') rmSync(pi, { recursive: true });
    if (failure === 'host-copy' || failure === 'resolver-mismatch') {
      const alternate = join(fixture.installationDir, failure === 'host-copy' ? 'host' : 'profile/other', 'pi-ai');
      mkdirSync(dirname(alternate), { recursive: true }); cpSync(pi, alternate, { recursive: true }); fixture.targets.openai = alternate;
    }
    if (failure === 'mixed') {
      const item = fixture.specs.openai.files[0];
      cpSync(join(ROOT, 'node_modules/@deepseek-ai/dsh-llm-pi-ai', item.path), join(pi, item.path));
    }
    if (failure === 'unknown') writeFileSync(join(pi, fixture.specs.openai.files[0].path), 'unrecognized bytes');
    await assert.rejects(inspectNativeComponents({ ...fixture, patch: true }));
    assertOriginal(fixture, 'deepseek-official');
    assert.equal(existsSync(join(fixture.installationDir, 'provider-patch')), false);
    assert.equal(existsSync(join(fixture.installationDir, 'pi-ai-patch')), false);
  }
});

test('cached unpatched pi-ai cannot pass even after both exact disk patches succeed', async () => {
  const fixture = nativeFixture();
  const original = await import(pathToFileURL(join(fixture.targets.openai, 'lib/index.js')));
  assert.equal(original.PiAiAdapter.transportSeam, undefined);
  await assert.rejects(inspectNativeComponents({ ...fixture, patch: true }), /loaded native component lacks/);
  for (const folder of ['provider-patch', 'pi-ai-patch']) assert.equal(JSON.parse(readFileSync(join(fixture.installationDir, folder, 'report.json'))).completed, true);
  assert.equal(existsSync(join(fixture.installationDir, 'installation.json')), false);
});

test('a second receipt collision preserves the first patch and the original failure directory', async () => {
  const fixture = nativeFixture(), prior = join(fixture.installationDir, 'pi-ai-patch');
  mkdirSync(prior); writeFileSync(join(prior, 'failure.json'), 'preserved failure\n');
  await assert.rejects(inspectNativeComponents({ ...fixture, patch: true }), /EEXIST/);
  assert.equal(JSON.parse(readFileSync(join(fixture.installationDir, 'provider-patch/report.json'))).completed, true);
  assertOriginal(fixture, 'openai');
  assert.equal(readFileSync(join(prior, 'failure.json'), 'utf8'), 'preserved failure\n');
});

test('business schema inspection runs the installed Store in memory and rejects a different actual schema', async () => {
  await inspectBusinessSchema(ROOT);
  const root = fresh(); mkdirSync(join(root, 'src'));
  const replacement = [
    'import { Store as Original } from ' + JSON.stringify(pathToFileURL(join(ROOT, 'src/store.mjs')).href) + ';',
    'export class Store extends Original {',
    '  constructor(filename) {',
    "    if (filename !== ':memory:') throw Error('Persistent database forbidden');",
    '    super(filename);',
    '    this.db.prepare("UPDATE business_meta SET value=\\\'2\\\' WHERE key=\\\'schema_version\\\'").run();',
    '  }',
    '}',
  ].join('\n');
  writeFileSync(join(root, 'src/store.mjs'), replacement);
  await assert.rejects(inspectBusinessSchema(root), /'2' !== '1'/);
  assert.deepEqual(readdirSync(root), ['src']);
});


test('old receipts have no controller authority; new proof binds exact manifest bytes and independent receipt', () => {
  assert.equal(readInstallation(installationFixture().path).modelSelection, undefined);
  assert.equal(readInstallation(installationFixture(true).path).modelSelection, undefined);
  const f = installationFixture(true, true), read = readInstallation(f.path);
  assert.equal(read.modelSelection.patchId, 'arcfold-session-controller-0.2.2-rc.1-model-selection-v1');
  assert.deepEqual(read.provider, read.providers['deepseek-official']);
  writeFileSync(read.modelSelection.receipt, '{}\n');
  assert.throws(() => readInstallation(f.path), /Controller patch receipt changed/);
});

test('controller proof rejects wrong package path manifest bytes and shadowing nested copies', () => {
  for (const change of [
    f => { f.receipt.modelSelection.patchId = 'wrong'; save(f.path, f.receipt); },
    f => { f.receipt.modelSelection.path = f.receipt.providers.openai.path; save(f.path, f.receipt); },
    f => writeFileSync(join(f.receipt.modelSelection.path, 'lib/index.js'), 'unknown controller'),
    f => save(join(f.receipt.profileDir, 'node_modules/@deepseek-ai/dsh-api-session-controller/package.json'), { name: 'shadow' }),
  ]) {
    const f = installationFixture(true, true); change(f); assert.throws(() => readInstallation(f.path));
  }
});

test('controller unknown mixed missing wrong consuming copy and replacement entry refuse all three patches', async () => {
  for (const failure of ['missing', 'foreign', 'mismatch', 'mixed', 'unknown', 'entry']) {
    const f = nativeFixture(), controller = f.targets.modelSelection;
    if (failure === 'missing') rmSync(controller, { recursive: true });
    if (failure === 'foreign' || failure === 'mismatch') {
      const alternate = join(failure === 'foreign' ? fresh() : f.installationDir, 'alternate-controller');
      cpSync(controller, alternate, { recursive: true }); f.targets.modelSelection = alternate;
    }
    if (failure === 'mixed') cpSync(join(ROOT, 'node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js'), join(controller, 'lib/index.js'));
    if (failure === 'unknown') writeFileSync(join(controller, 'lib/index.js'), 'unknown bytes');
    if (failure === 'entry') f.profileEntries.find(e => e.id === 'session-controller').name = 'unowned-controller';
    await assert.rejects(inspectNativeComponents({ ...f, patch: true }));
    for (const key of ['deepseek-official', 'openai']) assertOriginal(f, key);
    for (const folder of ['provider-patch', 'pi-ai-patch', 'model-selection-patch']) assert.equal(existsSync(join(f.installationDir, folder)), false);
  }
});

test('cached original controller cannot pass loaded proof after all exact disk patches', async () => {
  const f = nativeFixture();
  const old = await import(pathToFileURL(join(f.targets.modelSelection, 'lib/index.js')));
  assert.equal(old.SessionController.modelSelectionSeam, undefined);
  await assert.rejects(inspectNativeComponents({ ...f, patch: true }), /loaded native component lacks/);
  for (const folder of ['provider-patch', 'pi-ai-patch', 'model-selection-patch'])
    assert.equal(JSON.parse(readFileSync(join(f.installationDir, folder, 'report.json'))).completed, true);
  assert.equal(existsSync(join(f.installationDir, 'installation.json')), false);
});

test('actual official profile resolver and Include consume the patched host controller without a wrapper importer', async t => {
  const f = nativeFixture(), hostModules = join(f.installationDir, 'host/node_modules');
  mkdirSync(join(hostModules, '@deepseek-ai'), { recursive: true });
  const hostController = join(hostModules, '@deepseek-ai/dsh-api-session-controller');
  cpSync(f.targets.modelSelection, hostController, { recursive: true }); rmSync(f.targets.modelSelection, { recursive: true });
  for (const name of readdirSync(join(ROOT, 'node_modules'))) {
    if (name === '@deepseek-ai') {
      for (const child of readdirSync(join(ROOT, 'node_modules', name))) if (child !== 'dsh-api-session-controller')
        symlinkSync(join(ROOT, 'node_modules', name, child), join(hostModules, name, child));
    } else symlinkSync(join(ROOT, 'node_modules', name), join(hostModules, name));
  }
  const ctx = new Context(); t.after(async () => ctx.fiber.dispose());
  // Real official resolution interception, with a bounded host/profile package
  // inventory fixture. This does not claim a full standalone installation.
  await ctx.plugin(PluginPackages, { resolution: {
    profilesDir: dirname(f.profileDir), profileDir: f.profileDir, localPackageNames: [], linkedRoots: [],
    entries: [{ name: '@deepseek-ai/dsh-api-session-controller', version: '0.2.2-rc.1',
      packageDir: hostController, declarer: join(f.installationDir, 'host/package.json'), scope: 'installation' }],
  } });
  const proof = await inspectNativeComponents({ ...f, api: ctx.pluginPackages, patch: true });
  assert.equal(proof.modelSelection.path, hostController);
  const filename = join(f.profileDir, 'cordis.yml'); writeFileSync(filename, '[]\n');
  await ctx.plugin(Loader);
  await mountRootInclude(ctx, filename, [{ insert: [f.profileEntries.find(e => e.id === 'session-controller')] }]);
  await ctx.loader.await();
  const entry = [...ctx.loader.entries()].find(e => e.options.id === 'session-controller');
  assert.ok(entry); assert.equal(entry.parent.tree.ctx.baseUrl, pathToFileURL(f.profileDir).href + '/');
  const actual = await entry.parent.tree.import(entry.options.name);
  const proved = await import(pathToFileURL(join(proof.modelSelection.path, 'lib/index.js')));
  assert.equal(actual.SessionController, proved.SessionController);
  assert.equal(actual.SessionController.modelSelectionSeam, 'session-model-selection-commit-v1');
  save(join(f.installationDir, 'model-selection-consumption.json'), {
    parentURL: entry.parent.tree.ctx.baseUrl, entryId: entry.options.id, specifier: entry.options.name,
    actualPackagePath: ctx.pluginPackages.packageOf(entry.options.name, entry.parent.tree.ctx.baseUrl).dir,
    proof: proof.modelSelection, loadedCapability: actual.SessionController.modelSelectionSeam,
    loaderAndProvedClassIdentical: actual.SessionController === proved.SessionController,
  });
  t.diagnostic('Retained actual host-controller consuming proof: ' + f.installationDir);
});


test('any one bad original leaves every target byte and all three receipt locations untouched', async () => {
  for (const broken of ['deepseek-official', 'openai', 'modelSelection']) {
    const f = nativeFixture(); writeFileSync(join(f.targets[broken], f.specs[broken].files[0].path), 'unrecognized original');
    const snapshot = () => Object.fromEntries(Object.keys(f.targets).map(key => [key,
      f.specs[key].files.map(item => stamp(join(f.targets[key], item.path)).sha256)]));
    const before = snapshot();
    await assert.rejects(inspectNativeComponents({ ...f, patch: true }));
    assert.deepEqual(snapshot(), before);
    for (const folder of ['provider-patch', 'pi-ai-patch', 'model-selection-patch']) assert.equal(existsSync(join(f.installationDir, folder)), false);
  }
});

function frozenFixture() {
  const root = fresh(), original = join(root, 'resolved'), stage = join(root, 'replay'), inputs = join(root, 'inputs');
  const fixture = releaseFixture(root), manifest = JSON.parse(readFileSync(join(fixture.releaseDir, 'manifest.json')));
  const release = { root: fixture.releaseDir, manifest, manifestSHA: stamp(join(fixture.releaseDir, 'manifest.json')).sha256 };
  for (const directory of [original, stage, join(stage, 'commands'), join(stage, 'host'), join(stage, 'release'), join(stage, 'home')]) mkdirSync(directory);
  // These two layouts intentionally have the same unique versions but different instance sharing.
  const layout = [
    { path: 'consumer-a', name: 'consumer-a', version: '1.0.0', dependencies: { shared: '1.0.0' } },
    { path: 'consumer-b', name: 'consumer-b', version: '1.0.0', dependencies: { shared: '2.0.0' } },
    { path: 'consumer-c', name: 'consumer-c', version: '1.0.0', dependencies: { shared: '2.0.0' } },
    { path: 'shared', name: 'shared', version: '2.0.0' },
    { path: 'consumer-a/node_modules/shared', name: 'shared', version: '1.0.0' },
  ];
  const initial = layout.filter(row => !row.path.includes('shared')).concat([
    { path: 'shared', name: 'shared', version: '1.0.0' },
    { path: 'consumer-b/node_modules/shared', name: 'shared', version: '2.0.0' },
    { path: 'consumer-c/node_modules/shared', name: 'shared', version: '2.0.0' },
  ]);
  for (const { path, ...pkg } of initial) save(join(original, 'node_modules', path, 'package.json'), pkg);
  for (const scope of ['host', 'profile']) {
    save(join(inputs, scope, 'package.json'), { name: 'synthetic-' + scope, dependencies: scope === 'profile'
      ? Object.fromEntries(manifest.packages.map(pkg => [pkg.name, 'file:__ARCFOLD_RELEASE_ROOT__/' + pkg.file])) : {} });
    save(join(inputs, scope, 'pnpm-lock.yaml'), { layout: scope === 'profile' ? layout : [] });
    save(join(inputs, scope, 'pnpm-workspace.yaml'), { nodeLinker: 'hoisted', autoInstallPeers: false });
  }
  // A scripted package-manager boundary, not pnpm or an official host installation.
  // Production materializeFrozenRuntime still executes its real subprocess and hash guards.
  const manager = String.raw`
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const write = (path, value) => { mkdirSync(dirname(path), {recursive:true}); writeFileSync(path, value); };
const save = (path, value) => write(path, JSON.stringify(value)+'\n');
assert.equal(process.env.npm_config_offline, 'true');
const root = process.cwd(), args = process.argv.slice(2), home = process.env.DSH_HOME;
const profile = join(home, 'profiles/arcfold');
if (args[0] === '--profile') {
  assert.deepEqual(args, ['--profile','arcfold','--from-default-profile','web','--dump-config']);
  save(join(profile,'package.json'), {dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']}}});
  save(join(profile,'pnpm-workspace.yaml'), {nodeLinker:'hoisted',autoInstallPeers:false});
} else {
  const host = args[0] === 'install', directory = host ? root : profile;
  assert.deepEqual(args, host ? ['install','--frozen-lockfile','--ignore-scripts'] :
    ['plugin','--profile','arcfold','install','--frozen-lockfile','--ignore-scripts']);
  const lock = JSON.parse(readFileSync(join(directory,'pnpm-lock.yaml')));
  if (lock.fail) throw new Error('scripted frozen materialization failure');
  if (host) {
    save(join(directory,'node_modules/@deepseek-ai/dsh/package.json'), {name:'@deepseek-ai/dsh',version:'0.2.2-rc.1',exports:{'./package.json':'./package.json','./lib/bin.js':'./lib/bin.mjs'}});
    write(join(directory,'node_modules/@deepseek-ai/dsh/lib/bin.mjs'), readFileSync(process.argv[1]));
    save(join(directory,'node_modules/js-yaml/package.json'), {name:'js-yaml',version:'0.0.0-fixture',type:'module',exports:'./index.mjs'});
    write(join(directory,'node_modules/js-yaml/index.mjs'), 'export const load = JSON.parse;\n');
  } else {
    for (const archive of Object.values(JSON.parse(readFileSync(join(directory,'package.json'))).dependencies)) {
      assert.ok(archive.startsWith('file:'));
      assert.match(readFileSync(archive.slice(5), 'utf8'), /^not an archive /);
    }
  }
  for (const {path,...pkg} of lock.layout) save(join(directory,'node_modules',path,'package.json'), pkg);
  if (lock.mutate) write(join(directory,lock.mutate), 'changed input');
}
`;
  const pnpm = join(root, 'fixture-manager.mjs'); writeFileSync(pnpm, manager);
  const state = { root: stage, bootstrap, pnpm, profileName: 'arcfold', profileDir: join(stage, 'home/profiles/arcfold'),
    env: { PATH: dirname(process.execPath) + ':/usr/bin:/bin', DSH_HOME: join(stage, 'home'), npm_config_offline: 'true' } };
  return { root, original, state, release, inputs };
}

test('the shared frozen installer inventories the new final-lock tree, preserving initial sharing and inputs', async () => {
  const { original, state, release, inputs } = frozenFixture();
  const before = Object.fromEntries(['host','profile'].flatMap(scope => ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml']
    .map(name => [scope+'/'+name, stamp(join(inputs,scope,name))])));
  const originalConsumer = createRequire(join(original,'node_modules/consumer-b/package.json')).resolve('shared/package.json');
  const originalBytes = stamp(originalConsumer);
  const packages = await materializeFrozenRuntime(state, release, inputs);
  const shared = packages.profile.filter(row => row.name === 'shared');
  assert.deepEqual(shared.map(row => row.version).sort(), ['1.0.0','2.0.0']);
  const modules = join(state.profileDir,'node_modules');
  const consumed = ['consumer-a','consumer-b','consumer-c'].map(name =>
    createRequire(join(modules,name,'package.json')).resolve('shared/package.json'));
  assert.notEqual(consumed[0],consumed[1]); assert.equal(consumed[1],consumed[2]);
  assert.deepEqual(consumed.map(path => JSON.parse(readFileSync(path)).version), ['1.0.0','2.0.0','2.0.0']);
  assert.deepEqual(stamp(originalConsumer), originalBytes);
  assert.notEqual(originalConsumer,createRequire(join(original,'node_modules/consumer-c/package.json')).resolve('shared/package.json'));
  for (const [path, identity] of Object.entries(before)) assert.deepEqual(stamp(join(inputs,path)),identity);
  const relocation = JSON.parse(readFileSync(join(state.root,'profile-relocation.json')));
  assert.equal(relocation.length,3);
  assert.notEqual(relocation[0].beforeSHA,relocation[0].afterSHA);
  assert.equal(JSON.parse(readFileSync(join(state.root,'commands/host-install.result.json'))).code,0);
  assert.equal(JSON.parse(readFileSync(join(state.root,'commands/profile-install.result.json'))).code,0);
  assert.equal(existsSync(join(state.root,'supply.json')),false);
});

test('frozen installation rejects changes to every host/profile input and keeps failed command evidence', async t => {
  for (const scope of ['host','profile']) for (const name of ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml'])
    await t.test(scope+'/'+name, async () => {
      const { state,release,inputs } = frozenFixture();
      const path = join(inputs,scope,'pnpm-lock.yaml'), lock = JSON.parse(readFileSync(path));
      save(path,{...lock,mutate:name}); const before=stamp(path);
      await assert.rejects(materializeFrozenRuntime(state,release,inputs));
      assert.deepEqual(stamp(path),before);
      const result=JSON.parse(readFileSync(join(state.root,'commands',scope+'-install.result.json')));
      assert.equal(result.code,0); // The subprocess succeeded; the unchanged-input guard rejected it.
      assert.equal(existsSync(join(state.root,'runtime/supply.json')),false);
    });
  const {state,release,inputs}=frozenFixture();
  save(join(inputs,'profile/pnpm-lock.yaml'),{layout:[],fail:true});
  await assert.rejects(materializeFrozenRuntime(state,release,inputs),/profile-install failed/);
  assert.notEqual(JSON.parse(readFileSync(join(state.root,'commands/profile-install.result.json'))).code,0);
});

test('failed preparation replay preserves resolved inputs and never publishes a ready supply', async t => {
  const { original,release,inputs }=frozenFixture();
  const resolution={root:original,bootstrap,profileDir:join(original,'bootstrap-home/profiles/arcfold')};
  cpSync(join(inputs,'host'),join(original,'host'),{recursive:true});
  cpSync(join(inputs,'profile'),resolution.profileDir,{recursive:true});
  mkdirSync(join(original,'tooling')); mkdirSync(join(original,'store')); mkdirSync(join(original,'cache'));
  writeFileSync(join(original,'tooling/pnpm.tgz'),'invalid pinned archive');
  const before=stamp(join(resolution.profileDir,'pnpm-lock.yaml')); let requests=0;
  t.mock.method(globalThis,'fetch',()=>{requests++;throw new Error('No network');});
  await assert.rejects(freezeRuntimeSupply(resolution,release));
  assert.equal(requests,0);
  assert.deepEqual(stamp(join(resolution.profileDir,'pnpm-lock.yaml')),before);
  assert.equal(existsSync(join(original,'runtime/supply.json')),false);
  assert.equal(existsSync(join(original,'runtime/packages.json')),false);
  assert.equal(JSON.parse(readFileSync(join(original,'frozen-replay/failure.json'))).stage,'bootstrap');
  const replay=JSON.parse(readFileSync(join(original,'frozen-replay/install-start.json')));
  assert.equal(replay.offline,true); assert.equal(replay.reusedPrivateCache,true); assert.equal(replay.cacheOwner,original);
  const failure=stamp(join(original,'frozen-replay/failure.json'));
  await assert.rejects(freezeRuntimeSupply(resolution,release),/EEXIST/);
  assert.deepEqual(stamp(join(original,'frozen-replay/failure.json')),failure);
});
