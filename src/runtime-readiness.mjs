import { assertPreparationComposition } from './preparation-plugin.mjs';
import * as NativeGoalDriver from '@deepseek-ai/dsh-goal-round-driver';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { canonicalJson } from './store.mjs';
import { assertOpenAIIdentity, serviceIdentity } from './runtime-guard.mjs';
import { canonicalRuntimePath, runtimeProviderDefaults, runtimeRouteAvailability, runtimeTransport } from './runtime-config.mjs';

const CORE = '@arcfold/dsh', UI = '@arcfold/dsh-method-ui';
const ACTIVE = 2;
const SERVICES = ['llm', 'sessions', 'sessionPersistence', 'arcfoldBusiness', 'arcfoldBridge', 'arcfoldWork',
  'arcfoldOpportunities', 'arcfoldPreparation', 'arcfoldOpportunityWeb', 'arcfoldMethods', 'arcfoldGoals', 'arcfoldMethodWeb', 'arcfoldGoalWeb', 'agentPresets', 'pluginPackages',
  'clientModules', 'webApp', 'connection', 'credentials', 'agentDefaultModel', 'sessionController', 'configEditor', 'settings',
  'arcfoldRuntimeWorkspace', 'workspaceRegistry', 'workspaceController', 'arcfoldRuntimeModels', 'arcfoldModelWeb'];
const required = (condition, message) => { if (!condition) throw new Error(message); };

/** Loader keeps the thenable returned by registry.plugin; ownership belongs to its underlying Fiber. */
export function actualRuntimeFiber(entry, root) {
  const wrapper = entry?.fiber, actual = wrapper?.ctx.fiber;
  required(!entry?.disabled && actual?.state === ACTIVE && actual.ctx.root === root && actual.entry === entry &&
    (wrapper === actual || Object.getPrototypeOf(wrapper) === actual),
  `Required component is not active in this host: ${entry?.options.id ?? 'unknown'}`);
  return actual;
}

// The official driver is global on loading/teardown, even when mounted in a
// scoped preset. Require exactly its root entry and reject every preset copy.
export async function inspectNativeContinuationDriver(ctx, entries, compositions) {
  const name = '@deepseek-ai/dsh-goal-round-driver';
  const drivers = entries.filter(entry => entry.options.id === 'goal-round-driver' ||
    entry.options.name === name || entry.moduleNamespace?.apply === NativeGoalDriver.apply);
  required(drivers.length === 1, 'Expected one root native goal driver');
  const entry = drivers[0];
  required(entry.options.id === 'goal-round-driver' && entry.options.name === name &&
    entry.moduleNamespace?.apply === NativeGoalDriver.apply,
  'Native goal driver does not use the verified official module');
  for (const composition of compositions) for (const module of composition.modules) {
    required(module.moduleName !== name, 'A preset must not contain another native goal driver');
    // Preset inspection exposes its original specifier/base, not its private
    // Loader tree. Use the same public loader import/normalization for aliases.
    const owner = module.baseUrl ? ctx.extend({ baseUrl: module.baseUrl }) : ctx;
    const loaded = await owner.loader.import(module.moduleName);
    const plugin = owner.loader.unwrapExports(loaded);
    required(plugin !== NativeGoalDriver.apply && plugin?.apply !== NativeGoalDriver.apply,
      'A preset must not contain another native goal driver through a module alias');
  }
  const actual = actualRuntimeFiber(entry, ctx.root);
  for (const service of ['agents', 'goals', 'sessions'])
    required(actual.committed?.[service]?.value === serviceIdentity(ctx.get(service)),
      'Native goal driver is bound to a different host service');
  return actual;
}

/** Resolve only the verified local adapter's defaults; unknown routes are never probed. */
export async function runtimeMainAvailability(llm, config, selection) {
  if (!selection?.provider || !selection?.model) return { available: false, reason: 'main-not-configured' };
  if (!Object.hasOwn(runtimeTransport(config).routes[selection.provider]?.modelPolicies ?? {}, selection.model))
    return { available: false, reason: 'selected-route-not-supported' };
  const defaults = runtimeProviderDefaults(config, selection.provider);
  if (!defaults.available) return { available: false, reason: defaults.reason };
  let resolved;
  try { resolved = await llm.resolveCallConfig(selection); }
  catch { return { available: false, reason: 'selected-model-controls-unavailable' }; }
  required(resolved.provider === selection.provider && resolved.model === selection.model,
    'The model capability lookup replaced the selected route');
  if (config.main && resolved.maxTokens !== config.main.maxTokens)
    return { available: false, reason: 'main-output-limit-unavailable',
      requestedMaxTokens: config.main.maxTokens, resolvedMaxTokens: resolved.maxTokens ?? null };
  return runtimeRouteAvailability({ ...config, main: resolved }).main;
}

/** Fresh status projection only: no arm, config write, retry, or secret resolution. */
export async function refreshRuntimeReadiness(ctx, plan) {
  const unavailable = reason => ({ available: false, reason });
  const gateView = guard => guard?.snapshot() ?? { phase: 'unavailable', reason: 'guard-unavailable' };
  const blocked = (gate, reason = gate.phase === 'requires-restart' ? 'runtime-restart-required' : 'runtime-not-ready') => ({
    mode: 'configuration-only', modelGate: gate,
    routeAvailability: { main: unavailable(reason), learn: unavailable(reason), credentialConfigured: false,
      providerCredentialValidated: false, mainSelectionScope: 'native-default' }, issues: [reason],
  });
  let guard;
  try {
    guard = ctx.get('arcfoldRuntimeGuard');
    let gate = gateView(guard);
    if (gate.phase !== 'ready') return blocked(gate);
    const defaults = ctx.get('agentDefaultModel'), llm = ctx.get('llm'), credentials = ctx.get('credentials');
    required(defaults && llm && credentials, 'Runtime model settings are unavailable');
    const selection = defaults.currentSelection();
    const selectionKey = value => JSON.stringify([value.provider, value.model, value.reasoningEffort]);
    const before = selectionKey(selection);
    let main = await runtimeMainAvailability(llm, plan.config, selection);
    const learningDefaults = ctx.get('arcfoldLearningDefaults');
    const savedLearn = learningDefaults?.read();
    const learnSelection = savedLearn && plan.config.learn ? { ...plan.config.learn,
      provider: savedLearn.provider, model: savedLearn.model, reasoningEffort: savedLearn.reasoningEffort } : null;
    let learn = runtimeRouteAvailability({ ...plan.config, learn: learnSelection }).learn;
    const routes = runtimeTransport(plan.config).routes;
    const providers = {};
    for (const [provider, route] of Object.entries(routes)) providers[provider] = {
      credentialConfigured: (await credentials.describe(route.apiKeyRef)).configured === true, providerCredentialValidated: false,
    };
    const credentialConfigured = providers[selection.provider]?.credentialConfigured === true;
    const withCredential = (value, selected) => value.available && !providers[selected?.provider]?.credentialConfigured
      ? { ...value, available: false, reason: 'native-credential-not-configured', credentialConfigured: false }
      : { ...value, credentialConfigured: providers[selected?.provider]?.credentialConfigured === true };
    main = withCredential(main, selection); learn = withCredential(learn, learnSelection);
    // An asynchronous metadata read cannot advertise the earlier topology or
    // selection after a live native edit. The next status call may read again.
    gate = gateView(guard);
    if (ctx.get('arcfoldRuntimeGuard') !== guard || gate.phase !== 'ready') return blocked(gate);
    const latestSelection = ctx.get('agentDefaultModel')?.currentSelection();
    if (!latestSelection || selectionKey(latestSelection) !== before)
      main = unavailable('native-selection-changed-during-status');
    if (learningDefaults !== ctx.get('arcfoldLearningDefaults') || learningDefaults?.read()?.revision !== savedLearn?.revision)
      learn = unavailable('learning-selection-changed-during-status');
    const issues = [!main.available && main.reason, !learn.available && learn.reason,
      plan.config.transport && !credentialConfigured && 'native-credential-not-configured'].filter(Boolean);
    return { mode: main.available && credentialConfigured ? 'execution-ready' : 'configuration-only', modelGate: gate,
      routeAvailability: { main, learn, credentialConfigured, providerCredentialValidated: false,
        mainSelectionScope: 'native-default', providers }, issues };
  } catch {
    return blocked(gateView(guard), 'runtime-readiness-unavailable');
  }
}

/** Verify only fixed local modules and receipts, not model endpoints or secrets.
 * Shared by full startup and the real-plugin focused ownership fixtures. */
export async function inspectRuntimeProviders(ctx, plan, criticalFibers) {
  const routes = runtimeTransport(plan.config).routes;
  const providers = Object.keys(routes).filter(provider => runtimeProviderDefaults(plan.config, provider).available).sort();
  required(canonicalJson(ctx.llm.listProviders().map(value => value.id).sort()) === canonicalJson(providers),
    'The running model routes differ from the installed metered routes');
  const shared = plan.config.schema === 'arcfold-local-v2';
  for (const provider of providers) {
    const openai = provider === 'openai';
    const proof = plan.installation.providers?.[provider] ?? (!openai ? plan.installation.provider : undefined);
    required(proof?.path, `The installation has no actual consuming-copy proof for ${provider}`);
    const importer = pathToFileURL(join(plan.installation.coreRoot, 'src', openai ? 'openai-provider.mjs' : 'deepseek-provider.mjs')).href;
    const packageName = openai ? '@deepseek-ai/dsh-llm-pi-ai' : '@deepseek-ai/dsh-llm-deepseek';
    const actual = ctx.pluginPackages.packageOf(packageName, importer);
    required(actual && realpathSync(actual.dir) === realpathSync(proof.path), `The ${provider} wrapper resolves to an unverified copy`);
    const moduleURL = pathToFileURL(join(actual.dir, 'lib/index.js')).href;
    const loaded = await import(moduleURL);
    if (openai) {
      required(shared && typeof proof.receiptSHA256 === 'string' && /^[a-f0-9]{64}$/.test(proof.receiptSHA256) && proof.receipt,
        'OpenAI requires a new exact installation patch receipt');
      const receiptBytes = readFileSync(proof.receipt);
      required(createHash('sha256').update(receiptBytes).digest('hex') === proof.receiptSHA256, 'The OpenAI installation receipt changed');
      const inspector = await import(new URL('../scripts/patch-pi-ai-transport.mjs', import.meta.url));
      required(inspector.inspectPiAiPatch(actual.dir).state === 'patched' && proof.patchId === inspector.patchSpec.id &&
        loaded.PiAiAdapter.transportSeam === 'pi-ai-create-transport-v2', 'The actual OpenAI consuming copy lacks the exact loaded interface');
      const wrapper = criticalFibers['arcfold-openai-provider'];
      const llm = [...criticalFibers.llm.provisions].find(record => record.name === 'llm');
      const metered = [...criticalFibers['arcfold-shared-metered-host'].provisions].find(record => record.name === 'arcfoldMeteredTransport');
      const identity = assertOpenAIIdentity(ctx.root, wrapper, llm, metered);
      required(realpathSync(fileURLToPath(identity.moduleURL)) === realpathSync(fileURLToPath(moduleURL)) &&
        identity.nativeFiber.runtime.callback === loaded.apply,
        'The running native OpenAI child is not the verified installed module');
      criticalFibers['arcfold-openai-native'] = identity.nativeFiber;
    } else {
      const inspector = await import(new URL('../scripts/patch-deepseek-transport.mjs', import.meta.url));
      required(inspector.inspectDeepSeekPatch(actual.dir).state === 'patched' && proof.patchId === inspector.patchSpec.id &&
        loaded.registerDeepSeekProvider.transportSeam === 'deepseek-messages-create-transport-v1', 'The loaded DeepSeek provider lacks metered dispatch');
    }
  }
  return providers;
}


/** Check the actual official profile consumer and the one owned settings hook. */
export async function inspectRuntimeModelSelection(ctx, plan, criticalFibers) {
  const proof = plan.installation.modelSelection;
  required(proof?.path && proof.receipt && /^[a-f0-9]{64}$/.test(proof.receiptSHA256 ?? ''),
    'This installed version has no native model-selection patch proof');
  const parent = pathToFileURL(join(plan.installation.profileDir, 'cordis.yml')).href;
  const actual = ctx.pluginPackages.packageOf('@deepseek-ai/dsh-api-session-controller', parent);
  required(actual && realpathSync(actual.dir) === realpathSync(proof.path), 'The native controller uses an unverified consuming copy');
  required(createHash('sha256').update(readFileSync(proof.receipt)).digest('hex') === proof.receiptSHA256,
    'The native controller patch receipt changed');
  const inspector = await import(new URL('../scripts/patch-model-selection.mjs', import.meta.url));
  const loaded = await import(pathToFileURL(join(actual.dir, 'lib/index.js')).href);
  required(inspector.inspectModelSelectionPatch(actual.dir).state === 'patched' && proof.patchId === inspector.patchSpec.id &&
    loaded.SessionController.modelSelectionSeam === 'session-model-selection-commit-v1' &&
    serviceIdentity(ctx.sessionController).constructor === loaded.SessionController,
    'The running native controller lacks the verified model-selection interface');
  const modelFiber = criticalFibers['arcfold-runtime-model-settings'];
  const matches = [...modelFiber.provisions].filter(value => value.name === 'arcfoldRuntimeModels');
  const models = serviceIdentity(ctx.arcfoldRuntimeModels), identity = models.identity;
  required(matches.length === 1 && matches[0].value === models && Object.isFrozen(identity) &&
    identity.fiber === modelFiber && identity.hookActive() === true &&
    identity.controller === serviceIdentity(ctx.sessionController) && identity.defaults === serviceIdentity(ctx.agentDefaultModel) &&
    identity.sessions === serviceIdentity(ctx.sessions), 'The required native model selection handler is not owned by this runtime');
  const defaults = criticalFibers['agent-default-model'];
  required(defaults.entry && ctx.configEditor.entries().includes(defaults.entry) &&
    canonicalRuntimePath(ctx.configEditor.documentPath) === canonicalRuntimePath(join(plan.nativeHome, 'arcfold.patch.yml')),
    'The native model default has no verified persistent profile editor');
}

/** Observe the actual official host; this does not send a model or resolve a secret. */
export async function inspectRuntimeReady(ctx, plan) {
  const guard = ctx.get('arcfoldRuntimeGuard');
  required(guard, 'The root-owned model guard is absent');
  try {
    const expectedAdapterUpdates = guard.snapshot().adapterUpdates;
    const services = Object.fromEntries(SERVICES.map(name => [name, ctx.get(name)]));
    for (const name of SERVICES) required(services[name], `Required runtime service is not active: ${name}`);
    const loader = ctx.get('loader'); required(loader, 'Official loader is absent');
    const entries = [...loader.entries()];
    const entry = id => {
      const matches = entries.filter(value => value.options.id === id);
      required(matches.length === 1, `Expected one actual component: ${id}`);
      return matches[0];
    };
    const fiber = id => actualRuntimeFiber(entry(id), ctx.root);
    const profile = ctx.get('profileContext');
    required(profile && realpathSync(profile.dir) === plan.installation.profileDir &&
      realpathSync(profile.installAnchor) === plan.installation.installAnchor &&
      realpathSync(profile.home) === plan.nativeHome && realpathSync(profile.cwd) === plan.workspace,
    'The host is using a different profile, data home, installation or workspace');
    const parent = pathToFileURL(join(plan.installation.profileDir, 'package.json')).href;
    const packages = services.pluginPackages;
    for (const [name, directory] of [[CORE, plan.installation.coreRoot], [UI, plan.installation.uiRoot]])
      required(realpathSync(packages.packageOf(name, parent)?.dir ?? '') === directory, `Actual loaded package differs: ${name}`);
    const uiPath = services.clientModules.clientPath(UI);
    required(uiPath && realpathSync(uiPath).startsWith(plan.installation.uiRoot + '/'), 'The installed UI client is absent');
    required(services.clientModules.graph().entries.filter(value => value.id === UI).length === 1, 'The UI module is absent or duplicated');
    const typert = ctx.get('typert');
    for (const endpoint of ['arcfoldMethods/list', 'arcfoldMethods/decide', 'arcfoldGoals/list', 'arcfoldGoals/decide',
      'arcfoldOpportunities/list', 'arcfoldOpportunities/savePermission', 'arcfoldOpportunities/prepare', 'arcfoldOpportunities/continue',
      'session/modelCatalog', 'session/selectModel', 'arcfoldModels/read', 'arcfoldModels/saveLearning'])
      required(typert?.local.get(endpoint), `The actual UI endpoint is missing: ${endpoint}`);
    const presets = await services.agentPresets.list();
    for (const id of ['arcfold-main', 'arcfold-learning', 'arcfold-preparation'])
      required(presets.filter(value => value.id === id && !value.broken).length === 1, `Required preset is missing: ${id}`);
    const compositions = services.agentPresets.inspectCompositions();
    required(compositions.find(value => value.id === 'arcfold-main')?.modules.some(value => value.moduleName === '@arcfold/dsh/agent'),
      'The native main preset lacks Arcfold ownership');
    required(!compositions.find(value => value.id === 'arcfold-main')?.modules.some(value =>
      ['@deepseek-ai/dsh-tool-goal', '@deepseek-ai/dsh-command-goal'].includes(value.moduleName)),
    'Native goal mutations must not bypass Arcfold stage control');
    required(ctx.get('arcfoldWork'), 'Arcfold execution-stage control is missing');
    required(compositions.find(value => value.id === 'arcfold-learning')?.modules.length === 0, 'Learn acquired tool-bearing modules');
    assertPreparationComposition(compositions.find(value => value.id === 'arcfold-preparation'),
      entry('preset-arcfold-preparation').fiber.ctx.fiber.rawConfig.plugins);
    const nativeDriver = await inspectNativeContinuationDriver(ctx, entries, compositions);
    const configured = runtimeRouteAvailability(plan.config);
    required(services.arcfoldRuntimeWorkspace.requestedPath === plan.workspace,
      'The native workspace initialization used a different deployment directory');
    const criticalFibers = Object.fromEntries(['llm', 'arcfold-business', 'preset-arcfold-main', 'arcfold-preparation', 'preset-arcfold-preparation',
      'fs-observation-policy', 'fs-sandbox', 'tool-executor-native',
      'arcfold-runtime-workspace', 'workspace-controller', 'arcfold-runtime-model-settings',
      'session', 'session-controller', 'agent-default-model', 'config-editor', 'arcfold-ui'].map(id => [id, fiber(id)]));
    criticalFibers['goal-round-driver'] = nativeDriver;
    criticalFibers.goal = fiber('goal');
    await inspectRuntimeModelSelection(ctx, plan, criticalFibers);
    let identifyRequest;
    const routes = runtimeTransport(plan.config).routes;
    const enabled = Object.keys(routes).filter(provider => runtimeProviderDefaults(plan.config, provider).available);
    if (enabled.length) {
      for (const id of ['credentials', 'session']) criticalFibers[id] = fiber(id);
      if (plan.config.schema === 'arcfold-local-v2') criticalFibers['arcfold-shared-metered-host'] = fiber('arcfold-shared-metered-host');
      else criticalFibers['arcfold-metered-budget'] = fiber('arcfold-metered-budget');
      if (enabled.includes('deepseek-official')) criticalFibers['arcfold-metered-provider'] = fiber('arcfold-metered-provider');
      if (enabled.includes('openai')) criticalFibers['arcfold-openai-provider'] = fiber('arcfold-openai-provider');
      const { nativeRequestIdentity } = await import(pathToFileURL(join(plan.installation.coreRoot, 'src/native-request-authority.mjs')).href);
      identifyRequest = options => nativeRequestIdentity(services.arcfoldBusiness, services.sessions, options);
    }
    await inspectRuntimeProviders(ctx, plan, criticalFibers);
    if (configured.learn.available) {
      required(ctx.get('arcfoldLearning'), 'Configured independent learning is not active');
      criticalFibers['arcfold-learning'] = fiber('arcfold-learning');
      criticalFibers['preset-arcfold-learning'] = fiber('preset-arcfold-learning');
    }
    const rawUrl = new URL(services.webApp.getAdvertisedUrl());
    required(rawUrl.hostname === '127.0.0.1' && rawUrl.protocol === 'http:', 'Unexpected local web listener');
    rawUrl.username = ''; rawUrl.password = ''; rawUrl.search = ''; rawUrl.hash = '';
    // No HTTP inference: each required service, actual module and native preset was inspected above.
    guard.arm({ criticalFibers, identifyRequest, expectedAdapterUpdates });
    return { url: rawUrl.href, identity: { sourceCommit: plan.installation.sourceCommit, profile: plan.installation.profileName,
        core: plan.installation.coreRoot, ui: plan.installation.uiRoot },
      ...await refreshRuntimeReadiness(ctx, plan) };
  } catch (error) { guard.fail(error); throw error; }
}
