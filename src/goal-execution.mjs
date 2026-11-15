import { canonicalJson, DomainError } from './store.mjs';
import { hash, sourceAvailable, sourceText, dependenciesCurrent } from './evidence.mjs';
import { nativeDefinitionHash, workId, workRelation } from './goal-work.mjs';

const fail = message => { throw new DomainError('stage_control_required', message); };
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const owner = message => message?.role === 'user' && message.source?.kind === 'user' && message.source.principal === undefined;
const stageId = (sessionId, goalId) => 'execution-stage-' + hash([sessionId, goalId]);
const ref = goal => ({ id: goal.id, revision: goal.revision });
const currentTurn = events => events.findLast(event => event.type === 'turn/start');
const goalInput = (events, start) => events.find(event => event.seq > start.seq && event.type === 'user/message' && event.data.source?.kind === 'goal');
export const STAGE_TOOLS = ['arcfold_start_work', 'arcfold_revise_work', 'arcfold_decide_work', 'arcfold_resume_work'];

/** Arcfold owns a bounded stage and one-round permission; DSH remains the only scheduler. */
export class GoalExecution {
  constructor({ business }) { this.store = business.storage; this.mutations = new WeakMap(); this.controls = new WeakMap(); }
  attach(root) { this.root = root; }
  native(agent) { return this.root?.get('goals')?.get(agent) ?? null; }
  current(agent) {
    const goal = this.native(agent);
    return goal ? this.store.get('execution_stages', stageId(agent.session.id, goal.id)) : null;
  }
  view(stage) {
    if (!stage) return null;
    try { this.assertSources(stage); } catch {
      return { id: stage.id, status: 'needs_review', nativeGoalId: stage.nativeGoalId, nativeRevision: stage.nativeRevision,
        reason: '阶段依据已经变化，等待重新明确当前工作。', available: false };
    }
    return { id: stage.id, definitionVersion: stage.definitionVersion, epoch: stage.epoch,
      objective: stage.objective, doneWhen: stage.doneWhen, boundaries: stage.boundaries,
      status: stage.status, reason: stage.reason, nextStep: stage.permit?.nextStep ?? '',
      nativeGoalId: stage.nativeGoalId, nativeRevision: stage.nativeRevision, goalRef: stage.goalRef,
      sources: stage.sourceRefs.map(reference => {
        const original = this.store.get('events', reference.id);
        return { id: original.id, role: original.role, content: sourceText(original), receivedSeq: reference.receivedSeq };
      }), available: true,
      authority: 'arcfold-current-stage; native-execution-within-this-boundary' };
  }
  receipt(agent, extra = {}) { return { goal: this.native(agent), stage: this.view(this.current(agent)), ...extra }; }
  save(stage, changes) { return this.store.save('execution_stages', { ...stage, ...changes }, { expectedRevision: stage.revision }); }
  mutate(agent, operation, fn) {
    if (this.mutations.has(agent)) fail('已有阶段控制正在处理。');
    this.mutations.set(agent, operation);
    try { return fn(); } finally { this.mutations.delete(agent); }
  }
  disarm(agent) { this.root.get('goals').disarm(agent); }
  stoppedAfter(agent) {
    const stop = agent.session.snapshotEvents().findLast(event => event.type === 'goal/change' &&
      ['pause', 'block', 'clear'].includes(event.data.operation));
    return Math.max(stop?.seq ?? -1, this.current(agent)?.stopBoundary ?? -1);
  }
  beginControl(agent) {
    if (this.controls.has(agent)) fail('当前工作控制正在确认，请等待原请求的结果。');
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    this.controls.set(agent, promise);
    return () => { this.controls.delete(agent); resolve(); };
  }
  async awaitControl(agent) { await this.controls.get(agent); }
  abortControl(agent, decisionId) {
    this.disarm(agent);
    const stage = this.current(agent);
    if (stage?.permit?.userDecision === decisionId) this.save(stage, { status: 'waiting', permit: null, admission: null,
      reason: '恢复结果尚待确认，执行保持停止。', stopBoundary: agent.session.seq - 1 });
  }
  sources(call, after = -1) {
    const refs = [];
    for (const event of call.events.filter(e => e.seq > call.startSeq && e.seq < call.call.seq && e.type === 'user/message' && owner(e.data))) {
      const received = call.events.findLast(e => e.type === 'agent/inbox/spliced' && e.seq < event.seq &&
        e.data.inserted?.some(message => same(message, event.data)));
      if (!received || received.seq <= after) continue;
      const originals = this.store.listAll('events', { where: { sessionId: call.sessionId } }).filter(row =>
        row.message?.id === event.data.id && same(row.message, event.data));
      if (originals.length !== 1 || !sourceAvailable(this.store, originals[0])) continue;
      refs.push({ id: originals[0].id, revision: originals[0].revision, messageHash: hash(event.data), receivedSeq: received.seq });
    }
    if (!refs.length) fail('明确或恢复当前阶段需要本轮新收到的用户原话。');
    return refs;
  }
  assertSources(stage) {
    if (!stage?.sourceRefs?.length) fail('这项旧工作还需要明确当前阶段，请根据用户本次要求重新整理。');
    for (const source of stage.sourceRefs) {
      const row = this.store.get('events', source.id);
      if (!sourceAvailable(this.store, row) || row.revision !== source.revision || hash(row.message) !== source.messageHash)
        fail('当前阶段的委托原话已经撤回或改变。');
    }
    if (stage.goalRef) {
      const goal = this.store.get('goals', stage.goalRef.id);
      if (!goal || goal.status !== 'tracking' || goal.definitionVersion !== stage.goalRef.definitionVersion ||
          !dependenciesCurrent(this.store, { ...goal, status: 'active' }, this.store.currentSequence()))
        fail('关联的长期目标已经变化，需根据当前要求重新明确阶段。');
    }
  }
  assertNative(stage, goal) {
    this.assertSources(stage);
    if (!goal || goal.id !== stage.nativeGoalId || goal.revision !== stage.nativeRevision || nativeDefinitionHash(goal) !== stage.nativeDefinitionHash)
      fail('执行版本已经变化，需要通过 Arcfold 重新明确当前阶段。');
  }
  definition(args) {
    for (const key of ['objective', 'doneWhen', 'boundaries'])
      if (typeof args[key] !== 'string' || !args[key].trim() || args[key].length > 3000) fail('当前阶段需要具体任务、完成条件和推进边界。');
    const max = args.max_goal_rounds ?? 3;
    if (!Number.isSafeInteger(max) || max < 1 || max > 128) fail('阶段续跑轮数应为1到128的整数。');
    return { objective: args.objective.trim(), doneWhen: args.doneWhen.trim(), boundaries: args.boundaries.trim(), maxGoalRounds: max };
  }
  start(call, args, revise = false) {
    const spec = this.definition(args), sourceRefs = this.sources(call, this.stoppedAfter(call.agent));
    const before = this.native(call.agent), previous = this.current(call.agent);
    if (revise && before?.phase === 'complete') fail('上一阶段已经完成，请用 arcfold_start_work 开始用户新委托的阶段。');
    const roundsAtStart = revise ? before?.roundsStarted ?? 0 : 0;
    const nativeRoundLimit = roundsAtStart + spec.maxGoalRounds;
    if (nativeRoundLimit > 128) fail('本次阶段轮数超出宿主剩余轮数，请缩小当前阶段。');
    if (revise && (!before || before.id !== args.goal_id || before.revision !== args.revision)) fail('修改须对应当前执行的编号和版本。');
    if (!revise && before && before.phase !== 'complete') fail('已有工作需要通过 arcfold_revise_work 明确新阶段。');
    if (previous && ['waiting', 'paused', 'needs_review', 'completed'].includes(previous.status)) this.sources(call, previous.stopBoundary ?? -1);
    const link = this.store.listAll('goal_links', { where: { sessionId: call.sessionId, startSeq: call.startSeq } })[0];
    const parent = link && this.store.get('goals', link.goalId);
    const goalRef = parent?.status === 'tracking' ? { id: parent.id, definitionVersion: link.definitionVersion } : null;
    this.assertSources({ sourceRefs, goalRef });
    const goal = this.mutate(call.agent, revise ? 'edit' : 'create', () => revise
      ? this.root.get('goals').edit(call.agent, ref(before), { objective: spec.objective, maxGoalRounds: nativeRoundLimit })
      : this.root.get('goals').create(call.agent, { objective: spec.objective, maxGoalRounds: nativeRoundLimit }));
    try {
      const id = stageId(call.sessionId, goal.id), old = this.store.get('execution_stages', id);
      this.store.save('execution_stages', { id, sessionId: call.sessionId, nativeGoalId: goal.id,
        nativeRevision: goal.revision, nativeDefinitionHash: nativeDefinitionHash(goal), ...spec, roundsAtStart,
        definitionVersion: (old?.definitionVersion ?? 0) + 1, epoch: (old?.epoch ?? 0) + 1,
        sourceRefs, goalRef, status: revise ? 'waiting' : 'running',
        reason: revise ? '当前阶段已修改，等待明确继续。' : '执行当前明确委托的阶段。',
        stopBoundary: revise ? call.call.seq : null, decisionId: null, permit: null, admission: null,
        origin: { callId: call.callId, turn: call.turn, callSeq: call.call.seq, operation: revise ? 'revise' : 'start' } },
      { expectedRevision: old?.revision ?? null });
      if (revise) this.disarm(call.agent);
    } catch (error) { this.disarm(call.agent); throw error; }
    return this.receipt(call.agent);
  }
  decision(call, args) {
    let stage = this.current(call.agent); const goal = this.native(call.agent);
    this.assertNative(stage, goal);
    if (goal.id !== args.goal_id || goal.revision !== args.revision || stage.status !== 'running' || goal.activation !== 'armed')
      fail('决定须对应正在执行的当前阶段与版本。');
    if (this.decisionFor(stage, call.turn)) fail('本轮已经作出推进决定，请交代结果。');
    if (args.action === 'continue' && [...call.agent.inbox.nextStep, ...call.agent.inbox.nextTurn].some(owner))
      fail('先处理新收到的用户表达，再决定下一轮。');
    if (!['continue', 'wait', 'complete'].includes(args.action) || typeof args.reason !== 'string' || !args.reason.trim() ||
        args.reason.length > 2000 || typeof args.stageDone !== 'boolean' || typeof args.needsUserDecision !== 'boolean' ||
        typeof args.nextStep !== 'string' || args.nextStep.length > 2000) fail('阶段决定需要结果依据、完成判断及是否需用户决定。');
    if (args.action === 'continue' && (args.stageDone || args.needsUserDecision || !args.nextStep.trim() || goal.roundsStarted >= goal.maxGoalRounds))
      fail('只有当前阶段尚未完成、无需用户决定且下一步明确时，才可许可下一轮。');
    if (args.action === 'complete' && (!args.stageDone || args.needsUserDecision)) fail('请核对当前阶段的完成条件：满足时 complete 要求 stageDone=true 且 needsUserDecision=false；完成本阶段仍需信息或选择时用 wait。后续阶段的讨论另行保留。');
    if (args.action !== 'continue' && args.nextStep !== '') fail('等待或完成不携带下一轮执行步骤。');
    const id = 'stage-decision-' + hash([call.sessionId, call.callId]);
    if (this.store.get('stage_decisions', id)) fail('此阶段决定已经记录，不能重复执行。');
    const decision = { id, stageId: stage.id, sessionId: call.sessionId, definitionVersion: stage.definitionVersion,
      epoch: stage.epoch, nativeGoalId: goal.id, nativeRevision: goal.revision, turn: call.turn, callId: call.callId,
      callSeq: call.call.seq, action: args.action, reason: args.reason, stageDone: args.stageDone,
      needsUserDecision: args.needsUserDecision, nextStep: args.nextStep, evidence: 'current-main-model-decision; semantic-judgment-not-proven-by-schema' };
    this.store.save('stage_decisions', decision, { expectedRevision: null });
    if (args.action === 'continue') {
      this.save(stage, { decisionId: id, reason: args.reason, permit: { decisionId: id, nativeRevision: goal.revision,
        round: goal.roundsStarted + 1, fromTurn: call.turn, nextStep: args.nextStep, issuedSeq: call.call.seq } });
    } else {
      const operation = args.action === 'wait' ? 'pause' : 'complete';
      const after = this.mutate(call.agent, operation, () => this.root.get('goals')[operation](call.agent, ref(goal)));
      try {
        stage = this.current(call.agent);
        this.save(stage, { nativeRevision: after.revision, status: args.action === 'wait' ? 'waiting' : 'completed',
          reason: args.reason, decisionId: id, permit: null, stopBoundary: call.call.seq });
      } catch (error) { this.disarm(call.agent); throw error; }
    }
    return this.receipt(call.agent, { decisionId: id });
  }
  decisionFor(stage, turn) {
    const decision = stage?.decisionId && this.store.get('stage_decisions', stage.decisionId);
    return decision?.turn === turn && decision.definitionVersion === stage.definitionVersion && decision.epoch === stage.epoch ? decision : null;
  }
  success(events, decision) {
    return Boolean(decision && events.some(event => event.type === 'tool/result' && event.data.message?.toolCallId === decision.callId &&
      event.data.message.isError === false && event.data.message.content?.some(block => {
        if (block.type !== 'text') return false;
        try { const value = JSON.parse(block.text); return value.decisionId === decision.id && value.stage?.id === decision.stageId; } catch { return false; }
      })));
  }
  /** A browser or a new owner turn may resume the same stage, never revive an old ticket. */
  resume(agent, { goalId, revision, sourceRefs = null, userDecision = null, currentTurn: turn = null, callId = null, callSeq = null, allowRevisedTurn = false }) {
    let stage = this.current(agent); const goal = this.native(agent);
    this.assertNative(stage, goal);
    if (goal.id !== goalId || goal.revision !== revision || stage.status === 'completed' ||
        goal.roundsStarted >= goal.maxGoalRounds || goal.phase === 'complete') fail('该阶段不能直接恢复，请重新明确当前工作。');
    if (!sourceRefs?.length && !userDecision) fail('恢复需要新的用户决定。');
    if (sourceRefs && !sourceRefs.some(source => source.receivedSeq > (stage.stopBoundary ?? -1)) && !allowRevisedTurn)
      fail('恢复依据必须在停下之后新收到。');
    const after = this.mutate(agent, 'resume', () => this.root.get('goals').resume(agent, ref(goal)));
    try {
      stage = this.current(agent);
      const epoch = stage.epoch + 1;
      this.save(stage, { nativeRevision: after.revision, epoch, status: 'running', reason: '按用户的新决定继续当前阶段。',
        sourceRefs: sourceRefs ? [...stage.sourceRefs, ...sourceRefs.filter(source => !stage.sourceRefs.some(old => old.id === source.id))] : stage.sourceRefs,
        decisionId: null, admission: null, permit: userDecision ? { nativeRevision: after.revision, round: after.roundsStarted + 1,
          fromTurn: null, nextStep: stage.objective, issuedSeq: agent.session.seq - 1, userDecision } : null,
        resumedBy: sourceRefs ? { kind: 'owner-input', sourceIds: sourceRefs.map(source => source.id), turn, callId, callSeq } : { kind: 'browser', userDecision } });
    } catch (error) { this.disarm(agent); throw error; }
    return this.receipt(agent);
  }
  observeNative(agent, change) {
    if (this.mutations.get(agent) === change.operation) return;
    const stage = this.current(agent) ?? (change.cleared?.id && this.store.get('execution_stages', stageId(agent.session.id, change.cleared.id)));
    // Native controls may always stop execution. They cannot grant Arcfold stage authority.
    this.disarm(agent);
    if (stage) this.save(stage, { status: ['pause', 'block', 'clear'].includes(change.operation) ? 'paused' : 'needs_review',
      reason: ['pause', 'block'].includes(change.operation) ? '当前执行已停下。' : '执行定义或控制已变化，需重新明确当前阶段。',
      nativeRevision: change.goal?.revision ?? change.cleared?.revision ?? stage.nativeRevision, epoch: stage.epoch + 1,
      permit: null, admission: null, decisionId: null, stopBoundary: agent.session.seq - 1 });
  }
  ownerArrived(agent, message) {
    if (!owner(message)) return;
    const stage = this.current(agent);
    if (stage && (stage.permit || stage.decisionId)) this.save(stage, { permit: null, decisionId: null,
      reason: '先处理用户的新表达，再决定是否继续。' });
  }
  ownerEntered(agent, messages) {
    if (messages.some(owner)) this.ownerArrived(agent, messages.find(owner));
  }
  async stopping(agent, turn) {
    const goal = this.native(agent), stage = this.current(agent);
    if (!goal || goal.phase !== 'active') return;
    const events = agent.session.snapshotEvents(), decision = this.decisionFor(stage, turn);
    try {
      this.assertNative(stage, goal);
      if (stage.status === 'running' && stage.permit?.fromTurn === turn && stage.permit.nativeRevision === goal.revision &&
          stage.permit.round === goal.roundsStarted + 1 && decision?.action === 'continue' && this.success(events, decision)) return;
    } catch { /* The existing result remains delivered; invalid continuation stops. */ }
    this.disarm(agent);
    if (stage && stage.status === 'running') this.save(stage, { status: 'waiting', permit: null, admission: null,
      reason: '本轮已结束，等待明确下一步。', stopBoundary: agent.session.seq - 1 });
  }
  admit(agent, messages, turn) {
    const automatic = messages.find(message => message.source?.kind === 'goal');
    if (!automatic) return;
    const goal = this.native(agent), stage = this.current(agent), source = automatic.source;
    try {
      this.assertNative(stage, goal);
      if (stage.admission?.turn === turn && stage.admission.messageId === automatic.id) return;
      const permit = stage.permit;
      if (source.round <= 0 || stage.status !== 'running' || goal.phase !== 'active' || goal.activation !== 'armed' ||
          !permit || source.goalId !== goal.id || source.revision !== goal.revision || permit.nativeRevision !== goal.revision ||
          permit.round !== source.round || source.round !== goal.roundsStarted + 1) fail('下一轮缺少当前阶段的单次继续许可。');
      if (permit.decisionId && !this.success(agent.session.snapshotEvents(), this.store.get('stage_decisions', permit.decisionId)))
        fail('继续决定缺少真实成功回执。');
      if (permit.userDecision) {
        const control = this.store.get('goal_work_controls', permit.userDecision);
        if (control?.state !== 'applied' || control.request.action !== 'resume' ||
            control.request.sessionId !== stage.sessionId || control.request.nativeGoalId !== goal.id ||
            control.request.nativeRevision + 1 !== goal.revision) fail('网页恢复决定尚未确认生效。');
      }
      this.save(stage, { permit: null, decisionId: null, admission: { turn, messageId: automatic.id, round: source.round,
        nativeRevision: source.revision, definitionVersion: stage.definitionVersion, epoch: stage.epoch,
        decisionId: permit.decisionId ?? null, userDecision: permit.userDecision ?? null } });
    } catch (error) { this.disarm(agent); throw error; }
  }
  controlSucceeded(events, control, stage) {
    return Boolean(control?.callId && events.some(event => event.type === 'tool/result' &&
      event.data.message?.toolCallId === control.callId && event.data.message.isError === false &&
      event.data.message.content?.some(block => {
        try { const result = JSON.parse(block.text); return result.stage?.id === stage.id &&
          result.stage.definitionVersion === stage.definitionVersion; } catch { return false; }
      })));
  }
  ownerTransition(agent) {
    const events = agent.session.snapshotEvents(), start = currentTurn(events), stage = this.current(agent);
    if (!start || !stage) return false;
    const control = stage.resumedBy?.kind === 'owner-input' && stage.resumedBy.turn === start.data.turn
      ? stage.resumedBy : stage.origin?.turn === start.data.turn ? stage.origin : null;
    return this.controlSucceeded(events, control, stage);
  }
  freshOwner(agent) {
    const events = agent.session.snapshotEvents(), start = currentTurn(events), stage = this.current(agent);
    if (!start) return false;
    const boundary = Math.max(stage?.origin?.callSeq ?? -1, stage?.resumedBy?.callSeq ?? -1, this.stoppedAfter(agent));
    return events.some(event => event.seq > start.seq && event.type === 'user/message' && owner(event.data) &&
      events.some(received => received.type === 'agent/inbox/spliced' && received.seq > boundary && received.seq < event.seq &&
        received.data.inserted?.some(message => same(message, event.data))) &&
      this.store.listAll('events', { where: { sessionId: agent.session.id } }).some(row =>
        same(row.message, event.data) && sourceAvailable(this.store, row)));
  }
  historicalContinuation(agent) { return this.ownerTransition(agent) || this.freshOwner(agent); }
  browserControlSaved(agent, id, request) {
    const stage = this.store.get('execution_stages', stageId(agent.session.id, request.nativeGoalId));
    return Boolean(stage?.resumedBy?.kind === 'browser' && stage.resumedBy.userDecision === id &&
      stage.nativeRevision >= request.nativeRevision + 1);
  }
  boundToTurn(stage, turn) {
    return Boolean(stage && (stage.origin?.turn === turn || stage.admission?.turn === turn ||
      stage.resumedBy?.kind === 'owner-input' && stage.resumedBy.turn === turn));
  }
  assertCurrent(agent, { tools = false, name = null } = {}) {
    const events = agent.session.snapshotEvents(), start = currentTurn(events);
    if (!start) return;
    const input = goalInput(events, start), stage = this.current(agent), decision = this.decisionFor(stage, start.data.turn);
    const repair = ['get_goal', 'arcfold_start_work', 'arcfold_revise_work', 'arcfold_resume_work'].includes(name);
    // A newly entered owner correction may inspect/redefine the stage. It does
    // not authorize ordinary actions under an obsolete automatic admission.
    if (this.freshOwner(agent) && (!tools || repair)) return;
    if (tools && decision) fail('本轮已作出阶段决定，请交代结果，后续行动交由下一轮执行。');
    const expected = this.store.listAll('context_snapshots', { where: { sessionId: agent.session.id, turn: start.data.turn } })[0]?.material.executionStage;
    const boundOwner = this.boundToTurn(stage, start.data.turn);
    if (!input && !boundOwner && !expected?.boundToTurn) return;
    if (expected?.boundToTurn && expected.id !== stage?.id) fail('发起本次模型请求的阶段已被替换，旧动作不能继续执行。');
    const goal = this.native(agent), admission = stage?.admission;
    this.assertNative(stage, goal);
    if (!tools && decision && ['wait', 'complete'].includes(decision.action) && this.success(events, decision)) return;
    if (this.ownerTransition(agent)) {
      if (!tools || repair || stage.status === 'running' && goal.phase === 'active' && goal.activation === 'armed') return;
      fail('当前阶段已停下，先按用户要求恢复再执行。');
    }
    if (!input) fail('当前阶段控制缺少成功回执。');
    if (!admission || admission.turn !== start.data.turn || admission.messageId !== input.data.id ||
        admission.epoch !== stage.epoch || admission.definitionVersion !== stage.definitionVersion)
      fail('此自动轮不再持有当前阶段的执行许可。');
    if (stage.status !== 'running' || goal.phase !== 'active' || goal.activation !== 'armed' ||
        admission.nativeRevision !== goal.revision || admission.round !== goal.roundsStarted)
      fail('当前阶段已停下或改变，旧自动轮不能继续执行。');
  }
  stopForGoal(goalId) {
    for (const stage of this.store.listAll('execution_stages').filter(row => row.status === 'running' &&
      (row.goalRef?.id === goalId || workRelation(this.store, workId(row.sessionId, row.nativeGoalId))?.goalId === goalId))) {
      const agent = this.root?.get('agents')?.get(stage.sessionId);
      if (!agent || this.native(agent)?.id !== stage.nativeGoalId) continue;
      const goal = this.native(agent);
      if (goal.phase === 'active') this.root.get('goals').pause(agent, ref(goal));
    }
  }
}
