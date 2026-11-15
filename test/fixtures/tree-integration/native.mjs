import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { nativeFixture, provider, model, budgetManifest } from '../tree-model/native.mjs';
import { ScriptArtifacts } from '../../../src/tree/scripts.mjs';
import { SnapshotService } from '../../../src/tree/snapshots.mjs';
import { FixtureWorkspaceIO } from '../tree-scripts/helpers.mjs';
import { TreeRuntime } from '../../../src/tree/runtime.mjs';
import { TreeTokenCounter } from '../../../src/tree/token-counter.mjs';

export async function integratedFixture(t, script, options = {}) {
  const f = await nativeFixture(t, script, options), privateRoot = join(f.root, 'tree-private'), runtimeRoot = join(f.root, 'processes');
  mkdirSync(privateRoot, { recursive: true }); mkdirSync(runtimeRoot, { recursive: true });
  let runtime;
  const resolveSource = ref => runtime.resolveSource(ref);
  const artifacts = new ScriptArtifacts({ repository: f.repo, directory: join(privateRoot, 'artifacts'), resolveSource });
  const io = new FixtureWorkspaceIO({ workspace: f.root, runtimeRoot, protectedRoots: [privateRoot, ...[f.repo.filename, join(f.root, 'test-ledger.sqlite')].flatMap(path => [path, path + '-wal', path + '-shm']), join(f.root, 'sessions'), join(f.root, 'requests')] });
  const snapshots = new SnapshotService({ repository: f.repo, workspace: f.root, storageRoot: join(privateRoot, 'snapshots'), runtimeRoot, protectedRoots: io.protectedRoots,
    context: () => ({ actor: { kind: 'user', id: f.repo.userId }, sessionPolicy: { mode: 'workspace-write', workspaceRoot: f.root } }), io, allowUnconfinedFixture: true });
  const resources = { snapshots, cancelSession() {} };
  const tokenCounter = new TreeTokenCounter({ python: process.env.ARCFOLD_TREE_ENCODING_PYTHON, moduleDirectory: join(privateRoot, 'tokenizer-dependency') });
  const config = (role, agent) => ({ provider, model, reasoningEffort: 'off', maxTokens: role === 'main' ? agent.options.maxTokens : 2048,
    preset: 'tree-fixture', cwd: f.root, modelVersion: budgetManifest.modelVersion, priceVersion: f.ledger.manifestHash, budgetScope: budgetManifest.budgetScope, stage: 'smoke' });
  runtime = new TreeRuntime({ repository: f.repo, host: f.ctx, createUserMessage, defineTool, modelConfig: config, jobs: f.jobs, owner: f.owner,
    artifacts, tokenCounter, resourcesFor: () => resources, createWriterOptions: () => ({ workspaceIO: io, runtimeRoot, protectedRoots: [privateRoot], allowUnconfinedFixture: true,
      runner: { enforcement: 'fixture-control-only', run: async () => ({ code: 0, stdout: 'fixture probe', stderr: '', truncated: false }) } }) });
  runtime.learning.outputProtocol = options.learningProtocol ?? 'legacy-v3';
  for (const [object, name] of [[f.owner, 'assertProjection'], [f.ledger, 'markDispatched']]) {
    const original = object[name].bind(object);
    object[name] = (...args) => { try { return original(...args); } catch (error) { runtime.diagnostic('native_admission', error, { gate: name }); throw error; } };
  }
  f.ctx.on('session/event', (session, event) => runtime.observe(session, event));
  t.after(() => runtime.close());
  async function main(id, setup = async () => {}, resume = false) {
    const handle = await (resume ? f.ctx.agents.resume.bind(f.ctx.agents) : f.ctx.agents.create.bind(f.ctx.agents))({ ...(resume ? { resumeSessionId: id } : { sessionId: id }), meta: { cwd: f.root, agentPreset: 'tree-fixture' }, agentOptions: { provider, model, reasoningEffort: 'off', maxTokens: 2048 },
      setup: async (ctx, agent) => { runtime.mountMain(ctx, agent); await setup(ctx, agent); } }); f.handles.push(handle); return handle.agent;
  }
  async function turn(agent, text) { agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })); await agent.whenIdle(); await runtime.idle(); return runtime.repo.list('tree_turns', t => t.sessionId === agent.session.id).at(-1); }
  const shutdown = async () => { await runtime.close(); await f.shutdown(); };
  return { ...f, runtime, main, turn, resources, shutdown };
}
