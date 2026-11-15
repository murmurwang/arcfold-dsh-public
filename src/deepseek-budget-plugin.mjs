import { isAbsolute } from 'node:path';
import { BudgetLedger } from './budget.mjs';
import { DeepSeekTransport } from './deepseek-transport.mjs';
import { getRuntimeGuard } from './runtime-guard.mjs';
import { nativeRequestIdentity, ownEvidenceDirectory, assertNativeRequestCurrent } from './native-request-authority.mjs';
export { nativeRequestIdentity } from './native-request-authority.mjs';

export const name = 'arcfold-deepseek-budget';
export const inject = ['arcfoldBusiness', 'arcfoldBridge', 'sessions', 'llm'];
export async function apply(ctx, config = {}) {
  if (!isAbsolute(config.ledgerPath || '') || !isAbsolute(config.artifactDirectory || ''))
    throw new Error('Explicit absolute paths to the existing ledger and this host evidence directory are required');
  if (config.provider !== 'deepseek-official') throw new Error('This profile has one explicitly metered DeepSeek route');
  if (!['limited', 'web-unlimited'].includes(config.scope) || !config.authorizationRef || !Number.isFinite(config.ceilingCny))
    throw new Error('An explicit existing budget authorization and host scope are required');
  const lease = await ownEvidenceDirectory(config.artifactDirectory);
  let ledger, transport;
  let closing;
  const close = () => closing ??= (async () => {
    try { await transport?.close(); }
    finally { try { ledger?.close(); } finally { await lease.close(); } }
  })();
  ctx.effect(() => close, 'close owned transport before the ledger and kernel lock');
  try {
    ledger = new BudgetLedger(config.ledgerPath, {
      ceilingCny: config.ceilingCny, authorizationRef: config.authorizationRef, scope: config.scope,
      webAuthorization: config.webAuthorization, create: false,
    });
    transport = new DeepSeekTransport({ ledger, artifactDirectory: config.artifactDirectory,
      provider: config.provider, modelPolicies: config.modelPolicies, endpoint: config.endpoint,
      allowLocalTestEndpoint: config.allowLocalTestEndpoint === true,
      timeoutMs: config.timeoutMs,
      requestIdentity: options => nativeRequestIdentity(ctx.arcfoldBusiness, ctx.sessions, options),
      beforeDispatch: options => {
        getRuntimeGuard(ctx)?.assertDispatch(options);
        return assertNativeRequestCurrent(ctx, options);
      },
    });
    // This lock excludes another process using these artifacts. The original
    // shared ledger may still be used by the independent web host.
    await transport.recover({ exclusive: true });
    ctx.on('llm/stream', (options, next) => {
      if (options.provider !== config.provider) return next();
      transport.validateInput(options); // before the host can degrade attachments
      return next();
    }, { prepend: true });
    const policies = structuredClone(transport.modelPolicies);
    for (const policy of Object.values(policies)) {
      Object.freeze(policy.prices); Object.freeze(policy.reasoningEfforts); Object.freeze(policy);
    }
    ctx.provide('arcfoldDeepSeekTransport', Object.freeze({
      summary: () => ledger.summary(),
      createTransport: options => transport.createTransport(options),
      configuration: Object.freeze({ provider: config.provider, endpoint: transport.endpoint,
        modelPolicies: Object.freeze(policies) }),
    }));
  } catch (error) { await close(); throw error; }
}
