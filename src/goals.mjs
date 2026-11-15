import { workViews, assertWork, workId as nativeWorkId, goalContentHash, frozenGoalCurrent } from './goal-work.mjs';
// Business goals and their relation to native work. This service never runs work.
import { DomainError, canonicalJson, identity } from './store.mjs';
import { hash, sourceText, sourceAvailable, dependenciesCurrent, evidenceProvenance } from './evidence.mjs';
import { saveGoalTransition } from './learning-goals.mjs';
import { goalContextMessage } from './goal-context.mjs';
import { browseScope, browseContext } from './browse-scope.mjs';

const fail = (code, message) => { throw new DomainError(code, message); };
const digest = value => hash(JSON.parse(canonicalJson(value)));
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const inScope = (row, sessionId) => !row.scope?.conversationId || row.scope.conversationId === sessionId;
const atSequence = (row, cutoff) => row && nonnegative(row.createdSequence) && nonnegative(row.updatedSequence) &&
  row.createdSequence <= cutoff && row.updatedSequence <= cutoff;
const states = new Set(['tracking', 'paused', 'closed']);
const copy = value => JSON.parse(JSON.stringify(value));
const evidenceView = bundle => ({ ...copy(bundle), sources: bundle.sources.map(source => ({
  ...copy(source), provenance: evidenceProvenance(source.provenance) })) });

export const goalRepairAllowed = goal => Boolean(goal && goal.useProhibited === true &&
  goal.sourceInvalidation?.kind === 'source_dependency' && !goal.withdrawn && !goal.deleted);
export { goalContentHash };

function position({ sessionId, turn, startSeq }) {
  identity(sessionId, 'Native session id');
  if (!nonnegative(turn) || !nonnegative(startSeq)) fail('invalid_native_turn', '需要真实宿主轮次和开始序号。');
}
function paging(offset, limit) {
  if (!nonnegative(offset) || !positive(limit) || limit > 100) fail('invalid_pagination', '目标分页参数不合法。');
}
function metadata(goal) {
  return { id: goal.id, revision: goal.revision, definitionVersion: goal.definitionVersion,
    status: goal.status, repairOnly: true, reason: goal.sourceInvalidation?.reason || 'source_dependency' };
}

/** A paused/closed goal root remains discussable; its dependencies receive no exception. */
export function goalDefinitionCurrent(store, goal, cutoff = store.currentSequence()) {
  return Boolean(goal && states.has(goal.status) && positive(goal.definitionVersion) &&
    dependenciesCurrent(store, { ...goal, status: 'active' }, cutoff));
}

function sourcesFor(store, record) {
  const sources = new Map(), visited = new Set();
  function visit(row) {
    if (!row || visited.has(row.id)) return;
    visited.add(row.id);
    for (const id of row.sourceIds || []) sources.set(id, store.get('events', id));
    for (const ref of row.dependencies || []) {
      const kind = ref.kind || ['events', 'understandings', 'methods'].find(k => store.get(k, ref.id));
      if (kind === 'events') sources.set(ref.id, store.get(kind, ref.id));
      else visit(store.get(kind, ref.id));
    }
  }
  visit(record);
  return [...sources.values()].filter(Boolean).map(source => ({ id: source.id, revision: source.revision,
    role: source.role, content: sourceText(source), occurredAt: source.occurredAt ?? null,
    provenance: evidenceProvenance(source.provenance) }));
}
function partCurrent(store, goal, part, cutoff) {
  if (!part) return false;
  if (part.content === '' && part.sourceIds?.length === 0) return true;
  return dependenciesCurrent(store, { ...part, id: `goal-part:${goal.id}`, status: 'active',
    createdSequence: goal.createdSequence, updatedSequence: goal.updatedSequence }, cutoff);
}

// Original knowledge dependencies are not execution state and never enter the
// model bundle twice. Keep their exact identities for later historical display.
function knowledgeReferences(store, entry) {
  const found = new Map();
  function visit(row) {
    for (const ref of row?.dependencies || []) {
      const kind = ref.kind || ['events', 'understandings', 'methods'].find(k => store.get(k, ref.id));
      if (kind === 'events') continue;
      const key = kind + ':' + ref.id;
      if (found.has(key)) continue;
      found.set(key, { kind, id: ref.id, revision: ref.revision });
      visit(store.get(kind, ref.id));
    }
  }
  for (const shown of [entry.goal, ...entry.relatedGoals]) {
    if (shown.repairOnly) continue;
    const goal = store.get('goals', shown.id);
    visit(goal);
    if (shown.progress) visit(shown.progress);
    for (const relation of shown.relations || []) if (relation.state !== 'unavailable') visit(relation);
  }
  return [...found.values()];
}

export class GoalService {
  constructor({ business }) {
    if (!business?.storage) fail('invalid_goal_config', '需要业务存储。');
    this.store = business.storage;
  }

  reconcile() {
    return this.store.transaction(() => {
      const changes = [];
      for (const goal of this.store.listAll('goals')) {
        if (goal.deleted || goal.withdrawn || goal.useProhibited || !states.has(goal.status) ||
            goalDefinitionCurrent(this.store, goal)) continue;
        changes.push(saveGoalTransition(this.store, goal, { ...goal, useProhibited: true,
          sourceInvalidation: { kind: 'source_dependency', reason: 'source_changed' } }, {
          commandId: `goal-source:${goal.id}:${goal.revision}`, pendingId: null,
          actor: 'program_source_guard', reason: 'source_changed' }));
      }
      return changes;
    });
  }

  view(goal, cutoff = this.store.currentSequence()) {
    if (!goalDefinitionCurrent(this.store, goal, cutoff)) return null;
    const sources = new Map(sourcesFor(this.store, goal).map(source => [source.id, source]));
    const coverage = { progressUnavailable: 0, relationsUnavailable: 0, relationsNeedsReview: 0 };
    const progress = partCurrent(this.store, goal, goal.progress, cutoff) ? copy(goal.progress) : null;
    if (goal.progress && !progress) coverage.progressUnavailable++;
    if (progress) for (const source of sourcesFor(this.store, goal.progress)) sources.set(source.id, source);
    const relations = (goal.relations || []).map(relation => {
      const target = this.store.get('goals', relation.targetId);
      const state = !partCurrent(this.store, goal, relation, cutoff) ? 'unavailable'
        : !goalDefinitionCurrent(this.store, target, cutoff) ? 'unavailable'
          : (relation.sourceDefinitionVersion ?? goal.definitionVersion) !== goal.definitionVersion ||
            relation.targetDefinitionVersion !== target.definitionVersion ? 'needs_review' : 'current';
      if (state === 'unavailable') {
        coverage.relationsUnavailable++;
        return { type: relation.type, targetId: relation.targetId, state };
      }
      if (state === 'needs_review') coverage.relationsNeedsReview++;
      for (const source of sourcesFor(this.store, relation)) sources.set(source.id, source);
      return { ...copy(relation), state, targetStatus: target.status };
    });
    return { goal: { id: goal.id, revision: goal.revision, definitionVersion: goal.definitionVersion,
      title: goal.title, outcome: goal.outcome, scope: goal.scope || {}, status: goal.status,
      userControl: goal.userControl ?? null, sourceIds: [...goal.sourceIds],
      claimType: 'inference', contentAuthor: 'assistant', userEndorsement: 'not_established_by_this_record',
      progress, relations }, sources: [...sources.values()], coverage };
  }

  discussions({ sessionId, inputMessageIds = [], cutoffSequence = this.store.currentSequence() }) {
    const ids = new Set(inputMessageIds);
    const originals = this.store.listAll('events', { where: { sessionId } }).filter(source =>
      // Official owner prompts omit principal; other callers are explicitly
      // tagged by SessionController.prompt and cannot redeem a browser choice.
      source.role === 'user' && source.message?.source?.kind === 'user' &&
      source.message.source.principal === undefined && ids.has(source.message.id) &&
      dependenciesCurrent(this.store, { id: 'discussion-source', status: 'active', sourceIds: [source.id],
        dependencies: [{ kind: 'events', id: source.id, revision: source.revision }],
        createdSequence: source.createdSequence, updatedSequence: source.updatedSequence }, cutoffSequence));
    return this.store.listAll('goal_discussions', { where: { sessionId } }).flatMap(binding => {
      if (binding.createdSequence > cutoffSequence) return [];
      if (digest(binding.request) !== binding.requestHash) fail('goal_discussion_changed', '用户讨论绑定已被改写。');
      const matches = originals.filter(source => source.message.source.rpcId === binding.requestId &&
        digest(source.message.content) === binding.contentHash);
      if (matches.length !== 1) return [];
      const goal = this.store.get('goals', binding.goalId);
      if (!goal || goal.revision !== binding.goalRevision || goal.definitionVersion !== binding.definitionVersion ||
          !inScope(goal, sessionId)) fail('goal_discussion_changed', '已选目标已变化，请重新查看并明确选回。');
      return [{ ...binding, sourceId: matches[0].id, messageId: matches[0].message.id }];
    });
  }

  catalog({ sessionId, cutoffSequence = this.store.currentSequence(), inputMessageIds = [] }) {
    identity(sessionId, 'Native session id');
    if (!nonnegative(cutoffSequence)) fail('invalid_cutoff', '目标目录需要有效截止。');
    const explicit = new Map(this.discussions({ sessionId, inputMessageIds, cutoffSequence }).map(row => [row.goalId, row]));
    return this.store.listAll('goals').flatMap(goal => {
      if (!inScope(goal, sessionId) || !atSequence(goal, cutoffSequence)) return [];
      const discussion = explicit.get(goal.id);
      if (discussion?.mode === 'repair' && goalRepairAllowed(goal)) return [{ ...metadata(goal),
        contentHash: goalContentHash(goal), sourceIds: [discussion.sourceId], explicitDiscussion: true,
        discussionId: discussion.id }];
      if (!goalDefinitionCurrent(this.store, goal, cutoffSequence) ||
          goal.status !== 'tracking' && discussion?.mode !== 'discuss') return [];
      return [{ id: goal.id, revision: goal.revision, definitionVersion: goal.definitionVersion,
        contentHash: goalContentHash(goal), title: goal.title, outcome: goal.outcome, status: goal.status,
        sourceIds: [...goal.sourceIds], explicitDiscussion: Boolean(discussion), repairOnly: false,
        ...(discussion ? { discussionId: discussion.id } : {}) }];
    });
  }

  fullEntry(goal, shown, selection, snapshot, maxNodes = 6) {
    if (shown.repairOnly) {
      const binding = this.discussions({ sessionId: snapshot.sessionId,
        inputMessageIds: snapshot.material.inputMessageIds, cutoffSequence: snapshot.material.cutoffSequence })
        .find(row => row.id === shown.discussionId && row.mode === 'repair');
      if (!binding || !goalRepairAllowed(goal)) fail('goal_repair_not_allowed', '修复没有匹配本轮真实用户原话。');
      const source = this.store.get('events', binding.sourceId);
      return { goal: metadata(goal), relatedGoals: [], sources: [{ id: source.id, revision: source.revision,
        role: source.role, content: sourceText(source), occurredAt: source.occurredAt, provenance: evidenceProvenance(source.provenance) }],
        coverage: { relatedOmitted: 0 }, selection: copy(selection), discussionId: binding.id };
    }
    const cutoff = snapshot.material.cutoffSequence, root = this.view(goal, cutoff);
    if (!root) fail('goal_unavailable', '目标定义或其原件已失效。');
    const sources = new Map(root.sources.map(source => [source.id, source])), seen = new Set([goal.id]);
    const relatedGoals = [], queue = [...root.goal.relations], coverage = { ...root.coverage, relatedOmitted: 0 };
    for (const relation of queue) {
      if (relation.state !== 'current' || seen.has(relation.targetId)) continue;
      seen.add(relation.targetId);
      const target = this.store.get('goals', relation.targetId);
      if (target.status !== 'tracking' || !inScope(target, snapshot.sessionId) || relatedGoals.length + 1 >= maxNodes) {
        coverage.relatedOmitted++; continue;
      }
      const projected = this.view(target, cutoff);
      if (!projected) { coverage.relatedOmitted++; continue; }
      relatedGoals.push(projected.goal);
      for (const source of projected.sources) sources.set(source.id, source);
      queue.push(...projected.goal.relations);
    }
    return { goal: root.goal, relatedGoals, sources: [...sources.values()], coverage, selection: copy(selection) };
  }

  link({ sessionId, turn, startSeq, callId, contextSnapshotId, contextMessageId, selection, maxCharacters = 24000 }) {
    position({ sessionId, turn, startSeq }); identity(callId, 'Native goal tool call');
    identity(contextSnapshotId, 'Goal context snapshot'); identity(contextMessageId, 'Goal context message');
    if (!selection || typeof selection !== 'object' || Array.isArray(selection) ||
        Object.keys(selection).some(key => !['id', 'revision', 'definitionVersion', 'contentHash', 'reason', 'sourceIds'].includes(key)))
      fail('invalid_goal_selection', '关联仅接受目标版本、贡献解释和来源，不接受确认或权限字段。');
    if (!positive(maxCharacters) || maxCharacters > 180000) fail('goal_capacity', '目标完整材料容量不合法。');
    this.reconcile();
    return this.store.transaction(() => {
      const snapshot = this.store.get('context_snapshots', contextSnapshotId);
      const shown = snapshot?.material?.goals?.find(row => row.id === selection?.id);
      const goal = shown && this.store.get('goals', shown.id);
      if (this.store.get('host_bindings', sessionId)?.role !== 'main' || !snapshot ||
          snapshot.sessionId !== sessionId || snapshot.turn !== turn || snapshot.contextMessageId !== contextMessageId || !goal)
        fail('goal_context_mismatch', '目标选择没有对应本轮主会话已显示目录。');
      if (goal.revision !== selection.revision || shown.revision !== selection.revision ||
          goal.definitionVersion !== selection.definitionVersion || shown.definitionVersion !== selection.definitionVersion ||
          goalContentHash(goal) !== selection.contentHash || shown.contentHash !== selection.contentHash)
        fail('goal_selection_changed', '目标未显示或所见版本已经改变。');
      if (typeof selection.reason !== 'string' || !selection.reason.trim() || selection.reason.length > 2000 ||
          !Array.isArray(selection.sourceIds) || !selection.sourceIds.length ||
          new Set(selection.sourceIds).size !== selection.sourceIds.length ||
          selection.sourceIds.some(id => !shown.sourceIds.includes(id)))
        fail('invalid_goal_selection', '关联须保留本次贡献解释和已显示的来源。');
      const currentShown = this.catalog({ sessionId, cutoffSequence: snapshot.material.cutoffSequence,
        inputMessageIds: snapshot.material.inputMessageIds }).find(row => row.id === goal.id);
      if (!currentShown || canonicalJson(currentShown) !== canonicalJson(shown))
        fail('goal_unavailable', '目标资格、来源或用户讨论绑定已变化。');
      const id = 'goal-link-' + digest([sessionId, startSeq]);
      const prior = this.store.get('goal_links', id);
      if (prior) {
        if (prior.turn !== turn || prior.contextSnapshotId !== contextSnapshotId || prior.contextMessageId !== contextMessageId ||
            canonicalJson(prior.selection) !== canonicalJson(selection))
          fail('goal_link_conflict', '本轮已有不同的目标关联；不能覆盖原选择。');
        this.assertCurrent({ linkId: id, sessionId, turn, startSeq });
        return { receipt: this.receipt(prior), bundle: this.currentBundle({ sessionId, turn, startSeq }) };
      }
      const entry = { linkId: id, ...this.fullEntry(goal, shown, selection, snapshot) };
      const bundle = this.emptyBundle({ sessionId, turn, startSeq }); bundle.links.push(entry);
      if (goalContextMessage(bundle).content[0].text.length > maxCharacters)
        fail('goal_capacity', '目标完整定义、关系、原件及说明超过容量；本次未保存关联。');
      const core = { id, sessionId, turn, startSeq, callId, goalId: goal.id, goalRevision: goal.revision,
        definitionVersion: goal.definitionVersion, contentHash: goalContentHash(goal), selection: copy(selection),
        contextSnapshotId, contextMessageId, cutoffSequence: snapshot.material.cutoffSequence, bundle: entry,
        dependencyRefs: knowledgeReferences(this.store, entry),
        authority: 'assistant-inference-about-current-contribution; not-user-endorsement-or-execution-permission' };
      const link = this.store.save('goal_links', { ...core, coreHash: digest(core) });
      return { receipt: this.receipt(link), bundle };
    });
  }

  receipt(link) { return { linkId: link.id, goal: { id: link.goalId, revision: link.goalRevision,
    definitionVersion: link.definitionVersion, contentHash: link.contentHash }, authority: 'association-only; contribution-not-assessed' }; }
  emptyBundle({ sessionId, turn, startSeq }) {
    return { version: 'arcfold-linked-goal-v1', sessionId, turn, startSeq, links: [],
      authority: 'program-provided goal evidence; no-new-work-or-user-approval' };
  }
  assertCore(link) {
    const { revision, createdAt, updatedAt, createdSequence, updatedSequence, coreHash, ...core } = link;
    if (revision !== 1 || createdSequence !== updatedSequence || digest(core) !== coreHash)
      fail('goal_link_changed', '原目标关联不可改写。');
  }
  assertCurrent({ linkId, sessionId, turn, startSeq }) {
    position({ sessionId, turn, startSeq });
    const link = this.store.get('goal_links', linkId);
    if (!link || link.sessionId !== sessionId || link.turn !== turn || link.startSeq !== startSeq ||
        this.store.get('goal_link_outcomes', linkId)) fail('goal_link_closed', '目标关联不属于当前未结束轮次。');
    this.assertCore(link);
    const goal = this.store.get('goals', link.goalId), snapshot = this.store.get('context_snapshots', link.contextSnapshotId);
    const shown = snapshot?.material?.goals?.find(row => row.id === link.goalId);
    if (goal && !shown?.repairOnly && !goalDefinitionCurrent(this.store, goal))
      fail('goal_unavailable', '目标定义或其原件已失效。');
    if (!goal || !shown || (shown.repairOnly
      ? goal.revision !== link.goalRevision || goalContentHash(goal) !== link.contentHash
      : !frozenGoalCurrent(this.store, { ...shown, revision: link.goalRevision, contentHash: link.contentHash },
        snapshot.material.cutoffSequence))) fail('goal_selection_changed', '关联的目标定义或控制状态已变化。');
    if (shown.repairOnly) {
      const entry = { linkId, ...this.fullEntry(goal, shown, link.selection, snapshot) };
      if (canonicalJson(evidenceView(entry)) !== canonicalJson(evidenceView(link.bundle)))
        fail('goal_source_changed', '目标修复材料已经变化。');
    } else if (![link.bundle.goal, ...link.bundle.relatedGoals].every(row => frozenGoalCurrent(this.store, row)) ||
      !link.bundle.sources.every(ref => this.store.get('events', ref.id)?.revision === ref.revision &&
        sourceAvailable(this.store, this.store.get('events', ref.id))) ||
      !link.dependencyRefs.every(ref => {
        const row = this.store.get(ref.kind, ref.id);
        return row?.revision === ref.revision && dependenciesCurrent(this.store, row, this.store.currentSequence());
      })) fail('goal_source_changed', '目标完整材料的来源或依赖已经变化。');
    // assertCore above still verifies the exact historical bytes. Only the new
    // model-facing view drops transport metadata; the saved link is unchanged.
    return { link, bundle: evidenceView(link.bundle) };
  }
  currentBundle({ sessionId, turn, startSeq }) {
    position({ sessionId, turn, startSeq });
    const bundle = this.emptyBundle({ sessionId, turn, startSeq });
    for (const link of this.store.listAll('goal_links', { where: { sessionId, startSeq } })) {
      if (link.turn !== turn) fail('goal_link_conflict', '同一开始位置不能对应不同轮次。');
      if (this.store.get('goal_link_outcomes', link.id)) continue;
      try { bundle.links.push(this.assertCurrent({ linkId: link.id, sessionId, turn, startSeq }).bundle); }
      catch (error) { if (!(error instanceof DomainError)) throw error; }
    }
    return bundle;
  }

  recordInput({ linkIds, sessionId, turn, startSeq, step, requestIdentity, inputHash }) {
    position({ sessionId, turn, startSeq }); identity(requestIdentity, 'Native request identity');
    if (!nonnegative(step) || !Array.isArray(linkIds) || linkIds.length !== 1 || !/^[a-f0-9]{64}$/.test(inputHash))
      fail('invalid_goal_input', '需要本轮唯一关联及完整模型背景摘要。');
    return this.store.transaction(() => linkIds.map(linkId => {
      this.assertCurrent({ linkId, sessionId, turn, startSeq });
      const record = { id: 'goal-input-' + digest([linkId, requestIdentity]), linkId, sessionId, turn, startSeq,
        step, requestIdentity, inputHash, evidence: 'validated-input-handed-to-host; actual-send-requires-native-request-evidence' };
      const old = this.store.get('goal_inputs', record.id);
      if (old) {
        if (old.inputHash !== inputHash || old.step !== step) fail('goal_input_conflict', '同一发送身份不能更换目标背景。');
        return old;
      }
      return this.store.save('goal_inputs', record);
    }));
  }

  settleTurn({ sessionId, turn, startSeq, outcome, deliveryId = null }) {
    position({ sessionId, turn, startSeq });
    if (!['completed', 'cancelled', 'failed', 'interrupted', 'unknown'].includes(outcome)) fail('invalid_goal_outcome', '需要真实宿主终态。');
    return this.store.transaction(() => {
      const delivery = deliveryId && this.store.get('deliveries', deliveryId);
      if (deliveryId && (!delivery || delivery.sessionId !== sessionId || delivery.turn !== turn || delivery.startSeq !== startSeq))
        fail('goal_delivery_mismatch', '交付不属于关联的原生轮次。');
      return this.store.listAll('goal_links', { where: { sessionId, startSeq } }).map(link => {
        this.assertCore(link);
        if (link.turn !== turn) fail('goal_link_conflict', '关联轮次不匹配。');
        const record = { id: link.id, linkId: link.id, coreHash: link.coreHash, sessionId, turn, startSeq,
          outcome, deliveryId, endEventId: delivery?.endEventId ?? null, contributionEffect: 'not_assessed' };
        const old = this.store.get('goal_link_outcomes', link.id);
        if (old) {
          if (old.outcome !== outcome || old.deliveryId !== deliveryId) fail('goal_outcome_conflict', '原生结束事实不可改换。');
          return old;
        }
        return this.store.save('goal_link_outcomes', record);
      });
    });
  }

  details(goalId, { sessionId, viewScope } = {}) {
    identity(goalId, 'Goal id'); this.reconcile();
    const all = browseScope(viewScope) === 'all';
    const goal = this.store.get('goals', goalId);
    if (!goal || !all && sessionId && !inScope(goal, sessionId)) fail('goal_not_found', '目标不存在或不在当前讨论范围。');
    return this.detailView(goal, { sessionId, viewScope });
  }

  contribution(link) {
    const unavailable = { available: false, message: '当时关联判断的原件或依赖已失效，或缺少可复核版本，暂不展示旧正文。' };
    try { this.assertCore(link); } catch (error) { if (error instanceof DomainError) return unavailable; throw error; }
    const currentGoal = this.store.get('goals', link.goalId);
    if (!currentGoal || currentGoal.deleted || currentGoal.withdrawn || currentGoal.useProhibited ||
        !Array.isArray(link.dependencyRefs) || !link.bundle.sources.every(shown => {
      const source = this.store.get('events', shown.id);
      return source?.revision === shown.revision && sourceAvailable(this.store, source);
    }) || !link.dependencyRefs.every(ref => {
      if (!['understandings', 'methods'].includes(ref.kind)) return false;
      const dependency = this.store.get(ref.kind, ref.id);
      return dependency?.revision === ref.revision && dependenciesCurrent(this.store, dependency, this.store.currentSequence());
    })) return unavailable;
    return { available: true, reason: link.selection.reason, claimType: 'inference',
      sourceIds: [...link.selection.sourceIds], definitionVersion: link.definitionVersion };
  }

  /** Pure projection after the caller has reconciled source-invalid goals once. */
  detailView(goal, { sessionId, viewScope, visibleWorks } = {}) {
    const goalId = goal.id;
    const all = browseScope(viewScope) === 'all';
    const projected = this.view(goal), allowed = Boolean(projected);
    const discussions = this.store.listAll('goal_discussions', { where: { goalId } })
      .filter(row => all || !sessionId || row.sessionId === sessionId).reverse();
    return { goal: projected?.goal || metadata(goal), contentHash: goalContentHash(goal),
      browse: browseContext(goal, sessionId),
      sources: projected?.sources || [], relations: projected?.goal.relations || [], coverage: projected?.coverage || {},
      availability: { allowed, ...(!allowed ? { code: 'goal_source_invalid', message: '目标依据失效，旧内容不再提供。' } : {}) },
      repairAllowed: goalRepairAllowed(goal), controls: { resumeAllowed: allowed },
      discussionsTotal: discussions.length, discussions: discussions.slice(0, 20).map(row => ({ id: row.id,
        sessionId: row.sessionId, requestId: row.requestId, mode: row.mode, content: row.request.content,
        admission: row.admission ?? null, createdAt: row.createdAt })),
      works: visibleWorks ?? (all ? this.browseWorks(sessionId, goalId)
        : sessionId ? this.works(sessionId, goalId, viewScope === undefined ? 20 : null) : []),
      links: this.store.listAll('goal_links', { where: { goalId } }).map(link => ({ id: link.id, sessionId: link.sessionId,
        turn: link.turn, definitionVersion: link.definitionVersion,
        contribution: this.contribution(link),
        outcome: this.store.get('goal_link_outcomes', link.id) })) };
  }
  list({ sessionId, viewScope, offset = 0, limit = 20 } = {}) {
    paging(offset, limit); this.reconcile();
    const all = browseScope(viewScope) === 'all';
    const rows = this.store.listAll('goals').filter(goal => all || !sessionId || inScope(goal, sessionId)).reverse();
    const works = all ? this.browseWorks(sessionId) : sessionId ? this.works(sessionId, null, viewScope === undefined ? 20 : null) : [];
    return { works: viewScope === undefined ? works : works.filter(work => work.relation?.state !== 'current'),
      items: rows.slice(offset, offset + limit).map(goal => this.detailView(goal, { sessionId, viewScope,
        ...(viewScope === undefined ? {} : { visibleWorks: works.filter(work => work.relation?.goalId === goal.id) }) })), total: rows.length,
      nextOffset: offset + limit < rows.length ? offset + limit : null };
  }

  // Read the same persisted work set from every chat; controls still belong to
  // the original chat and must pass the existing native command checks.
  browseWorks(sessionId, goalId = null) {
    // roots() is a read of already-live top-level Agents, never a wake/load.
    const live = this.nativeRoot?.get('agents')?.roots?.() ?? [];
    const sessions = [...new Set([...this.store.listAll('goal_works').map(work => work.sessionId),
      ...live.map(agent => agent.id), ...(sessionId ? [sessionId] : [])])];
    return sessions.flatMap(origin => this.works(origin, goalId, null).map(work => origin === sessionId ? work
      : { ...work, canStop: false, canResume: false, otherSession: true }));
  }


  async controlWork({ sessionId, workId: id, nativeGoalId, nativeRevision, requestId, userIdentity, action, agent }) {
    if (!['pause', 'resume'].includes(action) || id !== nativeWorkId(sessionId, nativeGoalId) || !positive(nativeRevision))
      fail('invalid_goal_work_control', '工作控制须对应准确的原生工作版本。');
    identity(requestId, 'Work control request'); identity(userIdentity, 'User identity');
    const runtime = this.nativeRoot;
    if (!runtime || runtime.get('agents')?.get(sessionId) !== agent)
      fail('goal_main_session_required', '当前主交流已经变化。');
    const native = runtime.get('goals');
    const request = { sessionId, workId: id, nativeGoalId, nativeRevision, requestId, userIdentity, action };
    const decisionId = 'work-control-' + digest([userIdentity, requestId]);
    let prior = this.store.get('goal_work_controls', decisionId);
    const current = () => native.get(agent) ?? null;
    if (prior) {
      if (canonicalJson(prior.request) !== canonicalJson(request)) fail('decision_identity_conflict', '同一工作决定不能更换内容。');
      if (prior.state === 'applied') return { state: 'applied', decisionId, native: current() };
      const event = agent.session.snapshotEvents().find(e => e.seq === prior.nativeSeq);
      if (event?.type === 'goal/change' && event.data.operation === action &&
          event.data.goal?.id === nativeGoalId && event.data.goal.revision === nativeRevision + 1 &&
          (action !== 'resume' || !this.execution || this.execution.browserControlSaved(agent, decisionId, request)) &&
          await runtime.get('sessions').flush(agent.session) === true) {
        const latestDecision = this.store.get('goal_work_controls', decisionId);
        if (latestDecision.state !== 'applied') this.store.save('goal_work_controls',
          { ...latestDecision, state: 'applied', nativeEventHash: digest(event) }, { expectedRevision: latestDecision.revision });
        return { state: 'applied', decisionId, native: current() };
      }
      return { state: 'unknown', decisionId, native: current() };
    }
    const before = current();
    if (!before || before.id !== nativeGoalId || before.revision !== nativeRevision)
      fail('revision_conflict', '执行已变化，请刷新后再决定。');
    if (action === 'pause' && before.phase !== 'active' || action === 'resume' &&
      (!(['paused', 'blocked'].includes(before.phase) || before.phase === 'active' && before.activation === 'disarmed') ||
        before.roundsStarted >= before.maxGoalRounds))
      fail('goal_work_not_resumable', '当前工作状态不允许这个控制，请查看实际进展。');
    if (action === 'resume') {
      if (this.execution) this.execution.assertNative(this.execution.current(agent), before);
      else assertWork(this.store, this.store.get('goal_works', id));
    }
    // Persist the decision before entering the native side. Unknown is never replayed.
    prior = this.store.save('goal_work_controls', { id: decisionId, request, state: 'pending', nativeSeq: agent.session.seq,
      provenance: { kind: 'authenticated_browser_work_control', userIdentity } });
    const finishControl = action === 'resume' && this.execution ? this.execution.beginControl(agent) : () => {};
    try {
      if (action === 'resume' && this.execution)
        this.execution.resume(agent, { goalId: nativeGoalId, revision: nativeRevision, userDecision: decisionId });
      else native[action](agent, { id: nativeGoalId, revision: nativeRevision });
      if (await runtime.get('sessions').flush(agent.session) !== true) throw new Error('Native work control is not durable');
      const event = agent.session.snapshotEvents().find(e => e.seq === prior.nativeSeq);
      if (event?.type !== 'goal/change' || event.data.operation !== action ||
          event.data.goal?.id !== nativeGoalId || event.data.goal.revision !== nativeRevision + 1 ||
          action === 'resume' && this.execution && !this.execution.browserControlSaved(agent, decisionId, request))
        throw new Error('Native work control has no exact receipt');
      const latestDecision = this.store.get('goal_work_controls', decisionId);
        if (latestDecision.state !== 'applied') this.store.save('goal_work_controls',
          { ...latestDecision, state: 'applied', nativeEventHash: digest(event) }, { expectedRevision: latestDecision.revision });
      return { state: 'applied', decisionId, native: current() };
    } catch {
      // A pending receipt remains inspectable if the business write itself failed.
      if (action === 'resume') this.execution?.abortControl(agent, decisionId);
      return { state: 'unknown', decisionId, native: current() };
    } finally { finishControl(); }
  }

  works(sessionId, goalId = null, limit = 20) {
    const agent = this.nativeRoot?.get('agents')?.get(sessionId);
    const native = agent && this.nativeRoot?.get('goals')?.get(agent);
    return workViews(this.store, sessionId, native, goalId, limit).map(work => {
      if (!this.execution) return work;
      const stored = this.store.listAll('execution_stages', { where: { sessionId, nativeGoalId: work.nativeGoalId } })[0];
      const stage = this.execution.view(stored);
      return { ...work, stage, canResume: Boolean(native?.id === work.nativeGoalId &&
        (['paused', 'blocked'].includes(native.phase) || native.phase === 'active' && native.activation === 'disarmed') &&
        native.roundsStarted < native.maxGoalRounds && stage?.available && ['waiting', 'paused', 'running'].includes(stage.status)) };
    });
  }

  /** A browser choice is inert until the exact official user original exists. */
  bindDiscussion({ sessionId, requestId, content, goalId, expectedRevision, definitionVersion, mode, userIdentity }) {
    identity(sessionId, 'Native session id'); identity(requestId, 'Official prompt request id');
    identity(goalId, 'Goal id'); identity(userIdentity, 'Trusted browser identity');
    if (!positive(expectedRevision) || !positive(definitionVersion) || !['discuss', 'repair'].includes(mode) ||
        !Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'text' ||
        typeof content[0].text !== 'string' || !content[0].text.trim() ||
        Object.keys(content[0]).some(key => !['type', 'text'].includes(key)))
      fail('invalid_goal_discussion', '讨论选择须绑定明确版本及随后实际提交的完整文字。');
    const request = { sessionId, requestId, content: copy(content), goalId, expectedRevision,
      definitionVersion, mode, userIdentity };
    this.reconcile();
    return this.store.transaction(() => {
      const id = 'goal-discussion-' + digest([sessionId, requestId]), old = this.store.get('goal_discussions', id);
      const goalRef = { id: goalId, revision: expectedRevision, definitionVersion, mode };
      if (old) {
        if (old.requestHash !== digest(request) || canonicalJson(old.request) !== canonicalJson(request))
          fail('discussion_identity_conflict', '同一原生发送编号不能换目标、原话或用户身份。');
        return { binding: old, goalRef, created: false };
      }
      const goal = this.store.get('goals', goalId);
      if (!goal || goal.revision !== expectedRevision || goal.definitionVersion !== definitionVersion)
        fail('revision_conflict', '目标已变化，请重新查看后选回。');
      if (!inScope(goal, sessionId)) fail('goal_scope_denied', '选择不能扩大目标原有讨论范围。');
      if (mode === 'repair' ? !goalRepairAllowed(goal) : !goalDefinitionCurrent(this.store, goal))
        fail('goal_discussion_unavailable', '目标不具备所选讨论或重新澄清资格。');
      const binding = this.store.save('goal_discussions', { id, sessionId, requestId, contentHash: digest(content),
        goalId, goalRevision: expectedRevision, definitionVersion, mode, userIdentity, request,
        requestHash: digest(request), actor: 'user', provenance: { kind: 'trusted_user_goal_discussion', userIdentity },
        authority: 'chosen-for-one-exact-user-prompt; not-a-prompt-or-execution-record' });
      return { binding, goalRef, created: true };
    });
  }

  recordDiscussionAdmission({ bindingId, state }) {
    if (!['accepted', 'failed', 'unknown'].includes(state)) fail('invalid_discussion_admission', '需要实际提交入口的已知结果或未知。');
    return this.store.transaction(() => {
      const binding = this.store.get('goal_discussions', bindingId);
      if (!binding || digest(binding.request) !== binding.requestHash) fail('goal_discussion_changed', '讨论绑定缺失或改变。');
      if (binding.admission) {
        if (binding.admission.state !== state) fail('discussion_admission_conflict', '提交回执已保存，不可改换或重发。');
        return binding;
      }
      return this.store.save('goal_discussions', { ...binding, admission: { state,
        evidence: 'official-prompt-entry-result; not-proof-of-persisted-user-message' } }, { expectedRevision: binding.revision });
    });
  }

  decide({ goalId, expectedRevision, definitionVersion, action, requestId, userIdentity, sessionId }) {
    identity(goalId, 'Goal id'); identity(requestId, 'Goal decision request'); identity(userIdentity, 'Trusted user identity');
    if (!positive(expectedRevision) || !positive(definitionVersion) || !['pause', 'resume', 'close'].includes(action))
      fail('invalid_goal_decision', '用户目标决定须绑定所见版本和明确动作。');
    const request = { goalId, expectedRevision, definitionVersion, action, requestId, userIdentity, ...(sessionId ? { sessionId } : {}) };
    this.reconcile();
    const result = this.store.transaction(() => {
      const id = 'goal-decision-' + digest([userIdentity, requestId]), prior = this.store.get('goal_decisions', id);
      if (prior) {
        if (canonicalJson(prior.request) !== canonicalJson(request)) fail('decision_identity_conflict', '同一决定身份不能更换内容。');
        return { goal: prior.goal, decision: prior };
      }
      const goal = this.store.get('goals', goalId);
      if (!goal || goal.revision !== expectedRevision || goal.definitionVersion !== definitionVersion)
        fail('revision_conflict', '目标已变化，请重新查看后决定。');
      if (goal.deleted || goal.withdrawn) fail('goal_unavailable', '撤回或删除目标不能改变追踪状态。');
      if (action === 'resume' && !goalDefinitionCurrent(this.store, goal)) fail('goal_source_invalid', '原件失效的目标不能恢复追踪。');
      const saved = saveGoalTransition(this.store, goal, { ...goal, status: { pause: 'paused', resume: 'tracking', close: 'closed' }[action],
        userControl: { action, definitionVersion, decisionId: id, actor: 'user', userIdentity,
          ...(sessionId && this.nativeRoot?.get('agents')?.get(sessionId) ? { nativeBoundary: { sessionId,
            throughSeq: this.nativeRoot.get('agents').get(sessionId).session.seq - 1 } } : {}) } },
        { commandId: id, actor: 'trusted_user_goal_decision', pendingId: null, reason: action });
      const decision = this.store.save('goal_decisions', { id, request, goal: saved, actor: 'user',
        provenance: { kind: 'trusted_user_goal_decision', userIdentity }, meaning: action === 'close' ? 'end-tracking; not-proof-of-achievement' : action });
      return { goal: saved, decision };
    });
    if (action !== 'resume') this.execution?.stopForGoal(goalId);
    return result;
  }
}
