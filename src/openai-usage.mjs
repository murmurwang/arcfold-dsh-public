import { OPENAI_MODELS } from './openai-models.mjs';
import { createHash } from 'node:crypto';
import { Store, DomainError, canonicalJson, jsonClone } from './store.mjs';

const REQUESTS = 'openai_requests';
const AUTHORITIES = 'openai_request_authorities';
const AUTHORIZATIONS = 'openai_authorizations';
const now = () => new Date().toISOString();
const fail = (code, message) => { throw new DomainError(code, message, 409); };
function string(value, label, limit = 512) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || value.includes('\0'))
    fail('invalid_request', label + ' must be a nonempty string.');
  return value;
}
function metadata(value) {
  const copy = jsonClone(value);
  if (!copy || typeof copy !== 'object' || Array.isArray(copy))
    fail('invalid_request', 'Request metadata must be a plain object.');
  function inspect(item) {
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      if (/^(authorization|api[-_]?key|secret|password|access[-_]?token|refresh[-_]?token|credentials?)$/i.test(key))
        fail('sensitive_metadata', 'Credentials cannot be saved in usage metadata.');
      inspect(child);
    }
  }
  inspect(copy);
  if (!copy.transport || typeof copy.transport !== 'object' || Array.isArray(copy.transport))
    fail('invalid_request', 'The transport ownership evidence is required.');
  for (const key of ['version', 'ownerId', 'artifactKey']) string(copy.transport[key], 'transport.' + key);
  return copy;
}

function summarize(rows) {
  return { provider: 'openai', accounting: 'tokens_only', requests: rows.length,
    unknownCount: rows.filter(row => row.status === 'unknown').length,
    pendingCount: rows.filter(row => ['reserved', 'dispatched'].includes(row.status)).length,
    ...rows.reduce((sum, row) => {
      for (const key of ['promptTokens', 'completionTokens', 'cachedTokens']) sum[key] += row.usage?.[key] || 0;
      return sum;
    }, { promptTokens: 0, completionTokens: 0, cachedTokens: 0 }) };
}

/** Token-only accounting. Legacy rows stay intact; new authority is separate
 * from request bodies, and never borrowed from the DeepSeek experiment budget. */
export class OpenAIUsageLedger {
  constructor(filename, { scope = 'web-openai', webAuthorization, create = false } = {}) {
    if (scope !== 'web-openai') fail('invalid_usage_scope', 'OpenAI requires its independent web scope.');
    if (!webAuthorization || typeof webAuthorization !== 'object' || Array.isArray(webAuthorization))
      fail('invalid_web_authorization', 'Explicit OpenAI web authorization is required.');
    const { authorizationRef, authorizedAt, authorizationEvidence } = webAuthorization;
    string(authorizationRef, 'authorizationRef', 4096);
    string(authorizedAt, 'authorizedAt');
    string(authorizationEvidence, 'authorizationEvidence', 8000);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(authorizedAt) || !Number.isFinite(Date.parse(authorizedAt)))
      fail('invalid_web_authorization', 'Authorization needs a valid explicit timestamp.');
    const authorization = Object.freeze({ scope, provider: 'openai', accounting: 'tokens_only',
      authorizationRef, authorizedAt: new Date(authorizedAt).toISOString(), authorizationEvidence });
    const authorizationId = 'openai-web-' + createHash('sha256').update(authorizationRef).digest('hex');
    Object.defineProperties(this, {
      scope: { value: scope, enumerable: true },
      webAuthorization: { value: authorization, enumerable: true },
      authorizationId: { value: authorizationId, enumerable: true },
    });
    this.store = new Store(filename, { mode: 'legacy-records-v2', create });
    this.db = this.store.db; this.filename = this.store.filename;
    try {
      this.store.transaction(() => {
        const existing = this.store.get(AUTHORIZATIONS, authorizationId);
        if (existing && canonicalJson(existing.specification) !== canonicalJson(authorization))
          fail('web_authorization_conflict', 'This authorization is already bound to different evidence.');
        if (!existing) this.store.save(AUTHORIZATIONS, { id: authorizationId, specification: authorization, appliedAt: now() });
      });
    } catch (error) { this.store.close(); throw error; }
  }

  // Projection only: do not persist scope, metadata or copied top-level fields
  // into the original openai_requests JSON.
  project(row) {
    if (!row) return null;
    const authority = this.store.get(AUTHORITIES, row.requestId);
    return { ...row, ...row.specification,
      scope: authority?.scope ?? 'legacy', metadata: authority?.metadata ?? null };
  }
  get(id) { return this.project(this.store.get(REQUESTS, id)); }
  list() { return this.store.listAll(REQUESTS).map(row => this.project(row)); }
  required(id) {
    const row = this.store.get(REQUESTS, id);
    if (!row) fail('request_not_found', 'No OpenAI request has been registered.');
    return row;
  }
  save(row) {
    return this.store.save(REQUESTS, { ...row, id: row.requestId }, { expectedRevision: row.revision ?? null });
  }
  assertCurrentAuthorization() {
    const current = this.store.get(AUTHORIZATIONS, this.authorizationId);
    if (!current || canonicalJson(current.specification) !== canonicalJson(this.webAuthorization))
      fail('usage_authorization_stale', 'The explicit OpenAI authorization no longer matches.');
  }
  assertScope(id) {
    const row = this.store.get(REQUESTS, id);
    const authority = this.store.get(AUTHORITIES, id);
    if (!row && !authority) return;
    if (!row || !authority || authority.scope !== this.scope || authority.authorizationId !== this.authorizationId ||
        canonicalJson(authority.specification) !== canonicalJson(row.specification))
      fail('usage_scope_conflict', 'Legacy or differently authorized requests cannot be claimed by this transport.');
  }

  reserve({ requestId, bodyHash, model, maxOutputTokens, inputTokenCeiling, metadata: inputMetadata = {} } = {}) {
    string(requestId, 'requestId'); string(bodyHash, 'bodyHash', 256);
    if (!OPENAI_MODELS.includes(model) || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 ||
        !Number.isSafeInteger(inputTokenCeiling) || inputTokenCeiling < 1)
      fail('invalid_request', 'Unsupported OpenAI model or token controls.');
    const specification = { bodyHash, model, maxOutputTokens, inputTokenCeiling };
    const safe = metadata(inputMetadata);
    return this.store.transaction(() => {
      this.assertCurrentAuthorization(); this.assertScope(requestId);
      const prior = this.store.get(REQUESTS, requestId);
      if (prior) {
        const authority = this.store.get(AUTHORITIES, requestId);
        if (canonicalJson(prior.specification) !== canonicalJson(specification) ||
            canonicalJson(authority.metadata) !== canonicalJson(safe))
          fail('reservation_conflict', 'Request identity is already bound to different content or ownership.');
        if (prior.status !== 'released') return this.project(prior);
        if (prior.dispatchedAt || prior.usage !== null)
          fail('invalid_usage_state', 'Only demonstrably unsent requests can be reserved again.');
      } else this.store.save(AUTHORITIES, { id: requestId, scope: this.scope,
        authorizationId: this.authorizationId, specification, metadata: safe });
      return this.project(this.save({ ...prior, requestId, specification, status: 'reserved', dispatchedAt: null, usage: null }));
    });
  }
  markDispatched(id) {
    return this.store.transaction(() => {
      this.assertCurrentAuthorization(); this.assertScope(id);
      const row = this.required(id);
      if (row.status !== 'reserved' || row.dispatchedAt)
        fail('request_already_dispatched', 'A dispatched request cannot be automatically resent.');
      return this.project(this.save({ ...row, status: 'dispatched', dispatchedAt: now() }));
    });
  }
  markUnknown(id, reason = 'Provider outcome is unknown.') {
    string(reason, 'reason', 4000);
    return this.store.transaction(() => {
      this.assertScope(id); const row = this.required(id);
      if (row.status === 'settled') return this.project(row);
      if (!row.dispatchedAt || row.status === 'released')
        fail('invalid_usage_state', 'An unsent request cannot have an unknown provider result.');
      if (row.status === 'unknown' && row.reason === reason) return this.project(row);
      return this.project(this.save({ ...row, status: 'unknown', reason }));
    });
  }
  releaseUnsent(id, reason = 'Not dispatched.') {
    string(reason, 'reason', 4000);
    return this.store.transaction(() => {
      this.assertScope(id); const row = this.required(id);
      if (row.dispatchedAt || !['reserved', 'released'].includes(row.status))
        fail('already_dispatched', 'Only a demonstrably unsent request may be released.');
      if (row.status === 'released') return this.project(row);
      return this.project(this.save({ ...row, status: 'released', reason }));
    });
  }
  settle(id, usage) {
    const result = this.store.transaction(() => {
      this.assertScope(id); const row = this.required(id);
      if (!row.dispatchedAt || row.status === 'released')
        fail('invalid_usage_state', 'A dispatched request is required before settlement.');
      const { promptTokens, completionTokens, cachedTokens } = usage || {};
      const valid = usage && typeof usage === 'object' && !Array.isArray(usage) &&
        [promptTokens, completionTokens, cachedTokens].every(n => Number.isSafeInteger(n) && n >= 0) &&
        cachedTokens <= promptTokens && promptTokens <= row.specification.inputTokenCeiling &&
        completionTokens <= row.specification.maxOutputTokens;
      const normalized = { promptTokens, completionTokens, cachedTokens };
      if (row.status === 'settled') {
        if (!valid || canonicalJson(row.usage) !== canonicalJson(normalized))
          fail('usage_conflict', 'Settled usage cannot be replaced.');
        return { row };
      }
      if (!valid) return { invalid: true, row: this.save({ ...row, status: 'unknown',
        reason: 'Invalid or incomplete authoritative OpenAI usage.' }) };
      return { row: this.save({ ...row, status: 'settled', usage: normalized, settledAt: now() }) };
    });
    // Persist the unknown outcome before reporting malformed usage.
    if (result.invalid) fail('invalid_usage', 'OpenAI did not return complete valid token usage.');
    return this.project(result.row);
  }
  summary() { return summarize(this.store.listAll(REQUESTS)); }
  scopeSummary() {
    // Read request rows and companion authorities in one coherent transaction.
    // Legacy rows remain in the original all-time summary, never relabeled web.
    return this.store.transaction(() => ({ scope: this.scope,
      ...summarize(this.list().filter(row => row.scope === this.scope)) }));
  }
  close() { this.store.close(); }
}
