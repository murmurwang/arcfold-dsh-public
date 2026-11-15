import { worksForDelivery, assertWork, relationState } from './goal-work.mjs';
import { assertNativeContinuationStored } from './native-continuation.mjs';
// Business-only migration of 3.0 learning.mjs material/commitSection/save*.
// DSH and the host own execution, retries, dispatch identities and durability.
import { canonicalJson, identity } from './store.mjs';
import { messageText } from './business.mjs';
import { sourceText, evidenceProvenance } from './evidence.mjs';
import { pauseMethod } from './method-lifecycle.mjs';
import { usageForVersion } from './methods.mjs';
import { GoalService, goalRepairAllowed } from './goals.mjs';
import { ContractError, digest, clone, LEARN_PROMPT, LEARN_SCHEMA, LEARN_SECTIONS,
  parseLearn, assertVisibleSources, requiresUserSource, projectUnderstanding } from './learning-contracts.mjs';
import { applyGoalChanges, invalidateDependents } from './learning-goals.mjs';

export { LEARN_PROMPT, LEARN_SCHEMA } from './learning-contracts.mjs';
const groupName = kind => 'existing' + kind[0].toUpperCase() + kind.slice(1);
const unavailable = row => !row || row.deleted || row.withdrawn || row.useProhibited ||
  ['withdrawn', 'superseded', 'rejected', 'dismissed'].includes(row.status);
const atSequence = (row, cutoff) => Number.isSafeInteger(row?.createdSequence) &&
  Number.isSafeInteger(row.updatedSequence) && row.createdSequence <= cutoff && row.updatedSequence <= cutoff;
const fail = (code, message) => { throw new ContractError(code, message); };
const recordRef = (kind, record) => ({ kind, id: record.id, revision: record.revision, hash: digest(record) });
const errorView = error => ({ code: error.code || 'learning_commit_failed', message: error.message,
  ...(error.details ? { details: error.details } : {}) });

function sourceCurrent(store, source) {
  const control = source && store.get('source_controls', source.id);
  return !unavailable(source) && !unavailable(control || {}) && control?.status !== 'paused';
}

function sourceBefore(store, source, boundary) {
  if (!sourceCurrent(store, source) || !atSequence(source, boundary.sequence)) return false;
  const ref = source.provenance?.sourceRef;
  if (ref?.sessionId === boundary.sessionId && ref.seq > boundary.throughSeq) return false;
  return typeof source.occurredAt === 'string' && Number.isFinite(Date.parse(source.occurredAt)) &&
    Date.parse(source.occurredAt) <= Date.parse(boundary.occurredAt);
}

// Unlike a method dependency, a paused goal root can still be discussed.
function evidenceBundle(store, row, kind, boundary, path = new Set()) {
  const key = `${kind}:${row?.id}`;
  const rejected = kind === 'opportunities'
    ? !row || row.deleted || row.withdrawn || row.useProhibited : unavailable(row);
  if (rejected || row.status === 'paused' && !['goals', 'opportunities'].includes(kind) ||
      !atSequence(row, boundary.sequence) || path.has(key) ||
      !Array.isArray(row.sourceIds) || !row.sourceIds.length) return null;
  const next = new Set([...path, key]), sources = new Map(), records = new Map([[key, recordRef(kind, row)]]);
  for (const id of row.sourceIds) {
    const source = store.get('events', id);
    if (!sourceBefore(store, source, boundary)) return null;
    sources.set(id, source);
  }
  for (const ref of row.dependencies || []) {
    const depKind = ref.kind || ['events', 'understandings', 'methods'].find(k => store.get(k, ref.id));
    if (!['events', 'understandings', 'methods'].includes(depKind)) return null;
    const dependency = store.get(depKind, ref.id);
    if (!dependency || dependency.revision !== ref.revision) return null;
    if (depKind === 'events') {
      if (!sourceBefore(store, dependency, boundary)) return null;
      sources.set(dependency.id, dependency);
    } else {
      const nested = evidenceBundle(store, dependency, depKind, boundary, next);
      if (!nested) return null;
      for (const source of nested.sources) sources.set(source.id, source);
      for (const version of nested.records) records.set(`${version.kind}:${version.id}`, version);
    }
  }
  return { sources: [...sources.values()], records: [...records.values()] };
}

function sourceView(source) {
  return { id: source.id, revision: source.revision, role: source.role,
    content: source.message ? messageText(source.message) : sourceText(source),
    occurredAt: source.occurredAt, conversationId: source.conversationId ?? null,
    provenance: evidenceProvenance(source.provenance),
    ...(source.message?.content.some(block => !['text', 'reasoning'].includes(block.type))
      ? { nonTextBlocks: source.message.content.filter(block => !['text', 'reasoning'].includes(block.type)) } : {}),
    ...(source.role === 'assistant' ? { contentAuthor: 'assistant', userEndorsement: 'not_established_by_this_record' } : {}) };
}

function toolTrace(source) {
  return source.role === 'tool' ? { id: source.id, sourceId: source.id,
    toolCallId: source.message?.toolCallId ?? null, isError: source.message?.isError === true } : null;
}

export class LearningService {
  constructor({ business, maxCharacters = 180000 }) {
    if (!business?.storage || !Number.isSafeInteger(maxCharacters) || maxCharacters < 1000 || maxCharacters > 180000)
      throw new ContractError('invalid_learning_config', '需要业务存储和有效材料容量');
    this.business = business; this.store = business.storage; this.maxCharacters = maxCharacters;
  }

  prepare(pendingId) {
    identity(pendingId, 'Pending learning id');
    return this.store.transaction(() => {
      const existing = this.store.get('learning_inputs', pendingId);
      if (existing) {
        this.assertInput(existing);
        this.assertVersions(existing);
        return existing;
      }
      const pending = this.store.get('learning_pending', pendingId);
      if (!pending || pending.status !== 'pending') fail('invalid_learning_pending', '没有尚待处理的学习业务记录');
      const delivery = this.store.get('deliveries', pending.deliveryId);
      if (!delivery || delivery.kind !== 'formal_reply' || delivery.sessionId !== pending.sessionId ||
          delivery.throughSeq !== pending.throughSeq) fail('invalid_learning_delivery', '学习须对应真实正式交付');
      const boundary = { sequence: delivery.createdSequence, sessionId: delivery.sessionId,
        throughSeq: delivery.throughSeq, occurredAt: delivery.occurredAt };
      const sources = new Map(), versions = new Map();
      if (delivery.nativeContinuation) assertNativeContinuationStored(this.store, delivery.nativeContinuation);
      for (const id of [...new Set([...delivery.sourceEventIds,
        ...((delivery.nativeContinuation?.activeDelegation ?? delivery.nativeContinuation?.initialDelegation)?.sourceIds || [])])]) {
        const source = this.store.get('events', id);
        if (!sourceBefore(this.store, source, boundary)) fail('source_changed', '正式交付原件已失效或越过截止');
        sources.set(id, source);
      }
      if (!sources.has(delivery.eventId)) fail('invalid_learning_delivery', '正式回复原件缺失');
      const material = { version: 'arcfold-dsh-learning-v1', pendingId, sessionId: delivery.sessionId,
        deliveryId: delivery.id, deliveredAnswerId: delivery.eventId,
        inputEventIds: delivery.inputEventIds, inputEventId: delivery.inputEventIds.at(-1) || null,
        boundary, authority: 'answer-already-delivered; source-grounded-business-interpretations; no-native-execution-or-user-endorsement-authority',
        ...(delivery.nativeContinuation ? { nativeContinuation: delivery.nativeContinuation } : {}),
        sources: [], existingUnderstandings: [], existingMethods: [], existingOpportunities: [], existingGoals: [],
        coverage: {}, toolReceipts: [], backgroundAtTurnEnd: delivery.backgroundAtTurnEnd };
      for (const kind of LEARN_SECTIONS) {
        const coverage = material.coverage[kind] = { available: 0, included: 0, omitted: 0 };
        for (const row of this.store.listAll(kind)) {
          if (row.scope?.conversationId && row.scope.conversationId !== delivery.sessionId ||
              kind === 'opportunities' && row.conversationId !== delivery.sessionId) continue;
          coverage.available++;
          const validStatus = kind === 'understandings' ? row.status === 'active'
            : kind === 'methods' ? ['trial', 'active'].includes(row.status) : true;
          const bundle = validStatus && evidenceBundle(this.store, row, kind, boundary);
          if (!bundle) { coverage.omitted++; continue; }
          for (const source of bundle.sources) sources.set(source.id, source);
          for (const ref of bundle.records) versions.set(`${ref.kind}:${ref.id}`, ref);
          // Progress and each relationship have their own sources and versions.
          const view = clone(row);
          // Usage is a projection of adoption receipts, never a method revision.
          if (kind === 'methods') view.trialUses = usageForVersion(this.store, row, { cutoffSequence: boundary.sequence }).trialUses;
          if (kind === 'goals') {
            const validPart = part => {
              if (!part) return false;
              if (!part.sourceIds?.length) return part.content === '';
              const partBundle = evidenceBundle(this.store, { ...part, id: `part:${row.id}`,
                createdSequence: row.createdSequence, updatedSequence: row.updatedSequence }, 'goal_part', boundary);
              if (!partBundle) return false;
              for (const source of partBundle.sources) sources.set(source.id, source);
              for (const ref of partBundle.records.filter(ref => ref.kind !== 'goal_part')) versions.set(`${ref.kind}:${ref.id}`, ref);
              return true;
            };
            if (!validPart(view.progress)) view.progress = null;
            view.relations = (view.relations || []).filter(validPart).map(relation => {
              const target = this.store.get('goals', relation.targetId);
              return { ...relation, state: unavailable(target) ? 'unavailable'
                : target.definitionVersion !== relation.targetDefinitionVersion ||
                  (relation.sourceDefinitionVersion ?? row.definitionVersion) !== row.definitionVersion ? 'needs_review' : 'current' };
            });
          }
          material[groupName(kind)].push(view); coverage.included++;
        }
      }
      const goals = new GoalService({ business: this.business });
      const inputMessageIds = delivery.inputEventIds.map(id => this.store.get('events', id)?.message?.id).filter(Boolean);
      material.goalDiscussions = goals.discussions({ sessionId: delivery.sessionId, inputMessageIds,
        cutoffSequence: boundary.sequence }).map(binding => {
        const source = this.store.get('events', binding.sourceId);
        if (!material.inputEventIds.includes(source?.id) || !sourceBefore(this.store, source, boundary))
          fail('source_changed', '目标讨论没有本次真实用户原件');
        // Admission status is a later transport observation, not mutable user intent.
        versions.set(`goal_discussions:${binding.id}`, { kind: 'goal_discussions', id: binding.id,
          requestHash: binding.requestHash });
        if (binding.mode === 'repair') {
          const goal = this.store.get('goals', binding.goalId);
          if (!goalRepairAllowed(goal) || !atSequence(goal, boundary.sequence))
            fail('source_changed', '目标修复资格已改变');
          material.existingGoals = material.existingGoals.filter(row => row.id !== goal.id);
          material.existingGoals.push({ id: goal.id, revision: goal.revision,
            definitionVersion: goal.definitionVersion, status: goal.status, repairOnly: true,
            reason: goal.sourceInvalidation.reason || 'source_dependency', repairSourceId: source.id });
          versions.set(`goals:${goal.id}`, recordRef('goals', goal));
        }
        return { id: binding.id, goalId: binding.goalId, goalRevision: binding.goalRevision,
          definitionVersion: binding.definitionVersion, mode: binding.mode,
          sourceId: source.id, messageId: binding.messageId };
      });
      material.goalLinks = this.store.listAll('goal_links', { where: { sessionId: delivery.sessionId,
        startSeq: delivery.startSeq } }).flatMap(link => {
        if (link.turn !== delivery.turn || link.createdSequence > boundary.sequence) return [];
        goals.assertCore(link);
        const outcome = this.store.get('goal_link_outcomes', link.id);
        // The immutable association predates delivery; only this exact derived
        // end reference may have been saved after delivery.createdSequence.
        if (!outcome || outcome.deliveryId !== delivery.id || outcome.coreHash !== link.coreHash ||
            outcome.sessionId !== delivery.sessionId || outcome.turn !== delivery.turn ||
            outcome.startSeq !== delivery.startSeq || outcome.endEventId !== delivery.endEventId) return [];
        versions.set(`goal_links:${link.id}`, recordRef('goal_links', link));
        versions.set(`goal_link_outcomes:${link.id}`, recordRef('goal_link_outcomes', outcome));
        const entry = { linkId: link.id, goalId: link.goalId, goalRevision: link.goalRevision,
          definitionVersion: link.definitionVersion, deliveryId: delivery.id, outcome: outcome.outcome,
          contributionEffect: 'not_assessed', claimType: 'assistant_inference' };
        const records = [link.bundle.goal, ...link.bundle.relatedGoals];
        const current = records.every(shown => {
          const row = this.store.get('goals', shown.id);
          return row?.revision === shown.revision && atSequence(row, boundary.sequence) &&
            (shown.repairOnly ? goalRepairAllowed(row) : Boolean(evidenceBundle(this.store, row, 'goals', boundary)));
        }) && link.bundle.sources.every(shown => {
          const row = this.store.get('events', shown.id);
          return row?.revision === shown.revision && sourceBefore(this.store, row, boundary);
        });
        if (!current) return [{ ...entry, availability: 'source_or_definition_changed', selection: null }];
        for (const shown of link.bundle.sources) sources.set(shown.id, this.store.get('events', shown.id));
        for (const shown of records) versions.set(`goals:${shown.id}`, recordRef('goals', this.store.get('goals', shown.id)));
        return [{ ...entry, availability: 'current', selection: link.selection,
          inputEvidence: this.store.listAll('goal_inputs', { where: { linkId: link.id } })
            .filter(row => row.createdSequence <= boundary.sequence)
            .map(({ id, step, requestIdentity, inputHash, evidence }) => ({ id, step, requestIdentity, inputHash, evidence })) }];
      });
      material.goalWorks = worksForDelivery(this.store, delivery).map(work => {
        assertWork(this.store, work);
        if (!work.state) fail('goal_work_changed', '工作缺少截止前的原生状态');
        for (const id of work.sourceIds) {
          const source = this.store.get('events', id);
          if (!sourceBefore(this.store, source, boundary)) fail('source_changed', '工作委托来源不在此次交付截止内');
          sources.set(id, source);
        }
        versions.set('goal_works:' + work.id, recordRef('goal_works', this.store.get('goal_works', work.id)));
        return { id: work.id, sessionId: work.sessionId, nativeGoalId: work.nativeGoalId,
          ...work.state, id: work.id, relationId: work.relationId,
          relation: relationState(this.store, work, work.relationId && this.store.get('goal_work_links', work.relationId), work.state),
          sourceIds: work.sourceIds,
          originKind: work.originKind, authority: 'historical-work-facts; no-new-permission' };
      });
      material.sources = [...sources.values()].sort((a, b) => a.createdSequence - b.createdSequence).map(sourceView);
      material.toolReceipts = [...sources.values()].map(toolTrace).filter(Boolean);
      material.existingUnderstandings = material.existingUnderstandings.map(row => projectUnderstanding(row, material.sources));
      for (const source of sources.values()) {
        versions.set(`events:${source.id}`, recordRef('events', source));
        const control = this.store.get('source_controls', source.id);
        versions.set(`source_controls:${source.id}`, { kind: 'source_controls', id: source.id,
          revision: control?.revision ?? null, hash: control ? digest(control) : null });
      }
      const inputText = JSON.stringify(material);
      if (LEARN_PROMPT.length + inputText.length > this.maxCharacters ||
          Buffer.byteLength(LEARN_PROMPT + inputText) > 512000)
        fail('learning_capacity', '完整学习材料超过容量，未截断原件或冻结部分输入');
      return this.store.save('learning_inputs', { id: pendingId, pendingId, deliveryId: delivery.id,
        material, versions: [...versions.values()], prompt: LEARN_PROMPT, schema: LEARN_SCHEMA,
        inputText, inputHash: digest(inputText), materialHash: digest(material), promptHash: digest(LEARN_PROMPT) });
    });
  }

  assertInput(input) {
    if (input.inputText !== JSON.stringify(input.material) || input.inputHash !== digest(input.inputText) ||
        input.materialHash !== digest(input.material) || input.promptHash !== digest(input.prompt))
      fail('learning_input_changed', '冻结学习输入身份不一致');
  }

  ownChanges(pendingId) {
    const changes = new Map();
    for (const section of this.store.listAll('learning_sections', { where: { pendingId } }))
      if (section.status === 'completed') for (const change of section.changes) changes.set(`${change.kind}:${change.id}`, change);
    return changes;
  }

  assertVersions(input) {
    if (input.material.nativeContinuation) assertNativeContinuationStored(this.store, input.material.nativeContinuation);
    const own = this.ownChanges(input.pendingId);
    for (const ref of input.versions) {
      if (ref.kind === 'goal_discussions') {
        const current = this.store.get(ref.kind, ref.id);
        if (!current || current.requestHash !== ref.requestHash || digest(current.request) !== ref.requestHash)
          fail('source_changed', '真实用户目标选择已变化');
        continue;
      }
      const current = this.store.get(ref.kind, ref.id), accepted = own.get(`${ref.kind}:${ref.id}`) || ref;
      if ((current?.revision ?? null) !== accepted.revision || (current ? digest(current) : null) !== accepted.hash)
        fail('source_changed', `学习材料版本已变化：${ref.kind}/${ref.id}`);
      if (ref.kind === 'events' && !sourceCurrent(this.store, current)) fail('source_changed', '学习原件已撤回');
    }
  }

  assertTarget(input, kind, id) {
    const shown = input.material[groupName(kind)]?.find(row => row.id === id);
    const current = this.store.get(kind, id);
    if (kind === 'goals' && shown?.repairOnly === true) {
      const discussion = input.material.goalDiscussions.find(row => row.goalId === id && row.mode === 'repair');
      if (!current || current.revision !== shown.revision || !goalRepairAllowed(current) ||
          !atSequence(current, input.material.boundary.sequence) || !discussion ||
          !input.material.inputEventIds.includes(discussion.sourceId) ||
          !sourceBefore(this.store, this.store.get('events', discussion.sourceId), input.material.boundary))
        fail('learning_conflict', '目标修复缺少当前明确选回或新原话');
      return current;
    }
    if (!shown || !current || current.revision !== shown.revision ||
        !evidenceBundle(this.store, current, kind, input.material.boundary))
      fail('learning_conflict', '目标或依赖未显示、已改变或已失效');
    return current;
  }

  sourceReferences(input, ids, requireUser = false) {
    const refs = assertVisibleSources(ids, input.material.sources, { requireUser });
    for (const ref of refs) {
      const current = this.store.get('events', ref.id);
      if (current?.revision !== ref.revision || !sourceBefore(this.store, current, input.material.boundary))
        fail('source_changed', '提议引用的原件已变化或越过截止');
    }
    return refs;
  }

  understandingReferences(input, ids) {
    if (new Set(ids).size !== ids.length) fail('invalid_source', '理解依赖不可重复');
    return ids.map(id => {
      const current = this.assertTarget(input, 'understandings', id);
      if (current.status !== 'active') fail('learning_conflict', '理解依赖已失效');
      return { kind: 'understandings', id, revision: current.revision };
    });
  }

  /** Only consumes a flushed host-bound auxiliary result; never starts a session. */
  commit(pendingId, { sessionId, events }) {
    const input = this.store.get('learning_inputs', pendingId);
    if (!input) fail('learning_not_prepared', '尚未冻结学习输入');
    this.assertInput(input);
    const run = this.store.get('learning_runs', pendingId);
    if (!run || run.sessionId !== sessionId || !['submitted', 'settled'].includes(run.state) ||
        run.inputHash !== input.inputHash || run.message?.id !== run.messageId)
      fail('learning_run_mismatch', '辅助结果没有匹配的可信宿主登记');
    const output = auxiliaryOutput(input, run, events);
    const outputId = pendingId;
    this.store.transaction(() => {
      const prior = this.store.get('learning_outputs', outputId);
      if (prior && prior.outputHash !== output.outputHash) fail('learning_output_conflict', '同次学习不能改换输出或辅助事件');
      if (!prior) this.store.save('learning_outputs', { id: outputId, pendingId, ...output });
    });
    let parsed;
    try {
      if (output.error) throw new ContractError(output.error.code, output.error.message);
      parsed = parseLearn(output.rawText);
    } catch (error) {
      for (const section of LEARN_SECTIONS) this.recordFailure(pendingId, section, error);
      return this.finish(pendingId);
    }
    for (const section of LEARN_SECTIONS) {
      if (this.store.get('learning_sections', `${pendingId}:${section}`)) continue;
      try {
        if (parsed.issues[section].length) throw new ContractError('invalid_output', '学习分区格式不符合合同', parsed.issues[section]);
        this.commitSection(input, section, parsed.value[section]);
      } catch (error) { this.recordFailure(pendingId, section, error); }
    }
    return this.finish(pendingId);
  }

  commitSection(input, section, rows) {
    return this.store.transaction(() => {
      this.assertVersions(input);
      const before = new Map(LEARN_SECTIONS.flatMap(kind => this.store.listAll(kind)
        .map(row => [`${kind}:${row.id}`, recordRef(kind, row)])));
      let ids;
      if (section === 'goals') ids = applyGoalChanges(this.store, {
        pendingId: input.pendingId, material: input.material, rows,
        assertTarget: (kind, id) => this.assertTarget(input, kind, id),
        assertSources: (ids, required) => this.sourceReferences(input, ids, required),
        understandingRefs: ids => this.understandingReferences(input, ids),
      });
      else {
        const targets = new Set();
        ids = rows.map((row, index) => {
          if (row.targetId && targets.has(row.targetId)) fail('invalid_output', '同一分区不能重复修改一个目标');
          if (row.targetId) targets.add(row.targetId);
          const refs = section === 'opportunities' && row.operation === 'reuse' ? []
            : this.sourceReferences(input, row.sourceIds, requiresUserSource(section, row));
          return section === 'understandings' ? this.saveUnderstanding(input, row, index, refs)
            : section === 'methods' ? this.saveMethod(input, row, index, refs)
              : this.saveOpportunity(input, row, index, refs);
        });
      }
      const changes = LEARN_SECTIONS.flatMap(kind => this.store.listAll(kind).flatMap(row => {
        const previous = before.get(`${kind}:${row.id}`);
        return previous?.hash !== digest(row) ? [recordRef(kind, row)] : [];
      }));
      return this.store.save('learning_sections', { id: `${input.pendingId}:${section}`, pendingId: input.pendingId,
        section, status: 'completed', ids, changes });
    });
  }

  recordFailure(pendingId, section, error) {
    const id = `${pendingId}:${section}`;
    this.store.transaction(() => {
      if (!this.store.get('learning_sections', id)) this.store.save('learning_sections', {
        id, pendingId, section, status: 'failed', ids: [], changes: [], error: errorView(error) });
    });
  }

  finish(pendingId) {
    return this.store.transaction(() => {
      const sections = this.store.listAll('learning_sections', { where: { pendingId } });
      if (sections.length !== 4) fail('incomplete_learning', '学习分区尚未全部结算');
      const completed = sections.filter(section => section.status === 'completed').length;
      const status = completed === 4 ? 'completed' : completed ? 'partial' : 'failed';
      const pending = this.store.get('learning_pending', pendingId);
      if (!pending) fail('invalid_learning_pending', '学习待办已缺失');
      const result = { status, sections: Object.fromEntries(sections.map(section => [section.section, section])) };
      if (pending.status !== status || digest(pending.result || null) !== digest(result))
        this.store.save('learning_pending', { ...pending, status, result }, { expectedRevision: pending.revision });
      return result;
    });
  }

  saveUnderstanding(input, row, index, dependencies) {
    const old = row.operation === 'create' ? null : this.assertTarget(input, 'understandings', row.targetId);
    if (row.operation === 'create' && row.targetId || !row.content.trim()) fail('invalid_output', '理解内容或目标编号不合法');
    if (old && old.status !== 'active') fail('learning_conflict', '只可修订有效理解');
    if (old) {
      this.store.save('understandings', { ...old, status: row.operation === 'withdraw' ? 'withdrawn' : 'superseded',
        changeSourceIds: row.sourceIds, changedByRunId: input.pendingId }, { expectedRevision: old.revision });
      invalidateDependents(this.store, { ids: [old.id], pendingId: input.pendingId,
        reason: `understanding_${row.operation}_by_learning` });
    }
    if (row.operation === 'withdraw') return old.id;
    const saved = this.store.save('understandings', projectUnderstanding({
      id: 'understanding-' + digest([input.pendingId, index]).slice(0, 32), content: row.content, claimType: row.claimType,
      scope: { ...(row.scope === 'conversation' ? { conversationId: input.material.sessionId } : {}), topics: row.topics },
      status: 'active', sourceIds: row.sourceIds, dependencies, version: (old?.version || 0) + 1,
      previousId: old?.id || null, learnedFromRunId: input.pendingId, authority: 'revisable-understanding; not-permission',
    }, input.material.sources));
    return saved.id;
  }

  saveMethod(input, row, index, dependencies) {
    const old = row.operation === 'create' ? null : this.assertTarget(input, 'methods', row.targetId);
    if (row.operation === 'create' && row.targetId ||
        ![row.title, row.guidance, row.appliesTo, row.doesNotApplyTo].every(value => value.trim()))
      fail('invalid_output', '方法须有完整内容、适用与不适用条件和合法目标编号');
    dependencies.push(...this.understandingReferences(input, row.understandingIds));
    if (old) {
      pauseMethod(this.store, old, { reason: row.operation === 'pause' ? row.guidance : 'superseded',
        changes: { changeSourceIds: row.sourceIds }, pendingId: input.pendingId });
      invalidateDependents(this.store, { ids: [old.id], pendingId: input.pendingId, reason: `method_${row.operation}_by_learning` });
    }
    if (row.operation === 'pause') return old.id;
    const signature = digest({ title: row.title, guidance: row.guidance, appliesTo: row.appliesTo, doesNotApplyTo: row.doesNotApplyTo });
    // Include paused/exhausted historical methods; a new id cannot buy a new trial.
    const duplicate = this.store.listAll('methods').find(method => method.signature === signature ||
      digest({ title: method.title ?? '', guidance: method.guidance ?? '', appliesTo: method.appliesTo ?? '', doesNotApplyTo: method.doesNotApplyTo ?? '' }) === signature);
    if (duplicate) return duplicate.id;
    return this.store.save('methods', { id: 'method-' + digest([input.pendingId, index]).slice(0, 32),
      title: row.title, guidance: row.guidance, appliesTo: row.appliesTo, doesNotApplyTo: row.doesNotApplyTo,
      origin: 'inferred', proposedOrigin: row.origin, sourceIds: row.sourceIds, dependencies,
      status: 'trial', maxTrialUses: 3, validated: false, signature,
      version: (old?.version || 0) + 1, previousId: old?.id || null, learnedFromRunId: input.pendingId,
      evidence: [{ kind: 'learning-source', runId: input.pendingId, sourceIds: row.sourceIds }],
      authority: 'work-guidance-only; no-new-tool-or-permission' }).id;
  }

  saveOpportunity(input, row, index, dependencies) {
    if (row.operation === 'reuse') {
      const old = this.assertTarget(input, 'opportunities', row.targetId);
      if (row.sourceIds.length || [row.description, row.rationale, row.suggestedPreparation].some(value => value !== ''))
        fail('invalid_output', '复用机会只能关联旧编号，不能更新内容或恢复执行');
      return old.id;
    }
    if (row.targetId || ![row.description, row.rationale, row.suggestedPreparation].every(value => value.trim()))
      fail('invalid_output', '机会须有完整内容且新建不可指向旧编号');
    const signature = digest({ conversationId: input.material.sessionId, description: row.description,
      rationale: row.rationale, suggestedPreparation: row.suggestedPreparation, sourceIds: [...row.sourceIds].sort() });
    const duplicate = this.store.listAll('opportunities').find(item => item.signature === signature);
    if (duplicate) return duplicate.id;
    return this.store.save('opportunities', { id: 'opportunity-' + digest([input.pendingId, index]).slice(0, 32),
      conversationId: input.material.sessionId, description: row.description, rationale: row.rationale,
      suggestedPreparation: row.suggestedPreparation, sourceIds: row.sourceIds, dependencies,
      status: 'pending', preparationStatus: 'not_authorized', preparationRunId: null, artifactIds: [], signature,
      learnedFromRunId: input.pendingId, authority: 'unendorsed-option; no-execution-authority' }).id;
  }
}

function auxiliaryOutput(input, run, rawEvents) {
  if (!Array.isArray(rawEvents) || !rawEvents.length) fail('invalid_auxiliary_history', '辅助会话原事件缺失');
  const events = clone(rawEvents);
  for (const [seq, event] of events.entries()) if (event.seq !== seq || typeof event.type !== 'string' || !event.data)
    fail('invalid_auxiliary_history', '辅助会话必须提供从零开始的完整原事件');
  const starts = events.filter(event => event.type === 'turn/start');
  const ends = events.filter(event => event.type === 'turn/end');
  const originals = events.filter(event => event.type === 'user/message' && event.data.id === run.messageId);
  const expected = run.message;
  if (expected.source?.kind !== 'arcfold/learning' || expected.source.pendingId !== input.pendingId ||
      expected.source.deliveryId !== input.deliveryId || messageText(expected) !== input.inputText ||
      originals.length !== 1 || canonicalJson(originals[0].data) !== canonicalJson(expected))
    fail('learning_input_mismatch', '实际辅助消息与冻结材料或业务归属不一致');
  const final = events.findLast(event => event.type === 'assistant/message');
  const rawText = final ? messageText(final.data.message) : '';
  const error = (code, message) => ({ code, message });
  let problem = null;
  if (starts.length !== 1 || ends.length !== 1 || starts[0].seq >= ends[0].seq ||
      starts[0].data.turn !== ends[0].data.turn || events.some(event => event.type === 'session/end-seed' && event.data.inherited))
    problem = error('invalid_auxiliary_turn', '学习只接受一轮非继承的完整辅助输出');
  else if (ends[0].data.reason?.kind !== 'completed') problem = error('auxiliary_incomplete', '辅助会话未正常完成');
  else if (!final || final.seq <= starts[0].seq || final.seq >= ends[0].seq ||
      final.data.turn !== starts[0].data.turn || final.data.interrupted || final.data.message?.source?.kind !== 'model' ||
      !rawText.trim()) problem = error('auxiliary_incomplete', '学习没有完整模型正文');
  else if (events.some(event => ['tool/call', 'tool/result', 'job/registered', 'subagent/catalog'].includes(event.type)) ||
      events.some(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'tool-call')))
    problem = error('auxiliary_tools_forbidden', '学习业务不接受工具或后台执行分支');
  else if (events.some(event => event.type === 'user/message' && event.data.id !== run.messageId &&
      event.data.source?.kind !== 'runtime-context'))
    problem = error('auxiliary_extra_input', '冻结输入之后辅助会话又收到其他消息');
  else if (originals[0].seq <= starts[0].seq || originals[0].seq >= final.seq)
    problem = error('auxiliary_input_order', '冻结输入不在本轮模型输出之前');
  if (!problem) {
    let openStep = null;
    for (const event of events.filter(event => event.seq > starts[0].seq && event.seq < ends[0].seq)) {
      if (event.type === 'step/start') {
        if (openStep !== null || event.data.turn !== starts[0].data.turn || !Number.isSafeInteger(event.data.step)) {
          problem = error('auxiliary_step_boundary', '辅助步骤边界不完整'); break;
        }
        openStep = event.data.step;
      } else if (event.type === 'step/end') {
        if (openStep === null || event.data.step !== openStep || event.data.turn !== starts[0].data.turn) {
          problem = error('auxiliary_step_boundary', '辅助步骤边界不完整'); break;
        }
        openStep = null;
      } else if (['assistant/message', 'assistant/attempt'].includes(event.type) &&
          (openStep === null || event.data.step !== openStep || event.data.turn !== starts[0].data.turn)) {
        problem = error('auxiliary_step_boundary', '辅助模型输出不属于已进入的步骤'); break;
      }
    }
    if (openStep !== null) problem = error('auxiliary_step_boundary', '辅助步骤尚未关闭');
  }
  return { sessionId: run.sessionId, messageId: run.messageId,
    throughSeq: events.at(-1).seq, eventCount: events.length,
    sourceRef: { sessionId: run.sessionId, seq: final?.seq ?? null, type: final?.type ?? null },
    rawText, eventHash: final ? digest(final) : null,
    outputHash: digest({ sessionId: run.sessionId, events }), error: problem };
}
