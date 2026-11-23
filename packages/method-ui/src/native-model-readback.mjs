// Native selection is already committed before its directory becomes ready.
// Read that committed state once; the host's own receiver retains seq ordering.
export function watchNativeModelReadback({ directory, sessionId, sessions, remote, generation, isCurrent,
  onError = () => {} }) {
  let disposed = false, pending, epoch = 0, read;
  const invalidate = () => { epoch++; pending = undefined; read?.abort(); read = undefined; };
  const current = (operation, hostGeneration) => !disposed && operation === epoch
    && hostGeneration !== undefined && generation.getSnapshot() === hostGeneration && isCurrent();
  const changed = () => {
    const state = directory.store.getSnapshot();
    if (state.status === 'selecting' && state.pending) {
      if (pending !== state.pending) { invalidate(); pending = state.pending; }
      return;
    }
    if (!pending) return;
    if (state.status !== 'ready' || state.error || state.pending) { invalidate(); return; }
    pending = undefined;
    const operation = epoch, hostGeneration = generation.getSnapshot();
    if (!current(operation, hostGeneration)) return;
    const controller = read = new AbortController();
    void (async () => {
      try {
        const reply = await remote.projections({ sessionId }, controller.signal);
        if (!current(operation, hostGeneration)) return;
        const value = reply?.ok === true ? reply.value : null;
        if (value?.kind !== 'sequenced' || !Number.isSafeInteger(value.asOfSeq) || value.asOfSeq < 0
            || !value.values?.modelSelection) throw new Error('Native model state unavailable');
        sessions.handleControlFrame({ type: 'baseline', value: { projections: {
          [sessionId]: { asOfSeq: value.asOfSeq, values: value.values },
        } } });
      } catch {
        // No optimistic value, retry, or raw Remote error (which may carry data).
        if (current(operation, hostGeneration)) onError('NATIVE_MODEL_READBACK_FAILED');
      } finally { if (read === controller) read = undefined; }
    })();
  };
  const stopDirectory = directory.store.subscribe(changed);
  const stopGeneration = generation.subscribe(invalidate);
  return () => { disposed = true; invalidate(); stopDirectory(); stopGeneration(); };
}

/** Attach only to sessions whose Arcfold views are materialized. Dependencies
 * can arrive after this UI and may be replaced during an in-place update. */
export function installNativeModelReadback(ctx) {
  const requested = new Set(), watches = new Map();
  let attach;
  const clear = () => { for (const watch of watches.values()) watch.stop(); watches.clear(); };
  ctx.effect(() => {
    ctx.inject(['modelDirectories', 'sessions', 'remote.session'], owner => {
      const sessions = owner.sessions, models = owner.modelDirectories;
      const bind = sessionId => {
        const binding = sessions.binding(sessionId), prior = watches.get(sessionId);
        const main = () => binding?.session.projections.faceOf('agentPreset').getSnapshot() === 'arcfold-main'
          && sessions.subagentAddress(sessionId) === undefined;
        if (prior?.binding === binding && main()) return;
        prior?.stop(); watches.delete(sessionId);
        if (!binding || !main()) return;
        const directory = models.directoryFor(sessionId);
        const stop = watchNativeModelReadback({ directory, sessionId, sessions, remote: owner.remote.session,
          generation: owner.connection.generation, isCurrent: () => sessions.binding(sessionId) === binding && main(),
          onError: code => console.warn('[arcfold] ' + code) });
        watches.set(sessionId, { binding, stop });
      };
      attach = bind;
      for (const id of requested) bind(id);
      owner.effect(() => {
        const stop = sessions.list.subscribe(() => { for (const id of requested) bind(id); });
        return () => { if (attach === bind) attach = undefined; stop(); clear(); };
      }, 'Arcfold native model readback bindings');
    });
    return () => { attach = undefined; clear(); requested.clear(); };
  }, 'Arcfold native model readback');
  return sessionId => { requested.add(sessionId); attach?.(sessionId); };
}
