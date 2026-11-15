import { OPENAI_MODELS, OPENAI_REASONING_EFFORTS as efforts } from './openai-models.mjs';
import { MeteredTransport, fail, object, positive, text, keys, hash } from './metered-transport.mjs';
import { ResponsesReceipt } from './openai-receipt.mjs';
export const OPENAI_EVIDENCE_VERSION = 'arcfold-responses-transport-v1';
const OFFICIAL = 'https://api.openai.com/v1/responses';
const imageTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
function nativeImage(block) {
  // Validate the native durable reference, not a browser-supplied path or URL.
  // DSH's attachment store remains responsible for verifying the stored bytes.
  keys(block, ['type', 'attachment', 'offloaded']);
  keys(block.attachment, ['attachmentId', 'mediaType', 'bytes', 'width', 'height', 'name', 'originalDimensions']);
  const ref = block.attachment;
  if (!text(ref.attachmentId) || !/^sha256:[a-f0-9]{64}$/.test(ref.attachmentId) ||
      !imageTypes.includes(ref.mediaType) || !positive(ref.bytes) || !positive(ref.width) || !positive(ref.height) ||
      ref.name !== undefined && !text(ref.name) || block.offloaded !== undefined && block.offloaded !== true)
    throw fail('unsupported_model_content', 'A valid native image attachment reference is required.');
  if (ref.originalDimensions !== undefined) {
    keys(ref.originalDimensions, ['width', 'height']);
    if (!positive(ref.originalDimensions.width) || !positive(ref.originalDimensions.height))
      throw fail('unsupported_model_content', 'Original image dimensions must be positive integers.');
  }
}
function wireImage(block) {
  keys(block, ['type', 'image_url', 'detail']);
  const prefix = text(block.image_url) && /^data:(image\/(?:png|jpeg|webp|gif));base64,/.exec(block.image_url);
  const data = prefix && block.image_url.slice(prefix[0].length);
  if (block.detail !== 'auto' || !data || Buffer.from(data, 'base64').toString('base64') !== data)
    throw fail('unsupported_model_content', 'Only embedded native image bytes with automatic detail are supported.');
}
function functions(tools) {
  if (!Array.isArray(tools)) throw fail('unsupported_model_content', 'Client functions must be an array.');
  for (const tool of tools) {
    keys(tool, ['type', 'name', 'description', 'parameters', 'strict', 'defer_loading']);
    if (tool.type !== 'function' || !text(tool.name) || !object(tool.parameters) ||
        tool.description !== undefined && !text(tool.description) ||
        tool.strict !== undefined && typeof tool.strict !== 'boolean' ||
        tool.defer_loading !== undefined && typeof tool.defer_loading !== 'boolean')
      throw fail('unsupported_model_content', 'Only client JSON functions are supported.');
  }
}
function content(blocks, types) {
  if (!Array.isArray(blocks)) throw fail('unsupported_model_content', 'A content array is required.');
  for (const block of blocks) {
    if (block?.type === 'input_image' && types.includes('input_image')) { wireImage(block); continue; }
    keys(block, ['type', 'text', 'annotations']);
    if (!types.includes(block.type) || !text(block.text) ||
        block.annotations !== undefined && (!Array.isArray(block.annotations) || block.annotations.length))
      throw fail('unsupported_model_content', 'Only text content is supported.');
  }
}
function inputItems(items) {
  if (!Array.isArray(items) || !items.length) throw fail('unsupported_model_content', 'Responses input is required.');
  for (const item of items) {
    if (item.type === 'additional_tools') {
      // The pinned native translator records local tool changes in transcript
      // order. Accept its exact declaration shape; never re-encode the history.
      keys(item, ['type', 'role', 'tools']);
      if (item.role !== 'developer') throw fail('unsupported_model_content', 'Local tool declarations require the developer role.');
      functions(item.tools);
    } else if (item.type === 'configuration_update') {
      keys(item, ['type', 'reasoning']); keys(item.reasoning, ['effort']);
      if (!efforts.includes(item.reasoning.effort)) throw fail('unsupported_model_content', 'Invalid historical reasoning configuration.');
    } else if (item.type === 'reasoning') {
      keys(item, ['type', 'id', 'summary', 'encrypted_content', 'content', 'status']);
      if (!text(item.id) || item.encrypted_content !== undefined && !text(item.encrypted_content) ||
          !Array.isArray(item.summary)) throw fail('unsupported_model_content', 'Invalid reasoning history.');
      content(item.summary, ['summary_text']);
      if (item.content !== undefined) content(item.content, ['reasoning_text']);
      if (item.status !== undefined && !['completed','incomplete','in_progress'].includes(item.status))
        throw fail('unsupported_model_content', 'Invalid reasoning status.');
    } else if (item.type === 'function_call') {
      keys(item, ['type', 'id', 'call_id', 'name', 'arguments', 'status', 'namespace']);
      if (!text(item.call_id) || !text(item.name) || !text(item.arguments) ||
          item.id !== undefined && !text(item.id) || item.namespace !== undefined && !text(item.namespace))
        throw fail('unsupported_model_content', 'Invalid client function history.');
    } else if (item.type === 'function_call_output') {
      keys(item, ['type', 'call_id', 'output']);
      if (!text(item.call_id)) throw fail('unsupported_model_content', 'Invalid client result.');
      if (!text(item.output)) content(item.output, ['input_text', 'input_image']);
    } else if (item.type === 'tool_search_call' || item.type === 'tool_search_output') {
      // Pinned pi-ai represents local incremental tool discovery with these
      // completed client items. Remote/server tool execution is not accepted.
      const output = item.type === 'tool_search_output';
      keys(item, ['type', 'call_id', 'execution', 'status', output ? 'tools' : 'arguments']);
      if (item.execution !== 'client' || item.status !== 'completed' || !text(item.call_id))
        throw fail('unsupported_model_content', 'Only completed local tool discovery history is supported.');
      if (output) functions(item.tools);
      else { keys(item.arguments, ['query', 'limit']);
        if (!text(item.arguments.query) || !positive(item.arguments.limit)) throw fail('unsupported_model_content', 'Invalid local tool history.'); }
    } else {
      keys(item, ['type', 'role', 'content', 'id', 'status', 'phase']);
      if (item.type !== undefined && item.type !== 'message' ||
          !['system','developer','user','assistant'].includes(item.role))
        throw fail('unsupported_model_content', 'Only native messages and local function history are supported.');
      if (typeof item.content !== 'string') content(item.content,
        item.role === 'assistant' ? ['output_text'] : item.role === 'user' ? ['input_text', 'input_image'] : ['input_text']);
    }
  }
}
const protocol = Object.freeze({
  version: OPENAI_EVIDENCE_VERSION, endpoint: OFFICIAL,
  validateNativeImage: nativeImage,
  validateEndpoint(endpoint, allowLocalTestEndpoint) {
    const target = new URL(endpoint);
    const local = allowLocalTestEndpoint === true && target.protocol === 'http:' &&
      target.hostname === '127.0.0.1' && target.port && target.pathname === '/v1/responses';
    if (endpoint !== OFFICIAL && !local || target.username || target.password || target.search || target.hash)
      throw fail('invalid_transport_configuration', 'Only the fixed official Responses endpoint is supported.');
  },
  validatePolicies(policies) {
    if (!Object.keys(policies).length || Object.keys(policies).some(model => !OPENAI_MODELS.includes(model)))
      throw fail('invalid_transport_configuration', 'The supported OpenAI model must be explicit.');
    for (const p of Object.values(policies)) {
      if (!object(p) || !positive(p.contextWindow) || !positive(p.maxOutputTokens) ||
          p.maxOutputTokens < 16 || !Array.isArray(p.reasoningEfforts) || !p.reasoningEfforts.length ||
          p.reasoningEfforts.some(e => !efforts.includes(e)) ||
          p.requestMaxTokens !== undefined && (!positive(p.requestMaxTokens) || p.requestMaxTokens < 16 || p.requestMaxTokens > p.maxOutputTokens))
        throw fail('invalid_transport_configuration', 'Explicit OpenAI token and reasoning bounds are required.');
    }
  },
  createReceipt: () => new ResponsesReceipt(),
  reservationSpec: fixed => ({ maxOutputTokens: fixed.maxTokens, inputTokenCeiling: fixed.policy.contextWindow }),
});
export class OpenAITransport extends MeteredTransport {
  constructor(options = {}) { super({ ...options, protocol }); }
  validateInput(options) {
    super.validateInput(options);
    if (options.maxTokens < 16) throw fail('unfrozen_model_configuration', 'Responses requires at least 16 output tokens.');
    return true;
  }
  createTransport(options) {
    const local = super.createTransport(options);
    return Object.freeze({ fetch: (url, init) => local.send(url, init) });
  }
  validateWire(fixed, url, init) {
    if (url !== this.endpoint || init?.method !== 'POST' ||
        init.redirect !== undefined && init.redirect !== 'error' || typeof init.body !== 'string')
      throw fail('invalid_wire_request', 'Only the frozen Responses POST is permitted.');
    if (Buffer.byteLength(init.body) > this.maxRequestBytes) throw fail('request_too_large', 'Request evidence capacity exceeded.');
    let body;
    try { body = JSON.parse(init.body); } catch { throw fail('invalid_wire_request', 'Responses body must be JSON.'); }
    keys(body, ['model', 'input', 'stream', 'store', 'max_output_tokens', 'reasoning', 'include',
      'tools', 'prompt_cache_key']);
    if (body.model !== fixed.model || body.stream !== true || body.store !== false ||
        body.max_output_tokens !== fixed.maxTokens)
      throw fail('wire_configuration_changed', 'Serialized route and token bounds changed.');
    keys(body.reasoning, ['effort','summary']);
    const last = body.input?.at(-1);
    if (body.reasoning.effort !== 'medium' || body.reasoning.summary !== 'auto' ||
        last?.type !== 'configuration_update' || last.reasoning?.effort !== fixed.reasoningEffort ||
        JSON.stringify(body.include) !== JSON.stringify(['reasoning.encrypted_content']))
      throw fail('wire_configuration_changed', 'Pinned GPT-6 reasoning configuration changed.');
    inputItems(body.input);
    if (body.tools !== undefined) functions(body.tools);
    // Fixed short retention preserves the pinned official default. Long/explicit
    // cache modes cannot be introduced by a request or ambient environment.
    if (body.prompt_cache_key !== undefined && (!text(body.prompt_cache_key) || body.prompt_cache_key.length > 64))
      throw fail('wire_configuration_changed', 'Unapproved cache configuration.');
    const headers = new Headers(init.headers);
    if (headers.has('openai-organization') || headers.has('openai-project'))
      throw fail('invalid_wire_request', 'An ambient account/project override is not authorized.');
    if (!headers.get('authorization')) throw fail('missing_provider_auth', 'Provider authentication is required.');
    if (headers.has('host') && headers.get('host') !== new URL(url).host)
      throw fail('invalid_wire_request', 'The HTTP host cannot override the fixed endpoint.');
    return { body, headers: Object.fromEntries(headers), serialized: init.body, bodyHash: hash(init.body) };
  }
}
