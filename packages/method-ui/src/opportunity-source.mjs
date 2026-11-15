import { requireViewScope, viewScopeFields } from './browse-source.mjs';
export async function callOpportunity(rpc, endpoint, payload, signal) {
  const result = await rpc.call('/api', `arcfoldOpportunities/${endpoint}`, { args: { request: payload } }, signal);
  if (result?.ok !== true) throw Object.assign(new Error(result?.error?.message ?? '机会请求未完成。'), { code: result?.error?.code ?? 'opportunity_request_failed', remote: true });
  return result.value;
}
export function createOpportunitySource({ rpc, sessionId, viewScope, subscribeReset, intervalMs = 5000 }) {
  viewScopeFields(viewScope);
  let state = { items: [], total: 0, offset: 0, nextOffset: null, loading: true, permission: null, error: null, resetVersion: 0 };
  let generation = 0, disposed = false, controller, timer, reset; const listeners = new Set(), reads = new Set();
  const publish = value => { state = { ...state, ...value }; for (const listener of listeners) listener(); };
  function invalidateReads() {
    controller?.abort(); generation++;
    for (const read of reads) read.abort();
    publish({ items: [], total: 0, offset: 0, nextOffset: null, loading: true, permission: null,
      canPrepare: false, canContinue: false, error: null, resetVersion: state.resetVersion + 1 });
  }
  async function refresh(offset = state.offset) {
    if (disposed) return; controller?.abort(); controller = new AbortController(); const signal = controller.signal, current = ++generation;
    try { const value = await callOpportunity(rpc, 'list', { sessionId, offset, limit: 20, ...viewScopeFields(viewScope) }, signal);
      if (!disposed && current === generation && !signal.aborted) publish({ ...value, offset, loading: false, error: null });
    } catch (error) { if (!disposed && current === generation && !signal.aborted) publish({ loading: false, error: error.message }); }
  }
  const assertLive = () => { if (disposed) throw Object.assign(new Error('机会视图已关闭。'), { code: 'opportunity_view_disposed' }); };
  const stop = () => { clearInterval(timer); timer = undefined; reset?.(); reset = null; invalidateReads(); };
  return {
    getSnapshot: () => state,
    subscribe(listener) { if (disposed) return () => {}; listeners.add(listener);
      if (listeners.size === 1) { void refresh(); timer = setInterval(() => { void refresh(); }, intervalMs); reset = subscribeReset(() => { invalidateReads(); void refresh(0); }); }
      return () => { listeners.delete(listener); if (!listeners.size) stop(); }; },
    refresh,
    setViewScope(value) {
      requireViewScope(value);
      if (disposed || viewScope === value) return;
      viewScope = value; invalidateReads();
      if (listeners.size) void refresh(0);
    },
    async details(opportunityId) {
      assertLive(); const version = state.resetVersion, read = new AbortController(); reads.add(read);
      try {
        const value = await callOpportunity(rpc, 'details', { sessionId, opportunityId, ...viewScopeFields(viewScope) }, read.signal);
        assertLive();
        if (read.signal.aborted || version !== state.resetVersion)
          throw Object.assign(new Error('查看范围或连接已变化，请重新查看机会。'), { code: 'opportunity_view_reset' });
        return value;
      } finally { reads.delete(read); }
    },
    source: sourceId => { assertLive(); return callOpportunity(rpc, 'source', { sourceId }); },
    async act(endpoint, request) {
      assertLive();
      const payload = ['savePermission', 'continue'].includes(endpoint) ? { ...request, sessionId } : request;
      const value = await callOpportunity(rpc, endpoint, payload); await refresh(); return value;
    },
    dispose() { disposed = true; stop(); listeners.clear(); },
  };
}
