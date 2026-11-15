import { OPENAI_MODELS, OPENAI_REASONING_EFFORTS } from './openai-models.mjs';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalJson } from './store.mjs';
import { preflightWebBudget, webBudgetPath } from './web-budget-recovery.mjs';

const CONFIG_SCHEMA = 'arcfold-local-v1';
const SCHEMAS = [CONFIG_SCHEMA, 'arcfold-local-v2'];
const ROUTE_FIELDS = ['provider', 'model', 'reasoningEffort', 'maxTokens'];
const TRANSPORT_FIELDS = ['apiKeyRef', 'ledgerPath', 'artifactDirectory', 'scope', 'ceilingCny',
  'authorizationRef', 'webAuthorization', 'endpoint', 'modelPolicies', 'timeoutMs', 'allowLocalTestEndpoint'];
export const runtimeHash = value => createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };

function object(value, fields, name) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), `${name} must be an object`);
  requireValue(Object.keys(value).every(key => fields.includes(key)), `${name} has unsupported fields; store credential references only`);
}

/** Resolve existing ancestors too: two spellings of one data directory share one owner. */
export function canonicalRuntimePath(path, label = 'path') {
  requireValue(typeof path === 'string' && isAbsolute(path) && !path.includes('\0'), `${label} must be an absolute path`);
  let ancestor = resolve(path);
  const tail = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    requireValue(parent !== ancestor, `Cannot resolve ${label}`);
    tail.unshift(relative(parent, ancestor)); ancestor = parent;
  }
  return join(realpathSync(ancestor), ...tail);
}

function readConfig(path) {
  const configPath = canonicalRuntimePath(path, 'configPath');
  requireValue(lstatSync(configPath).isFile(), 'The runtime configuration must be a regular file');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  requireValue(SCHEMAS.includes(config?.schema), 'Unsupported Arcfold runtime configuration');
  return { configPath, config };
}

/** Stop/status deliberately do not depend on a usable model or code installation. */
export function loadRuntimeIdentity(path) {
  const { configPath, config } = readConfig(path);
  const dataRoot = canonicalRuntimePath(config.dataRoot, 'dataRoot');
  return { configPath, dataRoot, runtimeDirectory: join(dataRoot, 'runtime') };
}

function route(value, name) {
  if (value === null) return null;
  object(value, ROUTE_FIELDS, name);
  for (const key of ['provider', 'model', 'reasoningEffort'])
    requireValue(typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 256, `${name}.${key} is required`);
  requireValue(Number.isSafeInteger(value.maxTokens) && value.maxTokens > 0, `${name}.maxTokens must be a positive integer`);
  return structuredClone(value);
}

/** One read projection. Legacy files and their original fee authorization are never rewritten. */
export function runtimeTransport(config) {
  if (!config.transport) return { artifactDirectory: null, routes: {} };
  if (config.schema === 'arcfold-local-v2') return structuredClone(config.transport);
  const { artifactDirectory, ...route } = config.transport;
  return { artifactDirectory, routes: { 'deepseek-official': { ...route, kind: 'deepseek', network: { mode: 'direct' } } } };
}
function text(value, name, max = 4096) {
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\0'), `${name} is required`);
}
function webAuthority(value, original) {
  object(value, ['authorizationRef', 'authorizedAt', 'authorizationEvidence'], 'webAuthorization');
  for (const key of ['authorizationRef', 'authorizedAt', 'authorizationEvidence']) text(value[key], 'webAuthorization.' + key, 8000);
  requireValue(value.authorizationRef !== original && /^\d{4}-\d{2}-\d{2}T/.test(value.authorizedAt) && Number.isFinite(Date.parse(value.authorizedAt)),
    'Web use requires its separate explicit authorization and timestamp');
}
function network(value) {
  object(value, ['mode', 'url'], 'network');
  if (value.mode === 'direct') return requireValue(Object.keys(value).length === 1, 'A direct route cannot include a proxy');
  requireValue(value.mode === 'proxy' && Object.keys(value).length === 2 && typeof value.url === 'string', 'An explicit fixed direct or proxy network is required');
  const proxy = new URL(value.url);
  requireValue(['http:', 'https:'].includes(proxy.protocol) && !proxy.username && !proxy.password && proxy.pathname === '/' && !proxy.search && !proxy.hash,
    'Use a fixed HTTP CONNECT proxy without credentials, query or path');
}
function validateV2Transport(t) {
  object(t, ['artifactDirectory', 'routes'], 'transport'); canonicalRuntimePath(t.artifactDirectory, 'artifactDirectory');
  object(t.routes, ['deepseek-official', 'openai'], 'routes');
  requireValue(Object.keys(t.routes).length > 0, 'Configure at least one explicit route or use transport:null');
  for (const [provider, value] of Object.entries(t.routes)) {
    const openai = provider === 'openai';
    object(value, ['kind', 'apiKeyRef', 'ledgerPath', 'scope', 'webAuthorization', 'endpoint', 'modelPolicies', 'timeoutMs',
      'allowLocalTestEndpoint', 'network', ...(openai ? [] : ['ceilingCny', 'authorizationRef', 'mode'])], provider);
    requireValue(value.kind === (openai ? 'openai' : 'deepseek'), 'Provider and transport kind must agree');
    requireValue(typeof value.apiKeyRef === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value.apiKeyRef), 'Use an explicit native credential reference');
    canonicalRuntimePath(value.ledgerPath, 'ledgerPath'); network(value.network);
    requireValue(value.timeoutMs === undefined || Number.isSafeInteger(value.timeoutMs) && value.timeoutMs > 0, 'timeoutMs must be a positive integer');
    requireValue(value.allowLocalTestEndpoint === undefined || typeof value.allowLocalTestEndpoint === 'boolean', 'Synthetic endpoint permission must be explicit');
    const endpoint = new URL(value.endpoint), path = openai ? '/v1/responses' : '/anthropic/v1/messages';
    requireValue(!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash && endpoint.pathname === path &&
      (value.allowLocalTestEndpoint === true ? endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1' && endpoint.port
        : endpoint.href === (openai ? 'https://api.openai.com/v1/responses' : 'https://api.deepseek.com/anthropic/v1/messages')),
    'Use the fixed official endpoint or an explicitly synthetic loopback endpoint');
    if (openai) { requireValue(value.scope === 'web-openai', 'OpenAI requires independent web-openai accounting'); webAuthority(value.webAuthorization); }
    else {
      requireValue(['limited', 'web-unlimited'].includes(value.scope), 'DeepSeek requires an explicit existing fee scope');
      if (value.mode === 'web-only') {
        requireValue(value.scope === 'web-unlimited' && !Object.hasOwn(value, 'ceilingCny') &&
          !Object.hasOwn(value, 'authorizationRef'), 'Web-only mode cannot carry the original finite allowance');
        webAuthority(value.webAuthorization);
        webBudgetPath(t.artifactDirectory, value.ledgerPath);
      } else {
        requireValue(value.mode === undefined, 'Unsupported DeepSeek ledger mode');
        requireValue(Number.isFinite(value.ceilingCny) && value.ceilingCny > 0 && Number.isSafeInteger(Math.round(value.ceilingCny * 1e6)), 'The original ledger ceiling is required');
        text(value.authorizationRef, 'authorizationRef');
        if (value.scope === 'web-unlimited') webAuthority(value.webAuthorization, value.authorizationRef);
        else requireValue(value.webAuthorization === undefined, 'Limited scope cannot carry a different web authorization');
      }
    }
    requireValue(value.modelPolicies && typeof value.modelPolicies === 'object' && !Array.isArray(value.modelPolicies) && Object.keys(value.modelPolicies).length > 0, 'Explicit model policies are required');
    if (openai) requireValue(Object.keys(value.modelPolicies).every(model => OPENAI_MODELS.includes(model)), 'Only explicit supported OpenAI models are allowed');
    for (const [model, policy] of Object.entries(value.modelPolicies)) {
      text(model, 'model', 256);
      object(policy, ['contextWindow', 'maxOutputTokens', 'requestMaxTokens', 'reasoningEfforts', ...(openai ? [] : ['prices', 'priceVersion'])], 'model policy');
      const minimum = openai ? 16 : 1;
      requireValue(Number.isSafeInteger(policy.contextWindow) && policy.contextWindow > 0 && Number.isSafeInteger(policy.maxOutputTokens) && policy.maxOutputTokens >= minimum &&
        (policy.requestMaxTokens === undefined || Number.isSafeInteger(policy.requestMaxTokens) && policy.requestMaxTokens >= minimum && policy.requestMaxTokens <= policy.maxOutputTokens), 'Invalid explicit model token bounds');
      requireValue(Array.isArray(policy.reasoningEfforts) && policy.reasoningEfforts.length && new Set(policy.reasoningEfforts).size === policy.reasoningEfforts.length &&
        policy.reasoningEfforts.every(e => (openai ? OPENAI_REASONING_EFFORTS : ['off', 'low', 'high', 'max']).includes(e)), 'Invalid model reasoning policy');
      if (!openai) {
        text(policy.priceVersion, 'priceVersion'); object(policy.prices, ['input', 'output', 'cachedInput'], 'prices');
        requireValue(['input', 'output', 'cachedInput'].every(k => Number.isFinite(policy.prices[k]) && policy.prices[k] >= 0), 'Explicit original DeepSeek prices are required');
      }
    }
  }
}
export function validateRuntimeConfig(config) {
  object(config, ['schema', 'installationFile', 'dataRoot', 'workspace', 'listen', 'main', 'learn', 'transport'], 'configuration');
  requireValue(SCHEMAS.includes(config.schema), 'Unsupported Arcfold runtime configuration');
  for (const key of ['installationFile', 'dataRoot', 'workspace']) canonicalRuntimePath(config[key], key);
  requireValue(disjoint(canonicalRuntimePath(config.workspace), dirname(canonicalRuntimePath(config.installationFile))), 'Keep workspace separate from installed code');
  object(config.listen, ['host', 'port'], 'listen');
  requireValue(config.listen.host === '127.0.0.1', 'This local product currently binds only to 127.0.0.1');
  requireValue(Number.isSafeInteger(config.listen.port) && config.listen.port >= 0 && config.listen.port <= 65535, 'Invalid local port');
  route(config.main, 'main'); route(config.learn, 'learn');
  if (config.transport !== null && config.schema === 'arcfold-local-v2') validateV2Transport(config.transport);
  else if (config.transport !== null) {
    const t = config.transport; object(t, TRANSPORT_FIELDS, 'transport');
    requireValue(typeof t.apiKeyRef === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(t.apiKeyRef), 'transport.apiKeyRef must name a native credential reference');
    canonicalRuntimePath(t.ledgerPath, 'ledgerPath'); canonicalRuntimePath(t.artifactDirectory, 'artifactDirectory');
    requireValue(['limited', 'web-unlimited'].includes(t.scope), 'An explicit fee scope is required');
    requireValue(Number.isFinite(t.ceilingCny) && t.ceilingCny >= 0 && typeof t.authorizationRef === 'string' && t.authorizationRef.length > 0,
      'The original ledger authorization is required; initialization never creates or raises it');
    requireValue(t.modelPolicies && typeof t.modelPolicies === 'object' && !Array.isArray(t.modelPolicies) && Object.keys(t.modelPolicies).length > 0,
      'Explicit model accounting policies are required');
    const endpoint = new URL(t.endpoint);
    requireValue(!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash && endpoint.pathname === '/anthropic/v1/messages', 'Invalid Messages endpoint');
    const synthetic = t.allowLocalTestEndpoint === true;
    requireValue(synthetic ? endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1' && endpoint.port
      : endpoint.protocol === 'https:' && endpoint.hostname === 'api.deepseek.com' && !endpoint.port,
    'Use the official DeepSeek endpoint or an explicitly synthetic loopback endpoint');
    if (t.scope === 'web-unlimited') {
      object(t.webAuthorization, ['authorizationRef', 'authorizedAt', 'authorizationEvidence'], 'webAuthorization');
      requireValue(t.webAuthorization.authorizationRef !== t.authorizationRef &&
        typeof t.webAuthorization.authorizationEvidence === 'string' && t.webAuthorization.authorizationEvidence.length > 0 &&
        Number.isFinite(Date.parse(t.webAuthorization.authorizedAt)), 'Unlimited web use requires its separate explicit authorization');
    }
  }
  return structuredClone(config);
}

/** One legal shared adapter default; this never changes the saved user choices. */
export function runtimeProviderDefaults(config, provider = 'deepseek-official') {
  const transport = runtimeTransport(config).routes[provider];
  if (!transport) return { available: false, reason: 'transport-not-configured' };
  const policies = Object.values(transport.modelPolicies ?? {});
  if (policies.some(policy => !policy || typeof policy !== 'object' || Array.isArray(policy)))
    return { available: false, reason: 'model-catalog-controls-invalid' };
  const limits = policies.map(policy => policy.requestMaxTokens ?? policy.maxOutputTokens);
  if (!policies.length || limits.some(limit => !Number.isSafeInteger(limit) || limit < 1) ||
      policies.some(policy => !Array.isArray(policy.reasoningEfforts)))
    return { available: false, reason: 'model-catalog-controls-invalid' };
  const efforts = (provider === 'openai' ? OPENAI_REASONING_EFFORTS : ['off', 'low', 'high', 'max']).filter(effort => policies.every(policy => policy.reasoningEfforts.includes(effort)));
  if (!efforts.length) return { available: false, reason: 'model-catalog-has-no-common-controls' };
  const maxTokens = Math.min(...limits);
  const choices = [config.main, config.learn].filter(Boolean);
  // A valid output preference remains usable after a native model correction;
  // choosing connection defaults does not authorize its provider/model route.
  const output = choices.find(selection => Number.isSafeInteger(selection.maxTokens) && selection.maxTokens >= (provider === 'openai' ? 16 : 1) && selection.maxTokens <= maxTokens);
  const reasoning = choices.find(selection => efforts.includes(selection.reasoningEffort));
  return { available: true, maxTokens: output?.maxTokens ?? maxTokens, reasoningEffort: reasoning?.reasoningEffort ?? efforts[0] };
}

/** Availability is not a credential probe and does not issue a model request. */
export function runtimeRouteAvailability(config) {
  const routes = runtimeTransport(config).routes;
  const check = (selection, role) => {
    if (!selection || !selection.provider || !selection.model) return { available: false, reason: `${role}-not-configured` };
    const policy = routes[selection.provider]?.modelPolicies?.[selection.model];
    const defaults = runtimeProviderDefaults(config, selection.provider);
    if (!policy)
      return { available: false, reason: 'selected-route-not-supported' };
    if (!defaults.available) return { available: false, reason: defaults.reason };
    if (!policy.reasoningEfforts?.includes(selection.reasoningEffort) || !Number.isSafeInteger(selection.maxTokens) || selection.maxTokens < (selection.provider === 'openai' ? 16 : 1) ||
        selection.maxTokens > (policy.requestMaxTokens ?? policy.maxOutputTokens))
      return { available: false, reason: 'selection-outside-model-policy' };
    return { available: true, provider: selection.provider, model: selection.model,
      reasoningEffort: selection.reasoningEffort, maxTokens: selection.maxTokens };
  };
  return { main: check(config.main, 'main'), learn: check(config.learn, 'learn') };
}

function disjoint(a, b) {
  return a !== b && !a.startsWith(b + sep) && !b.startsWith(a + sep);
}

function checkExistingBusiness(filename, expected) {
  if (!existsSync(filename)) return;
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    requireValue(db.prepare("SELECT value FROM business_meta WHERE key='schema_version'").get()?.value === String(expected),
      'The selected code version is incompatible with the existing business database');
  } finally { db.close(); }
}

function checkExistingLedger(t) {
  requireValue(existsSync(t.ledgerPath), 'An existing authorized ledger is required; no new research balance will be created');
  const db = new DatabaseSync(t.ledgerPath, { readOnly: true });
  try {
    for (const table of ['records', 'store_meta', ...(t.kind === 'openai' ? [] : ['budget_settings', 'budget_requests'])])
      requireValue(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table), 'The existing ledger schema is incomplete');
    if (t.kind !== 'openai') {
    const settings = db.prepare('SELECT * FROM budget_settings WHERE singleton=1').get();
    requireValue(settings?.schema_version === 1 && settings.authorization_ref === t.authorizationRef &&
      settings.ceiling_micro === Math.round(t.ceilingCny * 1e6), 'The configured authorization does not match the original ledger');
    }
    requireValue(db.prepare("SELECT value FROM store_meta WHERE key='schema_version'").get()?.value === '2', 'Unsupported existing ledger schema');
    if (t.webAuthorization) {
      const openai = t.kind === 'openai', auth = t.webAuthorization;
      const id = (openai ? 'openai-web-' : 'budget-web-') + runtimeHash(auth.authorizationRef);
      const row = db.prepare('SELECT body FROM records WHERE kind=? AND id=?').get(openai ? 'openai_authorizations' : 'budget_authorizations', id);
      const specification = { scope: t.scope, ...(openai ? { provider: 'openai', accounting: 'tokens_only' } : {}),
        ...auth, authorizedAt: new Date(auth.authorizedAt).toISOString() };
      requireValue(!row || canonicalJson(JSON.parse(row.body).specification) === canonicalJson(specification), 'The existing web authorization conflicts with the configured evidence');
    }
  } finally { db.close(); }
}

export async function loadRuntimePlan(path) {
  const { configPath, config: raw } = readConfig(path);
  const config = validateRuntimeConfig(raw), identity = loadRuntimeIdentity(configPath);
  const { readInstallation } = await import('./runtime-installation.mjs');
  const installation = await readInstallation(canonicalRuntimePath(config.installationFile, 'installationFile'));
  const workspace = canonicalRuntimePath(config.workspace, 'workspace');
  requireValue(lstatSync(workspace).isDirectory(), 'The selected workspace must already exist');
  requireValue(disjoint(identity.dataRoot, workspace) && disjoint(identity.dataRoot, installation.installationDir),
    'Keep user data separate from workspace and installed code');
  requireValue(disjoint(workspace, installation.installationDir), 'Keep workspace separate from installed code');
  requireValue(installation.compatibility?.businessSchema === 1 && installation.compatibility?.nativeFormat === 4,
    'This launcher does not support the selected version data formats');
  const businessFilename = join(identity.dataRoot, 'business.sqlite');
  checkExistingBusiness(businessFilename, installation.compatibility.businessSchema);
  const transport = runtimeTransport(config);
  for (const route of Object.values(transport.routes)) {
    if (route.mode === 'web-only') preflightWebBudget({ artifactDirectory: transport.artifactDirectory, ledgerPath: route.ledgerPath });
    else checkExistingLedger(route);
  }
  return { ...identity, configurationHash: runtimeHash(config), nativeHome: join(identity.dataRoot, 'native'),
    businessFilename, workspace, installation, config, routeAvailability: runtimeRouteAvailability(config) };
}

/** First-use config only; never resets an existing file, ledger or profile. */
export function initializeRuntimeConfig({ configPath, installationFile, dataRoot, workspace, port = 4381 }) {
  const config = validateRuntimeConfig({ schema: CONFIG_SCHEMA,
    installationFile: canonicalRuntimePath(installationFile, 'installationFile'), dataRoot: canonicalRuntimePath(dataRoot, 'dataRoot'),
    workspace: canonicalRuntimePath(workspace, 'workspace'), listen: { host: '127.0.0.1', port }, main: null, learn: null, transport: null });
  const path = canonicalRuntimePath(configPath, 'configPath');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { configPath: path, mode: 'configuration-only', modelsConfigured: false };
}

const CLOSED_ROUTES = ['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'deepseek-llm-api-extensions',
  'session-log-deepseek', 'plugin-package-inventory-deepseek', 'llm-retry', 'session-title-llm',
  'schedule', 'ui-schedule', 'subagent-spawn-in-process', 'subagent-fork-in-process',
  'web-search-deepseek', 'web-deepseek-api', 'preset-standard', 'preset-minimal', 'preset-ptc', 'preset-cordis'];

export function runtimeDeploymentPatches(plan) {
  const { config } = plan, t = config.transport, shared = config.schema === 'arcfold-local-v2';
  const normalized = runtimeTransport(config);
  const defaults = Object.fromEntries(Object.keys(normalized.routes).map(provider => [provider, runtimeProviderDefaults(config, provider)]));
  const enabledRoutes = Object.fromEntries(Object.entries(normalized.routes).filter(([provider]) => defaults[provider].available));
  const available = runtimeRouteAvailability(config);
  // The provider catalog exists independently of the initial main choice. A native
  // conversation may select another model within the same explicit accounting policy.
  const providerDefaults = runtimeProviderDefaults(config), providerEnabled = providerDefaults.available;
  const initialMain = config.main ? { provider: config.main.provider, model: config.main.model,
    reasoningEffort: config.main.reasoningEffort } : { provider: '', model: '' };
  const patches = [
    ...CLOSED_ROUTES.map(id => ({ id, disabled: true })),
    { id: 'goal-round-driver', disabled: false },
    { id: 'hmr', disabled: true },
    { id: 'client-hmr', disabled: true },
    { id: 'ui-settings-models', disabled: true },
    { id: 'arcfold-ui', inject: ['arcfoldRuntimeModels'] },
    { id: 'llm', inject: ['arcfoldRuntimeGuard'] },
    // The bundle expression runs only after the root service is available. Its
    // config remains below user/home patches, so native saves can replace it.
    { id: 'agent-default-model', disabled: false, inject: ['arcfoldRuntimeGuard'] },
    { id: 'arcfold-business', disabled: false, config: { filename: plan.businessFilename } },
    { id: 'arcfold-metered-budget', disabled: shared || !providerEnabled, config: !shared && t ? {
      ...t, provider: 'deepseek-official', apiKeyRef: undefined,
    } : {} },
    { id: 'arcfold-metered-provider', disabled: !providerEnabled, config: providerEnabled ? {
      apiKeyRef: normalized.routes['deepseek-official'].apiKeyRef, maxTokens: providerDefaults.maxTokens,
      reasoningEffort: providerDefaults.reasoningEffort,
    } : {} },
    { id: 'arcfold-shared-metered-host', disabled: !shared || !Object.keys(enabledRoutes).length,
      config: shared ? { artifactDirectory: normalized.artifactDirectory, routes: enabledRoutes } : {} },
    { id: 'arcfold-openai-provider', disabled: !shared || !enabledRoutes.openai,
      config: shared && enabledRoutes.openai ? { apiKeyRef: enabledRoutes.openai.apiKeyRef,
        maxTokens: defaults.openai.maxTokens, reasoningEffort: defaults.openai.reasoningEffort } : {} },
    { id: 'arcfold-preparation', config: { preset: 'arcfold-preparation', maxTokens: 8192, cwd: plan.workspace } },
    { id: 'arcfold-learning', disabled: !available.learn.available, inject: ['arcfoldRuntimeModels'], config: available.learn.available ? {
      preset: 'arcfold-learning', ...config.learn, cwd: plan.workspace,
    } : {} },
    { id: 'agent-preset-registry', config: { default: 'arcfold-main' } },
    // The native browser creates its own first-use workspace independently of
    // process.cwd(). Gate that API until the explicit deployment path is registered.
    { id: 'workspace-controller', inject: ['arcfoldRuntimeWorkspace'] },
    { id: 'working-directory', config: { defaultDirectory: plan.workspace } },
    { id: 'sandbox-policy', config: { mode: 'workspace-write', workspaceRoot: plan.workspace } },
    { id: 'approval', config: { policy: 'ask' } },
    { id: 'webserver', config: { ...config.listen, compression: 'gzip', compressionLevel: 1, compressionThresholdBytes: 1024 } },
    { id: 'web-runtime', inject: ['webStartup', 'arcfoldRuntimeWorkspace'], config: { openBrowser: false, printUrl: false, surfaceContext: true } },
    { insert: [{ id: 'arcfold-runtime-model-settings',
      name: pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'runtime-model-settings.mjs')).href, config: { runtime: config } },
    { id: 'arcfold-runtime-workspace', name: pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'runtime-workspace.mjs')).href,
      config: { workspace: plan.workspace } },
    { id: 'arcfold-runtime-guard', name: pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'runtime-guard.mjs')).href,
      config: { modelSelectionRequired: true, initialMain, mainMaxTokens: config.main?.maxTokens ?? null,
        routeAvailability: available, learn: config.learn, modelPolicies: normalized.routes['deepseek-official']?.modelPolicies ?? {},
        ...(shared ? { routes: Object.fromEntries(Object.entries(enabledRoutes).map(([provider, route]) => [provider, {
          provider, endpoint: route.endpoint, modelPolicies: route.modelPolicies, network: route.network }])) } : {}) } }] },
  ];
  // JSON patches contain no secrets and no undefined pseudo-fields.
  return JSON.parse(JSON.stringify(patches));
}

/** Called only by the lock-owning child, before official runProfile. */
export async function prepareRuntimeBoot(plan, runDirectory) {
  const current = await loadRuntimePlan(plan.configPath);
  requireValue(current.configurationHash === plan.configurationHash && current.installation.sourceCommit === plan.installation.sourceCommit,
    'Configuration or selected version changed during startup');
  requireValue(realpathSync(process.cwd()) === plan.workspace && canonicalRuntimePath(process.env.DSH_HOME, 'DSH_HOME') === plan.nativeHome,
    'The child must select its explicit workspace and durable native home before boot');
  mkdirSync(plan.nativeHome, { recursive: true, mode: 0o700 });
  const require = createRequire(plan.installation.installAnchor);
  const boot = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href);
  const profile = boot.loadProfileDirectory('arcfold', plan.installation.profileDir, plan.installation.installAnchor, { userLayer: false });
  requireValue(profile.skippedBundles.length === 0, 'A required installed bundle was skipped');
  requireValue(canonicalJson(profile.layers.map(layer => layer.packageName)) === canonicalJson([
    '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@arcfold/dsh']), 'Unexpected installed bundle composition');
  const originalRows = boot.composeEntries([profile.layers.flatMap(layer => layer.patches)]);
  const nativePatchPath = join(plan.nativeHome, 'arcfold.patch.yml');
  const homePatches = boot.loadOptionalPatches('arcfold', join(plan.nativeHome, 'cordis.patch.yml')) ?? [];
  const userPatches = boot.loadOptionalPatches('arcfold', nativePatchPath) ?? [];
  const patches = runtimeDeploymentPatches(plan);
  profile.patchPath = nativePatchPath;
  profile.patches = userPatches;
  const rows = boot.composeEntries([profile.layers.flatMap(layer => layer.patches), userPatches, homePatches, patches]);
  const allowed = new Map(originalRows.map(row => [row.id, row.name]));
  for (const row of patches.flatMap(patch => patch.insert ?? [])) allowed.set(row.id, row.name);
  requireValue(rows.length === allowed.size && new Set(rows.map(row => row.id)).size === rows.length,
    'The installed composition contains added, missing or duplicate entries');
  for (const row of rows) {
    requireValue(allowed.get(row.id) === row.name, `Unsupported component replacement: ${row.id}`);
    requireValue(!row.group && !row.isolate && !row.intercept, `Unsupported runtime scope change: ${row.id}`);
  }
  const permission = rows.find(row => row.id === 'permission');
  requireValue(canonicalJson(permission.config.presets['workspace-write']) === canonicalJson({ sandbox: 'workspace-write', approval: 'ask' }),
    'The native workspace-write and ask permission boundary must be preserved');
  const patchPath = join(runDirectory, 'deployment.patch.json');
  writeFileSync(patchPath, JSON.stringify(patches, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { environment: boot.loadLayeredEnv('arcfold', plan.workspace), profile: plan.installation.profileName,
    resolvedProfile: { profile, installAnchor: plan.installation.installAnchor }, patchFiles: [patchPath],
    args: ['--no-open', '--port', String(plan.config.listen.port)],
    packageManager: { ...plan.installation.packageManager, env: {} } };
}

/** Pure first-use configuration. Authorization and publication belong to installed runtime-init. */
export function createInitialRuntimeConfig({ installationFile, dataRoot, workspace, port = 4381,
  main, learn, network: selectedNetwork = { mode: 'direct' }, credentialRefs, webAuthorizations, policy }) {
  requireValue(policy?.schema === 'arcfold-initial-policy-v1' && policy.requestMaxTokens === 128000,
    'Unsupported initial model policy');
  const root = canonicalRuntimePath(dataRoot, 'dataRoot'), artifactDirectory = join(root, 'requests');
  object(credentialRefs, ['deepseek-official', 'openai'], 'credentialRefs');
  requireValue(Object.keys(credentialRefs).length === 2, 'Both native credential references are required');
  const selection = (value, label) => {
    object(value, ['provider','model','reasoningEffort'], label);
    requireValue(Object.keys(value).length === 3, 'Supply all three model choices');
    return { ...value, maxTokens: policy.requestMaxTokens };
  };
  const routes = Object.fromEntries(['deepseek-official', 'openai'].map(provider => [provider, {
    ...structuredClone(policy.routes[provider]), apiKeyRef: credentialRefs[provider],
    ledgerPath: join(artifactDirectory, provider === 'openai' ? 'openai-web.sqlite' : 'deepseek-web.sqlite'),
    ...(provider === 'openai' ? { scope: 'web-openai' } : { mode: 'web-only', scope: 'web-unlimited' }),
    webAuthorization: structuredClone(webAuthorizations[provider]), network: structuredClone(selectedNetwork),
  }]));
  const config = validateRuntimeConfig({ schema: 'arcfold-local-v2',
    installationFile: canonicalRuntimePath(installationFile, 'installationFile'), dataRoot: root,
    workspace: canonicalRuntimePath(workspace, 'workspace'), listen: { host: '127.0.0.1', port },
    main: selection(main ?? policy.initialMain, 'main'), learn: selection(learn ?? main ?? policy.initialMain, 'learn'),
    transport: { artifactDirectory, routes } });
  const availability = runtimeRouteAvailability(config);
  requireValue(availability.main.available && availability.learn.available, 'Initial selection is outside the deployed model policy');
  return config;
}
