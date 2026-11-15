import { DomainError } from './store.mjs';

// An owner's display filter. This never changes stored scope or model context.
export function browseScope(value, fallback = 'current') {
  if (value === undefined) return fallback;
  if (value === 'all' || value === 'current') return value;
  throw new DomainError('invalid_browse_scope', '请选择全部积累或与当前聊天相关的内容。');
}

export function browseContext(row, sessionId) {
  const local = row.scope?.conversationId;
  return { related: !local || local === sessionId, scope: local ? 'conversation' : 'global',
    sourceSessionId: local || row.conversationId || row.sessionId || null };
}
