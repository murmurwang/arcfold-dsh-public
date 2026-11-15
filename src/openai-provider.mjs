import { OPENAI_MODELS } from './openai-models.mjs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as piAi from '@deepseek-ai/dsh-llm-pi-ai';
import { canonicalJson } from './store.mjs';
import { inspectPiAiPatch } from '../scripts/patch-pi-ai-transport.mjs';
const freeze = value => { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; };
export const name = 'arcfold-openai-provider';
export const inject = ['llm', 'credentials', 'arcfoldMeteredTransport'];
export async function apply(ctx, config = {}) {
  if (piAi.PiAiAdapter.transportSeam !== 'pi-ai-create-transport-v2')
    throw new Error('The loaded official pi-ai adapter lacks the required v2 interface');
  const packageDir = dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-llm-pi-ai/package.json')));
  if (inspectPiAiPatch(packageDir).state !== 'patched')
    throw new Error('The actual consuming pi-ai package must have the exact supported patch');
  const service = ctx.arcfoldMeteredTransport;
  const route = service?.configuration?.routes?.openai;
  if (!route || route.provider !== 'openai' || typeof service.createTransport !== 'function' ||
      !route.modelPolicies || !Object.keys(route.modelPolicies).length ||
      Object.keys(route.modelPolicies).some(model => !OPENAI_MODELS.includes(model)))
    throw new Error('The mandatory owned OpenAI transport and fixed model policy are required');
  const policies = Object.values(route.modelPolicies);
  if (typeof config.apiKeyRef !== 'string' || !config.apiKeyRef.trim() ||
      !Number.isSafeInteger(config.maxTokens) || config.maxTokens < 16 ||
      policies.some(policy => config.maxTokens > (policy.requestMaxTokens ?? policy.maxOutputTokens) ||
        !policy.reasoningEfforts.includes(config.reasoningEffort)))
    throw new Error('An explicit credential reference and authorized reasoning/output defaults are required');
  const requestTransport = options => {
    if (options.provider !== 'openai' || !Object.hasOwn(route.modelPolicies, options.model))
      throw new Error('This model is not in the owned OpenAI route');
    const selected = service.createTransport(options);
    if (selected === undefined)
      throw new Error('The mandatory OpenAI transport is unavailable');
    return selected;
  };
  let transportHookActive = true;
  const removeTransportHook = ctx.on('llm-pi-ai/request-transport', requestTransport);
  ctx.effect(() => () => { transportHookActive = false; removeTransportHook(); }, 'retire owned OpenAI request transport');
  // Isolate authorization so the official plugin cannot install OAuth flows.
  // The explicit apiKeyEnv resolves only through the injected credentials service.
  const isolated = ctx.isolate('authorization');
  const nativeConfig = { providers: { openai: {
    apiKeyEnv: config.apiKeyRef, api: 'openai-responses', baseURL: route.endpoint.slice(0, -'/responses'.length),
    transport: 'sse', reasoning: config.reasoningEffort, cacheRetention: 'short',
    retryPolicy: { mode: 'normal', maxRetries: 0 },
    models: Object.entries(route.modelPolicies).map(([id, policy]) => ({ id, input: ['text', 'image'],
      contextWindow: policy.contextWindow, maxTokens: config.maxTokens })),
  } } };
  const native = await isolated.plugin(piAi, structuredClone(nativeConfig));
  const nativeFiber = native.ctx.fiber;
  // Freeze our detached data and references, never the live Cordis child.
  const identity = Object.freeze({ nativeFiber, wrapperFiber: ctx.fiber,
    moduleURL: import.meta.resolve('@deepseek-ai/dsh-llm-pi-ai'),
    configuration: freeze(structuredClone(nativeConfig)), transportHookActive: () => transportHookActive });
  ctx.provide('arcfoldOpenAIProviderIdentity', identity);
  const configurationIdentity = canonicalJson(nativeConfig);
  ctx.on('internal/config', (fiber, next) => {
    const raw = next();
    if (fiber === native && canonicalJson(raw) !== configurationIdentity)
      throw new Error('The owned OpenAI profile is frozen; reload its explicit host configuration');
    return raw;
  });
}
