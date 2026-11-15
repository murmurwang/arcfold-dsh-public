import { defineTool } from '@deepseek-ai/dsh-tools';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { resolveNativeContextCall, belongsToSelectionBatch } from './native-context-call.mjs';
import { STAGE_TOOLS } from './goal-execution.mjs';

export const name = 'arcfold-goal-execution';
export const inject = ['tools', 'agents', 'goals', 'arcfoldBridge', 'arcfoldWork', 'systemPrompt'];
const reject = message => { throw new HarnessError(message, 'ARCFOLD_STAGE_CONTROL_INVALID'); };
const string = description => ({ type: 'string', required: true, description });
const reference = { goal_id: string('Current native work id returned by get_goal.'), revision: { type: 'integer', required: true } };
const definition = {
  objective: string('The concrete currently delegated stage, bounded by the current user request.'),
  doneWhen: string('Observable results that complete this stage; reaching these ends its automatic execution.'),
  boundaries: string('Scope, exclusions, and decisions that require waiting for the user.'),
  max_goal_rounds: { type: 'integer', description: 'Optional automatic rounds for this stage, default 3, maximum 128.' },
};

export function apply(ctx) {
  const work = ctx.arcfoldWork;
  work.attach(ctx.root);
  ctx.on('goal/changed', ({ agent, change }) => work.observeNative(agent, change));
  ctx.on('agent/inbox/inserted', ({ agent, message }) => work.ownerArrived(agent, message));
  ctx.on('agent/turn-stopping', ({ agent, turn }) => work.stopping(agent, turn));
  ctx.tools.guard(exec => {
    if (['create_goal', 'update_goal'].includes(exec.name)) return 'Use Arcfold stage controls; native goal mutation cannot authorize execution.';
    try {
      if (STAGE_TOOLS.some(name => belongsToSelectionBatch(exec, name))) {
        const events = exec.agent?.session.snapshotEvents() ?? [];
        const call = events.findLast(e => e.type === 'tool/call' && e.data.callId === exec.callId);
        const assistant = call && events.findLast(e => e.seq < call.seq && e.type === 'assistant/message');
        if (assistant?.data.message.content.filter(block => block.type === 'tool-call').length !== 1)
          return 'Call Arcfold work control alone, then read its receipt before any other action.';
      }
      if (exec.agent) work.assertCurrent(exec.agent, { tools: true, name: exec.name });
    } catch (error) { return error.message; }
  });
  ctx.systemPrompt.section({ name: 'arcfold:execution-control', order: 52, interpolate: false,
    text: `Arcfold 统一目标推进，DSH 负责执行当前明确委托的阶段。长期方向、当前阶段和本轮步骤分别维护：已有目标与学习提供背景，todo_write展示本轮操作，阶段工具落实继续或等待。你是作这些判断的同一位主助手。
用户只讨论方向、要求建立长期目标或共同拆解时，先交流并让后台整理长期目标。只有当前原话已委托可独立持续推进的具体工作，才单独调用 arcfold_start_work，写清当前阶段、可检查的完成条件、范围及须等待用户的决定。完成条件面向眼前阶段，避免把整个长期愿景作为当前执行范围。
本轮行动完成后，按实际结果单独调用 arcfold_decide_work。当前阶段的完成条件已满足时用 complete，stageDone=true、needsUserDecision=false；后续阶段即使还需共同讨论，也先结束已经完成的当前阶段并保留长期方向。完成当前阶段仍需用户判断或当前应停下时用 wait；仅当同一阶段还有明确、可独立完成的工作时用 continue，并写清下一步。普通文字提问也要落实为 wait。提交决定后交代本轮结果。没有明确继续决定，程序会等待新输入。
阶段修改依据本轮新用户要求，用 arcfold_revise_work；修改作废旧许可并保持停止，继续时再用 arcfold_resume_work。恢复只针对已有具体阶段。旧版本只有长期执行目标而缺少阶段时，先根据新的用户要求明确阶段。get_goal可查看现有执行和阶段。
每次continue只许可下一轮；结果仍需核实，完成步骤不等于长期目标达成。阶段控制的内容判断由你负责，程序核对原话、来源、版本及许可。后台学习更新理解与进展，不签发执行许可。` });
  const output = { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };
  ctx.tools.register(defineTool({ name: 'get_goal', description: 'Read current delegated execution and its Arcfold stage; this does not start work.',
    parameters: {}, output, execute(_args, exec) {
      if (!exec.agent || ctx.agents.get(exec.agent.id) !== exec.agent) reject('A live main session is required.');
      return work.receipt(exec.agent);
    }, presentCall: () => ({ card: 'generic', title: '查看当前阶段', kind: 'read' }) }));
  for (const [name, revise] of [['arcfold_start_work', false], ['arcfold_revise_work', true]]) {
    ctx.tools.register(defineTool({ name,
      description: revise ? 'Revise the current bounded stage from a new direct user request. Invalidates continuation and keeps execution stopped until explicitly resumed. Call alone.'
        : 'Start one concrete stage explicitly delegated by the current user. A long-term goal or discussion alone is not a running stage. Define completion and user-decision boundaries. Call alone; no automatic next round without arcfold_decide_work.',
      parameters: { ...(revise ? reference : {}), ...definition }, output,
      async execute(args, exec) {
        const call = await resolveNativeContextCall(ctx, exec, reject);
        if (call.batch.length !== 1) reject('Stage control must be a standalone tool call.');
        exec.signal.throwIfAborted();
        return work.start(call, args, revise);
      }, presentCall: () => ({ card: 'generic', title: revise ? '调整当前阶段' : '明确当前阶段', kind: 'other' }) }));
  }
  ctx.tools.register(defineTool({ name: 'arcfold_decide_work',
    description: 'After this turn\'s work, decide whether the current stage is complete, needs the user, or has a concrete independent next step. continue grants only the next round of the same stage. Call alone as your last action, then explain results.',
    parameters: { ...reference, action: { type: 'string', required: true, enum: ['continue', 'wait', 'complete'] },
      reason: string('Evidence and reasoning from this turn for the decision.'),
      stageDone: { type: 'boolean', required: true, description: 'Whether this stage\'s completion conditions are met.' },
      needsUserDecision: { type: 'boolean', required: true, description: 'Whether a user choice or information is still required to complete this CURRENT stage. Set false once this stage is complete, even when future stages await discussion.' },
      nextStep: string('Concrete independent next step within this same stage for continue; empty for wait/complete.') }, output,
    async execute(args, exec) {
      const call = await resolveNativeContextCall(ctx, exec, reject);
      if (call.batch.length !== 1) reject('Stage control must be a standalone tool call.');
      exec.signal.throwIfAborted();
      return work.decision(call, args);
    }, presentCall: () => ({ card: 'generic', title: '确定下一步', kind: 'other' }) }));
}
