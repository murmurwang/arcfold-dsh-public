/** Browser reads may refresh; writes never retry automatically. */
export function createTreeSource({ rpc, sessionId, subscribeReset = () => () => {}, intervalMs = 5000 }) {
  let snapshot = { loading: true, error: null, nodes: [], treeRevision: 0, current: { paths: [], turnIds: [] }, operations: {}, selection: null, epoch: 0, refreshRevision: 0 };
  let disposed = false, generation = 0, timer, reset;
  const listeners = new Set(), reads = new Set(), writes = new Map(), pending = new Map();
  const stopped = () => Object.assign(new Error('连接已结束，请重新打开。'), { code: 'TREE_READ_CANCELLED' });
  const publish = patch => { snapshot = { ...snapshot, ...patch }; listeners.forEach(listener => listener()); };
  const operation = (id, value) => publish({ operations: { ...snapshot.operations, [id]: { ...snapshot.operations[id], ...value } } });
  async function call(endpoint, payload, signal) {
    if (disposed) throw stopped();
    const result = await rpc.call('/api', 'arcfoldTreeV3/' + endpoint, { args: { request: { ...payload, sessionId } } }, signal);
    if (result?.ok !== true) throw Object.assign(new Error(result?.error?.message ?? '请求未确认，请读取操作记录。'), { code: result?.error?.code ?? 'TREE_UNKNOWN', remote: result?.ok === false });
    return result.value;
  }
  async function read(endpoint, payload = {}) {
    const controller = new AbortController(), epoch = snapshot.epoch; reads.add(controller);
    try { const result = await call(endpoint, payload, controller.signal); if (disposed || controller.signal.aborted || snapshot.epoch !== epoch) throw stopped(); return result; }
    finally { reads.delete(controller); }
  }
  function invalidate() { generation++; reads.forEach(c => c.abort()); publish({ epoch: snapshot.epoch + 1, nodes: [], selection: null, current: { paths: [], turnIds: [] }, loading: true }); }
  async function refresh() {
    if (disposed) return; const serial = ++generation;
    try {
      // Read every stable page. A mid-read revision conflict is visible and
      // does not splice two revisions of the tree into a misleading view.
      let nodes = [], cursor, treeRevision;
      do { const page = await read('tree.list', { ...(cursor ? { cursor } : {}), limit: 100 }); nodes.push(...page.nodes); cursor = page.nextCursor; treeRevision = page.treeRevision; } while (cursor);
      const current = await read('session.current');
      if (!disposed && serial === generation) publish({ nodes, current, treeRevision, loading: false, error: null, refreshRevision: snapshot.refreshRevision + 1 });
    } catch (error) { if (!disposed && serial === generation) publish({ loading: false, error: error.message }); }
  }
  async function readback(requestId) {
    const receipt = await read('receipts.read', { requestId }); operation(requestId, { state: receipt.state, receipt });
    if (['success', 'completed'].includes(receipt.state)) { pending.delete(requestId); void refresh(); }
    return receipt;
  }
  function act(endpoint, payload, requestId = globalThis.crypto.randomUUID()) {
    const hash = JSON.stringify([endpoint, payload]);
    const old = writes.get(requestId); if (old) {
      if (old.hash !== hash) return Promise.reject(Object.assign(new Error('这次提交编号已用于另一项操作。'), { code: 'IDEMPOTENCY_CONFLICT' }));
      return old.promise;
    }
    const controller = new AbortController(); pending.set(requestId, { endpoint, payload, hash }); operation(requestId, { endpoint, state: 'pending', message: '正在提交，尚未确认' });
    const promise = (async () => {
      try { const receipt = await call(endpoint, { ...payload, requestId }, controller.signal); operation(requestId, { state: receipt.state, receipt, message: receipt.state === 'success' ? '已保存' : '结果尚待确认' }); if (receipt.state === 'success') pending.delete(requestId); await refresh(); return receipt; }
      catch (error) {
        operation(requestId, { state: error.remote ? 'conflict' : 'unknown', message: error.message, code: error.code });
        // Lost replies may follow a successful server mutation. Only read its
        // receipt; a missing receipt is not permission to resend the write.
        if (!error.remote && !disposed) { try { const found = await readback(requestId); if (found.state === 'success') return found; } catch {} }
        throw error;
      }
    })(); writes.set(requestId, { hash, promise, controller }); return promise;
  }
  function stop() { clearInterval(timer); timer = undefined; reset?.(); reset = undefined; }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { if (disposed) return () => {}; listeners.add(listener); if (listeners.size === 1) { void refresh(); timer = setInterval(() => void refresh(), intervalMs); reset = subscribeReset(() => { invalidate(); void refresh(); for (const id of pending.keys()) void readback(id).catch(() => {}); }); } return () => { listeners.delete(listener); if (!listeners.size) stop(); }; },
    read, act, readback, refresh,
    select: nodeId => publish({ selection: nodeId }),
    openDetails: nodeId => publish({ selection: nodeId, detailsNodeId: nodeId }),
    closeDetails: () => publish({ detailsNodeId: null }),
    dispose() { disposed = true; stop(); reads.forEach(c => c.abort()); writes.forEach(w => w.controller.abort()); listeners.clear(); },
  };
}
