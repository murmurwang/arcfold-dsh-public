import { currentMainAgent } from './main-session.mjs';
import { browseScope } from './browse-scope.mjs';
import { TypertRemoteService, RemoteError } from '@deepseek-ai/dsh-typert-protocol';
const NAMESPACE = 'arcfoldOpportunities', SERVICE = 'arcfoldOpportunityWeb';
const ENDPOINTS = ['list', 'details', 'source', 'savePermission', 'prepare', 'stop', 'dismiss', 'acknowledge', 'continue'];
const invalid = message => { throw Object.assign(new Error(message), { code: 'invalid_opportunity_request' }); };
function object(value, fields, required = fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key)) ||
      required.some(key => !Object.hasOwn(value, key))) invalid('机会请求缺少必要内容或含未允许字段。');
}
function identity(value) { if (typeof value !== 'string' || !value.trim() || value.length > 512 || value.includes('\0')) invalid('请求身份无效。'); }
function trusted(connection, signal, peer) {
  if (!peer || peer !== connection.browserPeer || peer.principal?.kind !== 'owner' || peer.interactions !== 'answer' ||
      peer.signal?.aborted !== false || signal?.aborted !== false)
    throw Object.assign(new Error('此操作只接受当前已认证网页用户。'), { code: 'trusted_browser_required' });
}
export function createOpportunityHandler({ opportunities, preparation, connection, agents, agentPresets, prompt, inflight = new Map() }) {
  const main = (sessionId, expected) => {
    const agent = currentMainAgent({ agents, agentPresets }, sessionId);
    if (!agent || expected && agent !== expected)
      throw Object.assign(new Error('请先打开原来的 Arcfold 主交流，再发送继续工作的要求。'), { code: 'opportunity_session_denied' });
    return agent;
  };
  return async (endpoint, payload, signal, peer) => {
    try {
      trusted(connection, signal, peer); let value; const userIdentity = 'browser:' + peer.id;
      if (endpoint === 'list') {
        object(payload, ['sessionId', 'offset', 'limit', 'viewScope'], ['sessionId']); identity(payload.sessionId); browseScope(payload.viewScope);
        value = { ...opportunities.list(payload.sessionId, payload), canContinue: currentMainAgent({ agents, agentPresets }, payload.sessionId) !== null };
      } else if (endpoint === 'details') {
        object(payload, ['sessionId', 'opportunityId', 'viewScope'], ['sessionId', 'opportunityId']); identity(payload.sessionId); identity(payload.opportunityId);
        const all = browseScope(payload.viewScope) === 'all';
        value = opportunities.details(payload.opportunityId);
        if (!all && value.opportunity.conversationId !== payload.sessionId) invalid('请从机会原来的交流查看。');
      } else if (endpoint === 'source') {
        object(payload, ['sourceId']); identity(payload.sourceId);
        const source = opportunities.store.get('events', payload.sourceId);
        if (!source) invalid('原件不存在。');
        value = { source, control: opportunities.store.get('source_controls', payload.sourceId) };
      } else if (endpoint === 'savePermission') {
        object(payload, ['sessionId', 'enabled', 'extraSourceIds', 'files', 'expectedRevision', 'requestId']);
        value = opportunities.savePermission({ ...payload, userIdentity });
      } else if (endpoint === 'prepare') {
        object(payload, ['opportunityId', 'expectedRevision', 'permissionRevision', 'requestId']); identity(payload.requestId);
        const bound = opportunities.bindPreparation({ ...payload, userIdentity }), key = bound.binding.id;
        if (inflight.has(key)) value = inflight.get(key);
        else if (!bound.created) value = bound;
        else {
          const pending = Promise.resolve().then(async () => {
            let state = 'failed', runId = null;
            try {
              trusted(connection, signal, peer);
              const run = await preparation.prepare(payload); runId = run.id; state = 'accepted';
            } catch { /* Failed/uncertain admission remains a consumed request. */ }
            return { ...bound, binding: opportunities.preparationAdmission(key, state, runId) };
          });
          inflight.set(key, pending); value = pending.finally(() => { if (inflight.get(key) === pending) inflight.delete(key); });
        }
      } else if (endpoint === 'stop') {
        object(payload, ['runId', 'expectedRevision', 'requestId']); value = opportunities.stop({ ...payload, userIdentity });
      } else if (endpoint === 'dismiss') {
        object(payload, ['opportunityId', 'expectedRevision', 'requestId']); value = opportunities.dismiss({ ...payload, userIdentity });
      } else if (endpoint === 'acknowledge') {
        object(payload, ['notificationId']); identity(payload.notificationId); value = opportunities.acknowledge(payload.notificationId);
      } else if (endpoint === 'continue') {
        object(payload, ['sessionId', 'opportunityId', 'expectedRevision', 'requestId', 'text']);
        const agent = main(payload.sessionId);
        const bound = opportunities.bindContinuation({ ...payload, userIdentity }), key = bound.binding.id;
        if (inflight.has(key)) value = inflight.get(key);
        else if (!bound.created) value = bound;
        else {
          let entered = false;
          const pending = Promise.resolve().then(async () => {
            let state;
            try {
              trusted(connection, signal, peer);
              main(payload.sessionId, agent);
              if (!opportunities.isMain(payload.sessionId)) invalid('当前主交流不可用。');
              entered = true;
              const result = await prompt({ sessionId: payload.sessionId, requestId: payload.requestId, mode: 'queue',
                content: [{ type: 'text', text: payload.text }] }, signal);
              state = result?.accepted === true ? 'accepted' : 'unknown';
            } catch { state = entered ? 'unknown' : 'failed'; }
            return { ...bound, binding: opportunities.continuationAdmission(key, state) };
          });
          inflight.set(key, pending); value = pending.finally(() => { if (inflight.get(key) === pending) inflight.delete(key); });
        }
      } else invalid('机会操作不存在。');
      return { ok: true, value: await value };
    } catch (error) { return { ok: false, error: { code: error?.code ?? 'opportunity_request_failed', message: error.message ?? '操作未完成。' } }; }
  };
}
class OpportunityWeb extends TypertRemoteService {
  inflight = new Map();
  constructor(ctx) { super(ctx, SERVICE, { namespace: NAMESPACE }); }
  async dispatch(endpoint, payload) {
    const invocation = this.ctx.invocation, controller = this.ctx.sessionController;
    const result = await createOpportunityHandler({ opportunities: this.ctx.arcfoldOpportunities, preparation: this.ctx.arcfoldPreparation,
      connection: this.ctx.connection, agents: this.ctx.agents, agentPresets: this.ctx.agentPresets, inflight: this.inflight,
      prompt: (payload, signal) => controller.prompt(payload, signal) })(endpoint, payload, invocation?.signal, invocation?.peer);
    if (!result.ok) throw new RemoteError(result.error.code, result.error.message, {}); return result.value;
  }
  list(p) { return this.dispatch('list', p); }
  details(p) { return this.dispatch('details', p); }
  source(p) { return this.dispatch('source', p); }
  savePermission(p) { return this.dispatch('savePermission', p); }
  prepare(p) { return this.dispatch('prepare', p); }
  stop(p) { return this.dispatch('stop', p); }
  dismiss(p) { return this.dispatch('dismiss', p); }
  acknowledge(p) { return this.dispatch('acknowledge', p); }
  continue(p) { return this.dispatch('continue', p); }
}
export const opportunityInvocations = ENDPOINTS.map(method => ({ id: `@arcfold/dsh-method-ui#${NAMESPACE}/${method}`,
  service: SERVICE, namespace: NAMESPACE, method, invocation: { kind: 'direct' },
  parameters: [{ name: 'request', wire: 'request', source: 'json', codec: { mode: 'src-json' } }], result: { mode: 'src-json' } }));
export function installOpportunityWeb(ctx) {
  return ctx.inject(['arcfoldOpportunities', 'arcfoldPreparation', 'sessionController', 'connection', 'agents', 'agentPresets'], function opportunityWeb(owner) { new OpportunityWeb(owner); });
}
