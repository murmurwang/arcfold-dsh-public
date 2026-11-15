// Shared native identity/catalog checks; the host remains the execution owner.
import { canonicalJson } from './store.mjs';
import { contextMessage } from './context-material.mjs';

const nonnegative = value => Number.isSafeInteger(value) && value >= 0;

function liveCaller(ctx, exec, reject) {
  if (!exec.signal || typeof exec.signal.throwIfAborted !== 'function') reject('A native cancellation signal is required.');
  exec.signal.throwIfAborted();
  const agent = exec.agent;
  if (!agent || ctx.agents.get(agent.id) !== agent || agent.status !== 'running' ||
      ctx.agents.currentInitiator() !== agent || !ctx.arcfoldBridge.isBound(agent.session?.id))
    reject('Context selection requires the exact live Arcfold main agent in its current driver.');
  if (exec.parent !== undefined || exec.rootCallId !== exec.callId || typeof exec.callId !== 'string' || !exec.callId)
    reject('Context selection requires a direct native call, not a nested or PTC call.');
  const boundary = ctx.agents.turnBoundaryOf(agent.session);
  if (!nonnegative(boundary.openTurnStartSeq) || boundary.lastStepBoundary?.kind !== 'start')
    reject('Context selection requires an open native model step.');
  return { agent, boundary };
}

function callEvidence(events, exec, reject) {
  const calls = events.filter(event => event.type === 'tool/call' && event.data.callId === exec.callId);
  if (calls.length !== 1) reject('This call has no unique native tool/call record.');
  const call = calls[0];
  const assistant = events.findLast(event => event.seq < call.seq && event.type === 'assistant/message');
  if (!assistant || assistant.data.message?.role !== 'assistant' || assistant.data.message?.source?.kind !== 'model' ||
      assistant.data.interrupted || assistant.data.turn !== call.data.turn || assistant.data.step !== call.data.step)
    reject('This call does not belong to the completed assistant message in its native step.');
  const batch = assistant.data.message.content.filter(block => block.type === 'tool-call');
  const matching = batch.filter(block => block.id === exec.callId);
  if (matching.length !== 1 || new Set(batch.map(block => block.id)).size !== batch.length ||
      call.data.name !== exec.name || matching[0].name !== exec.name || matching[0].arguments !== call.data.arguments)
    reject('The native tool call differs from the assistant tool-call list.');
  let argumentsValue;
  try { argumentsValue = JSON.parse(call.data.arguments); } catch { reject('The native tool arguments are not JSON.'); }
  if (canonicalJson(argumentsValue) !== canonicalJson(exec.arguments)) reject('The execution arguments differ from the native call.');
  if (events.some(event => event.seq > call.seq && event.type === 'tool/result' && event.data.message?.toolCallId === exec.callId))
    reject('This native call already has a result.');
  return { call, assistant, batch };
}

/** Native driver + flushed call + current logged surface + saved material, not a second execution identity. */
export async function resolveNativeContextCall(ctx, exec, reject) {
  const before = liveCaller(ctx, exec, reject), session = before.agent.session;
  const events = await ctx.arcfoldBridge.durablePrefix(session);
  const after = liveCaller(ctx, exec, reject);
  if (after.agent !== before.agent || after.boundary.openTurnStartSeq !== before.boundary.openTurnStartSeq ||
      after.boundary.lastStepStartSeq !== before.boundary.lastStepStartSeq)
    reject('The native driver changed while its call was being flushed.');
  const startSeq = before.boundary.openTurnStartSeq;
  const start = events.find(event => event.seq === startSeq && event.type === 'turn/start');
  const stepStart = events.find(event => event.seq === before.boundary.lastStepStartSeq && event.type === 'step/start');
  const evidence = callEvidence(events, exec, reject);
  if (!start || !stepStart || !nonnegative(start.data.turn) || !nonnegative(stepStart.data.step) ||
      stepStart.seq <= startSeq || stepStart.data.turn !== start.data.turn ||
      evidence.assistant.seq <= stepStart.seq || evidence.call.data.turn !== start.data.turn ||
      evidence.call.data.step !== stepStart.data.step || events.some(event => event.seq > startSeq && event.type === 'turn/end') ||
      events.some(event => event.seq > stepStart.seq && event.type === 'step/end'))
    reject('The call is outside the current unfinished native turn and step.');

  const messages = session.deriveMessages().filter(message => message.source?.kind === 'arcfold/context');
  if (messages.length !== 1) reject('The native surface has no unique current Arcfold catalog.');
  const message = messages[0];
  const originals = events.filter(event => event.type === 'user/message' && event.data.id === message.id &&
    event.data.source?.kind === 'arcfold/context');
  if (originals.length !== 1 || originals[0].seq <= startSeq || originals[0].seq >= evidence.assistant.seq ||
      canonicalJson(originals[0].data) !== canonicalJson(message))
    reject('The visible catalog has no matching durable original before this assistant response.');
  const snapshots = ctx.arcfoldBridge.storage.listAll('context_snapshots', {
    where: { sessionId: session.id, turn: start.data.turn, contextMessageId: message.id },
  });
  if (snapshots.length !== 1 || canonicalJson(contextMessage(snapshots[0].material)) !== canonicalJson(message))
    reject('The native catalog is not the frozen material saved for this turn.');
  return { ...evidence, agent: before.agent, events, sessionId: session.id, turn: start.data.turn,
    step: stepStart.data.step, startSeq, callId: exec.callId,
    contextSnapshotId: snapshots[0].id, contextMessageId: message.id };
}

export function belongsToSelectionBatch(exec, toolName) {
  if (exec.name === toolName) return true;
  const events = exec.agent?.session?.snapshotEvents?.();
  if (!events) return false;
  const call = events.findLast(event => event.type === 'tool/call' && event.data.callId === exec.callId);
  const assistant = call && events.findLast(event => event.seq < call.seq && event.type === 'assistant/message' &&
    event.data.turn === call.data.turn && event.data.step === call.data.step);
  return assistant?.data.message.content.some(block => block.type === 'tool-call' && block.name === toolName) === true;
}
