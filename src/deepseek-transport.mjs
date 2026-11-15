import { MeteredTransport, fail, object, positive, text, keys, hash } from './metered-transport.mjs';
import { MessagesReceipt } from './deepseek-receipt.mjs';
const OFFICIAL = 'https://api.deepseek.com/anthropic/v1/messages';
const VERSION = 'arcfold-messages-transport-v1';
function wireBlocks(blocks, nested = false) {
  if (!Array.isArray(blocks)) throw fail('unsupported_model_content', 'Messages content must be an array.');
  for (const block of blocks) {
    if (block?.type === 'text') {
      keys(block, ['type', 'text']);
      if (!text(block.text)) throw fail('unsupported_model_content', 'Text content is invalid.');
    } else if (!nested && block?.type === 'thinking') {
      keys(block, ['type', 'thinking', 'signature']);
      if (!text(block.thinking) || block.signature !== undefined && !text(block.signature))
        throw fail('unsupported_model_content', 'Thinking content is invalid.');
    } else if (!nested && block?.type === 'tool_use') {
      keys(block, ['type', 'id', 'name', 'input']);
      if (!text(block.id) || !text(block.name) || !object(block.input))
        throw fail('unsupported_model_content', 'Client tool input is invalid.');
    } else if (!nested && block?.type === 'tool_result') {
      keys(block, ['type', 'tool_use_id', 'content', 'is_error']);
      if (!text(block.tool_use_id) || block.is_error !== undefined && typeof block.is_error !== 'boolean')
        throw fail('unsupported_model_content', 'Client tool result is invalid.');
      wireBlocks(block.content, true);
    } else if (!nested && ['tool_addition', 'tool_removal'].includes(block?.type)) {
      keys(block, ['type', 'tool']); keys(block.tool, ['type', 'name']);
      if (block.tool.type !== 'tool_reference' || !text(block.tool.name))
        throw fail('unsupported_model_content', 'Client tool update is invalid.');
    } else throw fail('unsupported_model_content', 'Images, uploads and server tools are not supported.');
  }
}

const protocol = Object.freeze({
  version: VERSION, endpoint: OFFICIAL,
  validateEndpoint(endpoint, allowLocalTestEndpoint) {
    const target = new URL(endpoint);
    const local = allowLocalTestEndpoint === true && target.protocol === 'http:' &&
      target.hostname === '127.0.0.1' && target.port && target.pathname === '/anthropic/v1/messages';
    if (endpoint !== OFFICIAL && !local || target.username || target.password || target.search || target.hash)
      throw fail('invalid_transport_configuration', 'Only the fixed official Messages endpoint is supported.');
  },
  validatePolicies(modelPolicies) {
    for (const policy of Object.values(modelPolicies)) {
      if (!object(policy) || !positive(policy.contextWindow) || !positive(policy.maxOutputTokens) ||
          !object(policy.prices) || !text(policy.priceVersion) || !policy.priceVersion ||
          !Array.isArray(policy.reasoningEfforts) || !policy.reasoningEfforts.length ||
          policy.reasoningEfforts.some(effort => !['off', 'low', 'high', 'max'].includes(effort)) ||
          policy.requestMaxTokens !== undefined && (!positive(policy.requestMaxTokens) || policy.requestMaxTokens > policy.maxOutputTokens))
        throw fail('invalid_transport_configuration', 'Model accounting bounds must be explicitly frozen.');
    }
  },
  createReceipt: () => new MessagesReceipt(),
  reservationSpec: fixed => ({ maxOutputTokens: fixed.policy.maxOutputTokens,
    inputTokenCeiling: fixed.policy.contextWindow, prices: fixed.policy.prices }),
});
export class DeepSeekTransport extends MeteredTransport {
  constructor(options = {}) { super({ ...options, protocol }); }
  validateWire(fixed, url, init) {
    if (url !== this.endpoint || init?.method !== 'POST' || init.redirect !== 'error' || typeof init.body !== 'string')
      throw fail('invalid_wire_request', 'Only the frozen single Messages POST is permitted.');
    if (Buffer.byteLength(init.body) > this.maxRequestBytes) throw fail('request_too_large', 'Request evidence capacity exceeded.');
    let body;
    try { body = JSON.parse(init.body); } catch { throw fail('invalid_wire_request', 'Messages body must be JSON.'); }
    keys(body, ['model', 'stream', 'max_tokens', 'messages', 'system', 'thinking', 'output_config', 'temperature', 'stop_sequences', 'tools']);
    if (body.model !== fixed.model || body.stream !== true || body.max_tokens !== fixed.maxTokens ||
        !Array.isArray(body.messages) || !body.messages.length || body.system !== undefined && !text(body.system))
      throw fail('wire_configuration_changed', 'Serialized route and token limit differ from the frozen request.');
    keys(body.thinking, ['type']);
    if (body.thinking.type !== (fixed.reasoningEffort === 'off' ? 'disabled' : 'enabled'))
      throw fail('wire_configuration_changed', 'Serialized reasoning differs from the frozen request.');
    if (fixed.reasoningEffort === 'off') {
      if (body.output_config !== undefined) throw fail('wire_configuration_changed', 'Disabled thinking cannot add an effort.');
    } else {
      keys(body.output_config, ['effort']);
      if (body.output_config.effort !== fixed.reasoningEffort) throw fail('wire_configuration_changed', 'Serialized effort changed.');
    }
    for (const message of body.messages) {
      keys(message, ['role', 'content']);
      if (!['user', 'assistant', 'system'].includes(message.role)) throw fail('unsupported_model_content', 'Unsupported Messages role.');
      wireBlocks(message.content);
    }
    if (body.tools !== undefined) {
      if (!Array.isArray(body.tools)) throw fail('unsupported_model_content', 'Client tools must be an array.');
      for (const tool of body.tools) {
        keys(tool, ['name', 'description', 'input_schema', 'defer_loading']);
        if (!text(tool.name) || !text(tool.description) || !object(tool.input_schema) ||
            tool.defer_loading !== undefined && tool.defer_loading !== true)
          throw fail('unsupported_model_content', 'Only client tools are allowed.');
      }
    }
    const headers = new Headers(init.headers);
    if (!headers.get('authorization') && !headers.get('x-api-key')) throw fail('missing_provider_auth', 'Provider authentication is required.');
    if (headers.has('host') && headers.get('host') !== new URL(url).host)
      throw fail('invalid_wire_request', 'The HTTP host cannot override the fixed endpoint.');
    return { body, headers: Object.fromEntries(headers), serialized: init.body, bodyHash: hash(init.body) };
  }

}
