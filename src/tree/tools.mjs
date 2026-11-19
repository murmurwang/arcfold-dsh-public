import { canonicalJson, digest, fail, shape, text, integer, array, oneOf } from './contracts.mjs';
import { TreeService } from './tree.mjs';
import { ExperienceService } from './experience.mjs';
import { bindTurnSnapshot } from './ui.mjs';
import { HarnessError } from '@deepseek-ai/dsh-llm';

const requiredString = { type: 'string', required: true };
const requiredVersion = { type: 'integer', required: true };
const strings = { type: 'array', required: true, items: { type: 'string' } };
export const TREE_TOOLS = Object.freeze({
  arcfold_mark_complete: { nodeId: requiredString, expectedRevision: requiredVersion, reason: requiredString },
  arcfold_revise_goal: { op: { type: 'string', enum: ['rename', 'add_parent', 'create_child', 'switch'], required: true }, nodeId: requiredString, expectedRevision: requiredVersion, name: { type: 'string' }, reason: requiredString },
  arcfold_read_history: { nodeId: requiredString, kind: { type: 'string', enum: ['summary', 'turns'], required: true }, afterTurnId: { type: 'string' }, limit: { type: 'integer' } },
  arcfold_read_method: { methodId: requiredString, expectedVersion: { type: 'integer' } },
  arcfold_run_method_script: { methodId: requiredString, expectedVersion: requiredVersion, scriptId: requiredString, args: { type: 'object', required: true, additionalProperties: true } },
  arcfold_request_script: { methodId: { type: 'string' }, expectedVersion: { type: 'integer' }, purpose: requiredString, evidenceIds: strings, fileRefs: strings },
});
const descriptions = {
  arcfold_mark_complete: '把本轮目标标为助手判断的完成，保留理由和来源；先检查对应钩子，用户仍可重新打开。',
  arcfold_revise_goal: '目标用来指导此刻的工作。只在本轮对话确实显出此刻在做的事变了时修改，依据须是本轮用户原话或用户认可的内容；拿不准就先问用户，不改。rename：同一件事有了更准确的说法，改写当前目标名字，下一步即生效。create_child：对话进到更具体的一层，在当前目标或它路径上的某一层下新建子目标并把本轮转过去，nodeId填那一层。add_parent：讨论里出现了更上层的目标，在当前目标之上加一层，并把本轮转到新上层。switch：本轮其实在做另一个已有候选目标，nodeId填那个目标。后三种在本轮回答结束时生效。name写此刻要做成什么，以用户为主语。修改后在回复里用一句话告诉用户改成了什么，用户可以当场纠正。',
  arcfold_read_history: '在当前节点的上级链或直接子节点分页读取原始经历或摘要。来源已撤回时不返回原文。',
  arcfold_read_method: '读取当前范围内一个有效方法的完整说明、准确版本和脚本逻辑编号。读取不扩大权限。',
  arcfold_run_method_script: '通过受限执行入口运行当前有效方法脚本。自动检查版本、权限和快照；参数不接受路径、命令或权限覆盖。',
  arcfold_request_script: '根据本轮真实证据排入专用脚本作者。新方法省略methodId/expectedVersion，不要求先有方法。evidenceIds只取本轮授权背景evidence中的id。fileRefs只取背景fileRefs中已登记的逻辑编号，不是文件名或路径；背景fileRefs为空时必须传[]。工作区文件名及读写目标写在purpose中，由作者只读工具核实；无需让用户另外上传工作区文件。purpose只描述业务输入、输出与约束，不另设计命令行开关或要求将作者私有脚本写到工作区。宿主固定以--input临时JSON参数文件调用，试跑加--dry-run；正式执行由arcfold_run_method_script的可信权限控制，不需要额外apply/write开关。返回任务状态，不自动执行；不要无限轮询。',
};

export async function nativeTreeCall(ctx, runtime, exec) {
  const agent = exec.agent; exec.signal?.throwIfAborted();
  if (!exec.signal || !agent || ctx.agents.get(agent.id) !== agent || ctx.agents.currentInitiator() !== agent || agent.status !== 'running' || runtime.mainAgents.get(agent.session.id) !== agent || exec.parent !== undefined || exec.rootCallId !== exec.callId || !exec.callId) fail('MAIN_REQUIRED', 'Only the exact direct native main call may use tree tools');
  const events = await runtime.freezeSession(agent.session); exec.signal.throwIfAborted();
  const start = events.findLast(e => e.type === 'turn/start'), step = events.findLast(e => e.type === 'step/start');
  const call = events.find(e => e.type === 'tool/call' && e.data.callId === exec.callId);
  const message = call && events.findLast(e => e.seq < call.seq && e.type === 'assistant/message');
  const block = message?.data.message?.content?.find(b => b.type === 'tool-call' && b.id === exec.callId);
  if (!start || !step || step.seq < start.seq || !call || call.seq < step.seq || call.data.name !== exec.name || block?.name !== exec.name || block.arguments !== call.data.arguments || message.data.message.source?.kind !== 'model' || canonicalJson(JSON.parse(call.data.arguments)) !== canonicalJson(exec.arguments) || events.some(e => e.seq > step.seq && ['step/end', 'turn/end'].includes(e.type)) || events.some(e => e.seq > call.seq && e.type === 'tool/result' && e.data.message.toolCallId === exec.callId)) fail('NATIVE_CALL_REQUIRED', 'Call must match its complete durable assistant and live step');
  const job = runtime.mainJob(agent.session.id, start.data.turn), scope = runtime.builder.capture(agent.session.id);
  if (!job || job.status !== 'submitted' || job.trigger.turnId !== scope.turnId || job.input.assignmentRevision !== scope.assignmentRevision) fail('MAIN_REQUIRED', 'Main call has no current owned logical turn');
  runtime.jobs.assertCurrent(job);
  const invocation = runtime.repo.list('tree_invocations', i => i.jobId === job.id && i.stepStartSeq === step.seq)[0];
  const exposure = invocation && runtime.repo.list('tree_exposures', e => e.invocationId === invocation.id && !e.revoked)[0];
  if (!exposure) fail('EXPOSURE_REQUIRED', 'The native request must have a recorded current exposure');
  return { agent, job, scope, exposure, events, call, actor: { kind: 'model', role: 'main', id: job.id }, requestId: digest(['tree-tool', agent.session.id, exec.callId]) };
}

export async function executeTreeTool(ctx, runtime, name, args, exec) {
  const current = await nativeTreeCall(ctx, runtime, exec), { agent, job, scope, exposure, requestId, actor } = current;
  const repo = runtime.repo, context = () => ({ actor, nodeIds: scope.nodeIds }), options = { repository: repo, resolveSource: runtime.resolveSource, context };
  if (name === 'arcfold_mark_complete') {
    shape(args, ['nodeId', 'expectedRevision', 'reason']); integer(args.expectedRevision, 'expectedRevision', 1); text(args.reason, 'reason', 2000);
    if (!scope.nodeIds.includes(args.nodeId)) fail('OUT_OF_SCOPE', 'Only a directly assigned node may be marked complete');
    const result = runtime.hooks(agent.session.id).evaluate({ sessionId: agent.session.id, moment: 'node_complete', eventKey: exec.callId, fields: { completedBy: 'model' }, signal: exec.signal });
    if (result.decision !== 'allow') fail('HOOK_DENIED', 'Completion is blocked by a current method check');
    const before = repo.list('tree_nodes'), receipt = new TreeService(options).setStatus({ requestId, expected: { ['tree_nodes:' + args.nodeId]: args.expectedRevision }, input: { nodeId: args.nodeId, status: 'completed', sourceRefs: job.input.sources.map(s => s.ref) } });
    runtime.metrics.observeTree(receipt, before, { logicalTurnId: scope.turnId });
    repo.command('recordCompletionReason', { requestId: digest([requestId, 'reason']), expected: {}, input: { nodeId: args.nodeId, reason: args.reason, callId: exec.callId, receiptId: receipt.id } }, actor, () => ({ receiptId: receipt.id }));
    // Final consolidation is queued after the current turn has settled.
    return { ...receipt.result, revision: repo.get('tree_nodes', args.nodeId).revision, receiptId: receipt.id };
  }
  if (name === 'arcfold_revise_goal') {
    shape(args, ['op', 'nodeId', 'expectedRevision', 'reason'], ['name']); oneOf(args.op, ['rename', 'add_parent', 'create_child', 'switch'], 'op');
    integer(args.expectedRevision, 'expectedRevision', 1); text(args.reason, 'reason', 2000);
    if (args.op === 'switch') {
      if (args.name !== undefined) fail('INVALID_FIELD', 'switch uses an existing goal and takes no name');
      if (scope.nodeIds.includes(args.nodeId)) fail('INVALID_FIELD', 'This goal is already current');
      if (!runtime.attribution.candidateNodes().some(n => n.id === args.nodeId)) fail('OUT_OF_SCOPE', 'Only an existing candidate goal can be switched to');
    } else {
      text(args.name, 'name', 80);
      const onPath = args.op === 'create_child' && scope.ancestorPaths.some(path => path.includes(args.nodeId));
      if (!scope.nodeIds.includes(args.nodeId) && !onPath) fail('OUT_OF_SCOPE', 'Only a current goal of this turn, or for create_child a goal on its path, can be revised');
    }
    const node = repo.get('tree_nodes', args.nodeId);
    if (!node || node.deleted) fail('NODE_NOT_FOUND', 'Goal not found');
    if (node.revision !== args.expectedRevision) fail('REVISION_CONFLICT', 'Goal changed; read it again before revising');
    const tree = new TreeService(options), sourceRefs = job.input.sources.map(s => s.ref), revisionId = digest(['goal-revision', scope.turnId, exec.callId]);
    const record = (state, extra = {}) => {
      const turn = repo.get('tree_turns', scope.turnId);
      return tree.recordGoalRevision({ requestId: digest([requestId, 'record']), expected: { ['tree_turns:' + turn.id]: turn.revision },
        input: { turnId: turn.id, revision: { id: revisionId, op: args.op, nodeId: args.nodeId, reason: args.reason, callId: exec.callId, state, ...(args.name !== undefined ? { name: args.name } : {}), ...extra } } });
    };
    if (args.op === 'rename') {
      const before = repo.list('tree_nodes'), receipt = tree.renameGoal({ requestId, expected: { ['tree_nodes:' + node.id]: node.revision }, input: { nodeId: node.id, name: args.name, sourceRefs } });
      runtime.metrics.observeTree(receipt, before, { logicalTurnId: scope.turnId });
      record('applied', { previousName: node.name });
      return { op: 'rename', nodeId: node.id, name: args.name, previousName: node.name, effective: 'next_step', revision: repo.get('tree_nodes', node.id).revision };
    }
    record('pending');
    return { op: args.op, nodeId: node.id, ...(args.name !== undefined ? { name: args.name } : { name: node.name }), effective: 'turn_end' };
  }
  if (name === 'arcfold_read_history') {
    shape(args, ['nodeId', 'kind'], ['afterTurnId', 'limit']); oneOf(args.kind, ['summary', 'turns'], 'kind');
    const history = new ExperienceService({ ...options, sources: runtime.sources }); history.assertReadScope(args.nodeId);
    if (args.kind === 'turns') return history.history(args.nodeId, { afterTurnId: args.afterTurnId ?? null, limit: args.limit ?? 10 });
    const summary = runtime.builder.summary(repo.get('tree_nodes', args.nodeId)); return { items: summary ? [summary] : [], revokedRefs: [], nextCursor: null };
  }
  if (name === 'arcfold_read_method') {
    shape(args, ['methodId'], ['expectedVersion']);
    const row = runtime.builder.activeItems(scope.ancestorPaths.flat()).find(r => r.item.id === args.methodId && r.method);
    if (!row || args.expectedVersion !== undefined && args.expectedVersion !== row.item.activeVersion) fail('METHOD_STALE', 'Method is unavailable in the current scope/version');
    repo.command('recordFullMethodRead', { requestId, expected: { ['tree_items:' + row.item.id]: row.item.revision }, input: { itemId: row.item.id, version: row.item.activeVersion, exposureId: exposure.id } }, actor, () => {
      const old = repo.get('tree_exposures', exposure.id), values = old.methodReadVersions ?? [], value = { itemId: row.item.id, version: row.item.activeVersion };
      repo.save('tree_exposures', { ...old, methodReadVersions: [...new Map([...values, value].map(v => [digest(v), v])).values()] }, old.revision); return value;
    });
    return { methodId: row.item.id, version: row.item.activeVersion, long: row.method.long, scopeNodeId: row.item.nodeId,
      scripts: row.method.scripts.map(s => { const artifact = repo.list('tree_script_artifacts', a => a.scriptId === s.id && a.version === s.version && a.methodId === row.item.id)[0]; return { scriptId: s.id, usage: artifact?.usage ?? '' }; }) };
  }
  if (name === 'arcfold_request_script') {
    shape(args, ['purpose', 'evidenceIds', 'fileRefs'], ['methodId', 'expectedVersion']); text(args.purpose, 'purpose', 2000); array(args.evidenceIds, 'evidenceIds', 20); array(args.fileRefs, 'fileRefs', 20);
    if (scope.nodeIds.length !== 1 && !args.methodId) fail('SCRIPT_SCOPE_AMBIGUOUS', 'A multi-goal script request must identify its existing method');
    const nodeId = args.methodId ? repo.get('tree_items', args.methodId)?.nodeId : scope.nodeIds[0];
    const result = runtime.writers.request(args, { job, callId: exec.callId, nodeId, exposureId: exposure.id }); runtime.kick(); return result;
  }
  if (name === 'arcfold_run_method_script') {
    shape(args, ['methodId', 'expectedVersion', 'scriptId', 'args']); integer(args.expectedVersion, 'expectedVersion', 1);
    const resources = runtime.resourcesFor(runtime.host.workingDirectory.get(agent.session));
    const broker = resources.brokerFor({ ...current, exec }); const result = await broker.run(args, { signal: exec.signal });
    if (result.snapshotId) bindTurnSnapshot(repo, result.snapshotId, scope.turnId);
    return { runId: result.id, exitCode: result.result?.code ?? null, stdout: result.result?.stdout ?? '', stderr: result.result?.stderr ?? '', truncated: result.result?.truncated ?? false, snapshotId: result.snapshotId ?? null, ...(result.error ? { denial: result.error.code } : {}) };
  }
  fail('TOOL_NOT_FOUND', 'Unknown tree tool');
}

export function mountTreeTools(ctx, runtime) {
  for (const [name, parameters] of Object.entries(TREE_TOOLS)) ctx.tools.register(runtime.defineTool({ name, description: descriptions[name], parameters,
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args, exec) => {
      try { return { ok: true, value: await executeTreeTool(ctx, runtime, name, args, exec) }; }
      catch (error) { if (error instanceof HarnessError) throw error; throw new HarnessError(error.message, error.code ?? 'TREE_TOOL_FAILED', { cause: error }); }
    },
    presentCall: () => ({ card: 'generic', title: descriptions[name], kind: name === 'arcfold_run_method_script' ? 'write' : 'read' }),
  }));
}
