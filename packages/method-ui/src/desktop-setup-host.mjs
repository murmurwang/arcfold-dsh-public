import { TypertRemoteService, RemoteError } from '@deepseek-ai/dsh-typert-protocol';
const service = 'arcfoldDesktopWeb', namespace = 'arcfoldDesktop';

export async function desktopRequest({ setup, connection }, method, request, signal, peer) {
  if (!peer || peer !== connection.browserPeer || peer.principal?.kind !== 'owner' ||
      peer.interactions !== 'answer' || peer.signal?.aborted !== false || signal?.aborted !== false)
    throw new RemoteError('trusted_browser_required', '当前连接尚未认证。', {});
  if (method === 'status') return setup?.status() ?? { state: 'not_desktop' };
  if (method !== 'start' || !request || typeof request !== 'object' || Array.isArray(request) ||
      Object.keys(request).join() !== 'confirmed' || request.confirmed !== true)
    throw new RemoteError('invalid_desktop_setup', '请确认模型使用与费用后再继续。', {});
  if (!setup?.start) throw new RemoteError('desktop_setup_unavailable', '当前环境无法进行 Desktop 设置。', {});
  signal.throwIfAborted();
  try { return await setup.start({ confirmed: true }); }
  catch { throw new RemoteError('desktop_setup_failed', '设置未完成。请刷新并查看当前状态，避免重复创建数据。', {}); }
}
class DesktopWeb extends TypertRemoteService {
  constructor(ctx) { super(ctx, service, { namespace }); }
  dispatch(method, request) {
    const { signal, peer } = this.ctx.invocation ?? {};
    return desktopRequest({ setup: this.ctx.get('arcfoldDesktopSetup'), connection: this.ctx.connection }, method, request, signal, peer);
  }
  status(request) { return this.dispatch('status', request); }
  start(request) { return this.dispatch('start', request); }
}
export const desktopInvocations = ['status', 'start'].map(method => ({
  id: `@arcfold/dsh-method-ui#${namespace}/${method}`, service, namespace, method, invocation: { kind: 'direct' },
  parameters: [{ name: 'request', wire: 'request', source: 'json', codec: { mode: 'src-json' } }], result: { mode: 'src-json' },
}));
export function installDesktopWeb(ctx) { return new DesktopWeb(ctx); }
