import { canonicalJson } from './store.mjs';
import { learningExecutionConfig } from './learning-defaults.mjs';
import { symbols } from '@deepseek-ai/cordis';

const guards = new WeakMap();
const ACTIVE = 2; // Cordis 4.1.0 FiberState.ACTIVE (the TS const enum has no JS export).
const SERVICE = 'arcfoldRuntimeGuard';
const REQUIRED = ['llm', 'arcfold-business', 'preset-arcfold-main'];
const ROUTE_FIELDS = ['provider', 'model', 'reasoningEffort', 'maxTokens'];

function frozen(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function configuration(value) {
  return frozen(JSON.parse(canonicalJson({
    modelSelectionRequired: value.modelSelectionRequired === true,
    initialMain: value.initialMain ?? { provider: '', model: '' },
    mainMaxTokens: value.mainMaxTokens ?? null,
    routeAvailability: value.routeAvailability ?? { main: { available: false }, learn: { available: false } },
    learn: value.learn ?? null,
    modelPolicies: value.modelPolicies ?? {},
    ...(value.routes === undefined ? {} : { routes: value.routes }),
  })));
}

function provision(fiber, name) {
  const matches = [...(fiber?.provisions ?? [])].filter(item => item.name === name);
  if (matches.length !== 1 || matches[0].ctx.fiber !== fiber)
    throw failure('ARCFOLD_RUNTIME_IDENTITY', `The runtime has no unique owned ${name} service`);
  return matches[0];
}

// Cordis exports this read-only tracing identity symbol. Event callbacks see
// caller-scoped proxies, not the raw service retained by Fiber.provisions.
export function serviceIdentity(value) {
  const seen = new Set();
  while (value && value[symbols.original]) {
    if (seen.has(value)) return null;
    seen.add(value); value = value[symbols.original];
  }
  return value;
}

/** Read the real optional child, never a guessed Loader entry or provider label. */
export function assertOpenAIIdentity(root, wrapper, llm, metered) {
  const record = provision(wrapper, 'arcfoldOpenAIProviderIdentity'), identity = record.value;
  const child = identity?.nativeFiber;
  if (!Object.isFrozen(identity) || !Object.isFrozen(identity.configuration) || identity.wrapperFiber !== wrapper ||
      !child || child.state !== ACTIVE || child.ctx.root !== root || child.parent.fiber !== wrapper ||
      child.committed?.llm !== llm || wrapper.committed?.llm !== llm || wrapper.committed?.arcfoldMeteredTransport !== metered ||
      typeof identity.moduleURL !== 'string' || typeof identity.transportHookActive !== 'function' || identity.transportHookActive() !== true ||
      canonicalJson(child.rawConfig) !== canonicalJson(identity.configuration))
    throw failure('ARCFOLD_RUNTIME_IDENTITY', 'The actual OpenAI child, fixed profile or owned transport callback changed.');
  return identity;
}

/** Root ownership deliberately survives profile-entry disposal. No entry may re-arm it. */
export function getRuntimeGuard(ctx) {
  return guards.get(ctx.root) ?? ctx.root.get(SERVICE);
}

export const name = 'arcfold-runtime-guard';
// No injection: the official llm entry depends on the root service this installs.
export function apply(ctx, input = {}) {
  const root = ctx.root, config = configuration(input), existing = getRuntimeGuard(root);
  if (existing) {
    if (canonicalJson(existing.configuration) !== canonicalJson(config)) existing.requireRestart('guard-configuration-changed');
    return; // Never return a root-owned disposer to the replaceable plugin fiber.
  }

  let phase = 'starting', reason = null, armed = false, adapterUpdates = 0;
  let releaseReady;
  const ready = new Promise(resolve => { releaseReady = resolve; });
  let pinned = [], identifyRequest, transport, rootLlm, openAI, business, models;
  const providerIdentitiesCurrent = () => {
    if (models && models.identity.hookActive() !== true) return false;
    if (openAI) { try { if (assertOpenAIIdentity(root, openAI.wrapper, rootLlm, transport) !== openAI.identity) return false; } catch { return false; } }
    return true;
  };
  const identitiesCurrent = () => providerIdentitiesCurrent() && pinned.every(saved => saved.fiber.uid === saved.uid && saved.fiber.state === ACTIVE &&
    saved.provisions.every(item => saved.fiber.provisions.has(item.record) && item.record.value === item.value && item.record.uid === item.uid) &&
    Object.entries(saved.committed).every(([key, item]) => saved.fiber.committed?.[key] === item.record &&
      item.record.value === item.value && item.record.uid === item.uid));
  const snapshot = () => Object.freeze(phase === 'ready' && !identitiesCurrent()
    ? { phase: 'requires-restart', reason: 'critical-component-changed', armed, adapterUpdates }
    : { phase, reason, armed, adapterUpdates });
  const stop = (next, why) => {
    if (phase === 'closed' || phase === 'failed' || phase === 'requires-restart') return;
    phase = next; reason = why; releaseReady();
  };
  const requireRestart = why => stop('requires-restart', why);
  const rejectState = () => {
    if (phase !== 'ready') throw failure(
      phase === 'requires-restart' ? 'ARCFOLD_RUNTIME_RESTART_REQUIRED' : 'ARCFOLD_RUNTIME_NOT_READY',
      phase === 'requires-restart' ? 'The model configuration changed; restart Arcfold through its launcher before sending another request.'
        : 'Arcfold is not ready to send model requests. Its configuration page remains available.',
    );
  };
  const assertIdentities = () => {
    if (!identitiesCurrent()) { requireRestart('critical-component-changed'); rejectState(); }
  };
  const assertInput = options => {
    rejectState(); assertIdentities();
    options.signal?.throwIfAborted();
    if (!transport) throw failure('ARCFOLD_ROUTE_UNAVAILABLE', 'No supported metered model route is configured.');
    if (!Object.isFrozen(options)) throw failure('ARCFOLD_RUNTIME_INPUT', 'Only a frozen native session request may use this runtime.');
    const policies = config.routes === undefined ? (options.provider === 'deepseek-official' ? config.modelPolicies : undefined) : config.routes[options.provider]?.modelPolicies;
    const policy = policies?.[options.model];
    if (!policy ||
        !policy.reasoningEfforts?.includes(options.reasoningEffort) ||
        !Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1 ||
        options.maxTokens > (policy.requestMaxTokens ?? policy.maxOutputTokens))
      throw failure('ARCFOLD_ROUTE_UNAVAILABLE', 'The selected model or request controls are not supported by this metered runtime.');
  };
  // Full business ownership is checked at the owned transport, after the
  // learning middleware has validated and recorded its single-call intent.
  const assertDispatch = options => {
    assertInput(options);
    const identity = identifyRequest(options);
    if (identity && typeof identity.then === 'function') {
      void Promise.resolve(identity).catch(() => {});
      throw failure('ARCFOLD_RUNTIME_IDENTITY', 'Native request identity must be checked synchronously.');
    }
    const role = identity?.metadata?.role;
    if (!['main', 'learning', 'preparation'].includes(role)) throw failure('ARCFOLD_RUNTIME_IDENTITY', 'The request has no supported Arcfold owner.');
    if (role === 'main' && config.mainMaxTokens !== null && options.maxTokens !== config.mainMaxTokens)
      throw failure('ARCFOLD_ROUTE_UNAVAILABLE', 'The native model default cannot represent the explicitly configured main output limit. Update the main configuration before sending.');
    if (role === 'learning') {
      const run = business?.get('learning_runs', identity.metadata.learningPendingId);
      if (!config.routeAvailability.learn?.available || !run || run.sessionId !== options.sessionId ||
          run.inputHash !== identity.metadata.learningInputHash)
        throw failure('ARCFOLD_ROUTE_UNAVAILABLE', 'This learning request has no matching saved execution configuration.');
      const execution = learningExecutionConfig(run);
      if (ROUTE_FIELDS.some(key => options[key] !== execution[key]))
        throw failure('ARCFOLD_ROUTE_UNAVAILABLE', 'This learning request does not match its independently configured model saved at start.');
    }
    if (role === 'preparation') {
      const run = business?.get('preparation_runs', identity.metadata.preparationRunId);
      if (!run || run.sessionId !== options.sessionId || run.inputHash !== identity.metadata.preparationInputHash ||
          run.state !== 'submitted' || ROUTE_FIELDS.some(key => options[key] !== run.executionConfig?.[key]) ||
          !root.get('arcfoldPreparation'))
        throw failure('ARCFOLD_ROUTE_UNAVAILABLE', 'Preparation has no matching bounded native owner.');
    }
    return identity;
  };
  const waitReady = async signal => {
    signal?.throwIfAborted();
    if (phase === 'starting') {
      if (!signal) await ready;
      else await new Promise((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
        signal.addEventListener('abort', abort, { once: true });
        ready.then(() => { signal.removeEventListener('abort', abort); resolve(); });
        if (signal.aborted) abort();
      });
    }
    signal?.throwIfAborted(); rejectState();
  };

  const guard = Object.freeze({
    configuration: config, snapshot, requireRestart, assertDispatch,
    assertReady() { rejectState(); assertIdentities(); },
    fail: () => stop('failed', 'startup-failed'),
    close: () => stop('closed', 'runtime-closed'),
    arm({ criticalFibers, identifyRequest: identify, expectedAdapterUpdates = adapterUpdates } = {}) {
      if (armed || phase !== 'starting') throw failure('ARCFOLD_RUNTIME_ARM', 'A runtime guard can be armed only once, by startup readiness.');
      try {
        if (!criticalFibers || typeof criticalFibers !== 'object' || Array.isArray(criticalFibers))
          throw failure('ARCFOLD_RUNTIME_IDENTITY', 'Startup must supply the actual critical plugin fibers.');
        for (const id of REQUIRED) if (!criticalFibers[id]) throw failure('ARCFOLD_RUNTIME_IDENTITY', `Startup is missing ${id}.`);
        pinned = Object.entries(criticalFibers).map(([id, fiber]) => {
          if (fiber?.state !== ACTIVE || !Number.isSafeInteger(fiber.uid) || fiber.uid < 1 || fiber.ctx.root !== root)
            throw failure('ARCFOLD_RUNTIME_IDENTITY', `The ${id} plugin is not an active child of this host.`);
          const pin = record => ({ record, value: record.value, uid: record.uid });
          return { id, fiber, uid: fiber.uid, provisions: [...fiber.provisions].map(pin),
            committed: Object.fromEntries(Object.entries(fiber.committed ?? {}).map(([key, record]) => [key, pin(record)])) };
        });
        rootLlm = provision(criticalFibers.llm, 'llm');
        business = provision(criticalFibers['arcfold-business'], 'arcfoldBusiness').value;
        if (config.modelSelectionRequired) {
          const modelFiber = criticalFibers['arcfold-runtime-model-settings'];
          models = provision(modelFiber, 'arcfoldRuntimeModels').value;
          const expected = { sessionController: 'session-controller', agentDefaultModel: 'agent-default-model', sessions: 'session', configEditor: 'config-editor' };
          for (const [name, id] of Object.entries(expected))
            if (modelFiber.committed?.[name] !== provision(criticalFibers[id], name))
              throw failure('ARCFOLD_RUNTIME_IDENTITY', 'Native model settings uses an unverified service.');
          const identity = models.identity;
          if (!Object.isFrozen(identity) || identity.fiber !== modelFiber || identity.hookActive() !== true ||
              identity.controller !== provision(criticalFibers['session-controller'], 'sessionController').value ||
              identity.defaults !== provision(criticalFibers['agent-default-model'], 'agentDefaultModel').value ||
              identity.sessions !== provision(criticalFibers.session, 'sessions').value)
            throw failure('ARCFOLD_RUNTIME_IDENTITY', 'The mandatory native model selection handler is absent or changed.');
        }
        const provider = criticalFibers['arcfold-metered-provider'];
        const shared = criticalFibers['arcfold-shared-metered-host'];
        const expectedProviders = config.routes === undefined ? (provider ? ['deepseek-official'] : []) : Object.keys(config.routes).sort();
        if (canonicalJson(rootLlm.value.listProviders().map(p => p.id).sort()) !== canonicalJson(expectedProviders) ||
            serviceIdentity(root.get('llm')) !== rootLlm.value || expectedAdapterUpdates !== adapterUpdates)
          throw failure('ARCFOLD_RUNTIME_IDENTITY', 'The actual model topology changed before the final readiness check.');
        if (config.routes !== undefined) {
          if (Boolean(shared) !== Boolean(expectedProviders.length)) throw failure('ARCFOLD_RUNTIME_IDENTITY', 'Shared accounting and actual model routes must be mounted together.');
          if (shared) {
            transport = provision(shared, 'arcfoldMeteredTransport');
            if (shared.committed?.llm !== rootLlm || typeof transport.value?.createTransport !== 'function' ||
                canonicalJson(transport.value.configuration.routes) !== canonicalJson(config.routes))
              throw failure('ARCFOLD_RUNTIME_IDENTITY', 'The shared accounting policies or LLM ownership differ from startup configuration.');
            const business = provision(criticalFibers['arcfold-business'], 'arcfoldBusiness');
            const sessions = provision(criticalFibers.session, 'sessions');
            if (shared.committed?.arcfoldBusiness !== business || shared.committed?.sessions !== sessions)
              throw failure('ARCFOLD_RUNTIME_IDENTITY', 'The shared host uses a different business or native session service.');
          }
          const deepseek = config.routes['deepseek-official'];
          if (Boolean(provider) !== Boolean(deepseek)) throw failure('ARCFOLD_RUNTIME_IDENTITY', 'The configured DeepSeek wrapper is absent or unexpected.');
          if (provider && (provider.committed?.llm !== rootLlm || provider.committed?.arcfoldDeepSeekTransport !== provision(shared, 'arcfoldDeepSeekTransport')))
            throw failure('ARCFOLD_RUNTIME_IDENTITY', 'The DeepSeek wrapper is not owned by the shared host.');
          const wrapper = criticalFibers['arcfold-openai-provider'];
          if (Boolean(wrapper) !== Boolean(config.routes.openai)) throw failure('ARCFOLD_RUNTIME_IDENTITY', 'The configured OpenAI wrapper is absent or unexpected.');
          if (wrapper) {
            const identity = assertOpenAIIdentity(root, wrapper, rootLlm, transport);
            if (criticalFibers['arcfold-openai-native'] !== identity.nativeFiber)
              throw failure('ARCFOLD_RUNTIME_IDENTITY', 'Readiness did not pin the actual native OpenAI child.');
            openAI = { wrapper, identity };
          }
          if (expectedProviders.length) {
            const credentials = provision(criticalFibers.credentials, 'credentials');
            for (const wrapper of [provider, criticalFibers['arcfold-openai-provider']].filter(Boolean))
              if (wrapper.committed?.credentials !== credentials) throw failure('ARCFOLD_RUNTIME_IDENTITY', 'A provider uses a foreign credential service.');
          }
        } else {
          const budget = criticalFibers['arcfold-metered-budget'];
          if (Boolean(budget) !== Boolean(provider)) throw failure('ARCFOLD_RUNTIME_IDENTITY', 'The model provider and its accounting service must be mounted together.');
          if (provider) {
            transport = provision(budget, 'arcfoldDeepSeekTransport');
            if (provider.committed?.llm !== rootLlm || provider.committed?.arcfoldDeepSeekTransport !== transport || budget.committed?.llm !== rootLlm ||
                transport.value?.configuration?.provider !== 'deepseek-official' || canonicalJson(transport.value.configuration.modelPolicies) !== canonicalJson(config.modelPolicies))
              throw failure('ARCFOLD_RUNTIME_IDENTITY', 'The metered provider is not bound to the verified LLM and accounting instances.');
          }
        }
        if (expectedProviders.length && typeof identify !== 'function') throw failure('ARCFOLD_RUNTIME_IDENTITY', 'A native request identity check is required.');
        if (config.routeAvailability.learn?.available && (!transport || !criticalFibers['arcfold-learning'] || !criticalFibers['preset-arcfold-learning']))
          throw failure('ARCFOLD_RUNTIME_IDENTITY', 'The independently configured learning route is incomplete.');
        identifyRequest = identify; armed = true; phase = 'ready'; releaseReady();
        return snapshot();
      } catch (error) { stop('failed', 'startup-identity-failed'); throw error; }
    },
  });
  guards.set(root, guard);
  root.on('llm/adapters-updated', () => {
    adapterUpdates++;
    if (armed) requireRestart('model-topology-changed');
  }, { global: true });
  root.on('internal/status', fiber => {
    if (armed && pinned.some(item => item.fiber === fiber) && fiber.state !== ACTIVE) requireRestart('critical-component-changed');
  }, { global: true });
  root.on('loader/volatile-update', function () {
    // Native default fields are explicitly volatile; a normal daily selection
    // retains the same service and must not tear down an active learning run.
    if (armed && pinned.some(item => item.fiber === this.fiber && item.id !== 'agent-default-model')) requireRestart('critical-configuration-changed');
  }, { global: true });
  root.on('llm/stream', function (options, next) {
    const sender = serviceIdentity(this);
    return (async function* () {
      await waitReady(options.signal);
      if (sender !== rootLlm.value) requireRestart('llm-instance-changed');
      // The outer gate runs before downstream learning validation. It
      // checks host/route readiness, not a dispatch intent that does not yet exist.
      assertInput(options);
      yield* next();
    })();
  }, { global: true, prepend: true });
  root.effect(() => () => guard.close(), 'close the model gate with the official host');
  root.provide(SERVICE, guard);
}
