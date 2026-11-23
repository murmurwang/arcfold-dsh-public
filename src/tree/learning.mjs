import { CONTRACT, canonicalJson, digest, fail, jsonClone, sourceRefs } from './contracts.mjs';
import { ItemService } from './items.mjs';
import { validateOutput, resolveSourceIds } from './prompts.mjs';
import { ScriptWriter } from './script-writer.mjs';
import { learningCorrections, LearningObservations, quotedSource } from './observations.mjs';
import { MetricsService } from './metrics.mjs';
import { deferredLearning, interruptedLearning, movedLearning, preDispatchLearning } from './jobs.mjs';
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

export class LearningService {
  constructor({ repository, experience, contextBuilder, consolidation, jobs, modelConfig, signals, writerRouter, annotations = () => ({}), outputProtocol = 'experience-v1' }) {
    Object.assign(this, { repo: repository, experience, builder: contextBuilder, consolidation, jobs, config: modelConfig, signals, writers: writerRouter, annotations, outputProtocol });
    this.resolveSource = contextBuilder.resolveSource;
    this.observations = new LearningObservations({ repository, metrics: new MetricsService({ repository, experience, signals }) });
  }
  existing(turn, nodeId) {
    return this.repo.list('tree_jobs', j => j.role === 'learning' && j.trigger.turnId === turn.id && j.nodeIds[0] === nodeId && j.input.currentTurn.assignmentRevision === turn.assignmentRevision)
      .sort((a, b) => b.enqueuedOrder - a.enqueuedOrder || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
  }
  enqueue(turnId, nodeId) {
    const turn = this.repo.get('tree_turns', turnId);
    if (!turn || turn.status !== 'settled' || !turn.nodeIds.includes(nodeId)) fail('LEARNING_EXPERIENCE', 'Learning needs a settled own main turn');
    const baseKey = digest(['turn-learning', turnId, nodeId, turn.assignmentRevision]), old = this.existing(turn, nodeId);
    let session = this.repo.list('tree_learning_sessions', s => s.nodeId === nodeId)[0];
    // Only an append stopped before submission, or one the provider refused
    // for context size without output, may be frozen again after the epoch
    // changes. A request interrupted by a host stop before it was released is
    // frozen again at once. Paid/unknown and ordinary failures never retry.
    const deferred = deferredLearning(old), interrupted = interruptedLearning(old), refused = preDispatchLearning(old), moved = movedLearning(old);
    // A refused append cannot go back into the same native session: its
    // position is already taken. Start a new session first (once per turn).
    if (refused && !session?.paused && session?.contextEpoch === old.contextEpoch) session = this.jobs.restartEpoch(nodeId);
    const ready = interrupted || moved ? !session?.paused : (deferred || refused) && !session?.paused && session?.contextEpoch > old.contextEpoch;
    if (old && !ready) return old;
    const key = !old ? baseKey : interrupted ? digest(['interrupted-learning', baseKey, old.id]) : refused ? digest(['pre-dispatch-learning', baseKey, old.id])
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
      currentTurn: { id: turnId, sourceIds: material.sources.map(s => s.id), assignmentRevision: turn.assignmentRevision }, constraints: context.segments.filter(s => s.nodeId !== null),
      previousReceipt: rejectedOutputs.length ? { ...(previousReceipt ?? {}), rejectedOutputs } : previousReceipt, epochSeed: this.epochSeed(nodeId, session), rootOnly: nodeId === this.repo.rootId() };
    const revisionSet = { ['tree_turns:' + turnId]: turn.revision };
    for (const row of rows) revisionSet['tree_items:' + row.item.id] = row.item.revision;
    // Node changes invalidate scope, but ordinary newer settled turns need not
    // stale this input. TreeService separately marks affected jobs invalidated.
    const trigger = { kind: 'settled_main_turn', producerRole: 'main', status: 'settled', turnId, watermark: digest([turnId, turn.assignmentRevision]),
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
    return this.repo.transaction(() => {
      const items = itemServiceFor(this.repo, this.resolveSource, job, learningCorrections(selected, job.input)), input = proposalInput(selected, job.input);
      const receipt = items.commitProposal({ requestId: digest([requestId, 'items']), expected: job.inputRevisionSet, input }).result;
      const categories = this.signals.recordCategories(output.categories, { job, requestId });
      // Per-turn learning is limited to corrections and feedback categories.
      // Do not promote model-extracted proposals, results or decisions into
      // additional observation records; old records remain available to read.
      const methodIds = receipt.methods.itemIds ?? [];
      this.repo.command('recordLearningOrigins', { requestId, expected: {}, input: { jobId: job.id, receipt, categories } }, program, () => {
        for (const partition of ['understandings', 'methods', 'supplements']) for (const id of receipt[partition].itemIds ?? []) {
          const item = this.repo.get('tree_items', id); this.repo.save('tree_items', { ...item, producerJobId: job.id, producerRole: 'learning', sourceTurnId: turn.id }, item.revision);
        }
        for (const intent of this.repo.list('tree_jobs', j => !j.role && j.kind === 'learning' && j.scopeKey === job.nodeIds[0] && j.input.turnId === turn.id && j.input.assignmentRevision === turn.assignmentRevision && j.status === 'queued')) this.repo.save('tree_jobs', { ...intent, status: 'committed', ownedJobId: job.id }, intent.revision);
        const meta = this.repo.meta();
        if (!meta.progressEvidence?.[turn.id]) this.repo.save('tree_meta', { ...meta, progressEvidence: { ...meta.progressEvidence, [turn.id]: { turnId: turn.id, assignmentRevision: turn.assignmentRevision,
          sourceRefs: this.experience.material(turn).sources.filter(s => s.role === 'assistant' && s.origin === 'model' || s.role === 'tool').map(s => s.ref), state: 'unclassified', confirmedOutputs: [], confirmedDecisions: [] } } }, meta.revision);
        return { receipt, categories };
      });
      if (!this.writers && methodIds.some(id => this.repo.get('tree_items', id).lifecycle === 'draft')) fail('WRITER_ROUTER_REQUIRED', 'Script proposals require the owned writer router');
      const writerJobs = this.writers ? methodIds.flatMap(id => this.writers.enqueueDraft(id, job).map(j => j.id)) : [];
      return { ...receipt, categories, writerJobs };
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
