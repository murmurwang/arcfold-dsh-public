import { protectedBashClass, protectedFileSystemClass } from './host-process.mjs';
import { ownedCompactionClass } from './host-context.mjs';

export const name = 'arcfold-tree-host';
export const inject = ['arcfoldTreeMode'];

// Preserve the actual legacy implementation when the flag is off. With the
// flag on, no ordinary file/process capability starts before its private fence.
export async function apply(ctx, config) {
  const { component, ...options } = config;
  const modules = { filesystem: '@deepseek-ai/dsh-fs-sandbox', shell: '@deepseek-ai/dsh-bash-sandbox', compaction: '@deepseek-ai/dsh-compaction-basic', goal: '@deepseek-ai/dsh-goal-round-driver' };
  if (!Object.hasOwn(modules, component)) throw new Error('Unknown tree host component');
  // The unchanged official entries wait for arcfoldLegacyMode. Do not install
  // a second copy under this wrapper when the feature is off.
  if (!ctx.arcfoldTreeMode.enabled) return;
  const Base = await import(modules[component]);
  if (component === 'goal') return; // v3 has only bounded same-turn hook steps.
  ctx.inject(['arcfoldTreeRuntime'], async owner => {
    const runtime = owner.arcfoldTreeRuntime;
    if (component === 'filesystem') {
      const { default: Local } = await import('@deepseek-ai/dsh-fs-local');
      const Protected = protectedFileSystemClass(Local, { readPolicy: policy => runtime.hostPolicy(policy),
        cordisUrl: import.meta.resolve('@deepseek-ai/cordis'), fileSystemUrl: import.meta.resolve('@deepseek-ai/dsh-fs-local') });
      await owner.plugin(Protected, options); return;
    }
    if (component === 'shell') { await owner.plugin(protectedBashClass(Base.default, policy => runtime.hostPolicy(policy)), options); return; }
    const { appendPluginRecord } = await import('@deepseek-ai/dsh-session');
    const Compactor = ownedCompactionClass(Base.default, { appendPluginRecord, summarize: (input, agent, signal) => runtime.summarizeNative(input, agent, signal) });
    // Auxiliary persistent learning uses its own 128K epoch replacement. Native
    // pressure must not rewrite it behind the owner's frozen input contract.
    class MainCompaction extends Compactor {
      compactIfNeeded(agent, ...args) { return runtime.mainAgents.has(agent.session.id) ? super.compactIfNeeded(agent, ...args) : Promise.resolve(null); }
      compactNow(agent, ...args) { if (!runtime.mainAgents.has(agent.session.id)) throw new Error('Only a main session supports native compaction'); return super.compactNow(agent, ...args); }
    }
    await owner.plugin(MainCompaction, options);
  });
}
