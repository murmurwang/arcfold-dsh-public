import { requireViewScope, viewScopeFields } from './browse-source.mjs';
export async function callGoal(rpc, endpoint, payload, signal) {
  const result = await rpc.call('/api', `arcfoldGoals/${endpoint}`, { args: { request: payload } }, signal);
  if (result?.ok !== true) throw Object.assign(new Error(result?.error?.message || '目标请求未完成。'),
    { code: result?.error?.code || 'goal_request_failed', remote: true });
  return result.value;
}

// Read-only UI cache. Mutations occur only in explicit click handlers.
export function createGoalSource({ rpc, sessionId, viewScope, subscribeReset, intervalMs = 5000 }) {
  viewScopeFields(viewScope);
  let snapshot = { loading: true, error: null, items: [], works: [], total: 0, offset: 0, nextOffset: null, readEpoch: 0 };
  let generation = 0, controller, timer, reset, disposed = false;
  const listeners = new Set(), reads = new Set();
  const publish = value => { snapshot = { ...snapshot, ...value }; for (const listener of listeners) listener(); };
  const cancelled = () => Object.assign(new Error('查看范围已变化，请重新打开目标。'), { code: 'goal_read_cancelled' });
  function invalidateReads({ clear = true } = {}) {
    controller?.abort(); generation++;
    for (const read of reads) read.abort();
    publish({ loading: true, error: null, readEpoch: snapshot.readEpoch + 1,
      ...(clear ? { items: [], works: [], total: 0, offset: 0, nextOffset: null, canDiscuss: false } : {}) });
  }
  async function refresh(offset = snapshot.offset) {
    if (disposed) return;
    controller?.abort(); controller = new AbortController();
    const current = ++generation, signal = controller.signal;
    try {
      const result = await callGoal(rpc, 'list', { sessionId, offset, limit: 20, ...viewScopeFields(viewScope) }, signal);
      if (current !== generation || signal.aborted || disposed) return;
      publish({ ...result, offset, loading: false, error: null });
    } catch (error) {
      if (current === generation && !signal.aborted && !disposed)
        publish({ loading: false, error: error instanceof Error ? error.message : '读取目标失败。' });
    }
  }
  function stop() { clearInterval(timer); timer = undefined; reset?.(); reset = undefined; invalidateReads(); }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      if (listeners.size === 1) {
        void refresh(); timer = setInterval(() => { void refresh(); }, intervalMs);
        // A reconnect invalidates pending reads, but does not erase the user's
        // unsent goal discussion. A changed goal revision still makes it stale.
        reset = subscribeReset(() => { invalidateReads({ clear: false }); void refresh(); });
      }
      return () => { listeners.delete(listener); if (!listeners.size) stop(); };
    },
    refresh,
    setViewScope(value) {
      requireViewScope(value);
      if (disposed || viewScope === value) return;
      viewScope = value; invalidateReads();
      if (listeners.size) void refresh(0);
    },
    async details(goalId) {
      if (disposed) throw cancelled();
      const read = new AbortController(), epoch = snapshot.readEpoch; reads.add(read);
      try {
        const value = await callGoal(rpc, 'details', { goalId, sessionId, ...viewScopeFields(viewScope) }, read.signal);
        if (disposed || read.signal.aborted || epoch !== snapshot.readEpoch) throw cancelled();
        return value;
      } finally { reads.delete(read); }
    },
    async decide(request) { const result = await callGoal(rpc, 'decide', request); await refresh(); return result; },
    async stopWork(request) { const result = await callGoal(rpc, 'stopWork', { ...request, sessionId }); await refresh(); return result; },
    async resumeWork(request) { const result = await callGoal(rpc, 'resumeWork', { ...request, sessionId }); await refresh(); return result; },
    discuss: request => callGoal(rpc, 'discuss', { ...request, sessionId }),
    dispose() { disposed = true; stop(); listeners.clear(); },
  };
}
