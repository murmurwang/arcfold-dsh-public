import React, { useEffect, useRef, useState } from 'react';
import { deployedRoutes, validLearningChoice } from './model-settings-source.mjs';
const h = React.createElement;
const PHASE_LABELS = { ready: 'modelsPhaseReady', starting: 'modelsPhaseStarting',
  'requires-restart': 'modelsPhaseRestart', failed: 'modelsPhaseFailed', closed: 'modelsPhaseClosed' };
const REASON_LABELS = {
  'main-not-configured': 'modelsReasonNoModel', 'learn-not-configured': 'modelsReasonNoModel',
  'native-credential-not-configured': 'modelsReasonCredential',
  'transport-not-configured': 'modelsReasonUnsupported', 'selected-route-not-supported': 'modelsReasonUnsupported',
  'selected-model-controls-unavailable': 'modelsReasonUnsupported', 'main-output-limit-unavailable': 'modelsReasonUnsupported',
  'selection-outside-model-policy': 'modelsReasonUnsupported', 'model-catalog-controls-invalid': 'modelsReasonUnsupported',
  'model-catalog-has-no-common-controls': 'modelsReasonUnsupported',
  'native-selection-changed-during-status': 'modelsReasonChanged', 'learning-selection-changed-during-status': 'modelsReasonChanged',
  'runtime-not-ready': 'modelsReasonNotReady', 'runtime-readiness-unavailable': 'modelsReasonNotReady',
  'guard-unavailable': 'modelsReasonNotReady', 'startup-failed': 'modelsReasonNotReady', 'runtime-closed': 'modelsReasonNotReady',
  'runtime-restart-required': 'modelsReasonRestart', 'critical-component-changed': 'modelsReasonRestart',
  'critical-configuration-changed': 'modelsReasonRestart', 'model-topology-changed': 'modelsReasonRestart',
};
const EFFORT_LABELS = { off: 'modelsEffortOff', low: 'modelsEffortLow', medium: 'modelsEffortMedium',
  high: 'modelsEffortHigh', xhigh: 'modelsEffortXHigh', max: 'modelsEffortMax' };
const reasonText = (reason, t) => t(REASON_LABELS[reason] || 'modelsReasonUnknown');
const effortText = (effort, t) => t(EFFORT_LABELS[effort] || 'modelsEffortOther');
const selectionText = (value, t) => value ? [value.provider, value.model,
  value.reasoningEffort ? effortText(value.reasoningEffort, t) : null].filter(Boolean).join(' · ') : '';
function outcomeText(result, t, credential = false) {
  if (result?.status === 'saved') return t(result.refreshed ? 'modelsSaved' : 'modelsSavedUnread');
  if (credential) return t(result?.status === 'unknown' ? 'modelsCredentialUnknown' : 'modelsCredentialFailed');
  return t(result?.status === 'unknown' ? 'modelsUnknown' : result?.code === 'conflict' ? 'modelsConflict' : 'modelsRefused');
}
function CredentialCard({ route, info, disabled, readFailed, onStore, onRemove, t }) {
  const [draft, setDraft] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const pending = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function write(remove) {
    if (pending.current || disabled || !info?.writable) return;
    pending.current = true; setBusy(true); setNotice('');
    const value = draft;
    setDraft('');
    try {
      const result = remove ? await onRemove(route.provider) : await onStore(route.provider, value);
      if (mounted.current) setNotice(outcomeText(result, t, true));
    } catch {
      if (mounted.current) setNotice(t('modelsCredentialUnknown'));
    } finally {
      pending.current = false;
      if (mounted.current) { setDraft(''); setBusy(false); }
    }
  }
  return h('article', { className: 'model-card' }, h('h3', null, route.label),
    h('p', null, readFailed ? t('modelsCredentialReadFailed') : t(info?.configured ? 'modelsConfigured' : 'modelsNotConfigured')),
    info?.source && h('p', { className: 'meta' }, t('modelsSource') + ': ' + info.source),
    !readFailed && !info?.writable && h('p', null, t('modelsReadOnly')),
    h('label', null, route.label + ' · ' + t('modelsCredential'),
      h('input', { type: 'password', value: draft, autoComplete: 'new-password', spellCheck: false,
        disabled: disabled || busy || !info?.writable,
        onChange: event => setDraft(event.target.value) })),
    h('div', { className: 'actions' },
      h('button', { type: 'button', disabled: disabled || busy || !info?.writable || !draft.trim(), onClick: () => { void write(false); } }, t('modelsCredentialSave')),
      h('button', { type: 'button', disabled: disabled || busy || !info?.writable || !info?.configured, onClick: () => { void write(true); } }, t('modelsCredentialRemove')),
      h('button', { type: 'button', onClick: () => { setDraft(''); setNotice(''); } }, t('modelsCredentialCancel'))),
    notice && h('p', { role: 'status' }, notice));
}
function Usage({ route, t }) {
  const usage = route.usage;
  const scope = { limited: 'modelsScopeLimited', 'web-unlimited': 'modelsScopeWeb', 'web-openai': 'modelsScopeOpenai' };
  const row = (label, value) => h('div', { key: label }, h('dt', null, t(label)), h('dd', null, value));
  return h('article', { className: 'model-card' }, h('h3', null, route.label),
    !usage ? h('p', null, t('modelsUsageMissing')) : h(React.Fragment, null,
      h('p', { className: 'meta' }, scope[usage.scope] ? t(scope[usage.scope]) : usage.scope),
      h('dl', null, row('modelsRequests', usage.requests), row('modelsUnknownCount', usage.unknownCount),
        usage.accounting === 'cny' ? [
          row('modelsSpent', '¥ ' + usage.spentCny), row('modelsReserved', '¥ ' + usage.reservedCny),
          row('modelsCeiling', usage.ceilingCny === null ? t('modelsNoCeiling') : '¥ ' + usage.ceilingCny),
        ] : [
          row('modelsPrompt', usage.promptTokens), row('modelsCompletion', usage.completionTokens),
          row('modelsCached', usage.cachedTokens), row('modelsPending', usage.pendingCount),
        ]),
      usage.accounting === 'tokens_only' && h('p', null, t('modelsTokensOnly'))));
}
function LearningForm({ data, disabled, onSave, t }) {
  const defaults = data.learning?.defaults;
  const [draft, setDraft] = useState(() => ({ ...defaults }));
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const pending = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setDraft({ ...defaults }); }, [defaults?.revision, defaults?.provider, defaults?.model, defaults?.reasoningEffort]);
  const routes = deployedRoutes(data), route = routes.find(row => row.provider === draft.provider);
  const model = route?.models?.find(row => row.id === draft.model);
  const blocked = disabled || busy || data.gate?.phase !== 'ready' || !data.learning?.enabled ||
    !defaults;
  const select = (label, value, options, update) => h('label', { key: label }, t(label),
    h('select', { value: options.some(item => item.id === value) ? value : '', disabled: blocked,
      onChange: event => update(event.target.value) },
    h('option', { value: '', disabled: true }, t('modelsChoose')),
    options.map(item => h('option', { key: item.id, value: item.id }, item.label || item.id))));
  async function save() {
    if (pending.current || blocked || !validLearningChoice(data, draft)) return;
    pending.current = true; setBusy(true); setNotice('');
    try {
      const result = await onSave({ expectedRevision: defaults.revision, provider: draft.provider,
        model: draft.model, reasoningEffort: draft.reasoningEffort });
      if (mounted.current) setNotice(outcomeText(result, t));
    } catch { if (mounted.current) setNotice(t('modelsUnknown')); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  return h('div', null,
    !data.learning?.enabled && h('p', null, t('modelsLearnDisabled')),
    !defaults && h('p', null, t('modelsNoDefault')),
    !data.learning?.availability?.available && h('p', null, reasonText(data.learning?.availability?.reason, t)),
    defaults && h('p', { className: 'meta' }, t('modelsRevision') + ': ' + defaults.revision + ' · ' + selectionText(defaults, t)),
    h('div', { className: 'model-fields' },
      select('modelsProvider', draft.provider, routes.map(row => ({ id: row.provider, label: row.label })),
        provider => { setNotice(''); setDraft({ provider, model: '', reasoningEffort: '' }); }),
      select('modelsModel', draft.model, route?.models || [],
        model => { setNotice(''); setDraft({ ...draft, model, reasoningEffort: '' }); }),
      select('modelsReasoning', draft.reasoningEffort, (model?.reasoningEfforts || []).map(id => ({ id, label: effortText(id, t) })),
        reasoningEffort => { setNotice(''); setDraft({ ...draft, reasoningEffort }); })),
    h('button', { type: 'button', disabled: blocked || !validLearningChoice(data, draft), onClick: () => { void save(); } },
      t(busy ? 'modelsBusy' : 'modelsSave')),
    notice && h('p', { role: 'status' }, notice));
}
export function ModelSettings({ useModels, onRefresh, onSaveLearning, onStoreCredential, onRemoveCredential, t }) {
  const state = useModels(value => value), data = state.data;
  return h('section', { className: 'arcfold-methods arcfold-model-settings', 'aria-label': t('modelsTitle') },
    h('header', null, h('h2', null, t('modelsTitle')),
      h('button', { type: 'button', disabled: state.loading, onClick: () => { void onRefresh(); } }, t('modelsRefresh'))),
    state.loading && h('p', { role: 'status' }, t('modelsLoading')),
    state.error && h('p', { role: 'alert' }, t('modelsReadFailed')),
    data && h(React.Fragment, null,
      h('p', { className: 'meta' }, t('modelsGate') + ': ' + t(PHASE_LABELS[data.gate.phase] || 'modelsReasonUnknown') + (data.gate.reason ? ' · ' + reasonText(data.gate.reason, t) : '')),
      h('h3', null, t('modelsMain')), h('p', null, t('modelsMainScope')),
      h('p', null, t('modelsDefault') + ': ' + (selectionText(data.main?.defaultSelection, t) || t('modelsUnavailable'))),
      !data.main?.availability?.available && h('p', null, reasonText(data.main?.availability?.reason, t)),
      h('h3', null, t('modelsLearn')), h('p', null, t('modelsLearnScope')),
      h(LearningForm, { data,
        disabled: Boolean(state.error || state.loading), onSave: onSaveLearning, t }),
      h('h3', null, t('modelsCredentials')), h('p', null, t('modelsCredentialScope')),
      !deployedRoutes(data).length && h('p', null, t('modelsNoRoutes')),
      deployedRoutes(data).map(route => h(CredentialCard, { key: route.provider + ':' + route.apiKeyRef, route,
        info: state.credentials[route.apiKeyRef], readFailed: state.credentialError,
        disabled: Boolean(state.error || state.loading), onStore: onStoreCredential, onRemove: onRemoveCredential, t })),
      h('h3', null, t('modelsUsage')), h('p', null, t('modelsUsageBoundary')),
      deployedRoutes(data).map(route => h(Usage, { key: route.provider, route, t }))));
}
