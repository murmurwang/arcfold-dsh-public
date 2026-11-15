import { LearningService } from './learning.mjs';
import { LearningRunner } from './learning-runner.mjs';
import { LearningDefaults, deploymentSelectionValidator } from './learning-defaults.mjs';

export const name = 'arcfold-learning';
export const inject = ['arcfoldBusiness', 'arcfoldBridge', 'agents', 'agentPresets', 'sessions', 'sessionPersistence', 'workingDirectory', 'llm'];
export async function apply(ctx, config = {}) {
  const learning = new LearningService({ business: ctx.arcfoldBusiness, maxCharacters: config.maxCharacters ?? 180000 });
  const deployment = { ...config, cwd: config.cwd ?? ctx.workingDirectory.defaultDirectory };
  const defaults = new LearningDefaults({ business: ctx.arcfoldBusiness, deployment,
    assertSelection: ctx.get('arcfoldRuntimeModels')?.assertLearningSelection ?? deploymentSelectionValidator(deployment) });
  const runner = new LearningRunner({ business: ctx.arcfoldBusiness, learning, host: ctx, config, defaults, onSettled: pendingId => ctx.emit('arcfold/opportunities-committed', pendingId), logger: ctx.logger });
  ctx.effect(() => () => runner.close(), 'stop auxiliary learning before its business storage');
  ctx.on('llm/stream', (options, next) => runner.guardStream(options, next));
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end' || !ctx.arcfoldBridge.isBound(session.id)) return;
    // Bridge observation schedules reconciliation synchronously. Await only that
    // durable business commit, never a main-turn hook or another main Agent.
    void Promise.resolve().then(async () => {
      await ctx.arcfoldBridge.pending.get(session.id);
      if (!runner.closed) await runner.kick();
    }).catch(error => ctx.logger.error?.(error));
  });
  ctx.provide('arcfoldLearningDefaults', defaults);
  ctx.provide('arcfoldLearning', runner);
  await runner.recover();
  void runner.kick().catch(error => ctx.logger.error?.(error));
}
