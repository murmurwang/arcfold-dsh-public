import { hash } from './evidence.mjs';
import { canonicalJson } from './store.mjs';

export const GOAL_CONTEXT = 'arcfold/linked-goal';
export const GOAL_TOOL = 'arcfold_link_goal';
const INTRO = '以下长期目标已由本轮主助手关联，程序已核对其版本与原件。本次贡献是助手的判断，不是用户认可或目标已实现的证明。联系只解释当前工作，不扩大委托或工具权限；暂停或结束追踪的目标只能在用户明确选回时讨论，不因此恢复追踪。来源失效时仅可依本次新原话重新澄清，不使用无效旧内容。\n';

export function goalContextMessage(bundle) {
  return { id: 'arcfold-goal-context-' + hash(bundle), role: 'user',
    source: { kind: GOAL_CONTEXT, sessionId: bundle.sessionId, turn: bundle.turn,
      startSeq: bundle.startSeq, linkIds: bundle.links.map(row => row.linkId) },
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

// The link core is immutable. A later native call can return the same link only
// for the exact same selection; derive its success from actual call/result pairs.
export function hasSuccessfulGoalReceipt(events, link) {
  return events.filter(event => event.seq > link.startSeq && event.type === 'tool/call' &&
    event.data.turn === link.turn && event.data.name === GOAL_TOOL).some(call => {
    if (events.filter(event => event.type === 'tool/call' && event.data.callId === call.data.callId).length !== 1)
      return false;
    let args;
    try { args = JSON.parse(call.data.arguments); } catch { return false; }
    if (!args || Object.keys(args).length !== 1 || !Object.hasOwn(args, 'selection') ||
        canonicalJson(args.selection) !== canonicalJson(link.selection)) return false;
    const results = events.filter(event => event.seq > call.seq && event.type === 'tool/result' &&
      event.data.turn === link.turn && event.data.step === call.data.step &&
      event.data.message?.toolCallId === call.data.callId);
    if (results.length !== 1) return false;
    const receipt = receiptOf(results[0]);
    return receipt?.linkId === link.id && receipt.goal?.id === link.goalId &&
      receipt.goal.revision === link.goalRevision && receipt.goal.definitionVersion === link.definitionVersion &&
      receipt.goal.contentHash === link.contentHash;
  });
}

export function eligibleGoalBundle(goals, events, position) {
  const bundle = goals.currentBundle(position);
  return { ...bundle, links: bundle.links.filter(entry => {
    const link = goals.store.get('goal_links', entry.linkId);
    return link && hasSuccessfulGoalReceipt(events, link);
  }) };
}
