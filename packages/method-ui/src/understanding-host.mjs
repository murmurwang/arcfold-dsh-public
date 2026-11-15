import { currentMainAgent } from './main-session.mjs';
import { browseScope } from './browse-scope.mjs';
import { TypertRemoteService, RemoteError } from '@deepseek-ai/dsh-typert-protocol';
const NAMESPACE = 'arcfoldUnderstandings', SERVICE = 'arcfoldUnderstandingWeb';
const ENDPOINTS = ['list', 'details', 'decide', 'correct'];
const reject = (code, message) => { throw new RemoteError(code, message, {}); };
function shape(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key)))
    reject('invalid_understanding_request', '理解操作包含缺失或未允许的字段。');
}
function id(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || value.includes('\0'))
    reject('invalid_understanding_request', '请求身份无效。');
}
function trusted(connection, signal, peer) {
  if (!peer || peer !== connection.browserPeer || peer.principal?.kind !== 'owner' ||
      peer.interactions !== 'answer' || peer.signal?.aborted !== false || signal?.aborted !== false)
    reject('trusted_browser_required', '此操作只接受当前已认证网页的请求。');
}
const errors = {
  invalid_browse_scope: '请选择全部积累或与当前聊天相关的内容。',
  revision_conflict: '所查看的版本已变化，请重新打开后决定。',
  understanding_session_denied: '请打开当前的 Arcfold 主交流。',
  understanding_not_found: '当前交流中无法查看这条理解。',
  source_scope_denied: '这条来源不属于所查看的理解。',
  source_unavailable: '这条来源已不可用，请刷新。',
  understanding_unavailable: '当前版本不能执行这项操作，请刷新。',
  understanding_identity_conflict: '这个提交编号对应另一份内容，未重复发送。',
  understanding_command_changed: '这项操作已经变化，请刷新查看记录。',
};
// Only coalesce simultaneous invocations. The durable service owns replay rules.
export function createUnderstandingHandler({ understandings, agents, agentPresets, connection, prompt, inflight = new Map() }) {
  const main = (sessionId, expected) => {
    const agent = currentMainAgent({ agents, agentPresets }, sessionId);
    if (!agent || expected && agent !== expected)
      reject('understanding_session_denied', errors.understanding_session_denied);
    return agent;
  };
  return async (endpoint, payload, signal, peer) => {
    try {
      trusted(connection, signal, peer);
      if (!understandings) reject('understanding_unavailable', '当前部署尚未接通理解管理。');
      if (endpoint === 'list') {
        shape(payload, ['sessionId', 'offset', 'limit', 'viewScope'], ['sessionId']); id(payload.sessionId); browseScope(payload.viewScope);
        if (payload.viewScope === undefined) main(payload.sessionId);
        if (payload.offset !== undefined && (!Number.isSafeInteger(payload.offset) || payload.offset < 0) ||
            payload.limit !== undefined && (!Number.isSafeInteger(payload.limit) || payload.limit < 1 || payload.limit > 100))
          reject('invalid_understanding_request', '分页范围无效。');
        return { ...understandings.list(payload), canCorrect: currentMainAgent({ agents, agentPresets }, payload.sessionId) !== null };
      }
      if (endpoint === 'details') {
        shape(payload, ['sessionId', 'understandingId', 'viewScope'], ['sessionId', 'understandingId']); id(payload.sessionId); id(payload.understandingId); browseScope(payload.viewScope);
        if (payload.viewScope === undefined) main(payload.sessionId);
        const detail = understandings.details(payload);
        return currentMainAgent({ agents, agentPresets }, payload.sessionId) ? detail : { ...detail,
          controls: { ...detail.controls, stopAllowed: false, correctionAllowed: false, sourceControlAllowed: false } };
      }
      const common = ['sessionId', 'understandingId', 'expectedRevision', 'requestId'];
      if (endpoint === 'correct') shape(payload, [...common, 'text']);
      else if (endpoint === 'decide') shape(payload, [...common, 'action', 'sourceRef'], [...common, 'action']);
      else reject('understanding_endpoint_not_found', '不存在的理解操作。');
      for (const name of ['sessionId', 'understandingId', 'requestId']) id(payload[name]);
      const agent = main(payload.sessionId);
      if (!Number.isSafeInteger(payload.expectedRevision) || payload.expectedRevision < 1)
        reject('invalid_understanding_request', '操作必须绑定已查看的版本。');
      const request = { ...payload, userIdentity: 'browser:' + peer.id };
      if (endpoint === 'decide') {
        if (!['stop-understanding', 'withdraw-source'].includes(payload.action)) reject('invalid_understanding_request', '理解操作无效。');
        if (payload.action === 'withdraw-source') {
          shape(payload.sourceRef, ['id', 'revision', 'expectedControlRevision']); id(payload.sourceRef.id);
          const { revision, expectedControlRevision } = payload.sourceRef;
          if (!Number.isSafeInteger(revision) || revision < 1 || expectedControlRevision !== null &&
              (!Number.isSafeInteger(expectedControlRevision) || expectedControlRevision < 1)) reject('invalid_understanding_request', '来源版本无效。');
        } else if (Object.hasOwn(payload, 'sourceRef')) reject('invalid_understanding_request', '停止理解不接受来源参数。');
        return understandings.decide(request);
      }
      if (typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 16000 || payload.text.includes('\0'))
        reject('invalid_correction_text', '请填写不超过 16000 字符的完整替换内容。');
      const bound = understandings.bindCorrection(request), key = bound.command.id;
      if (inflight.has(key)) return await inflight.get(key);
      if (!bound.created) return bound;
      const pending = Promise.resolve().then(async () => {
        let entered = false, state;
        try {
          trusted(connection, signal, peer); main(payload.sessionId, agent); entered = true;
          const result = await prompt({ sessionId: payload.sessionId, requestId: payload.requestId,
            mode: 'steer', content: [{ type: 'text', text: payload.text }] }, signal);
          state = result?.accepted === true ? 'accepted' : 'unknown';
        } catch { state = entered ? 'unknown' : 'failed'; }
        const command = understandings.recordCorrectionAdmission({ commandId: key, state });
        return { ...bound, command };
      });
      inflight.set(key, pending);
      try { return await pending; } finally { if (inflight.get(key) === pending) inflight.delete(key); }
    } catch (error) {
      if (error instanceof RemoteError) throw error;
      const code = Object.hasOwn(errors, error?.code) ? error.code : 'understanding_request_failed';
      throw new RemoteError(code, errors[code] ?? '操作未确认，请刷新查看原始记录。未自动重试。', {});
    }
  };
}
class UnderstandingWeb extends TypertRemoteService {
  inflight = new Map();
  constructor(ctx) { super(ctx, SERVICE, { namespace: NAMESPACE }); }
  dispatch(method, request) {
    const { signal, peer } = this.ctx.invocation ?? {}, controller = this.ctx.sessionController;
    return createUnderstandingHandler({ understandings: this.ctx.arcfoldUnderstandings, agents: this.ctx.agents, agentPresets: this.ctx.agentPresets,
      connection: this.ctx.connection, inflight: this.inflight,
      prompt: (input, abort) => controller.prompt(input, abort) })(method, request, signal, peer);
  }
  list(value) { return this.dispatch('list', value); }
  details(value) { return this.dispatch('details', value); }
  decide(value) { return this.dispatch('decide', value); }
  correct(value) { return this.dispatch('correct', value); }
}
export const understandingInvocations = ENDPOINTS.map(method => ({
  id: `@arcfold/dsh-method-ui#${NAMESPACE}/${method}`, service: SERVICE, namespace: NAMESPACE, method,
  invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json', codec: { mode: 'src-json' } }], result: { mode: 'src-json' },
}));
export function installUnderstandingWeb(ctx) {
  return ctx.inject(['arcfoldUnderstandings', 'agents', 'agentPresets', 'sessionController', 'connection'], owner => { new UnderstandingWeb(owner); });
}
