import { basename, isAbsolute } from 'node:path';
import { BudgetLedger } from '../budget.mjs';
import { canonicalJson, digest, fail, integer, jsonClone, shape, text } from './contracts.mjs';

export const TREE_TEST_SCOPE = 'arcfold-tree-v3-150cny';
export const TEST_STAGE_CNY = Object.freeze({ smoke: 5, roles: 20, learning: 35, scripts: 30, heldout: 40, repair: 20 });
const frozen = value => { if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); } return value; };

// Runtime experiment policy: preserve finite ledger arithmetic and settlement.
// Preserve the existing finite ledger's dispatch/unknown/settlement
// and schema. Its physical SQL bucket remains "limited"; a sealed manifest maps
// this one independent database to the externally visible tree experiment scope.
export class TreeTestLedger {
  constructor({ filename, authorizationRef, manifest, create = false }) {
    if (!isAbsolute(filename) || basename(filename) !== 'test-ledger.sqlite') fail('TEST_LEDGER_PATH', 'The shared experiment requires an explicit test-ledger.sqlite');
    shape(manifest, ['budgetScope', 'ceilingCny', 'model', 'modelVersion', 'prices', 'inputBound', 'outputCap', 'verification']);
    if (manifest.budgetScope !== TREE_TEST_SCOPE || manifest.ceilingCny !== 150 || manifest.inputBound !== 1000000) fail('TEST_BUDGET', 'One 150 CNY experiment and conservative 1M input reservation required');
    integer(manifest.outputCap, 'output cap', 1, 8192); text(manifest.model, 'model'); text(manifest.modelVersion, 'model version');
    shape(manifest.prices, ['input', 'output', 'cachedInput']); for (const p of Object.values(manifest.prices)) if (!Number.isFinite(p) || p < 0) fail('TEST_PRICE', 'Explicit nonnegative peak prices required');
    shape(manifest.verification, ['at', 'urls', 'contentHashes', 'adapterVersion']); text(manifest.verification.at, 'price verification time');
    if (!Array.isArray(manifest.verification.urls) || !manifest.verification.urls.length || !Array.isArray(manifest.verification.contentHashes) || manifest.verification.contentHashes.some(h => !/^[a-f0-9]{64}$/.test(h)) || manifest.verification.urls.length !== manifest.verification.contentHashes.length) fail('TEST_PRICE', 'Official verification references and hashes required');
    this.base = new BudgetLedger(filename, { ceilingCny: 150, authorizationRef, scope: 'limited', create });
    Object.defineProperties(this, { filename: { value: filename, enumerable: true }, scope: { value: TREE_TEST_SCOPE, enumerable: true }, manifest: { value: frozen(jsonClone(manifest)), enumerable: true }, manifestHash: { value: digest(manifest), enumerable: true } });
    try {
      this.base.store.transaction(() => {
        const id = 'arcfold-tree-test-budget-manifest', old = this.base.store.get('experiment_budget_manifest', id);
        if (old && old.hash !== this.manifestHash) fail('TEST_MANIFEST_CONFLICT', 'Do not silently change model, price or scope within this experiment');
        if (!old) {
          if (this.base.list().length || !create) fail('TEST_LEDGER_UNOWNED', 'Cannot adopt another experiment ledger');
          this.base.store.save('experiment_budget_manifest', { id, hash: this.manifestHash, manifest: this.manifest, authorizationRef });
        }
      });
    } catch (e) { this.base.close(); throw e; }
  }
  assertCurrentAuthorization() {
    if (this.base.scope !== 'limited' || this.base.authorization.ceilingMicroCny !== 150000000 || this.base.summary().ceilingMicroCny !== 150000000 || digest(this.manifest) !== this.manifestHash) fail('TEST_BUDGET', 'Experiment cannot change its finite 150 CNY cap');
    this.base.assertCurrentAuthorization(); const record = this.base.store.get('experiment_budget_manifest', 'arcfold-tree-test-budget-manifest');
    if (record?.hash !== this.manifestHash || digest(record.manifest) !== this.manifestHash) fail('TEST_MANIFEST_CONFLICT', 'Frozen experiment authorization changed');
  }
  reserve(spec) {
    const m = this.manifest;
    if (spec.model !== m.model || spec.inputTokenCeiling !== m.inputBound || spec.maxOutputTokens > m.outputCap || canonicalJson(spec.prices) !== canonicalJson(m.prices)) fail('TEST_RESERVATION', 'Request differs from the frozen peak reservation policy');
    const metadata = spec.metadata ?? {}, stage = metadata.stage;
    if (!Object.hasOwn(TEST_STAGE_CNY, stage) || metadata.budgetScope !== this.scope || !metadata.treeJobId || !metadata.treeInvocationId || !metadata.role) fail('TEST_OWNER', 'Every paid request requires a role, job, invocation and experiment stage');
    // Transport priceVersion is its own policy evidence; do not let that value
    // overwrite and hide the job's independently frozen price identity.
    if (metadata.modelVersion !== m.modelVersion || metadata.treePriceVersion !== this.manifestHash || metadata.priceVersion !== this.manifestHash) fail('TEST_RESERVATION', 'Job model/version and ledger price manifest must agree');
    if (stage === 'repair' && (!metadata.failureId || !metadata.repairCommit || !metadata.retestPlanHash)) fail('TEST_REPAIR', 'Repair allowance requires a located failure, commit and frozen retest plan');
    return this.base.store.transaction(() => {
      this.assertCurrentAuthorization(); const prior = this.base.get(spec.requestId);
      if (prior && ['stage', 'treeJobId', 'treeInvocationId', 'role', 'budgetScope'].some(k => prior.metadata[k] !== metadata[k])) fail('TEST_OWNER', 'Request cannot switch role/stage/owner');
      const reserved = this.base.reserve(spec); // Reuses integer monetary arithmetic and the total hard cap.
      const stageMicro = this.base.list().filter(r => r.metadata?.stage === stage).reduce((n, r) => n + r.spentMicroCny + r.reservedMicroCny, 0);
      if (stageMicro > TEST_STAGE_CNY[stage] * 1000000) fail('TEST_STAGE_EXCEEDED', 'Stage spent + reserved + unknown exceeds its allowance');
      return reserved;
    });
  }
  get(id) { return this.base.get(id); }
  list() { return this.base.list(); }
  assertScope(id) {
    this.assertCurrentAuthorization(); this.base.assertScope(id);
    const record = this.get(id);
    if (record && (record.model !== this.manifest.model || record.metadata?.budgetScope !== this.scope || record.metadata?.treePriceVersion !== this.manifestHash ||
        record.metadata?.modelVersion !== this.manifest.modelVersion || !Object.hasOwn(TEST_STAGE_CNY, record.metadata?.stage) || !record.metadata?.treeJobId || !record.metadata?.treeInvocationId || !record.metadata?.role)) fail('TEST_OWNER', 'Saved receipt does not belong to this frozen experiment owner');
  }
  markDispatched(id) {
    return this.base.store.transaction(() => {
      this.assertCurrentAuthorization(); const record = this.get(id), active = this.list().filter(r => r.status === 'dispatched');
      if (active.length >= 2 || record?.metadata.role === 'script_writer' && active.some(r => r.metadata.role === 'script_writer')) fail('TEST_CONCURRENCY', 'At most two test requests and one writer may be in flight across all roles');
      return this.base.markDispatched(id);
    });
  }
  markUnknown(id, reason) { return this.base.markUnknown(id, reason); }
  releaseUnsent(id, reason) { return this.base.releaseUnsent(id, reason); }
  settle(id, usage) { return this.base.settle(id, usage); }
  summary() {
    const base = this.base.summary(), records = this.list();
    return { ...base, scope: this.scope, physicalScope: 'limited', manifestHash: this.manifestHash,
      unknownMicroCny: records.filter(r => r.status === 'unknown').reduce((n, r) => n + r.reservedMicroCny, 0),
      stages: Object.fromEntries(Object.entries(TEST_STAGE_CNY).map(([stage, ceilingCny]) => [stage, { ceilingCny, spentMicroCny: records.filter(r => r.metadata?.stage === stage).reduce((n, r) => n + r.spentMicroCny, 0), reservedMicroCny: records.filter(r => r.metadata?.stage === stage).reduce((n, r) => n + r.reservedMicroCny, 0) }])) };
  }
  modelPolicy() { return { contextWindow: this.manifest.inputBound, maxOutputTokens: this.manifest.outputCap, requestMaxTokens: this.manifest.outputCap, prices: jsonClone(this.manifest.prices), priceVersion: this.manifestHash, reasoningEfforts: ['off', 'low', 'high', 'max'] }; }
  close() { this.base.close(); }
}
