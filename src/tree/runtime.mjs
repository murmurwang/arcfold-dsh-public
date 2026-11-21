import { canonicalJson, digest, fail } from './contracts.mjs';
import { mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUserMessage, HarnessError } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { TreeRepository } from './repository.mjs';
import { TreeTestLedger, TREE_TEST_SCOPE } from './experiment-budget.mjs';
import { BudgetLedger } from '../budget.mjs';
import { openOwnedWebBudget } from '../web-budget-recovery.mjs';
import { DeepSeekTransport } from '../deepseek-transport.mjs';
import { registerTreeRequestAuthority, ownEvidenceDirectory } from '../native-request-authority.mjs';
import { ScriptArtifacts, MethodScriptBroker } from './scripts.mjs';
import { SnapshotService, ConfinedWorkspaceIO } from './snapshots.mjs';
import { canonicalPath, processPolicy, beneath } from './host-process.mjs';
import { TreeJobs, deferredLearning } from './jobs.mjs';
import { TreeModelOwner } from './model-owner.mjs';
import { NativeSources, ExperienceService } from './experience.mjs';
import { ContextBuilder, mountTreeContext } from './context.mjs';
import { AttributionService } from './attribution.mjs';
import { TreeService } from './tree.mjs';
import { ConsolidationService } from './consolidation.mjs';
import { LearningService, WriterRouter, itemInput } from './learning.mjs';
import { VerificationService, ConsolidationReflection } from './verification.mjs';
import { EpisodeSignals, evidenceResolver } from './signals.mjs';
import { ClusterService } from './clusters.mjs';
import { ImprovementService } from './improvement.mjs';
import { MetricsService, ReflectionTriggers } from './metrics.mjs';
import { LocalReports } from './reports.mjs';
import { HookService, mountHookContext } from './hooks.mjs';
import { TreeUIService, bindTurnSnapshot } from './ui.mjs';
import { mountTreeTools, nativeTreeCall } from './tools.mjs';
import { TreeTokenCounter } from './token-counter.mjs';
import { bindNativeTurnSelection, captureNativeSelection, nativeModel, nativeModelConfig, NativeInputEstimate } from './native-models.mjs';
import { NativeModelRecords } from './native-model-records.mjs';
import { StartupTiming, untimed } from '../startup-timing.mjs';

const program = { kind: 'program', id: 'tree-runtime' };
const done = new Set(['committed', 'failed', 'invalid_output', 'stale', 'cancelled']);
const busy = new Set(['NODE_BUSY', 'NODE_ORDER', 'LEARNING_UNKNOWN', 'LEARNING_PAUSED', 'WORKER_BUSY', 'WRITER_BUSY']);

// Keep preparation and the last synchronous dispatch check in one admission
// interval. Requests already on the wire may overlap; no paid request is retried.
class AdmissionQueue {
  constructor(limit) { this.limit = limit; this.active = 0; this.waiters = []; }
  acquire(signal) {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const entry = { grant: () => {
        signal?.removeEventListener('abort', abort); this.active++;
        let released = false;
        resolve(() => { if (released) return; released = true; this.active--; this.drain(); });
      } };
      const abort = () => { this.waiters = this.waiters.filter(v => v !== entry); reject(signal.reason); };
      signal?.addEventListener('abort', abort, { once: true }); this.waiters.push(entry); this.drain();
    });
  }
  drain() { while (this.active < this.limit && this.waiters.length) this.waiters.shift().grant(); }
}

class RuntimeContextBuilder extends ContextBuilder {
  capture(sessionId, role = 'main') {
    const { key: _key, ...value } = super.capture(sessionId, role);
    const branchId = this.repo.meta().attributionSelections?.[sessionId]?.nodeId;
    if (branchId) {
      const ids = new Set(this.repo.list('tree_nodes', n => !n.deleted && this.repo.ancestors(n.id).some(a => a.id === branchId)).map(n => n.id));
      value.segments = value.segments.map(segment => {
        if (segment.key !== 'global-overview') return segment;
        const overview = JSON.parse(segment.text).globalOverview.filter(n => ids.has(n.id));
        return { ...segment, text: canonicalJson({ globalOverview: overview, selectedBranchId: branchId }), version: digest([branchId, overview]),
          sourceRefs: overview.flatMap(n => this.summary(this.repo.get('tree_nodes', n.id))?.sourceRefs ?? []), summaryVersions: segment.summaryVersions.filter(s => ids.has(s.nodeId)) };
      });
    }
    if (role === 'main') {
      const turn = this.repo.get('tree_turns', value.turnId), sources = turn.userSourceRefs.map(this.resolveSource);
      const authority = { logicalTurnId: turn.id, assignmentRevision: turn.assignmentRevision,
        // Name and root path of each current goal, so main sees every turn what
        // the turn is filed under and can revise it, including on an ancestor.
        nodes: turn.nodeIds.map(id => { const node = this.repo.get('tree_nodes', id); return { id, name: node.name, expectedRevision: node.revision,
          path: this.repo.ancestors(id).map(n => ({ id: n.id, name: n.name, expectedRevision: n.revision })) }; }),
        evidence: sources.filter(Boolean).map(s => ({ id: s.id, messageId: s.ref.messageId })), fileRefs: [],
        instruction: '工具参数的节点版本和证据编号必须逐字使用本段当前值；此编号表不增加执行授权。nodes是本轮当前目标，path从根到当前目标。回答前对照：要做成的结果已经不是它，就用arcfold_revise_goal修改，同一结果下换步骤不算；要在path上某一层下面新建，create_child的nodeId填那一层；它其实属于全局概貌里另一个目标，用move挪过去。' };
      value.segments = [...value.segments, { key: `turn-authority:${turn.id}`, nodeId: null, version: digest(authority), text: canonicalJson(authority), sourceRefs: turn.userSourceRefs, itemVersions: [], summaryVersions: [] }];
      value.renderedHash = digest(value.segments); value.bytes = Buffer.byteLength(value.segments.map(s => s.text).join('\n'));
    }
    return { ...value, key: digest(value) };
  }
}

/** Composition around DSH's existing loop. This scheduler runs owned jobs only;
 * it never follows up a main Agent or invents another human turn. */
export class TreeRuntime {
  constructor({ repository, host, createUserMessage, defineTool, modelConfig, ledgerLookup, resourcesFor, artifacts, createWriterOptions,
    jobs, owner, inputTokenCount, tokenCounter, annotations, browserScope, snapshotsFor, followConversationModel = false, nativeModels = false }) {
    Object.assign(this, { repo: repository, host, createUserMessage, defineTool, modelConfig, resourcesFor });
    this.logs = new Map(); this.mainAgents = new Map(); this.settlements = new Map(); this.workers = new Map(); this.closed = false;
    this.admissions = new AdmissionQueue(1); this.requestSlots = new AdmissionQueue(2); this.mainAdmissions = new Map(); this.shutdown = new AbortController();
    this.enabled = true;
    this.nativeModels = nativeModels;
    this.sources = new NativeSources({ readSession: id => ({ sessionId: id, durable: this.logs.has(id), events: this.logs.get(id) }) });
    this.resolveSource = evidenceResolver(repository, ref => this.sources.resolve(ref));
    const options = { repository, resolveSource: this.resolveSource, sources: this.sources, context: () => ({ actor: program }) };
    this.experience = new ExperienceService(options); this.builder = new RuntimeContextBuilder(options);
    this.jobs = jobs ?? new TreeJobs({ repository, assertSources: rows => rows.every(s => Boolean(this.resolveSource(s.ref))) });
    this.jobs.assertSources = rows => rows.every(s => Boolean(this.resolveSource(s.ref)));
    this.owner = owner ?? new TreeModelOwner({ jobs: this.jobs, host, createUserMessage, ledgerLookup, inputTokenCount });
    this.tokenCounter = tokenCounter;
    if (tokenCounter) {
      this.owner.prepareInput = options => tokenCounter.prepare(options);
      if (tokenCounter.count) this.owner.inputTokenCount = options => tokenCounter.count(options);
    }
    this.owner.verifyMainInput = (job, request) => this.verifyMainInput(job, request);
    this.owner.applyResult = (result, context) => this.applyResult(result, context);
    this.owner.beforeSubmit = (job, agent) => this.beforeSubmit(job, agent);
    // Attribution is already enclosed in the main admission interval. Other
    // roles may overlap on the wire, but commit only between main admissions.
    this.owner.beforeResult = job => job.role === 'attribution' ? undefined : this.admissions.acquire(this.shutdown.signal);
    this.consolidation = new ConsolidationService({ repository, experience: this.experience, contextBuilder: this.builder, jobs: this.jobs });
    // Bind background work to the originating durable job rather than to a
    // mutable global selection shared by several conversations.
    const sourceForBackground = (origin = {}) => {
      if (!followConversationModel) return null;
      let parent = origin.parentJobId && this.repo.get('tree_jobs', origin.parentJobId);
      if (origin.parentJobId && !parent) fail('MODEL_SOURCE_MISSING', 'The originating background model job is unavailable');
      if (!parent && origin.turnId) {
        parent = this.repo.list('tree_jobs', j => j.role === 'main' && j.trigger?.turnId === origin.turnId)[0];
        if (!parent) fail('MODEL_SOURCE_MISSING', 'The originating conversation model job is unavailable');
      }
      if (!parent && origin.nodeIds?.length) parent = this.repo.list('tree_jobs', j => j.role === 'main' && j.status === 'committed' && j.nodeIds.some(id => origin.nodeIds.includes(id)))
        .sort((a, b) => (b.enqueuedOrder ?? 0) - (a.enqueuedOrder ?? 0) || b.id.localeCompare(a.id))[0];
      return parent ?? null;
    };
    this.backgroundModelConfig = (role, origin = {}) => {
      if (!followConversationModel) return modelConfig(role);
      if (origin.agent) return modelConfig(role, origin.agent, origin.selection ?? origin.agent.model?.current?.() ?? origin.agent.model);
      return modelConfig(role, undefined, sourceForBackground(origin)?.modelConfig);
    };
    this.backgroundModelConfig.source = sourceForBackground;
    this.writers = new WriterRouter({ repository, jobs: this.jobs, modelConfig: this.backgroundModelConfig, artifacts, createWriterOptions, defineTool });
    this.owner.mountWriterTools = (ctx, job) => this.writers.mount(ctx, job);
    this.signals = new EpisodeSignals({ repository, resolveSource: this.resolveSource, experience: this.experience });
    this.clusters = new ClusterService({ repository, signals: this.signals });
    const common = { repository, jobs: this.jobs, modelConfig: this.backgroundModelConfig, experience: this.experience, contextBuilder: this.builder, writerRouter: this.writers };
    this.learning = new LearningService({ ...common, consolidation: this.consolidation, signals: this.signals, annotations });
    this.verification = new VerificationService({ ...common, clusters: this.clusters });
    this.reflection = new ConsolidationReflection({ repository, consolidation: this.consolidation, resolveSource: this.resolveSource, writerRouter: this.writers });
    this.reports = new LocalReports({ repository, resolveSource: this.resolveSource });
    this.improvement = new ImprovementService({ ...common, reports: this.reports });
    this.metrics = new MetricsService({ repository, experience: this.experience, signals: this.signals });
    this.triggers = new ReflectionTriggers({ repository, metrics: this.metrics, clusters: this.clusters, verification: this.verification });
    this.attribution = new AttributionService({ repository, sources: this.sources, contextBuilder: this.builder, jobs: this.jobs, modelOwner: this.owner,
      modelConfig: (agent, selection) => this.backgroundModelConfig('attribution', { agent, selection }), cancelJob: id => this.owner.handles.get(id)?.agent.cancel({ kind: 'user', message: 'Attribution cancelled' }, { keepInbox: false }) });
    this.ui = new TreeUIService({ repository, resolveSource: this.resolveSource, metrics: this.metrics, reports: this.reports,
      attribution: this.attribution, selectBranch: (payload, context, requestId) => this.selectBranch(payload, context, requestId),
      snapshotsFor: snapshotsFor ?? (context => {
        const session = this.host.sessions.get(context.sessionId);
        if (!session) fail('SNAPSHOT_UNAVAILABLE', 'Open the originating session before restoring its workspace');
        return this.resourcesFor(this.host.workingDirectory.get(session), context).snapshots;
      }), browserScope: browserScope ?? (context => {
        const known = this.mainAgents.has(context.sessionId) || this.repo.list('tree_turns', t => t.sessionId === context.sessionId).length;
        return known ? { nodeIds: this.repo.list('tree_nodes', n => !n.deleted).map(n => n.id) } : null;
      }) });
  }
  diagnostic(kind, error, extra = {}) {
    const value = { kind, code: error.code ?? 'HOST_ERROR', message: error.message, ...extra };
    this.repo.command('recordTreeRuntimeDiagnostic', { requestId: digest(['runtime-diagnostic', value]), expected: {}, input: value }, program, () => {
      const meta = this.repo.meta(); this.repo.save('tree_meta', { ...meta, runtimeDiagnostics: { ...meta.runtimeDiagnostics, [digest(value)]: { ...value, at: this.repo.now() } } }, meta.revision); return value;
    });
  }
  async freezeSession(session) {
    const before = session.snapshotEvents();
    if (await this.host.sessions.flush(session) !== true) fail('NATIVE_NOT_DURABLE', 'Native originals must be flushed before tree processing');
    const reader = await this.host.sessionPersistence.open(session.id, 'read');
    try {
      const packet = await reader.read(), events = packet.events;
      if (digest(events.slice(0, before.length)) !== digest(before)) fail('NATIVE_NOT_DURABLE', 'Native durable prefix disagrees with observation');
      this.logs.set(session.id, events); return events;
    } finally { await reader.close(); }
  }
  async recover(timing = untimed) {
    // Read historical sources before checking a received job. No Agent is resumed.
    await timing.step('recover-read-sessions', async () => {
      const ids = new Set(this.repo.list('tree_turns').map(t => t.sessionId));
      for (const id of ids) {
        const live = this.host.sessions.get(id);
        if (live) await this.freezeSession(live);
        else { let reader; try { reader = await this.host.sessionPersistence.open(id, 'read'); this.logs.set(id, (await reader.read()).events); }
          catch (error) { if (error.name !== 'SessionPersistenceNotFoundError') throw error; this.logs.set(id, []); this.diagnostic('source_missing', error, { sessionId: id }); }
          finally { await reader?.close(); } }
      }
    });
    const recovered = await timing.step('recover-model-owner', () => this.owner.recover());
    timing.step('recover-cancel-prepared', () => {
      for (const job of this.repo.list('tree_jobs', j => j.role === 'main' && j.status === 'prepared')) {
        // Native human sessions are never automatically resumed by this worker.
        // A prepared main has not crossed submit and cannot own a paid request.
        if (this.host.sessions.get(job.nativeSessionId)) continue;
        if (job.invocationIds.length) fail('JOB_CORRUPT', 'Prepared main unexpectedly owns an invocation');
        this.jobs.transition(job.id, 'cancelled', { error: { code: 'UNSENT_RESTART', message: 'Host restarted before main submission; original input retained, no automatic replay' } });
      }
    });
    timing.step('recover-settle-turns', () => {
      for (const turn of this.repo.list('tree_turns', t => !['settled', 'interrupted', 'failed'].includes(t.status))) {
        try { this.settleTurn(turn.id, { recovery: true }); } catch (error) { this.diagnostic('experience_recovery', error, { turnId: turn.id }); }
      }
    });
    timing.step('recover-learning-pressure', () => { for (const job of this.repo.list('tree_jobs', j => j.role === 'learning' && j.status === 'failed')) this.handlePressure(job); });
    timing.step('recover-replay-committed', () => { for (const job of this.repo.list('tree_jobs', j => j.role && j.status === 'committed')) this.afterCommit(job); });
    timing.step('recover-kick', () => this.kick()); return recovered;
  }
  applyResult(result, context) {
    const { job } = context;
    if (job.role === 'main') return { logicalTurnId: job.trigger.turnId, nativeTurn: job.trigger.nativeTurn };
    if (job.role === 'consolidation' && job.trigger.nativeCompaction) {
      if (result.broaden.length || result.retrospect.understandings.length || result.retrospect.methods.length) fail('COMPACTION_OUTPUT', 'Native compaction cannot modify tree learning');
      return { nativeCompaction: job.input.nativeCompaction.inputHash, summary: result.summary };
    }
    if (job.role === 'attribution') {
      const before = this.repo.list('tree_nodes'), receipt = this.attribution.applyResult(result, context);
      this.metrics.observeTree(receipt, before, { logicalTurnId: receipt.result.turnId }); return receipt;
    }
    const services = { learning: this.learning, consolidation: this.reflection, verification: this.verification, improvement: this.improvement, script_writer: this.writers };
    return services[job.role].applyResult(result, context);
  }
  mainJob(sessionId, nativeTurn) { return this.repo.list('tree_jobs', j => j.role === 'main' && j.trigger.nativeSessionId === sessionId && j.trigger.nativeTurn === nativeTurn)[0]; }
  verifyMainInput(job, request) {
    const agent = this.mainAgents.get(request.sessionId), scope = this.builder.scope(request.sessionId), turn = this.repo.get('tree_turns', job.trigger.turnId);
    if (!agent || job.role !== 'main' || scope?.phase !== 'active' || scope.turnId !== turn?.id || turn.assignmentRevision !== job.input.assignmentRevision) return false;
    if (!job.input.sources.every(source => request.messages.some(m => m.source?.kind === 'user' && m.id === source.ref.messageId && canonicalJson(m.content) === canonicalJson(source.content)))) return false;
    const mounted = this.builder.mounted.get(request.sessionId), snapshot = this.builder.capture(request.sessionId);
    return mounted?.snapshotKey === snapshot.key && canonicalJson(request.messages.filter(m => m.source?.kind === 'arcfold/tree-context')) === canonicalJson(mounted.messages);
  }
  hooks(sessionId) {
    const agent = this.mainAgents.get(sessionId); if (!agent) fail('MAIN_REQUIRED', 'Only an attached native main session has hook authority');
    return new HookService({ repository: this.repo, readScope: id => this.builder.scope(id), resolveSource: this.resolveSource, workspace: this.host.workingDirectory.get(agent.session) });
  }
  async prepare(payload, decision) {
    if (decision.kind === 'reject' || !decision.messages.length) return decision;
    const { agent, turn: nativeTurn, signal } = payload, sessionId = agent.session.id;
    signal.throwIfAborted(); await this.settlements.get(sessionId);
    const combined = AbortSignal.any([signal, this.shutdown.signal]), slot = await this.requestSlots.acquire(combined);
    let release;
    try { release = await this.admissions.acquire(combined); }
    catch (error) { slot(); throw error; }
    this.mainAdmissions.set(sessionId, { release, slot });
    try { return await this.prepareAdmitted(payload, decision); }
    catch (error) { this.releaseMain(sessionId); throw error; }
  }
  releaseMain(sessionId, preparationOnly = false) {
    const entry = this.mainAdmissions.get(sessionId); if (!entry) return;
    entry.release();
    if (!preparationOnly) { entry.slot(); this.mainAdmissions.delete(sessionId); }
  }
  async prepareAdmitted(payload, decision) {
    const { agent, turn: nativeTurn, signal } = payload, sessionId = agent.session.id;
    signal.throwIfAborted(); await this.freezeSession(agent.session);
    if (this.nativeModels) payload = { ...payload, modelSelection: this.mainJob(sessionId, nativeTurn)?.modelConfig
      ?? await captureNativeSelection(this.host, agent, payload.modelSelection, signal) };
    let turn = this.attribution.existing(sessionId, nativeTurn), fresh = !turn;
    if (fresh) {
      if (!decision.messages.some(m => m.source?.kind === 'user')) { this.releaseMain(sessionId); return { kind: 'reject' }; }
      this.consumeBranchContinuation(sessionId, nativeTurn, decision.messages);
      if (this.attribution.capacity(sessionId).blocked) {
        this.deferForBranch(sessionId, nativeTurn, decision.messages);
        this.releaseMain(sessionId); return { kind: 'reject' };
      }
      const workspace = this.host.workingDirectory.get(agent.session), resources = this.resourcesFor(workspace);
      let snapshot;
      try { snapshot = await resources.snapshots.capture({ requestId: digest(['main-snapshot', sessionId, nativeTurn]), reason: 'main_turn', signal }); }
      catch (error) { this.diagnostic('snapshot_unavailable', error, { sessionId, nativeTurn }); }
      turn = await this.attribution.attribute({ sessionId, nativeTurn, messages: decision.messages, signal, agent, modelSelection: payload.modelSelection });
      if (!turn) { this.releaseMain(sessionId); return { kind: 'reject' }; }
      if (snapshot) bindTurnSnapshot(this.repo, snapshot.id, turn.id);
    }
    const hooks = this.hooks(sessionId), contextMessages = [];
    const add = result => { const value = hooks.message(result); if (value) contextMessages.push(this.createUserMessage(value)); };
    const scope = await this.builder.activate(sessionId, turn.id, { cancelPrevious: async leaving => {
      for (const event of leaving.leaveEvents) {
        // An explicit owner undo may remove the old target after its turn.
        // Its hooks are no longer eligible; still cancel the old session below.
        const node = this.repo.get('tree_nodes', event.nodeId);
        if (node && !node.deleted) add(hooks.evaluate({ sessionId, moment: 'node_leave', nodeId: event.nodeId, eventKey: `${leaving.token}:leave:${event.nodeId}`, fields: {}, fileEffects: 'unknown', signal }));
      }
      this.resourcesFor(this.host.workingDirectory.get(agent.session)).cancelSession?.(sessionId);
    } });
    if (fresh) {
      for (const event of scope.enterEvents) add(hooks.evaluate({ sessionId, moment: 'node_enter', nodeId: event.nodeId, eventKey: `${scope.token}:enter:${event.nodeId}`, fields: { nodeId: event.nodeId, nodeName: this.repo.get('tree_nodes', event.nodeId).name }, signal }));
      add(hooks.evaluate({ sessionId, moment: 'user_message', eventKey: `${turn.id}:human`, fields: { userMessage: this.sources.claimed(sessionId, decision.messages).map(s => s.text).join('\n') }, origin: 'user', signal }));
    }
    let job = this.mainJob(sessionId, nativeTurn);
    if (!job) {
      const sources = turn.userSourceRefs.map(this.resolveSource), context = this.builder.build(turn.nodeIds), rows = this.builder.activeItems(context.ancestorPaths.flat());
      job = this.jobs.enqueue({ role: 'main', key: turn.id, nodeIds: turn.nodeIds, revisionSet: {}, config: this.modelConfig('main', agent, payload.modelSelection),
        trigger: { kind: 'user_turn', producerRole: 'user', origin: 'user', nativeSessionId: sessionId, nativeTurn, turnId: turn.id },
        input: { scope: { nodeIds: turn.nodeIds, ancestorPaths: context.ancestorPaths, treeRevision: context.treeRevision }, sources, knownItems: rows.map(itemInput), assignmentRevision: turn.assignmentRevision,
          allowedIds: { nodeIds: context.ancestorPaths.flat(), subjectIds: rows.map(r => r.item.id), fileIds: [] }, changeReceipts: [] } });
      this.jobs.prepare(job.id); job = this.jobs.submit(job.id);
    }
    if (job.status !== 'submitted') fail('MAIN_RESULT_UNKNOWN', 'This native turn already has a result or unresolved attempt; do not resend');
    return { ...decision, messages: [...decision.messages, ...contextMessages] };
  }
  saveBranchPending(value, requestId) {
    return this.repo.command('recordAttributionPending', { requestId, expected: {}, input: value }, program, () => {
      const meta = this.repo.meta(); this.repo.save('tree_meta', { ...meta, attributionPending: { ...meta.attributionPending, [value.id]: value } }, meta.revision); return value;
    }).result;
  }
  deferForBranch(sessionId, nativeTurn, messages) {
    const sources = this.sources.claimed(sessionId, messages), id = digest(['attribution-pending', sessionId, nativeTurn]);
    if (!sources.length) fail('PROGRAM_NOT_USER', 'Only an original human input can wait for branch selection');
    const old = this.repo.meta().attributionPending?.[id]; if (old) return old;
    return this.saveBranchPending({ id, sessionId, nativeTurn, sourceRefs: sources.map(s => s.ref), state: 'waiting', revision: 1,
      preview: sources.map(s => s.text).join('\n').slice(0, 2000), at: this.repo.now() }, id);
  }
  consumeBranchContinuation(sessionId, nativeTurn, messages) {
    const ids = new Set(messages.filter(m => m.source?.kind === 'user').map(m => m.id));
    for (const pending of Object.values(this.repo.meta().attributionPending ?? {})) {
      if (pending.sessionId !== sessionId || !['dispatch_intent', 'queued'].includes(pending.state) || !pending.sourceRefs.every(r => ids.has(r.messageId))) continue;
      this.saveBranchPending({ ...pending, state: 'consumed', revision: pending.revision + 1, resumedNativeTurn: nativeTurn }, digest(['consume-branch', pending.id, nativeTurn]));
    }
  }
  async selectBranch(payload, context, requestId) {
    const { sessionId, signal, actor } = context, agent = this.mainAgents.get(sessionId);
    if (!agent || agent.status !== 'idle') fail('SESSION_BUSY', '请等当前对话结束，再选择目标范围。');
    await this.settlements.get(sessionId);
    const release = await this.admissions.acquire(AbortSignal.any([signal, this.shutdown.signal]));
    try {
      signal.throwIfAborted();
      await this.freezeSession(agent.session);
      if (agent.status !== 'idle') fail('SESSION_BUSY', '对话状态已变化，请刷新后再选择。');
      const selection = this.attribution.selection(sessionId), meta = this.repo.meta();
      if (meta.treeRevision !== payload.expectedTreeRevision || selection.revision !== payload.expectedSelectionRevision) fail('REVISION_CONFLICT', '目标或范围已变化，请刷新后选择。');
      if (payload.nodeId !== null) {
        const node = this.repo.get('tree_nodes', payload.nodeId);
        if (!node || node.deleted) fail('NODE_NOT_FOUND', '选定的目标已不存在。');
        const count = this.attribution.candidateNodes(this.repo.now(), node.id).length;
        if (count > 2000) fail('CANDIDATE_CAPACITY', `这支仍有${count}个候选，超过2000个；请再选择下一级目标。`);
      } else if (payload.pendingId && this.attribution.candidateNodes().length > 2000) fail('CANDIDATE_CAPACITY', '整棵树超量，请选定一支后再继续。');
      let pending, messages;
      if (payload.pendingId) {
        pending = meta.attributionPending?.[payload.pendingId];
        if (!pending || pending.sessionId !== sessionId || pending.state !== 'waiting') fail('CONTINUATION_UNAVAILABLE', '这条消息已经继续或发送结果待核对，不能重复发送。');
        if (this.mainJob(sessionId, pending.nativeTurn) || this.attribution.existing(sessionId, pending.nativeTurn)) fail('CONTINUATION_UNAVAILABLE', '这轮已进入执行，不能从范围选择入口重发。');
        const events = this.sources.events(sessionId);
        messages = pending.sourceRefs.map(ref => {
          const source = this.sources.resolve(ref), event = events[ref.seq], message = event?.data.inserted?.find(m => m.id === ref.messageId);
          if (!source || source.origin !== 'user' || !message || events.some(e => e.type === 'user/message' && e.data.id === ref.messageId)) fail('CONTINUATION_UNAVAILABLE', '原话已经处理或原件无法核对，不能重发。');
          return message;
        });
        if (agent.inbox.hasPending) fail('SESSION_BUSY', '还有待处理的输入，请先核对当前对话。');
      }
      this.repo.command('selectAttributionBranch', { requestId, expected: {}, input: { sessionId, ...payload } }, actor, () => {
        const current = this.repo.meta();
        const next = { nodeId: payload.nodeId, revision: selection.revision + 1, at: this.repo.now(), requestId };
        // Persist the intent before touching DSH's inbox. An interrupted intent
        // is visible and is never automatically replayed.
        this.repo.save('tree_meta', { ...current, attributionSelections: { ...current.attributionSelections, [sessionId]: next },
          ...(pending ? { attributionPending: { ...current.attributionPending, [pending.id]: { ...pending, state: 'dispatch_intent', revision: pending.revision + 1, continuationRequestId: requestId } } } : {}) }, current.revision);
        return next;
      });
      if (pending) {
        // These are the same durable human messages, not fabricated follow-ups.
        // Queue the full batch in one native step; only the last append wakes it.
        messages.forEach((message, index) => agent.send(message, 'next-step', index === messages.length - 1));
        await this.freezeSession(agent.session);
        const current = this.repo.meta().attributionPending[pending.id];
        this.saveBranchPending({ ...current, state: 'queued', revision: current.revision + 1 }, digest(['queue-branch', requestId]));
      }
      return { selection: this.attribution.selection(sessionId), continued: pending?.id ?? null };
    } finally { release(); }
  }
  mountMain(ctx, agent) {
    const sessionId = agent.session.id; this.mainAgents.set(sessionId, agent);
    if (this.nativeModels) ctx.effect(() => bindNativeTurnSelection(agent), 'keep the originating model until the native turn ends');
    this.owner.attachMain(ctx);
    mountHookContext(ctx, { service: this.hooks(sessionId), sessionId, createUserMessage: this.createUserMessage });
    mountTreeContext(ctx, { builder: this.builder, sessionId, createUserMessage: this.createUserMessage });
    // Prepare wraps the downstream host decision. It only admits accepted human
    // input; subsequent tool/program steps reuse the existing logical turn.
    ctx.on('agent/pre-step', async (payload, next) => this.prepare(payload, await next()));
    ctx.on('llm/stream', (request, next) => {
      if (request.sessionId !== sessionId) return next();
      const runtime = this;
      return (async function* () {
        const job = runtime.owner.jobFor(sessionId), invocation = runtime.repo.list('tree_invocations', i => i.jobId === job.id).at(-1);
        if (!invocation) fail('INVOCATION_GUARD', 'Native main must be admitted before exposure');
        runtime.builder.expose(sessionId, invocation.id, invocation.stepStartSeq, runtime.builder.capture(sessionId));
        try {
          for await (const chunk of next()) {
            const receipt = runtime.owner.ledgerLookup(invocation.ledgerRequestId);
            if (receipt?.dispatchedAt || runtime.nativeModels && receipt?.startedAt) runtime.releaseMain(sessionId, true);
            yield chunk;
          }
        } finally { runtime.releaseMain(sessionId); }
      })();
    });
    mountTreeTools(ctx, this);
    this.mountToolHooks(ctx, agent);
    ctx.on('agent/turn-stopping', payload => this.stopping(payload));
    ctx.effect(() => () => { this.mainAgents.delete(sessionId); this.resourcesFor(this.host.workingDirectory.get(agent.session)).cancelSession?.(sessionId); }, 'release tree main adapter');
  }
  toolFields(exec) {
    const fields = { toolName: exec.name };
    if (exec.name === 'bash' && typeof exec.arguments.command === 'string') fields.command = exec.arguments.command;
    if (['read', 'write', 'edit'].includes(exec.name) && typeof exec.arguments.file_path === 'string') fields.filePath = exec.arguments.file_path;
    return fields;
  }
  turnEffects(agent) {
    const events = agent.session.snapshotEvents(), start = events.findLast(e => e.type === 'turn/start');
    const calls = events.filter(e => e.type === 'tool/call' && e.seq > (start?.seq ?? -1)), files = [];
    const readOnly = new Set(['read', 'glob', 'grep', 'ask_user', 'todo', 'web_fetch', 'arcfold_read_method', 'arcfold_read_history', 'arcfold_mark_complete', 'arcfold_request_script']);
    let complete = true;
    for (const call of calls) {
      if (readOnly.has(call.data.name)) continue;
      const result = events.find(e => e.type === 'tool/result' && e.data.message?.toolCallId === call.data.callId);
      if (['write', 'edit'].includes(call.data.name) && result && !result.data.message.isError) {
        try { files.push(JSON.parse(call.data.arguments).file_path); } catch { complete = false; }
      } else complete = false;
    }
    return { fields: { earlierToolsInTurn: calls.map(e => e.data.name), earlierFilesInTurn: [...new Set(files.filter(p => typeof p === 'string'))] }, fileEffects: complete ? 'complete' : 'unknown' };
  }
  mountToolHooks(ctx, agent) {
    const hooks = this.hooks(agent.session.id), pending = new Map();
    ctx.on('tools/pre-execute', async (exec, next) => {
      const base = await next(); if (!['allow', 'ask'].includes(base.kind)) return base;
      await nativeTreeCall(ctx, this, exec);
      const effects = this.turnEffects(agent);
      // Exclude this pending call from the "earlier" projection.
      effects.fields.earlierToolsInTurn = effects.fields.earlierToolsInTurn.slice(0, -1);
      const result = hooks.evaluate({ sessionId: agent.session.id, moment: 'before_tool', eventKey: exec.callId, fields: { ...this.toolFields(exec), ...effects.fields }, fileEffects: effects.fileEffects, signal: exec.signal });
      pending.set(exec.callId, result);
      if (result.decision === 'deny') return { kind: 'deny', reason: '当前方法要求阻止这次工具操作。', info: { code: 'TREE_HOOK_DENIED' } };
      if (result.decision === 'ask') return { kind: 'ask', reason: '当前方法要求本次操作先经用户确认。' };
      return base;
    });
    ctx.tools.guard(exec => {
      const result = pending.get(exec.callId); if (!result) return '当前工具调用没有完成目标范围检查。';
      try { exec.signal.throwIfAborted(); hooks.assertCurrent(result.snapshot); if (result.decision === 'deny') return '当前方法拒绝这次工具操作。'; }
      catch { return '目标范围或方法已改变，本次工具操作没有执行。'; }
    });
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const base = await next(), before = pending.get(exec.callId);
      if (!before || exec.signal.aborted) return base;
      const after = hooks.evaluate({ sessionId: agent.session.id, moment: 'after_tool', eventKey: exec.callId,
        fields: { ...this.toolFields(exec), isError: result.isError, output: result.content.filter(b => b.type === 'text').map(b => b.text).join('\n') }, signal: exec.signal });
      const contexts = [before, after].map(value => hooks.message(value)).filter(Boolean).map(value => this.createUserMessage(value));
      return contexts.length ? { ...base, additionalContexts: [...(base.additionalContexts ?? []), ...contexts] } : base;
    });
    ctx.on('tools/result', exec => { pending.delete(exec.callId); });
  }
  async stopping({ agent, turn, signal }) {
    signal.throwIfAborted();
    const sessionId = agent.session.id, hooks = this.hooks(sessionId), events = agent.session.snapshotEvents(), start = events.findLast(e => e.type === 'turn/start').seq;
    const own = events.filter(e => e.seq > start), effects = this.turnEffects(agent), fields = { toolsCalled: own.filter(e => e.type === 'tool/call').map(e => e.data.name), ...effects.fields, filesWritten: effects.fields.earlierFilesInTurn };
    const result = hooks.evaluate({ sessionId, moment: 'turn_end', eventKey: `${turn}:${events.at(-1).seq}`, fields, fileEffects: effects.fileEffects, signal });
    // A new human inbox entry invalidates a continuation, even when it arrived
    // during the final provider response instead of cancelling that response.
    if (!result.continuation || [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(m => m.source?.kind === 'user')) return;
    const message = this.createUserMessage(hooks.message(result));
    if (hooks.claimContinuation(result, message.id, signal).claimed) agent.steer(message);
  }
  observe(session, event) {
    if (this.closed || !this.mainAgents.has(session.id) || event.type !== 'turn/end') return;
    this.releaseMain(session.id);
    const previous = this.settlements.get(session.id) ?? Promise.resolve();
    const promise = previous.catch(() => {}).then(async () => {
      const release = await this.admissions.acquire(this.shutdown.signal);
      try {
      await this.freezeSession(session); const turn = this.attribution.existing(session.id, event.data.turn); if (!turn) return;
      const job = this.mainJob(session.id, event.data.turn);
      if (job && !done.has(job.status)) {
        try { this.owner.consume(job.id, this.logs.get(session.id)); }
        catch (error) { if (this.jobs.get(job.id).status === 'submitted') this.jobs.transition(job.id, 'unknown', { error: { code: error.code ?? 'HOST_ERROR', message: error.message } }); this.diagnostic('main_settlement', error, { jobId: job.id }); }
      }
      // A failed revision must not block settlement or this turn's learning.
      try { this.applyGoalRevisions(turn.id, job); } catch (error) { this.diagnostic('goal_revision_apply', error, { turnId: turn.id }); }
      this.settleTurn(turn.id); this.kick();
      } finally { release(); }
    }).catch(error => this.diagnostic('turn_settlement', error, { sessionId: session.id, nativeTurn: event.data.turn }));
    this.settlements.set(session.id, promise); return promise;
  }
  // Applies main's structural goal revisions once its turn has ended, before
  // settlement queues learning, so this turn's learning lands on the revised
  // goal and the next attribution starts there. Also records whether the final
  // reply told the user about each revision, which the reply must do.
  applyGoalRevisions(turnId, job) {
    const turn = this.repo.get('tree_turns', turnId), revisions = turn?.goalRevisions ?? [];
    if (!revisions.length || revisions.every(r => r.announced !== undefined)) return null;
    const mainCommitted = job?.role === 'main' && this.jobs.get(job.id).status === 'committed', actor = { kind: 'model', role: 'main', id: job?.id ?? 'main' };
    const tree = new TreeService({ repository: this.repo, resolveSource: this.resolveSource, context: () => ({ actor, nodeIds: turn.nodeIds }) });
    const before = this.repo.list('tree_nodes');
    const receipt = tree.applyGoalRevisions({ requestId: digest(['apply-goal-revisions', turnId]), expected: { [`tree_turns:${turnId}`]: turn.revision }, input: { turnId, mainCommitted } });
    this.metrics.observeTree(receipt, before, { logicalTurnId: turnId });
    let reply = '';
    try { reply = this.sources.turn(turn.sessionId, turn.nativeTurn).sources.filter(s => s.role === 'assistant' || s.origin === 'model').map(s => s.text).at(-1) ?? ''; }
    catch (error) { this.diagnostic('goal_revision_reply', error, { turnId }); }
    const current = this.repo.get('tree_turns', turnId);
    // A move is told by naming where the goal went.
    const named = r => r.op === 'switch' ? this.repo.get('tree_nodes', r.nodeId)?.name : r.op === 'move' ? this.repo.get('tree_nodes', r.parentId)?.name : r.name;
    const goalRevisions = current.goalRevisions.map(r => ({ ...r, announced: Boolean(named(r) && reply.includes(named(r))) }));
    for (const r of goalRevisions.filter(r => !r.announced && r.state !== 'dropped')) this.diagnostic('goal_revision_unannounced', Object.assign(new Error('The reply did not tell the user about a goal revision'), { code: 'GOAL_REVISION_UNANNOUNCED' }), { turnId, revisionId: r.id });
    this.repo.command('recordGoalRevisionAnnouncement', { requestId: digest(['goal-revision-announcement', turnId]), expected: { [`tree_turns:${turnId}`]: current.revision }, input: { turnId } }, program, () => {
      this.repo.save('tree_turns', { ...current, goalRevisions }, current.revision); return { turnId, unannounced: goalRevisions.filter(r => !r.announced).map(r => r.id) };
    });
    return receipt;
  }
  settleTurn(turnId, { recovery = false } = {}) {
    const turn = this.repo.get('tree_turns', turnId), events = this.sources.events(turn.sessionId);
    const start = events.find(e => e.type === 'turn/start' && e.data.turn === turn.nativeTurn), end = start && events.find(e => e.type === 'turn/end' && e.seq > start.seq && e.data.turn === turn.nativeTurn);
    const committedUser = end && events.some(e => e.type === 'user/message' && e.data.source?.kind === 'user' && e.seq > start.seq && e.seq < end.seq);
    if (!end && recovery && !this.host.sessions.get(turn.sessionId)) {
      if (!start || !turn.userSourceRefs.length || turn.userSourceRefs.some(ref => this.resolveSource(ref)?.origin !== 'user')) fail('SOURCE_CHANGED', 'Unfinished recovered turn has no durable original');
      const own = events.filter(e => e.seq >= start.seq), hash = digest(own);
      return this.repo.command('recordInterruptedTreeRecovery', { requestId: digest(['recovered-interruption', turnId]), expected: {}, input: { turnId, hash } }, program, () => {
        const current = this.repo.get('tree_turns', turnId), refs = [...turn.userSourceRefs, ...own.map(e => this.sources.project(turn.sessionId, e)).filter(s => s && s.role !== 'user').map(s => s.ref)];
        this.repo.save('tree_turns', { ...current, status: 'interrupted', settledAt: this.repo.now(), experienceRefs: refs, experienceHash: hash, nativeEndSeq: null,
          recoveryEvidence: { reason: 'host_restart_without_durable_end', throughSeq: own.at(-1)?.seq, hash }, nativeEndReason: null }, current.revision);
        return { turnId, status: 'interrupted', learningIntents: [], nativeEndMissing: true };
      });
    }
    if (!end || committedUser || end.data.reason?.kind === 'completed') return this.experience.settle(turnId);
    // A cancellation/error during attribution can precede the native input
    // commit. Keep the genuine durable inbox reference, never invent a user
    // message or schedule learning for a conversation that did not run.
    if (!turn.userSourceRefs.length || turn.userSourceRefs.some(ref => this.resolveSource(ref)?.origin !== 'user')) fail('SOURCE_CHANGED', 'Interrupted input lost its durable original');
    const own = events.filter(e => e.seq >= start.seq && e.seq <= end.seq), hash = digest(own), status = end.data.reason.kind === 'error' ? 'failed' : 'interrupted';
    return this.repo.command('settleInterruptedTreeAdmission', { requestId: digest(['interrupted-admission', turnId]), expected: {}, input: { turnId, hash, endSeq: end.seq } }, program, () => {
      const current = this.repo.get('tree_turns', turnId);
      this.repo.save('tree_turns', { ...current, status, settledAt: this.repo.now(), experienceRefs: turn.userSourceRefs, experienceHash: hash, nativeEndSeq: end.seq, nativeEndReason: end.data.reason, inputCommitted: false }, current.revision);
      return { turnId, status, inputCommitted: false, learningIntents: [] };
    });
  }
  enqueueSummary(plan) {
    const frozen = this.consolidation.freeze(plan), key = digest([plan.nodeId, plan.sourceWatermark, plan.reason]);
    const old = this.repo.get('tree_jobs', digest(['model_job', 'consolidation', key])); if (old) return old;
    return this.jobs.enqueue({ role: 'consolidation', key, nodeIds: [plan.nodeId], input: frozen.input, revisionSet: frozen.revisions, config: this.backgroundModelConfig('consolidation', { turnId: plan.throughTurnIds.at(-1), nodeIds: [plan.nodeId] }), trigger: { kind: plan.reason === 'node_leave' ? 'leave_timeout' : plan.reason, modelSourceTurnId: plan.throughTurnIds.at(-1) } });
  }
  afterCommit(job) {
    if (job.status !== 'committed') return;
    if (job.trigger.nativeCompaction) return;
    if (job.role === 'script_writer') this.writers.activateReady(job.input.binding.methodId, job.input.binding.draftVersion);
    if (job.role === 'consolidation') {
      this.consolidation.finishEpoch(job.id);
      const summary = this.repo.list('tree_summaries', s => s.jobId === job.id)[0];
      if (summary && summary.reason !== 'threshold') this.triggers.scan(summary.nodeId, { summaryId: summary.id, parentJobId: job.id });
    }
    if (job.role === 'learning') for (const nodeId of job.nodeIds) this.triggers.scan(nodeId, { parentJobId: job.id });
  }
  async beforeSubmit(job, agent) {
    if (job.role !== 'learning' || !this.tokenCounter) return;
    const options = { provider: job.modelConfig.provider, model: job.modelConfig.model, reasoningEffort: job.modelConfig.reasoningEffort, maxTokens: job.modelConfig.maxTokens,
      messages: [{ role: 'system', content: [{ type: 'text', text: job.prompt.text }] }, ...agent.session.deriveMessages().filter(m => m.role !== 'system'), job.nativeMessage],
      tools: [], toolHistory: { tools: [], updates: [] }, signal: this.shutdown.signal };
    const reading = await this.tokenCounter.prepare(options), fullRequest = this.tokenCounter.request(options);
    const model = await this.host.llm.resolveModelInfo(job.modelConfig.provider, job.modelConfig.model, this.shutdown.signal);
    const pressure = this.consolidation.pressure({ fullRequest, measure: () => reading, contextWindow: model.context?.contextWindow,
      maxOutputTokens: job.modelConfig.maxTokens, estimated: this.nativeModels });
    if (pressure.needsSummary) {
      this.diagnostic('learning_pressure', { code: 'LEARNING_PRESSURE', message: 'Learning append stopped before submission' }, { jobId: job.id, measurement: pressure });
      fail('LEARNING_PRESSURE', `${reading.kind} input ${pressure.tokens} exceeds ${pressure.limit}; original input retained and no request submitted`);
    }
  }
  handlePressure(job) {
    if (!deferredLearning(job)) return false;
    const nodeId = job.nodeIds[0], session = this.repo.list('tree_learning_sessions', s => s.nodeId === nodeId)[0];
    if (session?.contextEpoch !== job.contextEpoch) return true;
    this.repo.command('handleLearningPressure', { requestId: digest(['learning-pressure', job.id]), expected: {}, input: { jobId: job.id, contextEpoch: job.contextEpoch } }, program, () => {
      const plan = this.consolidation.plan(nodeId, 'threshold');
      const hasNewSummaryMaterial = plan && plan.sourceWatermark !== session.sourceWatermark;
      // The refused input stays in the current native session, so the turn
      // must move to a new one. With nothing older to summarize, rotate to a
      // fresh session over the same verified summary instead of pausing.
      if (job.providerRejected && !hasNewSummaryMaterial && session.summaryId && !job.trigger.retriesProviderRejection) {
        this.jobs.rotateEpoch(nodeId); return { rotatedEpoch: session.contextEpoch + 1 };
      }
      if (job.providerRejected && job.trigger.retriesProviderRejection && !hasNewSummaryMaterial) {
        const message = '新学习会话的请求仍超出模型上下文，原文和待处理任务已保留。';
        this.jobs.pauseLearning(nodeId, message);
        this.diagnostic('learning_capacity', { code: 'LEARNING_CAPACITY', message }, { jobId: job.id, nodeId });
        return { capacityBlocked: true };
      }
      this.jobs.pauseLearning(nodeId, this.nativeModels ? '预计输入长度接近上限，等待整理；原文保留。' : '精确输入计数达到上限，等待整理；原文保留。');
      if (hasNewSummaryMaterial) return { summaryJobId: this.enqueueSummary(plan).id };
      this.diagnostic('learning_capacity', { code: 'LEARNING_CAPACITY', message: 'No older material can be summarized while retaining the last three learning turns' }, { jobId: job.id, nodeId });
      return { capacityBlocked: true };
    });
    return true;
  }
  async summarizeNative(input, agent, signal) {
    signal?.throwIfAborted();
    if (this.mainAgents.get(agent.session.id) !== agent) fail('COMPACTION_OWNER', 'Only an attached main may compact its native history');
    await this.freezeSession(agent.session); await this.idle(); signal?.throwIfAborted();
    const start = agent.session.snapshotEvents().findLast(e => e.type === 'compaction/start');
    if (!start) fail('COMPACTION_OWNER', 'Native compaction transaction required');
    const messages = input.messages.filter(m => m.role !== 'system' && (['assistant', 'tool'].includes(m.role) || m.source?.kind === 'user' || m.source?.kind === 'compact-checkpoint'));
    const messageIds = new Set(messages.map(m => m.id)), toolIds = new Set(messages.flatMap(m => (m.content ?? []).filter(b => b.type === 'tool-call').map(b => b.id)));
    const sources = this.logs.get(agent.session.id).filter(e => messageIds.has(e.type === 'user/message' ? e.data.id : e.data.message?.id) || e.type === 'tool/call' && toolIds.has(e.data.callId))
      .map(e => this.sources.project(agent.session.id, e)).filter(Boolean);
    const previous = messages.filter(m => m.source?.kind === 'compact-checkpoint');
    const scope = this.builder.scope(agent.session.id), nodeIds = scope?.nodeIds ?? [this.repo.rootId()];
    const key = digest(['native-compaction', agent.session.id, start.data.compactionId]), existing = this.repo.get('tree_jobs', digest(['model_job', 'consolidation', key]));
    const selection = this.nativeModels ? await captureNativeSelection(this.host, agent, agent.model.current(), signal) : undefined;
    const job = existing ?? this.jobs.enqueue({ role: 'consolidation', key, nodeIds, revisionSet: {}, config: this.backgroundModelConfig('consolidation', { agent, selection }),
      trigger: { kind: 'threshold', reason: 'threshold', nativeCompaction: true },
      input: { scope: { nodeIds, ancestorPaths: nodeIds.map(id => this.repo.ancestors(id).map(n => n.id)), treeRevision: this.repo.meta().treeRevision }, sources, knownItems: [], changeReceipts: [],
        allowedIds: { nodeIds, subjectIds: [], fileIds: [] }, nativeCompaction: { sessionId: agent.session.id, inputHash: digest(input), previous,
          instruction: '只压缩给定原文与先前安全检查点，保留用户决定、助手建议的区别及工具结果。不要加入节点理解、方法或程序注入文字。' } } });
    const cancel = () => this.owner.handles.get(job.id)?.agent.cancel({ kind: 'user', message: 'Main compaction cancelled' }, { keepInbox: false });
    signal?.addEventListener('abort', cancel, { once: true });
    let completed;
    try { signal?.throwIfAborted(); completed = await this.owner.run(job.id); signal?.throwIfAborted(); }
    finally { signal?.removeEventListener('abort', cancel); }
    if (completed.status !== 'committed') fail('COMPACTION_UNAVAILABLE', `Owned summary ${completed.status}; original history retained`);
    const content = [{ type: 'text', text: canonicalJson(completed.resultRef.summary) }];
    return { summary: content, rawOutput: completed.rawMessage.content, provider: completed.modelConfig.provider, model: completed.modelConfig.model, maxTokens: completed.modelConfig.maxTokens };
  }
  scan() {
    if (this.closed) return Promise.resolve(false);
    if (this.scanPromise) return this.scanPromise;
    this.scanPromise = this.scanAdmitted().finally(() => { this.scanPromise = null; });
    return this.scanPromise;
  }
  async scanAdmitted() {
    const release = await this.admissions.acquire(this.shutdown.signal);
    try { return this.scanOne(); }
    finally { release(); }
  }
  async scanOne() {
    if (this.closed) return false;
    for (const job of this.repo.list('tree_jobs', j => j.role === 'consolidation' && j.status === 'committed' && j.input.summaryPlan?.reason === 'threshold')) {
      const session = this.repo.list('tree_learning_sessions', s => s.nodeId === job.nodeIds[0])[0];
      if (session?.contextEpoch !== job.input.summaryPlan.contextEpoch) continue;
      try { this.afterCommit(job); } catch (error) { if (!busy.has(error.code)) this.diagnostic('epoch_completion', error, { jobId: job.id }); }
    }
    for (const intent of this.repo.list('tree_jobs', j => !j.role && j.kind === 'learning' && j.status === 'queued')) {
      try { this.learning.enqueue(intent.input.turnId, intent.nodeIds[0]); }
      catch (error) { if (!busy.has(error.code)) this.diagnostic('learning_queue', error, { intentId: intent.id }); }
    }
    for (const intent of this.repo.list('tree_jobs', j => !j.role && j.kind === 'verification' && j.status === 'queued')) {
      try { this.verification.enqueueCorrection(intent); }
      catch (error) {
        if (busy.has(error.code)) continue;
        this.diagnostic('source_recheck_queue', error, { intentId: intent.id });
        if (['JOB_STALE', 'SOURCE_CHANGED', 'RECHECK_EVIDENCE_MISSING'].includes(error.code)) this.repo.command('retireSourceRecheckIntent',
          { requestId: digest(['retire-source-recheck', intent.id]), expected: { ['tree_jobs:' + intent.id]: intent.revision }, input: { intentId: intent.id, reason: error.code } },
          { kind: 'program', id: 'source-recheck' }, () => { this.repo.save('tree_jobs', { ...intent, status: 'stale', error: { code: error.code, message: error.message } }, intent.revision); return { intentId: intent.id }; });
      }
    }
    for (const plan of this.consolidation.due()) this.enqueueSummary(plan);
    for (const node of this.repo.list('tree_nodes', n => !n.deleted && n.status === 'completed' && n.statusOrigin !== 'cascade')) {
      if (this.repo.list('tree_jobs', j => ['learning', 'consolidation'].includes(j.role) && j.nodeIds.includes(node.id) && !done.has(j.status)).length) continue;
      const plan = this.consolidation.plan(node.id, 'node_complete'); if (plan) this.enqueueSummary(plan);
    }
    for (const role of ['attribution', 'learning', 'consolidation', 'verification', 'improvement']) this.improvement.enqueue(role);
    const ready = [...this.repo.list('tree_jobs', j => j.status === 'prepared' && j.role), ...this.jobs.queued()];
    let started = false;
    for (const job of ready.filter(j => !['main', 'attribution'].includes(j.role))) {
      if (this.workers.size >= 2 || this.workers.has(job.id)) continue;
      if (job.role === 'script_writer' && [...this.workers.keys()].some(id => this.jobs.get(id).role === 'script_writer')) continue;
      try { this.jobs.prepare(job.id); }
      catch (error) { if (!busy.has(error.code)) { this.jobs.transition(job.id, 'stale', { error: { code: error.code, message: error.message } }); this.diagnostic('job_preparation', error, { jobId: job.id }); } continue; }
      const promise = this.runWorker(job.id).catch(error => { if (!this.closed && !busy.has(error.code)) this.diagnostic('job_worker', error, { jobId: job.id }); })
        .finally(() => { this.workers.delete(job.id); if (!this.closed) this.kick(); });
      this.workers.set(job.id, promise);
      started = true;
    }
    return started;
  }
  async runWorker(id) {
    const slot = await this.requestSlots.acquire(this.shutdown.signal);
    try {
      const result = await this.owner.run(id), release = await this.admissions.acquire(this.shutdown.signal);
      try { if (!this.handlePressure(result)) this.afterCommit(result); }
      finally { release(); }
    } finally { slot(); }
  }
  kick() {
    if (this.closed || this.scanPending) return;
    this.scanPending = true;
    queueMicrotask(() => { this.scanPending = false; void this.scan().then(progress => { if (progress) this.kick(); }).catch(error => { if (!this.closed) this.diagnostic('worker_scan', error); }); });
  }
  async idle() {
    for (;;) { await Promise.all([...this.settlements.values()]); const progress = await this.scan(); await Promise.all([...this.workers.values()]); if (!progress && !this.workers.size && !this.scanPending) return; }
  }
  start() { this.timer = setInterval(() => this.kick(), 60000); this.timer.unref(); }
  async close() { this.closed = true; clearInterval(this.timer); this.shutdown.abort(); for (const id of this.mainAdmissions.keys()) this.releaseMain(id); await this.owner.close(); await Promise.allSettled([...this.settlements.values(), ...this.workers.values(), this.scanPromise]); }
}

/** Explicit separate namespace; the legacy bridge/writers are never provided. */
export async function installTreeRuntime(ctx, config, { legacyFilename } = {}) {
  // The business plugin starts before filesystem/working-directory providers.
  // Runtime capabilities resolve from the native root at operation time, as in
  // the existing bridge; they are checked before admitting any operation.
  const host = ctx.root;
  const path = (value, field) => { if (!isAbsolute(value ?? '')) fail('TREE_CONFIG', `Explicit absolute ${field} required`); return canonicalPath(value); };
  const privateRoot = path(config.privateRoot, 'privateRoot'), runtimeRoot = path(config.runtimeRoot, 'runtimeRoot');
  const treeFilename = path(config.treeFilename, 'treeFilename'), workspace = path(config.workspace, 'workspace');
  if (!beneath(treeFilename, privateRoot) || treeFilename === privateRoot || beneath(runtimeRoot, privateRoot) || beneath(privateRoot, runtimeRoot)) fail('TREE_CONFIG', 'Tree database is private; execution files require a separate root');
  for (const directory of [privateRoot, runtimeRoot]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const timing = new StartupTiming({ directory: privateRoot, logger: ctx.logger });
  const nativeModels = config.adapter === 'dsh-native-v1';
  const budget = config.budget ?? {}, ledgerPath = nativeModels ? null : path(budget.ledgerPath, 'budget.ledgerPath');
  const evidence = path(nativeModels ? config.accounting?.artifactDirectory : budget.artifactDirectory, 'request evidence');
  const webOnly = budget.mode === 'web-only';
  if (nativeModels) {
    if (config.budget || config.models || config.tokenCounter || config.followConversationModel !== true || !config.accounting?.authorization?.authorizationRef)
      fail('TREE_CONFIG', 'Native model routing requires its own explicit consent and the originating conversation choice');
  } else {
    if (budget.mode !== undefined && !webOnly || webOnly && (budget.manifest || budget.scope !== 'web-unlimited' || Object.hasOwn(budget, 'authorizationRef') || Object.hasOwn(budget, 'ceilingCny'))) fail('TREE_CONFIG', 'Web-only accounting must retain its explicit website authority without a test allowance');
    if (!beneath(ledgerPath, privateRoot) || ledgerPath === treeFilename || (webOnly ? !budget.webAuthorization : !budget.authorizationRef)) fail('TREE_CONFIG', 'Explicit private ledger paths and authorization required');
  }
  if (!beneath(evidence, privateRoot) || evidence === privateRoot) fail('TREE_CONFIG', 'Private request evidence path required');
  let lease;
  try { lease = await timing.step('evidence-lease', () => ownEvidenceDirectory(evidence)); }
  catch (error) { timing.finish(error); throw error; }
  let repo, ledger, transport, nativeRecords, runtime, unregister, closing;
  const close = () => closing ??= (async () => {
    try { await runtime?.close(); await transport?.close(); }
    finally { try { unregister?.(); ledger?.close(); repo?.close(); } finally { await lease.close(); } }
  })();
  ctx.effect(() => close, 'close tree workers, metering, storage and evidence ownership');
  try {
    repo = timing.step('open-tree', () => new TreeRepository({ treeFilename, userId: config.userId, legacyFilename }));
    const experiment = budget.manifest?.budgetScope === TREE_TEST_SCOPE;
    ledger = nativeModels ? null : experiment ? new TreeTestLedger({ filename: ledgerPath, manifest: budget.manifest, authorizationRef: budget.authorizationRef, create: budget.create === true })
      : webOnly ? openOwnedWebBudget({ artifactDirectory: evidence, ledgerPath, webAuthorization: budget.webAuthorization, owner: lease }).ledger
      : new BudgetLedger(ledgerPath, { ceilingCny: budget.ceilingCny, authorizationRef: budget.authorizationRef, scope: budget.scope, webAuthorization: budget.webAuthorization, create: false });
    const modelPolicies = experiment ? { [ledger.manifest.model]: ledger.modelPolicy() } : budget.modelPolicies;
    if (!nativeModels && (!modelPolicies || !Object.keys(modelPolicies).length)) fail('TREE_CONFIG', 'Frozen model policies are required');
    const protectedRoots = [privateRoot, ...(config.protectedRoots ?? []).map(p => path(p, 'protectedRoots'))];
    if (legacyFilename) protectedRoots.push(canonicalPath(legacyFilename));
    const resources = new Map(), brokers = new Set();
    const artifacts = new ScriptArtifacts({ repository: repo, directory: join(privateRoot, 'artifacts'), resolveSource: ref => runtime.resolveSource(ref) });
    const sessionPolicy = session => {
      if (!ctx.get('sandboxPolicy')) fail('POLICY_UNAVAILABLE', 'Current native file permissions are required');
      return host.sandboxPolicy.resolve({ session });
    };
    const resourceFor = (directory, uiContext) => {
      directory = realpathSync(directory);
      let resource = resources.get(directory);
      const snapshotOptions = { repository: repo, workspace: directory, storageRoot: join(privateRoot, 'snapshots'), runtimeRoot, protectedRoots };
      if (!resource) {
        const snapshots = new SnapshotService(snapshotOptions), io = new ConfinedWorkspaceIO({ workspace: directory, runtimeRoot, protectedRoots });
        resource = { snapshots, io, cancelSession: id => { for (const broker of brokers) broker.cancelSession(id); },
          brokerFor: ({ agent, actor, exec }) => {
            const context = () => {
              exec.signal.throwIfAborted();
              if (runtime.mainAgents.get(agent.session.id) !== agent || host.agents.currentInitiator() !== agent || agent.status !== 'running') fail('MAIN_REQUIRED', 'Native main tool authority ended');
              return { actor, sessionId: agent.session.id, nativeToolCallId: exec.callId, sessionPolicy: sessionPolicy(agent.session) };
            };
            const broker = new MethodScriptBroker({ repository: repo, artifacts, snapshots, runtimeRoot, protectedRoots, context,
              resolveSource: runtime.resolveSource, readScope: id => runtime.builder.scope(id),
              // Authored files narrow the live native tool's permission; they
              // cannot grant it. Snapshot coverage checks every declared file.
              authorizeWrites: ({ context: current, artifact }) => ({ paths: artifact.writePaths ?? [], authorizationRef: digest({ nativeToolCallId: current.nativeToolCallId, sessionId: current.sessionId, sessionPolicy: current.sessionPolicy, artifactId: artifact.id, artifactRevision: artifact.revision }) }) });
            brokers.add(broker); return broker;
          } };
        resources.set(directory, resource);
      }
      if (!uiContext) return resource;
      const session = ctx.sessions.get(uiContext.sessionId);
      if (!session || host.workingDirectory.get(session) !== directory) fail('SNAPSHOT_UNAVAILABLE', 'Restore session workspace changed');
      return { ...resource, snapshots: new SnapshotService({ ...snapshotOptions, context: () => {
        uiContext.signal.throwIfAborted(); runtime.ui.authorize(uiContext);
        if (ctx.sessions.get(uiContext.sessionId) !== session || host.workingDirectory.get(session) !== directory) fail('WORKSPACE_CHANGED', 'Restore session changed');
        return { ...uiContext, sessionPolicy: sessionPolicy(session) };
      } }) };
    };
    const modelConfig = (role, agent, selection) => {
      if (nativeModels) return nativeModelConfig(role, selection, agent ? host.workingDirectory.get(agent.session) : workspace, config.stage ?? 'desktop');
      const selected = config.models?.[role]; if (!selected) fail('TREE_CONFIG', `Explicit ${role} model configuration required`);
      const route = role === 'main' ? { ...selected, ...(selection ?? agent?.model?.current?.() ?? agent?.model), maxTokens: agent?.options.maxTokens ?? selected.maxTokens }
        : config.followConversationModel === true ? { ...selected, provider: selection?.provider ?? config.models.main.provider, model: selection?.model ?? config.models.main.model } : selected;
      const policy = modelPolicies[route.model];
      if (route.provider !== 'deepseek-official' || !policy) fail('TREE_CONFIG', 'Role model has no authorized metered route');
      // A resumed/forked native conversation can retain a model other than the
      // current main default. Record the version belonging to the actual route.
      const versions = experiment ? [ledger.manifest.modelVersion] : [...new Set(Object.values(config.models)
        .filter(value => value.provider === route.provider && value.model === route.model).map(value => value.modelVersion))];
      if (versions.length !== 1 || typeof versions[0] !== 'string' || !versions[0]) fail('TREE_CONFIG', 'Selected model requires one explicit matching version');
      return { provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort, maxTokens: route.maxTokens,
        preset: role === 'script_writer' ? 'arcfold-tree-writer' : 'arcfold-tree-reader', cwd: agent ? host.workingDirectory.get(agent.session) : workspace,
        modelVersion: versions[0], priceVersion: experiment ? ledger.manifestHash : policy.priceVersion,
        budgetScope: experiment ? TREE_TEST_SCOPE : budget.scope, stage: selected.stage ?? config.stage ?? 'runtime' };
    };
    if (!nativeModels) for (const role of ['attribution', 'learning', 'consolidation', 'verification', 'improvement', 'script_writer']) modelConfig(role);
    if (!nativeModels && !config.tokenCounter) fail('TREE_CONFIG', 'The new tree requires an explicit verified offline token counter');
    if (config.adapter !== undefined && !['desktop-private-v1', 'dsh-native-v1'].includes(config.adapter)) fail('TREE_CONFIG', 'Unknown provider adapter');
    const adapter = await timing.step('model-adapter', async () => config.adapter === 'desktop-private-v1'
      ? await (await import('../desktop/adapter.mjs')).loadDesktopDeepSeekAdapter() : undefined);
    const tokenCounter = nativeModels ? new NativeInputEstimate(host) : new TreeTokenCounter({ python: config.tokenCounter.python, moduleDirectory: join(privateRoot, 'tokenizer-dependency'), adapter });
    runtime = timing.step('create-runtime', () => new TreeRuntime({ repository: repo, host, createUserMessage, defineTool, modelConfig, nativeModels,
      followConversationModel: config.followConversationModel === true, ledgerLookup: id => nativeModels ? nativeRecords?.get(id) : ledger.get(id), artifacts, resourcesFor: resourceFor, tokenCounter,
      createWriterOptions: job => ({ workspaceIO: resourceFor(job.modelConfig.cwd).io, runtimeRoot, protectedRoots }),
      browserScope: context => ctx.sessions.get(context.sessionId) ? { nodeIds: repo.list('tree_nodes', n => !n.deleted).map(n => n.id) } : null }));
    runtime.hostPolicy = supplied => {
      const agent = ctx.get('agents')?.currentInitiator(), policy = supplied ?? sessionPolicy(agent?.session);
      const directory = agent ? host.workingDirectory.get(agent.session) : policy.workspaceRoot;
      return processPolicy({ workspace: directory, runtimeRoot, protectedRoots,
        immutableRoots: [dirname(fileURLToPath(import.meta.url))], sessionPolicy: policy, authorizedWriteRoots: [directory] });
    };
    // This empty legacy facade exists solely for the already-audited authority
    // resolver. It grants no old work/learning ownership and starts no writers.
    const business = Object.freeze({ get: () => null, listAll: () => [] });
    unregister = registerTreeRequestAuthority(business, runtime.owner);
    if (nativeModels) {
      timing.step('model-records', () => {
        nativeRecords = new NativeModelRecords(repo, runtime.owner);
        nativeRecords.recover();
        // An upgrade cannot replay work admitted under a different billing route.
        // Historical data and receipts stay in their original stores.
        for (const job of repo.list('tree_jobs', j => j.role && !nativeModel(j.modelConfig) && ['queued', 'prepared'].includes(j.status)))
          runtime.jobs.transition(job.id, 'cancelled', { error: { code: 'MODEL_ROUTE_UPGRADED', message: '模型通道已更新；保留旧任务原文，不自动重发。' } });
      });
      ctx.on('llm/stream', (options, next) => runtime.owner.owns(options.sessionId)
        ? runtime.owner.guardStream(options, () => nativeRecords.stream(options, next)) : next(), { prepend: true });
      ctx.provide('arcfoldNativeModelRecords', Object.freeze({ summary: () => nativeRecords.summary() }));
    } else {
      transport = new DeepSeekTransport({ ledger, artifactDirectory: evidence, provider: 'deepseek-official', modelPolicies,
      endpoint: budget.endpoint, allowLocalTestEndpoint: budget.allowLocalTestEndpoint === true, timeoutMs: budget.timeoutMs,
      requestIdentity: options => runtime.owner.identity(options), beforeDispatch: options => runtime.owner.assertRequest(options) });
    await timing.step('transport-recover', () => transport.recover({ exclusive: true }));
    ctx.on('llm/stream', (options, next) => {
      if (!runtime.owner.owns(options.sessionId)) fail('MODEL_OWNER', 'New-tree profile refuses every unowned request');
      transport.validateInput(options); return runtime.owner.guardStream(options, next);
    }, { prepend: true });
      ctx.provide('arcfoldDeepSeekTransport', Object.freeze({ summary: () => ledger.summary(), createTransport: options => transport.createTransport(options),
        configuration: Object.freeze({ provider: 'deepseek-official', endpoint: transport.endpoint, modelPolicies: transport.modelPolicies }) }));
    }
    ctx.on('session/event', (session, event) => runtime.observe(session, event));
    ctx.provide('arcfoldBusiness', business);
    ctx.provide('arcfoldTreeRuntime', runtime);
    ctx.provide('arcfoldTreeV3', runtime.ui);
    await runtime.recover(timing); timing.step('start-workers', () => runtime.start());
    timing.finish(); return runtime;
  } catch (error) { timing.finish(error); await close(); throw error; }
}
