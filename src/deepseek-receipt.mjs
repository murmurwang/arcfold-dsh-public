import { createParser } from 'eventsource-parser';
import { DomainError, jsonClone } from './store.mjs';

const invalid = () => new DomainError('invalid_provider_receipt', 'The original Messages receipt is incomplete or inconsistent.', 409);
const count = value => Number.isSafeInteger(value) && value >= 0;

/** Billing only. Official DSH remains the sole translator of answer/tool content. */
export function messagesUsage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid();
  for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'])
    if (!count(raw[key])) throw invalid();
  // There is no verified tariff for cache creation in this supported route.
  if (raw.cache_creation_input_tokens !== 0) throw invalid();
  const promptTokens = raw.input_tokens + raw.cache_read_input_tokens;
  if (!count(promptTokens)) throw invalid();
  return { promptTokens, completionTokens: raw.output_tokens, cachedTokens: raw.cache_read_input_tokens };
}

export class MessagesReceipt {
  constructor() {
    this.decoder = new TextDecoder('utf-8', { fatal: true });
    this.started = false; this.stopped = false; this.finalUsage = null;
    this.stopReason = null; this.messageId = null; this.model = null;
    this.lineParts = []; this.skipLf = false;
    this.parser = createParser({
      onError: () => { throw invalid(); },
      onEvent: event => this.event(event),
    });
  }

  event(event) {
    let value;
    try { value = JSON.parse(event.data); } catch { throw invalid(); }
    if (!value || typeof value !== 'object' || typeof value.type !== 'string' ||
        event.event && event.event !== value.type || this.stopped) throw invalid();
    if (value.type === 'ping') return;
    if (value.type === 'message_start') {
      if (this.started || typeof value.message?.id !== 'string' || !value.message.id ||
          typeof value.message?.model !== 'string' || !value.message.model) throw invalid();
      this.started = true; this.messageId = value.message.id; this.model = value.message.model;
      return;
    }
    if (!this.started) throw invalid();
    if (value.type === 'message_delta') {
      if (this.stopReason !== null) throw invalid();
      if (value.delta?.stop_reason != null) {
        if (typeof value.delta.stop_reason !== 'string' || !value.delta.stop_reason) throw invalid();
        messagesUsage(value.usage);
        this.finalUsage = jsonClone(value.usage); this.stopReason = value.delta.stop_reason;
      }
      return;
    }
    if (value.type === 'message_stop') {
      if (!this.finalUsage || this.stopReason === null) throw invalid();
      this.stopped = true; return;
    }
    if (!['content_block_start', 'content_block_delta', 'content_block_stop'].includes(value.type)) throw invalid();
    if (this.stopReason !== null) throw invalid();
  }

  // Feed complete lines to the official SSE framer so its terminal callback
  // identifies the exact boundary, even when a network chunk has extra bytes.
  // After that boundary our supported protocol permits whitespace only.
  feedText(fragment) {
    if (this.stopped) {
      if (!/^[ \t\r\n]*$/.test(fragment)) throw invalid();
      return;
    }
    let start = 0;
    for (let index = 0; index < fragment.length; index++) {
      const character = fragment[index];
      if (this.skipLf) {
        this.skipLf = false;
        if (character === '\n') { start = index + 1; continue; }
      }
      if (character !== '\r' && character !== '\n') continue;
      this.lineParts.push(fragment.slice(start, index));
      const line = this.lineParts.join(''); this.lineParts = [];
      this.parser.feed(line + '\n');
      start = index + 1; this.skipLf = character === '\r';
      if (this.stopped) {
        if (!/^[ \t\r\n]*$/.test(fragment.slice(start))) throw invalid();
        return;
      }
    }
    if (start < fragment.length) this.lineParts.push(fragment.slice(start));
  }

  push(bytes) { this.feedText(this.decoder.decode(bytes, { stream: true })); }

  finish() {
    this.feedText(this.decoder.decode());
    if (!this.started || !this.stopped || !this.finalUsage) throw invalid();
    return { messageId: this.messageId, model: this.model, stopReason: this.stopReason,
      rawUsage: this.finalUsage, usage: messagesUsage(this.finalUsage) };
  }
}
