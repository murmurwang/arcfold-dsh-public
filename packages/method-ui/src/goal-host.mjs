import { currentMainAgent } from './main-session.mjs';
import { browseScope } from './browse-scope.mjs';
import { TypertRemoteService, RemoteError } from '@deepseek-ai/dsh-typert-protocol';

const NAMESPACE = 'arcfoldGoals', SERVICE = 'arcfoldGoalWeb';
const ENDPOINTS = ['list', 'details', 'decide', 'discuss', 'stopWork', 'resumeWork'];
const invalid = message => { throw Object.assign(new Error(message), { code: 'invalid_goal_request' }); };
function object(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key)))
    invalid('目标请求包含缺失或未允许的字段。');
}
function identity(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || value.includes('\0'))
    invalid('请求身份不能为空或超长。');
}
function version(payload) {
  if (!Number.isSafeInteger(payload.expectedRevision) || payload.expectedRevision < 1 ||
      !Number.isSafeInteger(payload.definitionVersion) || payload.definitionVersion < 1)
    invalid('操作必须绑定已查看的目标版本。');
}
function trusted(connection, signal, peer) {
  if (!peer || peer !== connection.browserPeer || peer.principal?.kind !== 'owner' ||
      peer.interactions !== 'answer' || peer.signal?.aborted !== false || signal?.aborted !== false)
    throw Object.assign(new Error('此操作只接受当前已认证网页的请求。'), { code: 'trusted_browser_required' });
}

// The map coalesces only concurrent delivery of the same explicit submission.
// Durable binding ownership, including unknown admission, belongs to GoalService.
export function createGoalHandler({ goals, connection, agents, agentPresets, prompt, inflight = new Map() }) {
  const assertMain = (sessionId, expected) => {
    const agent = currentMainAgent({ agents, agentPresets }, sessionId);
    if (!agent || expected && agent !== expected)
      throw Object.assign(new Error('请打开当前的 Arcfold 主交流，再从这里发送目标讨论。'), { code: 'goal_main_session_required' });
    return agent;
  };
  return async (endpoint, payload, signal, peer) => {
    try {
      trusted(connection, signal, peer);
      let value;
      if (endpoint === 'list') {
        object(payload, ['sessionId', 'offset', 'limit', 'viewScope'], ['sessionId']); identity(payload.sessionId); browseScope(payload.viewScope);
        if (payload.offset !== undefined && (!Number.isSafeInteger(payload.offset) || payload.offset < 0) ||
            payload.limit !== undefined && (!Number.isSafeInteger(payload.limit) || payload.limit < 1 || payload.limit > 100))
          invalid('目标分页参数不合法。');
        value = { ...goals.list(payload), canDiscuss: currentMainAgent({ agents, agentPresets }, payload.sessionId) !== null };
      } else if (endpoint === 'details') {
        object(payload, ['sessionId', 'goalId', 'viewScope'], ['sessionId', 'goalId']); identity(payload.sessionId); identity(payload.goalId); browseScope(payload.viewScope);
        value = goals.details(payload.goalId, { sessionId: payload.sessionId,
          ...(payload.viewScope !== undefined ? { viewScope: payload.viewScope } : {}) });
      } else if (endpoint === 'stopWork' || endpoint === 'resumeWork') {
        object(payload, ['sessionId', 'workId', 'nativeGoalId', 'nativeRevision', 'requestId']);
        for (const key of ['sessionId', 'workId', 'nativeGoalId', 'requestId']) identity(payload[key]);
        if (!Number.isSafeInteger(payload.nativeRevision) || payload.nativeRevision < 1) invalid('执行版本不合法。');
        const agent = assertMain(payload.sessionId);
        value = goals.controlWork({ ...payload, agent, action: endpoint === 'stopWork' ? 'pause' : 'resume',
          userIdentity: 'browser:' + peer.id });
      } else if (endpoint === 'decide') {
        object(payload, ['goalId', 'expectedRevision', 'definitionVersion', 'action', 'requestId', 'sessionId'],
          ['goalId', 'expectedRevision', 'definitionVersion', 'action', 'requestId']);
        if (payload.sessionId) assertMain(payload.sessionId);
        identity(payload.goalId); identity(payload.requestId); version(payload);
        if (!['pause', 'resume', 'close'].includes(payload.action)) invalid('目标决定必须是暂停、恢复或结束追踪。');
        value = goals.decide({ ...payload, userIdentity: 'browser:' + peer.id });
      } else if (endpoint === 'discuss') {
        object(payload, ['sessionId', 'goalId', 'expectedRevision', 'definitionVersion', 'mode', 'text', 'requestId']);
        identity(payload.sessionId); identity(payload.goalId); identity(payload.requestId); version(payload);
        if (!['discuss', 'repair'].includes(payload.mode) || typeof payload.text !== 'string' ||
            !payload.text.trim() || payload.text.length > 24000 || payload.text.includes('\0'))
          invalid('请填写本次要发送的原话，长度不超过 24000 字。');
        const agent = assertMain(payload.sessionId);
        const content = [{ type: 'text', text: payload.text }];
        const { text: _text, ...request } = payload;
        const bound = goals.bindDiscussion({ ...request, content, userIdentity: 'browser:' + peer.id });
        const key = bound.binding.id;
        // A repeated request is validated by business before joining the in-flight call.
        if (inflight.has(key)) value = inflight.get(key);
        else if (!bound.created) value = bound; // No retry of failed, unknown or crash-interrupted admission.
        else {
          let enteredPrompt = false;
          const pending = Promise.resolve().then(async () => {
            let state;
            try {
              trusted(connection, signal, peer);
              assertMain(payload.sessionId, agent);
              enteredPrompt = true;
              const result = await prompt({ sessionId: payload.sessionId, requestId: payload.requestId,
                mode: 'queue', content }, signal);
              state = result?.accepted === true ? 'accepted' : 'unknown';
            } catch { state = enteredPrompt ? 'unknown' : 'failed'; }
            const binding = goals.recordDiscussionAdmission({ bindingId: key, state });
            return { ...bound, binding };
          });
          inflight.set(key, pending);
          // Do not start another call if the caller disconnects or recording fails.
          value = pending.finally(() => { if (inflight.get(key) === pending) inflight.delete(key); });
        }
      } else throw Object.assign(new Error('不存在的目标操作。'), { code: 'goal_endpoint_not_found' });
      return { ok: true, value: await value };
    } catch (error) {
      return { ok: false, error: { code: typeof error?.code === 'string' ? error.code : 'goal_request_failed',
        message: error instanceof Error ? error.message : '目标操作未完成。', details: {} } };
    }
  };
}

class GoalWeb extends TypertRemoteService {
  inflight = new Map();
  constructor(ctx) { super(ctx, SERVICE, { namespace: NAMESPACE }); }
  async dispatch(endpoint, request) {
    const invocation = this.ctx.invocation;
    // Access through this call-derived Context preserves the original Gateway invocation.
    const controller = this.ctx.sessionController;
    const result = await createGoalHandler({ goals: this.ctx.arcfoldGoals, connection: this.ctx.connection, agents: this.ctx.agents, agentPresets: this.ctx.agentPresets,
      inflight: this.inflight, prompt: (payload, signal) => controller.prompt(payload, signal) })(
      endpoint, request, invocation?.signal, invocation?.peer);
    if (!result.ok) throw new RemoteError(result.error.code, result.error.message, result.error.details);
    return result.value;
  }
  list(request) { return this.dispatch('list', request); }
  details(request) { return this.dispatch('details', request); }
  decide(request) { return this.dispatch('decide', request); }
  discuss(request) { return this.dispatch('discuss', request); }
  stopWork(request) { return this.dispatch('stopWork', request); }
  resumeWork(request) { return this.dispatch('resumeWork', request); }
}

export const goalInvocations = ENDPOINTS.map(method => ({ id: `@arcfold/dsh-method-ui#${NAMESPACE}/${method}`,
  service: SERVICE, namespace: NAMESPACE, method, invocation: { kind: 'direct' },
  parameters: [{ name: 'request', wire: 'request', source: 'json', codec: { mode: 'src-json' } }], result: { mode: 'src-json' } }));
export function installGoalWeb(ctx) {
  return ctx.inject(['arcfoldGoals', 'sessionController', 'agents', 'agentPresets', 'connection'], function goalWeb(owner) { new GoalWeb(owner); });
}
