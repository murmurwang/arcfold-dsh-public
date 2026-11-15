// Exact model IDs implemented by the pinned official Responses translator.
// Deployment modelPolicies may expose a subset; unknown models never fall back.
export const OPENAI_MODELS = Object.freeze(['gpt-6-astra', 'gpt-6.1-sol']);
export const OPENAI_REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
