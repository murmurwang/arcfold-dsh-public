// The UI host is packaged separately from core; keep its wire validation local.
export function browseScope(value, fallback = 'current') {
  if (value === undefined) return fallback;
  if (value === 'all' || value === 'current') return value;
  throw Object.assign(new Error('请选择全部积累或与当前聊天相关的内容。'), { code: 'invalid_browse_scope' });
}
