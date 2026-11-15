import { TypertRemoteService, RemoteError } from '@deepseek-ai/dsh-typert-protocol';
const SERVICE = 'arcfoldModelWeb', NAMESPACE = 'arcfoldModels';
const fail = (code, message) => { throw new RemoteError(code, message, {}); };
async function runModelRequest({ models, connection }, method, request, signal, peer) {
  if (!peer || peer !== connection.browserPeer || peer.principal?.kind !== 'owner' ||
      peer.interactions !== 'answer' || peer.signal?.aborted !== false || signal?.aborted !== false)
    fail('trusted_browser_required', '此操作只接受当前已认证网页的请求。');
  if (!models) fail('model_settings_unavailable', '当前部署尚未接通模型设置。');
  if (!request || typeof request !== 'object' || Array.isArray(request)) fail('invalid_model_request', '设置请求格式无效。');
  if (method === 'read') {
    if (Object.keys(request).length) fail('invalid_model_request', '读取模型设置不接受会话或其他参数。');
    const result = await models.read(); signal.throwIfAborted(); return result;
  }
  if (method === 'saveLearning') {
    const fields = ['expectedRevision', 'provider', 'model', 'reasoningEffort'];
    if (Object.keys(request).sort().join() !== fields.sort().join() || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1 ||
        ['provider', 'model', 'reasoningEffort'].some(key => typeof request[key] !== 'string' || !request[key] || request[key].length > 256))
      fail('invalid_model_request', '只接受当前版本和完整的学习模型选择。');
    // A disconnected browser must not leave an awaited catalog read able to
    // commit its setting. The service invokes this again just before saving.
    return models.saveLearning(request, () => {
      signal.throwIfAborted();
      if (peer !== connection.browserPeer || peer.signal.aborted || peer.principal?.kind !== 'owner' || peer.interactions !== 'answer') fail('trusted_browser_required', '网页连接已变化，请刷新设置。');
    });
  }
  fail('model_endpoint_not_found', '不存在的模型设置操作。');
}
const knownErrors = {
  revision_conflict: '学习设置已在其他页面修改，请刷新后重新选择。',
  learning_configuration_unavailable: '当前部署无法使用所选的学习模型，请检查设置。',
  invalid_learning_defaults: '请提交完整的模型选择和当前设置版本。',
  ARCFOLD_RUNTIME_RESTART_REQUIRED: '运行配置已变化，请通过启动器重新启动后再保存。',
  ARCFOLD_RUNTIME_NOT_READY: '运行环境尚未就绪，请稍后刷新。',
};
export async function dispatchModelRequest(...args) {
  try { return await runModelRequest(...args); }
  catch (error) {
    if (error instanceof RemoteError) throw error;
    const code = Object.hasOwn(knownErrors, error?.code) ? error.code : 'model_settings_failed';
    throw new RemoteError(code, knownErrors[code] ?? '模型设置未完成，请刷新查看实际保存结果。', {});
  }
}
class ModelWeb extends TypertRemoteService {
  constructor(ctx) { super(ctx, SERVICE, { namespace: NAMESPACE }); }
  dispatch(method, request) {
    const { signal, peer } = this.ctx.invocation ?? {};
    return dispatchModelRequest({ models: this.ctx.get('arcfoldRuntimeModels'), connection: this.ctx.connection }, method, request, signal, peer);
  }
  read(request) { return this.dispatch('read', request); }
  saveLearning(request) { return this.dispatch('saveLearning', request); }
}
export const modelInvocations = ['read', 'saveLearning'].map(method => ({
  id: `@arcfold/dsh-method-ui#${NAMESPACE}/${method}`, service: SERVICE, namespace: NAMESPACE, method,
  invocation: { kind: 'direct' },
  parameters: [{ name: 'request', wire: 'request', source: 'json', codec: { mode: 'src-json' } }], result: { mode: 'src-json' } }));
export function installModelWeb(ctx) { return new ModelWeb(ctx); }
