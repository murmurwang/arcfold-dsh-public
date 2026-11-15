// The unpacked release entry uses Node builtins only. Runtime code is selected
// from the verified installation, so this directory needs no node_modules.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, existsSync, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalRuntimePath, loadRuntimeIdentity, loadRuntimePlan, runtimeTransport } from './runtime-config.mjs';
import { installRelease, readInstallation } from './runtime-installation.mjs';
import { canonicalJson } from './store.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, path) => path === root || path.startsWith(root + sep);
const protocol = 'arcfold-runtime-v1';
const runIdValid = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);

function privateJson(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    assert.ok(info.isFile() && info.uid === process.getuid() && (info.mode & 0o777) === 0o600 && info.size <= 2 * 1024 * 1024,
      'Runtime ownership records must be private regular files');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}

/** A stop must still work after the selected model/version is edited. Verify
 * only the old owner's management code and native lock, not its model or UI. */
export function managementInstallation(identity) {
  const currentPath = join(identity.runtimeDirectory, 'current.json');
  if (!existsSync(currentPath)) return null;
  const current = privateJson(currentPath);
  assert.ok(current.schema === protocol && current.dataRoot === identity.dataRoot && runIdValid(current.runId),
    'Current runtime belongs to a different data directory');
  const runDirectory = join(identity.runtimeDirectory, 'runs', current.runId);
  const launch = privateJson(join(runDirectory, 'launch.json'));
  assert.ok(launch.schema === protocol && launch.runId === current.runId && launch.runDirectory === runDirectory &&
    launch.plan?.dataRoot === identity.dataRoot && launch.plan.runtimeDirectory === identity.runtimeDirectory &&
    current.configurationHash === launch.plan.configurationHash && /^[a-f0-9]{64}$/.test(current.configurationHash),
  'The current owner and launch record disagree');
  const installation = launch.plan.installation;
  assert.ok(installation?.schema === 'arcfold-installation-v1', 'The owner has no installation identity');
  const root = realpathSync(installation.installationDir);
  assert.equal(installation.installationDir, root);
  assert.equal(installation.installationFile, join(root, 'installation.json'));
  const receipt = privateJson(installation.installationFile);
  const { installationFile, ...snapshot } = installation;
  assert.equal(canonicalJson(receipt), canonicalJson(snapshot), 'The old owner installation receipt changed');
  assert.equal(installation.identities.node.path, process.execPath, 'Use the Node installation recorded for this runtime');
  const node = readFileSync(process.execPath);
  assert.equal(sha(node), installation.identities.node.sha256, 'The recorded Node executable changed');
  assert.equal(node.length, installation.identities.node.bytes);
  const manifest = installation.identities.fileManifest;
  assert.equal(manifest.path, 'installation-files.json');
  const bytes = readFileSync(join(root, manifest.path));
  assert.equal(sha(bytes), manifest.sha256); assert.equal(bytes.length, manifest.bytes);
  const files = JSON.parse(bytes); assert.equal(files.length, manifest.count);
  const byPath = new Map(files.map(file => [file.path, file]));
  assert.equal(byPath.size, files.length);
  function verify(filename) {
    const actual = realpathSync(filename);
    assert.ok(inside(root, actual), 'Management code escaped its recorded installation');
    const record = byPath.get(relative(root, actual));
    assert.ok(record && record.link === undefined, 'Management code is absent from the recorded installation');
    const content = readFileSync(actual);
    assert.equal(sha(content), record.sha256, 'Management code changed: ' + relative(root, actual));
    assert.equal(content.length, record.bytes);
    return actual;
  }
  const core = realpathSync(installation.coreRoot);
  verify(join(core, 'package.json'));
  for (const name of ['runtime-lifecycle.mjs', 'runtime-config.mjs', 'store.mjs']) verify(join(core, 'src', name));
  // The verified old manager determines its own known import closure. Earlier
  // installations do not import this module and need none of these new files.
  const configSource = readFileSync(join(core, 'src/runtime-config.mjs'), 'utf8');
  if (/\bfrom\s+['"]\.\/web-budget-recovery\.mjs['"]/.test(configSource))
    for (const name of ['web-budget-recovery.mjs', 'budget.mjs', 'evidence-ownership.mjs'])
      verify(join(core, 'src', name));
  if (/\bfrom\s+['\"]\.\/openai-models\.mjs['\"]/.test(configSource))
    verify(join(core, 'src/openai-models.mjs'));
  const require = createRequire(join(core, 'package.json'));
  const flock = verify(require.resolve('@deepseek-ai/node-addon-system/flock'));
  const flockPackage = verify(require.resolve('@deepseek-ai/node-addon-system/package.json'));
  assert.equal(JSON.parse(readFileSync(flockPackage)).version, '0.1.2');
  const platformPackage = verify(createRequire(flock).resolve(`@deepseek-ai/node-addon-system-${process.platform}-${process.arch}/package.json`));
  assert.equal(process.platform, 'darwin', 'This release currently supports macOS only');
  assert.equal(JSON.parse(readFileSync(platformPackage)).version, '0.1.2');
  verify(join(dirname(platformPackage), 'bin/system.node'));
  return installation;
}

async function runtimeApi(configPath, { currentOwner = false } = {}) {
  const identity = loadRuntimeIdentity(configPath);
  let installation = currentOwner ? managementInstallation(identity) : null;
  if (!installation) {
    // Only locating a fresh/stopped installation: model configuration is not parsed.
    const config = JSON.parse(readFileSync(identity.configPath, 'utf8'));
    installation = readInstallation(canonicalRuntimePath(config.installationFile, 'installationFile'));
  }
  const api = await import(pathToFileURL(join(installation.coreRoot, 'src/runtime-lifecycle.mjs')).href);
  return { api, identity, installation };
}

/** Only for a proposed new selection, after readInstallation has verified its
 * complete files and dependencies. Importing the private entry does not launch
 * it: runtime-host runs main only when Node executes that file as argv[1].
 * These are the v1 handoff interfaces, not a second list of internal modules.
 * Existing-owner stop/status deliberately keep their narrower management path. */
async function requireVersionRuntime(installation) {
  try {
    const api = await import(pathToFileURL(join(installation.coreRoot, 'src/runtime-lifecycle.mjs')).href);
    assert.equal(api.RUNTIME_PROTOCOL, protocol, 'Unsupported runtime management protocol');
    for (const name of ['acquireRuntimeLease', 'startRuntime', 'stopRuntime', 'statusRuntime', 'openRuntime'])
      assert.equal(typeof api[name], 'function', `Missing runtime operation: ${name}`);
    const host = await import(pathToFileURL(join(installation.coreRoot, 'src/runtime-host.mjs')).href);
    for (const name of ['runOwnedRuntime', 'openRuntimeBrowser'])
      assert.equal(typeof host[name], 'function', `Missing private host entry: ${name}`);
  } catch (cause) {
    throw Object.assign(new Error('The selected installation does not provide a compatible standalone runtime.', { cause }),
      { code: 'version_not_launchable' });
  }
}

export async function selectRuntimeVersion({ configPath, installationFile }) {
  const { api, identity } = await runtimeApi(configPath, { currentOwner: true });
  // A kernel lease covers validation and replacement, so another start cannot
  // open business state while the code selection changes.
  const lease = await api.acquireRuntimeLease(identity.runtimeDirectory);
  const temporary = join(dirname(identity.configPath), '.arcfold-version-' + randomUUID() + '.json');
  try {
    assert.deepEqual(loadRuntimeIdentity(configPath), identity, 'Data ownership changed before version selection acquired its lock');
    const original = readFileSync(identity.configPath);
    const config = JSON.parse(original);
    const previousInstallationFile = config.installationFile;
    config.installationFile = canonicalRuntimePath(installationFile, 'installationFile');
    const staged = await open(temporary, 'wx', 0o600);
    try { await staged.writeFile(JSON.stringify(config, null, 2) + '\n'); await staged.sync(); } finally { await staged.close(); }
    const next = await loadRuntimePlan(temporary);
    await requireVersionRuntime(next.installation);
    const transport = runtimeTransport(next.config);
    if (Object.values(transport.routes).some(route => route.mode === 'web-only')) {
      // Delegate only after full installation verification. The unpacked CLI
      // does not resolve native addons or inherit a local development install.
      const target = await import(pathToFileURL(join(next.installation.coreRoot, 'src/web-budget-recovery.mjs')).href)
        .catch(cause => { throw Object.assign(new Error('The selected version cannot validate web-only recovery.', { cause }), { code: 'version_not_launchable' }); });
      assert.equal(target.WEB_BUDGET_RECOVERY_VERSION, 'web-only-recovery-v1', 'Unsupported target web-only recovery capability');
      const targetConfig = await import(pathToFileURL(join(next.installation.coreRoot, 'src/runtime-config.mjs')).href);
      targetConfig.validateRuntimeConfig(next.config);
      await target.validateWebBudgetVersion(transport.routes, transport.artifactDirectory);
    }
    assert.deepEqual(readFileSync(identity.configPath), original, 'Configuration changed during version selection');
    await rename(temporary, identity.configPath);
    const directory = await open(dirname(identity.configPath), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    return { configPath: identity.configPath, previousInstallationFile, installationFile: next.installation.installationFile,
      sourceCommit: next.installation.sourceCommit, dataPreserved: true, started: false };
  } finally {
    try { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    finally { await lease.close(); }
  }
}

const FLAGS = {
  install: ['release', 'installation', 'supply', 'offline-store'],
  'export-legacy': ['installation-file', 'source-db', 'output'],
  init: ['config', 'installation-file', 'data', 'workspace', 'port', 'web-unlimited', 'main-provider', 'main-model', 'main-reasoning', 'learn-provider', 'learn-model', 'learn-reasoning', 'proxy'],
  start: ['config', 'timeout-ms'], status: ['config'], stop: ['config', 'timeout-ms'],
  restart: ['config', 'timeout-ms'], open: ['config', 'timeout-ms'],
  'use-version': ['config', 'installation-file'],
};
const REQUIRED = { 'export-legacy': ['installation-file', 'source-db', 'output'], install: ['release', 'installation'], init: ['config', 'installation-file', 'data', 'workspace'],
  start: ['config'], status: ['config'], stop: ['config'], restart: ['config'], open: ['config'], 'use-version': ['config', 'installation-file'] };
export function parseRuntimeCommand(argv) {
  if (argv.length === 0 || argv.length === 1 && ['help', '--help', '-h'].includes(argv[0])) return { command: 'help', options: {} };
  const [command, ...args] = argv; assert.ok(Object.hasOwn(FLAGS, command), 'Unknown command; use --help');
  const options = {};
  for (let i = 0; i < args.length;) {
    const flag = args[i++], name = flag?.slice(2);
    assert.ok(flag?.startsWith('--') && FLAGS[command].includes(name) && !Object.hasOwn(options, name),
      'Unsupported or duplicate option; use --help');
    if (name === 'web-unlimited') { options[name] = true; continue; }
    const value = args[i++];
    assert.ok(value && !value.startsWith('--'), 'Incomplete option; use --help');
    options[name] = value;
  }
  for (const name of REQUIRED[command]) assert.ok(options[name], `--${name} is required`);
  for (const name of ['port', 'timeout-ms']) if (options[name] !== undefined) {
    assert.match(options[name], /^\d+$/, `--${name} must be an integer`); options[name] = Number(options[name]);
  }
  for (const name of Object.keys(options).filter(name => ['config','installation-file','data','workspace','release','installation','supply','offline-store','source-db','output'].includes(name))) {
    const path = canonicalRuntimePath(options[name], name);
    if (command === 'export-legacy' && ['source-db','output'].includes(name))
      assert.equal(options[name], path, 'Legacy export requires canonical paths without aliases');
    options[name] = path;
  }
  if (command === 'init') {
    assert.equal(options['web-unlimited'], true, 'Explicit --web-unlimited confirmation is required');
    for (const prefix of ['main','learn']) {
      const fields = ['provider','model','reasoning'].map(name => prefix + '-' + name);
      assert.ok(fields.every(name => options[name] === undefined) || fields.every(name => typeof options[name] === 'string'),
        'Supply all three model choices');
    }
    if (options.proxy !== undefined) {
      const proxy = new URL(options.proxy);
      assert.ok(['http:','https:'].includes(proxy.protocol) && !proxy.username && !proxy.password &&
        proxy.pathname === '/' && !proxy.search && !proxy.hash, 'Use an explicit unauthenticated HTTP CONNECT proxy');
    }
  }
  return { command, options };
}

export const runtimeHelp = `Arcfold local product (macOS arm64, Node 24.15.0)
  install --release ABS --installation NEW_ABS [--supply ABS] [--offline-store ABS_JSON]
  init --config NEW_ABS --installation-file ABS --data ABS --workspace ABS --web-unlimited [--port 4381]
       [--proxy URL] [--main-provider ID --main-model ID --main-reasoning ID]
       [--learn-provider ID --learn-model ID --learn-reasoning ID]
  start|stop|restart|open --config ABS [--timeout-ms 60000]
  status --config ABS
  use-version --config ABS --installation-file ABS
  export-legacy --installation-file ABS --source-db ABS --output NEW_ABS
Start never installs packages. Models and credential references are explicit configuration.
Open hands the authenticated address directly to the system browser; it does not print credentials.
Version selection requires a stopped owner and preserves the existing data. See docs/local-runtime.md.`;

export async function runRuntimeCommand(argv, { signal } = {}) {
  const { command, options: o } = parseRuntimeCommand(argv); signal?.throwIfAborted();
  if (command === 'help') return runtimeHelp;
  if (command === 'install') {
    const result = await installRelease({ releaseDir: o.release, installationDir: o.installation,
      supplyManifest: o.supply, offlineStore: o['offline-store'] ? JSON.parse(readFileSync(o['offline-store'], 'utf8')) : undefined, signal });
    return { installationFile: result.installationFile, sourceCommit: result.sourceCommit, hostStarted: false };
  }
  if (command === 'export-legacy') {
    const installation = readInstallation(o['installation-file']);
    const api = await import(pathToFileURL(join(installation.coreRoot, 'src/legacy-export.mjs')).href);
    assert.equal(api.LEGACY_EXPORT_VERSION, 'legacy3-finite-projection-v1', 'Unsupported legacy exporter');
    return api.exportLegacy3({ sourceDb: o['source-db'], output: o.output, signal });
  }
  if (command === 'init') {
    const installation = readInstallation(o['installation-file']);
    assert.deepEqual(Object.keys(installation.providers ?? {}).sort(), ['deepseek-official','openai'],
      'First use requires both actual provider proofs');
    assert.ok(installation.modelSelection, 'First use requires the native model-selection proof');
    const api = await import(pathToFileURL(join(installation.coreRoot, 'src/runtime-init.mjs')).href);
    const choice = prefix => o[prefix + '-provider'] === undefined ? undefined : {
      provider: o[prefix + '-provider'], model: o[prefix + '-model'], reasoningEffort: o[prefix + '-reasoning'] };
    return api.initializeRuntimeDeployment({ configPath: o.config, installationFile: installation.installationFile,
      dataRoot: o.data, workspace: o.workspace, webUnlimited: o['web-unlimited'],
      main: choice('main'), learn: choice('learn'), network: o.proxy ? { mode:'proxy',url:o.proxy } : { mode:'direct' },
      ...(o.port === undefined ? {} : { port: o.port }) });
  }
  if (command === 'use-version') return selectRuntimeVersion({ configPath: o.config, installationFile: o['installation-file'] });
  const parameters = { configPath: o.config, timeoutMs: o['timeout-ms'], signal };
  if (command === 'restart') {
    const old = await runtimeApi(o.config, { currentOwner: true });
    const previous = await old.api.stopRuntime(parameters); signal?.throwIfAborted();
    const next = await runtimeApi(o.config);
    return { ...await next.api.startRuntime(parameters), previous };
  }
  const { api } = await runtimeApi(o.config, { currentOwner: command !== 'start' });
  return api[command + 'Runtime'](parameters);
}
