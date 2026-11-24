import { CONTRACT, canonicalJson, digest, fail, jsonClone, sourceRefs } from './contracts.mjs';
import { ItemService } from './items.mjs';
import { validateOutput, resolveSourceIds } from './prompts.mjs';
import { ScriptWriter } from './script-writer.mjs';
import { learningCorrections, LearningObservations, quotedSource } from './observations.mjs';
import { MetricsService } from './metrics.mjs';
import { deferredLearning, interruptedLearning, movedLearning, preDispatchLearning, providerErrorLearning, LEARNING_BACKLOG_SKIPPED } from './jobs.mjs';
import { compactLearningSource } from './experience.mjs';

const program = { kind: 'program', id: 'tree-learning' };
// experience-v1 is the production default. correction-v1 and the legacy
// contract stay readable for jobs frozen before the upgrade and for fixtures.
export const COMPACT_PROTOCOLS = Object.freeze(['correction-v1', 'experience-v1']);
const unique = values => [...new Map(values.map(v => [canonicalJson(v), v])).values()];
export function itemInput({ item, version, method, previous }) {
  return { id: item.id, version: item.activeVersion, nodeId: item.nodeId, kind: item.kind, sourceKind: version.sourceKind, userProtected: item.userProtected,
    originNodeId: item.originNodeId, originChain: item.originChain, content: version.content, ...(previous ? { previous } : {}), method: method ?? null, validation: item.validation };
}
export function proposalInput(output, envelope) {
  const refs = ids => resolveSourceIds(ids, envelope);
  const method = proposal => {
    const { sourceIds, origin: _origin, ...value } = proposal;
    const category = envelope.trigger.directRequirement?.category;
    return { ...value, expectedEffect: value.expectedEffect ?? { category, change: ['approved', 'adopted_proposal', 'confirmed_inference', 'proceeded'].includes(category) ? 'more' : 'less', text: `遵守本轮明确要求（${category}）` }, sourceRefs: refs(sourceIds) };
  };
  return { nodeId: envelope.scope.nodeIds[0], understandings: (output.understandings ?? []).map(({ sourceIds, origin: _origin, ...value }) => ({ ...value, sourceRefs: refs(sourceIds) })),
    methods: (output.methods ?? []).map(method), supplements: (output.supplements ?? []).map(({ sourceIds, ...value }) => {
      const actual = refs(sourceIds); if (!actual.some(ref => envelope.sources.some(s => digest(s.ref) === digest(ref) && s.role === 'user' && s.origin === 'user'))) fail('SUPPLEMENT_USER_REQUIRED', 'Learning supplements need a real user requirement');
      return { ...value, sourceRefs: actual, traitEvidence: actual, universalStopgap: false };
    }), revisions: (output.revisions ?? []).map(({ sourceIds, correctionEvidence: _evidence, ...value }) => ({ ...value, sourceRefs: refs(sourceIds) })),
    ...(output.developments?.length ? { developments: output.developments.map(({ sourceIds, ...value }) => ({ ...value, sourceRefs: refs(sourceIds) })) } : {}) };
}
export function itemServiceFor(repo, resolveSource, job, corrections) {
  const correction = job.trigger.correction;
  return new ItemService({ repository: repo, resolveSource, context: () => ({ actor: { kind: 'model', id: job.id, role: job.role }, nodeIds: job.nodeIds,
    ...(correction ? { correction: { ...correction, sourceRefs: resolveSourceIds(correction.sourceIds, job.input) } } : {}), ...(corrections ? { corrections } : {}) }) });
}

// Beyond this many other goals the learning input carries none.
export const OTHER_GOALS_LIMIT = 200;

export class LearningService {
  constructor({ repository, experience, contextBuilder, consolidation, jobs, modelConfig, signals, writerRouter, annotations = () => ({}), outputProtocol = 'experience-v1' }) {
    Object.assign(this, { repo: repository, experience, builder: contextBuilder, consolidation, jobs, config: modelConfig, signals, writers: writerRouter, annotations, outputProtocol });
    this.resolveSource = contextBuilder.resolveSource;
    this.observations = new LearningObservations({ repository, metrics: new MetricsService({ repository, experience, signals }) });
  }
  existing(turn, nodeId) {
    const skipped = this.repo.list('tree_jobs', j => !j.role && j.kind === 'learning' && j.scopeKey === nodeId && j.input.turnId === turn.id && j.input.assignmentRevision === turn.assignmentRevision && j.error?.code === LEARNING_BACKLOG_SKIPPED)[0];
    if (skipped) return skipped;
    return this.repo.list('tree_jobs', j => j.role === 'learning' && j.trigger.turnId === turn.id && j.nodeIds[0] === nodeId && j.input.currentTurn.assignmentRevision === turn.assignmentRevision)
      .sort((a, b) => b.enqueuedOrder - a.enqueuedOrder || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
  }
  providerRetryAvailable(job) {
    if (!providerErrorLearning(job)) return false;
    const attempts = this.repo.list('tree_jobs', j => j.role === 'learning' && j.nodeIds[0] === job.nodeIds[0] && j.trigger.turnId === job.trigger.turnId);
    return !attempts.some(j => j.trigger.retriesProviderError) && attempts.reduce((n, j) => n + j.invocationIds.length, 0) < 2;
  }
  enqueue(turnId, nodeId) {
    const turn = this.repo.get('tree_turns', turnId);
    if (!turn || turn.status !== 'settled' || !turn.nodeIds.includes(nodeId)) fail('LEARNING_EXPERIENCE', 'Learning needs a settled own main turn');
    const baseKey = digest(['turn-learning', turnId, nodeId, turn.assignmentRevision]), old = this.existing(turn, nodeId);
    let session = this.repo.list('tree_learning_sessions', s => s.nodeId === nodeId)[0];
    // Only an append stopped before submission, or one the provider refused
    // for context size without output, may be frozen again after the epoch
    // changes. A request interrupted by a host stop before it was released is
    // frozen again at once. A durably failed provider turn gets one persistent
    // retry; genuinely unknown requests remain blocked.
    const retried = this.repo.list('tree_jobs', j => j.role === 'learning' && j.nodeIds[0] === nodeId && j.trigger.turnId === turnId && j.trigger.retriesProviderError).length > 0;
    const providerError = this.providerRetryAvailable(old);
    const deferred = deferredLearning(old), interrupted = interruptedLearning(old), refused = preDispatchLearning(old), moved = movedLearning(old);
    // A refused append cannot go back into the same native session: its
    // position is already taken. Start a new session first (once per turn).
    if (refused && !session?.paused && session?.contextEpoch === old.contextEpoch) session = this.jobs.restartEpoch(nodeId);
    const ready = interrupted || moved || providerError ? !session?.paused : (deferred || refused) && !session?.paused && session?.contextEpoch > old.contextEpoch;
    if (old && !ready) return old;
    const key = !old ? baseKey : providerError ? digest(['provider-error-learning', baseKey]) : interrupted ? digest(['interrupted-learning', baseKey, old.id]) : refused ? digest(['pre-dispatch-learning', baseKey, old.id])
      : moved ? digest(['moved-learning', baseKey, old.id]) : digest(['epoch-learning', baseKey, session.contextEpoch]);
    // Freeze after previous receipts, not eagerly while an earlier turn is still
    // producing the very constraints and acknowledgements this turn must read.
    if (this.repo.list('tree_jobs', j => ['learning', 'consolidation'].includes(j.role) && j.nodeIds.includes(nodeId) && !['committed', 'failed', 'invalid_output', 'stale', 'cancelled'].includes(j.status)).length) fail('NODE_BUSY', 'Earlier learning/summary must settle before freezing the next turn');
    const turns = this.experience.turns(nodeId, { includeInterrupted: false });
    for (const prior of turns.slice(0, turns.findIndex(t => t.id === turnId))) {
      const previous = this.existing(prior, nodeId);
      if (!previous || !['committed', 'failed', 'invalid_output', 'stale', 'cancelled'].includes(previous.status)) fail('NODE_ORDER', 'Prior own experience has not been processed');
    }
    const material = this.experience.material(turn); if (material.revokedRefs.length) fail('SOURCE_CHANGED', 'Original experience was withdrawn');
    const context = this.builder.build([nodeId], 'learning'), rows = this.builder.activeItems(context.ancestorPaths.flat(), 'learning');
    const otherGoals = this.otherGoals(context.ancestorPaths.flat());
    const priorTurns = turns.slice(0, turns.findIndex(t => t.id === turnId));
    // Compact protocols read this turn plus the previous own turn, and never
    // the legacy observation records.
    const compact = COMPACT_PROTOCOLS.includes(this.outputProtocol);
    const observed = compact ? { proposals: [], fragments: [], sources: [] } : this.observations.freeze(nodeId, priorTurns.map(t => t.id));
    const previousSources = compact && priorTurns.length ? this.experience.material(priorTurns.at(-1)).sources : priorTurns.flatMap(t => t.userSourceRefs.map(this.resolveSource)).filter(Boolean);
    const sources = unique([...material.sources, ...previousSources, ...observed.sources]).map(compactLearningSource);
    const annotations = jsonClone(this.annotations(turn, nodeId));
    if (annotations.correction) {
      const c = annotations.correction;
      if (!Array.isArray(c.itemIds) || !Array.isArray(c.sourceIds) || !c.sourceIds.length || c.sourceIds.some(id => !material.sources.some(s => s.id === id && s.role === 'user' && s.origin === 'user'))) fail('CORRECTION_REQUIRED', 'Correction must be bound to the current actual user input');
    }
    const scopedItems = this.repo.list('tree_items', i => context.ancestorPaths.flat().includes(i.nodeId));
    const historicalIds = (session?.history ?? []).flatMap(h => ['understandings', 'methods', 'supplements'].flatMap(k => h.receipt?.[k]?.itemIds ?? []));
    const observedIds = new Set([...scopedItems.map(i => i.id), ...historicalIds]);
    const receipts = this.repo.list('tree_change_events', e => e.ordinal > (session?.appliedChangeOrdinal ?? 0) && e.entityIds.some(key => key.startsWith('tree_items:') && observedIds.has(key.slice(11)) || key === 'tree_nodes:' + nodeId || key === 'tree_turns:' + turnId));
    const rejectedOutputs = session ? this.repo.list('tree_jobs', j => j.role === 'learning' && j.nativeSessionId === session.sessionId && ['invalid_output', 'failed'].includes(j.status))
      .map(j => ({ jobId: j.id, turnId: j.trigger.turnId ?? null, state: j.status, adopted: false, error: j.error ?? null, rawHash: j.rawHash ?? null, nativeLogRef: j.nativeLogRef ?? null })) : [];
    const previousReceipt = session?.history?.at(-1)?.receipt ?? null;
    const input = { inputVersion: CONTRACT, role: 'learning', ...(compact ? { outputProtocol: this.outputProtocol } : {}), scope: { nodeIds: [nodeId], ancestorPaths: context.ancestorPaths, treeRevision: context.treeRevision }, sources, knownItems: rows.map(itemInput),
      allowedIds: { nodeIds: context.ancestorPaths.flat(), fileIds: annotations.fileIds ?? [], subjectIds: [...rows.map(r => r.item.id), ...observed.proposals.map(p => p.id), ...observed.fragments.map(f => f.id)] }, changeReceipts: receipts,
      ...(compact ? {} : { observationContext: { proposals: observed.proposals, fragments: observed.fragments } }),
      ...(compact ? { otherGoals } : {}), currentTurn: { id: turnId, sourceIds: material.sources.map(s => s.id), assignmentRevision: turn.assignmentRevision }, constraints: context.segments.filter(s => s.nodeId !== null),
      previousReceipt: rejectedOutputs.length ? { ...(previousReceipt ?? {}), rejectedOutputs } : previousReceipt, epochSeed: this.epochSeed(nodeId, session), rootOnly: nodeId === this.repo.rootId() };
    const revisionSet = { ['tree_turns:' + turnId]: turn.revision };
    for (const row of rows) revisionSet['tree_items:' + row.item.id] = row.item.revision;
    // Node changes invalidate scope, but ordinary newer settled turns need not
    // stale this input. TreeService separately marks affected jobs invalidated.
    const trigger = { kind: 'settled_main_turn', producerRole: 'main', status: 'settled', turnId, watermark: digest([turnId, turn.assignmentRevision]),
      ...((providerError || old?.trigger?.retriesProviderError || retried) ? { retriesProviderError: true } : {}),
      ...(old?.providerRejected ? { retriesProviderRejection: true } : {}), ...(refused ? { retriesPreDispatch: true } : {}), ...(moved ? { refreezesMove: true } : {}),
      ...(annotations.correction ? { correction: annotations.correction } : {}), ...(annotations.directRequirement ? { directRequirement: annotations.directRequirement } : {}) };
    return this.jobs.enqueue({ role: 'learning', key, nodeIds: [nodeId], input, revisionSet, config: this.config('learning', { turnId, nodeIds: [nodeId] }), trigger });
  }
  // A session restarted without a summary starts from its latest learning jobs
  // alone; every other session uses the verified summary seed.
  epochSeed(nodeId, session) {
    if (!session || session.summaryId !== null || session.contextEpoch === 1 || session.appendSeq > 0) return this.consolidation.learningSeed(nodeId);
    const recent = session.recentJobIds.map(id => this.jobs.get(id)).filter(job => job?.status === 'committed' && !job.invalidated && job.nodeIds[0] === nodeId).map(job => {
      const input = jsonClone(job.input); delete input.epochSeed; input.sources = input.sources.map(compactLearningSource);
      return { jobId: job.id, input, output: job.validatedResult, receipt: job.resultRef, nativeLogRef: job.nativeLogRef };
    });
    return { contextEpoch: session.contextEpoch, summary: null, recent, constraints: this.builder.build([nodeId], 'learning').segments };
  }
  // Goals a turn's learning may place a new item on: every active or paused
  // goal outside the turn's own path. A large tree gets no list at all.
  otherGoals(path) {
    const rows = this.repo.list('tree_nodes', n => !n.deleted && ['active', 'paused'].includes(n.status) && !path.includes(n.id));
    if (rows.length > OTHER_GOALS_LIMIT) return [];
    return rows.sort((a, b) => a.id.localeCompare(b.id)).map(n => ({ id: n.id, name: n.name, oneLine: this.builder.summary(n)?.oneLine ?? '', path: this.repo.ancestors(n.id).map(a => a.name) }));
  }
  // Split placed items off the proposal. A placement whose goal is no longer
  // usable keeps its item on the turn's goal and is reported.
  placements(selected, job) {
    const own = job.nodeIds[0], path = job.input.scope.ancestorPaths.flat(), listed = new Set((job.input.otherGoals ?? []).map(g => g.id));
    const replaced = new Set((selected.revisions ?? []).map(r => r.replacedByIndex)), groups = new Map(), issues = [], moved = { understanding: new Set(), method: new Set() };
    for (const p of job.input.outputProtocol === 'experience-v1' ? selected.placements ?? [] : []) {
      const node = this.repo.get('tree_nodes', p.goalId), list = p.kind === 'understanding' ? selected.understandings : selected.methods;
      const problem = !list?.[p.index] || p.kind === 'understanding' && replaced.has(p.index) ? 'PLACEMENT_ITEM'
        : !listed.has(p.goalId) || path.includes(p.goalId) ? 'PLACEMENT_GOAL'
        : !node || node.deleted || !['active', 'paused'].includes(node.status) ? 'PLACEMENT_GOAL_CLOSED' : null;
      if (problem) { issues.push({ code: problem, goalId: p.goalId, itemKind: p.kind, index: p.index }); continue; }
      if (!groups.has(p.goalId)) groups.set(p.goalId, { understandings: [], methods: [], reasons: [] });
      const group = groups.get(p.goalId);
      group[p.kind === 'understanding' ? 'understandings' : 'methods'].push(list[p.index]); group.reasons.push({ kind: p.kind, reason: p.reason });
      moved[p.kind].add(p.index);
    }
    const keep = (rows, set) => rows.filter((_, i) => !set.has(i));
    const shift = index => index - [...moved.understanding].filter(i => i < index).length;
    const ownSelected = { ...selected, understandings: keep(selected.understandings ?? [], moved.understanding), methods: keep(selected.methods ?? [], moved.method),
      revisions: (selected.revisions ?? []).map(r => ({ ...r, replacedByIndex: shift(r.replacedByIndex) })) };
    delete ownSelected.placements;
    return { own, ownSelected, groups, issues };
  }
  applyResult(result, { job, requestId }) {
    const output = validateOutput('learning', result, job.input), turn = this.repo.get('tree_turns', job.trigger.turnId);
    if (turn?.status !== 'settled' || !turn.nodeIds.includes(job.nodeIds[0]) || turn.assignmentRevision !== job.input.currentTurn.assignmentRevision) fail('JOB_STALE', 'Experience assignment changed');
    // experience-v1 output was bounded item by item when it was parsed: at most
    // three new understandings, two source-quoted changes and one method that
    // cites this turn's user input. Older protocols keep the single-correction
    // rule: an ordinary statement or a model inference alone is not saved.
    const selected = job.input.outputProtocol === 'experience-v1' ? { ...output, supplements: [] } : { ...output, understandings: [], methods: [], supplements: [], revisions: [], developments: [] };
    if (job.input.outputProtocol !== 'experience-v1') {
      const revision = output.revisions.find(value => value.correctionEvidence?.quotes?.length || job.trigger.correction?.itemIds?.includes(value.targetId));
      if (revision) {
        selected.understandings = [output.understandings[revision.replacedByIndex]];
        selected.revisions = [{ ...revision, replacedByIndex: 0 }];
      } else if (output.correctionClaim) {
        const { kind, quote } = output.correctionClaim;
        quotedSource(job.input, quote, 'user');
        const partition = kind === 'understanding' ? 'understandings' : 'methods';
        const item = output[partition].find(value => value.sourceIds.includes(quote.sourceId));
        if (item) selected[partition] = [item];
      }
    }
    const { ownSelected, groups, issues } = this.placements(selected, job);
    return this.repo.transaction(() => {
      const items = itemServiceFor(this.repo, this.resolveSource, job, learningCorrections(ownSelected, job.input)), input = proposalInput(ownSelected, job.input);
      const receipt = items.commitProposal({ requestId: digest([requestId, 'items']), expected: job.inputRevisionSet, input }).result;
      const placed = [...groups].map(([goalId, group]) => {
        const service = new ItemService({ repository: this.repo, resolveSource: this.resolveSource, context: () => ({ actor: { kind: 'model', id: job.id, role: job.role }, nodeIds: [goalId] }) });
        const proposal = { ...proposalInput({ understandings: group.understandings, methods: group.methods, supplements: [], revisions: [] }, job.input), nodeId: goalId };
        return { goalId, reasons: group.reasons, receipt: service.commitProposal({ requestId: digest([requestId, 'placed', goalId]), expected: {}, input: proposal }).result };
      });
      const categories = this.signals.recordCategories(output.categories, { job, requestId });
      // Per-turn learning is limited to corrections and feedback categories.
      // Do not promote model-extracted proposals, results or decisions into
      // additional observation records; old records remain available to read.
      const methodIds = receipt.methods.itemIds ?? [];
      this.repo.command('recordLearningOrigins', { requestId, expected: {}, input: { jobId: job.id, receipt, categories, ...(placed.length || issues.length ? { placed, issues } : {}) } }, program, () => {
        for (const partition of ['understandings', 'methods', 'supplements']) for (const id of receipt[partition].itemIds ?? []) {
          const item = this.repo.get('tree_items', id); this.repo.save('tree_items', { ...item, producerJobId: job.id, producerRole: 'learning', sourceTurnId: turn.id }, item.revision);
        }
        for (const { goalId, reasons, receipt: placedReceipt } of placed) for (const [partition, kind] of [['understandings', 'understanding'], ['methods', 'method']]) for (const id of placedReceipt[partition]?.itemIds ?? []) {
          const item = this.repo.get('tree_items', id);
          this.repo.save('tree_items', { ...item, producerJobId: job.id, producerRole: 'learning', sourceTurnId: turn.id, placedFromNodeId: job.nodeIds[0], placementReason: reasons.find(r => r.kind === kind)?.reason ?? null }, item.revision);
        }
        if (issues.length) {
          const meta = this.repo.meta(), diagnostics = { ...meta.runtimeDiagnostics };
          for (const issue of issues) { const value = { kind: 'learning_placement', ...issue, message: 'The item stayed on the turn\'s goal', jobId: job.id, nodeId: job.nodeIds[0] }; diagnostics[digest(value)] = { ...value, at: this.repo.now() }; }
          this.repo.save('tree_meta', { ...meta, runtimeDiagnostics: diagnostics }, meta.revision);
        }
        for (const intent of this.repo.list('tree_jobs', j => !j.role && j.kind === 'learning' && j.scopeKey === job.nodeIds[0] && j.input.turnId === turn.id && j.input.assignmentRevision === turn.assignmentRevision && j.status === 'queued')) this.repo.save('tree_jobs', { ...intent, status: 'committed', ownedJobId: job.id }, intent.revision);
        const meta = this.repo.meta();
        if (!meta.progressEvidence?.[turn.id]) this.repo.save('tree_meta', { ...meta, progressEvidence: { ...meta.progressEvidence, [turn.id]: { turnId: turn.id, assignmentRevision: turn.assignmentRevision,
          sourceRefs: this.experience.material(turn).sources.filter(s => s.role === 'assistant' && s.origin === 'model' || s.role === 'tool').map(s => s.ref), state: 'unclassified', confirmedOutputs: [], confirmedDecisions: [] } } }, meta.revision);
        return { receipt, categories };
      });
      if (!this.writers && methodIds.some(id => this.repo.get('tree_items', id).lifecycle === 'draft')) fail('WRITER_ROUTER_REQUIRED', 'Script proposals require the owned writer router');
      const writerJobs = this.writers ? methodIds.flatMap(id => this.writers.enqueueDraft(id, job).map(j => j.id)) : [];
      return { ...receipt, categories, writerJobs, ...(placed.length ? { placed: placed.map(p => ({ goalId: p.goalId, understandings: p.receipt.understandings, methods: p.receipt.methods })) } : {}) };
    });
  }
}

/** Routes script creation only. Execution remains the separate native main tool. */
export class WriterRouter {
  constructor({ repository, jobs, modelConfig, artifacts, createWriterOptions, defineTool }) { Object.assign(this, { repo: repository, jobs, config: modelConfig, artifacts, createWriterOptions, defineTool }); this.instances = new Map(); }
  request(input, { job, callId, nodeId, exposureId }) {
    // B7 supplies these identities after validating the live native main call.
    // Neither the model tool arguments nor generated files select an owner.
    if (job.role !== 'main' || !job.nodeIds.includes(nodeId) || !callId) fail('MAIN_REQUIRED', 'An admitted native main call in this node is required');
    this.jobs.assertCurrent(job);
    const requestId = digest(['main-script-request', job.id, callId]), old = this.repo.get('tree_receipts', digest(['receipt', requestId]));
    if (old) { if (old.result.requestHash !== digest(input)) fail('IDEMPOTENCY_CONFLICT', 'Native script request changed'); return old.result; }
    const sourceRefs = resolveSourceIds(input.evidenceIds, job.input);
    if (!sourceRefs.length) fail('WRITER_REQUEST_SOURCE', 'evidenceIds must include a current evidence id');
    if (input.fileRefs.some(id => !job.input.allowedIds.fileIds?.includes(id))) fail('WRITER_REQUEST_SOURCE', 'fileRefs accepts only supplied logical file ids, not paths. If no file ids were supplied use []; describe workspace paths in purpose for the author to inspect.');
    const scriptRequest = { purpose: input.purpose, evidence: input.evidenceIds, files: input.fileRefs };
    const service = new ItemService({ repository: this.repo, resolveSource: this.artifacts.resolveSource, context: () => ({ actor: program }) });
    return this.repo.transaction(() => {
      let methodId = input.methodId;
      if (methodId) {
        const item = this.repo.get('tree_items', methodId);
        if (!item || item.nodeId !== nodeId || item.kind !== 'method' || item.lifecycle !== 'active' || item.activeVersion !== input.expectedVersion || item.userProtected) fail('METHOD_REQUEST_SCOPE', 'Existing script request must target an own current unprotected method');
        const version = this.repo.get('tree_item_versions', digest(['item_version', item.id, item.activeVersion]));
        service.review({ requestId: digest([requestId, 'draft']), expected: { ['tree_items:' + item.id]: item.revision }, input: { itemId: item.id, version: item.activeVersion, exposureId, operation: 'rewrite', reason: '当前主轮请求制作脚本', sourceRefs,
          windowId: requestId, opportunityRefs: [], replacement: { ...version.content, scriptRequests: [scriptRequest] } } });
      } else {
        const proposed = { kind: 'technique', short: null, long: { name: '当前明确请求的脚本', description: '按当前委托制作并提供调用说明', whenToUse: '', steps: input.purpose, pitfalls: '', verify: '' }, hooks: [], scriptRequests: [scriptRequest],
          expectedEffect: { category: 'omitted', change: 'less', text: '当前明确要求的脚本可供调用' }, sourceRefs };
        const receipt = service.commitProposal({ requestId: digest([requestId, 'draft']), expected: {}, input: { nodeId, understandings: [], methods: [proposed], supplements: [] } }).result;
        if (receipt.methods.status !== 'applied') fail('SCRIPT_REQUEST_INVALID', receipt.methods.reason); methodId = receipt.methods.itemIds[0];
      }
      const jobs = this.enqueueDraft(methodId, job, { explicit: true });
      return this.repo.command('requestMethodScript', { requestId, expected: {}, input }, program, () => ({ methodId, jobId: jobs[0].id, state: 'queued', requestHash: digest(input) })).result;
    });
  }
  enqueueDraft(methodId, parentJob, { explicit = false } = {}) {
    const item = this.repo.get('tree_items', methodId); if (!item || item.lifecycle !== 'draft') return [];
    const bundle = this.repo.get('tree_methods', digest(['method', methodId, item.draftVersion]));
    return bundle.pendingScriptRequests.map((request, requestIndex) => {
      const key = digest(['write-method-script', methodId, item.draftVersion, requestIndex]), prior = this.repo.get('tree_jobs', digest(['model_job', 'script_writer', key])); if (prior) return prior;
      // Writers need the original evidence, not the learning input's reference.
      const sources = parentJob.input.sources.filter(s => request.evidence.includes(s.id)).map(s => s.elided ? this.resolveSource(s.ref) ?? s : s);
      if (sources.length !== new Set(request.evidence).size || !sources.length || request.files.some(id => !parentJob.input.allowedIds.fileIds?.includes(id))) fail('WRITER_REQUEST_SOURCE', 'Script request must bind its source and allowed file references');
      const binding = { methodId, draftVersion: item.draftVersion, requestIndex, scriptId: digest(['method-script', methodId, item.draftVersion, requestIndex]), version: 1 };
      return this.jobs.enqueue({ role: 'script_writer', key, nodeIds: [item.nodeId], revisionSet: { ['tree_items:' + item.id]: item.revision }, config: this.config('script_writer', { parentJobId: parentJob.id, nodeIds: [item.nodeId] }),
        trigger: { kind: explicit ? 'explicit_script_request' : 'learned_script_request', producerRole: parentJob.role, methodId, parentJobId: parentJob.id },
        input: { scope: { nodeIds: [item.nodeId], ancestorPaths: [this.repo.ancestors(item.nodeId).map(n => n.id)], treeRevision: this.repo.meta().treeRevision }, sources, knownItems: [], allowedIds: { nodeIds: [item.nodeId], fileIds: request.files, subjectIds: [] }, changeReceipts: [], request, binding } });
    });
  }
  writer(job) {
    if (job.role !== 'script_writer') fail('WRITER_BINDING', 'Only an owned writer job may mount these tools');
    let writer = this.instances.get(job.id);
    if (!writer) {
      const options = this.createWriterOptions(job);
      writer = new ScriptWriter({ ...options, repository: this.repo, artifacts: this.artifacts, binding: { ...job.input.binding, jobId: job.id }, assertJob: id => {
        const current = this.jobs.get(id); this.jobs.assertCurrent(current); return ['prepared', 'submitted', 'result_received', 'validated', 'committed'].includes(current.status);
      } }); this.instances.set(job.id, writer);
    }
    return writer;
  }
  mount(agentContext, job) { this.writer(job).mount(agentContext, this.defineTool); }
  applyResult(output, { job }) { return this.writer(job).verifyFinal(output); }
  activateReady(methodId, draftVersion) {
    const item = this.repo.get('tree_items', methodId);
    if (item?.lifecycle === 'active' && item.activeVersion === draftVersion + 1) return { itemId: item.id, version: item.activeVersion, duplicate: true };
    if (!item || item.lifecycle !== 'draft' || item.draftVersion !== draftVersion) fail('JOB_STALE', 'Method draft changed before activation');
    const bundle = this.repo.get('tree_methods', digest(['method', methodId, draftVersion]));
    const jobs = bundle.pendingScriptRequests.map((_, index) => this.repo.get('tree_jobs', digest(['model_job', 'script_writer', digest(['write-method-script', methodId, draftVersion, index])])));
    if (jobs.some(j => !j || j.status !== 'committed')) return { itemId: methodId, state: jobs.some(j => j?.status === 'unknown') ? 'unknown' : jobs.some(j => ['failed', 'invalid_output', 'stale', 'cancelled'].includes(j?.status)) ? 'failed' : 'queued' };
    return this.artifacts.activate({ methodId, draftVersion, artifactIds: jobs.map(j => j.resultRef.artifactId), requestId: digest(['activate-method-scripts', methodId, draftVersion]) }).result;
  }
}
