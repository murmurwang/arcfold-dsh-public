import { DomainError, canonicalJson } from './store.mjs';
import { hash } from './evidence.mjs';

export function methodPauseReason(method) {
  const reason = method.pauseReason || method.withdrawalReason || '';
  if (reason === 'import_batch_withdrawn') return '你已撤销这批导入；方法依赖的来源已停止作为依据，因此暂停。原记录保留。';
  if (reason === 'user_request') return '你已选择暂停；需要时可重新查看并决定。';
  if (reason === 'trial_limit') return '试用次数用完，已停止新的试用，等待你决定是否继续。这不代表效果验证通过或失败。';
  if (reason === 'negative_feedback') return '反馈指出需要调整，方法已暂停，等待重新判断。';
  if (reason === 'superseded') return '学习提出了修订，旧方法已暂停；请查看后继版本。';
  if (/^(source_|understanding_|method_)/.test(reason)) return '方法依据的原件、理解或其他方法已撤回、暂停或变化，需要先核对依据。';
  return reason ? '暂停原因：' + reason : '历史记录没有保存暂停原因，无法据此认定曾经提醒过你。';
}

/** One synchronous state transition and notification, including Learn's pauses. */
export function pauseMethod(store, method, { reason, changes = {}, pendingId = null } = {}) {
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 4000)
    throw new DomainError('invalid_pause_reason', '暂停必须保留具体原因。', 400);
  return store.transaction(() => {
    const current = store.get('methods', method.id);
    if (current?.revision !== method.revision)
      throw new DomainError('revision_conflict', '方法已变化，请重新读取。');
    const patch = { ...changes, status: 'paused', pauseReason: reason };
    if (Object.entries(patch).every(([key, value]) => canonicalJson(current[key] ?? null) === canonicalJson(value))) return current;
    const saved = store.save('methods', { ...current, ...patch }, { expectedRevision: current.revision });
    store.save('notifications', {
      id: 'method-pause-' + hash([saved.id, saved.revision]), kind: 'method_paused', status: 'unread',
      methodId: saved.id, methodRevision: saved.revision, methodVersion: saved.version || 1,
      pendingId, reason, title: '协作方法已暂停',
      message: `“${saved.title || '未命名方法'}”：${methodPauseReason(saved)}`,
    });
    return saved;
  });
}
