import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertUsableApiKey, LlmError } from '@deepseek-ai/dsh-llm';
import { catalogModelInfo, registerDeepSeekProvider } from '@deepseek-ai/dsh-llm-deepseek';
import { resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek-api-key';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { inspectDeepSeekPatch } from '../scripts/patch-deepseek-transport.mjs';

const TRANSPORT_CONTRACT = 'deepseek-messages-create-transport-v1';

export const name = 'arcfold-deepseek-provider';
export const inject = ['llm', 'credentials', 'arcfoldDeepSeekTransport'];
export function apply(ctx, config = {}) {
  // Check the loaded function as well as disk: patching a file after an earlier
  // import must not make the cached original adapter look safe to register.
  if (registerDeepSeekProvider.transportSeam !== TRANSPORT_CONTRACT)
    throw new Error('The loaded DeepSeek provider lacks the required transport interface');
  const packageDir = dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-llm-deepseek/package.json')));
  if (inspectDeepSeekPatch(packageDir).state !== 'patched')
    throw new Error('The exact supported DeepSeek provider patch is required');
  const service = ctx.arcfoldDeepSeekTransport;
  const { provider, endpoint, modelPolicies } = service.configuration;
  if (provider !== 'deepseek-official' || !Object.keys(modelPolicies).length)
    throw new Error('An explicit metered DeepSeek model catalog is required');
  if (typeof config.apiKeyRef !== 'string' || !config.apiKeyRef ||
      !Number.isSafeInteger(config.maxTokens) || config.maxTokens < 1 ||
      !['off', 'low', 'high', 'max'].includes(config.reasoningEffort))
    throw new Error('A credential reference, output limit and reasoning effort are required');
  const models = Object.entries(modelPolicies).map(([id, policy]) => {
    if (config.maxTokens > (policy.requestMaxTokens ?? policy.maxOutputTokens) ||
        !policy.reasoningEfforts.includes(config.reasoningEffort))
      throw new Error('Provider defaults exceed a frozen model accounting policy');
    return { id, name: id, inputModalities: ['text'], contextWindow: policy.contextWindow,
      maxTokens: config.maxTokens };
  });
  // This deployment generation is fixed. A different route/catalog requires a
  // plugin reload; the user-selected model remains an ordinary DSH option.
  const connection = resolveAdapterOptions({
    baseURL: endpoint.slice(0, -'/v1/messages'.length), apiKeyEnv: config.apiKeyRef,
    models, maxTokens: config.maxTokens, reasoningEffort: config.reasoningEffort,
    retryPolicy: { mode: 'normal', maxRetries: 0 },
  }, launchEnvironmentOf(ctx));
  for (const model of connection.models) Object.freeze(model);
  Object.freeze(connection.models); Object.freeze(connection);
  registerDeepSeekProvider(ctx, provider, {
    providerName: 'DeepSeek', options: () => connection, connect: async () => connection,
    createTransport: options => service.createTransport(options),
    // Resolve secrets only inside the official credential service. They remain
    // in memory for the request and never enter Arcfold config or evidence.
    resolveAuth: async current => {
      const credential = await ctx.credentials.resolve(current.apiKeyEnv);
      if (!credential) throw new LlmError('Configure the DeepSeek credential in the host Models page', 'MISSING_CREDENTIAL');
      return { headers: { 'x-api-key': assertUsableApiKey(credential.value, name, current.apiKeyEnv) } };
    },
    discoverModels: async route => connection.models.map(model => catalogModelInfo(route, model)),
  });
}
