import { presentationLabel } from './locales.mjs';
import React, { useEffect, useRef, useState } from 'react';
const h = React.createElement;
const literal = value => typeof value === 'string' ? value : JSON.stringify(value ?? '');
export function UnderstandingDock({ useUnderstandings, onUnderstandingDetails, onUnderstandingDecide,
  onUnderstandingCorrect, onUnderstandingRefresh, onUnderstandingPage, t }) {
  const state = useUnderstandings(value => value);
  const [expanded, expand] = useState(false), [detail, setDetail] = useState(null), [edit, setEdit] = useState(null);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [notice, setNotice] = useState(''), [error, setError] = useState('');
  const generation = useRef(0), pending = useRef(false), identities = useRef(new Map()), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  useEffect(() => {
    generation.current++; setDetail(null); setEdit(null); setLoading(false); setError(''); setNotice('');
  }, [state.readEpoch]);
  async function show(id, retainNotice = false, retainedEdit = null) {
    const current = ++generation.current; setLoading(true); setEdit(null); setDetail(null);
    if (!retainNotice) { setError(''); setNotice(''); }
    try {
      const value = await onUnderstandingDetails(id);
      if (mounted.current && current === generation.current) {
        setDetail(value);
        if (retainedEdit?.id === value.understanding.id && retainedEdit.revision === value.understanding.revision) setEdit(retainedEdit);
      }
    }
    catch (failure) { if (mounted.current && current === generation.current) setError(failure.message || t('failed')); }
    finally { if (mounted.current && current === generation.current) setLoading(false); }
  }
  async function refresh() {
    const current = generation.current, id = detail?.understanding.id;
    try {
      await onUnderstandingRefresh();
      if (mounted.current && current === generation.current && id) await show(id);
    } catch (failure) { if (mounted.current && current === generation.current) setError(failure.message || t('failed')); }
  }
  async function act(action, source) {
    if (pending.current || loading || !detail || detail.browse?.related === false) return;
    const current = detail.understanding, selectedGeneration = generation.current;
    if (action === 'correct' && (!edit || edit.id !== current.id || edit.revision !== current.revision || !edit.text.trim())) return;
    const request = { understandingId: current.id, expectedRevision: current.revision,
      ...(action === 'correct' ? { text: edit.text } : { action }),
      ...(source ? { sourceRef: { id: source.id, revision: source.revision, expectedControlRevision: source.expectedControlRevision } } : {}) };
    const key = JSON.stringify(request);
    if (!identities.current.has(key)) identities.current.set(key, globalThis.crypto.randomUUID());
    request.requestId = identities.current.get(key);
    pending.current = true; setBusy(true); setNotice(''); setError('');
    try {
      const value = await (action === 'correct' ? onUnderstandingCorrect(request) : onUnderstandingDecide(request));
      if (!mounted.current || selectedGeneration !== generation.current) return;
      const command = value.command;
      setNotice(t(command?.result?.state === 'applied' ? 'understandingApplied' : command?.result?.state === 'failed' ? 'understandingFailed'
        : action !== 'correct' ? 'understandingSaved' : command?.admission?.state === 'accepted' ? 'understandingPending' : 'understandingUnknown'));
      await onUnderstandingRefresh();
      if (mounted.current && selectedGeneration === generation.current)
        await show(current.id, true, action === 'correct' && !command?.result && command?.admission?.state !== 'accepted' ? edit : null);
    } catch (failure) {
      if (mounted.current && selectedGeneration === generation.current) {
        if (failure.code === 'revision_conflict') {
          setError(failure.message || t('failed'));
          await show(current.id, true);
        } else setError((failure.message || t('failed')) + ' ' + t('understandingUnknown'));
      }
    } finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  const button = (label, action, disabled = false, props = {}) => h('button', { type: 'button', disabled,
    onClick: () => { void action(); }, ...props }, t(label));
  const body = value => h('div', { className: 'text' }, literal(value));
  const item = detail?.understanding;
  const claim = value => presentationLabel('claim', value, t);
  return h('section', { className: 'arcfold-methods arcfold-understandings', 'aria-label': t('understandingTitle') },
    h('header', null, h('strong', null, `${t('understandingTitle')} · ${state.total}`),
      button(expanded ? 'understandingHide' : 'understandingOpen', () => expand(!expanded), false, { 'aria-expanded': expanded }),
      button('refresh', refresh, busy || loading)),
    expanded && h('div', { className: 'detail' },
      h('p', { className: 'meta' }, t('understandingBoundary')),
      (state.loading || loading) && h('p', { role: 'status' }, t('understandingLoading')),
      (error || state.error) && h('p', { role: 'alert' }, error || state.error), notice && h('p', { role: 'status' }, notice),
      h('ul', null, state.items.map(row => h('li', { key: row.understanding.id },
        body(row.understanding.content), h('p', { className: 'meta' }, claim(row.understanding.claimType)),
        button('understandingOpen', () => show(row.understanding.id), busy || loading)))),
      !state.loading && !state.error && !state.items.length && h('p', null, t('understandingEmpty')),
      h('nav', null, button('previous', () => onUnderstandingPage(Math.max(0, state.offset - 20)), busy || loading || !state.offset),
        button('next', () => onUnderstandingPage(state.nextOffset), busy || loading || state.nextOffset == null)),
      item && h('article', { 'aria-label': t('understandingTitle') + ' ' + item.id },
        h('h3', null, claim(item.claimType)), body(item.content),
        detail.browse?.related === false && h('p', { className: 'meta' }, t('browseReturnToOrigin')),
        h('p', { className: 'meta' }, `${t('revision')} ${item.revision} · ${t('understandingVersion')} ${item.version ?? '—'} · ${presentationLabel('understanding', item.status, t)} · ${t(detail.availability.allowed ? 'understandingAvailable' : 'understandingUnavailable')}`),
        !detail.availability.allowed && h('p', null, detail.availability.message),
        h('p', { className: 'meta' }, t('understandingWithdrawalHelp')),
        h('div', { className: 'actions' },
          button('understandingStop', () => act('stop-understanding'), busy || loading || !detail.controls?.stopAllowed),
          button('understandingCorrect', () => setEdit({ id: item.id, revision: item.revision, text: item.content }), busy || loading || !detail.controls?.correctionAllowed)),
        edit && h('div', { className: 'understanding-correction' },
          h('p', null, t('understandingCorrectionHelp')),
          h('label', null, t('understandingReplacement'), h('textarea', { value: edit.text, maxLength: 16000, disabled: busy || loading,
            onChange: event => setEdit({ ...edit, text: event.target.value }) })),
          button('understandingSubmit', () => act('correct'), busy || loading || !edit.text.trim()),
          button('understandingCancel', () => setEdit(null), busy)),
        h('h4', null, t('understandingSource')),
        (detail.sources || []).map(source => h('div', { className: 'source', key: source.id },
          h('p', { className: 'meta' }, `${source.id} · ${source.author && source.author !== source.role ? source.author : presentationLabel('role', source.role, t)} · ${source.occurredAt || ''} · ${t('revision')} ${source.revision ?? '—'} · ${t(source.available ? 'understandingAvailable' : 'understandingUnavailable')}`),
          body(source.missing ? t('understandingMissing') : source.content),
          h('details', null, h('summary', null, t('understandingProvenance')), body(source.provenance), source.control && body(source.control)),
          button('understandingWithdraw', () => act('withdraw-source', source), busy || loading || detail.controls?.sourceControlAllowed === false || !source.available || !Number.isSafeInteger(source.revision)))),
        h('h4', null, t('understandingSuccessors')),
        (detail.successors || []).map(next => h('div', { key: next.id }, h('span', null, `${next.id} · ${t('revision')} ${next.revision} `),
          button('understandingOpen', () => show(next.id), busy || loading))),
        h('details', null, h('summary', null, `${t('understandingHistory')} · ${detail.history?.length || 0}/${detail.historyTotal || 0}`),
          (detail.history || []).map(row => h('div', { className: 'source', key: row.understanding.id },
            h('p', { className: 'meta' }, `${row.understanding.id} · ${t('revision')} ${row.understanding.revision} · ${t('understandingVersion')} ${row.understanding.version ?? '—'}`), body(row.understanding.content)))),
        h('h4', null, `${t('understandingCommands')} · ${detail.commands?.length || 0}/${detail.commandsTotal || 0}`),
        (detail.commands || []).map(command => h('div', { className: 'source', key: command.id },
          h('p', null, `${presentationLabel('understandingAction', command.action, t)} · ${command.requestId} · ${t(command.result?.state === 'applied' ? 'understandingApplied' : command.result?.state === 'failed' ? 'understandingFailed' : 'understandingAwaiting')}`),
          command.admission && h('p', null, t('understandingAdmission') + ': ' + presentationLabel('admission', command.admission.state, t)),
          command.request?.text !== undefined && body(command.request.text), command.result?.error && body(command.result.error.message),
          command.result?.changes?.length > 0 && h('details', null, h('summary', null, t('understandingEffects')), body(command.result.changes)),
          command.result?.goalImpacts?.length > 0 && h('details', null, h('summary', null, t('understandingGoalEffects')), body(command.result.goalImpacts)))))));
}
