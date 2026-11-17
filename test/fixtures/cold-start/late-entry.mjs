// Frozen 0.5.1 entry: negative control for the startup regression.
import { OpportunityService } from './opportunities.mjs';
import { ImportService } from './importer.mjs';
import { BusinessStore } from './business.mjs';
import { SessionBridge } from './session-bridge.mjs';
import { MethodService } from './methods.mjs';
import { GoalService } from './goals.mjs';
import { UnderstandingService } from './understandings.mjs';
import { GoalExecution } from './goal-execution.mjs';

export const name = 'arcfold-business';
export const inject = ['sessions', 'sessionPersistence', 'llm'];
export async function apply(ctx, config = {}) {
  if (config.goalTreeV3?.enabled !== undefined && typeof config.goalTreeV3.enabled !== 'boolean') throw new Error('goalTreeV3.enabled must be an explicit boolean');
  const desktopSetup = ctx.get('arcfoldDesktopSetup'), desktop = desktopSetup?.status();
  if (desktop?.modelRouting === 'dsh-native-v1' && !desktopSetup.authorizes?.(config.goalTreeV3)) {
    // A saved 0.4.x runtime must not start its old provider while Desktop is
    // awaiting consent to native routing. Setup remains visible and no task runs.
    ctx.provide('arcfoldTreeMode', Object.freeze({ enabled: false }));
    return;
  }
  ctx.provide('arcfoldTreeMode', Object.freeze({ enabled: config.goalTreeV3?.enabled === true }));
  if (config.goalTreeV3?.enabled === true) {
    const { installTreeRuntime } = await import('./tree/runtime.mjs');
    await installTreeRuntime(ctx, config.goalTreeV3, { legacyFilename: config.filename });
    return;
  }
  const desktopState = desktop?.state;
  if (!config.filename && ['needs_setup', 'configured', 'activation_failed', 'interrupted', 'unavailable'].includes(desktopState)) {
    ctx.provide('arcfoldLegacyMode', Object.freeze({ enabled: true }));
    return;
  }
  // The native Loader adds this dependency to the original execution entries.
  // Dependency activation is reactive; disabled expressions are not.
  ctx.provide('arcfoldLegacyMode', Object.freeze({ enabled: true }));
  if (config.goalTreeV3?.enabled !== undefined && config.goalTreeV3.enabled !== false) throw new Error('goalTreeV3.enabled must be an explicit boolean');
  if (typeof config.filename !== 'string' || !config.filename) throw new Error('An explicit Arcfold business database path is required');
  const business = new BusinessStore({ filename: config.filename });
  const opportunities = new OpportunityService({ business });
  const imports = new ImportService({ business });
  const methods = new MethodService({ business });
  const goals = new GoalService({ business });
  const understandings = new UnderstandingService({ business, goals });
  const bridge = new SessionBridge({ business, methods, goals, understandings, sessions: ctx.sessions, persistence: ctx.sessionPersistence,
    logger: ctx.logger, maxContextCharacters: config.maxContextCharacters ?? 24000 });
  const work = new GoalExecution({ business });
  bridge.work = work;
  goals.execution = work;
  ctx.effect(() => async () => { await imports.close(); await bridge.close(); }, 'close Arcfold business storage after reconciliation');
  ctx.on('session/event', (session, event) => bridge.observe(session, event));
  ctx.on('llm/stream', (options, next) => bridge.guardStream(options, next));
  await bridge.recover();
  ctx.provide('arcfoldBusiness', business);
  ctx.provide('arcfoldOpportunities', opportunities);
  ctx.provide('arcfoldImports', imports);
  ctx.provide('arcfoldBridge', bridge);
  ctx.provide('arcfoldMethods', methods);
  ctx.provide('arcfoldGoals', goals);
  ctx.provide('arcfoldWork', work);
  ctx.provide('arcfoldUnderstandings', understandings);
}
