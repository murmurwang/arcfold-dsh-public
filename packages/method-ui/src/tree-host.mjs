import { TypertRemoteService, RemoteError } from '@deepseek-ai/dsh-typert-protocol';
// This package is installed separately from core. Its wire declarations must
// not reach back through the development monorepo layout. The gateway test
// checks this public list against the core adapter on every candidate.
export const TREE_RPC_ENDPOINTS = ['session.current', 'session.selectBranch', 'tree.list', 'node.details', 'turn.details', 'source.read', 'node.rename', 'node.move', 'node.status', 'turn.correct', 'turn.undoCreate', 'turn.undoStatus', 'item.confirm', 'item.edit', 'item.withdraw', 'item.undoCorrection', 'hook.disable', 'signal.correct', 'snapshots.list', 'snapshots.preview', 'snapshots.restore', 'metrics.read', 'reports.list', 'reports.details', 'reports.export', 'parameters.set', 'receipts.read'];
const NAMESPACE = 'arcfoldTreeV3', SERVICE = 'arcfoldTreeWeb';
const messages = {
  CANDIDATE_CAPACITY: '这支目标的候选仍超过2000个，请选择更小的一支；尚未调用模型。', SESSION_BUSY: '当前对话仍在处理，请稍后刷新再选择范围。', CONTINUATION_UNAVAILABLE: '这条消息已继续或发送状态待核对，不能重复发送。',
  REVISION_CONFLICT: '内容已变化，请刷新后再决定。', VERSION_CONFLICT: '这个版本已变化，请刷新。', IDEMPOTENCY_CONFLICT: '此提交编号已经用于另一份操作，未再次执行。',
  NEED_ASSIGNMENT_CORRECTION: '这个目标已有后续经历，请改用纠正本轮归属。', RESTORE_CONFLICT: '预览后文件已变化，请重新预览。',
  FORBIDDEN: '当前连接无权执行此操作。', BROWSE_SCOPE: '这项内容不在当前可查看范围。', SOURCE_CHANGED: '原始证据已经不可用，请刷新。',
  USER_PROTECTED: '用户确认的内容受保护。', CORRECTION_CHANGED: '更正后的内容已有变化，请查看历史后再决定。', SNAPSHOT_UNAVAILABLE: '当前工作区尚不能恢复这份快照。', INVALID_FIELD: '请检查填写内容。', INVALID_SHAPE: '操作字段不完整或不受支持。',
  TREE_CYCLE: '不能把目标移到自己的下级。', ROOT_INVARIANT: '不能这样改变根目标。', CONFIRM_INFERENCE_ONLY: '只有助手推断的理解需要确认。', ITEM_RECHECK_REQUIRED: '归属已变化，请核对并保存当前内容后再使用。', ENDPOINT_NOT_FOUND: '不存在这项操作。',
};
export function createTreeHandler({ service, connection, inflight = new Map() }) {
  return async (endpoint, payload, signal, peer) => {
    try {
      if (!peer || peer !== connection.browserPeer || peer.principal?.kind !== 'owner' || peer.interactions !== 'answer' || peer.signal?.aborted !== false || signal?.aborted !== false) throw new RemoteError('TRUSTED_BROWSER_REQUIRED', '仅接受当前已认证网页的请求。', {});
      if (!service || !payload || typeof payload.sessionId !== 'string' || !payload.sessionId.trim()) throw new RemoteError('TREE_UNAVAILABLE', '请打开当前个人助手的聊天。', {});
      const { sessionId, ...request } = payload, context = { actor: { kind: 'user', id: service.repo.userId }, sessionId, signal: AbortSignal.any([signal, peer.signal]), peer };
      const key = request.requestId && peer.id + ':' + request.requestId, hash = JSON.stringify([sessionId, endpoint, request]);
      const active = key && inflight.get(key); if (active) { if (active.hash !== hash) throw new RemoteError('IDEMPOTENCY_CONFLICT', messages.IDEMPOTENCY_CONFLICT, {}); return await active.promise; }
      const promise = service.dispatch(endpoint, request, context); if (key) inflight.set(key, { hash, promise });
      try { return await promise; } finally { if (key && inflight.get(key)?.promise === promise) inflight.delete(key); }
    } catch (error) {
      if (error instanceof RemoteError) throw error;
      const code = Object.hasOwn(messages, error?.code) ? error.code : 'TREE_REQUEST_FAILED';
      throw new RemoteError(code, messages[code] ?? '操作尚未确认，请刷新查看记录。没有自动重发。', { status: error?.statusCode === 403 ? 403 : 409 });
    }
  };
}
class TreeWeb extends TypertRemoteService {
  inflight = new Map();
  constructor(ctx) { super(ctx, SERVICE, { namespace: NAMESPACE }); }
  dispatch(endpoint, request) { const { signal, peer } = this.ctx.invocation ?? {}; return createTreeHandler({ service: this.ctx.arcfoldTreeV3, connection: this.ctx.connection, inflight: this.inflight })(endpoint, request, signal, peer); }
}
for (const endpoint of TREE_RPC_ENDPOINTS) Object.defineProperty(TreeWeb.prototype, endpoint, { value(request) { return this.dispatch(endpoint, request); } });
export const treeInvocations = TREE_RPC_ENDPOINTS.map(method => ({ id: `@arcfold/dsh-method-ui#${NAMESPACE}/${method}`, service: SERVICE, namespace: NAMESPACE, method, invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json', codec: { mode: 'src-json' } }], result: { mode: 'src-json' } }));
export function installTreeWeb(ctx) { return ctx.inject(['arcfoldTreeV3', 'connection'], owner => { new TreeWeb(owner); }); }
