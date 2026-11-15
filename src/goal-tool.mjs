import { defineTool } from '@deepseek-ai/dsh-tools';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { resolveNativeContextCall, belongsToSelectionBatch } from './native-context-call.mjs';
import { GOAL_TOOL, goalContextMessage } from './goal-context.mjs';

export const name = 'arcfold-goal-tool';
export const inject = ['tools', 'agents', 'arcfoldBridge', 'arcfoldGoals'];
const reject = message => { throw new HarnessError(message, 'ARCFOLD_GOAL_CALL_INVALID'); };
export const resolveNativeGoalCall = (ctx, exec) => resolveNativeContextCall(ctx, exec, reject);

function assertSelection(args) {
  const fields = ['id', 'revision', 'definitionVersion', 'contentHash', 'reason', 'sourceIds'];
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 1 ||
      !Object.hasOwn(args, 'selection')) reject('Provide exactly one goal selection.');
  const item = args.selection;
  if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== fields.length ||
      fields.some(field => !Object.hasOwn(item, field)))
    reject('A goal selection requires exactly id, revision, definitionVersion, contentHash, reason and sourceIds.');
}

export function apply(ctx) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!belongsToSelectionBatch(exec, GOAL_TOOL)) return next();
    try {
      const current = await resolveNativeGoalCall(ctx, exec);
      if (current.batch.length !== 1 || current.batch[0].name !== GOAL_TOOL)
        return { kind: 'deny', reason: 'Request arcfold_link_goal alone. Read the returned goal context in the next model step before requesting any action.' };
    } catch (error) { return { kind: 'deny', reason: error.message }; }
    return next();
  });
  ctx.tools.register(defineTool({
    name: GOAL_TOOL,
    description: 'Relate this turn to one goal shown in the current Arcfold catalog, with your reason and its displayed sources. Call alone in the assistant tool batch. The receipt is followed by program goal context in the next step. A link is your interpretation, not user confirmation, new work authority, resumed tracking or proof that the long-term goal is complete.',
    parameters: { selection: { type: 'object', required: true, additionalProperties: false, properties: {
      id: { type: 'string', required: true }, revision: { type: 'integer', required: true },
      definitionVersion: { type: 'integer', required: true }, contentHash: { type: 'string', required: true },
      reason: { type: 'string', required: true }, sourceIds: { type: 'array', required: true, items: { type: 'string' } },
    } } },
    output: { schema: { type: 'json' }, render: (_args, receipt) => [{ type: 'text', text: JSON.stringify(receipt) }] },
    async execute(args, exec) {
      assertSelection(args);
      const current = await resolveNativeGoalCall(ctx, exec);
      if (current.batch.length !== 1 || current.batch[0].name !== GOAL_TOOL || typeof exec.deferContext !== 'function')
        reject('The goal selection must be a standalone native tool call.');
      const { receipt, bundle } = ctx.arcfoldGoals.link({ sessionId: current.sessionId, turn: current.turn,
        startSeq: current.startSeq, callId: current.callId, contextSnapshotId: current.contextSnapshotId,
        contextMessageId: current.contextMessageId, selection: args.selection,
        maxCharacters: ctx.arcfoldBridge.maxContextCharacters });
      exec.signal.throwIfAborted();
      exec.deferContext(goalContextMessage(bundle));
      exec.signal.throwIfAborted();
      return receipt;
    },
    presentCall: () => ({ card: 'generic', title: 'Relate this work to a goal', kind: 'read' }),
  }));
}
