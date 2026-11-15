import { requireViewScope, viewScopeFields } from './browse-source.mjs';
// Matches the host acceptance limit; native ordinary uploads have their own policy.
export const IMPORT_MAX_FILE_BYTES = 805306368;
export function createImportSource({ rpc, fileUpload, sessionId, viewScope, subscribeReset, intervalMs = 5000 }) {
  viewScopeFields(viewScope);
  let snapshot = { loading: true, error: null, items: [], total: 0, offset: 0, nextOffset: null,
    canImport: viewScope === undefined ? undefined : false, readEpoch: 0 };
  let generation = 0, listRead, timer, reset, disposed = false;
  const listeners = new Set(), pending = new Set();
  const stopped = () => Object.assign(new Error('连接已经变化，请重新读取导入记录。'), { code: 'import_request_cancelled' });
  const publish = value => { snapshot = { ...snapshot, ...value }; for (const listener of listeners) listener(); };
  async function operation(fn) {
    if (disposed) throw stopped();
    const controller = new AbortController(), epoch = snapshot.readEpoch; pending.add(controller);
    try {
      const result = await fn(controller.signal);
      if (disposed || controller.signal.aborted || epoch !== snapshot.readEpoch) throw stopped();
      return result;
    } finally { pending.delete(controller); }
  }
  async function call(endpoint, request, signal) {
    const scope = ['list', 'details'].includes(endpoint) ? viewScopeFields(viewScope) : {};
    const result = await rpc.call('/api', `arcfoldImports/${endpoint}`, { args: { request: { ...request, sessionId, ...scope } } }, signal);
    if (result?.ok !== true) throw Object.assign(new Error(result?.error?.message || '导入操作未完成。'),
      { code: result?.error?.code || 'import_request_failed', remote: true });
    return result.value;
  }
  function invalidate() {
    listRead?.abort(); generation++;
    for (const controller of pending) controller.abort();
    publish({ loading: true, error: null, items: [], total: 0, offset: 0, nextOffset: null,
      canImport: viewScope === undefined ? undefined : false, readEpoch: snapshot.readEpoch + 1 });
  }
  async function refresh(offset = snapshot.offset) {
    if (disposed) return;
    listRead?.abort(); listRead = new AbortController();
    const current = ++generation, signal = listRead.signal;
    try {
      const result = await call('list', { offset, limit: 20 }, signal);
      if (!disposed && !signal.aborted && current === generation) publish({ ...result, offset, loading: false, error: null });
    } catch (error) {
      if (!disposed && !signal.aborted && current === generation) publish({ loading: false, error: error.message });
    }
  }
  function stop() { clearInterval(timer); timer = undefined; reset?.(); reset = undefined; invalidate(); }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      if (listeners.size === 1) {
        void refresh(); timer = setInterval(() => { void refresh(); }, intervalMs);
        reset = subscribeReset(() => { invalidate(); void refresh(0); });
      }
      return () => { listeners.delete(listener); if (!listeners.size) stop(); };
    },
    refresh,
    setViewScope(value) {
      requireViewScope(value);
      if (disposed || viewScope === value) return;
      viewScope = value; invalidate();
      if (listeners.size) void refresh(0);
    },
    details: request => operation(signal => call('details', request, signal)),
    prepare: request => operation(signal => call('prepare', request, signal)),
    confirm: request => operation(signal => call('confirm', request, signal)),
    withdraw: request => operation(signal => call('withdraw', request, signal)),
    upload(file, onProgress) {
      return operation(async signal => {
        if (!(file instanceof Blob) || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > IMPORT_MAX_FILE_BYTES)
          throw Object.assign(new Error('请选择不超过 768 MiB 的完整导出文件。'), { code: 'invalid_import_file', remote: true });
        // File/Blob preserves the native streaming path; do not read it into a byte array.
        const result = await fileUpload.upload(sessionId, file, file.name || 'arcfold-export.json', signal, onProgress);
        if (result?.ok !== true) throw Object.assign(new Error(result?.error?.message || '文件上传未完成。'),
          { code: result?.error?.code || 'import_upload_failed', remote: true });
        if (typeof result.value?.receiptId !== 'string' || result.value.file?.bytes !== file.size)
          throw new Error('上传回执与所选文件不一致，请查看记录后重新选择。');
        return result.value;
      });
    },
    dispose() { disposed = true; stop(); listeners.clear(); },
  };
}
