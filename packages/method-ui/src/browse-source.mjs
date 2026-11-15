// Browsing changes a read projection, never a record's scope or an action's authority.
export function viewScopeFields(viewScope) {
  if (viewScope !== undefined && !['all', 'current'].includes(viewScope))
    throw new TypeError('Unknown Arcfold view scope');
  return viewScope === undefined ? {} : { viewScope };
}

export function requireViewScope(viewScope) {
  if (viewScope === undefined) throw new TypeError('A view scope is required');
  viewScopeFields(viewScope);
}

export function createBrowseScopeSource(sources) {
  let snapshot = { viewScope: 'all', epoch: 0 }, disposed = false;
  const listeners = new Set();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener); return () => listeners.delete(listener);
    },
    setViewScope(viewScope) {
      requireViewScope(viewScope);
      if (disposed || snapshot.viewScope === viewScope) return;
      for (const source of sources) source.setViewScope?.(viewScope);
      snapshot = { viewScope, epoch: snapshot.epoch + 1 };
      for (const listener of listeners) listener();
    },
    dispose() { disposed = true; listeners.clear(); },
  };
}
