import { presentationLabel } from './locales.mjs';
import React, { useRef, useState } from 'react';
const h = React.createElement;
const text = (key, value) => h('div', { className: 'text', key }, value ?? '');

export function MethodDock({ useMethods, onDetails, onDecide, onAcknowledge, onRefresh, onPage, t }) {
  const state = useMethods(value => value);
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const actionPending = useRef(false), detailGeneration = useRef(0), retryIds = useRef(new Map());

  async function show(methodId, keepError = false) {
    const generation = ++detailGeneration.current;
    setDetailLoading(true); setExpanded(true);
    if (!keepError) { setError(null); setNotice(null); }
    try {
      const value = await onDetails(methodId);
      if (generation === detailGeneration.current) setDetail(value);
    } catch (failure) {
      if (generation === detailGeneration.current) { setDetail(null); setError(failure.message || t('failed')); }
    } finally {
      if (generation === detailGeneration.current) setDetailLoading(false);
    }
  }
  function closeDetail() {
    detailGeneration.current++; setDetail(null); setDetailLoading(false);
  }
  async function historyPage(offset) {
    if (!detail) return;
    const methodId = detail.method.id, generation = ++detailGeneration.current;
    setDetailLoading(true); setError(null);
    try {
      const value = await onDetails(methodId, offset);
      if (generation === detailGeneration.current) setDetail(current => current?.method.id === methodId
        ? { ...current, notifications: value.notifications } : current);
      // History reads do not silently replace the full method/version the user
      // is deciding on. A deliberate reload or conflict refresh does that.
    } catch (failure) {
      if (generation === detailGeneration.current) setError(failure.message || t('failed'));
    } finally { if (generation === detailGeneration.current) setDetailLoading(false); }
  }
  async function decide(action) {
    if (actionPending.current || detailLoading || !detail) return;
    actionPending.current = true; setBusy(true); setError(null); setNotice(null);
    // The request comes from the displayed detail, never a newer unseen list item.
    const request = { methodId: detail.method.id, expectedRevision: detail.method.revision,
      contentHash: detail.contentHash, action };
    const key = JSON.stringify(request);
    if (!retryIds.current.has(key)) retryIds.current.set(key, globalThis.crypto.randomUUID());
    request.requestId = retryIds.current.get(key);
    try {
      await onDecide(request);
      retryIds.current.delete(key);
      setNotice(t('saved'));
      await show(request.methodId, true);
    } catch (failure) {
      if (failure.remote) retryIds.current.delete(key);
      setError(failure.remote ? failure.message : `${failure.message || t('failed')} ${t('unknown')}`);
      if (failure.code === 'revision_conflict' || failure.code === 'method_superseded' || failure.code === 'method_source_invalid') {
        setError(`${failure.message || ''} ${t('conflict')}`);
        await show(request.methodId, true);
      }
    } finally { actionPending.current = false; setBusy(false); }
  }
  async function acknowledge(id) {
    if (actionPending.current) return;
    actionPending.current = true; setBusy(true); setError(null);
    try { await onAcknowledge(id); await historyPage(detail?.notifications?.offset ?? 0); }
    catch (failure) { setError(failure.message || t('failed')); }
    finally { actionPending.current = false; setBusy(false); }
  }
  const button = (label, action, disabled = false, extra = {}) => h('button', { type: 'button', disabled,
    onClick: () => { void action(); }, ...extra }, label);
  const method = detail?.method;
  const history = detail?.notifications;
  return h('section', { className: 'arcfold-methods', 'aria-label': t('title') },
    h('header', null,
      h('strong', null, `${t('title')} · ${t('pending')} ${state.decisionCount} · ${t('unread')} ${state.unreadCount}`),
      button(expanded ? t('close') : t('open'), () => setExpanded(!expanded), false, { 'aria-expanded': expanded }),
      button(t('refresh'), onRefresh)),
    state.loading && h('p', { role: 'status' }, t('loading')),
    state.error && h('p', { role: 'alert' }, state.error),
    expanded && h('div', { className: 'detail' },
      error && h('p', { role: 'alert' }, error),
      notice && h('p', { role: 'status' }, notice),
      !method && !detailLoading && h('ul', null, state.items.map(item => h('li', { key: item.method.id },
        h('strong', null, item.method.title),
        h('p', { className: 'meta' }, `${presentationLabel('method', item.method.status, t)} · ${t('version')} ${item.method.version ?? 1}`),
        text('current-reason', item.reason),
        item.needsDecision && h('p', null, t('decisionPrompt')),
        item.unreadCount > 0 && h('p', { className: 'meta' }, `${t('unread')} ${item.unreadCount}`),
        button(t(item.needsDecision ? 'reviewDecision' : 'viewDetails'), () => show(item.method.id), busy)))),
      !method && !detailLoading && !state.loading && !state.error && !state.items.length && h('p', null, t('empty')),
      !method && !detailLoading && (state.offset > 0 || state.nextOffset != null) && h('nav', { 'aria-label': t('title') },
        button(t('previous'), () => onPage(Math.max(0, state.offset - 20)), state.offset === 0),
        button(t('next'), () => onPage(state.nextOffset), state.nextOffset === null || state.nextOffset === undefined)),
      detailLoading && h('p', { role: 'status' }, t('loading')),
      method && h('ul', null, h('li', null, h('article', { 'aria-label': method.title },
        button(t('backToMethods'), closeDetail, busy),
        h('h3', null, method.title),
        h('p', { className: 'meta' }, [`${t('version')} ${method.version ?? 1}`,
          method.revision != null ? `${t('revision')} ${method.revision}` : null,
          `${t('status')} ${presentationLabel('method', method.status, t)}`].filter(Boolean).join(' · ')),
        h('h4', null, t('reason')), text('reason', detail.reason),
        detail.needsDecision && h('p', null, t('decisionPrompt')),
        detail.usage && h('p', null, `${t('usage')} ${detail.usage.trialUses}/${detail.usage.maxTrialUses} · ${t('remaining')} ${detail.usage.remaining}`),
        detail.pendingAdoptionCount > 0 && h('div', null,
          h('h4', null, `${t('pendingAdoptions')} ${detail.pendingAdoptionCount}`),
          (detail.pendingAdoptions || []).map(adoption => h('p', { className: 'meta', key: adoption.id },
            `${adoption.id} · ${t('conversation')} ${adoption.sessionId} · ${t('turn')} ${adoption.turn} · ${presentationLabel('adoption', adoption.state, t)}`))),
        method.guidance !== undefined && h('div', null,
          h('h4', null, t('guidance')), text('guidance', method.guidance),
          h('h4', null, t('applies')), text('applies', method.appliesTo),
          h('h4', null, t('excludes')), text('excludes', method.doesNotApplyTo)),
        h('h4', null, t('sources')),
        detail.sources.length ? detail.sources.map(source => h('div', { className: 'source', key: source.id },
          h('p', { className: 'meta' }, `${t('sourceIdentity')}: ${source.id} · ${t('revision')} ${source.revision} · ${t('author')}: ${presentationLabel('role', source.role, t)} · ${t('sourceTime')}: ${source.occurredAt ?? ''}`),
          text('content', source.content),
          h('p', { className: 'meta' }, `${t('provenance')}: ${JSON.stringify(source.provenance ?? null)}`))) : h('p', null, t('noSources')),
        detail.successors.length > 0 && h('div', null, h('h4', null, t('successors')),
          detail.successors.map(next => h('p', { key: next.id },
            `${next.title} · ${t('version')} ${next.version} · ${presentationLabel('method', next.status, t)} `,
            button(t('open'), () => show(next.id), busy)))),
        !detail.activation.allowed && method.status !== 'active' && h('p', { role: 'alert' }, detail.activation.message),
        h('p', { className: 'meta' }, t('boundary')),
        h('div', { className: 'actions' },
          button(busy ? t('busy') : t('continue'), () => decide('continue'), busy || detailLoading || !detail.activation.allowed),
          button(t(method.status === 'paused' ? 'keepPaused' : 'pause'), () => decide('pause'),
            busy || detailLoading || !(['trial', 'active'].includes(method.status) || method.status === 'paused' && detail.needsDecision)),
          button(t('retry'), () => show(method.id), busy)),
        h('details', { key: method.id, 'aria-label': t('history') },
          h('summary', null, `${t('history')} ${history?.total ?? 0} · ${t('unread')} ${history?.unreadCount ?? 0}`),
          h('ul', null, (history?.items || []).map(item => h('li', { key: item.id },
            h('strong', null, item.title), text('message', item.displayMessage ?? item.message),
            h('p', { className: 'meta' }, `${t('version')} ${item.methodVersion} · ${item.createdAt ?? ''}`),
            item.status === 'unread' ? button(t('acknowledge'), () => acknowledge(item.id), busy || detailLoading) : h('span', null, t('read'))))),
          !history?.total && h('p', null, t('noNotifications')),
          (history?.offset > 0 || history?.nextOffset != null) && h('nav', { 'aria-label': t('history') },
            button(t('previous'), () => historyPage(Math.max(0, history.offset - 20)), busy || detailLoading || history.offset === 0),
            button(t('next'), () => historyPage(history.nextOffset), busy || detailLoading || history.nextOffset == null))))))));
}
