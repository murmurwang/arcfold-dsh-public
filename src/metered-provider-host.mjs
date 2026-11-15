import { openOwnedWebBudget } from './web-budget-recovery.mjs';
import { isAbsolute } from 'node:path';
import { Agent, ProxyAgent } from 'undici';
import { getRuntimeGuard } from './runtime-guard.mjs';
import { BudgetLedger } from './budget.mjs';
import { OpenAIUsageLedger } from './openai-usage.mjs';
import { DeepSeekTransport } from './deepseek-transport.mjs';
import { OpenAITransport, OPENAI_EVIDENCE_VERSION } from './openai-transport.mjs';
import { nativeRequestIdentity, ownEvidenceDirectory, assertNativeRequestCurrent } from './native-request-authority.mjs';

function frozen(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); }
  return value;
}
function dispatcherFor(network) {
  if (network?.mode === 'direct' && Object.keys(network).length === 1) return new Agent();
  if (network?.mode === 'proxy' && Object.keys(network).length === 2 && typeof network.url === 'string') {
    const proxy = new URL(network.url);
    if (['http:', 'https:'].includes(proxy.protocol) && !proxy.username && !proxy.password &&
        proxy.pathname === '/' && !proxy.search && !proxy.hash)
      return new ProxyAgent({ uri: proxy.href });
  }
  throw new Error('An explicit fixed direct or HTTP CONNECT proxy route is required');
}
export const name = 'arcfold-metered-provider-host';
export const inject = ['arcfoldBusiness', 'arcfoldBridge', 'sessions', 'llm'];
export async function apply(ctx, config = {}) {
  if (!isAbsolute(config.artifactDirectory || '') || !config.routes ||
      !Object.keys(config.routes).length || Object.keys(config.routes).some(p => !['openai','deepseek-official'].includes(p)))
    throw new Error('An absolute evidence root and fixed owned provider routes are required');
  const routes = frozen(structuredClone(config.routes));
  const lease = await ownEvidenceDirectory(config.artifactDirectory);
  const ledgers = [], transports = new Map();
  const lifecycle = { stopping: new AbortController(), inflight: new Map(),
    evidenceVersions: new Set(Object.keys(routes).map(p => p === 'openai' ? OPENAI_EVIDENCE_VERSION : 'arcfold-messages-transport-v1')) };
  let closing;
  const close = () => closing ??= (async () => {
    try { const outcomes = await Promise.allSettled([...transports.values()].map(t => t.close()));
      if (outcomes.some(outcome => outcome.status === 'rejected')) throw new Error('Owned transport cleanup failed'); }
    finally { try { for (const ledger of ledgers) ledger.close(); } finally { await lease.close(); } }
  })();
  ctx.effect(() => close, 'drain shared sends before closing ledgers and the evidence lock');
  try {
    for (const [provider, route] of Object.entries(routes)) {
      if (!isAbsolute(route.ledgerPath || '') || route.kind !== (provider === 'openai' ? 'openai' : 'deepseek') || provider === 'openai' && route.scope !== 'web-openai')
        throw new Error('Each owned route requires its explicitly selected existing ledger');
      if (route.mode !== undefined && (provider !== 'deepseek-official' || route.mode !== 'web-only' ||
          route.scope !== 'web-unlimited' || Object.hasOwn(route, 'ceilingCny') || Object.hasOwn(route, 'authorizationRef')))
        throw new Error('Web-only requires independent explicit web scope without a finite allowance');
      const ledger = route.mode === 'web-only'
        ? openOwnedWebBudget({ artifactDirectory: config.artifactDirectory, ledgerPath: route.ledgerPath,
          webAuthorization: route.webAuthorization, owner: lease }).ledger
        : provider === 'openai'
        ? new OpenAIUsageLedger(route.ledgerPath, { scope: 'web-openai', webAuthorization: route.webAuthorization, create: false })
        : new BudgetLedger(route.ledgerPath, { scope: route.scope, ceilingCny: route.ceilingCny,
          authorizationRef: route.authorizationRef, webAuthorization: route.webAuthorization, create: false });
      ledgers.push(ledger);
      const dispatcher = dispatcherFor(route.network);
      let transport;
      try {
        transport = new (provider === 'openai' ? OpenAITransport : DeepSeekTransport)({
          ledger, artifactDirectory: config.artifactDirectory, provider, modelPolicies: route.modelPolicies,
          endpoint: route.endpoint, allowLocalTestEndpoint: route.allowLocalTestEndpoint === true,
          timeoutMs: route.timeoutMs, dispatcher, ownsDispatcher: true, lifecycle,
          requestIdentity: options => nativeRequestIdentity(ctx.arcfoldBusiness, ctx.sessions, options),
          beforeDispatch: options => {
            getRuntimeGuard(ctx)?.assertDispatch(options);
            return assertNativeRequestCurrent(ctx, options);
          },
        });
      } catch (error) { await dispatcher.close(); throw error; }
      transports.set(provider, transport);
    }
    for (const transport of transports.values()) await transport.recover({ exclusive: true });
    ctx.on('llm/stream', (options, next) => {
      const transport = transports.get(options.provider);
      if (transport) transport.validateInput(options);
      return next();
    }, { prepend: true });
    const configurations = frozen(Object.fromEntries([...transports].map(([provider, transport]) => [provider, {
      provider, endpoint: transport.endpoint, modelPolicies: structuredClone(transport.modelPolicies),
      network: structuredClone(routes[provider].network),
    }])));
    const service = Object.freeze({
      configuration: Object.freeze({ routes: configurations, evidenceDirectory: config.artifactDirectory }),
      summary(provider) {
        const ledger = transports.get(provider)?.ledger;
        return ledger ? (provider === 'openai' ? ledger.scopeSummary() : ledger.summary()) : null;
      },
      createTransport(options) {
        const transport = transports.get(options.provider);
        if (!transport) throw new Error('This route has no mandatory owned transport');
        return transport.createTransport(options);
      },
    });
    ctx.provide('arcfoldMeteredTransport', service);
    if (transports.has('deepseek-official')) ctx.provide('arcfoldDeepSeekTransport', Object.freeze({
      configuration: configurations['deepseek-official'], createTransport: options => service.createTransport(options),
    }));
  } catch (error) { await close(); throw error; }
}
