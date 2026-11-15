export const zh = {
  collaborationTitle: 'Arcfold', collaborationClose: '关闭',
  collaborationViewScope: '查看范围', collaborationAll: '全部积累', collaborationCurrent: '与当前聊天相关',
  browseOtherSession: '来自其他聊天', browseReturnToOrigin: '请回到原聊天修改这条记录或继续相关工作。',
  presentationUnknown: "暂未识别",
  stateTrial: "试用中",
  stateActive: "采用中",
  statePaused: "已暂停",
  stateUnavailable: '记录暂不可用',
  stateSuperseded: "已有后继版本",
  stateWithdrawn: "已停止采用",
  stateReserved: "已领取，待核对",
  stateSettled: "已核对",
  roleUser: "用户",
  roleAssistant: "助手",
  roleTool: "工具",
  roleProgram: "程序",
  outcomePending: "尚待结束",
  outcomeCompleted: "本轮已完成",
  outcomeCancelled: "本轮已取消",
  outcomeFailed: "本轮失败",
  outcomeInterrupted: "本轮中断",
  outcomeUnknown: "本轮结果未知",
  admissionAccepted: "原生入口已受理",
  admissionFailed: "提交失败",
  admissionUnknown: "提交结果未知",
  actionStopUnderstanding: "停止采用理解",
  actionWithdrawSource: "撤回来源",
  actionCorrect: "提交逐字纠正",

  title: '协作方法', pending: '待决定', unread: '未读提醒', loading: '正在读取方法…', empty: '此范围内暂无协作方法。',
  decisionPrompt: '需要你决定：是否继续采用此版本。', reviewDecision: '查看并决定', viewDetails: '查看详情',
  history: '历史提醒', backToMethods: '返回方法列表', keepPaused: '保持暂停',
  open: '查看全文与理由', close: '收起详情', refresh: '刷新', previous: '上一页', next: '下一页',
  guidance: '完整指导', applies: '适用条件', excludes: '不适用条件', sources: '依据原件', reason: '当前状态与理由',
  version: '内容版本', revision: '记录版本', status: '状态', usage: '已选入试用', remaining: '剩余次数',
  pendingAdoptions: '尚待核对的采用', conversation: '交流', turn: '轮次',
  successors: '后继版本', continue: '继续采用此版本', pause: '暂停采用此版本', busy: '正在保存…',
  saved: '决定已保存。继续采用不代表效果已经验证，也不增加工作或工具权限。',
  failed: '操作未完成。', unknown: '结果尚未确认；可再次点击同一操作，沿用原请求编号。',
  conflict: '方法已变化。请重新查看以下全文和理由，再决定是否提交。',
  notifications: '停止与到期提醒', read: '已读', acknowledge: '标记已读', noNotifications: '目前没有提醒。',
  noSources: '没有可显示的原件。', sourceIdentity: '原件身份', sourceTime: '原始时间', author: '作者角色',
  provenance: '来源归属', retry: '重新读取详情', boundary: '查看与已读不会恢复方法；只有下方按钮会保存你的决定。',
};
export const en = {
  collaborationTitle: 'Arcfold', collaborationClose: 'Close',
  collaborationViewScope: 'View scope', collaborationAll: 'All records', collaborationCurrent: 'Related to this conversation',
  browseOtherSession: 'From another conversation', browseReturnToOrigin: 'Return to the original conversation to change this record or continue its work.',
  presentationUnknown: "Not yet recognized",
  stateTrial: "In trial",
  stateActive: "In use",
  statePaused: "Paused",
  stateUnavailable: 'Record unavailable',
  stateSuperseded: "Superseded",
  stateWithdrawn: "Withdrawn",
  stateReserved: "Reserved; awaiting reconciliation",
  stateSettled: "Reconciled",
  roleUser: "User",
  roleAssistant: "Assistant",
  roleTool: "Tool",
  roleProgram: "Program",
  outcomePending: "Awaiting turn end",
  outcomeCompleted: "Turn completed",
  outcomeCancelled: "Turn cancelled",
  outcomeFailed: "Turn failed",
  outcomeInterrupted: "Turn interrupted",
  outcomeUnknown: "Turn outcome unknown",
  admissionAccepted: "Accepted by native input",
  admissionFailed: "Submission failed",
  admissionUnknown: "Submission outcome unknown",
  actionStopUnderstanding: "Stop using understanding",
  actionWithdrawSource: "Withdraw source",
  actionCorrect: "Submit exact correction",

  title: 'Collaboration methods', pending: 'Awaiting decision', unread: 'Unread notices', loading: 'Loading methods…', empty: 'No collaboration methods in this view.',
  decisionPrompt: 'Your decision: whether to keep using this version.', reviewDecision: 'Review and decide', viewDetails: 'View details',
  history: 'Notice history', backToMethods: 'Back to methods', keepPaused: 'Keep paused',
  open: 'Read full method and reason', close: 'Close details', refresh: 'Refresh', previous: 'Previous', next: 'Next',
  guidance: 'Full guidance', applies: 'Applies when', excludes: 'Does not apply when', sources: 'Original evidence', reason: 'Current state and reason',
  version: 'Content version', revision: 'Record revision', status: 'State', usage: 'Trial selections', remaining: 'Remaining',
  pendingAdoptions: 'Selections awaiting reconciliation', conversation: 'Conversation', turn: 'Turn',
  successors: 'Later versions', continue: 'Continue this version', pause: 'Pause this version', busy: 'Saving…',
  saved: 'Decision saved. Continuing does not validate effectiveness or grant additional work or tool permissions.',
  failed: 'The action did not complete.', unknown: 'Outcome not confirmed; repeat the same action to reuse its request ID.',
  conflict: 'The method changed. Read the refreshed guidance and reason before deciding again.',
  notifications: 'Pause and trial notices', read: 'Read', acknowledge: 'Mark read', noNotifications: 'No notices.',
  noSources: 'No original evidence is available to display.', sourceIdentity: 'Source identity', sourceTime: 'Original time', author: 'Author role',
  provenance: 'Provenance', retry: 'Reload details', boundary: 'Viewing or marking read does not resume a method. Only these controls save your decision.',
};

const presentationKeys = {
  "method": {
    "trial": "stateTrial",
    "active": "stateActive",
    "paused": "statePaused",
    "unavailable": "stateUnavailable",
    "superseded": "stateSuperseded"
  },
  "understanding": {
    "active": "stateActive",
    "withdrawn": "stateWithdrawn",
    "superseded": "stateSuperseded"
  },
  "adoption": {
    "reserved": "stateReserved",
    "settled": "stateSettled"
  },
  "role": {
    "user": "roleUser",
    "assistant": "roleAssistant",
    "tool": "roleTool",
    "program": "roleProgram"
  },
  "outcome": {
    "pending": "outcomePending",
    "completed": "outcomeCompleted",
    "cancelled": "outcomeCancelled",
    "failed": "outcomeFailed",
    "interrupted": "outcomeInterrupted",
    "unknown": "outcomeUnknown"
  },
  "admission": {
    "accepted": "admissionAccepted",
    "failed": "admissionFailed",
    "unknown": "admissionUnknown"
  },
  "understandingAction": {
    "stop-understanding": "actionStopUnderstanding",
    "withdraw-source": "actionWithdrawSource",
    "correct": "actionCorrect"
  },
  "goal": {
    "tracking": "goalTracking",
    "paused": "goalPaused",
    "closed": "goalClosed"
  },
  "relation": {
    "part_of": "goalPart",
    "supports": "goalSupports",
    "derived_from": "goalDerived"
  },
  "claim": {
    "user_statement": "understandingLiteral",
    "inference": "understandingInference",
    "open_question": "understandingQuestion"
  }
};
// Free text (including reasons, provenance and authored content) is not passed here.
export function presentationLabel(group, value, t) {
  const entries = Object.hasOwn(presentationKeys, group) ? presentationKeys[group] : null;
  return t(entries && Object.hasOwn(entries, value) ? entries[value] : 'presentationUnknown');
}
