import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { packageRelease, validateReleasePackage } from '../scripts/package-release.mjs';
import { applyDeepSeekPatch, patchSpec } from '../scripts/patch-deepseek-transport.mjs';
import { applyPiAiPatch, patchSpec as piAiSpec } from '../scripts/patch-pi-ai-transport.mjs';
import { applyModelSelectionPatch, patchSpec as modelSpec } from '../scripts/patch-model-selection.mjs';

const source = dirname(dirname(fileURLToPath(import.meta.url)));
const evidence = realpathSync(mkdtempSync(join(tmpdir(), 'arcfold-release-package-')));
const hash = value => createHash('sha256').update(value).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const git = (root, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args], {
  encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
}).trim();
function commit(root) {
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Arcfold release fixture', '-c', 'user.email=fixture@localhost',
    '-c', 'commit.gpgsign=false', 'commit', '-m', 'Private packaging fixture; not managed acceptance');
}
function fixture(label, mutate = () => {}) {
  const root = mkdtempSync(join(evidence, label + '-'));
  const metadata = json(join(source, 'package.json'));
  const paths = new Set(['package.json', 'package-lock.json', 'README.md', ...metadata.files,
    'scripts/package-release.mjs', 'packages/method-ui/package.json', 'packages/method-ui/README.md',
    'packages/method-ui/build.mjs', 'packages/method-ui/src']);
  for (const path of paths) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(source, path), join(root, path), { recursive: true, errorOnExist: true, force: false });
  }
  mutate(root);
  git(root, 'init', '--template=', '--initial-branch=release-fixture'); commit(root);
  return { root, output: root + '-output', options: { sourceRoot: root, dependencyRoot: source, outputDir: root + '-output', sourceKind: 'candidate' } };
}
let builtPromise;
function built() {
  return builtPromise ||= (async () => {
    const fixtureResult = fixture('actual', root => {
      mkdirSync(join(root, 'test')); writeFileSync(join(root, 'test/private.txt'), 'SYNTHETIC excluded test material');
      writeFileSync(join(root, 'private.sqlite'), 'SYNTHETIC excluded data');
      writeFileSync(join(root, '.env'), 'SYNTHETIC_NOT_A_SECRET=excluded');
    });
    return { ...fixtureResult, manifest: await packageRelease(fixtureResult.options) };
  })();
}

test('standard npm pack emits two actual portable archives with exact files, build and dependency identities', async t => {
  t.diagnostic(`Retained release evidence: ${evidence}`);
  const result = await built(), { manifest, root, output } = result;
  assert.equal(manifest.source.commit, git(root, 'rev-parse', 'HEAD'));
  assert.equal(manifest.source.tree, git(root, 'rev-parse', 'HEAD^{tree}'));
  assert.equal(manifest.source.kind, 'candidate'); assert.match(manifest.source.authority, /not managed acceptance/);
  assert.equal(manifest.packages.length, 2); assert.equal(manifest.build.installs, 0); assert.equal(manifest.build.modelCalls, 0);
  assert.deepEqual(manifest.packages.map(pkg => pkg.name), ['@arcfold/dsh', '@arcfold/dsh-method-ui']);
  assert.equal(manifest.dependencies.transport.state, 'patched');
  assert.equal(manifest.dependencies.transport.capability.value, 'deepseek-messages-create-transport-v1');
  assert.deepEqual(manifest.dependencies.transport, manifest.dependencies.transports['deepseek-official']);
  assert.equal(manifest.dependencies.transports.openai.state, 'patched');
  assert.equal(manifest.dependencies.transports.openai.capability.value, 'pi-ai-create-transport-v2');
  assert.equal(manifest.dependencies.modelSelection.state, 'patched');
  assert.equal(manifest.dependencies.modelSelection.capability.value, 'session-model-selection-commit-v1');
  for (const pkg of manifest.packages) {
    assert.equal(hash(readFileSync(join(output, pkg.file))), pkg.sha256);
    assert.ok(pkg.files.some(file => file.path === 'src/index.mjs'));
    assert.ok(pkg.files.every(file => !/test|private\.sqlite|\.env|research|node_modules/u.test(file.path)));
  }
  const core = manifest.packages[0], ui = manifest.packages[1];
  assert.ok(core.files.every(file => !file.path.startsWith('packages/')));
  assert.ok(core.files.some(file => file.path === 'presets/arcfold.patch.yml'));
  for (const path of ['scripts/patch-pi-ai-transport.mjs', 'patches/pi-ai-0.2.2-rc.1-transport.json',
    'src/openai-provider.mjs', 'src/metered-provider-host.mjs', 'docs/openai-metered-backend.md',
    'scripts/patch-model-selection.mjs', 'patches/session-controller-0.2.2-rc.1-model-selection.json', 'docs/model-selection.md'])
    assert.ok(core.files.some(file => file.path === path), 'Dormant OpenAI export needs its actual packaged dependency: ' + path);
  assert.ok(ui.files.some(file => file.path === 'src/style.css'));
  assert.equal(ui.files.find(file => file.path === 'lib/client.js').sha256, manifest.build.ui.output.sha256);
  assert.deepEqual(manifest.build.ui.external, ['react']);
  assert.equal(manifest.build.ui.esbuildVersion, '0.28.2');
  assert.equal(hash(readFileSync(join(output, manifest.lock.file))), manifest.lock.sha256);
  const text = readFileSync(join(output, 'manifest.json'), 'utf8');
  for (const path of [source, root, output]) assert.equal(text.includes(path), false);
  for (const line of readFileSync(join(output, 'SHA256SUMS'), 'utf8').trim().split('\n')) {
    const [digest, file] = line.split('  '); assert.equal(hash(readFileSync(join(output, file))), digest);
  }
  assert.equal(git(root, 'status', '--porcelain=v1'), '');
  assert.equal(existsSync(join(root, 'packages/method-ui/lib')), false, 'Original source is never built in place');
  renameSync(root, root + '-unavailable');
  const client = readFileSync(join(output, '.build/unpacked-ui/package/lib/client.js'), 'utf8');
  let registered;
  runInNewContext(client, { window: { __ModuleLoader__: { load: item => { assert.equal(registered, undefined); registered = item; } } } });
  assert.equal(registered.id, '@arcfold/dsh-method-ui');
  const require = createRequire(join(source, 'package.json')), imports = [];
  const api = registered.factory(name => { imports.push(name); assert.equal(name, 'react'); return require(name); });
  assert.equal(typeof api.apply, 'function'); assert.deepEqual([...api.inject], ['slots', 'connection', 'locale', 'fileUpload']);
  assert.ok(imports.length >= 1); assert.ok(imports.every(name => name === 'react'));
});

test('packed UI host imports outside the source tree with only declared runtime dependencies', async () => {
  const { output } = await built();
  const detached = join(evidence, 'detached-ui-host');
  cpSync(join(output, '.build/unpacked-ui/package'), detached, { recursive: true });
  symlinkSync(join(source, 'node_modules'), join(detached, 'node_modules'), 'dir');
  const host = await import(pathToFileURL(join(detached, 'src/index.mjs')));
  assert.equal(typeof host.apply, 'function');
  assert.equal(typeof host.createMethodHandler, 'function');
});

test('artifact validation rejects missing client, patch, export and leaked private data', async () => {
  const { output } = await built();
  for (const [kind, label, mutate, expected] of [
    ['ui', 'client', root => rmSync(join(root, 'lib/client.js')), /absent from package|ENOENT/],
    ['core', 'controller-helper', root => rmSync(join(root, 'scripts/patch-model-selection.mjs')), /ENOENT/],
    ['core', 'controller-manifest', root => rmSync(join(root, 'patches/session-controller-0.2.2-rc.1-model-selection.json')), /Missing exact transport patch/],
    ['core', 'pi-ai-helper', root => rmSync(join(root, 'scripts/patch-pi-ai-transport.mjs')), /ENOENT/],
    ['core', 'pi-ai-manifest', root => rmSync(join(root, 'patches/pi-ai-0.2.2-rc.1-transport.json')), /Missing exact transport patch/],
    ['core', 'openai-doc', root => rmSync(join(root, 'docs/openai-metered-backend.md')), /ENOENT/],
    ['core', 'patch', root => rmSync(join(root, 'patches/deepseek-0.2.2-rc.1-transport.json')), /Missing exact transport patch/],
    ['core', 'export', root => { const metadata = json(join(root, 'package.json')); metadata.exports['./missing'] = './src/missing.mjs'; writeFileSync(join(root, 'package.json'), JSON.stringify(metadata)); }, /Export is absent/],
    ['core', 'data', root => writeFileSync(join(root, 'src/private.sqlite'), 'SYNTHETIC'), /Data or secret file/],
    ['core', 'path', root => writeFileSync(join(root, 'src/private.mjs'), 'export const path = "/Users/example/research/private";'), /Personal absolute path/],
  ]) {
    const copy = join(evidence, `missing-${label}`);
    cpSync(join(output, '.build', 'unpacked-' + kind, 'package'), copy, { recursive: true }); mutate(copy);
    assert.throws(() => validateReleasePackage(copy, kind), expected);
  }
});

test('source defects retain a failed attempt without packing or altering the committed source', async () => {
  for (const [label, mutate, expected] of [
    ['missing-bundle', root => rmSync(join(root, 'cordis.patch.yml')), /ENOENT/],
    ['floating-peer', root => { const path = join(root, 'packages/method-ui/package.json'), metadata = json(path);
      metadata.peerDependencies.react = '^18.3.1'; writeFileSync(path, JSON.stringify(metadata)); }, /must pin/],
    ['symbolic-input', root => { rmSync(join(root, 'src/agent.mjs')); symlinkSync(join(source, 'src/agent.mjs'), join(root, 'src/agent.mjs')); }, /symlinks/],
  ]) {
    const result = fixture(label, mutate);
    await assert.rejects(packageRelease(result.options), expected);
    assert.equal(json(join(result.output, '.build/failure.json')).completed, false);
    assert.equal(existsSync(join(result.output, 'manifest.json')), false);
    assert.equal(readdirSync(result.output).filter(file => file.endsWith('.tgz')).length, 0);
    assert.equal(git(result.root, 'status', '--porcelain=v1'), '');
  }
});

test('dirty sources and an existing output are refused rather than relabelled or overwritten', async () => {
  const result = fixture('dirty'); writeFileSync(join(result.root, 'src/agent.mjs'), '// uncommitted\n');
  await assert.rejects(packageRelease(result.options), /clean exact checkout/);
  const firstFailure = readFileSync(join(result.output, '.build/failure.json'));
  await assert.rejects(packageRelease(result.options), /EEXIST/);
  assert.deepEqual(readFileSync(join(result.output, '.build/failure.json')), firstFailure);
  await assert.rejects(packageRelease({ ...result.options, outputDir: join(result.root, 'output') }), /separate/);
});

function privateDependencies(label) {
  const root = mkdtempSync(join(evidence, label + '-'));
  cpSync(join(source, 'package.json'), join(root, 'package.json'));
  cpSync(join(source, 'package-lock.json'), join(root, 'package-lock.json'));
  const modules = join(root, 'node_modules'); mkdirSync(modules);
  for (const name of readdirSync(join(source, 'node_modules'))) {
    if (name === '@deepseek-ai') {
      mkdirSync(join(modules, name));
      for (const item of readdirSync(join(source, 'node_modules', name))) {
        const from = join(source, 'node_modules', name, item), to = join(modules, name, item);
        if (['dsh-llm-deepseek', 'dsh-llm-pi-ai', 'dsh-api-session-controller'].includes(item)) cpSync(from, to, { recursive: true }); else symlinkSync(from, to);
      }
    } else symlinkSync(join(source, 'node_modules', name), join(modules, name));
  }
  return root;
}

test('a matching lock cannot substitute for the real provider patch or loaded module capability', async () => {
  const input = fixture('provider'), dependencyRoot = privateDependencies('provider-dependencies');
  const providerRoot = join(dependencyRoot, 'node_modules/@deepseek-ai/dsh-llm-deepseek');
  for (const file of patchSpec.files) {
    const path = join(providerRoot, file.path); let text = readFileSync(path, 'utf8');
    assert.equal(hash(text), file.afterSha256);
    for (const edit of [...file.edits].reverse()) { assert.equal(text.split(edit.after).length, 2); text = text.replace(edit.after, edit.before); }
    assert.equal(hash(text), file.beforeSha256); writeFileSync(path, text);
  }
  await assert.rejects(packageRelease({ ...input.options, dependencyRoot }), /actual patched provider/);
  const original = await import(pathToFileURL(join(providerRoot, 'lib/index.js')).href);
  assert.equal(original.registerDeepSeekProvider.transportSeam, undefined);
  applyDeepSeekPatch({ packageDir: providerRoot, receiptDir: join(dependencyRoot, 'patch-receipt') });
  await assert.rejects(packageRelease({ ...input.options, dependencyRoot, outputDir: input.output + '-cached' }), /loaded provider or controller lacks/);
  assert.equal(existsSync(join(input.output + '-cached', 'manifest.json')), false);
});

test('pi-ai disk and cached loaded capability are independently required by release validation', async () => {
  const input = fixture('pi-ai-provider'), dependencyRoot = privateDependencies('pi-ai-dependencies');
  const providerRoot = join(dependencyRoot, 'node_modules/@deepseek-ai/dsh-llm-pi-ai');
  for (const file of piAiSpec.files) {
    const path = join(providerRoot, file.path); let text = readFileSync(path, 'utf8');
    assert.equal(hash(text), file.afterSha256);
    for (const edit of [...file.edits].reverse()) { assert.equal(text.split(edit.after).length, 2); text = text.replace(edit.after, edit.before); }
    assert.equal(hash(text), file.beforeSha256); writeFileSync(path, text);
  }
  await assert.rejects(packageRelease({ ...input.options, dependencyRoot }), /actual patched provider/);
  const original = await import(pathToFileURL(join(providerRoot, 'lib/index.js')).href);
  assert.equal(original.PiAiAdapter.transportSeam, undefined);
  applyPiAiPatch({ packageDir: providerRoot, receiptDir: join(dependencyRoot, 'pi-ai-receipt') });
  await assert.rejects(packageRelease({ ...input.options, dependencyRoot, outputDir: input.output + '-cached' }), /loaded provider or controller lacks/);
  assert.equal(existsSync(join(input.output + '-cached', 'manifest.json')), false);
});


test('release requires exact controller bytes and actual loaded capability even when the dependency lock matches', async () => {
  const input = fixture('controller'), dependencyRoot = privateDependencies('controller-dependencies');
  const controller = join(dependencyRoot, 'node_modules/@deepseek-ai/dsh-api-session-controller');
  for (const item of modelSpec.files) {
    const filename = join(controller, item.path); let text = readFileSync(filename, 'utf8');
    assert.equal(hash(text), item.afterSha256);
    for (const edit of [...item.edits].reverse()) text = text.replace(edit.after, edit.before);
    assert.equal(hash(text), item.beforeSha256); writeFileSync(filename, text);
  }
  await assert.rejects(packageRelease({ ...input.options, dependencyRoot }), /actual patched provider or controller/);
  const original = await import(pathToFileURL(join(controller, 'lib/index.js')));
  assert.equal(original.SessionController.modelSelectionSeam, undefined);
  applyModelSelectionPatch({ packageDir: controller, receiptDir: join(dependencyRoot, 'controller-receipt') });
  await assert.rejects(packageRelease({ ...input.options, dependencyRoot, outputDir: input.output + '-cached' }), /loaded provider or controller lacks/);
  assert.equal(existsSync(join(input.output + '-cached', 'manifest.json')), false);
});
