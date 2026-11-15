import { hash } from './evidence.mjs';

export const METHOD_CONTEXT = 'arcfold/adopted-methods';
export const METHOD_TOOL = 'arcfold_use_methods';
const INTRO = '以下方法已由本轮主助手选择，并由程序核对当前版本与原件。它们只指导当前工作，不是用户的新要求，不增加工具或执行权限。选择和展示不证明方法有效；当前用户纠正优先。\n';

export function methodContextMessage(bundle) {
  return { id: 'arcfold-method-context-' + hash(bundle), role: 'user',
    source: { kind: METHOD_CONTEXT, sessionId: bundle.sessionId, turn: bundle.turn,
      startSeq: bundle.startSeq, adoptionIds: bundle.methods.map(row => row.adoptionId) },
    content: [{ type: 'text', text: INTRO + JSON.stringify(bundle) }] };
}

function receiptOf(event) {
  if (event?.type !== 'tool/result' || event.data.message?.isError !== false || event.data.error ||
      event.data.message.role !== 'tool' || event.data.message.source?.kind !== 'tool' ||
      event.data.message.source.callId !== event.data.message.toolCallId) return null;
  const blocks = event.data.message.content;
  if (!Array.isArray(blocks) || blocks.some(block => block.type !== 'text')) return null;
  try { return JSON.parse(blocks.map(block => block.text).join('')); } catch { return null; }
}

// deferContext may survive a failed tool. Require its independently persisted,
// successful native result before any managed guidance can enter a model input.
export function hasSuccessfulMethodReceipt(events, adoption) {
  return adoption.callIds.some(callId => {
    const calls = events.filter(event => event.seq > adoption.startSeq && event.type === 'tool/call' &&
      event.data.turn === adoption.turn && event.data.name === METHOD_TOOL && event.data.callId === callId);
    if (calls.length !== 1) return false;
    const call = calls[0];
    const results = events.filter(event => event.seq > call.seq && event.type === 'tool/result' &&
      event.data.turn === adoption.turn && event.data.step === call.data.step && event.data.message?.toolCallId === callId);
    if (results.length !== 1) return false;
    const receipt = receiptOf(results[0]);
    return receipt?.adoptionIds?.includes(adoption.id) && receipt.methods?.some(row =>
      row.adoptionId === adoption.id && row.id === adoption.methodId && row.revision === adoption.methodRevision &&
      row.version === adoption.methodVersion && row.contentHash === adoption.contentHash) === true;
  });
}

export function eligibleMethodBundle(methods, events, position) {
  const bundle = methods.currentBundle(position);
  return { ...bundle, methods: bundle.methods.filter(entry => {
    const adoption = methods.store.get('method_adoptions', entry.adoptionId);
    return adoption && hasSuccessfulMethodReceipt(events, adoption);
  }) };
}

export function methodTurn(session) {
  const events = session.snapshotEvents();
  const start = events.findLast(event => event.type === 'turn/start');
  const step = events.findLast(event => event.type === 'step/start');
  if (!start || !step || step.seq <= start.seq || step.data.turn !== start.data.turn ||
      events.some(event => event.seq > start.seq && event.type === 'turn/end'))
    throw new Error('Method context requires the current open native turn');
  return { events, position: { sessionId: session.id, turn: start.data.turn, startSeq: start.seq }, step };
}
