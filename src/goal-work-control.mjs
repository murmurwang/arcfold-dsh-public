import { canonicalJson } from './store.mjs';
import { sourceAvailable } from './evidence.mjs';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { resolveNativeContextCall, belongsToSelectionBatch } from './native-context-call.mjs';
const reject = message => { throw new HarnessError(message, 'ARCFOLD_WORK_RESUME_DENIED'); };
export const name = 'arcfold-work-control';
export const inject = ['tools', 'agents', 'goals', 'arcfoldBridge', 'arcfoldGoals', 'arcfoldWork', 'systemPrompt'];
export function assertResumeInput({ events, startSeq, callSeq, goal }) {
  const pause = events.findLast(e => e.type === 'goal/change' && e.data.goal?.id === goal.id && ['pause', 'block'].includes(e.data.operation));
  const inputs = events.filter(e => e.seq > startSeq && e.seq < callSeq && e.type === 'user/message' &&
    e.data.role === 'user' && e.data.source?.kind === 'user' && e.data.source.principal === undefined);
  let selected;
  const valid = inputs.some(input => {
    const received = events.flatMap(e => e.type === 'agent/inbox/spliced'
      ? (e.data.inserted || []).filter(message => message.id === input.data.id).map(message => ({ event: e, message })) : []).at(-1);
    const valid = received && received.event.seq < input.seq && received.event.seq > (pause?.seq ?? -1) &&
      canonicalJson(received.message) === canonicalJson(input.data);
    if (valid) selected = { input, received };
    return valid;
  });
  if (!valid) reject('Resuming requires a new owner message received after the last pause or block, in this current turn.');
  return selected;
}
export function apply(ctx) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!belongsToSelectionBatch(exec, 'arcfold_resume_work')) return next();
    try {
      const call = await resolveNativeContextCall(ctx, exec, reject);
      if (call.batch.length !== 1 || call.batch[0].name !== 'arcfold_resume_work')
        return { kind: 'deny', reason: 'Resume the work alone; no other tool in this batch is admitted.' };
    } catch (error) { return { kind: 'deny', reason: error.message }; }
    return next();
  });
  ctx.systemPrompt.section({ name: 'arcfold:work-resume', order: 51, interpolate: false,
    text: '用户在本轮新原话中要求继续当前已暂停或冷恢复的工作时，先get_goal核当前编号、版本和Arcfold阶段，再单独调用arcfold_resume_work。它只恢复已有具体阶段；依据用户原话判断，程序续轮和背景学习不构成用户要求。要改方向先用arcfold_revise_work明确新阶段，再按用户要求恢复；本轮结束仍须提交阶段推进决定。' });
  ctx.tools.register(defineTool({
    name: 'arcfold_resume_work',
    description: 'Resume the current delegated native work when the new owner message asks to continue it. Call alone, with get_goal current id/revision. Does not create, edit or broaden work; automatic rounds cannot invoke it.',
    parameters: { goal_id: { type: 'string', required: true }, revision: { type: 'integer', required: true } },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const call = await resolveNativeContextCall(ctx, exec, reject);
      if (call.batch.length !== 1 || call.batch[0].name !== 'arcfold_resume_work') reject('Resume this work alone.');
      const goal = ctx.goals.get(call.agent);
      if (!goal || goal.id !== args.goal_id || goal.revision !== args.revision ||
          !(['paused', 'blocked'].includes(goal.phase) || goal.phase === 'active' && goal.activation === 'disarmed'))
        reject('The current native work no longer matches the requested stopped revision.');
      const { input } = assertResumeInput({ events: call.events, startSeq: call.startSeq, callSeq: call.call.seq, goal });
      const originals = ctx.arcfoldBridge.storage.listAll('events', { where: { sessionId: call.sessionId } })
        .filter(row => row.message?.id === input.data.id && canonicalJson(row.message) === canonicalJson(input.data));
      if (originals.length !== 1 || !sourceAvailable(ctx.arcfoldBridge.storage, originals[0]))
        reject('The new owner resume message was withdrawn or no longer has its exact business original.');
      exec.signal.throwIfAborted();
      const stage = ctx.arcfoldWork.current(call.agent);
      const revisedHere = stage?.origin.operation === 'revise' && stage.origin.turn === call.turn;
      return { ...ctx.arcfoldWork.resume(call.agent, { goalId: goal.id, revision: goal.revision,
        sourceRefs: ctx.arcfoldWork.sources(call), currentTurn: call.turn, callId: call.callId, callSeq: call.call.seq, allowRevisedTurn: revisedHere }),
        attribution: 'model-interpreted-current-owner-request; no-new-delegation' };
    },
    presentCall: () => ({ card: 'generic', title: 'Continue this work', kind: 'other' }),
  }));
}
