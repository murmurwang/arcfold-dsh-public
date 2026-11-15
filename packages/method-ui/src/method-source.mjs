import { requireViewScope, viewScopeFields } from './browse-source.mjs';
const CHANNEL = '/api';
export async function callMethod(rpc, endpoint, payload, signal) {
  const result = await rpc.call(CHANNEL, `arcfoldMethods/${endpoint}`, { args: { request: payload } }, signal);
  if (result?.ok !== true) throw Object.assign(new Error(result?.error?.message || '方法请求未完成。'),
    { code: result?.error?.code || 'method_request_failed', remote: true });
  return result.value;
}

// One UI-owned read cache, not a second business queue. It exists only while observed.
export function createMethodSource({ rpc, sessionId, viewScope, subscribeReset, intervalMs = 5000 }) {
  viewScopeFields(viewScope);
  let snapshot = { loading: true, error: null, items: [], total: 0, decisionCount: 0,
    nextOffset: null, offset: 0, unreadCount: 0, readEpoch: 0 };
  const listeners = new Set(), reads = new Set();
  let generation = 0, controller, timer, reset, disposed = false;
  const publish = value => { snapshot = { ...snapshot, ...value }; for (const listener of listeners) listener(); };
  const scope = () => viewScope === undefined ? {} : { sessionId, ...viewScopeFields(viewScope) };
  const cancelled = () => Object.assign(new Error('查看范围已变化，请重新打开方法。'), { code: 'method_read_cancelled' });
  function invalidateReads() {
    controller?.abort(); generation++;
    for (const read of reads) read.abort();
    publish({ loading: true, error: null, items: [], total: 0, decisionCount: 0,
      nextOffset: null, offset: 0, unreadCount: 0, readEpoch: snapshot.readEpoch + 1 });
  }
  async function refresh(offset = snapshot.offset) {
    if (disposed) return;
    controller?.abort(); controller = new AbortController();
    const current = ++generation, signal = controller.signal;
    try {
      const cards = await callMethod(rpc, 'cards', { offset, limit: 20, ...scope() }, signal);
      if (current !== generation || signal.aborted || disposed) return;
      publish({ loading: false, error: null, items: cards.items, total: cards.total,
        decisionCount: cards.decisionCount, nextOffset: cards.nextOffset, offset, unreadCount: cards.unreadCount });
    } catch (error) {
      if (current === generation && !signal.aborted && !disposed)
        publish({ loading: false, error: error instanceof Error ? error.message : '读取方法失败。' });
    }
  }
  function stop() {
    clearInterval(timer); timer = undefined; reset?.(); reset = undefined;
    invalidateReads();
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      if (listeners.size === 1) {
        void refresh();
        timer = setInterval(() => { void refresh(); }, intervalMs);
        reset = subscribeReset(() => { invalidateReads(); void refresh(0); });
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
    async details(methodId, offset = 0) {
      if (disposed) throw cancelled();
      const read = new AbortController(), epoch = snapshot.readEpoch; reads.add(read);
      try {
        const value = await callMethod(rpc, 'cardDetails', { methodId, offset, limit: 20, ...scope() }, read.signal);
        if (disposed || read.signal.aborted || epoch !== snapshot.readEpoch) throw cancelled();
        return value;
      } finally { reads.delete(read); }
    },
    async acknowledge(notificationId) {
      const result = await callMethod(rpc, 'acknowledge', { notificationId });
      await refresh(); return result;
    },
    async decide(request) {
      const result = await callMethod(rpc, 'decide', request);
      await refresh(); return result;
    },
    dispose() { disposed = true; stop(); listeners.clear(); },
  };
}
