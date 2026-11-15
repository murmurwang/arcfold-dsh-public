// User control over business knowledge. Native DSH alone admits and runs input.
import { DomainError, canonicalJson, identity } from './store.mjs';
import { eventId } from './business.mjs';
import { hash, sourceText, sourceAvailable, dependenciesCurrent } from './evidence.mjs';
import { projectUnderstanding } from './learning-contracts.mjs';
import { invalidateDependents } from './learning-goals.mjs';
import { GoalService } from './goals.mjs';
import { browseScope, browseContext } from './browse-scope.mjs';

const fail = (code, message) => { throw new DomainError(code, message); };
const digest = value => hash(JSON.parse(canonicalJson(value)));
const copy = value => JSON.parse(canonicalJson(value));
const positive = value => Number.isSafeInteger(value) && value > 0;
const inScope = (row, sessionId) => !row.scope?.conversationId || row.scope.conversationId === sessionId;
const allowedKeys = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)))
    fail('invalid_understanding_request', '理解操作只接受规定的版本、内容和可信调用身份。');
};
const commandId = (sessionId, requestId) => 'understanding-command-' + digest([sessionId, requestId]);

// Retain missing originals as missing; never fabricate their author or text.
function sourcesFor(store, record) {
  const ids = new Set(), seen = new Set();
  function visit(row) {
    if (!row || seen.has(row.id)) return;
    seen.add(row.id);
    for (const id of row.sourceIds || []) ids.add(id);
    for (const ref of row.dependencies || []) {
      const kind = ref.kind || ['events', 'understandings', 'methods'].find(name => store.get(name, ref.id));
      if (kind === 'events') ids.add(ref.id);
      else if (['understandings', 'methods'].includes(kind)) visit(store.get(kind, ref.id));
    }
  }
  visit(record);
  return [...ids].map(id => {
    const source = store.get('events', id), control = store.get('source_controls', id);
    return { id, revision: source?.revision ?? null, available: Boolean(source && sourceAvailable(store, source)),
      missing: !source, role: source?.role ?? null, author: source?.author ?? source?.role ?? null,
      content: source ? sourceText(source) : null, occurredAt: source?.occurredAt ?? null,
      provenance: source?.provenance ?? null, control: control ?? null,
      expectedControlRevision: control?.revision ?? null };
  });
}

/** Trusted Host supplies identity; an identity string never proves native input. */
export class UnderstandingService {
  constructor({ business, goals = new GoalService({ business }) }) {
    if (!business?.storage) fail('invalid_understanding_config', '需要业务存储。');
    this.store = business.storage;
    this.goals = goals;
  }

  session(sessionId) {
    // The authenticated Host checks the live main Agent for management.
    // A past execution binding neither admits browsing nor proves current input.
    identity(sessionId, 'Native main session');
  }
  target({ sessionId, understandingId, expectedRevision }) {
    const row = this.store.get('understandings', understandingId);
    if (!row || !inScope(row, sessionId)) fail('understanding_not_found', '理解不存在或不在当前交流的可见范围。');
    if (expectedRevision !== undefined && row.revision !== expectedRevision)
      fail('revision_conflict', '理解已经变化，请重新查看所见版本。');
    return row;
  }
  view(row) {
    const sources = sourcesFor(this.store, row);
    const projected = projectUnderstanding(row, sources.filter(source => !source.missing));
    const available = row.status === 'active' && dependenciesCurrent(this.store, row, this.store.currentSequence());
    return { understanding: projected, sources, availability: { allowed: available,
      ...(!available ? { code: 'understanding_unavailable', message: '记录保留，当前不作为 Arcfold 有效背景采用。' } : {}) },
      controls: { stopAllowed: row.status === 'active' && !row.deleted,
        correctionAllowed: this.isCorrectable(row) },
      historyPreserved: true, authority: 'provenance and eligibility only; not truth or action permission' };
  }
  list({ sessionId, viewScope, offset = 0, limit = 20 } = {}) {
    this.session(sessionId);
    const all = browseScope(viewScope) === 'all';
    if (!Number.isSafeInteger(offset) || offset < 0 || !positive(limit) || limit > 100)
      fail('invalid_pagination', '理解列表分页参数不合法。');
    const rows = this.store.listAll('understandings').filter(row => all || inScope(row, sessionId)).reverse();
    return { items: rows.slice(offset, offset + limit).map(row => this.browseView(row, sessionId)), total: rows.length,
      nextOffset: offset + limit < rows.length ? offset + limit : null };
  }
  browseView(row, sessionId) {
    const detail = this.view(row), browse = browseContext(row, sessionId);
    return { ...detail, browse, controls: { ...detail.controls,
      stopAllowed: browse.related && detail.controls.stopAllowed,
      correctionAllowed: browse.related && detail.controls.correctionAllowed, sourceControlAllowed: browse.related } };
  }
  details({ sessionId, understandingId, viewScope }) {
    this.session(sessionId); identity(understandingId, 'Understanding id');
    const all = browseScope(viewScope) === 'all';
    const row = all ? this.store.get('understandings', understandingId) : this.target({ sessionId, understandingId });
    if (!row) fail('understanding_not_found', '理解不存在。');
    const history = [], seen = new Set();
    let current = row;
    while (current && !seen.has(current.id) && (all || inScope(current, sessionId))) {
      seen.add(current.id); history.push(current);
      current = current.previousId ? this.store.get('understandings', current.previousId) : null;
    }
    const commands = this.store.listAll('understanding_commands').filter(command => (all || command.sessionId === sessionId) &&
      (command.understandingId === row.id || command.result?.after?.id === row.id)).reverse();
    const successors = this.store.listAll('understandings').filter(item => item.previousId === row.id && (all || inScope(item, sessionId)));
    return { ...this.browseView(row, sessionId), historyTotal: history.length, history: history.slice(0, 20).map(item => this.browseView(item, sessionId)),
      commandsTotal: commands.length, commands: commands.slice(0, 20), successorsTotal: successors.length,
      successors: successors.slice(0, 20).map(item => ({ id: item.id, revision: item.revision, version: item.version, status: item.status })) };
  }
  request(input, correction = false) {
    allowedKeys(input, ['sessionId', 'requestId', 'understandingId', 'expectedRevision', 'userIdentity',
      ...(correction ? ['text'] : ['action', 'sourceRef'])]);
    this.session(input.sessionId);
    for (const key of ['requestId', 'understandingId', 'userIdentity']) identity(input[key], key);
    if (!positive(input.expectedRevision)) fail('invalid_understanding_request', '需要所见理解的明确版本。');
    if (correction) {
      if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 16000 || input.text.includes('\0'))
        fail('invalid_correction_text', '请提交一段不超过 16000 字符的完整新表述；原字和换行会保留。');
    } else if (!['stop-understanding', 'withdraw-source'].includes(input.action)) {
      fail('invalid_understanding_action', '只接受停用理解或停止把原件当依据。');
    }
    return copy({ ...input, action: correction ? 'correct' : input.action });
  }
  prior(request) {
    const prior = this.store.get('understanding_commands', commandId(request.sessionId, request.requestId));
    if (prior && (prior.requestHash !== digest(request) || canonicalJson(prior.request) !== canonicalJson(request)))
      fail('understanding_identity_conflict', '同一请求编号不能更换操作、原话、版本或用户身份。');
    return prior;
  }
  savedCommand(request, fields = {}) {
    return this.store.save('understanding_commands', { id: commandId(request.sessionId, request.requestId),
      sessionId: request.sessionId, requestId: request.requestId, understandingId: request.understandingId,
      action: request.action, request, requestHash: digest(request), actor: 'user',
      provenance: { kind: 'trusted_owner_understanding_control', userIdentity: request.userIdentity },
      admission: null, result: null, ...fields });
  }
  goalViews() {
    return new Map(this.store.listAll('goals').map(goal => {
      const view = this.goals.view(goal);
      return [goal.id, { id: goal.id, revision: goal.revision, status: goal.status, userControl: goal.userControl ?? null,
        definitionAvailable: Boolean(view), progressAvailable: Boolean(view?.goal.progress),
        coverage: view?.coverage ?? null, relations: view?.goal.relations.map(row => ({ type: row.type,
          targetId: row.targetId, state: row.state })) ?? null }];
    }));
  }
  impacts(before) {
    const after = this.goalViews();
    return [...after].flatMap(([id, value]) => canonicalJson(before.get(id) ?? null) === canonicalJson(value)
      ? [] : [{ id, before: before.get(id) ?? null, after: value }]);
  }

  decide(input) {
    const request = this.request(input);
    if (request.action === 'withdraw-source') {
      allowedKeys(request.sourceRef, ['id', 'revision', 'expectedControlRevision']);
      identity(request.sourceRef.id, 'Original source id');
      if (!positive(request.sourceRef.revision) || !(request.sourceRef.expectedControlRevision === null || positive(request.sourceRef.expectedControlRevision)))
        fail('invalid_source_control', '停止依据须绑定原件版本与当前控制版本，首次控制使用 null。');
    } else if (request.sourceRef !== undefined) fail('invalid_source_control', '停用理解不能附带原件操作。');
    return this.store.transaction(() => {
      const prior = this.prior(request);
      if (prior) return { command: prior, created: false };
      const before = this.target(request), goalsBefore = this.goalViews();
      const id = commandId(request.sessionId, request.requestId);
      let after = before, control = null, invalidIds, reason;
      if (request.action === 'stop-understanding') {
        if (before.status !== 'active' || before.deleted) fail('understanding_unavailable', '所见理解已停用、替换或删除。');
        after = this.store.save('understandings', { ...before, status: 'withdrawn',
          changedByCommandId: id, withdrawalReason: 'understanding_stopped_by_user' }, { expectedRevision: before.revision });
        invalidIds = [before.id]; reason = 'understanding_stopped_by_user';
      } else {
        if (!sourcesFor(this.store, before).some(source => source.id === request.sourceRef.id))
          fail('source_scope_denied', '只能停止这条已显示理解的真实来源链中的原件。');
        const source = this.store.get('events', request.sourceRef.id), existing = this.store.get('source_controls', request.sourceRef.id);
        if (!source || source.revision !== request.sourceRef.revision || (existing?.revision ?? null) !== request.sourceRef.expectedControlRevision)
          fail('revision_conflict', '原件或其控制状态已变化，请重新查看。');
        if (!sourceAvailable(this.store, source)) fail('source_unavailable', '该原件已经停止作为依据。');
        control = this.store.save('source_controls', { ...existing, id: source.id, useProhibited: true,
          sourceRevision: source.revision, commandId: id, reason: 'source_withdrawn_by_user', actor: 'user',
          provenance: { kind: 'trusted_owner_source_control', userIdentity: request.userIdentity } },
        { expectedRevision: existing?.revision ?? null });
        invalidIds = [source.id]; reason = 'source_withdrawn_by_user';
      }
      const changes = invalidateDependents(this.store, { ids: invalidIds, pendingId: id, reason });
      after = this.store.get('understandings', before.id);
      const command = this.savedCommand(request, { result: { state: 'applied', before, after, control, changes,
        goalImpacts: this.impacts(goalsBefore), meaning: 'future Arcfold eligibility; original native history and prior actions remain' } });
      return { command, created: true };
    });
  }

  bindCorrection(input) {
    const request = this.request(input, true);
    return this.store.transaction(() => {
      const prior = this.prior(request);
      if (prior) return { command: prior, created: false };
      const old = this.target(request);
      this.assertCorrectable(old);
      return { command: this.savedCommand(request), created: true };
    });
  }
  isCorrectable(row) {
    // Source invalidation may mark a superseded historical row withdrawn. A
    // real successor still makes it historical, regardless of either status.
    return !row.deleted && ['active', 'withdrawn'].includes(row.status) && positive(row.version) &&
      positive(row.version + 1) && this.store.list('understandings', { where: { previousId: row.id }, limit: 1 }).length === 0;
  }
  assertCorrectable(row) {
    if (!this.isCorrectable(row))
      fail('understanding_unavailable', '只能纠正保有版本身份的当前理解；旧版本仍可查看或撤回来源，请选择当前版本纠正。');
  }
  assertCommand(command) {
    if (!command || command.action !== 'correct' || digest(command.request) !== command.requestHash ||
        command.id !== commandId(command.request.sessionId, command.request.requestId) ||
        command.sessionId !== command.request.sessionId || command.requestId !== command.request.requestId ||
        command.understandingId !== command.request.understandingId)
      fail('understanding_command_changed', '纠正绑定缺失或已被改写。');
  }
  recordCorrectionAdmission({ commandId: id, state }) {
    if (!['accepted', 'failed', 'unknown'].includes(state)) fail('invalid_correction_admission', '需要实际原生提交入口的结果。');
    return this.store.transaction(() => {
      const command = this.store.get('understanding_commands', id); this.assertCommand(command);
      if (command.admission) {
        if (command.admission.state !== state) fail('correction_admission_conflict', '提交结果已保存，不可改换或重发。');
        return command;
      }
      return this.store.save('understanding_commands', { ...command, admission: { state,
        evidence: 'native-prompt-entry-result; not-proof-of-durable-owner-input' } }, { expectedRevision: command.revision });
    });
  }

  // This internal call receives the exact claims returned by ingestClaimedInputs,
  // plus its durable prefix. No public RPC accepts claims, events or source rows.
  applyClaimedCorrections({ sessionId, claims, events }) {
    this.session(sessionId);
    if (this.store.get('host_bindings', sessionId)?.role !== 'main')
      fail('understanding_session_denied', '应用纠正需要实际主交流的执行关联。');
    if (!Array.isArray(claims) || !Array.isArray(events)) fail('invalid_correction_claims', '纠正需要真实持久收件箱原件。');
    const claimed = claims.map(claim => {
      const source = this.store.get('events', claim.sourceId), ref = claim.inboxRef;
      const inbox = events.filter(event => event.type === 'agent/inbox/spliced' && event.seq === ref?.seq);
      const saved = ref && this.store.get('dsh_events', eventId(sessionId, ref.seq));
      if (!source || source.sessionId !== sessionId || source.role !== 'user' || source.message?.role !== 'user' ||
          source.message.id !== claim.messageId || source.message.source?.kind !== 'user' ||
          source.message.source.principal !== undefined || digest(source.message) !== claim.messageHash ||
          ref?.sessionId !== sessionId || ref.type !== 'agent/inbox/spliced' || !Number.isSafeInteger(ref.index) || ref.index < 0 ||
          inbox.length !== 1 || digest(inbox[0]) !== ref.sha256 || saved?.sha256 !== ref.sha256 ||
          canonicalJson(inbox[0].data.inserted?.[ref.index] ?? null) !== canonicalJson(source.message))
        fail('invalid_correction_claims', '纠正不能脱离持久的原生 owner 用户收件箱原件。');
      return { source, claim };
    });
    if (new Set(claimed.map(row => row.source.id)).size !== claimed.length)
      fail('invalid_correction_claims', '本次用户原件身份不能重复。');
    // Current native request identities give direct record keys; ordinary steps
    // do not scan or replay every past correction in this conversation.
    const commands = [...new Set(claimed.map(row => row.source.message.source.rpcId).filter(id => typeof id === 'string'))]
      .map(requestId => this.store.get('understanding_commands', commandId(sessionId, requestId)))
      .filter(command => command?.action === 'correct');
    const results = [];
    for (const command of commands) {
      if (command.result) continue;
      this.assertCommand(command);
      try {
        results.push(this.store.transaction(() => {
          const current = this.store.get('understanding_commands', command.id); this.assertCommand(current);
          if (current.result) return current;
          const originals = this.store.listAll('events', { where: { sessionId } }).filter(source =>
            source.message?.source?.kind === 'user' && source.message.source.principal === undefined &&
            source.message.source.rpcId === current.requestId && source.role === 'user');
          const matches = claimed.filter(row => row.source.message.source.rpcId === current.requestId);
          if (originals.length !== 1 || matches.length !== 1 || originals[0].id !== matches[0].source.id ||
              canonicalJson(matches[0].source.message.content) !== canonicalJson([{ type: 'text', text: current.request.text }]))
            fail('correction_source_mismatch', '原生原话的编号或全文不再唯一匹配所确认的纠正。');
          const { source, claim } = matches[0];
          if (!sourceAvailable(this.store, source)) fail('source_unavailable', '纠正原件已经停止作为依据。');
          const before = this.target(current.request); this.assertCorrectable(before);
          const goalsBefore = this.goalViews();
          const retired = this.store.save('understandings', { ...before, status: 'superseded',
            changedByCommandId: current.id, changeSourceIds: [source.id] }, { expectedRevision: before.revision });
          const changes = invalidateDependents(this.store, { ids: [before.id], pendingId: current.id,
            reason: 'understanding_corrected_by_user' });
          const after = this.store.save('understandings', projectUnderstanding({
            id: 'understanding-' + digest(current.id).slice(0, 32), content: current.request.text,
            claimType: 'user_statement', scope: copy(before.scope ?? {}), status: 'active',
            sourceIds: [source.id], dependencies: [{ kind: 'events', id: source.id, revision: source.revision }],
            version: before.version + 1, previousId: before.id, createdByCommandId: current.id,
            authority: 'literal-user-statement; revisable; not truth or action permission' },
          [{ ...source, content: sourceText(source) }]));
          return this.store.save('understanding_commands', { ...current, result: { state: 'applied',
            before, retired, after, sourceId: source.id, sourceRevision: source.revision, claim: copy(claim),
            changes, goalImpacts: this.impacts(goalsBefore),
            evidence: 'durable-native-owner-inbox; final request guard still requires actual native user/message' } },
          { expectedRevision: current.revision });
        }));
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        // Ingestion is already committed. Keep the real original even when the
        // old knowledge version or confirmed text cannot be safely replaced.
        results.push(this.store.transaction(() => {
          const current = this.store.get('understanding_commands', command.id); this.assertCommand(current);
          if (current.result) return current;
          return this.store.save('understanding_commands', { ...current, result: { state: 'failed',
            error: { code: error.code, message: error.message },
            claimedSourceIds: claimed.filter(row => row.source.message.source.rpcId === current.requestId).map(row => row.source.id),
            meaning: 'native input preserved; no replacement or automatic resend' } }, { expectedRevision: current.revision });
        }));
      }
    }
    return results;
  }
}
