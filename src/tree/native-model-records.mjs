import { digest, fail, jsonClone } from './contracts.mjs';

const usageFields = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'];
function reportedUsage(value) {
  if (!value || !['inputTokens', 'outputTokens'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)) return null;
  const entries = usageFields.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]);
  return entries.every(([, count]) => Number.isSafeInteger(count) && count >= 0) ? Object.fromEntries(entries) : null;
}
export const nativeResponseComplete = receipt => receipt?.kind === 'dsh-native-response-v1' && receipt.status === 'response_received';

/** Record what the native stream actually reports, separately from billing.
 * No credentials, wire headers, guessed prices or network-dispatch claims. */
export class NativeModelRecords {
  constructor(repository, owner) { this.repo = repository; this.owner = owner; }
  invocation(requestId) { return this.repo.list('tree_invocations', row => row.ledgerRequestId === requestId)[0]; }
  get(requestId) { return this.invocation(requestId)?.nativeRequest ?? null; }
  write(requestId, changes) {
    const row = this.invocation(requestId);
    if (!row) fail('INVOCATION_MISSING', 'Native model request has no owning task');
    const receipt = { ...row.nativeRequest, ...changes };
    this.repo.command('recordNativeModelRequest', { requestId: digest(['native-model-request', requestId, row.revision, receipt]),
      expected: { [`tree_invocations:${row.id}`]: row.revision }, input: { invocationId: row.id, receipt } },
    { kind: 'program', id: 'native-model-records' }, () => {
      this.repo.save('tree_invocations', { ...row, nativeRequest: receipt }, row.revision); return { invocationId: row.id };
    });
    return receipt;
  }
  async *stream(options, next) {
    const { requestId } = this.owner.assertRequest(options);
    if (this.get(requestId)) fail('INVOCATION_REPLAY', 'This native request already has an attempt; do not resend');
    options.signal?.throwIfAborted();
    this.write(requestId, { kind: 'dsh-native-response-v1', requestId, status: 'started',
      provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort ?? null,
      maxTokens: options.maxTokens ?? null, startedAt: this.repo.now(), usage: null, usageStatus: 'missing',
      usageSource: 'dsh-native-adapter', adapterUsage: null, cost: null, priceStatus: 'unknown', finish: null });
    let finish = null, usage = null, adapterUsage = null, usageStatus = 'missing', exhausted = false;
    try {
      for await (const chunk of next()) {
        if (finish) fail('NATIVE_STREAM_PROTOCOL', 'Native provider returned data after its terminal result');
        if (chunk.type === 'usage') {
          adapterUsage = reportedUsage(chunk.usage);
          // Some native adapters initialize omitted provider counters to zero.
          // Keep their values for inspection, but do not turn ambiguous zero
          // input/output into a confirmed usage record or a free request.
          const complete = adapterUsage && adapterUsage.inputTokens + (adapterUsage.cacheReadTokens ?? 0) + (adapterUsage.cacheWriteTokens ?? 0) > 0 && adapterUsage.outputTokens > 0;
          usage = complete ? adapterUsage : null;
          usageStatus = complete ? 'reported' : adapterUsage ? 'unconfirmed' : 'invalid';
        }
        if (chunk.type === 'finish') finish = chunk.reason?.kind ?? 'unknown';
        yield chunk;
      }
      exhausted = true;
    } finally {
      const status = exhausted && ['stop', 'tool-calls', 'max-tokens'].includes(finish) ? 'response_received'
        : finish === 'error' ? 'failed' : finish === 'aborted' || options.signal?.aborted ? 'cancelled' : 'unknown';
      this.write(requestId, { status, finish, usage, usageStatus, adapterUsage, endedAt: this.repo.now() });
    }
  }
  recover() {
    for (const row of this.repo.list('tree_invocations', item => item.nativeRequest?.status === 'started'))
      this.write(row.ledgerRequestId, { status: 'unknown', recoveredAt: this.repo.now() });
  }
  summary() {
    const records = this.repo.list('tree_invocations', row => row.nativeRequest).map(row => row.nativeRequest);
    return { scope: 'dsh-native', requests: records.length,
      complete: records.filter(row => nativeResponseComplete(row)).length,
      unknown: records.filter(row => row.status === 'unknown' || row.status === 'started').length,
      usageMissing: records.filter(row => row.usageStatus !== 'reported').length,
      cost: null, priceStatus: 'unknown', records: records.map(row => jsonClone(row)) };
  }
}
