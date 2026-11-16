import { canonicalJson, digest, fail, jsonClone } from './contracts.mjs';
import { ROLE_LIMITS } from './jobs.mjs';

export const NATIVE_MODEL_SCOPE = 'dsh-native';
export const nativeModel = config => config?.budgetScope === NATIVE_MODEL_SCOPE;
export function nativeAgentOptions(config) {
  return { provider: config.provider, model: config.model,
    ...(config.reasoningEffort == null ? {} : { reasoningEffort: config.reasoningEffort }),
    ...(config.maxTokens == null ? {} : { maxTokens: config.maxTokens }) };
}

/** Keep DSH's persisted selection and next-choice projection. Only the running
 * Arcfold turn reads its original choice; select() still records the next one. */
export function bindNativeTurnSelection(agent) {
  const original = agent.model;
  let turn, frozen;
  const bound = Object.create(original);
  bound.current = () => {
    const events = agent.session.snapshotEvents();
    const start = events.findLast(event => event.type === 'turn/start');
    const end = events.findLast(event => event.type === 'turn/end');
    if (!start || end && end.seq > start.seq) { turn = undefined; frozen = undefined; return original.current(); }
    if (turn !== start.seq) { turn = start.seq; frozen = original.current(); }
    return frozen && { ...frozen };
  };
  bound.select = selection => original.select(selection);
  agent.model = bound;
  return () => { if (agent.model === bound) agent.model = original; };
}

/** Resolve through the host's actual adapter. Absent effort/output controls stay
 * absent rather than inventing a provider-specific 'off' value or version. */
export async function captureNativeSelection(host, agent, selection, signal) {
  if (!selection?.provider || !selection?.model) fail('MODEL_SELECTION_REQUIRED', '请先在聊天输入框选择模型。');
  const header = agent?.session.requestHeader?.();
  const maxTokens = header ? header.adapterDefaults?.maxTokens === true ? undefined : header.config?.maxTokens : agent?.options.maxTokens;
  const request = { provider: selection.provider, model: selection.model,
    ...(selection.reasoningEffort == null ? {} : { reasoningEffort: selection.reasoningEffort }),
    ...(maxTokens == null ? {} : { maxTokens }) };
  const prepared = await host.llm.prepareCall(request, signal);
  signal?.throwIfAborted();
  // This handle is capability resolution only. The native Agent prepares its
  // own one-shot call; the request guard verifies that its effective controls
  // still match this snapshot before allowing any adapter stream.
  return { provider: prepared.config.provider, model: prepared.config.model,
    reasoningEffort: prepared.config.reasoningEffort ?? null, maxTokens: prepared.config.maxTokens ?? null,
    contextWindow: prepared.context?.contextWindow ?? null };
}

export function nativeModelConfig(role, selection, cwd, stage = 'desktop') {
  if (!selection?.provider || !selection?.model) fail('MODEL_SOURCE_MISSING', '此任务缺少来源聊天的模型选择，未发起调用。');
  const maxTokens = role === 'main' ? selection.maxTokens ?? null : Math.min(ROLE_LIMITS[role], selection.maxTokens ?? ROLE_LIMITS[role]);
  return { provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort ?? null, maxTokens,
    preset: role === 'script_writer' ? 'arcfold-tree-writer' : 'arcfold-tree-reader', cwd,
    modelVersion: 'unreported', priceVersion: 'unknown', budgetScope: NATIVE_MODEL_SCOPE, stage,
    contextWindow: selection.contextWindow ?? null };
}

/** The host's own heuristic, labelled as an estimate. It is never used as an
 * invoice or as a replacement for exact experimental-budget token counts. */
export class NativeInputEstimate {
  constructor(host) { this.host = host; }
  request(options) { return jsonClone({ ...nativeAgentOptions(options), messages: options.messages, tools: options.tools ?? [], toolHistory: options.toolHistory ?? null }); }
  async prepare(options) {
    const request = this.request(options), meter = this.host.get?.('tokenMeter') ?? this.host.tokenMeter;
    if (!meter?.estimateMessage) fail('TOKEN_METER_REQUIRED', 'DSH 输入长度估算服务尚未就绪。');
    const tokens = request.messages.reduce((sum, message) => sum + meter.estimateMessage(message), 0)
      + Math.ceil(canonicalJson({ tools: request.tools, toolHistory: request.toolHistory }).length / 4);
    return { kind: 'estimated', tokens, inputHash: digest(request), tokenizerIdentity: 'dsh-token-meter/0.2.2-rc.1-heuristic' };
  }
}
