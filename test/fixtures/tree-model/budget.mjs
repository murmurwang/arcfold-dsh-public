import { digest } from '../../../src/tree/contracts.mjs';
import { TREE_TEST_SCOPE } from '../../../src/tree/experiment-budget.mjs';
export const manifest = { budgetScope: TREE_TEST_SCOPE, ceilingCny: 150, model: 'deepseek-flash', modelVersion: 'synthetic-offline-fixture-not-live-version-proof', prices: { input: 2, output: 8, cachedInput: 0.04 }, inputBound: 1000000, outputCap: 8192, verification: { at: '2026-11-12T00:00:00.000Z', urls: ['https://example.test/synthetic-offline-pricing'], contentHashes: [digest('synthetic-only')], adapterVersion: 'deepseek-messages-create-transport-v1' } };
export const authorizationRef = 'offline-fixture-150-not-real-spend';
export function reservation(id, stage = 'smoke', policy = manifest) {
  return { requestId: id, bodyHash: digest(id), model: policy.model, inputTokenCeiling: policy.inputBound, maxOutputTokens: policy.outputCap, prices: policy.prices,
    metadata: { budgetScope: TREE_TEST_SCOPE, modelVersion: policy.modelVersion, treePriceVersion: digest(policy), priceVersion: digest(policy), stage, treeJobId: `job-${id}`, treeInvocationId: `invocation-${id}`, role: 'learning', ...(stage === 'repair' ? { failureId: 'synthetic-failure', repairCommit: digest('synthetic-commit'), retestPlanHash: digest('synthetic-plan') } : {}) } };
}
