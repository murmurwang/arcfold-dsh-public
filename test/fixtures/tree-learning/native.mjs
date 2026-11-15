import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { nativeFixture, provider, model, budgetManifest } from '../tree-model/native.mjs';
import { NativeSources, ExperienceService } from '../../../src/tree/experience.mjs';
import { TreeService } from '../../../src/tree/tree.mjs';
import { ContextBuilder, mountTreeContext } from '../../../src/tree/context.mjs';
import { ConsolidationService } from '../../../src/tree/consolidation.mjs';
import { EpisodeSignals } from '../../../src/tree/signals.mjs';
import { ClusterService } from '../../../src/tree/clusters.mjs';
import { LearningService, WriterRouter } from '../../../src/tree/learning.mjs';
import { VerificationService } from '../../../src/tree/verification.mjs';
import { ScriptArtifacts } from '../../../src/tree/scripts.mjs';
import { FixtureWorkspaceIO } from '../tree-scripts/helpers.mjs';
import { digest } from '../../../src/tree/contracts.mjs';
import { emptyLearning, emptyVerification } from './helpers.mjs';

export async function nativeLearning(t) {
  let learningCalls = 0, writerCalls = 0;
  const usage = '输出合成检查结果，真实写入能力由 B4 单独实测。', generated = "console.log('fixture-only');\n";
  const f = await nativeFixture(t, ({ role, input }) => {
    if (role === 'main') return '合成答复：先核对原文，再说明结果。';
    if (role === 'verification') return emptyVerification();
    if (role === 'learning') {
      if (++learningCalls > 1) return emptyLearning();
      const sourceId = input.sources.find(s => s.role === 'user').id;
      return { ...emptyLearning(), correctionClaim: { kind: 'method', quote: { sourceId, text: '之前漏了核对，请给我一段可重复使用的合成核对脚本。' } }, methods: [{ kind: 'technique', short: { situation: '重复检查合成材料时', action: '使用核对脚本', basis: '本轮明确要求', notApplicable: '没有同类材料时' }, long: null, hooks: [], scriptRequests: [{ purpose: '提供可重复的核对', evidence: [sourceId], files: [] }], expectedEffect: { category: 'omitted', change: 'less', text: '减少遗漏核对' }, sourceIds: [sourceId] }] };
    }
    const calls = [
      { name: 'writer_put', args: { relativePath: 'check.mjs', content: generated } },
      { name: 'writer_probe', args: { entry: 'check.mjs', args: {} } },
      { name: 'writer_finish', args: { manifest: { entry: 'check.mjs', files: ['check.mjs'], argSchema: { type: 'object', properties: {}, required: [], additionalProperties: false }, dryRunSupport: true, usage }, verified: [], notVerified: ['本次 probe 是控制流替身，不是操作系统证据'] } },
    ];
    const call = calls[writerCalls++]; return call ? { tool: { ...call, id: 'writer-' + writerCalls } } : { files: [{ name: 'check.mjs', purpose: '合成检查' }], usage, stepsText: '输出检查标记', verified: [], notVerified: ['fixture-only probe'], problems: '' };
  });
  const logs = new Map(), sources = new NativeSources({ readSession: sessionId => ({ sessionId, durable: true, events: logs.get(sessionId) ?? [] }) }), resolveSource = ref => sources.resolve(ref);
  const context = { actor: { kind: 'program', id: 'native-fixture' } }, opts = { repository: f.repo, context: () => context, resolveSource, sources };
  const tree = new TreeService(opts), experience = new ExperienceService(opts), builder = new ContextBuilder(opts), consolidation = new ConsolidationService({ repository: f.repo, experience, contextBuilder: builder, jobs: f.jobs });
  f.jobs.assertSources = rows => rows.every(s => Boolean(resolveSource(s.ref)));
  const config = () => ({ provider, model, reasoningEffort: 'off', maxTokens: 2048, preset: 'tree-fixture', cwd: f.root, modelVersion: budgetManifest.modelVersion, priceVersion: f.ledger.manifestHash, budgetScope: budgetManifest.budgetScope, stage: 'smoke' });
  const workspace = join(f.root, 'workspace'), runtimeRoot = join(f.root, 'runtime'), privateRoot = join(f.root, 'private');
  for (const dir of [workspace, runtimeRoot, privateRoot]) mkdirSync(dir, { recursive: true });
  const artifacts = new ScriptArtifacts({ repository: f.repo, directory: privateRoot, resolveSource }), io = new FixtureWorkspaceIO({ workspace, runtimeRoot, protectedRoots: [privateRoot, f.repo.filename] });
  const runner = { enforcement: 'fixture-control-only', async run(options) { options.assertCurrent(); return { code: 0, stdout: 'probe control fixture', stderr: '', truncated: false, reason: null }; } };
  const writers = new WriterRouter({ repository: f.repo, jobs: f.jobs, modelConfig: config, artifacts, defineTool, createWriterOptions: () => ({ workspaceIO: io, runtimeRoot, protectedRoots: [privateRoot, f.repo.filename], runner, allowUnconfinedFixture: true }) });
  const signals = new EpisodeSignals({ repository: f.repo, resolveSource, experience }), clusters = new ClusterService({ repository: f.repo, signals });
  const learning = new LearningService({ repository: f.repo, experience, contextBuilder: builder, consolidation, jobs: f.jobs, modelConfig: config, signals, writerRouter: writers, outputProtocol: 'legacy-v3' });
  const verification = new VerificationService({ repository: f.repo, experience, contextBuilder: builder, jobs: f.jobs, modelConfig: config, clusters, writerRouter: writers });
  f.owner.mountWriterTools = (ctx, job) => writers.mount(ctx, job);
  f.owner.applyResult = (output, ctx) => ctx.job.role === 'learning' ? learning.applyResult(output, ctx) : ctx.job.role === 'script_writer' ? writers.applyResult(output, ctx) : ctx.job.role === 'verification' ? verification.applyResult(output, ctx) : {};
  async function main(sessionId, text) {
    let job, turn;
    const handle = await f.ctx.agents.create({ sessionId, agentOptions: { provider, model, reasoningEffort: 'off', maxTokens: 2048 }, setup: agentCtx => {
      f.owner.attachMain(agentCtx); mountTreeContext(agentCtx, { builder, sessionId, createUserMessage });
      agentCtx.on('agent/pre-step', async (payload, next) => {
        assert.equal(await f.ctx.sessions.flush(payload.agent.session), true); logs.set(sessionId, payload.agent.session.snapshotEvents());
        const claimed = sources.claimed(sessionId, payload.messages), refs = claimed.map(s => s.ref);
        const receipt = tree.applyAttribution({ requestId: digest(['native-attribution-fixture', sessionId]), expected: {}, input: { sessionId, nativeTurn: payload.turn, userSourceRefs: refs, sourceRefs: refs, actions: [{ action: 'continue', nodeId: f.repo.rootId() }], statusChanges: [] } });
        turn = f.repo.get('tree_turns', receipt.result.turnId); await builder.activate(sessionId, turn.id, { cancelPrevious: () => {} });
        job = f.jobs.enqueue({ role: 'main', key: turn.id, nodeIds: [f.repo.rootId()], revisionSet: {}, config: config(), trigger: { kind: 'user_turn', producerRole: 'user', origin: 'user', nativeSessionId: sessionId, nativeTurn: payload.turn },
          input: { scope: { nodeIds: [f.repo.rootId()], ancestorPaths: [[f.repo.rootId()]], treeRevision: f.repo.meta().treeRevision }, sources: claimed, knownItems: [], allowedIds: { nodeIds: [f.repo.rootId()], fileIds: [], subjectIds: [] }, changeReceipts: [] } });
        f.jobs.prepare(job.id); f.jobs.submit(job.id); return next();
      });
      agentCtx.on('llm/stream', (options, next) => { if (options.sessionId !== sessionId) return next(); const invocation = f.repo.list('tree_invocations', i => i.jobId === job.id).at(-1); if (invocation) builder.expose(sessionId, invocation.id, invocation.stepStartSeq, builder.capture(sessionId)); return next(); });
    } }); f.handles.push(handle);
    handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })); await handle.agent.whenIdle(); assert.equal(await f.ctx.sessions.flush(handle.agent.session), true);
    logs.set(sessionId, handle.agent.session.snapshotEvents()); const result = f.owner.consume(job.id, logs.get(sessionId));
    assert.equal(result.status, 'committed', JSON.stringify(result.error)); experience.settle(turn.id); return turn;
  }
  const first = await main('b5-main-one', '之前漏了核对，请给我一段可重复使用的合成核对脚本。');
  const firstLearning = await f.owner.run(learning.enqueue(first.id, f.repo.rootId()).id); assert.equal(firstLearning.status, 'committed', JSON.stringify(firstLearning.error));
  const methodId = firstLearning.resultRef.methods.itemIds[0], writerId = firstLearning.resultRef.writerJobs[0];
  assert.equal(writers.activateReady(methodId, 1).state, 'queued'); const writer = await f.owner.run(writerId); assert.equal(writer.status, 'committed', JSON.stringify(writer.error));
  assert.equal(writers.activateReady(methodId, 1).version, 2); assert.equal(writers.activateReady(methodId, 1).duplicate, true);
  const second = await main('b5-main-two', '继续核对；这是下一轮合成委托。');
  const secondLearning = await f.owner.run(learning.enqueue(second.id, f.repo.rootId()).id); assert.equal(secondLearning.status, 'committed', JSON.stringify(secondLearning.error));
  assert.equal(secondLearning.nativeSessionId, firstLearning.nativeSessionId); assert.ok(f.requests.filter(r => r.role === 'learning').at(-1).input.previousReceipt.methods.itemIds.includes(methodId));
  const review = await f.owner.run(verification.enqueue(f.repo.rootId()).id); assert.equal(review.status, 'committed', JSON.stringify(review.error));
  assert.equal(f.repo.list('tree_exposures').length, 2);
  assert.ok(review.input.effects.some(e => e.turnId === second.id && e.itemVersions.some(v => v.itemId === methodId && v.version === 2)));
  assert.deepEqual(new Set(f.requests.find(r => r.role === 'script_writer').body.tools.map(t => t.name)), new Set(['writer_read', 'writer_list', 'writer_search', 'writer_put', 'writer_probe', 'writer_finish']));
  assert.ok(f.requests.filter(r => r.role === 'learning' || r.role === 'verification').every(r => !r.body.tools?.length));
  assert.equal(f.repo.list('tree_script_runs').length, 0, 'Creation and activation never execute a script');
  writeFileSync(join(f.root, 'B5-native.json'), JSON.stringify({ kind: 'actual-native-main-learning-writer-verification-with-synthetic-model-responses-and-fixture-only-probe', first, second, firstLearning, secondLearning, writer, review, exposures: f.repo.list('tree_exposures'), signals: f.repo.list('tree_signals'), realModel: { requests: 0, spentCny: 0, reservedCny: 0, unknownCny: 0 } }, null, 2));
  return f;
}
