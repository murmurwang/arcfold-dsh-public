#!/usr/bin/env node
// Build only from an exact Git source and already installed dependencies. No install/publish.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { desktopPython, readDesktopPythonArchive } from '../src/desktop/python-runtime.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DESKTOP_VERSION = '0.2.2-rc.1';
const OPENAI_ADAPTER = '@deepseek-ai/dsh-llm-pi-ai';
const STABLE_VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
const DESKTOP_INSTALLER_FILES = new Set(['bin', 'scripts/patch-pi-ai-transport.mjs', 'scripts/patch-model-selection.mjs',
  'scripts/prepare-runtime-locks.mjs']);
const DESKTOP_NOTICES = ['LICENSE', 'THIRD_PARTY_NOTICES.md'];
const DESKTOP_CORE_REQUIRED = ['src', 'runtime', 'cordis.patch.yml', 'presets', ...DESKTOP_NOTICES];
const DESKTOP_EXCLUDED_SOURCES = ['src/openai-provider.mjs',
  'patches/pi-ai-0.2.2-rc.1-transport.json', 'patches/session-controller-0.2.2-rc.1-model-selection.json'];

const CORE_FILES = new Set(['scripts/exact-package-patch.mjs', 'scripts/patch-model-selection.mjs', 'docs/model-selection.md', 'src', 'presets', 'bin', 'runtime', 'cordis.patch.yml', 'scripts/patch-deepseek-transport.mjs',
  'scripts/prepare-runtime-locks.mjs', 'patches', 'docs/local-runtime.md',
  'docs/release-bundle.md', 'docs/method-adoption.md', 'docs/goal-link.md', 'docs/goal-control.md', 'docs/metered-provider.md',
  'docs/opportunity-preparation.md', 'docs/provider-seam.md', 'scripts/patch-pi-ai-transport.mjs', 'docs/openai-metered-backend.md', 'README.md',
  ...DESKTOP_NOTICES]);
const UI_FILES = new Set(['src', 'lib', 'README.md', ...DESKTOP_NOTICES]);
const GIT_ENV = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
const git = (root, ...args) => execFileSync('git', ['--no-optional-locks', '-C', root, ...args], { env: GIT_ENV, encoding: 'utf8' }).trim();
const inside = (root, path) => path === root || path.startsWith(root + sep);

function safePath(path) {
  assert.ok(typeof path === 'string' && path && !isAbsolute(path) && !path.includes('\\') &&
    path.split('/').every(part => part && part !== '.' && part !== '..'), `Unsafe package path: ${path}`);
  return path;
}

function inventory(root, paths) {
  const result = [];
  function visit(path) {
    safePath(path);
    const stat = lstatSync(join(root, path));
    assert.equal(stat.isSymbolicLink(), false, `Package source must not contain symlinks: ${path}`);
    if (stat.isDirectory()) for (const name of readdirSync(join(root, path)).sort()) visit(path + '/' + name);
    else {
      assert.ok(stat.isFile(), `Unsupported package file: ${path}`);
      result.push({ path, bytes: stat.size, sha256: sha256(readFileSync(join(root, path))) });
    }
  }
  [...new Set(paths)].sort().forEach(visit);
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

function checkFiles(files, root, forbiddenRoots, target) {
  for (const file of files) {
    assert.ok(!/(^|\/)(?:test|tests|research|var|artifacts|node_modules|\.git|\.env)(?:\/|\.|$)/u.test(file.path),
      `Private/development file in package: ${file.path}`);
    assert.ok(!/\.(?:sqlite(?:-wal|-shm)?|db|pem|key|p12|pfx)$/u.test(file.path), `Data or secret file in package: ${file.path}`);
    if (file.path === 'src/tree/tokenizer-resources/deepseek_recipe-0.2.0-cp310-abi3-macosx_11_0_arm64.whl') {
      assert.equal(file.sha256, '624bb4d0fb3ed541b9e34d2ef96ff66057026ded7d6708b0b9088cc6d6723999', 'Only the audited official offline tokenizer wheel may be packaged');
      continue;
    }
    if (target === 'desktop' && file.path === desktopPython.path) {
      assert.equal(file.bytes, desktopPython.bytes);
      assert.equal(file.sha256, desktopPython.sha256, 'Only the approved Desktop Python archive may be packaged');
      continue;
    }
    const text = readFileSync(join(root, file.path), 'utf8');
    assert.equal(text.includes('\0'), false, `Unexpected binary package source: ${file.path}`);
    for (const path of forbiddenRoots) assert.equal(text.includes(path), false, `Build-machine path in ${file.path}`);
    assert.equal(/(?:\/Users\/[^/\s]+\/|\/var\/folders\/|\/home\/[^/\s]+\/)/u.test(text), false,
      `Personal absolute path in ${file.path}`);
    assert.equal(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(text), false, `Private key in ${file.path}`);
  }
}

function validateMetadata(metadata, name, allowed) {
  assert.equal(metadata.name, name); assert.ok(SEMVER.test(metadata.version)); assert.equal(metadata.type, 'module');
  assert.equal(metadata.main, './src/index.mjs');
  assert.ok(Array.isArray(metadata.files) && metadata.files.length > 0);
  assert.equal(new Set(metadata.files).size, metadata.files.length);
  for (const path of metadata.files) assert.ok(allowed.has(path), `Unapproved package.files entry: ${path}`);
  for (const group of ['dependencies', 'devDependencies', 'peerDependencies'])
    for (const [dependency, version] of Object.entries(metadata[group] || {}))
      assert.ok(SEMVER.test(version), `${name} must pin ${group}.${dependency}, not ${version}`);
  assert.equal(metadata.peerDependencies?.['@deepseek-ai/cordis'], '4.1.0');
}

function desktopManifests(core, ui, version) {
  assert.ok(STABLE_VERSION.test(version), 'Desktop builds require a stable version such as 0.2.0');
  assert.equal(core.engines?.dsh, DESKTOP_VERSION, 'The Desktop dependency range requires host validation');
  assert.equal(core.exports?.['./desktop-bootstrap'], './src/desktop/bootstrap.mjs',
    'Desktop distribution requires the Desktop source integration');
  assert.equal(core.dependencies?.[OPENAI_ADAPTER], DESKTOP_VERSION, 'Review changes to the pinned source adapter dependency');
  const desktopCore = structuredClone(core);
  assert.ok(core.files.includes('src'), 'Desktop archives retain the vendored adapter notice');
  desktopCore.description = 'Arcfold for DeepSeek Harness Desktop';
  delete desktopCore.private;
  delete desktopCore.scripts;
  delete desktopCore.devDependencies;
  delete desktopCore.exports['./openai'];
  delete desktopCore.dependencies[OPENAI_ADAPTER];
  desktopCore.dependencies[ui.name] = version;
  desktopCore.version = version;
  // The Desktop archive has its own first-run and update instructions.
  const runtimeFiles = core.files.filter(path => !DESKTOP_INSTALLER_FILES.has(path) && !path.startsWith('docs/'));
  desktopCore.files = [...runtimeFiles, ...DESKTOP_NOTICES];
  const desktopUi = { ...ui, version, files: [...ui.files, ...DESKTOP_NOTICES] };
  delete desktopUi.private;
  return { core: desktopCore, ui: desktopUi };
}

function writeDesktopReadme(path, version) {
  writeFileSync(path, `# Arcfold for DeepSeek Harness Desktop

Arcfold ${version} runs in DSH ${DESKTOP_VERSION} on macOS with Apple silicon.

Open Plugins, choose Add plugin, and enter \`@arcfold/dsh\`. Enable Arcfold and complete its first-run setup. It creates its own workspace and data. Configure DeepSeek in DSH's Models settings when ready.

To update, open the installed Arcfold entry in Plugins, choose a compatible version, and confirm. Back up your Desktop data before replacing the installed version.

Arcfold supports DeepSeek V4 Pro and Flash. On first setup, Arcfold selects DeepSeek V4 Pro if the DSH default model is unset.
`);
}

function prepareDesktopPatch(path) {
  const overlay = readFileSync(path, 'utf8');
  // The shared overlay still includes a disabled OpenAI entry for local runtime
  // configurations. Desktop archives omit it because they do not ship that adapter.
  const openaiEntry = "    - id: arcfold-openai-provider\n      name: '@arcfold/dsh/openai'\n      disabled: true\n      config: {}\n";
  assert.equal(overlay.split(openaiEntry).length, 2, 'Review changes to the disabled OpenAI overlay row');
  writeFileSync(path, overlay.replace(openaiEntry, ''));
}

/** Validate the actual staged package, including files npm must not silently omit. */
export function validateReleasePackage(root, kind, forbiddenRoots = [], target = 'local') {
  assert.ok(['local', 'desktop'].includes(target));
  const metadata = readJson(join(root, 'package.json'));
  validateMetadata(metadata, kind === 'core' ? '@arcfold/dsh' : '@arcfold/dsh-method-ui', kind === 'core' ? CORE_FILES : UI_FILES);
  const required = kind !== 'core' ? ['src', 'lib', ...(target === 'desktop' ? DESKTOP_NOTICES : [])] : target === 'desktop' ? DESKTOP_CORE_REQUIRED :
    ['src', 'cordis.patch.yml', 'presets', 'scripts/patch-deepseek-transport.mjs', 'scripts/patch-pi-ai-transport.mjs',
      'scripts/patch-model-selection.mjs', 'scripts/exact-package-patch.mjs', 'docs/model-selection.md', 'docs/openai-metered-backend.md', 'patches'];
  for (const path of required) assert.ok(metadata.files.includes(path), `Missing required package.files entry: ${path}`);
  const files = inventory(root, ['package.json', 'README.md', ...metadata.files]);
  assert.equal(new Set(files.map(file => file.path)).size, files.length, 'Overlapping package.files entries');
  checkFiles(files, root, forbiddenRoots, target);
  const names = new Set(files.map(file => file.path));
  assert.ok(metadata.exports && typeof metadata.exports === 'object');
  for (const [name, target] of Object.entries(metadata.exports)) {
    assert.ok(typeof target === 'string' && target.startsWith('./'), `Unsupported export: ${name}`);
    const path = safePath(target.slice(2));
    if (path.includes('*')) {
      assert.equal(path.split('*').length, 2); assert.equal(name.split('*').length, 2, `Invalid export pattern: ${name}`);
      const [prefix, suffix] = path.split('*');
      assert.ok([...names].some(file => file.startsWith(prefix) && file.endsWith(suffix) && file.length > prefix.length + suffix.length),
        `Export pattern has no packaged target: ${name} -> ${target}`);
    } else assert.ok(names.has(path), `Export is absent from package: ${name} -> ${target}`);
  }
  if (kind === 'core') {
    assert.deepEqual(metadata.dsh?.bundle?.patch, ['./cordis.patch.yml', './presets/arcfold.patch.yml']);
    for (const path of metadata.dsh.bundle.patch) assert.ok(names.has(path.slice(2)), `Missing bundle patch: ${path}`);
    if (target === 'desktop') {
      assert.equal(metadata.private, undefined);
      assert.equal(metadata.engines.dsh, DESKTOP_VERSION);
      assert.equal(metadata.exports['./desktop-bootstrap'], './src/desktop/bootstrap.mjs');
      assert.equal(metadata.exports['./openai'], undefined);
      assert.equal(metadata.dependencies[OPENAI_ADAPTER], undefined);
      assert.equal(metadata.dependencies['@arcfold/dsh-method-ui'], metadata.version);
      assert.ok(names.has('runtime/initial-policy.json'));
      assert.ok(names.has(desktopPython.path), 'Desktop installation requires the bundled Python runtime');
      assert.ok(names.has('src/desktop/bootstrap.mjs'));
      assert.ok(names.has('src/desktop/vendor/NOTICE.md'));
      assert.ok(DESKTOP_EXCLUDED_SOURCES.every(path => !names.has(path)));
      assert.ok(metadata.files.every(path => !DESKTOP_INSTALLER_FILES.has(path) && !path.startsWith('docs/')));
    } else {
      for (const path of ['patches/deepseek-0.2.2-rc.1-transport.json', 'patches/deepseek-0.2.2-rc.1-transport.patch',
        'patches/pi-ai-0.2.2-rc.1-transport.json', 'patches/session-controller-0.2.2-rc.1-model-selection.json'])
        assert.ok(names.has(path), `Missing exact transport patch: ${path}`);
    }
    assert.equal(metadata.dsh.client, undefined, 'Core host entries must not duplicate the UI package identity');
  } else {
    if (target === 'desktop') assert.equal(metadata.private, undefined);
    assert.equal(metadata.exports['./client'], './lib/client.js');
    assert.equal(metadata.dsh?.client?.platform, 'web');
    assert.equal(metadata.peerDependencies['@deepseek-ai/dsh-typert-protocol'], '0.2.2-rc.1');
    assert.equal(metadata.peerDependencies.react, '18.3.1');
    assert.ok(names.has('src/style.css'));
    const client = readFileSync(join(root, 'lib/client.js'), 'utf8');
    assert.ok(client.includes('window.__ModuleLoader__.load({id:"@arcfold/dsh-method-ui"'), 'Missing official UI factory registration');
    assert.ok(client.includes('require("react")'), 'Missing host React import');
  }
  return { metadata, files };
}

async function dependencies(root, source, core, ui, target) {
  const lockBytes = readFileSync(join(source, 'package-lock.json'));
  assert.deepEqual(readFileSync(join(root, 'package-lock.json')), lockBytes, 'Dependency installation must match the exact source lock');
  const lock = JSON.parse(lockBytes);
  for (const group of ['dependencies', 'devDependencies', 'peerDependencies'])
    assert.deepEqual(lock.packages[''][group] || {}, core[group] || {}, `Root lock metadata mismatch: ${group}`);
  for (const [path, entry] of Object.entries(lock.packages).filter(([path]) => path)) {
    safePath(path); assert.ok(SEMVER.test(entry.version) && typeof entry.integrity === 'string', `Unpinned lock entry: ${path}`);
    const url = new URL(entry.resolved);
    assert.ok(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash,
      `Nonportable dependency resolution: ${path}`);
  }
  const expected = { ...core.dependencies, ...core.devDependencies, ...core.peerDependencies, ...ui.peerDependencies };
  const resolved = [];
  for (const [name, version] of Object.entries(expected).sort(([a], [b]) => a.localeCompare(b))) {
    const entry = lock.packages['node_modules/' + name];
    assert.ok(entry && entry.version === version && entry.integrity, `Locked dependency absent or different: ${name}`);
    const actualPath = join(root, 'node_modules', name, 'package.json'), actual = readJson(actualPath);
    assert.equal(actual.name, name); assert.equal(actual.version, version, `Installed dependency differs: ${name}`);
    resolved.push({ name, version, integrity: entry.integrity, packageJsonSha256: sha256(readFileSync(actualPath)) });
  }
  assert.equal(expected.esbuild, '0.28.2'); assert.equal(expected.react, '18.3.1'); assert.equal(expected['react-dom'], '18.3.1');
  assert.equal(expected['@deepseek-ai/dsh'], '0.2.2-rc.1');
  const components = {};
  const localPatches = [
    { key: 'deepseek-official', package: '@deepseek-ai/dsh-llm-deepseek', wrapper: 'deepseek-provider',
      script: 'patch-deepseek-transport', inspect: 'inspectDeepSeekPatch' },
    { key: 'openai', package: '@deepseek-ai/dsh-llm-pi-ai', wrapper: 'openai-provider',
      script: 'patch-pi-ai-transport', inspect: 'inspectPiAiPatch' },
    { key: 'modelSelection', package: '@deepseek-ai/dsh-api-session-controller',
      script: 'patch-model-selection', inspect: 'inspectModelSelectionPatch' },
  ];
  for (const definition of target === 'local' ? localPatches : []) {
    // A release dependency tree is flat; controller lookup uses the same profile-root
    // anchor as the official Include, never an invented Arcfold wrapper importer.
    const require = createRequire(definition.wrapper ? join(root, 'src', definition.wrapper + '.mjs') : join(root, 'cordis.yml'));
    const providerJson = realpathSync(require.resolve(definition.package + '/package.json'));
    const inspector = await import(pathToFileURL(join(source, 'scripts', definition.script + '.mjs')).href);
    const inspected = inspector[definition.inspect](dirname(providerJson));
    assert.equal(inspected.state, 'patched', 'Release validation requires the actual patched provider or controller');
    const provider = await import(pathToFileURL(require.resolve(definition.package)).href);
    const capability = inspector.patchSpec.runtimeCapability;
    assert.deepEqual(Object.getOwnPropertyDescriptor(provider[capability.export], capability.property), {
      value: capability.value, writable: false, enumerable: true, configurable: false,
    }, 'The actual loaded provider or controller lacks the frozen capability');
    components[definition.key] = { patchId: inspected.patchId, package: inspected.package, version: inspected.version,
      patchSpecSha256: inspected.patchSpecSha256, state: inspected.state, files: inspected.files, capability };
  }
  const transports = Object.fromEntries(['deepseek-official', 'openai'].map(key => [key, components[key]]));
  return { lockBytes, identity: { lockSha256: sha256(lockBytes), direct: resolved,
    lockEntries: Object.entries(lock.packages).filter(([path]) => path).map(([path, entry]) => ({ path,
      version: entry.version, resolved: entry.resolved, integrity: entry.integrity, optional: entry.optional === true })),
    ...(target === 'local' ? { transport: transports['deepseek-official'], transports, modelSelection: components.modelSelection } : {}) } };
}

function npmEnvironment(directory) {
  mkdirSync(directory, { mode: 0o700 });
  for (const name of ['user.npmrc', 'global.npmrc']) writeFileSync(join(directory, name), '', { flag: 'wx', mode: 0o600 });
  return { PATH: process.env.PATH, npm_config_userconfig: join(directory, 'user.npmrc'),
    npm_config_globalconfig: join(directory, 'global.npmrc'), npm_config_cache: join(directory, 'cache'),
    npm_config_offline: 'true', npm_config_ignore_scripts: 'true', npm_config_audit: 'false',
    npm_config_fund: 'false', npm_config_update_notifier: 'false' };
}

function command(commandName, args, options, receipt) {
  try {
    const stdout = execFileSync(commandName, args, { ...options, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    save(receipt, { command: commandName, args, exitCode: 0, stdout }); return stdout;
  } catch (error) {
    save(receipt, { command: commandName, args, exitCode: error.status ?? null, signal: error.signal ?? null,
      stdout: error.stdout?.toString() || '', stderr: error.stderr?.toString() || '', error: error.message });
    throw error;
  }
}

function pack(root, kind, output, build, env, forbiddenRoots, target) {
  const before = validateReleasePackage(root, kind, forbiddenRoots, target);
  const result = JSON.parse(command('npm', ['pack', '--ignore-scripts', '--offline', '--json', '--pack-destination', output],
    { cwd: root, env }, join(build, `npm-pack-${kind}.json`)));
  assert.equal(result.length, 1); const packed = result[0];
  assert.equal(packed.name, before.metadata.name); assert.equal(packed.version, before.metadata.version);
  assert.equal(basename(packed.filename), packed.filename);
  assert.deepEqual(packed.files.map(file => file.path).sort(), before.files.map(file => file.path).sort(), 'npm packed an unexpected file set');
  const archive = join(output, packed.filename), entries = command('tar', ['-tzf', archive], { cwd: build, env }, join(build, `tar-list-${kind}.json`))
    .trim().split('\n').sort();
  assert.deepEqual(entries, before.files.map(file => 'package/' + file.path).sort(), 'Actual tarball entries differ from npm/source');
  const extracted = join(build, 'unpacked-' + kind); mkdirSync(extracted);
  command('tar', ['-xzf', archive, '-C', extracted], { cwd: build, env }, join(build, `tar-extract-${kind}.json`));
  const actual = validateReleasePackage(join(extracted, 'package'), kind, forbiddenRoots, target);
  assert.deepEqual(actual, before, 'Actual archive bytes differ from the validated source');
  const bytes = readFileSync(archive);
  assert.equal(packed.integrity, 'sha512-' + createHash('sha512').update(bytes).digest('base64'));
  return { name: packed.name, version: packed.version, file: packed.filename, sha256: sha256(bytes), integrity: packed.integrity,
    bytes: bytes.length, exports: actual.metadata.exports, dependencies: actual.metadata.dependencies || {},
    peerDependencies: actual.metadata.peerDependencies || {}, files: actual.files };
}

/** sourceKind is a caller assertion. Git identity proves bytes, not managed acceptance. */
export async function packageRelease({ sourceRoot, dependencyRoot, outputDir, sourceKind, target = 'local', version, pythonArchive }) {
  assert.ok(['local', 'desktop'].includes(target), 'Choose the local or desktop distribution');
  assert.ok(target === 'desktop' ? STABLE_VERSION.test(version) : version === undefined,
    'Specify a stable --version for the Desktop distribution only');
  assert.ok(target === 'desktop' ? pythonArchive : pythonArchive === undefined,
    'Supply --desktop-python-archive for the Desktop distribution only');
  assert.ok(['candidate', 'accepted'].includes(sourceKind), 'Explicit sourceKind candidate or accepted is required');
  assert.ok(sourceRoot && dependencyRoot && outputDir, 'Explicit source, dependencies and new output are required');
  const source = realpathSync(resolve(sourceRoot)), dependency = realpathSync(resolve(dependencyRoot)), output = resolve(outputDir);
  assert.ok(!inside(source, output) && !inside(dependency, output) && !inside(output, source) && !inside(output, dependency),
    'Output must be separate from source and frozen dependencies');
  assert.equal(realpathSync(dirname(output)), dirname(output), 'Output parent must not traverse a symlink');
  mkdirSync(output, { mode: 0o700 }); // Never overwrite an earlier attempt.
  const build = join(output, '.build'); mkdirSync(build, { mode: 0o700 });
  save(join(build, 'locations.json'), { source, dependency, output, sourceKind, target });
  try {
    assert.equal(git(source, 'rev-parse', '--show-toplevel'), source, 'Source must be its own Git root');
    assert.equal(git(source, 'status', '--porcelain=v1', '--untracked-files=all'), '', 'Source must be a clean exact checkout');
    const sourceIdentity = { commit: git(source, 'rev-parse', 'HEAD'), tree: git(source, 'rev-parse', 'HEAD^{tree}'),
      kind: sourceKind, authority: 'kind is declared by caller; Git and file hashes verify source identity, not managed acceptance' };
    const core = readJson(join(source, 'package.json')), ui = readJson(join(source, 'packages/method-ui/package.json'));
    validateMetadata(core, '@arcfold/dsh', CORE_FILES); validateMetadata(ui, '@arcfold/dsh-method-ui', UI_FILES);
    assert.equal(core.version, ui.version);
    const desktop = target === 'desktop' ? desktopManifests(core, ui, version) : null;
    const sourcePaths = ['package.json', 'package-lock.json', 'README.md', ...(desktop?.core.files ?? core.files),
      'scripts/package-release.mjs', 'packages/method-ui/package.json', 'packages/method-ui/build.mjs',
      ...ui.files.filter(path => path !== 'lib').map(path => 'packages/method-ui/' + path)];
    const originals = inventory(source, sourcePaths);
    assert.equal(new Set(originals.map(file => file.path)).size, originals.length, 'Overlapping release input paths');
    const dep = await dependencies(dependency, source, core, ui, target);
    const coreStage = join(build, 'core'), uiStage = join(build, 'ui'); mkdirSync(coreStage); mkdirSync(uiStage);
    for (const file of originals) {
      if (file.path === 'package-lock.json' || file.path === 'scripts/package-release.mjs') continue;
      if (desktop && DESKTOP_EXCLUDED_SOURCES.includes(file.path)) continue;
      const isUi = file.path.startsWith('packages/method-ui/');
      const target = join(isUi ? uiStage : coreStage, isUi ? file.path.slice('packages/method-ui/'.length) : file.path);
      mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(source, file.path), target);
    }
    if (desktop) {
      writeFileSync(join(coreStage, desktopPython.path), readDesktopPythonArchive(pythonArchive), { flag: 'wx' });
      for (const path of DESKTOP_NOTICES) copyFileSync(join(coreStage, path), join(uiStage, path));
      writeDesktopReadme(join(coreStage, 'README.md'), version);
      writeFileSync(join(coreStage, 'package.json'), JSON.stringify(desktop.core, null, 2) + '\n');
      writeFileSync(join(uiStage, 'package.json'), JSON.stringify(desktop.ui, null, 2) + '\n');
      prepareDesktopPatch(join(coreStage, 'cordis.patch.yml'));
    }
    const builder = await import(pathToFileURL(join(uiStage, 'build.mjs')).href);
    const built = await builder.buildMethodUi({ dependencyRoot: dependency });
    save(join(build, 'ui-build.json'), built);
    const env = npmEnvironment(join(build, 'npm'));
    const npmVersion = command('npm', ['--version'], { cwd: build, env }, join(build, 'npm-version.json')).trim();
    const forbidden = [source, dependency, output];
    const packages = [pack(coreStage, 'core', output, build, env, forbidden, target), pack(uiStage, 'ui', output, build, env, forbidden, target)];
    assert.deepEqual(inventory(source, sourcePaths), originals, 'Source changed during packaging');
    assert.equal(git(source, 'status', '--porcelain=v1', '--untracked-files=all'), '', 'Source changed during packaging');
    assert.equal(git(source, 'rev-parse', 'HEAD'), sourceIdentity.commit);
    assert.deepEqual(readFileSync(join(dependency, 'package-lock.json')), dep.lockBytes);
    writeFileSync(join(output, 'dependency-lock.json'), dep.lockBytes, { flag: 'wx', mode: 0o600 });
    const manifest = { schema: 'arcfold-release-v1', version: version ?? core.version,
      ...(desktop ? { target, host: { dsh: DESKTOP_VERSION }, desktopPython } : {}), source: { ...sourceIdentity, files: originals },
      build: { node: process.version, platform: process.platform, arch: process.arch, npm: npmVersion,
        ui: built, installs: 0, modelCalls: 0 }, dependencies: dep.identity, packages,
      lock: { file: 'dependency-lock.json', sha256: sha256(dep.lockBytes) },
      limits: 'Packaging evidence only; no host launch, provider request, production migration or managed acceptance is implied.' };
    const text = JSON.stringify(manifest);
    for (const path of forbidden) assert.equal(text.includes(path), false, 'Manifest must remain portable');
    save(join(output, 'manifest.json'), manifest);
    const sums = [...packages.map(pkg => ({ file: pkg.file, sha256: pkg.sha256 })), manifest.lock,
      { file: 'manifest.json', sha256: sha256(readFileSync(join(output, 'manifest.json'))) }];
    writeFileSync(join(output, 'SHA256SUMS'), sums.map(item => `${item.sha256}  ${item.file}\n`).join(''), { flag: 'wx', mode: 0o600 });
    save(join(build, 'completed.json'), { completed: true, manifestSha256: sums.at(-1).sha256 });
    return manifest;
  } catch (error) {
    save(join(build, 'failure.json'), { completed: false, name: error.name, message: error.message });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const values = {}, names = { '--source': 'sourceRoot', '--dependencies': 'dependencyRoot', '--output': 'outputDir', '--source-kind': 'sourceKind',
      '--target': 'target', '--version': 'version', '--desktop-python-archive': 'pythonArchive' };
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i += 2) {
      assert.ok(names[args[i]] && args[i + 1] && !args[i + 1].startsWith('--') && !Object.hasOwn(values, names[args[i]]), 'Unknown, repeated or incomplete option');
      values[names[args[i]]] = args[i + 1];
    }
    const result = await packageRelease(values);
    console.log(JSON.stringify({ completed: true, version: result.version, source: result.source.commit,
      packages: result.packages.map(({ name, file, sha256 }) => ({ name, file, sha256 })) }));
  } catch (error) { console.error(JSON.stringify({ completed: false, message: error.message })); process.exitCode = 1; }
}
