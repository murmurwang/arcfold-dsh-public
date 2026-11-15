import { requireViewScope, viewScopeFields } from './browse-source.mjs';
// Refresh and reconnect only read. Every write has an explicit UI caller.
export function createUnderstandingSource({ rpc, sessionId, viewScope, subscribeReset, intervalMs = 5000 }) {
  viewScopeFields(viewScope);
  let snapshot = { loading: true, error: null, items: [], total: 0, offset: 0, nextOffset: null, readEpoch: 0 };
  let generation = 0, controller, timer, reset, disposed = false;
  const listeners = new Set(), reads = new Set();
  const stopped = () => Object.assign(new Error('这次读取已经结束，请重新打开。'), { code: 'understanding_read_cancelled' });
  const call = async (endpoint, payload, signal) => {
    if (disposed) throw stopped();
    const scope = ['list', 'details'].includes(endpoint) ? viewScopeFields(viewScope) : {};
    const result = await rpc.call('/api', `arcfoldUnderstandings/${endpoint}`, { args: { request: { ...payload, sessionId, ...scope } } }, signal);
    if (result?.ok !== true) throw Object.assign(new Error(result?.error?.message || '理解请求未完成。'),
      { code: result?.error?.code || 'understanding_request_failed', remote: true });
    return result.value;
  };
  const publish = value => { snapshot = { ...snapshot, ...value }; for (const listener of listeners) listener(); };
  function invalidateReads() {
    controller?.abort(); generation++;
    for (const read of reads) read.abort();
    publish({ loading: true, error: null, items: [], total: 0, offset: 0, nextOffset: null, readEpoch: snapshot.readEpoch + 1 });
  }
  async function refresh(offset = snapshot.offset) {
    if (disposed) return;
    controller?.abort(); controller = new AbortController();
    const current = ++generation, signal = controller.signal;
    try {
      const result = await call('list', { offset, limit: 20 }, signal);
      if (current === generation && !disposed && !signal.aborted) publish({ ...result, offset, loading: false, error: null });
    } catch (error) {
      if (current === generation && !disposed && !signal.aborted) publish({ loading: false, error: error.message });
    }
  }
  async function details(understandingId) {
    if (disposed) throw stopped();
    const read = new AbortController(), epoch = snapshot.readEpoch; reads.add(read);
    try {
      const result = await call('details', { understandingId }, read.signal);
      if (disposed || read.signal.aborted || epoch !== snapshot.readEpoch) throw stopped();
      return result;
    } finally { reads.delete(read); }
  }
  function stop() { clearInterval(timer); timer = undefined; reset?.(); reset = undefined; invalidateReads(); }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      if (listeners.size === 1) { void refresh(); timer = setInterval(() => { void refresh(); }, intervalMs);
        reset = subscribeReset(() => { invalidateReads(); void refresh(0); }); }
      return () => { listeners.delete(listener); if (!listeners.size) stop(); };
    },
    refresh, details,
    setViewScope(value) {
      requireViewScope(value);
      if (disposed || viewScope === value) return;
      viewScope = value; invalidateReads();
      if (listeners.size) void refresh(0);
    },
    decide: request => call('decide', request),
    correct: request => call('correct', request),
    dispose() { disposed = true; stop(); listeners.clear(); },
  };
}
