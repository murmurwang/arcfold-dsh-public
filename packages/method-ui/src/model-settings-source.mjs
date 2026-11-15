// A visible-page read cache. Credentials and mutations never enter its snapshot.
const PROVIDERS = new Set(['deepseek-official', 'openai']);
const own = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const refused = code => ({ status: 'refused', code });
const remoteCode = code => ['revision_conflict', 'learning_defaults_conflict'].includes(code) ? 'conflict' : 'refused';
export function deployedRoutes(data) {
  return (data?.routes || []).filter(route => PROVIDERS.has(route.provider));
}
export function validLearningChoice(data, request) {
  const route = deployedRoutes(data).find(row => row.provider === request.provider);
  const model = route?.models?.find(row => row.id === request.model);
  return Boolean(model?.reasoningEfforts?.includes(request.reasoningEffort));
}

export function createModelSettingsSource({ rpc, subscribeReset }) {
  let snapshot = { loading: false, data: null, error: null, credentials: {}, credentialError: false };
  const listeners = new Set();
  let generation = 0, readController, mutationController, reset, disposed = false, writing = false;
  const publish = patch => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };
  const active = () => !disposed && listeners.size > 0;
  async function refresh() {
    if (!active()) return false;
    readController?.abort();
    const controller = new AbortController(), current = ++generation;
    readController = controller;
    const stillCurrent = () => active() && current === generation && !controller.signal.aborted;
    publish({ loading: true, error: null });
    try {
      const reply = await rpc.call('/api', 'arcfoldModels/read', { args: { request: {} } }, controller.signal);
      if (reply?.ok !== true) throw new Error('read refused');
      if (!stillCurrent()) return false;
      const data = reply.value;
      const refs = [...new Set(deployedRoutes(data).map(route => route.apiKeyRef))];
      let credentials = {}, credentialError = false;
      if (refs.length) {
        try {
          const result = await rpc.call('/api', 'credentials/describe', { args: { refs } }, controller.signal);
          if (result?.ok !== true) throw new Error('credential metadata refused');
          credentials = Object.fromEntries(refs.map(ref => {
            const value = result.value?.[ref];
            return [ref, { configured: value?.configured === true, writable: value?.writable === true,
              ...(typeof value?.source === 'string' ? { source: value.source } : {}) }];
          }));
        } catch { credentialError = true; }
      }
      if (!stillCurrent()) return false;
      publish({ loading: false, data, error: null, credentials, credentialError });
      return true;
    } catch {
      if (stillCurrent()) publish({ loading: false, error: 'read_failed' });
      return false;
    }
  }
  function stop() {
    reset?.(); reset = undefined;
    readController?.abort(); mutationController?.abort(); generation++;
  }
  async function mutate(endpoint, args, credential = false) {
    if (!active() || writing) return refused('unavailable');
    writing = true;
    const controller = new AbortController();
    mutationController = controller;
    try {
      const result = await rpc.call('/api', endpoint, { args }, controller.signal);
      if (result?.ok !== true) {
        const code = credential ? 'credential_refused' : remoteCode(result?.error?.code);
        await refresh();
        return refused(code);
      }
      const refreshed = await refresh();
      return { status: 'saved', refreshed };
    } catch {
      // No exception, response details or input value is retained or rethrown.
      return { status: 'unknown', code: credential ? 'credential_unknown' : 'unknown' };
    } finally {
      writing = false;
      if (mutationController === controller) mutationController = undefined;
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      if (listeners.size === 1) {
        reset = subscribeReset(() => { void refresh(); });
        void refresh();
      }
      return () => { listeners.delete(listener); if (!listeners.size) stop(); };
    },
    refresh,
    saveLearning(request) {
      const data = snapshot.data;
      if (!own(request, ['expectedRevision', 'provider', 'model', 'reasoningEffort']) ||
          !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1 ||
          data?.gate?.phase !== 'ready' || snapshot.error || snapshot.loading ||
          !data?.learning?.enabled || !data.learning.defaults ||
          !validLearningChoice(data, request)) return Promise.resolve(refused('unavailable'));
      return mutate('arcfoldModels/saveLearning', { request: { ...request } });
    },
    storeCredential(provider, value) {
      const route = deployedRoutes(snapshot.data).find(row => row.provider === provider);
      if (!route || !snapshot.credentials[route.apiKeyRef]?.writable || snapshot.error || snapshot.loading ||
          typeof value !== 'string' || !value.trim()) return Promise.resolve(refused('credential_unavailable'));
      return mutate('credentials/set', { ref: route.apiKeyRef, value }, true);
    },
    removeCredential(provider) {
      const route = deployedRoutes(snapshot.data).find(row => row.provider === provider);
      if (!route || !snapshot.credentials[route.apiKeyRef]?.writable || snapshot.error || snapshot.loading)
        return Promise.resolve(refused('credential_unavailable'));
      return mutate('credentials/unset', { ref: route.apiKeyRef }, true);
    },
    dispose() { disposed = true; stop(); listeners.clear(); },
  };
}
