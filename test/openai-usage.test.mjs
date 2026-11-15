import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OpenAIUsageLedger } from '../src/openai-usage.mjs';

const webAuthorization = { authorizationRef: 'fixture-openai-web', authorizedAt: '2026-11-07T00:00:00Z',
  authorizationEvidence: 'Explicit isolated OpenAI web authorization; not DeepSeek development.' };
const options = { scope: 'web-openai', webAuthorization };
function file(t) {
  const dir = mkdtempSync(join(tmpdir(), 'arcfold-openai-usage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true })); return join(dir, 'usage.sqlite');
}
function ledger(t, filename = file(t), extra = {}) {
  const value = new OpenAIUsageLedger(filename, { ...options, create: true, ...extra });
  t.after(() => value.close()); return value;
}
const request = id => ({ requestId: id, bodyHash: 'a'.repeat(64), model: 'gpt-6-astra',
  maxOutputTokens: 64, inputTokenCeiling: 1024,
  metadata: { role: 'main', sessionId: 'native-session', turn: 0, step: 0,
    transport: { version: 'arcfold-openai-responses-transport-v1', ownerId: 'isolated-owner', artifactKey: id } } });

test('an existing authorized file is required unless fresh creation is explicit', t => {
  const filename = file(t);
  assert.throws(() => new OpenAIUsageLedger(filename, options), { code: 'ledger_missing' });
  assert.equal(existsSync(filename), false);
  assert.throws(() => new OpenAIUsageLedger(filename, { create: true }), { code: 'invalid_web_authorization' });
  assert.equal(existsSync(filename), false);
  assert.throws(() => new OpenAIUsageLedger(filename, { ...options, scope: 'limited', create: true }), { code: 'invalid_usage_scope' });
  assert.equal(existsSync(filename), false);
});

test('independent token-only authority and request ownership survive close/reopen without resend', t => {
  const filename = file(t), value = ledger(t, filename);
  const first = value.reserve(request('one'));
  assert.equal(first.scope, 'web-openai'); assert.equal(first.model, 'gpt-6-astra');
  assert.deepEqual(first.metadata, request('one').metadata);
  const raw = value.store.get('openai_requests', 'one');
  assert.equal(raw.model, undefined); assert.equal(raw.metadata, undefined);
  assert.deepEqual(raw.specification, { bodyHash: 'a'.repeat(64), model: 'gpt-6-astra', maxOutputTokens: 64, inputTokenCeiling: 1024 });
  value.markDispatched('one'); value.markUnknown('one', 'connection ended');
  const before = value.get('one'), sequence = value.store.currentSequence(); value.close();
  const reopened = ledger(t, filename, { create: false });
  assert.equal(reopened.store.currentSequence(), sequence);
  assert.deepEqual(reopened.reserve(request('one')), before);
  assert.throws(() => reopened.markDispatched('one'), { code: 'request_already_dispatched' });
  assert.throws(() => reopened.releaseUnsent('one'), { code: 'already_dispatched' });
  assert.equal(reopened.summary().unknownCount, 1);
  const settled = reopened.settle('one', { promptTokens: 11, completionTokens: 5, cachedTokens: 3 });
  assert.deepEqual(reopened.settle('one', settled.usage), settled);
  assert.deepEqual(reopened.summary(), { provider: 'openai', accounting: 'tokens_only', requests: 1,
    unknownCount: 0, pendingCount: 0, promptTokens: 11, completionTokens: 5, cachedTokens: 3 });
  assert.equal(Object.hasOwn(reopened.summary(), 'spentCny'), false);
});

test('authorization changes between reservation and dispatch synchronously reject; accounting remains possible', t => {
  const value = ledger(t); value.reserve(request('unsent')); value.reserve(request('sent')); value.markDispatched('sent');
  const authority = value.store.get('openai_authorizations', value.authorizationId);
  value.store.save('openai_authorizations', { ...authority, specification: { ...authority.specification, authorizationEvidence: 'changed' } },
    { expectedRevision: authority.revision });
  assert.throws(() => value.assertCurrentAuthorization(), { code: 'usage_authorization_stale' });
  assert.throws(() => value.markDispatched('unsent'), { code: 'usage_authorization_stale' });
  assert.throws(() => value.reserve(request('other')), { code: 'usage_authorization_stale' });
  assert.equal(value.get('unsent').dispatchedAt, null); assert.equal(value.get('other'), null);
  assert.equal(value.releaseUnsent('unsent').status, 'released');
  assert.equal(value.settle('sent', { promptTokens: 11, completionTokens: 5, cachedTokens: 3 }).status, 'settled');
  assert.throws(() => new OpenAIUsageLedger(value.filename, options), { code: 'web_authorization_conflict' });
});

test('different authorization or transport ownership cannot take over an existing request', t => {
  const filename = file(t), value = ledger(t, filename); value.reserve(request('one'));
  const other = ledger(t, filename, { create: false, webAuthorization: { ...webAuthorization, authorizationRef: 'other-explicit-web' } });
  assert.throws(() => other.assertScope('one'), { code: 'usage_scope_conflict' });
  assert.throws(() => other.reserve(request('one')), { code: 'usage_scope_conflict' });
  assert.throws(() => other.markDispatched('one'), { code: 'usage_scope_conflict' });
  const changed = request('one'); changed.metadata.transport.ownerId = 'different-owner';
  assert.throws(() => value.reserve(changed), { code: 'reservation_conflict' });
  assert.throws(() => value.reserve({ ...request('one'), bodyHash: 'b'.repeat(64) }), { code: 'reservation_conflict' });
  assert.equal(value.get('one').dispatchedAt, null);
});

test('unsent release is idempotent, may be reacquired only with unchanged ownership, and cannot be called unknown', t => {
  const value = ledger(t); value.reserve(request('one'));
  assert.throws(() => value.markUnknown('one'), { code: 'invalid_usage_state' });
  const released = value.releaseUnsent('one', 'cancelled before send');
  const sequence = value.store.currentSequence();
  assert.deepEqual(value.releaseUnsent('one'), released); assert.equal(value.store.currentSequence(), sequence);
  assert.throws(() => value.settle('one', { promptTokens: 0, completionTokens: 0, cachedTokens: 0 }), { code: 'invalid_usage_state' });
  assert.equal(value.reserve(request('one')).status, 'reserved');
  value.markDispatched('one');
  assert.throws(() => value.markDispatched('one'), { code: 'request_already_dispatched' });
});

test('missing, impossible or partial usage commits unknown; no cached-token default hides a missing field', t => {
  const value = ledger(t);
  const invalid = [null, {}, { promptTokens: 11, completionTokens: 5 },
    { promptTokens: 11, completionTokens: 5, cachedTokens: 12 },
    { promptTokens: 1025, completionTokens: 5, cachedTokens: 3 },
    { promptTokens: 11, completionTokens: 65, cachedTokens: 3 },
    { promptTokens: -1, completionTokens: 5, cachedTokens: 0 }];
  invalid.forEach((usage, i) => {
    const id = 'bad-' + i; value.reserve(request(id)); value.markDispatched(id);
    assert.throws(() => value.settle(id, usage), { code: 'invalid_usage' });
    assert.equal(value.get(id).status, 'unknown'); assert.equal(value.get(id).usage, null);
  });
  assert.equal(value.summary().unknownCount, invalid.length); assert.equal(value.summary().promptTokens, 0);
  value.settle('bad-0', { promptTokens: 11, completionTokens: 5, cachedTokens: 3 });
  const before = value.get('bad-0');
  assert.throws(() => value.settle('bad-0', { promptTokens: 8, completionTokens: 5, cachedTokens: 3 }), { code: 'usage_conflict' });
  assert.deepEqual(value.markUnknown('bad-0', 'late error'), before);
});

test('owned reservation and companion commit atomically, without secrets in metadata', t => {
  const value = ledger(t), sequence = value.store.currentSequence();
  const secret = request('secret'); secret.metadata.nested = { apiKey: 'synthetic-not-real' };
  assert.throws(() => value.reserve(secret), { code: 'sensitive_metadata' });
  assert.equal(value.store.currentSequence(), sequence);
  value.db.exec("CREATE TRIGGER fail_request BEFORE INSERT ON records WHEN NEW.kind='openai_requests' BEGIN SELECT RAISE(ABORT,'fixture-write-failure'); END");
  assert.throws(() => value.reserve(request('rollback')), /fixture-write-failure/);
  assert.equal(value.store.get('openai_request_authorities', 'rollback'), null);
  assert.equal(value.get('rollback'), null); assert.equal(value.store.currentSequence(), sequence);
});
