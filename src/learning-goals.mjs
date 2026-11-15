import { linkWork } from './goal-work.mjs';
// Business-only adaptation of Arcfold 3.0 service.mjs applyGoalChanges,
// saveGoalTransition and invalidateDependents. No jobs are created/cancelled.
import { ContractError, digest } from './learning-contracts.mjs';
import { pauseMethod } from './method-lifecycle.mjs';

const invalid = message => { throw new ContractError('invalid_output', message); };

export function saveGoalTransition(store, before, after, { commandId, pendingId, reason, sourceIds = [], actor = 'assistant_inference' }) {
  const id = 'goal-audit-' + digest(commandId);
  if (store.get('audit', id)) throw new ContractError('learning_conflict', '目标变更身份已经使用');
  const saved = store.save('goals', after, { expectedRevision: before?.revision ?? null });
  store.save('audit', { id, commandId, goalId: saved.id, actor, reason,
    pendingId, sourceIds, before: before || null, after: saved });
  return saved;
}

function assertAcyclic(goals) {
  const byId = new Map(goals.map(goal => [goal.id, goal])), edges = new Map();
  for (const goal of goals) {
    if (goal.deleted || goal.withdrawn || goal.useProhibited) continue;
    for (const relation of goal.relations || []) {
      const target = byId.get(relation.targetId);
      if (relation.type === 'part_of' && target && !target.deleted && !target.withdrawn &&
          !target.useProhibited && target.definitionVersion === relation.targetDefinitionVersion)
        edges.set(goal.id, [...(edges.get(goal.id) || []), target.id]);
    }
  }
  const visiting = new Set(), done = new Set();
  function visit(id) {
    if (visiting.has(id)) invalid('目标组成关系不能成环');
    if (done.has(id)) return;
    visiting.add(id);
    for (const next of edges.get(id) || []) visit(next);
    visiting.delete(id); done.add(id);
  }
  for (const id of byId.keys()) visit(id);
}

/** All rows and their definition/relationship versions share one section transaction. */
export function applyGoalChanges(store, { pendingId, material, rows, assertTarget, assertSources, understandingRefs }) {
  const aliases = new Map(), ids = new Set(), prepared = [];
  for (const [index, row] of rows.entries()) {
    const old = row.operation === 'update' ? assertTarget('goals', row.targetId) : null;
    const repair = old && material.existingGoals.find(goal => goal.id === old.id)?.repairOnly === true;
    if (repair && (!old.useProhibited || old.sourceInvalidation?.kind !== 'source_dependency' ||
        old.withdrawn || old.deleted || !row.sourceIds.some(id => material.inputEventIds.includes(id))))
      invalid('重新澄清须有本次新用户原话，且只能修复程序标记的来源失效目标');
    if (row.operation === 'create' && row.targetId !== '') invalid('新建目标不能指定旧编号');
    if ((row.operation === 'update' && row.clientRef) ||
        (row.clientRef && (!row.clientRef.startsWith('new-goal:') || aliases.has(row.clientRef))))
      invalid('临时目标编号仅限同区新建且不可重复');
    const id = old?.id || 'goal-' + digest([pendingId, index]).slice(0, 32);
    if (ids.has(id)) invalid('同一区不能重复修改一个目标');
    ids.add(id);
    if (row.clientRef) aliases.set(row.clientRef, id);
    const references = understandingRefs(row.understandingIds);
    const dependencies = [...assertSources(row.sourceIds, true), ...references];
    const scope = row.scope === 'global' ? {} : { conversationId: old?.conversationId || material.sessionId };
    const definition = { title: row.title, outcome: row.outcome, scope, understandingRefs: references };
    const previous = old && { title: old.title, outcome: old.outcome, scope: old.scope || {},
      understandingRefs: (old.dependencies || []).filter(ref => ref.kind === 'understandings') };
    const definitionVersion = old ? old.definitionVersion + Number(digest(definition) !== digest(previous)) : 1;
    if (!Number.isSafeInteger(definitionVersion) || definitionVersion < 1) invalid('旧目标缺少有效定义版本');
    if (!row.progress.content.trim() && (row.progress.content !== '' || row.progress.sourceIds.length))
      invalid('空进展必须使用空文字和空来源');
    const progressDependencies = row.progress.content ? assertSources(row.progress.sourceIds) : [];
    const controlSources = row.sourceIds.map(id => store.get('events', id)).filter(source =>
      material.inputEventIds.includes(source?.id) && source.message?.role === 'user' &&
      source.message.source?.kind === 'user' && source.message.source.principal === undefined);
    if (row.controlProposal !== 'none' && !controlSources.length)
      invalid('追踪解释必须引用本轮真实owner原话，后台续轮不能改变追踪');
    const controlBoundary = old?.userControl?.nativeBoundary;
    const laterThanHumanControl = !old?.userControl || controlBoundary && controlSources.some(source => {
      const ref = source.provenance?.sourceRef;
      return ref?.type === 'agent/inbox/spliced' && ref.sessionId === controlBoundary.sessionId &&
        ref.seq > controlBoundary.throughSeq;
    });
    const applyTracking = row.controlProposal !== 'none' && laterThanHumanControl;

    const next = { ...old, id, conversationId: old?.conversationId || material.sessionId,
      title: row.title, outcome: row.outcome, scope, definitionVersion,
      understandingIds: row.understandingIds, sourceIds: row.sourceIds, dependencies,
      status: applyTracking ? { pause: 'paused', resume: 'tracking', close: 'closed' }[row.controlProposal] : old?.status || 'tracking',
      userControl: old?.userControl ?? null,
      ...(row.controlProposal !== 'none' ? { trackingInterpretation: { action: row.controlProposal,
        sourceIds: controlSources.map(source => source.id), pendingId, claimType: 'inference',
        applied: Boolean(applyTracking), reason: applyTracking ? 'current_owner_input' : 'prior_user_control_order_unproven' } } : {}),
      progress: { content: row.progress.content, sourceIds: row.progress.sourceIds,
        dependencies: progressDependencies, runId: pendingId },
      relations: [], controlProposal: row.controlProposal === 'none' ? null : {
        action: row.controlProposal, definitionVersion, sourceIds: row.sourceIds,
        dependencies: assertSources(row.sourceIds), claimType: 'inference', runId: pendingId },
      claimType: 'inference', contentAuthor: 'assistant', userEndorsement: 'not_established_by_this_record',
      learnedFromRunId: old?.learnedFromRunId || pendingId, updatedFromRunId: pendingId };
    if (repair) {
      next.useProhibited = false;
      next.sourceInvalidation = null;
      next.withdrawalReason = null;
    }
    prepared.push({ old, next, row, index });
  }
  const replacements = new Map(prepared.map(item => [item.next.id, item.next]));
  for (const item of prepared) {
    const seen = new Set();
    for (const relation of item.row.relations) {
      const targetId = aliases.get(relation.targetId) || relation.targetId;
      const target = replacements.get(targetId) || assertTarget('goals', targetId);
      const key = relation.type + ':' + targetId;
      if (!target || targetId === item.next.id || seen.has(key)) invalid('目标关系不能自连、重复或缺少两端');
      seen.add(key);
      // A full Learn update explicitly reproposes each relation. Bind both
      // definitions; retaining an old stored edge never silently rebases it.
      item.next.relations.push({ ...relation, targetId, sourceDefinitionVersion: item.next.definitionVersion,
        targetDefinitionVersion: target.definitionVersion,
        dependencies: assertSources(relation.sourceIds) });
    }
  }
  assertAcyclic([...store.listAll('goals').filter(goal => !replacements.has(goal.id)), ...replacements.values()]);
  const result = prepared.map(({ old, next, index }) => saveGoalTransition(store, old, next, {
    commandId: `${pendingId}:goals:${index}`, pendingId, reason: old ? 'learn_update' : 'learn_create',
    sourceIds: next.sourceIds }).id);
  const workIds = new Set();
  for (const { next, row, index } of prepared) for (const selection of row.workLinks || []) {
    if (workIds.has(selection.workId)) invalid('同一工作在本区只能联系一个明确目标');
    workIds.add(selection.workId);
    const shown = material.goalWorks?.find(work => work.id === selection.workId);
    if (!shown || shown.sessionId !== material.sessionId) invalid('工作联系必须逐字选择本次交付的真实工作编号');
    assertSources(selection.sourceIds);
    linkWork(store, { work: store.get('goal_works', shown.id), goal: store.get('goals', next.id),
      state: shown, reason: selection.reason, sourceIds: selection.sourceIds,
      expectedRelationId: shown.relationId,
      origin: { kind: 'learning', pendingId, index } });
  }
  return result;
}

/** Invalidate dependent business knowledge only; execution remains host-owned. */
export function invalidateDependents(store, { ids, pendingId, reason }) {
  const invalidIds = new Set(ids), changes = [];
  const inventory = ['understandings', 'methods', 'opportunities', 'goals']
    .flatMap(kind => store.listAll(kind).map(record => ({ kind, record })));
  let advanced;
  do {
    advanced = false;
    for (const item of inventory) {
      const { kind, record } = item;
      if (invalidIds.has(record.id) || (!(record.sourceIds || []).some(id => invalidIds.has(id)) &&
          !(record.dependencies || []).some(ref => invalidIds.has(ref.id)))) continue;
      invalidIds.add(record.id); advanced = true;
      const next = kind === 'goals'
        ? { ...record, useProhibited: true, sourceInvalidation: { kind: 'source_dependency', reason }, withdrawalReason: reason }
        : { ...record, status: kind === 'understandings' ? 'withdrawn' : kind === 'methods' ? 'paused' : 'dismissed',
          withdrawalReason: reason, ...(kind === 'methods' ? { pauseReason: reason } : {}) };
      item.record = kind === 'methods'
        ? pauseMethod(store, record, { reason, changes: { withdrawalReason: reason }, pendingId })
        : store.save(kind, next, { expectedRevision: record.revision });
      changes.push({ kind, id: record.id, revision: item.record.revision });
      if (kind === 'goals') store.save('audit', {
        id: 'goal-audit-' + digest([pendingId, reason, record.id, record.revision]),
        goalId: record.id, pendingId, actor: 'program_source_guard', reason, before: record, after: item.record });
    }
  } while (advanced);
  return changes;
}
