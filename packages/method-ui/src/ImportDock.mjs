import { importReasonKeys } from './import-locales.mjs';
import React, { useEffect, useRef, useState } from 'react';
import { IMPORT_MAX_FILE_BYTES } from './import-source.mjs';
const h = React.createElement;
const statusKeys = { preparing:'importPreparingStatus', ready:'importReady', failed:'importFailed', confirmed:'importConfirmed', withdrawn:'importWithdrawn' };
const eligibilityKeys = { enabled:'importEnabled', trial:'importTrial', paused:'importPaused', history:'importHistory', needs_review:'importNeedsReview' };
const scopeKeys = { global:'importGlobal', mapped:'importMapped', historical:'importHistoricalScope' };
export function ImportDock({ useImports, importSessionId, onImportUpload, onImportPrepare, onImportDetails,
  onImportConfirm, onImportWithdraw, onImportRefresh, onImportPage, t }) {
  const state = useImports(value => value);
  const [expanded, expand] = useState(false), [file, setFile] = useState(null), [receipt, setReceipt] = useState(null);
  const [detail, setDetail] = useState(null), [scope, setScope] = useState(''), [text, setText] = useState(null);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [progress, setProgress] = useState(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const mounted = useRef(true), generation = useRef(0), pending = useRef(false), identities = useRef(new Map());
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  useEffect(() => {
    generation.current++; setDetail(null); setText(null); setReceipt(null); setScope(''); setLoading(false); setProgress(null);
    setError(''); if (pending.current) setNotice(t('importUnknown'));
  }, [state.readEpoch]);
  const current = value => mounted.current && value === generation.current;
  async function show(batchId, view = 'records', offset = 0, retainNotice = false) {
    const version = ++generation.current; setLoading(true); setText(null); setDetail(null);
    if (!retainNotice) { setError(''); setNotice(''); }
    try {
      const result = await onImportDetails({ batchId, view, offset, limit: 20 });
      if (current(version)) { setDetail({ ...result, offset }); setScope(result.batch.scopeMap[0]?.sourceConversationId || ''); }
    } catch (failure) { if (current(version)) setError(failure.message || t('failed')); }
    finally { if (current(version)) setLoading(false); }
  }
  async function readText(textKey, offset = 0) {
    if (!detail || pending.current) return;
    const version = generation.current, batchId = detail.batch.id; setLoading(true); setText(null);
    try {
      const result = await onImportDetails({ batchId, view:'text', textKey, offset, limit:16000 });
      if (current(version)) setText(result);
    } catch (failure) { if (current(version)) setError(failure.message || t('failed')); }
    finally { if (current(version)) setLoading(false); }
  }
  async function refresh() {
    const version = generation.current, selected = detail;
    await onImportRefresh();
    if (current(version) && selected) await show(selected.batch.id, selected.view, selected.offset, true);
  }
  async function prepare(reuse = false) {
    if (state.canImport === false || pending.current || loading || (!reuse && !file) || (reuse && !receipt)) return;
    const version = ++generation.current;
    pending.current = true; setBusy(true); setError(''); setNotice(''); setText(null); setProgress(null);
    try {
      let staged = receipt;
      if (!reuse) {
        staged = await onImportUpload(file, value => { if (current(version)) setProgress(value); });
        if (!current(version)) return;
        setReceipt(staged);
      }
      const value = await onImportPrepare({ receiptId: staged.receiptId, requestId:globalThis.crypto.randomUUID(),
        scopeMap:reuse && scope ? [{ sourceConversationId:scope, targetSessionId:importSessionId }] : [] });
      if (!current(version)) return;
      setReceipt({ ...staged, batchId:value.id });
      await onImportRefresh();
      if (current(version)) await show(value.id, 'records', 0, true);
    } catch (failure) {
      if (current(version)) setError((failure.message || t('failed')) + (failure.remote ? '' : ' ' + t('importUnknown')));
    } finally { pending.current = false; if (mounted.current) { setBusy(false); setProgress(null); } }
  }
  async function decide(action) {
    const batch = detail?.batch;
    if (state.canImport === false || detail?.canImport === false || !batch || pending.current || loading) return;
    const changed = scope !== (batch.scopeMap[0]?.sourceConversationId || '');
    if (action === 'confirm' && (batch.status !== 'ready' || batch.sessionId !== importSessionId || changed)) return;
    if (action === 'withdraw' && batch.status !== 'confirmed') return;
    const version = generation.current;
    const request = { batchId:batch.id, expectedRevision:batch.revision, previewHash:batch.previewHash };
    const key = JSON.stringify([action,request]);
    if (!identities.current.has(key)) identities.current.set(key,globalThis.crypto.randomUUID());
    request.requestId = identities.current.get(key);
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const value = await (action === 'confirm' ? onImportConfirm(request) : onImportWithdraw(request));
      if (!current(version)) return;
      setNotice(t('importSaved'));
      await onImportRefresh();
      if (current(version)) await show(value.id, 'records', 0, true);
    } catch (failure) {
      if (current(version)) {
        setError((failure.message || t('failed')) + (failure.remote ? '' : ' ' + t('importUnknown')));
        // Only read back. A lost response must never trigger a second mutation.
        await onImportRefresh();
        if (current(version)) await show(batch.id, 'records', 0, true);
      }
    } finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  const button = (label, action, disabled = false, props = {}) => h('button', { type:'button', disabled,
    onClick:() => { void action(); }, ...props }, t(label));
  const body = value => h('div', { className:'text' }, String(value ?? ''));
  const reason = code => t(importReasonKeys.includes(code) ? 'importReason_' + code : 'importReasonUnrecognized');
  const role = value => t(['user','assistant','tool','system','material','program'].includes(value) ? 'importRole_' + value : 'importRoleUnknown');
  const batch = detail?.batch, locked = busy || loading;
  const actionLocked = locked || state.canImport === false || detail?.canImport === false;
  const scopeChanged = batch && scope !== (batch.scopeMap[0]?.sourceConversationId || '');
  const receiptMatches = receipt && batch && receipt.batchId === batch.id;
  return h('section', { className:'arcfold-methods arcfold-imports', 'aria-label':t('importTitle') },
    h('header', null, h('strong', null, `${t('importTitle')} · ${state.total}`),
      button(expanded ? 'importHide' : 'importOpen', () => expand(!expanded), busy, { 'aria-expanded':expanded }),
      button('refresh', refresh, locked)),
    expanded && h('div', { className:'detail' },
      h('p', null, t('importBoundary')),
      h('label', null, t('importFile'), h('input', { type:'file', accept:'.json,.jsonl,.ndjson,application/json', disabled:actionLocked,
        onChange:event => {
          const chosen = event.target.files?.[0] || null; generation.current++; setDetail(null); setText(null); setReceipt(null); setScope(''); setNotice('');
          const valid = chosen && chosen.size > 0 && chosen.size <= IMPORT_MAX_FILE_BYTES;
          setFile(valid ? chosen : null); setError(chosen && !valid ? t('importFileTooLarge') : '');
        } })),
      button('importPrepare', () => prepare(), actionLocked || !file),
      busy && h('p', { role:'status' }, t('importWorking'), progress && ` ${progress.loaded.toLocaleString()} / ${file?.size.toLocaleString()} bytes`),
      h('p', { className:'meta' }, t('importStorage')),
      (state.loading || loading) && h('p', { role:'status' }, t('importLoading')),
      (error || state.error) && h('p', { role:'alert' }, error || state.error), notice && h('p', { role:'status' }, notice),
      h('ul', null, state.items.map(row => h('li', { key:row.id },
        body(row.file.name), h('p', { className:'meta' }, `${t(statusKeys[row.status])} · ${row.createdAt}`),
        button('importPreview', () => show(row.id), locked)))),
      !state.loading && !state.error && !state.items.length && h('p', null, t('importEmpty')),
      h('nav', null, button('previous', () => onImportPage(Math.max(0,state.offset-20)), locked || !state.offset),
        button('next', () => onImportPage(state.nextOffset), locked || state.nextOffset == null)),
      batch && h('article', { 'aria-label':t('importTitle') + ' ' + batch.id },
        h('h3', null, batch.file.name), h('p', null, t(statusKeys[batch.status])),
        h('p', { className:'meta' }, t('importSnapshot')),
        batch.status === 'withdrawn' && h('p', { role:'status' }, t('importWithdrawnNotice')),
        h('p', { className:'meta' }, `${t('importRevision')} ${batch.revision} · ${batch.file.bytes.toLocaleString()} bytes`),
        h('details', null, h('summary', null, t('importFileHash')), body(batch.file.sha256)),
        batch.error && h('p', { role:'alert' }, batch.error.message),
        h('h4', null, t('importCountsAtPreview')),
        h('dl', { className:'import-counts' }, Object.entries({ sources:'importCountSources',records:'importCountRecords',enabled:'importEnabled',trial:'importTrial',paused:'importPaused',history:'importHistory',needsReview:'importNeedsReview' }).map(([name,key]) =>
          h('div', { key:name }, h('dt', null, t(key)), h('dd', null, String(batch.counts[name] ?? 0))))),
        h('h4', null, t('importScopeTitle')), h('p', { className:'meta' }, t('importScopeHelp')),
        h('label', null, t('importMapScope'), h('select', { value:scope, disabled:actionLocked || batch.status !== 'ready' || !receiptMatches || batch.sessionId !== importSessionId,
          onChange:event => setScope(event.target.value) },
          h('option', { value:'' }, t('importKeepScope')),
          batch.sourceScopes.map(source => h('option', { key:source.sourceConversationId, value:source.sourceConversationId }, `${source.title || source.sourceConversationId} · ${source.messageCount}`)))),
        scope && h('p', { className:'text' }, batch.sourceScopes.find(source => source.sourceConversationId === scope)?.preview),
        scopeChanged && h('p', { role:'status' }, t('importScopeChanged')),
        batch.status === 'ready' && (receiptMatches ? button('importReprepare', () => prepare(true), actionLocked || !scopeChanged)
          : h('p', { className:'meta' }, t('importNoReceipt'))),
        h('nav', null, button('importRecords', () => show(batch.id,'records'), locked), button('importSources', () => show(batch.id,'sources'), locked)),
        h('p', { className:'meta' }, t('importExcerpt')),
        h('ul', null, detail.items.map(row => h('li', { key:row.id, className:'source' },
          row.title && h('h4', null, row.title), body(row.textPreview),
          row.eligibility && h('p', null, `${t('importEligibilityAtPreview')}：${t(eligibilityKeys[row.eligibility])}`),
          row.claimType && h('p', null, t({ user_statement:'importClaimLiteral', inference:'importClaimInference', open_question:'importClaimQuestion' }[row.claimType] || 'importClaimInference')),
          row.kind === 'methods' && h(React.Fragment, null,
            h('h4', null, t('importAppliesTo')), body(row.appliesTo ?? t('importAttributeUnavailable')),
            h('h4', null, t('importDoesNotApplyTo')), body(row.doesNotApplyTo ?? t('importAttributeUnavailable'))),
          row.scope && h('p', { className:'meta' }, t(scopeKeys[row.scope.kind])),
          row.scope?.topics?.length > 0 && h('p', { className:'meta' }, t('importTopics') + ': ' + row.scope.topics.join(' · ')),
          row.role && h('p', { className:'meta' }, `${role(row.role)} · ${row.occurredAt || ''} · ${t('importSourceAtPreview')}：${t(row.available ? 'importAvailable' : 'importUnavailable')}`),
          row.methodUsage && h('p', null, `${t('importUsageAtPreview')}：${t('importUsed')} ${row.methodUsage.trialUses ?? '—'} / ${t('importMaximum')} ${row.methodUsage.maxTrialUses ?? '—'} · ${t('importRemaining')} ${row.methodUsage.remaining ?? '—'}`),
          row.reasonCodes?.length > 0 && h('details', null, h('summary', null, t('importReason')), body(row.reasonCodes.map(reason).join('\n'))),
          row.existingRecordId && h('details', null, h('summary', null, t('importExistingRecord')), body(row.existingRecordId)),
          row.originalTextKey && button('importOriginalRecord', () => readText(row.originalTextKey), locked),
          row.textKey && button(detail.view === 'sources' ? 'importText' : 'importContent', () => readText(row.textKey), locked)))),
        h('nav', null, button('previous', () => show(batch.id,detail.view,Math.max(0,detail.offset-20)), locked || !detail.offset),
          button('next', () => show(batch.id,detail.view,detail.nextOffset), locked || detail.nextOffset == null)),
        text && h('section', { 'aria-label':t('importTextPage') },
          h('h4', null, t('importTextPage')), h('p', { className:'meta' }, `${text.offset}–${text.offset+text.text.length} / ${text.total}`), body(text.text),
          button('importReadPrevious', () => readText(text.textKey,Math.max(0,text.offset-16000)), locked || !text.offset),
          button('importReadMore', () => readText(text.textKey,text.nextOffset), locked || text.nextOffset == null)),
        batch.status === 'ready' && h('div', { className:'import-decision' }, h('p', null, t('importConfirmHelp')),
          batch.sessionId !== importSessionId && h('p', null, t('importOtherSession')),
          button('importConfirm', () => decide('confirm'), actionLocked || scopeChanged || batch.sessionId !== importSessionId)),
        batch.status === 'confirmed' && h('div', { className:'import-decision' }, h('p', null, t('importWithdrawHelp')),
          button('importWithdraw', () => decide('withdraw'), actionLocked)))));
}
