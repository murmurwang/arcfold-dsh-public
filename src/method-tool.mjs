import { defineTool } from '@deepseek-ai/dsh-tools';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { resolveNativeContextCall, belongsToSelectionBatch } from './native-context-call.mjs';
import { METHOD_TOOL, methodContextMessage } from './method-context.mjs';

export const name = 'arcfold-method-tool';
export const inject = ['tools', 'agents', 'arcfoldBridge', 'arcfoldMethods'];
const reject = (message, code = 'ARCFOLD_METHOD_CALL_INVALID') => { throw new HarnessError(message, code); };
// Keep the method-specific error contract while sharing exact native evidence checks.
export const resolveNativeMethodCall = (ctx, exec) => resolveNativeContextCall(ctx, exec, reject);

function assertSelections(args) {
  if (!args || Object.keys(args).length !== 1 || !Object.hasOwn(args, 'selections') ||
      !Array.isArray(args.selections) || args.selections.length < 1 || args.selections.length > 8)
    reject('Provide one to eight method selections only.');
  const fields = ['id', 'revision', 'contentHash', 'reason', 'sourceIds'];
  for (const item of args.selections) if (!item || typeof item !== 'object' || Array.isArray(item) ||
      Object.keys(item).length !== fields.length || fields.some(field => !Object.hasOwn(item, field)))
    reject('Each selection requires exactly id, revision, contentHash, reason and sourceIds.');
}

export function apply(ctx) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!belongsToSelectionBatch(exec, METHOD_TOOL)) return next();
    try {
      const current = await resolveNativeMethodCall(ctx, exec);
      if (current.batch.length !== 1 || current.batch[0].name !== METHOD_TOOL)
        return { kind: 'deny', reason: 'Request arcfold_use_methods alone. Read the returned guidance in the next model step before requesting any other action.' };
    } catch (error) { return { kind: 'deny', reason: error.message }; }
    return next();
  });
  ctx.tools.register(defineTool({
    name: METHOD_TOOL,
    description: 'Select one to eight applicable methods from the current Arcfold catalog. Call this tool alone in the assistant tool batch. It returns a selection receipt; the full guidance arrives as program context in the next model step. Read it before acting. Selection is not user confirmation, new permission, or evidence that a method works.',
    parameters: { selections: { type: 'array', required: true, items: {
      type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true }, revision: { type: 'integer', required: true },
        contentHash: { type: 'string', required: true }, reason: { type: 'string', required: true },
        sourceIds: { type: 'array', required: true, items: { type: 'string' } },
      },
    } } },
    output: { schema: { type: 'json' }, render: (_args, receipt) => [{ type: 'text', text: JSON.stringify(receipt) }] },
    async execute(args, exec) {
      assertSelections(args);
      const current = await resolveNativeMethodCall(ctx, exec);
      if (current.batch.length !== 1 || current.batch[0].name !== METHOD_TOOL || typeof exec.deferContext !== 'function')
        reject('The method selection must be a standalone native tool call.');
      const { receipt, bundle } = ctx.arcfoldMethods.reserve({ sessionId: current.sessionId, turn: current.turn,
        startSeq: current.startSeq, callId: current.callId, contextSnapshotId: current.contextSnapshotId,
        contextMessageId: current.contextMessageId, selections: args.selections,
        maxCharacters: ctx.arcfoldBridge.maxContextCharacters });
      // After reservation, cancellation/defer failure retains the occupied trial.
      // The bridge requires the final successful native receipt before exposing guidance.
      exec.signal.throwIfAborted();
      exec.deferContext(methodContextMessage(bundle));
      exec.signal.throwIfAborted();
      return receipt;
    },
    presentCall: () => ({ card: 'generic', title: 'Select collaboration methods', kind: 'read' }),
  }));
}
