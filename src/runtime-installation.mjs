import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, closeSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url), HERE = dirname(SELF), CORE = '@arcfold/dsh', UI = '@arcfold/dsh-method-ui';
const BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', CORE];
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const within = (root, path) => path === root || path.startsWith(root + sep);
const errorData = error => ({ name: error.name, message: error.message, stack: error.stack });
const safe = path => { assert.ok(typeof path === 'string' && path && !isAbsolute(path) && !path.split(/[\\/]/).some(x => x === '..' || x === '')); return path; };
const file = path => ({ sha256: sha(readFileSync(path)), bytes: lstatSync(path).size });
const copy = (from, to) => { mkdirSync(dirname(to), { recursive: true, mode: 0o700 }); copyFileSync(from, to, constants.COPYFILE_EXCL); };
function newDestination(path, sources) {
  const absolute = resolve(path), destination = join(realpathSync(dirname(absolute)), absolute.slice(dirname(absolute).length + 1));
  for (const source of sources.filter(Boolean)) {
    const root = realpathSync(resolve(source));
    assert.ok(!within(root, destination) && !within(destination, root), 'Installation stage must be separate from its source resources');
  }
  return destination;
}

function checkPlatform(bootstrap) {
  assert.equal(bootstrap.schema, 'arcfold-runtime-bootstrap-v1');
  assert.deepEqual([bootstrap.platform, bootstrap.arch, bootstrap.node, bootstrap.dsh, bootstrap.cordis, bootstrap.pnpm.version],
    ['darwin', 'arm64', '24.15.0', '0.2.2-rc.1', '4.1.0', '11.28.5']);
  assert.equal(bootstrap.pnpm.url, 'https://registry.npmjs.org/pnpm/-/pnpm-11.28.5.tgz');
  assert.equal(bootstrap.pnpm.sha256, '1ef4e447a68713656064f3f174c0f44719960a043a3fe2299169d08cf1dbf8ee');
  assert.equal(bootstrap.pnpm.bytes, 5736887);
  assert.equal(process.platform, bootstrap.platform, 'Unverified installation platform');
  assert.equal(process.arch, bootstrap.arch, 'Unverified installation architecture');
  assert.equal(process.versions.node, bootstrap.node, 'Use the verified Node version');
}
function releaseAt(directory) {
  const root = realpathSync(resolve(directory)), manifest = json(join(root, 'manifest.json'));
  assert.equal(manifest.schema, 'arcfold-release-v1');
  assert.match(manifest.source.commit, /^[a-f0-9]{40}$/);
  assert.deepEqual(manifest.packages.map(p => p.name).sort(), [CORE, UI].sort());
  for (const item of manifest.packages) {
    const archive = join(root, safe(item.file)); assert.equal(realpathSync(archive), archive);
    assert.deepEqual(file(archive), { sha256: item.sha256, bytes: item.bytes });
    assert.equal('sha512-' + createHash('sha512').update(readFileSync(archive)).digest('base64'), item.integrity);
  }
  return { root, manifest, manifestSHA: file(join(root, 'manifest.json')).sha256 };
}
function inventory(root, skipModules = false) {
  const rows = [];
  function walk(path = '') {
    const full = join(root, path), st = lstatSync(full);
    if (st.isSymbolicLink()) {
      assert.ok(within(root, realpathSync(full)), 'Installed package symlink escapes its root');
      rows.push({ path, link: readlinkSync(full) });
    } else if (st.isDirectory()) for (const name of readdirSync(full).sort()) {
      if (!skipModules || name !== 'node_modules') walk(path ? path + '/' + name : name);
    } else { assert.ok(st.isFile()); rows.push({ path, ...file(full), executable: st.mode & 0o111 }); }
  }
  walk(); return rows;
}
function packagesAt(nodeModules) {
  const rows = [];
  function visit(modules) {
    for (const name of readdirSync(modules).sort()) {
      if (name.startsWith('.')) continue;
      const roots = name.startsWith('@') ? readdirSync(join(modules, name)).sort().map(x => join(modules, name, x)) : [join(modules, name)];
      for (const root of roots) {
        assert.equal(lstatSync(root).isSymbolicLink(), false, 'Supply requires the official hoisted layout');
        const pkg = json(join(root, 'package.json')), files = inventory(root, true);
        rows.push({ name: pkg.name, version: pkg.version, location: relative(nodeModules, root), files, payloadSHA: sha(JSON.stringify(files)) });
        if (existsSync(join(root, 'node_modules'))) visit(join(root, 'node_modules'));
      }
    }
  }
  visit(nodeModules); return rows.sort((a, b) => (a.name + '@' + a.version + ':' + a.location).localeCompare(b.name + '@' + b.version + ':' + b.location));
}
const packageSet = rows => rows.map(({ name, version, payloadSHA }) => ({ name, version, payloadSHA })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const targetIdentity = row => row && { scope: row.scope, name: row.name, version: row.version, payloadSHA: row.payloadSHA };
function comparableGraph(graph) {
  // Do not collapse equal package names: every concrete consumer remains an array entry.
  // Physical location may differ; scope, payload, declared edges and multiplicity may not.
  const ordered = rows => rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const consumers = graph.map(({ owner, requires }) => ({ owner: targetIdentity(owner), requires: requires.map(({ target, ...edge }) => ({ ...edge, target: targetIdentity(target) })) }));
  const sharing = new Map();
  for (const { owner, requires } of graph) for (const { target, ...edge } of requires) if (target) {
    const key = target.scope + '/' + target.location;
    if (!sharing.has(key)) sharing.set(key, { target: targetIdentity(target), consumers: [] });
    sharing.get(key).consumers.push({ owner: targetIdentity(owner), ...edge });
  }
  // Retain which consumers share one actual instance, without requiring that instance's hoist path.
  return { consumers: ordered(consumers), sharedTargets: ordered([...sharing.values()].map(row => ({ ...row, consumers: ordered(row.consumers) }))) };
}
function consumerGraph(state, api, requireHost, packages, hostCordis, uiRoot) {
  const instances = new Map();
  for (const scope of ['host', 'profile']) {
    const modules = join(scope === 'host' ? join(state.root, 'host') : state.profileDir, 'node_modules');
    for (const row of packages[scope]) instances.set(realpathSync(join(modules, row.location)), { scope, name: row.name, version: row.version, payloadSHA: row.payloadSHA, location: row.location });
  }
  const target = root => {
    if (!root) return null;
    const item = instances.get(realpathSync(root)); assert.ok(item, 'Official dependency escaped the installed host/profile inventory'); return item;
  };
  let browser;
  function browserReact() {
    if (browser) return browser;
    const webApp = requireHost.resolve('@deepseek-ai/dsh-web-app/package.json');
    const frontendRoot = dirname(createRequire(webApp).resolve('@deepseek-ai/dsh-web-frontend/package.json'));
    const frontend = target(frontendRoot); assert.equal(frontend.scope, 'host');
    const shell = readFileSync(join(frontendRoot, 'dist/assets/index-BgUyXZcc.js'));
    assert.equal(sha(shell), 'c7e9821660f7e0f0524cc7cb1a375a5171eebbe68e167b80d290bd2ea391286d');
    const loader = readFileSync(requireHost.resolve('@deepseek-ai/dsh-client-modules/client'));
    assert.equal(sha(loader), '74e834b85e44f75874198bb0e937de98fd78c2bc0c5145cc14032185f579731f');
    const client = readFileSync(join(uiRoot, 'lib/client.js'), 'utf8');
    assert.deepEqual([...new Set([...client.matchAll(/\brequire\("([^"\n]+)"\)/g)].map(x => x[1]))], ['react']);
    // Fixed official shell seed and loader provide the same browser React 18.3.1 object.
    browser = { scope: 'browser', name: 'react', version: '18.3.1', location: 'official-shell-seed/react',
      payloadSHA: sha(JSON.stringify({ frontend: targetIdentity(frontend), shell: sha(shell), loader: sha(loader), client: sha(client) })) };
    return browser;
  }
  const graph = [];
  for (const [root, owner] of instances) {
    const manifest = json(join(root, 'package.json')), requires = [], parent = pathToFileURL(join(root, 'package.json')).href;
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) for (const [name, range] of Object.entries(manifest[field] || {}).sort()) {
      const optional = field === 'optionalDependencies' || field === 'peerDependencies' && manifest.peerDependenciesMeta?.[name]?.optional === true;
      const actual = api.packageOf(name, parent); let consumed = target(actual?.dir), supply = 'official-server-resolver';
      if (owner.scope === 'profile' && owner.name === UI && owner.version === '0.1.0' && field === 'peerDependencies' && name === 'react') {
        assert.equal(range, '18.3.1'); consumed = browserReact(); supply = 'official-browser-seed';
      } else if (!optional) assert.ok(consumed, 'Missing required dependency: ' + owner.name + ' -> ' + name);
      if (name === '@deepseek-ai/cordis' && actual) assert.equal(realpathSync(actual.dir), hostCordis, 'A declared Cordis consumer chose another instance');
      requires.push({ field, name, range, optional, supply, target: consumed });
    }
    graph.push({ owner, requires });
  }
  return graph;
}

async function run(state, label, executable, args, cwd = state.root) {
  state.signal?.throwIfAborted();
  const base = join(state.root, 'commands', label), stdout = openSync(base + '.stdout.log', 'wx', 0o600), stderr = openSync(base + '.stderr.log', 'wx', 0o600);
  let child, timer, hardTimer, aborted = false, timedOut = false;
  const kill = signal => { if (!child?.pid) return; try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
  const stop = () => { kill('SIGTERM'); hardTimer ??= setTimeout(() => kill('SIGKILL'), 5000); };
  const abort = () => { aborted = true; stop(); };
  let result;
  try {
    child = spawn(executable, args, { cwd, env: state.env, detached: true, stdio: ['ignore', stdout, stderr] });
    save(base + '.command.json', { executable, args, cwd, environmentKeys: Object.keys(state.env).sort(), pid: child.pid, startedAt: new Date().toISOString() });
    state.signal?.addEventListener('abort', abort, { once: true }); if (state.signal?.aborted) abort();
    timer = setTimeout(() => { timedOut = true; stop(); }, 900000);
    result = await new Promise(done => { child.once('error', error => done({ code: null, error: errorData(error) })); child.once('close', (code, signal) => done({ code, signal })); });
  } finally {
    clearTimeout(timer); clearTimeout(hardTimer); state.signal?.removeEventListener('abort', abort); closeSync(stdout); closeSync(stderr);
  }
  save(base + '.result.json', { ...result, aborted, timedOut, endedAt: new Date().toISOString() });
  assert.ok(!aborted && !timedOut && result.code === 0, `${label} failed; preserved logs: ${base}`);
}

async function initialize(root, bootstrap, offlineStore, signal, ownedCache) {
  checkPlatform(bootstrap); assert.equal(isAbsolute(root), true);
  mkdirSync(root, { mode: 0o700 }); // Existing successful or failed stages are never reused.
  root = realpathSync(root);
  for (const name of ['commands', 'tooling', 'host', 'release', 'bootstrap-home', 'bootstrap-agents', 'config', 'cache', 'store', 'tmp', 'bin']) mkdirSync(join(root, name), { mode: 0o700 });
  // Only a preparation's own private download resources may be reused by its replay.
  // This is not an external-resource escape hatch; public installation has no such option.
  if (ownedCache) {
    assert.equal(root, join(ownedCache.root, 'frozen-replay'));
    assert.deepEqual(offlineStore, { pnpmArchive: join(ownedCache.root, 'tooling/pnpm.tgz'),
      storeDir: join(ownedCache.root, 'store'), cacheDir: join(ownedCache.root, 'cache') });
  }
  const cacheRoot = ownedCache?.root ?? root, config = join(root, 'config');
  for (const name of ['npmrc', 'npm-globalrc']) writeFileSync(join(config, name), '', { flag: 'wx', mode: 0o600 });
  const env = { PATH: join(root, 'bin') + ':' + dirname(process.execPath) + ':/usr/bin:/bin', HOME: join(root, 'bootstrap-home'),
    DSH_HOME: join(root, 'bootstrap-home'), DSH_AGENTS_HOME: join(root, 'bootstrap-agents'), TMPDIR: join(root, 'tmp'),
    XDG_CONFIG_HOME: config, XDG_CACHE_HOME: join(cacheRoot, 'cache'), XDG_STATE_HOME: join(root, 'bootstrap-home'), XDG_DATA_HOME: join(root, 'bootstrap-home'),
    NPM_CONFIG_USERCONFIG: join(config, 'npmrc'), NPM_CONFIG_GLOBALCONFIG: join(config, 'npm-globalrc'),
    NPM_CONFIG_CACHE: join(cacheRoot, 'cache'), CI: '1', LANG: 'en_US.UTF-8', NODE_DISABLE_COMPILE_CACHE: '1' };
  for (const [key, value] of Object.entries({ store_dir: join(cacheRoot, 'store'), cache_dir: join(cacheRoot, 'cache'), config_dir: config,
    state_dir: join(root, 'bootstrap-home'), userconfig: join(config, 'npmrc'), globalconfig: join(config, 'npm-globalrc'),
    ignore_scripts: 'true', ignore_pnpmfile: 'true', package_import_method: 'copy', offline: offlineStore ? 'true' : 'false', registry: 'https://registry.npmjs.org/' })) {
    env['npm_config_' + key] = value; env['pnpm_config_' + key] = value;
  }
  const state = { root, bootstrap, env, signal, profileName: 'arcfold', profileDir: join(root, 'bootstrap-home/profiles/arcfold') };
  save(join(root, 'install-start.json'), { schema: 'arcfold-install-stage-v1', bootstrap, offline: Boolean(offlineStore), cacheOwner: cacheRoot, reusedPrivateCache: Boolean(ownedCache), startedAt: new Date().toISOString() });
  try {
    const archive = join(root, 'tooling/pnpm.tgz');
    if (offlineStore) {
      assert.ok(Object.keys(offlineStore).every(key => ['pnpmArchive', 'storeDir', 'cacheDir'].includes(key)) && offlineStore.pnpmArchive && offlineStore.storeDir);
      copy(realpathSync(resolve(offlineStore.pnpmArchive)), archive);
      for (const [key, destination] of [['storeDir', 'store'], ['cacheDir', 'cache']]) if (offlineStore[key] && !ownedCache) {
        const source = realpathSync(resolve(offlineStore[key]));
        assert.ok(inventory(source).every(row => row.link === undefined), 'Offline resources must not link back into immutable sources');
        cpSync(source, join(root, destination), { recursive: true, dereference: false, errorOnExist: true, force: false });
      }
    } else {
      const response = await fetch(bootstrap.pnpm.url, { redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(120000), ...(signal ? [signal] : [])]) });
      assert.equal(response.status, 200, 'Pinned pnpm download failed');
      writeFileSync(archive, Buffer.from(await response.arrayBuffer()), { flag: 'wx', mode: 0o600 });
    }
    assert.deepEqual(file(archive), { sha256: bootstrap.pnpm.sha256, bytes: bootstrap.pnpm.bytes });
    assert.equal('sha512-' + createHash('sha512').update(readFileSync(archive)).digest('base64'), bootstrap.pnpm.integrity);
    await run(state, 'extract-pnpm', '/usr/bin/tar', ['-xzf', archive, '-C', join(root, 'tooling')]);
    const pkg = json(join(root, 'tooling/package/package.json')); assert.equal(pkg.name, 'pnpm'); assert.equal(pkg.version, bootstrap.pnpm.version);
    state.pnpm = join(root, 'tooling/package/bin/pnpm.mjs');
    // Official plugin management invokes pnpm by name; this local wrapper never consults a user/global install.
    const quote = text => "'" + text.replaceAll("'", "'\\''") + "'";
    writeFileSync(join(root, 'bin/pnpm'), '#!/bin/sh\nexec ' + quote(process.execPath) + ' ' + quote(state.pnpm) + ' "$@"\n', { flag: 'wx', mode: 0o700 });
    return state;
  } catch (error) { save(join(root, 'failure.json'), { stage: 'bootstrap', ...errorData(error) }); throw error; }
}
function copyRelease(state, release) {
  for (const pkg of release.manifest.packages) copy(join(release.root, pkg.file), join(state.root, 'release', pkg.file));
  copy(join(release.root, 'manifest.json'), join(state.root, 'release/manifest.json'));
}
async function initializeProfile(state) {
  const requireHost = createRequire(join(state.root, 'host/package.json'));
  state.installAnchor = requireHost.resolve('@deepseek-ai/dsh/package.json');
  state.cliPath = requireHost.resolve('@deepseek-ai/dsh/lib/bin.js');
  assert.equal(json(state.installAnchor).version, state.bootstrap.dsh);
  assert.equal(existsSync(state.profileDir), false);
  await run(state, 'profile-initialize', process.execPath, [state.cliPath, '--profile', state.profileName, '--from-default-profile', 'web', '--dump-config']);
  assert.deepEqual(json(join(state.profileDir, 'package.json')).dsh.profile.bundles, BUNDLES.slice(0, 2));
  const yaml = await import(pathToFileURL(requireHost.resolve('js-yaml')));
  const workspace = yaml.load(readFileSync(join(state.profileDir, 'pnpm-workspace.yaml'), 'utf8'));
  assert.equal(workspace.nodeLinker, 'hoisted'); assert.equal(workspace.autoInstallPeers, false);
}
function installFiles(state) {
  const rows = [];
  for (const dir of ['host/node_modules', 'bootstrap-home/profiles/arcfold/node_modules', 'tooling/package'])
    for (const row of inventory(join(state.root, dir))) rows.push({ ...row, path: dir + '/' + row.path });
  for (const name of ['host/package.json', 'host/pnpm-lock.yaml', 'host/pnpm-workspace.yaml',
    'bootstrap-home/profiles/arcfold/package.json', 'bootstrap-home/profiles/arcfold/pnpm-lock.yaml',
    'bootstrap-home/profiles/arcfold/pnpm-workspace.yaml', 'bootstrap-home/profiles/arcfold/cordis.patch.yml']) {
    assert.equal(lstatSync(join(state.root, name)).isSymbolicLink(), false);
    rows.push({ path: name, ...file(join(state.root, name)) });
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}
const PROVIDERS = [
  { key: 'deepseek-official', package: '@deepseek-ai/dsh-llm-deepseek', wrapper: 'deepseek-provider',
    script: 'patch-deepseek-transport', inspect: 'inspectDeepSeekPatch', apply: 'applyDeepSeekPatch', receipt: 'provider-patch' },
  { key: 'openai', package: '@deepseek-ai/dsh-llm-pi-ai', wrapper: 'openai-provider',
    script: 'patch-pi-ai-transport', inspect: 'inspectPiAiPatch', apply: 'applyPiAiPatch', receipt: 'pi-ai-patch' },
];

const MODEL_SELECTION = { key: 'modelSelection', package: '@deepseek-ai/dsh-api-session-controller',
  script: 'patch-model-selection', inspect: 'inspectModelSelectionPatch', apply: 'applyModelSelectionPatch', receipt: 'model-selection-patch' };

/** The root Include consumes bare controller names from profile/cordis.yml's directory.
 * This is distinct from the two wrappers' own dependency imports. Check all three
 * original targets before any patch writes or module imports. */
export async function inspectNativeComponents({ api, coreRoot, profileDir, installationDir, profileEntries, patch = false }) {
  const controllers = profileEntries?.filter(entry => entry.id === 'session-controller');
  assert.equal(controllers?.length, 1, 'The actual profile must contain exactly one session controller');
  assert.equal(controllers[0].name, MODEL_SELECTION.package, 'The profile replaced the native session controller');
  assert.notEqual(controllers[0].disabled, true, 'The native session controller must be enabled');
  const targets = [];
  for (const definition of [...PROVIDERS, MODEL_SELECTION]) {
    const parent = definition.wrapper ? pathToFileURL(join(coreRoot, 'src', definition.wrapper + '.mjs')).href
      : new URL('.', pathToFileURL(join(profileDir, 'cordis.yml'))).href;
    const path = api.packageOf(definition.package, parent)?.dir;
    const boundary = definition.wrapper ? profileDir : installationDir;
    assert.ok(path && within(realpathSync(boundary), realpathSync(path)),
      definition.wrapper ? 'Native provider must be consumed from this profile' : 'Native controller must be consumed from this installation');
    assert.equal(realpathSync(createRequire(parent).resolve(definition.package)), join(path, 'lib/index.js'),
      'Official resolver and actual native consumption differ');
    const patcher = await import(pathToFileURL(join(coreRoot, 'scripts', definition.script + '.mjs')));
    assert.equal(patcher[definition.inspect](path).state, 'original', 'Native component must start from exact original bytes');
    targets.push({ definition, path, patcher });
  }
  // Preserve each receipt even if a later patch or loaded capability fails.
  if (patch) for (const { definition, path, patcher } of targets)
    patcher[definition.apply]({ packageDir: path, receiptDir: join(installationDir, definition.receipt) });
  const components = {};
  for (const { definition, path, patcher } of targets) {
    const entry = { path, patchId: patcher.patchSpec.id };
    if (patch) {
      const loaded = await import(pathToFileURL(join(path, 'lib/index.js')));
      const capability = patcher.patchSpec.runtimeCapability;
      assert.deepEqual(Object.getOwnPropertyDescriptor(loaded[capability.export], capability.property), {
        value: capability.value, writable: false, enumerable: true, configurable: false,
      }, 'The actual loaded native component lacks the frozen capability');
      entry.receipt = join(installationDir, definition.receipt, 'report.json');
      entry.receiptSHA256 = file(entry.receipt).sha256;
    }
    components[definition.key] = entry;
  }
  return { providers: Object.fromEntries(PROVIDERS.map(row => [row.key, components[row.key]])), modelSelection: components.modelSelection };
}

/** Verify the installed implementation without opening any persistent business or ledger file. */
export async function inspectBusinessSchema(coreRoot) {
  const { Store } = await import(pathToFileURL(join(coreRoot, 'src/store.mjs')));
  const store = new Store(':memory:');
  try {
    assert.equal(store.metaTable, 'business_meta');
    assert.equal(store.db.prepare("SELECT value FROM business_meta WHERE key='schema_version'").get().value, '1');
    assert.equal(store.db.prepare("SELECT name FROM sqlite_schema WHERE name='store_meta'").get(), undefined);
  } finally { store.close(); }
}

async function inspect(state, release, patch, packages, expectedGraph) {
  const requireHost = createRequire(join(state.root, 'host/package.json'));
  const profileRequire = createRequire(join(state.profileDir, 'package.json'));
  const coreRoot = dirname(profileRequire.resolve(CORE + '/package.json')), uiRoot = dirname(profileRequire.resolve(UI + '/package.json'));
  for (const pkg of release.manifest.packages) {
    const root = pkg.name === CORE ? coreRoot : uiRoot; assert.ok(within(state.profileDir, realpathSync(root)));
    for (const item of pkg.files) assert.equal(file(join(root, safe(item.path))).sha256, item.sha256, 'Installed release content differs');
  }
  const { Context } = await import(pathToFileURL(requireHost.resolve('@deepseek-ai/cordis')));
  const { loadProfileDirectory, createRuntimeResolution, PluginPackages, composeEntries } = await import(pathToFileURL(requireHost.resolve('@deepseek-ai/dsh-app-boot')));
  assert.deepEqual(json(join(state.profileDir, 'package.json')).dsh.profile.bundles, BUNDLES);
  const profile = loadProfileDirectory('dsh', state.profileDir, state.installAnchor, { userLayer: false });
  assert.deepEqual(profile.skippedBundles, []); assert.deepEqual(profile.layers.map(row => row.packageName), BUNDLES);
  const resolution = await createRuntimeResolution({ installAnchor: state.installAnchor, profile, home: join(state.root, 'bootstrap-home') });
  const ctx = new Context(); let providers, modelSelection, graph;
  try {
    await ctx.plugin(PluginPackages, { resolution });
    const api = ctx.get('pluginPackages');
    const hostCordis = realpathSync(dirname(requireHost.resolve('@deepseek-ai/cordis/package.json')));
    for (const root of [coreRoot, uiRoot]) assert.equal(realpathSync(api.packageOf('@deepseek-ai/cordis', pathToFileURL(join(root, 'package.json')).href).dir), hostCordis);
    graph = consumerGraph(state, api, requireHost, packages, hostCordis, uiRoot);
    if (expectedGraph) assert.deepEqual(comparableGraph(graph), comparableGraph(expectedGraph), 'Actual installed dependency consumption differs from the frozen supply');
    ({ providers, modelSelection } = await inspectNativeComponents({ api, coreRoot, profileDir: state.profileDir,
      installationDir: state.root, profileEntries: composeEntries(profile.layers.map(layer => layer.patches)), patch }));
    const { SESSION_FORMAT_VERSION } = await import(pathToFileURL(requireHost.resolve('@deepseek-ai/dsh-session')));
    assert.equal(SESSION_FORMAT_VERSION, 4);
    await inspectBusinessSchema(coreRoot);
  } finally { await ctx.fiber.dispose(); }
  return { coreRoot, uiRoot, consumerGraph: graph, provider: providers['deepseek-official'], providers, modelSelection,
    compatibility: { businessSchema: 1, nativeFormat: 4 } };
}
function replaceArchiveRoots(text, release, from, to) {
  for (const pkg of release.manifest.packages) text = text.split(join(from, pkg.file)).join(to + '/' + pkg.file);
  return text;
}
function supplyAt(path, release) {
  path = realpathSync(resolve(path));
  const root = dirname(path), supply = json(path);
  assert.equal(supply.schema, 'arcfold-runtime-supply-v1'); assert.equal(supply.ready, true);
  assert.equal(supply.releaseManifestSHA, release.manifestSHA); assert.equal(supply.sourceCommit, release.manifest.source.commit);
  checkPlatform(supply.bootstrap);
  assert.deepEqual(supply.files.map(row => row.path).sort(), ['host/package.json', 'host/pnpm-lock.yaml', 'host/pnpm-workspace.yaml',
    'packages.json', 'profile/package.json', 'profile/pnpm-lock.yaml', 'profile/pnpm-workspace.yaml'].sort());
  for (const row of supply.files) assert.deepEqual(file(join(root, safe(row.path))), { sha256: row.sha256, bytes: row.bytes });
  return { root, path, supply };
}

const FROZEN_INPUTS = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];

// Shared by supply replay and public installation: no installed node_modules are copied.
export async function materializeFrozenRuntime(state, release, sourceRoot) {
  const inputs = ['host', 'profile'].flatMap(scope => FROZEN_INPUTS.map(name => ({
    path: scope + '/' + name, ...file(join(sourceRoot, scope, name)),
  })));
  copyRelease(state, release);
  for (const name of FROZEN_INPUTS) copy(join(sourceRoot, 'host', name), join(state.root, 'host', name));
  await run(state, 'host-install', process.execPath, [state.pnpm, 'install', '--frozen-lockfile', '--ignore-scripts'], join(state.root, 'host'));
  for (const row of inputs.filter(row => row.path.startsWith('host/')))
    assert.deepEqual(file(join(state.root, row.path)), { sha256: row.sha256, bytes: row.bytes }, 'Frozen host input changed: ' + row.path);
  await initializeProfile(state);
  // Only the just-created empty profile is replaced by the release's actual frozen install inputs.
  const relocation = [];
  for (const name of FROZEN_INPUTS) {
    const original = readFileSync(join(sourceRoot, 'profile', name), 'utf8');
    assert.equal(sha(original), inputs.find(row => row.path === 'profile/' + name).sha256, 'Frozen profile source changed');
    const content = replaceArchiveRoots(original, release, '__ARCFOLD_RELEASE_ROOT__', join(state.root, 'release'));
    assert.equal(content.includes('__ARCFOLD_RELEASE_ROOT__'), false, 'Unexpected profile path placeholder');
    const target = join(state.profileDir, name);
    if (existsSync(target)) assert.ok(name !== 'pnpm-lock.yaml', 'Fresh profile unexpectedly has a lock');
    relocation.push({ file: name, beforeSHA: sha(original), afterSHA: sha(content) });
    writeFileSync(target, content, { mode: 0o600, flag: name === 'pnpm-lock.yaml' ? 'wx' : 'w' });
  }
  save(join(state.root, 'profile-relocation.json'), relocation);
  await run(state, 'profile-install', process.execPath, [state.cliPath, 'plugin', '--profile', state.profileName, 'install', '--frozen-lockfile', '--ignore-scripts']);
  for (const row of relocation) assert.equal(file(join(state.profileDir, row.file)).sha256, row.afterSHA);
  for (const row of inputs) assert.deepEqual(file(join(sourceRoot, row.path)), { sha256: row.sha256, bytes: row.bytes }, 'Frozen source input changed');
  return { host: packagesAt(join(state.root, 'host/node_modules')), profile: packagesAt(join(state.profileDir, 'node_modules')) };
}

/** New version installation only. Neither native user state nor a ledger is opened. */
export async function installRelease({ releaseDir, installationDir, supplyManifest, offlineStore, signal }) {
  const release = releaseAt(releaseDir), source = supplyAt(supplyManifest ?? join(release.root, 'runtime/supply.json'), release);
  const destination = newDestination(installationDir, [release.root, source.root, offlineStore?.storeDir, offlineStore?.cacheDir, offlineStore?.pnpmArchive]);
  const state = await initialize(destination, source.supply.bootstrap, offlineStore, signal);
  try {
    const actualPackages = await materializeFrozenRuntime(state, release, source.root);
    const expected = json(join(source.root, 'packages.json'));
    for (const scope of ['host', 'profile']) assert.deepEqual(packageSet(actualPackages[scope]), expected[scope], `Actual ${scope} package payloads differ from the prepared supply`);
    assert.ok(Array.isArray(expected.consumerGraph) && expected.consumerGraph.length > 0);
    const { consumerGraph: graph, ...inspected } = await inspect(state, release, true, actualPackages, expected.consumerGraph);
    save(join(state.root, 'dependency-consumers.json'), graph);
    const files = installFiles(state); save(join(state.root, 'installation-files.json'), files);
    const receipt = { schema: 'arcfold-installation-v1', installationDir: state.root, hostRoot: join(state.root, 'host'), installAnchor: state.installAnchor,
      cliPath: state.cliPath, profileDir: state.profileDir, profileName: state.profileName, sourceCommit: release.manifest.source.commit,
      ...inspected, packageManager: { command: process.execPath, args: [state.pnpm] },
      identities: { releaseManifestSHA: release.manifestSHA, supplyManifestSHA: file(source.path).sha256,
        bootstrap: source.supply.bootstrap, node: { path: process.execPath, ...file(process.execPath) },
        consumers: { path: 'dependency-consumers.json', ...file(join(state.root, 'dependency-consumers.json')), count: graph.length },
        fileManifest: { path: 'installation-files.json', ...file(join(state.root, 'installation-files.json')), count: files.length } },
      installedAt: new Date().toISOString(), modelsCalled: 0, hostStarted: false };
    save(join(state.root, 'installation.json'), receipt); return readInstallation(join(state.root, 'installation.json'));
  } catch (error) { if (!existsSync(join(state.root, 'failure.json'))) save(join(state.root, 'failure.json'), { stage: 'installation', ...errorData(error) }); throw error; }
}

/** No directory creation, imports of installed code, configuration writes or service start. */
export function readInstallation(installationFile) {
  const filename = realpathSync(resolve(installationFile)), receipt = json(filename), root = realpathSync(dirname(filename));
  assert.equal(receipt.schema, 'arcfold-installation-v1'); assert.equal(receipt.installationDir, root);
  assert.equal(receipt.profileName, 'arcfold'); assert.deepEqual(receipt.compatibility, { businessSchema: 1, nativeFormat: 4 });
  checkPlatform(receipt.identities.bootstrap); assert.equal(receipt.identities.node.path, process.execPath);
  assert.deepEqual(file(process.execPath), { sha256: receipt.identities.node.sha256, bytes: receipt.identities.node.bytes });
  for (const path of [receipt.hostRoot, receipt.installAnchor, receipt.cliPath, receipt.profileDir, receipt.coreRoot, receipt.uiRoot, receipt.provider.path, ...receipt.packageManager.args])
    assert.ok(within(root, realpathSync(path)), 'Installation reference escaped its immutable version directory');
  if (receipt.providers !== undefined) {
    assert.deepEqual(Object.keys(receipt.providers).sort(), PROVIDERS.map(row => row.key).sort(), 'Incomplete native provider proof');
    assert.deepEqual(receipt.provider, receipt.providers['deepseek-official'], 'DeepSeek compatibility alias differs');
    for (const definition of PROVIDERS) {
      const entry = receipt.providers[definition.key];
      assert.ok(within(realpathSync(receipt.profileDir), realpathSync(entry.path)), 'Native provider escaped its profile');
      const metadata = json(join(entry.path, 'package.json'));
      assert.equal(metadata.name, definition.package); assert.equal(metadata.version, '0.2.2-rc.1');
      assert.equal(entry.receipt, join(root, definition.receipt, 'report.json'));
      assert.ok(within(root, realpathSync(entry.receipt)), 'Provider receipt escaped its version directory');
      assert.equal(file(entry.receipt).sha256, entry.receiptSHA256, 'Provider patch receipt changed');
      const proof = json(entry.receipt);
      assert.equal(proof.completed, true); assert.equal(proof.after.state, 'patched');
      assert.equal(proof.after.packageDir, entry.path); assert.equal(proof.after.patchId, entry.patchId);
    }
  }
  if (receipt.modelSelection !== undefined) {
    const entry = receipt.modelSelection;
    assert.deepEqual(Object.keys(entry).sort(), ['path', 'patchId', 'receipt', 'receiptSHA256'].sort(), 'Invalid model selection proof');
    assert.ok(within(root, realpathSync(entry.path)), 'Native controller escaped its installation');
    const metadata = json(join(entry.path, 'package.json'));
    assert.equal(metadata.name, MODEL_SELECTION.package); assert.equal(metadata.version, '0.2.2-rc.1');
    const spec = json(join(receipt.coreRoot, 'patches/session-controller-0.2.2-rc.1-model-selection.json'));
    assert.equal(spec.package, MODEL_SELECTION.package); assert.equal(spec.version, metadata.version);
    assert.equal(entry.patchId, spec.id);
    assert.equal(entry.receipt, join(root, MODEL_SELECTION.receipt, 'report.json'));
    assert.ok(within(root, realpathSync(entry.receipt)), 'Controller receipt escaped its version directory');
    assert.equal(file(entry.receipt).sha256, entry.receiptSHA256, 'Controller patch receipt changed');
    const proof = json(entry.receipt);
    assert.equal(proof.completed, true); assert.equal(proof.after.state, 'patched');
    assert.equal(proof.after.packageDir, entry.path); assert.equal(proof.after.patchId, entry.patchId);
    assert.equal(proof.after.patchSpecSha256, file(join(receipt.coreRoot, 'patches/session-controller-0.2.2-rc.1-model-selection.json')).sha256);
    for (const item of spec.files) assert.equal(file(join(entry.path, safe(item.path))).sha256, item.afterSha256, 'Installed controller patch bytes changed');
  }
  assert.equal(receipt.packageManager.command, process.execPath);
  const manifest = receipt.identities.fileManifest, path = join(root, safe(manifest.path));
  assert.deepEqual(file(path), { sha256: manifest.sha256, bytes: manifest.bytes });
  const files = json(path); assert.equal(files.length, manifest.count);
  const consumers = receipt.identities.consumers;
  assert.deepEqual(file(join(root, safe(consumers.path))), { sha256: consumers.sha256, bytes: consumers.bytes });
  assert.equal(json(join(root, consumers.path)).length, consumers.count);
  // Includes additions/removals and links, so a new nested dependency cannot shadow an unchanged recorded file.
  assert.deepEqual(installFiles({ root }), files, 'Installed code or profile assets changed');
  return { ...receipt, installationFile: filename };
}

/** Release-maintenance operation, never invoked by daily start. Output remains outside both tgz archives. */
export async function prepareRuntimeSupply({ releaseDir, outputDir, offlineStore, signal }) {
  const release = releaseAt(releaseDir), templates = resolve(HERE, '../runtime'), bootstrap = json(join(templates, 'bootstrap.json'));
  const destination = newDestination(outputDir, [release.root, templates, offlineStore?.storeDir, offlineStore?.cacheDir, offlineStore?.pnpmArchive]);
  const state = await initialize(destination, bootstrap, offlineStore, signal);
  try {
    copyRelease(state, release);
    for (const name of ['package.json', 'pnpm-workspace.yaml']) copy(join(templates, 'host', name), join(state.root, 'host', name));
    await run(state, 'host-resolve', process.execPath, [state.pnpm, 'install', '--ignore-scripts'], join(state.root, 'host'));
    await initializeProfile(state);
    writeFileSync(join(state.profileDir, 'pnpm-workspace.yaml'), readFileSync(join(templates, 'profile/pnpm-workspace.yaml')), { mode: 0o600 });
    await run(state, 'profile-add', process.execPath, [state.cliPath, 'plugin', '--profile', state.profileName, 'add',
      ...release.manifest.packages.map(pkg => join(state.root, 'release', pkg.file)), '--ignore-scripts']);
    return await freezeRuntimeSupply(state, release);
  } catch (error) { if (!existsSync(join(state.root, 'failure.json'))) save(join(state.root, 'failure.json'), { stage: 'supply-preparation', ...errorData(error) }); throw error; }
}

// Maintenance boundary: called only after official host resolution and profile add finish.
export async function freezeRuntimeSupply(state, release) {
  const { bootstrap, signal } = state;
  const target = join(state.root, 'runtime'); mkdirSync(target, { mode: 0o700 });
  for (const scope of ['host', 'profile']) for (const name of FROZEN_INPUTS) {
    const input = join(scope === 'host' ? join(state.root, 'host') : state.profileDir, name), output = join(target, scope, name);
    mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
    const text = readFileSync(input, 'utf8');
    const projected = scope === 'profile' ? replaceArchiveRoots(text, release, join(state.root, 'release'), '__ARCFOLD_RELEASE_ROOT__') : text;
    assert.equal(projected.includes(state.root), false, 'Supply lock leaked an installation-specific path');
    writeFileSync(output, projected, { flag: 'wx', mode: 0o600 });
  }
  // Fresh resolution and frozen install can choose different hoisted instances even
  // with the same final lock. Keep the initial tree, but certify the consumer path.
  const inputs = inventory(target);
  const replay = await initialize(join(state.root, 'frozen-replay'), bootstrap, {
    pnpmArchive: join(state.root, 'tooling/pnpm.tgz'), storeDir: join(state.root, 'store'), cacheDir: join(state.root, 'cache'),
  }, signal, state);
  let packages, inspected;
  try {
    packages = await materializeFrozenRuntime(replay, release, target);
    inspected = await inspect(replay, release, false, packages);
    assert.deepEqual(inventory(target), inputs, 'Frozen supply inputs changed during replay');
    save(join(replay.root, 'replay-inspection.json'), { inputRoot: target, inputs, cacheOwner: state.root,
      storeDir: join(state.root, 'store'), cacheDir: join(state.root, 'cache'), offline: true,
      initialInstallationPreserved: true, installedPackagesCopied: false, patched: false,
      packages: { host: packageSet(packages.host), profile: packageSet(packages.profile) },
      consumerGraph: inspected.consumerGraph });
  } catch (error) {
    if (!existsSync(join(replay.root, 'failure.json'))) save(join(replay.root, 'failure.json'), { stage: 'frozen-replay', ...errorData(error) });
    throw error;
  }
  save(join(target, 'packages.json'), { host: packageSet(packages.host), profile: packageSet(packages.profile), consumerGraph: inspected.consumerGraph });
  const files = inventory(target);
  save(join(target, 'supply.json'), { schema: 'arcfold-runtime-supply-v1', ready: true, bootstrap, sourceCommit: release.manifest.source.commit,
    releaseManifestSHA: release.manifestSHA, files, origin: 'Clean offline frozen host/profile replay of final resolved inputs; initial resolution preserved; not a development or cache seed lock',
    createdAt: new Date().toISOString(), hostStarted: false, modelCalls: 0 });
  return { supplyManifest: join(target, 'supply.json'), outputDir: state.root, sourceCommit: release.manifest.source.commit };
}
