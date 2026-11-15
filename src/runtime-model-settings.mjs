import { createModelSelectionHandler } from './model-selection.mjs';
import { getRuntimeGuard, serviceIdentity } from './runtime-guard.mjs';
import { runtimeTransport, runtimeRouteAvailability } from './runtime-config.mjs';
import { runtimeMainAvailability } from './runtime-readiness.mjs';

const choice = value => value ? { provider: value.provider, model: value.model,
  reasoningEffort: value.reasoningEffort ?? null } : { provider: '', model: '', reasoningEffort: null };
const defaultView = value => value ? { revision: value.revision, ...choice(value) } : null;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const unavailable = reason => ({ available: false, reason });

/** Read-only views and validated edits over existing native/business owners. */
export function createRuntimeModelSettings(host, config, guard) {
  const routes = runtimeTransport(config).routes;
  const assertReady = () => guard.assertReady();
  const assertLearningSelection = selected => {
    // Startup can prepare an existing pending item before the outer stream gate
    // opens. This grants no send: that gate and the final dispatch still apply.
    const phase = guard.snapshot().phase;
    if (!['starting', 'ready'].includes(phase)) assertReady();
    if (!config.learn || !runtimeRouteAvailability({ ...config, learn: selected }).learn.available)
      fail('learning_configuration_unavailable', '当前部署不允许这项学习模型设置。');
  };
  const assertMainSelection = async (_agent, selected) => {
    assertReady();
    const available = await runtimeMainAvailability(host.llm, config, selected);
    assertReady();
    if (!available.available) fail('model_selection_unavailable', '当前部署无法使用这项主模型设置。');
  };
  const catalog = async () => {
    const native = await host.sessionController.modelCatalog();
    return Object.entries(routes).map(([provider, route]) => {
      const group = native.groups.find(group => group.id === provider);
      return { provider, label: provider === 'openai' ? 'OpenAI' : 'DeepSeek', apiKeyRef: route.apiKeyRef,
        models: (group?.models ?? []).flatMap(model => {
          const policy = route.modelPolicies[model.id];
          if (!policy) return [];
          const efforts = (model.reasoning?.efforts ?? []).map(value => value.id)
            .filter(value => policy.reasoningEfforts.includes(value));
          return efforts.length ? [{ id: model.id, label: model.name, reasoningEfforts: efforts }] : [];
        }) };
    });
  };
  const usage = provider => {
    const source = host.get('arcfoldMeteredTransport') ?? (provider === 'deepseek-official' ? host.get('arcfoldDeepSeekTransport') : null);
    let value; try { value = source?.summary(provider); } catch { return null; }
    if (!value) return null;
    if (provider === 'openai') return { accounting: 'tokens_only', scope: value.scope,
      requests: value.requests, unknownCount: value.unknownCount, pendingCount: value.pendingCount,
      promptTokens: value.promptTokens, completionTokens: value.completionTokens, cachedTokens: value.cachedTokens };
    return { accounting: 'cny', scope: value.scope, requests: value.requests, unknownCount: value.unknownCount,
      spentCny: value.spentCny, reservedCny: value.reservedCny, ceilingCny: value.ceilingCny };
  };
  return Object.freeze({ assertLearningSelection, assertMainSelection,
    async read() {
      const defaults = host.get('arcfoldLearningDefaults');
      const main = choice(host.agentDefaultModel.currentSelection()), learn = defaults?.read();
      let list = [], mainAvailability, learnAvailability;
      try { list = await catalog(); } catch { /* A stopped/failed catalog has no executable choices. */ }
      try { mainAvailability = await runtimeMainAvailability(host.llm, config, main); }
      catch { mainAvailability = unavailable('selected-model-controls-unavailable'); }
      learnAvailability = config.learn && learn ? runtimeRouteAvailability({ ...config,
        learn: { ...config.learn, ...choice(learn) } }).learn : unavailable('learn-not-configured');
      const presence = {};
      for (const [provider, route] of Object.entries(routes)) {
        try { presence[provider] = (await host.credentials.describe(route.apiKeyRef)).configured === true; }
        catch { presence[provider] = false; }
      }
      const withCredential = (available, selected) => available.available && !presence[selected?.provider]
        ? unavailable('native-credential-not-configured') : available;
      mainAvailability = withCredential(mainAvailability, main); learnAvailability = withCredential(learnAvailability, learn);
      const gate = guard.snapshot(), currentMain = choice(host.agentDefaultModel.currentSelection()), currentLearn = defaults?.read();
      if (JSON.stringify(currentMain) !== JSON.stringify(main)) mainAvailability = unavailable('native-selection-changed-during-status');
      if (currentLearn?.revision !== learn?.revision) learnAvailability = unavailable('learning-selection-changed-during-status');
      if (gate.phase !== 'ready') mainAvailability = learnAvailability = unavailable('runtime-not-ready');
      return { gate, main: { defaultSelection: currentMain, availability: mainAvailability },
        learning: { enabled: Boolean(config.learn && defaults), defaults: defaultView(currentLearn), availability: learnAvailability },
        routes: list.map(route => ({ ...route, usage: usage(route.provider) })) };
    },
    async saveLearning(request, assertCaller = () => {}) {
      assertCaller(); assertReady();
      const defaults = host.get('arcfoldLearningDefaults');
      if (!config.learn || !defaults) fail('learning_configuration_unavailable', '当前部署尚未启用独立学习。');
      // The default service owns exact field/revision checks. Catalog reads may
      // await, so current authorization and revision are checked again at save.
      const list = await catalog();
      const model = list.find(route => route.provider === request?.provider)?.models.find(model => model.id === request?.model);
      if (!model?.reasoningEfforts.includes(request?.reasoningEffort))
        fail('learning_configuration_unavailable', '所选模型或思考强度不在当前可用目录中。');
      assertCaller(); assertReady();
      return defaultView(defaults.save(request));
    },
  });
}

export const name = 'arcfold-runtime-model-settings';
export const inject = ['arcfoldRuntimeGuard', 'arcfoldBusiness', 'sessions', 'sessionController',
  'agentDefaultModel', 'llm', 'credentials', 'configEditor'];
export function apply(ctx, { runtime } = {}) {
  const config = structuredClone(runtime), guard = getRuntimeGuard(ctx);
  const service = createRuntimeModelSettings(ctx, config, guard);
  const handler = createModelSelectionHandler({ sessions: ctx.sessions, defaults: ctx.agentDefaultModel,
    assertSelection: service.assertMainSelection });
  let active = true;
  const dispose = ctx.on('session/select-model', payload => handler(payload));
  ctx.effect(() => () => { active = false; dispose(); }, 'remove native idle model selection');
  ctx.provide('arcfoldRuntimeModels', Object.freeze({ ...service,
    identity: Object.freeze({ fiber: ctx.fiber, controller: serviceIdentity(ctx.sessionController),
      defaults: serviceIdentity(ctx.agentDefaultModel), sessions: serviceIdentity(ctx.sessions),
      hookActive: () => active }) }));
}
