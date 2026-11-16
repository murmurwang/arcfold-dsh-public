import { dirname, join, resolve, sep } from 'node:path';
import { accessSync, closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { canonicalRuntimePath, runtimeProviderDefaults, runtimeTransport, validateRuntimeConfig } from '../runtime-config.mjs';
import { initializeOwnedWebBudget, preflightWebBudget } from '../web-budget-recovery.mjs';
import { canonicalJson } from '../store.mjs';

const roles = ['main', 'attribution', 'learning', 'consolidation', 'verification', 'improvement', 'script_writer'];
const disjoint = (a, b) => a !== b && !a.startsWith(b + sep) && !b.startsWith(a + sep);
const assert = (condition, message) => { if (!condition) throw new Error(message); };

/** Project an already authorized Desktop installation into the native host.
 * This function is read-only. In particular it does not create a ledger,
 * adopt another installation's files, obtain credentials or authorize spending. */
function projectDesktopConfiguration({ local, runtimeRoot, python, userId, models }, checkLedger, checkInterpreter = true) {
  const config = validateRuntimeConfig(local);
  const data = canonicalRuntimePath(config.dataRoot), workspace = canonicalRuntimePath(config.workspace);
  const workers = canonicalRuntimePath(runtimeRoot, 'runtimeRoot');
  const interpreter = checkInterpreter ? realpathSync(canonicalRuntimePath(python, 'python')) : canonicalRuntimePath(python, 'python');
  if (checkInterpreter) {
    assert(lstatSync(interpreter).isFile(), 'Desktop token counter needs an executable interpreter');
    accessSync(interpreter, constants.X_OK);
  }
  const install = dirname(canonicalRuntimePath(config.installationFile));
  assert(lstatSync(workspace).isDirectory(), 'Desktop workspace must already exist');
  assert(disjoint(data, workspace) && disjoint(workers, data) && disjoint(workers, workspace) &&
    disjoint(data, install) && disjoint(workers, install), 'Desktop data, workspace, processes and installed code must be separate');
  assert(typeof userId === 'string' && userId.trim().length > 0 && userId.length <= 256, 'An explicit Desktop user identity is required');
  const transport = runtimeTransport(config), route = transport.routes['deepseek-official'];
  assert(route?.mode === 'web-only' && route.scope === 'web-unlimited' && route.webAuthorization && route.network?.mode === 'direct',
    'Desktop requires its own explicitly authorized, direct DeepSeek accounting route');
  const evidence = canonicalRuntimePath(transport.artifactDirectory), ledgerPath = canonicalRuntimePath(route.ledgerPath);
  assert(!disjoint(data, evidence) && evidence !== data && evidence.startsWith(data + sep), 'Desktop request evidence must be inside its data directory');
  if (checkLedger) preflightWebBudget({ artifactDirectory: evidence, ledgerPath });
  assert(models && typeof models === 'object' && Object.keys(models).length === roles.length && roles.every(role => Object.hasOwn(models, role)),
    'All seven 4397 model roles must be specified explicitly');
  for (const role of roles) {
    const value = models[role], policy = route.modelPolicies[value?.model];
    assert(value && Object.keys(value).every(k => ['provider', 'model', 'modelVersion', 'reasoningEffort', 'maxTokens'].includes(k)) &&
      value.provider === 'deepseek-official' && policy && typeof value.modelVersion === 'string' && value.modelVersion.length > 0 &&
      policy.reasoningEfforts.includes(value.reasoningEffort) && Number.isSafeInteger(value.maxTokens) && value.maxTokens > 0 &&
      value.maxTokens <= (policy.requestMaxTokens ?? policy.maxOutputTokens), `Invalid explicit Desktop model role: ${role}`);
  }
  const main = models.main;
  assert(['provider', 'model', 'reasoningEffort', 'maxTokens'].every(k => config.main?.[k] === main[k]), 'Desktop main model must match the authorized configuration');
  const defaults = runtimeProviderDefaults(config, 'deepseek-official');
  assert(defaults.available, 'Desktop provider defaults do not fit the accounting policies');
  const tree = { enabled: true, adapter: 'desktop-private-v1', followConversationModel: true, workspace, privateRoot: data, runtimeRoot: workers,
    treeFilename: join(data, 'tree.sqlite'), userId, models: structuredClone(models), stage: 'desktop', tokenCounter: { python: interpreter },
    budget: { mode: 'web-only', scope: 'web-unlimited', webAuthorization: structuredClone(route.webAuthorization),
      ledgerPath, artifactDirectory: evidence, modelPolicies: structuredClone(route.modelPolicies), endpoint: route.endpoint,
      timeoutMs: route.timeoutMs, ...(route.allowLocalTestEndpoint === true ? { allowLocalTestEndpoint: true } : {}) } };
  // The caller supplies the independently verified offline interpreter. No
  // hard-coded developer machine path is substituted here.
  return { tree, patches: [
    { id: 'arcfold-business', config: { goalTreeV3: tree } },
    { id: 'arcfold-metered-provider', disabled: true },
    { insert: [{ id: 'arcfold-desktop-metered-provider', name: '@arcfold/dsh/desktop-deepseek',
      config: { apiKeyRef: route.apiKeyRef, maxTokens: defaults.maxTokens, reasoningEffort: defaults.reasoningEffort } }] },
    { id: 'agent-default-model', config: { provider: main.provider, model: main.model, reasoningEffort: main.reasoningEffort } },
    { id: 'working-directory', config: { defaultDirectory: workspace } },
  ] };
}

export function desktopConfiguration(options) { return projectDesktopConfiguration(options, true); }
// Upgrade inspects the old configuration and ledger without executing or
// requiring its retired tokenizer. This does not authorize any model call.
export function desktopConfigurationForUpgrade(options) { return projectDesktopConfiguration(options, true, false); }

const hash = value => createHash('sha256').update(value).digest('hex');
function writePrivateNew(path, value) {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
  const directory = openSync(dirname(path), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
function privateRegular(path) {
  const st = lstatSync(path);
  assert(st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.uid === process.getuid() && !(st.mode & 0o077), 'Desktop initialization receipt must remain private and unmodified');
  return st;
}

/** Explicit first use for a new, separate Desktop namespace. A completed
 * setup is idempotent only for the exact same inputs and owned ledger. An
 * interrupted setup is retained and refused for manual reconciliation. */
export async function initializeDesktop(options, consent, runtimePython = options.python) {
  assert(consent?.confirmed === true && Object.keys(consent).length === 1, 'Explicit Desktop model-spending confirmation is required');
  // Only this installation's interpreter changes with a plugin upgrade. The
  // original settings still bind the receipt and the accounting authorization.
  const runtimeOptions = { ...options, python: runtimePython };
  const projection = projectDesktopConfiguration(runtimeOptions, false), tree = projection.tree;
  const root = tree.privateRoot, evidence = tree.budget.artifactDirectory, ledger = tree.budget.ledgerPath;
  assert(evidence === join(root, 'requests') && ledger === join(evidence, 'deepseek-web.sqlite'), 'First use requires the fixed independent Desktop evidence directory');
  assert(resolve(options.local.dataRoot) === root, 'Desktop data directory cannot be an alias');
  const configPath = join(root, 'desktop-configuration.json'), intentPath = join(root, 'desktop-initialization.json'), completedPath = join(root, 'desktop-initialization-completed.json');
  const bytes = canonicalJson({ schema: 'arcfold-desktop-configuration-v1', options }) + '\n', inputHash = hash(bytes);
  if (existsSync(root)) {
    const rootStat = lstatSync(root);
    assert(rootStat.isDirectory() && !rootStat.isSymbolicLink() && rootStat.uid === process.getuid() && !(rootStat.mode & 0o077), 'Desktop data directory must remain private and owned');
    assert(existsSync(completedPath), 'Desktop initialization is interrupted or the directory is not owned; reconcile before retrying');
    privateRegular(intentPath); privateRegular(configPath); privateRegular(completedPath);
    const intent = JSON.parse(readFileSync(intentPath, 'utf8')), completed = JSON.parse(readFileSync(completedPath, 'utf8'));
    assert(intent.schema === 'arcfold-desktop-initialization-v1' && completed.schema === 'arcfold-desktop-initialization-completed-v1', 'Unsupported Desktop initialization receipt');
    assert(intent.inputHash === inputHash && completed.inputHash === inputHash && hash(readFileSync(configPath)) === inputHash,
      'Desktop initialization retry requires the same original configuration');
    const st = privateRegular(ledger);
    assert(st.dev === completed.ledger.dev && st.ino === completed.ledger.ino, 'Desktop accounting ledger has been replaced');
    preflightWebBudget({ artifactDirectory: evidence, ledgerPath: ledger });
    return { created: false, configPath, ...projection };
  }
  assert(runtimePython === options.python, 'Fresh Desktop initialization must record its runtime');
  // mkdir is the ownership claim; it fails instead of adopting any existing
  // directory. Completion is published only after the independent ledger.
  mkdirSync(root, { mode: 0o700 });
  writePrivateNew(intentPath, JSON.stringify({ schema: 'arcfold-desktop-initialization-v1', inputHash }) + '\n');
  writePrivateNew(configPath, bytes);
  const account = await initializeOwnedWebBudget({ artifactDirectory: evidence, ledgerPath: ledger, webAuthorization: tree.budget.webAuthorization });
  assert(account.created && account.ledgerPath === ledger, 'First use cannot adopt an existing accounting ledger');
  const st = privateRegular(ledger);
  writePrivateNew(completedPath, JSON.stringify({ schema: 'arcfold-desktop-initialization-completed-v1', inputHash, ledger: { dev: st.dev, ino: st.ino } }) + '\n');
  return { created: true, configPath, ...desktopConfiguration(runtimeOptions) };
}
