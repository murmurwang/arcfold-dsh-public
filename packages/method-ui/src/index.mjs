import { opportunityInvocations, installOpportunityWeb } from './opportunity-host.mjs';
import { importInvocations, installImportWeb } from './import-host.mjs';
import { understandingInvocations, installUnderstandingWeb } from './understanding-host.mjs';
// The browser transport supplies identity; no model-facing control is registered here.
import { TypertRemoteService, RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import { goalInvocations, installGoalWeb } from './goal-host.mjs';
import { modelInvocations, installModelWeb } from './model-host.mjs';
import { browseScope } from './browse-scope.mjs';
import { treeInvocations, installTreeWeb } from './tree-host.mjs';
import { desktopInvocations, installDesktopWeb } from './desktop-setup-host.mjs';
export const name = 'arcfold-method-ui';
export const inject = ['connection', 'typert', 'typertGateway'];
export const CHANNEL = '/api';
export const NAMESPACE = 'arcfoldMethods';
const SERVICE = 'arcfoldMethodWeb';
const ENDPOINTS = ['list', 'details', 'cards', 'cardDetails', 'notifications', 'acknowledge', 'decide'];

function invalid(message) {
  throw Object.assign(new Error(message), { code: 'invalid_method_request' });
}
function object(value, allowed, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key)))
    invalid('方法请求包含缺失或未允许的字段。');
  return value;
}
function identity(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || value.includes('\0'))
    invalid('请求编号不能为空或超长。');
}
function page(payload, notifications = false, scoped = false) {
  object(payload, notifications ? ['offset', 'limit', 'unread'] : scoped ? ['offset', 'limit', 'sessionId', 'viewScope'] : ['offset', 'limit']);
  if (scoped) {
    browseScope(payload.viewScope, 'all');
    if (payload.viewScope !== undefined || payload.sessionId !== undefined) identity(payload.sessionId);
  }
  if (payload.offset !== undefined && (!Number.isSafeInteger(payload.offset) || payload.offset < 0) ||
      payload.limit !== undefined && (!Number.isSafeInteger(payload.limit) || payload.limit < 1 || payload.limit > (notifications ? 200 : 100)) ||
      payload.unread !== undefined && typeof payload.unread !== 'boolean') invalid('分页参数不合法。');
  return payload;
}

export function createMethodHandler({ methods, connection }) {
  return async (endpoint, payload, signal, peer) => {
    try {
      if (!peer || peer !== connection.browserPeer || peer.principal?.kind !== 'owner' ||
          peer.interactions !== 'answer' || peer.signal?.aborted !== false || signal?.aborted !== false)
        throw Object.assign(new Error('此操作只接受当前已认证网页的请求。'), { code: 'trusted_browser_required' });
      let value;
      switch (endpoint) {
        case 'list': value = methods.listDecisions(page(payload)); break;
        case 'cards': value = methods.listCards(page(payload, false, true)); break;
        case 'cardDetails': {
          object(payload, ['methodId', 'offset', 'limit', 'sessionId', 'viewScope'], ['methodId']); identity(payload.methodId);
          const { methodId, ...pagination } = payload;
          value = methods.cardDetails(methodId, page(pagination, false, true)); break;
        }
        case 'notifications': value = methods.notifications(page(payload, true)); break;
        case 'details':
          object(payload, ['methodId'], ['methodId']); identity(payload.methodId);
          value = methods.details(payload.methodId); break;
        case 'acknowledge':
          object(payload, ['notificationId'], ['notificationId']); identity(payload.notificationId);
          value = methods.acknowledgeNotification(payload.notificationId); break;
        case 'decide': {
          const fields = ['methodId', 'expectedRevision', 'contentHash', 'action', 'requestId'];
          object(payload, fields, fields);
          identity(payload.methodId); identity(payload.contentHash); identity(payload.requestId);
          if (!Number.isSafeInteger(payload.expectedRevision) || payload.expectedRevision < 1 ||
              !['continue', 'pause'].includes(payload.action)) invalid('决定必须绑定已查看的版本和操作。');
          value = methods.decide({ ...payload, userIdentity: 'browser:' + peer.id });
          break;
        }
        default: throw Object.assign(new Error('不存在的方法操作。'), { code: 'method_endpoint_not_found' });
      }
      return { ok: true, value: await value };
    } catch (error) {
      return { ok: false, error: { code: typeof error?.code === 'string' ? error.code : 'method_request_failed',
        message: error instanceof Error ? error.message : '方法操作未完成。', details: {} } };
    }
  };
}

class MethodWeb extends TypertRemoteService {
  constructor(ctx) { super(ctx, SERVICE, { namespace: NAMESPACE }); }
  async dispatch(endpoint, request) {
    const invocation = this.ctx.invocation;
    const result = await createMethodHandler({ methods: this.ctx.arcfoldMethods, connection: this.ctx.connection })(
      endpoint, request, invocation?.signal, invocation?.peer);
    if (!result.ok) throw new RemoteError(result.error.code, result.error.message, result.error.details);
    return result.value;
  }
  list(request) { return this.dispatch('list', request); }
  details(request) { return this.dispatch('details', request); }
  cards(request) { return this.dispatch('cards', request); }
  cardDetails(request) { return this.dispatch('cardDetails', request); }
  notifications(request) { return this.dispatch('notifications', request); }
  acknowledge(request) { return this.dispatch('acknowledge', request); }
  decide(request) { return this.dispatch('decide', request); }
}

class ArcfoldMode extends TypertRemoteService {
  constructor(ctx) { super(ctx, 'arcfoldModeWeb', { namespace: 'arcfoldMode' }); }
  current() {
    const { peer, signal } = this.ctx.invocation ?? {};
    if (!peer || peer !== this.ctx.connection.browserPeer || peer.principal?.kind !== 'owner' || peer.interactions !== 'answer' || peer.signal?.aborted !== false || signal?.aborted !== false) throw new RemoteError('TRUSTED_BROWSER_REQUIRED', '当前连接尚未认证。', {});
    return { goalTreeV3: Boolean(this.ctx.get('arcfoldTreeMode')?.enabled) };
  }
}
export function apply(ctx) {
  new ArcfoldMode(ctx);
  ctx.inject(['arcfoldMethods'], owner => { new MethodWeb(owner); });
  installTreeWeb(ctx);
  installDesktopWeb(ctx);
  installGoalWeb(ctx);
  installModelWeb(ctx);
  installUnderstandingWeb(ctx);
  installImportWeb(ctx);
  installOpportunityWeb(ctx);
  // Use the existing authenticated Gateway; do not claim its single /api interceptor.
  ctx.typert.register({ package: '@arcfold/dsh-method-ui', face: 'host', schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: [{ id: '@arcfold/dsh-method-ui#arcfoldMode/current', service: 'arcfoldModeWeb', namespace: 'arcfoldMode', method: 'current', invocation: { kind: 'direct' }, parameters: [], result: { mode: 'src-json' } }, ...desktopInvocations, ...treeInvocations, ...ENDPOINTS.map(method => ({ id: `@arcfold/dsh-method-ui#${NAMESPACE}/${method}`,
      service: SERVICE, namespace: NAMESPACE, method, invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: { mode: 'src-json' } }],
      result: { mode: 'src-json' } })), ...goalInvocations, ...modelInvocations, ...understandingInvocations, ...importInvocations, ...opportunityInvocations] });
}
