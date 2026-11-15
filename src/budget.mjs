// Monetary arithmetic and ledger transitions retained from Arcfold 3.0.
import { Store, DomainError, jsonClone } from './store.mjs';
import { createHash } from 'node:crypto';

const MICRO = 1_000_000;
const PRICE_SCALE = 1_000_000_000n;
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const now = () => new Date().toISOString();

function decimalScaled(value, scaleDigits, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new DomainError('invalid_budget', `${name} must be a finite nonnegative number.`, 400);
  // String conversion produces the decimal value declared by the caller; do not
  // multiply binary floating-point prices into cumulative monetary balances.
  const match = String(value).match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);
  if (!match) throw new DomainError('invalid_budget', `${name} is not a supported decimal.`, 400);
  const fraction = match[2] ?? '', exponent = Number(match[3] ?? 0);
  const shift = scaleDigits + exponent - fraction.length;
  let number = BigInt(match[1] + fraction);
  if (shift >= 0) number *= 10n ** BigInt(shift);
  else {
    const divisor = 10n ** BigInt(-shift);
    if (number % divisor !== 0n) throw new DomainError('invalid_budget', `${name} has too many decimal places.`, 400);
    number /= divisor;
  }
  if (number > BigInt(Number.MAX_SAFE_INTEGER)) throw new DomainError('invalid_budget', `${name} exceeds safe accounting limits.`, 400);
  return number;
}
function amountMicro(value) {
  const amount = decimalScaled(value, 6, 'ceilingCny');
  if (amount < 1n) throw new DomainError('invalid_budget', 'Budget ceiling must be at least one micro-yuan.', 400);
  return Number(amount);
}
function tokens(value, name, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) throw new DomainError('invalid_budget', `${name} must be a ${positive ? 'positive' : 'nonnegative'} integer.`, 400);
  return value;
}
function string(value, name, max = 512) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new DomainError('invalid_budget', `${name} is required.`, 400);
  return value;
}
function priceValues(prices) {
  const copy = jsonClone(prices);
  if (!copy || typeof copy !== 'object' || Array.isArray(copy) || Object.keys(copy).sort().join(',') !== 'cachedInput,input,output') {
    throw new DomainError('invalid_budget', 'Prices require exactly input, output and cachedInput in CNY per million tokens.', 400);
  }
  for (const key of ['input', 'output', 'cachedInput']) decimalScaled(copy[key], 9, `${key} price`);
  return copy;
}
function costMicro(prompt, completion, cached, prices, reserve = false) {
  const input = decimalScaled(prices.input, 9, 'input price');
  const cachedInput = decimalScaled(prices.cachedInput, 9, 'cachedInput price');
  const output = decimalScaled(prices.output, 9, 'output price');
  const numerator = reserve
    ? BigInt(prompt) * (input > cachedInput ? input : cachedInput) + BigInt(completion) * output
    : BigInt(prompt - cached) * input + BigInt(cached) * cachedInput + BigInt(completion) * output;
  const result = (numerator + PRICE_SCALE - 1n) / PRICE_SCALE;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new DomainError('budget_exceeded', 'Request exceeds accounting capacity.');
  return Number(result);
}
function safeMetadata(value) {
  const copy = jsonClone(value);
  if (!copy || typeof copy !== 'object' || Array.isArray(copy)) throw new DomainError('invalid_budget', 'Metadata must be an object.', 400);
  const inspect = item => {
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      if (/^(authorization|api[-_]?key|secret|password|access[-_]?token|refresh[-_]?token|credentials?)$/i.test(key)) {
        throw new DomainError('sensitive_metadata', 'Credentials cannot be stored in budget metadata.', 400);
      }
      inspect(child);
    }
  };
  inspect(copy); return copy;
}

export function webBudgetIdentity(webAuthorization) {
  if (!webAuthorization || typeof webAuthorization !== 'object' || Array.isArray(webAuthorization) ||
      Object.keys(webAuthorization).sort().join(',') !== 'authorizationEvidence,authorizationRef,authorizedAt')
    throw new DomainError('invalid_web_authorization', 'An exact explicit web authorization is required.', 400);
  const { authorizationRef, authorizedAt, authorizationEvidence } = webAuthorization;
  string(authorizationRef, 'webAuthorization.authorizationRef', 4096);
  string(authorizedAt, 'webAuthorization.authorizedAt');
  string(authorizationEvidence, 'webAuthorization.authorizationEvidence', 8000);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(authorizedAt) || !Number.isFinite(Date.parse(authorizedAt)))
    throw new DomainError('invalid_web_authorization', 'A valid explicit web authorization timestamp is required.', 400);
  return { id: 'budget-web-' + createHash('sha256').update(authorizationRef).digest('hex'),
    specification: { scope: 'web-unlimited', authorizationRef, authorizedAt: new Date(authorizedAt).toISOString(), authorizationEvidence } };
}
function freezeWebBudget(ledger) {
  Object.freeze(ledger.webAuthorization);
  Object.defineProperties(ledger, {
    mode: { value: 'web-only', enumerable: true },
    scope: { value: 'web-unlimited', writable: false, configurable: false, enumerable: true },
    webAuthorization: { value: ledger.webAuthorization, writable: false, configurable: false, enumerable: true },
    webAuthorizationId: { value: ledger.webAuthorizationId, writable: false, configurable: false, enumerable: true },
  });
}

export class BudgetLedger {
  static fromWebBudgetStore(store, webAuthorization) {
    const expected = webBudgetIdentity(webAuthorization);
    if (!(store instanceof Store) || !store.webBudget ||
        canonical(store.webBudgetIdentity) !== canonical(expected))
      throw new DomainError('web_budget_identity_conflict', 'The recovered store must retain its exact authority.');
    store.assertWebBudgetSchema();
    const ledger = Object.create(BudgetLedger.prototype);
    Object.assign(ledger, { store, db: store.db, filename: store.filename,
      webAuthorization: expected.specification, webAuthorizationId: expected.id });
    freezeWebBudget(ledger); return ledger;
  }

  constructor(filename, options = {}) {
    const { ceilingCny = 50, authorizationRef, scope = 'limited', webAuthorization, create = false } = options;
    if (options.mode !== undefined && options.mode !== 'web-only')
      throw new DomainError('invalid_budget_mode', 'Unsupported budget mode.', 400);
    const webOnly = options.mode === 'web-only';
    if (webOnly && (scope !== 'web-unlimited' || !Object.hasOwn(options, 'scope') ||
        Object.hasOwn(options, 'ceilingCny') || Object.hasOwn(options, 'authorizationRef')))
      throw new DomainError('invalid_web_only_budget', 'Web-only mode requires explicit web-unlimited scope and no finite allowance or base authorization.', 400);
    const ceilingMicroCny = webOnly ? null : amountMicro(ceilingCny);
    if (!webOnly) string(authorizationRef, 'authorizationRef', 4096);
    if (!['limited', 'web-unlimited'].includes(scope)) throw new DomainError('invalid_budget_scope', 'Budget scope must be limited or web-unlimited.', 400);
    this.scope = scope;
    if (!webOnly) this.authorization = { ceilingMicroCny, authorizationRef };
    if (scope === 'web-unlimited') {
      if (!webAuthorization || typeof webAuthorization !== 'object' || Array.isArray(webAuthorization)) throw new DomainError('invalid_web_authorization', 'Unlimited web requests require separate explicit authorization.', 400);
      const { authorizationRef: ref, authorizedAt, authorizationEvidence } = webAuthorization;
      string(ref, 'webAuthorization.authorizationRef', 4096); string(authorizedAt, 'webAuthorization.authorizedAt'); string(authorizationEvidence, 'webAuthorization.authorizationEvidence', 8000);
      if (ref === authorizationRef || !/^\d{4}-\d{2}-\d{2}T/.test(authorizedAt) || !Number.isFinite(Date.parse(authorizedAt))) throw new DomainError('invalid_web_authorization', 'Web authorization must identify a separate explicit decision and valid timestamp.', 400);
      this.webAuthorization = { scope, authorizationRef: ref, authorizedAt: new Date(authorizedAt).toISOString(), authorizationEvidence };
      this.webAuthorizationId = `budget-web-${createHash('sha256').update(ref).digest('hex')}`;
    }
    if (webOnly) {
      freezeWebBudget(this);
      this.store = new Store(filename, { mode: 'web-only-budget-v1', create,
        webBudgetIdentity: { id: this.webAuthorizationId, specification: this.webAuthorization } });
      this.db = this.store.db; this.filename = this.store.filename;
      return;
    }
    this.store = new Store(filename, { mode: 'legacy-ledger-v2', create }); this.db = this.store.db; this.filename = this.store.filename;
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS budget_settings (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1),
          schema_version INTEGER NOT NULL,
          ceiling_micro INTEGER NOT NULL CHECK(ceiling_micro>0),
          authorization_ref TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS budget_requests (
          id TEXT PRIMARY KEY,
          body_hash TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('reserved','dispatched','unknown','settled','released')),
          reserved_micro INTEGER NOT NULL CHECK(reserved_micro>=0),
          spent_micro INTEGER NOT NULL CHECK(spent_micro>=0),
          body TEXT NOT NULL CHECK(json_valid(body)),
          scope TEXT NOT NULL DEFAULT 'limited' CHECK(scope IN ('limited','web-unlimited'))
        );
      `);
      this.store.transaction(() => {
        // Serialize schema inspection and migration across simultaneous opens.
        // ALTER only adds a default: every legacy body and amount stays intact.
        if (!this.db.prepare('PRAGMA table_info(budget_requests)').all().some(column => column.name === 'scope')) {
          this.db.exec("ALTER TABLE budget_requests ADD COLUMN scope TEXT NOT NULL DEFAULT 'limited' CHECK(scope IN ('limited','web-unlimited'))");
        }
        const settings = this.db.prepare('SELECT * FROM budget_settings WHERE singleton=1').get();
        if (!settings) this.db.prepare('INSERT INTO budget_settings VALUES(1,1,?,?,?)').run(ceilingMicroCny, authorizationRef, now());
        else if (settings.schema_version !== 1 || settings.ceiling_micro !== ceilingMicroCny || settings.authorization_ref !== authorizationRef) {
          throw new DomainError('budget_configuration_conflict', 'The existing ledger ceiling and authorization cannot be changed by reopening it.');
        }
        if (this.webAuthorization) {
          const existing = this.store.get('budget_authorizations', this.webAuthorizationId);
          if (existing && canonical(existing.specification) !== canonical(this.webAuthorization)) throw new DomainError('web_authorization_conflict', 'This web authorization is already bound to different evidence.');
          if (!existing) this.store.save('budget_authorizations', { id: this.webAuthorizationId, specification: this.webAuthorization, appliedAt: now() });
        }
      });
    } catch (error) { this.store.close(); throw error; }
  }

  get(requestId) {
    this.store.assertOpen(); string(requestId, 'requestId');
    const row = this.db.prepare('SELECT body FROM budget_requests WHERE id=?').get(requestId);
    return row ? JSON.parse(row.body) : null;
  }

  list() {
    this.store.assertOpen();
    return this.db.prepare('SELECT body FROM budget_requests ORDER BY id').all().map(row => JSON.parse(row.body));
  }

  assertCurrentAuthorization() {
    if (this.mode === 'web-only') {
      this.store.assertOpen();
      try { this.store.assertWebBudgetIdentity(); }
      catch { throw new DomainError('budget_authorization_stale', 'The explicit web authorization no longer matches.'); }
      return;
    }
    if (this.scope === 'web-unlimited') {
      const current = this.store.get('budget_authorizations', this.webAuthorizationId);
      if (!current || canonical(current.specification) !== canonical(this.webAuthorization)) throw new DomainError('budget_authorization_stale', 'The explicit web authorization no longer matches.');
      return;
    }
    const current = this.db.prepare('SELECT ceiling_micro,authorization_ref FROM budget_settings WHERE singleton=1').get();
    if (current.ceiling_micro !== this.authorization.ceilingMicroCny || current.authorization_ref !== this.authorization.authorizationRef) {
      throw new DomainError('budget_authorization_stale', 'This ledger instance must be reopened with the current explicit authorization before reserving or dispatching.');
    }
  }

  upgradeAuthorization({ expectedCeilingCny, expectedAuthorizationRef, ceilingCny, authorizationRef, authorizedAt, authorizationEvidence } = {}) {
    if (this.mode === 'web-only')
      throw new DomainError('web_only_no_limited_budget', 'A web-only ledger has no finite allowance to upgrade.', 409);
    const previous = { ceilingMicroCny: amountMicro(expectedCeilingCny), authorizationRef: string(expectedAuthorizationRef, 'expectedAuthorizationRef', 4096) };
    const next = { ceilingMicroCny: amountMicro(ceilingCny), authorizationRef: string(authorizationRef, 'authorizationRef', 4096) };
    string(authorizedAt, 'authorizedAt'); string(authorizationEvidence, 'authorizationEvidence', 8000);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(authorizedAt) || !Number.isFinite(Date.parse(authorizedAt))) throw new DomainError('invalid_budget', 'A valid explicit authorization timestamp is required.', 400);
    if (next.ceilingMicroCny <= previous.ceilingMicroCny || next.authorizationRef === previous.authorizationRef) throw new DomainError('invalid_budget_upgrade', 'An upgrade must strictly increase the ceiling and identify a new explicit authorization.');
    const specification = { previous, next, authorizedAt: new Date(authorizedAt).toISOString(), authorizationEvidence };
    const id = `budget-upgrade-${createHash('sha256').update(authorizationRef).digest('hex')}`;
    const record = this.store.transaction(() => {
      const current = this.db.prepare('SELECT ceiling_micro,authorization_ref FROM budget_settings WHERE singleton=1').get();
      const existing = this.store.get('budget_authorizations', id);
      if (existing) {
        if (canonical(existing.specification) !== canonical(specification)) throw new DomainError('authorization_upgrade_conflict', 'This authorization is already bound to different upgrade evidence.');
        // A historical replay never reverts a later authorization or resets totals.
        return existing;
      }
      if (current.ceiling_micro !== previous.ceilingMicroCny || current.authorization_ref !== previous.authorizationRef) throw new DomainError('budget_configuration_conflict', 'The expected previous budget authorization no longer matches.');
      if (this.db.prepare("SELECT 1 FROM budget_requests WHERE status='dispatched' LIMIT 1").get()) throw new DomainError('budget_upgrade_in_flight', 'Finish or classify active dispatched requests before changing authorization.');
      const record = this.store.save('budget_authorizations', { id, specification, appliedAt: now() });
      this.db.prepare('UPDATE budget_settings SET ceiling_micro=?,authorization_ref=? WHERE singleton=1').run(next.ceilingMicroCny, next.authorizationRef);
      return record;
    });
    const current = this.db.prepare('SELECT ceiling_micro,authorization_ref FROM budget_settings WHERE singleton=1').get();
    if (current.ceiling_micro === next.ceilingMicroCny && current.authorization_ref === next.authorizationRef) this.authorization = next;
    return record;
  }

  summary() {
    this.store.assertOpen();
    // One SELECT provides a coherent SQLite snapshot across settings and totals.
    const row = this.db.prepare(`SELECT ${this.mode === 'web-only' ? 'NULL' : 'ceiling_micro'} AS ceiling,
      COALESCE((SELECT SUM(spent_micro) FROM budget_requests WHERE scope=:scope),0) AS spent,
      COALESCE((SELECT SUM(reserved_micro) FROM budget_requests WHERE scope=:scope),0) AS reserved,
      (SELECT COUNT(*) FROM budget_requests WHERE scope=:scope AND status='unknown') AS unknownCount,
      (SELECT COUNT(*) FROM budget_requests WHERE scope=:scope) AS requests,
      COALESCE((SELECT SUM(spent_micro) FROM budget_requests),0) AS allSpent,
      COALESCE((SELECT SUM(reserved_micro) FROM budget_requests),0) AS allReserved,
      (SELECT COUNT(*) FROM budget_requests WHERE status='unknown') AS allUnknown,
      (SELECT COUNT(*) FROM budget_requests) AS allRequests
      ${this.mode === 'web-only' ? '' : 'FROM budget_settings WHERE singleton=1'}`).get({ scope: this.scope });
    const ceiling = this.scope === 'limited' ? row.ceiling : null;
    const available = ceiling === null ? null : ceiling - row.spent - row.reserved;
    return { scope: this.scope, ceilingCny: ceiling === null ? null : ceiling / MICRO, spentCny: row.spent / MICRO, reservedCny: row.reserved / MICRO,
      availableCny: available === null ? null : available / MICRO, unknownCount: row.unknownCount, requests: row.requests,
      ceilingMicroCny: ceiling, spentMicroCny: row.spent, reservedMicroCny: row.reserved, availableMicroCny: available,
      allTime: { spentCny: row.allSpent / MICRO, reservedCny: row.allReserved / MICRO, spentMicroCny: row.allSpent, reservedMicroCny: row.allReserved, unknownCount: row.allUnknown, requests: row.allRequests } };
  }

  write(record) {
    // The SQL column owns scope; neither request metadata nor a later caller can
    // change it. Old sealed writers omit the column and still default to limited.
    const scope = this.db.prepare('SELECT scope FROM budget_requests WHERE id=?').get(record.requestId)?.scope || this.scope;
    const saved = { ...record, updatedAt: now(), reservedCny: record.reservedMicroCny / MICRO, spentCny: record.spentMicroCny / MICRO };
    this.db.prepare(`INSERT INTO budget_requests(id,body_hash,status,reserved_micro,spent_micro,body,scope) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,reserved_micro=excluded.reserved_micro,spent_micro=excluded.spent_micro,body=excluded.body`)
      .run(saved.requestId, saved.bodyHash, saved.status, saved.reservedMicroCny, saved.spentMicroCny, JSON.stringify(saved), scope);
    return jsonClone(saved);
  }

  assertScope(requestId) {
    const row = this.db.prepare('SELECT scope FROM budget_requests WHERE id=?').get(requestId);
    if (row && row.scope !== this.scope) throw new DomainError('budget_scope_conflict', 'This request belongs to another fixed budget scope; it cannot be reserved or dispatched here.');
  }

  reserve({ requestId, bodyHash, model, maxOutputTokens, inputTokenCeiling, prices, metadata = {} } = {}) {
    string(requestId, 'requestId'); string(bodyHash, 'bodyHash', 256); string(model, 'model');
    tokens(maxOutputTokens, 'maxOutputTokens', { positive: true }); tokens(inputTokenCeiling, 'inputTokenCeiling', { positive: true });
    const fixedPrices = priceValues(prices), safe = safeMetadata(metadata);
    const specification = { bodyHash, model, maxOutputTokens, inputTokenCeiling, prices: fixedPrices };
    const reserveMicroCny = costMicro(inputTokenCeiling, maxOutputTokens, 0, fixedPrices, true);
    return this.store.transaction(() => {
      this.assertCurrentAuthorization();
      const previous = this.get(requestId);
      if (previous) {
        this.assertScope(requestId);
        if (canonical(previous.specification) !== canonical(specification)) throw new DomainError('reservation_conflict', 'Request identity is already bound to a different body or accounting specification.');
        if (previous.status !== 'released') return previous;
        if (previous.dispatchedAt || previous.spentMicroCny !== 0) throw new DomainError('invalid_budget_state', 'Only demonstrably unsent requests may reacquire a reservation.');
      }
      const summary = this.summary();
      if (this.scope === 'limited' && reserveMicroCny > summary.availableMicroCny) throw new DomainError('budget_exceeded', 'The request worst-case cost exceeds the remaining authorized budget.', 409,
        { requestedMicroCny: reserveMicroCny, availableMicroCny: summary.availableMicroCny });
      if (previous) return this.write({ ...previous, status: 'reserved', reservedMicroCny: reserveMicroCny,
        reservationRestarts: (previous.reservationRestarts || 0) + 1, reacquiredAt: now() });
      return this.write({ requestId, ...specification, specification, metadata: safe, status: 'reserved',
        createdAt: now(), reservedMicroCny: reserveMicroCny, reservedMaximumMicroCny: reserveMicroCny, spentMicroCny: 0, dispatchedAt: null, usage: null });
    });
  }

  required(requestId) {
    const record = this.get(requestId);
    if (!record) throw new DomainError('request_not_found', 'No reservation exists for this request.', 404);
    return record;
  }

  markDispatched(requestId) {
    return this.store.transaction(() => {
      this.assertCurrentAuthorization();
      const record = this.required(requestId);
      this.assertScope(requestId);
      if (record.status !== 'reserved' || record.dispatchedAt) throw new DomainError('request_already_dispatched', 'This request cannot be dispatched again.');
      return this.write({ ...record, status: 'dispatched', dispatchedAt: now() });
    });
  }

  markUnknown(requestId, reason = 'Provider outcome is unknown.') {
    string(reason, 'reason', 4000);
    return this.store.transaction(() => {
      const record = this.required(requestId);
      if (record.status === 'settled') return record;
      if (record.status === 'released') throw new DomainError('invalid_budget_state', 'An unsent released reservation cannot become unknown.');
      return this.write({ ...record, status: 'unknown', unknownReason: reason, unknownAt: now() });
    });
  }

  releaseUnsent(requestId, reason = 'Not dispatched.') {
    string(reason, 'reason', 4000);
    return this.store.transaction(() => {
      const record = this.required(requestId);
      if (record.status === 'released') return record;
      if (record.status !== 'reserved' || record.dispatchedAt) throw new DomainError('already_dispatched', 'Only a demonstrably unsent reservation can be released.');
      const releasedAt = now();
      return this.write({ ...record, status: 'released', reservedMicroCny: 0, releaseReason: reason, releasedAt,
        releaseHistory: [...(record.releaseHistory || []), { reason, releasedAt }] });
    });
  }

  settle(requestId, usage) {
    const result = this.store.transaction(() => {
      const record = this.required(requestId);
      if (!record.dispatchedAt || record.status === 'released') throw new DomainError('invalid_budget_state', 'A dispatched request is required before settlement.');
      let normalized, invalid;
      try {
        if (!usage || typeof usage !== 'object' || Array.isArray(usage)) throw new Error('Complete provider usage is required.');
        const promptTokens = tokens(usage.promptTokens, 'promptTokens');
        const completionTokens = tokens(usage.completionTokens, 'completionTokens');
        const cachedTokens = tokens(usage.cachedTokens ?? 0, 'cachedTokens');
        if (cachedTokens > promptTokens || promptTokens > record.inputTokenCeiling || completionTokens > record.maxOutputTokens) throw new Error('Provider usage exceeds the reserved token bounds.');
        normalized = { promptTokens, completionTokens, cachedTokens };
      } catch (error) { invalid = error.message; }
      if (record.status === 'settled') {
        if (invalid || canonical(record.usage) !== canonical(normalized)) throw new DomainError('usage_conflict', 'A settled request cannot be assigned different usage.');
        return { record };
      }
      if (invalid) {
        return { invalid, record: this.write({ ...record, status: 'unknown', unknownAt: now(), unknownReason: 'Invalid or incomplete usage: ' + invalid }) };
      }
      const spentMicroCny = costMicro(normalized.promptTokens, normalized.completionTokens, normalized.cachedTokens, record.prices);
      if (spentMicroCny > record.reservedMaximumMicroCny) {
        return { invalid: 'Cost exceeds the reserved worst-case amount.', record: this.write({ ...record, status: 'unknown', unknownReason: 'Cost exceeds the reserved worst-case amount.' }) };
      }
      return { record: this.write({ ...record, status: 'settled', reservedMicroCny: 0, spentMicroCny, usage: normalized, settledAt: now(), unknownReason: null }) };
    });
    // Commit unknown before throwing; rolling the transaction back would hide it.
    if (result.invalid) throw new DomainError('invalid_usage', result.invalid, 409, { requestId });
    return result.record;
  }

  close() { this.store.close(); }
}
