// Business selection and user decisions only. DSH owns tools, turns and requests.
import { DomainError, canonicalJson, identity } from './store.mjs';
import { hash, sourceText, dependenciesCurrent, evidenceProvenance } from './evidence.mjs';
import { invalidateDependents } from './learning-goals.mjs';
import { pauseMethod, methodPauseReason } from './method-lifecycle.mjs';
import { methodContextMessage } from './method-context.mjs';
import { browseScope, browseContext } from './browse-scope.mjs';

export { pauseMethod, methodPauseReason } from './method-lifecycle.mjs';
const fail = (code, message) => { throw new DomainError(code, message); };
const digest = value => hash(JSON.parse(canonicalJson(value)));
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const notificationKinds = new Set(['method_paused', 'method_trial_allocated']);
const inScope = (row, sessionId) => !row.scope?.conversationId || row.scope.conversationId === sessionId;
const version = row => row.version ?? 1;
const contentOf = row => ({ id: row.id, version: version(row), title: row.title, guidance: row.guidance,
  appliesTo: row.appliesTo, doesNotApplyTo: row.doesNotApplyTo, scope: row.scope ?? null,
  sourceIds: row.sourceIds || [], dependencies: row.dependencies || [],
  authority: 'work-guidance-only; no-new-tool-or-permission' });
export const methodContentHash = row => digest(contentOf(row));

function methodSourcesCurrent(store, method, cutoff = store.currentSequence()) {
  return dependenciesCurrent(store, { ...method, status: 'trial' }, cutoff);
}

/** Old trialUses, when present, is a frozen import basis, never a live counter. */
export function usageForVersion(store, method, { cutoffSequence = store.currentSequence() } = {}) {
  const legacyUses = method.trialUses ?? 0, maxTrialUses = method.maxTrialUses;
  if (!nonnegative(legacyUses) || !positive(maxTrialUses) || !nonnegative(cutoffSequence))
    fail('invalid_method_usage', '方法的历史试用次数、上限或统计截止不合法。');
  const counted = store.listAll('method_adoptions', { where: { methodId: method.id } })
    .filter(row => row.methodVersion === version(method) && row.countedTrial === true &&
      row.createdSequence <= cutoffSequence).length;
  const trialUses = legacyUses + counted;
  if (!Number.isSafeInteger(trialUses)) fail('invalid_method_usage', '试用次数超出可表示范围。');
  return { trialUses, maxTrialUses, remaining: Math.max(0, maxTrialUses - trialUses) };
}

function sourcesFor(store, method) {
  const sources = new Map(), visited = new Set();
  function visit(row) {
    if (visited.has(row.id)) return;
    visited.add(row.id);
    for (const id of row.sourceIds || []) sources.set(id, store.get('events', id));
    for (const ref of row.dependencies || []) {
      const kind = ref.kind || ['events', 'understandings', 'methods'].find(k => store.get(k, ref.id));
      const dependency = kind && store.get(kind, ref.id);
      if (kind === 'events') sources.set(ref.id, dependency);
      else if (dependency) visit(dependency);
    }
  }
  visit(method);
  return [...sources.values()].filter(Boolean).map(source => ({ id: source.id, revision: source.revision,
    role: source.role, content: sourceText(source), occurredAt: source.occurredAt ?? null,
    provenance: evidenceProvenance(source.provenance) }));
}

function assertNative({ sessionId, turn, startSeq }) {
  identity(sessionId, 'Native session id');
  if (!nonnegative(turn) || !nonnegative(startSeq)) fail('invalid_native_turn', '需要真实宿主轮次及开始序号。');
}
function pagination(offset, limit, maximum) {
  if (!nonnegative(offset) || !positive(limit) || limit > maximum) fail('invalid_pagination', '分页参数不合法。');
}
const page = (rows, offset, limit) => ({ items: rows.slice(offset, offset + limit), total: rows.length,
  nextOffset: offset + limit < rows.length ? offset + limit : null });

export class MethodService {
  constructor({ business }) {
    if (!business?.storage) fail('invalid_method_config', '需要业务存储。');
    this.store = business.storage;
  }

  reconcile() {
    return this.store.transaction(() => {
      const paused = [];
      for (const stale of this.store.listAll('methods')) {
        const method = this.store.get('methods', stale.id);
        if (!['trial', 'active'].includes(method.status)) continue;
        let reason = !methodSourcesCurrent(this.store, method) ? 'source_changed' : null;
        if (!reason && method.status === 'trial' && usageForVersion(this.store, method).remaining === 0) {
          const open = this.store.listAll('method_adoptions', { where: { methodId: method.id } })
            .some(row => row.methodVersion === version(method) && row.state !== 'settled');
          if (!open) reason = 'trial_limit';
          else this.ensureTrialNotice(method);
        }
        if (!reason) continue;
        const saved = pauseMethod(this.store, method, { reason });
        invalidateDependents(this.store, { ids: [method.id], pendingId: null, reason: 'method_' + reason });
        paused.push(saved);
      }
      return paused;
    });
  }

  catalog({ sessionId, cutoffSequence = this.store.currentSequence() }) {
    identity(sessionId, 'Native session id');
    if (!nonnegative(cutoffSequence)) fail('invalid_cutoff', '需要有效的材料截止序号。');
    this.reconcile();
    return this.store.listAll('methods').filter(method => ['trial', 'active'].includes(method.status) &&
      inScope(method, sessionId) && dependenciesCurrent(this.store, method, cutoffSequence)).flatMap(method => {
      const usage = usageForVersion(this.store, method);
      if (method.status === 'trial' && usage.remaining === 0) return [];
      return [{ id: method.id, revision: method.revision, version: version(method), contentHash: methodContentHash(method),
        title: method.title, appliesTo: method.appliesTo, doesNotApplyTo: method.doesNotApplyTo,
        sourceIds: [...method.sourceIds], status: method.status, ...usage }];
    });
  }

  /** Native identities and snapshot ids must be derived by the trusted adapter. */
  reserve({ sessionId, turn, startSeq, callId, contextSnapshotId, contextMessageId, selections, maxCharacters = 24000 }) {
    assertNative({ sessionId, turn, startSeq }); identity(callId, 'Native tool call id');
    identity(contextSnapshotId, 'Context snapshot id'); identity(contextMessageId, 'Context message id');
    if (!Array.isArray(selections) || selections.length < 1 || selections.length > 8 ||
        new Set(selections.map(row => row?.id)).size !== selections.length ||
        !positive(maxCharacters) || maxCharacters > 180000) fail('invalid_method_selection', '一次需选择一至八条不重复方法，并保留完整材料。');
    this.reconcile();
    return this.store.transaction(() => {
      const snapshot = this.store.get('context_snapshots', contextSnapshotId);
      if (this.store.get('host_bindings', sessionId)?.role !== 'main' || !snapshot ||
          snapshot.sessionId !== sessionId || snapshot.turn !== turn || snapshot.contextMessageId !== contextMessageId ||
          !Array.isArray(snapshot.material?.methods)) fail('method_context_mismatch', '选择没有对应的主会话已展示目录。');
      const prepared = selections.map(selection => {
        const shown = snapshot.material.methods.find(row => row.id === selection.id);
        const method = this.store.get('methods', selection.id);
        if (!shown || !method || shown.revision !== selection.revision || shown.contentHash !== selection.contentHash ||
            method.revision !== selection.revision || methodContentHash(method) !== selection.contentHash)
          fail('method_selection_changed', '方法未展示或版本已经改变，请重新读取目录。');
        if (typeof selection.reason !== 'string' || !selection.reason.trim() || selection.reason.length > 2000 ||
            !Array.isArray(selection.sourceIds) || !selection.sourceIds.length ||
            new Set(selection.sourceIds).size !== selection.sourceIds.length ||
            selection.sourceIds.some(id => !shown.sourceIds.includes(id)))
          fail('invalid_method_selection', '选择须保留理由并引用所见目录中的来源。');
        if (!['trial', 'active'].includes(method.status) || !inScope(method, sessionId) ||
            !dependenciesCurrent(this.store, method, snapshot.material.cutoffSequence))
          fail('method_unavailable', '方法或其原件已暂停、失效或越过展示截止。');
        const contentHash = methodContentHash(method), methodVersion = version(method);
        const id = 'method-adoption-' + digest([sessionId, startSeq, method.id, methodVersion, contentHash]);
        const existing = this.store.get('method_adoptions', id);
        if (existing && (existing.turn !== turn || existing.state === 'settled'))
          fail('method_adoption_closed', '该采用所属轮次已经结束或身份不一致。');
        if (!existing && method.status === 'trial' && usageForVersion(this.store, method).remaining === 0)
          fail('method_trial_exhausted', '试用次数已用完，当前已领取工作可完成，新的采用需用户决定。');
        const adoption = existing || { id, sessionId, turn, startSeq, methodId: method.id, methodVersion,
          methodRevision: method.revision, contentHash, countedTrial: method.status === 'trial', state: 'reserved',
          contextSnapshotId, contextMessageId, callIds: [], selection: { reason: selection.reason,
            sourceIds: [...selection.sourceIds], claimType: 'inference' }, authority: 'selected-for-this-native-turn-only' };
        return { method, adoption, existing };
      });
      const bundle = { version: 'arcfold-adopted-methods-v1', sessionId, turn, startSeq,
        methods: prepared.map(({ method, adoption }) => this.bundleEntry(method, adoption)),
        authority: 'program-provided guidance; not user instructions or new execution permission' };
      // A later tool call may add methods, but cannot grow this turn's background
      // without bound by repeatedly staying below the per-call capacity.
      const current = this.currentBundle({ sessionId, turn, startSeq });
      const combined = new Map([...current.methods, ...bundle.methods].map(entry => [entry.adoptionId, entry]));
      if (methodContextMessage({ ...current, methods: [...combined.values()] }).content[0].text.length > maxCharacters)
        fail('method_capacity', '本轮已选及新选方法的完整材料合计超过容量，本次未新增占用。');
      const adoptions = prepared.map(({ adoption, existing }) => adoption.callIds.includes(callId) ? adoption
        : this.store.save('method_adoptions', { ...adoption, callIds: [...adoption.callIds, callId] },
          { expectedRevision: existing?.revision ?? null }));
      for (const { method } of prepared) this.ensureTrialNotice(method);
      return { receipt: { adoptionIds: adoptions.map(row => row.id), methods: adoptions.map(row => ({
        id: row.methodId, revision: row.methodRevision, version: row.methodVersion, contentHash: row.contentHash,
        adoptionId: row.id })), authority: 'selection-receipt-only; not evidence of effective use' }, bundle };
    });
  }

  bundleEntry(method, adoption) {
    return { adoptionId: adoption.id, method: contentOf(method), sources: sourcesFor(this.store, method),
      selection: adoption.selection };
  }

  pendingAdoptions(method) {
    const contentHash = methodContentHash(method);
    return this.store.listAll('method_adoptions', { where: { methodId: method.id } })
      .filter(row => row.methodVersion === version(method) && row.contentHash === contentHash && row.state !== 'settled')
      .map(({ id, sessionId, turn, startSeq, callIds, state }) => ({ id, sessionId, turn, startSeq, callIds, state }));
  }

  // This states a durable allocation fact, not whether a native writer is alive,
  // whether a model received the method, or whether its use succeeded.
  ensureTrialNotice(method) {
    if (method.status !== 'trial' || usageForVersion(this.store, method).remaining !== 0) return null;
    const contentHash = methodContentHash(method);
    const id = 'method-trial-allocated-' + digest([method.id, version(method), contentHash]);
    const existing = this.store.get('notifications', id);
    if (existing) return existing;
    const pendingAdoptions = this.pendingAdoptions(method);
    if (!pendingAdoptions.length) return null;
    return this.store.save('notifications', { id, kind: 'method_trial_allocated', status: 'unread',
      methodId: method.id, methodRevision: method.revision, methodVersion: version(method), contentHash,
      reason: 'trial_allocated', title: '协作方法试用名额已全部领取',
      message: `“${method.title || '未命名方法'}”：登记提醒时，试用名额已全部领取；部分采用结果仍待核对；当时已领取工作可继续，新的采用等待你决定。`,
      pendingAdoptions, pendingAdoptionCount: pendingAdoptions.length,
      evidence: 'allocated-trial-usage; native-outcome-and-effectiveness-not-established' });
  }

  /** Projection only. Host still checks successful tool receipts before sending. */
  currentBundle({ sessionId, turn, startSeq }) {
    assertNative({ sessionId, turn, startSeq });
    return this.store.transaction(() => ({ version: 'arcfold-adopted-methods-v1', sessionId, turn, startSeq,
      methods: this.store.listAll('method_adoptions', { where: { sessionId, startSeq } }).flatMap(adoption => {
        if (adoption.turn !== turn) fail('method_adoption_conflict', '同一起点不能属于不同宿主轮次。');
        if (adoption.state === 'settled') return [];
        const method = this.store.get('methods', adoption.methodId);
        if (!method || !['trial', 'active'].includes(method.status) || !inScope(method, sessionId) ||
            version(method) !== adoption.methodVersion || methodContentHash(method) !== adoption.contentHash ||
            !dependenciesCurrent(this.store, method, this.store.currentSequence())) return [];
        return [this.bundleEntry(method, adoption)];
      }), authority: 'program-provided guidance; not user instructions or new execution permission' }));
  }

  assertCurrent({ adoptionId, sessionId, turn, startSeq }) {
    assertNative({ sessionId, turn, startSeq }); identity(adoptionId, 'Method adoption id');
    this.reconcile();
    const adoption = this.store.get('method_adoptions', adoptionId);
    if (!adoption || adoption.sessionId !== sessionId || adoption.turn !== turn || adoption.startSeq !== startSeq ||
        adoption.state === 'settled') fail('method_adoption_closed', '采用不属于当前有效宿主轮次。');
    const method = this.store.get('methods', adoption.methodId);
    if (!method || !['trial', 'active'].includes(method.status) || !inScope(method, sessionId) ||
        version(method) !== adoption.methodVersion || methodContentHash(method) !== adoption.contentHash ||
        !dependenciesCurrent(this.store, method, this.store.currentSequence()))
      fail('method_unavailable', '所选方法的内容、来源或当前授权已变化。');
    return { adoption, bundle: this.bundleEntry(method, adoption) };
  }

  /** Validated input handed to DSH. A later provider guard may still reject it. */
  recordInput({ adoptionIds, sessionId, turn, startSeq, step, requestIdentity, inputHash }) {
    assertNative({ sessionId, turn, startSeq }); identity(requestIdentity, 'Native request identity');
    if (!nonnegative(step) || !Array.isArray(adoptionIds) || !adoptionIds.length ||
        new Set(adoptionIds).size !== adoptionIds.length || typeof inputHash !== 'string' || !/^[a-f0-9]{64}$/.test(inputHash))
      fail('invalid_method_input', '需要原生模型步骤、不重复的采用编号和完整背景消息的摘要。');
    return this.store.transaction(() => adoptionIds.map(adoptionId => {
      this.assertCurrent({ adoptionId, sessionId, turn, startSeq });
      const record = { id: 'method-input-' + digest([adoptionId, requestIdentity]), adoptionId,
        sessionId, turn, startSeq, step, requestIdentity, inputHash,
        evidence: 'validated-input-handed-to-host-provider; actual-send-requires-native-request-evidence' };
      const old = this.store.get('method_inputs', record.id);
      if (old) {
        if (old.step !== step || old.sessionId !== sessionId || old.turn !== turn || old.startSeq !== startSeq || old.inputHash !== inputHash)
          fail('method_input_conflict', '同一请求身份不能对应不同原生步骤或背景消息。');
        return old;
      }
      return this.store.save('method_inputs', record);
    }));
  }

  /** The bridge supplies an already persisted terminal native turn, never a job. */
  settleTurn({ sessionId, turn, startSeq, outcome, deliveryId = null }) {
    assertNative({ sessionId, turn, startSeq });
    if (!['completed', 'cancelled', 'failed', 'interrupted', 'unknown'].includes(outcome)) fail('invalid_method_outcome', '需要宿主终态。');
    return this.store.transaction(() => {
      if (deliveryId) {
        const delivery = this.store.get('deliveries', deliveryId);
        if (!delivery || delivery.sessionId !== sessionId || delivery.turn !== turn || delivery.startSeq !== startSeq)
          fail('method_delivery_mismatch', '正式交付不属于该原生轮次。');
      }
      const records = this.store.listAll('method_adoptions', { where: { sessionId, startSeq } }).map(row => {
        if (row.turn !== turn) fail('method_adoption_conflict', '同一起点不能属于不同宿主轮次。');
        if (row.state === 'settled') {
          if (row.outcome !== outcome || row.deliveryId !== deliveryId) fail('method_outcome_conflict', '原生终态已经记录，不能改写。');
          return row;
        }
        return this.store.save('method_adoptions', { ...row, state: 'settled', outcome, deliveryId,
          effectiveness: 'not_assessed' }, { expectedRevision: row.revision });
      });
      this.reconcile();
      return records;
    });
  }

  successors(method) {
    return this.store.listAll('methods', { where: { previousId: method.id } })
      .filter(row => version(row) > version(method))
      .map(({ id, title, status, version }) => ({ id, title, status, version }));
  }

  details(methodId) {
    identity(methodId, 'Method id'); this.reconcile();
    const method = this.store.get('methods', methodId);
    if (!method) fail('method_not_found', '方法不存在。');
    return this.detailView(method);
  }

  detailView(method, { includeSources = true } = {}) {
    const usage = usageForVersion(this.store, method), successors = this.successors(method);
    const pendingAdoptions = this.pendingAdoptions(method);
    const issue = !['trial', 'paused'].includes(method.status)
      ? { code: 'invalid_method_state', message: '只有试用或暂停的方法可以确认继续。' }
      : successors.length ? { code: 'method_superseded', message: '已有后继版本，请查看新版本后决定。' }
        : !methodSourcesCurrent(this.store, method) ? { code: 'method_source_invalid', message: '原件或依赖已经失效，需先修正内容。' } : null;
    return { method, contentHash: methodContentHash(method), usage, successors,
      pendingAdoptions, pendingAdoptionCount: pendingAdoptions.length,
      reason: method.status === 'paused' ? methodPauseReason(method) : method.status === 'active'
        ? '你已明确确认在适用范围内继续采用，仍不代表效果已验证。'
        : usage.remaining ? '正在有限试用；只有实际选入当前工作时才占用次数。' : '试用名额已用完，已领取的工作可继续完成；新的采用等待你决定。',
      needsDecision: !successors.length && method.pauseReason !== 'user_request' &&
        (method.status === 'paused' || method.status === 'trial' && usage.remaining === 0),
      activation: { allowed: !issue, ...(issue || {}) }, sources: includeSources ? sourcesFor(this.store, method) : [] };
  }

  unavailableView(methodId, methodVersion) {
    return { method: { id: methodId, title: '方法记录暂不可用', status: 'unavailable', version: methodVersion },
      reason: '未找到这条方法的当前记录，历史提醒仍保留。', needsDecision: false, usage: null,
      activation: { allowed: false, code: 'method_not_found', message: '当前方法记录不可用，不能作出采用决定。' },
      sources: [], successors: [], pendingAdoptions: [], pendingAdoptionCount: 0 };
  }

  // Group the complete collections before paging. Two independently paged
  // lists cannot establish one current card per method or complete history.
  listCards({ sessionId, viewScope, offset = 0, limit = 20 } = {}) {
    pagination(offset, limit, 100);
    const scope = browseScope(viewScope, 'all');
    if (viewScope !== undefined) identity(sessionId, 'Browsing session');
    return this.store.transaction(() => {
      this.reconcile();
      const histories = new Map();
      for (const notice of this.store.listAll('notifications').filter(row => notificationKinds.has(row.kind))) {
        if (!histories.has(notice.methodId)) histories.set(notice.methodId, []);
        histories.get(notice.methodId).push(notice);
      }
      const methods = new Map(this.store.listAll('methods').map(row => [row.id, row]));
      const rows = [...new Set([...methods.keys(), ...histories.keys()])].flatMap(id => {
        const method = methods.get(id), history = histories.get(id) || [];
        if (scope === 'current' && (!method || !inScope(method, sessionId))) return [];
        const detail = method ? this.detailView(method, { includeSources: false })
          : this.unavailableView(id, history.at(-1)?.methodVersion);
        // Keep the original management endpoint compatible. The explicit
        // browse view includes active/trial methods without notices as well.
        if (viewScope === undefined && !detail.needsDecision && !history.length) return [];
        return [{ method: { id, title: detail.method.title, version: detail.method.version ?? 1,
          revision: detail.method.revision, status: detail.method.status },
          reason: detail.reason, needsDecision: detail.needsDecision,
          ...(method ? { browse: browseContext(method, sessionId) } : {}),
          notificationCount: history.length, unreadCount: history.filter(row => row.status === 'unread').length,
          order: history.reduce((latest, row) => Math.max(latest, row.createdSequence ?? 0), method?.updatedSequence ?? 0) }];
      }).sort((a, b) => Number(b.needsDecision) - Number(a.needsDecision) || b.order - a.order || a.method.id.localeCompare(b.method.id));
      return { ...page(rows.map(({ order, ...row }) => row), offset, limit),
        decisionCount: rows.filter(row => row.needsDecision).length,
        unreadCount: rows.reduce((count, row) => count + row.unreadCount, 0) };
    });
  }

  cardDetails(methodId, { sessionId, viewScope, offset = 0, limit = 20 } = {}) {
    identity(methodId, 'Method id'); pagination(offset, limit, 100);
    const scope = browseScope(viewScope, 'all');
    if (viewScope !== undefined) identity(sessionId, 'Browsing session');
    return this.store.transaction(() => {
      const notifications = this.notifications({ methodId, offset, limit });
      const method = this.store.get('methods', methodId);
      if (!method && !notifications.total) fail('method_not_found', '方法不存在。');
      if (scope === 'current' && (!method || !inScope(method, sessionId)))
        fail('method_not_found', '此方法不在当前聊天筛选范围。');
      const detail = method ? this.detailView(method)
        : this.unavailableView(methodId, notifications.items[0]?.methodVersion);
      return { ...detail, ...(method ? { browse: browseContext(method, sessionId) } : {}),
        notifications: { ...notifications, offset } };
    });
  }

  listDecisions({ offset = 0, limit = 20 } = {}) {
    pagination(offset, limit, 100);
    return this.store.transaction(() => {
      this.reconcile();
      const rows = this.store.listAll('methods').map(row => this.detailView(row)).filter(row => row.needsDecision).reverse();
      return page(rows, offset, limit);
    });
  }

  notifications({ offset = 0, limit = 100, unread = false, methodId } = {}) {
    pagination(offset, limit, 200);
    if (typeof unread !== 'boolean') fail('invalid_pagination', '通知筛选参数不合法。');
    if (methodId !== undefined) identity(methodId, 'Method id');
    this.reconcile();
    const legacySuffix = '学习提出暂停：import_batch_withdrawn';
    const rows = this.store.listAll('notifications').filter(row => notificationKinds.has(row.kind) &&
      (methodId === undefined || row.methodId === methodId)).reverse()
      // Preserve the notice's own title prefix and persisted wording. Correct
      // only the exact old suffix; never reinterpret it from today's method.
      .map(row => row.kind === 'method_paused' && row.reason === 'import_batch_withdrawn' &&
          typeof row.message === 'string' && row.message.endsWith(legacySuffix)
        ? { ...row, displayMessage: row.message.slice(0, -legacySuffix.length) +
            methodPauseReason({ pauseReason: row.reason }) } : row);
    return { ...page(unread ? rows.filter(row => row.status === 'unread') : rows, offset, limit),
      unreadCount: rows.filter(row => row.status === 'unread').length };
  }

  acknowledgeNotification(notificationId) {
    return this.store.transaction(() => {
      const row = this.store.get('notifications', notificationId);
      if (!row || !notificationKinds.has(row.kind)) fail('notification_not_found', '方法通知不存在。');
      return row.status === 'read' ? row : this.store.save('notifications', { ...row, status: 'read' }, { expectedRevision: row.revision });
    });
  }

  /** Trusted browser handler only. Never register this as a model-facing tool. */
  decide({ methodId, expectedRevision, contentHash, action, requestId, userIdentity }) {
    identity(methodId, 'Method id'); identity(requestId, 'User decision request id'); identity(userIdentity, 'Trusted user identity');
    if (!positive(expectedRevision) || typeof contentHash !== 'string' || !['continue', 'pause'].includes(action))
      fail('invalid_method_decision', '用户决定须绑定所见方法版本和具体操作。');
    const request = { methodId, expectedRevision, contentHash, action, requestId, userIdentity };
    this.reconcile();
    return this.store.transaction(() => {
      const id = 'method-decision-' + digest([userIdentity, requestId]), existing = this.store.get('method_decisions', id);
      if (existing) {
        if (canonicalJson(existing.request) !== canonicalJson(request)) fail('decision_identity_conflict', '同一决定请求不能更换内容。');
        return { method: existing.method, decision: existing };
      }
      const detail = this.details(methodId), before = detail.method;
      if (before.revision !== expectedRevision || detail.contentHash !== contentHash) fail('revision_conflict', '方法已变化，请重新查看全文和停止理由。');
      if (action === 'continue' && !detail.activation.allowed) fail(detail.activation.code, detail.activation.message);
      const method = action === 'pause' ? pauseMethod(this.store, before, { reason: 'user_request' })
        : this.store.save('methods', { ...before, status: 'active', validated: false, pauseReason: null,
          withdrawalReason: null, activationReason: 'explicit_user_decision', activationDecisionId: id },
          { expectedRevision: before.revision });
      if (action === 'pause') invalidateDependents(this.store, { ids: [methodId], pendingId: null, reason: 'method_user_request' });
      const decision = this.store.save('method_decisions', { id, request, actor: 'user',
        provenance: { kind: 'trusted_user_method_decision', userIdentity }, before, method,
        authority: 'current-method-guidance-only; no-additional-tool-or-work-permission' });
      return { method, decision };
    });
  }
}
