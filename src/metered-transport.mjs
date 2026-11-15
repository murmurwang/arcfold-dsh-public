import { Agent } from 'undici';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DomainError, jsonClone } from './store.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const at = () => new Date().toISOString();
const fail = (code, message) => new DomainError(code, message, 409);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const text = value => typeof value === 'string';
function required(value, label) {
  if (!text(value) || !value.trim() || value.length > 512 || value.includes('\0'))
    throw fail('invalid_transport_configuration', `${label} is required.`);
  return value;
}
function keys(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key)))
    throw fail('unsupported_model_content', 'An unsupported request field was rejected before sending.');
}
function toolSchemas(tools) {
  if (tools === undefined) return;
  if (!Array.isArray(tools)) throw fail('unsupported_model_content', 'Client tool declarations must be an array.');
  for (const tool of tools) {
    keys(tool, ['name', 'description', 'parameters', 'deferLoading']);
    if (!text(tool.name) || !tool.name || !text(tool.description) || !object(tool.parameters) ||
        tool.deferLoading !== undefined && tool.deferLoading !== true)
      throw fail('unsupported_model_content', 'Only text client tools are supported.');
    jsonClone(tool.parameters);
  }
}
async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
  const directory = await open(resolve(path, '..'), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
async function optionalJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function errorCode(error) {
  if (error?.code === 'ARCFOLD_CONTEXT_CHANGED') return 'arcfold_context_changed';
  if (error?.code === 'ARCFOLD_METHOD_CONTEXT_CHANGED') return 'arcfold_method_context_changed';
  if (error?.code === 'ARCFOLD_GOAL_CONTEXT_CHANGED') return 'arcfold_goal_context_changed';
  if (error instanceof DomainError && /^[a-z][a-z0-9_]{0,70}$/.test(error.code)) return error.code;
  return ['AbortError', 'TimeoutError'].includes(error?.name) ? 'request_interrupted' : 'transport_error';
}
function assertReceiptModel(receipt, model) {
  // Aliases require a separately frozen pricing contract; none are implicit.
  if (receipt.model !== model)
    throw fail('provider_model_mismatch', 'The provider receipt model differs from the frozen request.');
}
function freezeJson(value) {
  const copy = jsonClone(value);
  const freeze = item => {
    if (item && typeof item === 'object') { for (const child of Object.values(item)) freeze(child); Object.freeze(item); }
    return item;
  };
  return freeze(copy);
}


export { fail, object, positive, text, keys, hash };

/** One lifecycle for all paid protocol boundaries. */
export class MeteredTransport {
  constructor({ ledger, artifactDirectory, provider, modelPolicies, requestIdentity, beforeDispatch = () => {},
    protocol, endpoint = protocol.endpoint, allowLocalTestEndpoint = false, dispatcher, ownsDispatcher = dispatcher === undefined, lifecycle,
    timeoutMs = 20 * 60 * 1000, maxRequestBytes = 16 * 1024 * 1024,
    maxResponseBytes = 32 * 1024 * 1024 } = {}) {
    if (!ledger || !artifactDirectory || typeof requestIdentity !== 'function' || typeof beforeDispatch !== 'function' || !object(modelPolicies))
      throw fail('invalid_transport_configuration', 'Ledger, evidence, model policies and native identity are required.');
    required(provider, 'Provider');
    const target = new URL(endpoint);
    protocol.validateEndpoint(endpoint, allowLocalTestEndpoint);
    for (const value of [timeoutMs, maxRequestBytes, maxResponseBytes])
      if (!positive(value)) throw fail('invalid_transport_configuration', 'Transport bounds must be positive integers.');
    this.modelPolicies = jsonClone(modelPolicies);
    protocol.validatePolicies(this.modelPolicies);
    this.ledger = ledger; this.artifactDirectory = resolve(artifactDirectory); this.provider = provider;
    this.requestIdentity = requestIdentity; this.endpoint = target.href; this.timeoutMs = timeoutMs;
    this.beforeDispatch = beforeDispatch;
    this.maxRequestBytes = maxRequestBytes; this.maxResponseBytes = maxResponseBytes;
    this.dispatcher = dispatcher ?? new Agent(); this.ownsDispatcher = ownsDispatcher;
    this.protocol = protocol;
    this.lifecycle = lifecycle ?? { stopping: new AbortController(), inflight: new Map(), evidenceVersions: new Set([protocol.version]) };
    this.stopping = this.lifecycle.stopping; this.inflight = this.lifecycle.inflight; this.closing = null;
  }

  validateInput(options) {
    if (this.stopping.signal.aborted) throw fail('provider_closed', 'The paid transport is closed.');
    if (!object(options) || options.provider !== this.provider || !Object.hasOwn(this.modelPolicies, options.model))
      throw fail('unregistered_model_route', 'This route has no authorized accounting policy.');
    const policy = this.modelPolicies[options.model];
    if (!policy.reasoningEfforts.includes(options.reasoningEffort) || !positive(options.maxTokens) ||
        options.maxTokens > (policy.requestMaxTokens ?? policy.maxOutputTokens))
      throw fail('unfrozen_model_configuration', 'Reasoning effort and output limit must match the explicit model policy.');
    if (!Array.isArray(options.messages) || !options.messages.length ||
        options.system !== undefined && !text(options.system))
      throw fail('unsupported_model_content', 'Native conversation input is required.');
    for (const message of options.messages) {
      if (!object(message) || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role) || !Array.isArray(message.content))
        throw fail('unsupported_model_content', 'Only native conversation messages are supported.');
      for (const block of message.content) {
        if (block?.type === 'text' || block?.type === 'reasoning' && message.role === 'assistant') {
          keys(block, ['type', 'text']);
          if (!text(block.text)) throw fail('unsupported_model_content', 'Text blocks must contain text.');
        } else if (block?.type === 'tool-call' && message.role === 'assistant') {
          keys(block, ['type', 'id', 'name', 'arguments']);
          if (!text(block.id) || !text(block.name) || !text(block.arguments))
            throw fail('unsupported_model_content', 'Client tool calls must contain text arguments.');
        } else if (['tool-addition', 'tool-removal'].includes(block?.type) && message.role === 'developer') {
          keys(block, ['type', 'toolName']);
          if (!text(block.toolName)) throw fail('unsupported_model_content', 'Client tool updates require a name.');
        } else if (block?.type === 'image' && ['user', 'tool'].includes(message.role) && this.protocol.validateNativeImage) {
          this.protocol.validateNativeImage(block);
        } else throw fail('unsupported_model_content', 'This content is not supported by the selected model route.');
      }
    }
    toolSchemas(options.tools);
    if (options.toolHistory !== undefined) {
      keys(options.toolHistory, ['tools', 'updates']); toolSchemas(options.toolHistory.tools);
      if (!Array.isArray(options.toolHistory.updates)) throw fail('unsupported_model_content', 'Tool history is invalid.');
      for (const update of options.toolHistory.updates) toolSchemas(update.additions);
    }
    return true;
  }

  persistJson(path, value) { return atomicJson(path, value); }

  createTransport(options) {
    this.validateInput(options);
    // Native messages must not change while the official adapter awaits auth or
    // while evidence is persisted. AbortSignal keeps its live cancellation state.
    const nativeOptions = Object.freeze({ ...options, messages: freezeJson(options.messages),
      ...(options.tools === undefined ? {} : { tools: freezeJson(options.tools) }),
      ...(options.toolHistory === undefined ? {} : { toolHistory: freezeJson(options.toolHistory) }), signal: options.signal });
    const identity = jsonClone(this.requestIdentity(nativeOptions));
    if (!object(identity)) throw fail('missing_native_request_identity', 'Native request identity is required.');
    required(identity.requestId, 'Native request identity');
    if (!object(identity.metadata ?? {})) throw fail('missing_native_request_identity', 'Native request metadata is required.');
    const fixed = { provider: options.provider, model: options.model, maxTokens: options.maxTokens,
      reasoningEffort: options.reasoningEffort, policy: jsonClone(this.modelPolicies[options.model]), identity,
      inputSignal: options.signal, nativeOptions, ownerId: randomUUID() };
    let used = false;
    return { send: (url, init) => {
      if (used) return Promise.reject(fail('request_already_dispatched', 'One native step may send at most once.'));
      used = true;
      return this.send(fixed, url, init);
    } };
  }

  async send(fixed, url, init) {
    if (this.stopping.signal.aborted) throw fail('provider_closed', 'The paid transport is closed.');
    const wire = this.validateWire(fixed, url, init);
    const requestId = fixed.identity.requestId, key = hash(requestId);
    const cancellation = new AbortController();
    const signal = AbortSignal.any([this.stopping.signal, cancellation.signal, AbortSignal.timeout(this.timeoutMs),
      ...[fixed.inputSignal, init.signal].filter(Boolean)]);
    signal.throwIfAborted();
    let resolveDone;
    const done = new Promise(resolve => { resolveDone = resolve; });
    const state = { requestId, bodyHash: wire.bodyHash, ownerId: fixed.ownerId, key,
      directory: join(this.artifactDirectory, key), done, resolveDone, bytes: 0, chunks: 0,
      responseHash: createHash('sha256'), dispatched: false, ownsReservation: false, settled: false,
      finished: false, closing: null, signal, cancellation, pendingRead: null };
    this.inflight.set(state.ownerId, state);
    try {
      await mkdir(this.artifactDirectory, { recursive: true, mode: 0o700 });
      try { await mkdir(state.directory, { mode: 0o700 }); }
      catch (error) {
        if (error.code === 'EEXIST') throw fail('request_already_dispatched', 'This native request already has preserved attempt evidence.');
        throw error;
      }
      state.ownsDirectory = true;
      await this.persistJson(join(state.directory, 'identity.json'), { version: this.protocol.version, requestId,
        ownerId: fixed.ownerId, scope: this.ledger.scope, bodyHash: wire.bodyHash, createdAt: at() });
      const reserved = this.ledger.reserve({ requestId, bodyHash: wire.bodyHash, model: fixed.model,
        ...this.protocol.reservationSpec(fixed), metadata: { ...(fixed.identity.metadata ?? {}),
          transport: { version: this.protocol.version, ownerId: fixed.ownerId, artifactKey: key }, ...(fixed.policy.priceVersion ? { priceVersion: fixed.policy.priceVersion } : {}) } });
      if (reserved.metadata?.transport?.ownerId !== fixed.ownerId)
        throw fail('request_already_dispatched', 'This native request already belongs to another recorded attempt.');
      state.ownsReservation = true;
      const request = { version: this.protocol.version, requestId, ownerId: fixed.ownerId, bodyHash: wire.bodyHash,
        createdAt: at(), endpoint: url, scope: this.ledger.scope, body: wire.body, serialized: wire.serialized,
        policy: fixed.policy, metadata: reserved.metadata };
      await this.persistJson(join(state.directory, 'request.json'), request);
      signal.throwIfAborted();
      const currentIdentity = jsonClone(this.requestIdentity(fixed.nativeOptions));
      if (currentIdentity.requestId !== requestId)
        throw fail('native_request_changed', 'The native request owner changed before dispatch.');
      const checked = this.beforeDispatch(fixed.nativeOptions);
      if (checked && typeof checked.then === 'function') {
        void Promise.resolve(checked).catch(() => {});
        throw fail('async_before_dispatch', 'The final dispatch check must be synchronous.');
      }
      signal.throwIfAborted();
      // No await from the final authority check through the actual network call.
      this.ledger.markDispatched(requestId); state.dispatched = true;
      const target = new URL(url);
      const response = await this.dispatcher.request({ origin: target.origin, path: target.pathname,
        method: 'POST', headers: wire.headers, body: wire.serialized, signal,
        idempotent: false, maxRedirections: 0, headersTimeout: 0, bodyTimeout: 0 });
      state.networkBody = response.body;
      // An unread Response may be cancelled before its async iterator is pulled.
      // The abort path still records unknown; prevent an unhandled Node error.
      state.networkBody.on('error', () => {});
      state.status = response.statusCode;
      const header = name => Array.isArray(response.headers[name]) ? response.headers[name].join(', ') : response.headers[name] ?? null;
      state.headers = { status: state.status, contentType: header('content-type'),
        requestId: header('x-request-id'), receivedAt: at() };
      await this.persistJson(join(state.directory, 'headers.json'), state.headers);
      state.bodyFile = await open(join(state.directory, 'response-body.bin'), 'wx', 0o600);
      state.chunkFile = await open(join(state.directory, 'response-chunks.jsonl'), 'wx', 0o600);
      state.parser = state.status >= 200 && state.status < 300 && state.headers.contentType?.includes('text/event-stream')
        ? this.protocol.createReceipt() : null;
      const iterator = response.body[Symbol.asyncIterator]();
      const consume = async chunk => {
        const bytes = Buffer.from(chunk);
        if (state.bytes + bytes.length > this.maxResponseBytes) throw fail('response_too_large', 'Response evidence capacity exceeded.');
        await state.bodyFile.writeFile(bytes); await state.bodyFile.sync();
        await state.chunkFile.writeFile(JSON.stringify({ sequence: state.chunks++, offset: state.bytes,
          bytes: bytes.length, receivedAt: at() }) + '\n'); await state.chunkFile.sync();
        state.bytes += bytes.length; state.responseHash.update(bytes); state.parser?.push(bytes);
        return bytes;
      };
      const finish = async () => {
        if (!state.parser) {
          if (state.status >= 200 && state.status < 300)
            throw fail('provider_http_error', 'The provider did not return a Messages event stream.');
          await this.persistJson(join(state.directory, 'http-receipt.json'), {
            version: this.protocol.version, requestId, ownerId: state.ownerId, bodyHash: state.bodyHash,
            status: state.status, completeAt: at(), bytes: state.bytes, chunks: state.chunks,
            responseHash: state.responseHash.digest('hex'),
          });
          this.ledger.markUnknown(requestId, 'provider_http_error');
          await this.finish(state); return;
        }
        const parsed = state.parser.finish();
        assertReceiptModel(parsed, fixed.model);
        const receipt = { version: this.protocol.version, requestId, ownerId: state.ownerId, bodyHash: state.bodyHash,
          status: state.status, completeAt: at(), bytes: state.bytes, chunks: state.chunks,
          responseHash: state.responseHash.digest('hex'), ...parsed };
        await this.persistJson(join(state.directory, 'receipt.json'), receipt);
        this.ledger.settle(requestId, parsed.usage); state.settled = true;
        await this.finish(state);
      };
      const stream = new ReadableStream({
        start: controller => { state.controller = controller; },
        pull: controller => {
          const reading = (async () => {
            try {
              signal.throwIfAborted();
              const next = await iterator.next();
              if (next.done) { await finish(); controller.close(); return; }
              const bytes = await consume(next.value);
              if (state.parser?.stopped) {
                // DSH stops consuming at message_stop. Finish evidence and billing
                // before exposing that terminal chunk, retaining any trailing bytes.
                const tail = [];
                for await (const more of { [Symbol.asyncIterator]: () => iterator }) tail.push(await consume(more));
                await finish();
                controller.enqueue(bytes);
                for (const more of tail) controller.enqueue(more);
                controller.close();
              } else controller.enqueue(bytes);
            } catch (error) {
              await this.failure(state, error);
              controller.error(fail(errorCode(error), 'The original provider receipt is incomplete.'));
            }
          })();
          state.pendingRead = reading;
          const clear = () => { if (state.pendingRead === reading) state.pendingRead = null; };
          void reading.then(clear, clear);
          return reading;
        },
        cancel: async () => {
          cancellation.abort();
          await this.interrupt(state);
        },
      }, { highWaterMark: 0 });
      state.abort = () => {
        void this.interrupt(state).catch(() => {});
      };
      signal.addEventListener('abort', state.abort, { once: true });
      if (signal.aborted) state.abort();
      if ([204, 205, 304].includes(state.status)) {
        await this.failure(state, fail('provider_http_error', 'A Messages response body is required.'));
        return new Response(null, { status: state.status });
      }
      return new Response(stream, { status: state.status, headers: response.headers });
    } catch (error) {
      await this.failure(state, error);
      throw fail(errorCode(error), 'The Messages request did not complete.');
    }
  }

  failure(state, error) {
    if (state.failing) return state.failing;
    if (state.finished) return state.closing;
    state.failing = (async () => {
      try {
        if (state.dispatched && !state.settled) this.ledger.markUnknown(state.requestId, errorCode(error));
        else if (state.ownsReservation && !state.dispatched) {
          const current = this.ledger.get(state.requestId);
          if (current?.status === 'reserved' && !current.dispatchedAt && current.metadata?.transport?.ownerId === state.ownerId)
            this.ledger.releaseUnsent(state.requestId, errorCode(error));
        }
        if (state.ownsDirectory) await this.persistJson(join(state.directory, `error-${randomUUID()}.json`), {
          version: this.protocol.version, requestId: state.requestId, bodyHash: state.bodyHash, ownerId: state.ownerId,
          at: at(), code: errorCode(error), dispatched: state.dispatched, settled: state.settled,
          persistedBytes: state.bytes, chunks: state.chunks,
        }).catch(() => {});
      } finally { await this.finish(state); }
    })();
    return state.failing;
  }

  interrupt(state) {
    if (state.interruption) return state.interruption;
    state.networkBody?.destroy();
    state.interruption = (async () => {
      if (state.pendingRead) await state.pendingRead.catch(() => {});
      if (!state.finished) await this.failure(state, fail('request_interrupted', 'The request stopped.'));
      try { state.controller?.error(fail('request_interrupted', 'The request stopped.')); } catch {}
      await state.done;
    })();
    return state.interruption;
  }

  finish(state) {
    if (state.closing) return state.closing;
    state.finished = true;
    state.closing = (async () => {
      state.signal.removeEventListener('abort', state.abort);
      state.networkBody?.destroy();
      const results = await Promise.allSettled([state.bodyFile?.close(), state.chunkFile?.close()]);
      const complete = () => { this.inflight.delete(state.ownerId); state.resolveDone(); };
      // A pull may still be unwinding after its final disk write. Do not let the
      // caller close the ledger until that operation has actually returned.
      if (state.pendingRead) void state.pendingRead.then(complete, complete);
      else complete();
      if (results.some(result => result.status === 'rejected')) throw fail('receipt_cleanup_failed', 'Receipt file cleanup failed.');
    })();
    return state.closing;
  }

  async recover({ exclusive = false } = {}) {
    if (!exclusive || this.inflight.size) throw fail('recovery_requires_exclusive_owner', 'Cold recovery requires exclusive ownership of this evidence directory.');
    const result = { settled: [], unknown: [], released: [], unchanged: [] };
    let entries;
    try { entries = await readdir(this.artifactDirectory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return result; throw error; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
      const directory = join(this.artifactDirectory, entry.name);
      const request = await optionalJson(join(directory, 'request.json'));
      const identityEvidence = await optionalJson(join(directory, 'identity.json'));
      if (request && identityEvidence && ['version','requestId','ownerId','scope','bodyHash'].some(field => request[field] !== identityEvidence[field]))
        throw fail('receipt_identity_conflict', 'Saved request and attempt identity disagree.');
      const savedIdentity = request ?? identityEvidence;
      if (savedIdentity && savedIdentity.version !== this.protocol.version) {
        if (!this.lifecycle.evidenceVersions.has(savedIdentity.version))
          throw fail('receipt_identity_conflict', 'Evidence belongs to an unregistered transport version.');
        continue;
      }
      if (!request) {
        const identity = await optionalJson(join(directory, 'identity.json'));
        if (!identity) continue;
        const record = this.ledger.get(identity.requestId);
        if (!record) continue;
        if (identity.version !== this.protocol.version || hash(identity.requestId) !== entry.name || identity.scope !== this.ledger.scope ||
            record.bodyHash !== identity.bodyHash || record.metadata?.transport?.ownerId !== identity.ownerId ||
            record.metadata.transport.version !== this.protocol.version || record.metadata.transport.artifactKey !== entry.name)
          throw fail('receipt_identity_conflict', 'Incomplete attempt evidence does not own its ledger entry.');
        this.ledger.assertScope(identity.requestId);
        if (record.status === 'reserved' && !record.dispatchedAt) {
          this.ledger.releaseUnsent(identity.requestId, 'cold_recovery_unsent'); result.released.push(identity.requestId);
        } else if (record.status === 'dispatched') {
          this.ledger.markUnknown(identity.requestId, 'cold_recovery_incomplete'); result.unknown.push(identity.requestId);
        } else result.unchanged.push(identity.requestId);
        continue;
      }
      if (request.version !== this.protocol.version || hash(request.requestId) !== entry.name || request.scope !== this.ledger.scope ||
          hash(request.serialized) !== request.bodyHash || JSON.stringify(JSON.parse(request.serialized)) !== JSON.stringify(request.body))
        throw fail('receipt_identity_conflict', 'Saved request identity is inconsistent.');
      const record = this.ledger.get(request.requestId);
      if (!record || record.bodyHash !== request.bodyHash || record.model !== request.body.model || record.metadata?.transport?.ownerId !== request.ownerId ||
          record.metadata.transport.version !== this.protocol.version || record.metadata.transport.artifactKey !== entry.name)
        throw fail('receipt_identity_conflict', 'Saved request does not own the ledger entry.');
      this.ledger.assertScope(request.requestId);
      const receipt = await optionalJson(join(directory, 'receipt.json'));
      if (receipt) {
        const bytes = await readFile(join(directory, 'response-body.bin'));
        const headers = await optionalJson(join(directory, 'headers.json'));
        if (receipt.version !== this.protocol.version || receipt.requestId !== request.requestId || receipt.ownerId !== request.ownerId ||
            receipt.bodyHash !== request.bodyHash || receipt.bytes !== bytes.length || receipt.responseHash !== hash(bytes) ||
            receipt.status < 200 || receipt.status >= 300 || headers?.status !== receipt.status ||
            !headers.contentType?.includes('text/event-stream')) throw fail('receipt_identity_conflict', 'Saved response identity is inconsistent.');
        const chunks = (await readFile(join(directory, 'response-chunks.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        let offset = 0;
        for (const [index, chunk] of chunks.entries()) {
          if (chunk.sequence !== index || chunk.offset !== offset || !positive(chunk.bytes))
            throw fail('receipt_identity_conflict', 'Saved receipt chunk ordering is inconsistent.');
          offset += chunk.bytes;
        }
        if (offset !== bytes.length || chunks.length !== receipt.chunks)
          throw fail('receipt_identity_conflict', 'Saved receipt chunk boundary is inconsistent.');
        const parser = this.protocol.createReceipt(); parser.push(bytes); const parsed = parser.finish();
        assertReceiptModel(parsed, record.model);
        if (JSON.stringify(parsed) !== JSON.stringify(Object.fromEntries(Object.keys(parsed).map(key => [key, receipt[key]]))))
          throw fail('receipt_identity_conflict', 'Saved response usage differs from its original bytes.');
        this.ledger.settle(request.requestId, parsed.usage); result.settled.push(request.requestId);
      } else if (record.status === 'reserved' && !record.dispatchedAt) {
        this.ledger.releaseUnsent(request.requestId, 'cold_recovery_unsent'); result.released.push(request.requestId);
      } else if (record.status === 'dispatched') {
        this.ledger.markUnknown(request.requestId, 'cold_recovery_incomplete'); result.unknown.push(request.requestId);
      } else result.unchanged.push(request.requestId);
    }
    return result;
  }

  close() {
    if (this.closing) return this.closing;
    this.stopping.abort();
    this.closing = (async () => {
      await Promise.allSettled([...this.inflight.values()].map(state => state.done));
      if (this.ownsDispatcher) await this.dispatcher.close();
    })();
    return this.closing;
  }
}
