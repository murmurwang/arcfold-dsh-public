import { createParser } from 'eventsource-parser';
import { DomainError, jsonClone } from './store.mjs';
const invalid = () => new DomainError('invalid_provider_receipt', 'The original Responses receipt is incomplete or inconsistent.', 409);
const count = value => Number.isSafeInteger(value) && value >= 0;

/** Accounting uses original input_tokens, which already includes cache hits. */
export function responsesUsage(raw) {
  if (!raw || !count(raw.input_tokens) || !count(raw.output_tokens) ||
      !count(raw.input_tokens_details?.cached_tokens) ||
      raw.input_tokens_details.cached_tokens > raw.input_tokens ||
      raw.total_tokens !== undefined && (!count(raw.total_tokens) || raw.total_tokens !== raw.input_tokens + raw.output_tokens) ||
      raw.output_tokens_details?.reasoning_tokens !== undefined &&
        (!count(raw.output_tokens_details.reasoning_tokens) || raw.output_tokens_details.reasoning_tokens > raw.output_tokens))
    throw invalid();
  return { promptTokens: raw.input_tokens, completionTokens: raw.output_tokens,
    cachedTokens: raw.input_tokens_details.cached_tokens };
}

/** Billing only: the pinned official SDK continues to translate content/history. */
export class ResponsesReceipt {
  constructor() {
    this.decoder = new TextDecoder('utf-8', { fatal: true });
    this.started = false; this.stopped = false; this.finalUsage = null;
    this.messageId = null; this.model = null; this.stopReason = null;
    this.lineParts = []; this.skipLf = false;
    this.parser = createParser({ onError: () => { throw invalid(); }, onEvent: event => this.event(event) });
  }
  event(event) {
    let value;
    try { value = JSON.parse(event.data); } catch { throw invalid(); }
    if (!value || typeof value.type !== 'string' || event.event && event.event !== value.type || this.stopped)
      throw invalid();
    if (value.type === 'response.created') {
      if (this.started || typeof value.response?.id !== 'string' || !value.response.id ||
          typeof value.response?.model !== 'string' || !value.response.model) throw invalid();
      this.started = true; this.messageId = value.response.id; this.model = value.response.model;
      return;
    }
    if (!this.started) throw invalid();
    if (['response.completed', 'response.incomplete'].includes(value.type)) {
      const response = value.response;
      if (response?.id !== this.messageId || response.model !== this.model ||
          response.status !== (value.type === 'response.completed' ? 'completed' : 'incomplete') ||
          value.type === 'response.incomplete' && response.incomplete_details?.reason !== 'max_output_tokens' ||
          response.error != null) throw invalid();
      responsesUsage(response.usage);
      this.finalUsage = jsonClone(response.usage);
      this.stopReason = value.type === 'response.completed' ? 'completed' : 'max_output_tokens';
      this.stopped = true; return;
    }
    if (!['response.in_progress', 'response.output_item.added', 'response.output_item.done',
      'response.content_part.added', 'response.content_part.done', 'response.output_text.delta',
      'response.output_text.done', 'response.output_text.annotation.added',
      'response.reasoning_summary_part.added', 'response.reasoning_summary_part.done',
      'response.reasoning_summary_text.delta', 'response.reasoning_summary_text.done',
      'response.reasoning_text.delta', 'response.reasoning_text.done',
      'response.function_call_arguments.delta', 'response.function_call_arguments.done',
      'response.refusal.delta', 'response.refusal.done'].includes(value.type)) throw invalid();
    if (value.response && (value.response.id !== this.messageId || value.response.model !== this.model)) throw invalid();
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
      rawUsage: this.finalUsage, usage: responsesUsage(this.finalUsage) };
  }
}
