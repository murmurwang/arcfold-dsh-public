import React, { useEffect, useState } from 'react';
const h = React.createElement;

function status(item, t) {
  const key = item.control?.dismissed ? 'opportunityDismissed' : item.stopped ? 'opportunityStopped'
    : !item.run ? (item.rejection ? 'opportunityRejected' : 'opportunityPending')
    : ({ prepared: 'opportunityPrepared', submitted: 'opportunitySubmitted', unknown: 'opportunityUncertain',
      stopped: 'opportunityStopped', settled: 'opportunitySettled' }[item.run.state] ?? 'presentationUnknown');
  return t(key);
}

function OpportunityCard({ item, readDetails, sessionId, t }) {
  const [detail, setDetail] = useState(null), [error, setError] = useState(null);
  useEffect(() => {
    let active = true;
    // Browsing never grants permission, marks a notice as read, starts
    // preparation, or submits a new instruction.
    Promise.resolve().then(() => readDetails(item.opportunity.id)).then(value => {
      if (active) setDetail(value);
    }, failure => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [item.opportunity.id, readDetails]);
  const current = detail ?? item, row = current.opportunity;
  return h('article', { className: 'opportunity-card', 'aria-label': row.description },
    h('div', { className: 'opportunity-status' },
      h('span', { className: 'status-badge' }, status(current, t)),
      current.notice && h('span', { className: 'meta' }, t(current.notice.status === 'unread' ? 'opportunityUnread' : 'opportunityAlreadyRead'))),
    h('h3', { className: 'text' }, row.description),
    sessionId && row.conversationId !== sessionId && h('p', { className: 'meta' }, t('browseOtherSession')),
    row.rationale && h('div', { className: 'opportunity-field' }, h('h4', null, t('opportunityRationale')), h('p', { className: 'text' }, row.rationale)),
    row.suggestedPreparation && h('div', { className: 'opportunity-field' }, h('h4', null, t('opportunitySuggestion')), h('p', { className: 'text' }, row.suggestedPreparation)),
    error && h('p', { role: 'alert' }, error),
    current.reason && (current.run || current.control || current.rejection) && h('p', { className: 'meta' }, current.reason),
    current.rejection && !current.run && h('p', { role: 'alert' }, current.rejection.error.message),
    current.run?.error && h('p', { role: 'alert' }, current.run.error.message),
    current.artifact && h('div', { className: 'opportunity-draft' }, h('h4', null, t('opportunityDraft')),
      !current.available && h('p', { role: 'alert' }, t('opportunityStopped')),
      h('p', { className: 'meta' }, current.artifact.evidence.path), h('pre', { className: 'text' }, current.artifact.evidence.text),
      h('p', { className: 'meta' }, t('opportunityNotUsefulYet'))),
    detail && h('details', { className: 'opportunity-evidence' }, h('summary', null, t('opportunityEvidence')),
      h('pre', { className: 'text' }, JSON.stringify(detail.run?.input ?? detail.originals, null, 2))));
}

export function OpportunityDock({ useOpportunities, onOpportunityDetails, onOpportunityRefresh, onOpportunityPage, opportunitySessionId, viewScope, t }) {
  const state = useOpportunities(value => value);
  const [open, setOpen] = useState(false), [refreshVersion, setRefreshVersion] = useState(0);
  const button = (label, action, disabled = false, extra = {}) => h('button', { type: 'button', disabled, onClick: action, ...extra }, label);
  return h('section', { className: 'arcfold-methods arcfold-opportunities', 'aria-label': t('opportunityTitle') },
    h('header', null, h('strong', null, `${t('opportunityTitle')} · ${state.total}`),
      button(t(open ? 'opportunityHide' : 'opportunityOpen'), () => setOpen(!open), false, { 'aria-expanded': open }),
      button(t('refresh'), () => { setRefreshVersion(value => value + 1); void onOpportunityRefresh(); })),
    state.error && h('p', { role: 'alert' }, state.error),
    open && h('div', { className: 'detail opportunity-content' },
      h('div', { className: 'opportunity-overview' },
        h('p', null, t('opportunityReadOnly')),
        viewScope !== 'all' && h('div', { className: 'opportunity-status' }, h('span', { className: 'status-badge' }, t(state.permission?.enabled ? 'opportunityOn' : 'opportunityOff'))),
        state.workspace && h('p', { className: 'meta' }, `${t('opportunityWorkspace')} · ${state.workspace}`)),
      h('ul', { className: 'opportunity-list' }, state.items.map(item => h('li', {
        // Versioned snapshots discard late reads across reconnects and refresh.
        key: JSON.stringify([item, state.permission?.revision, state.resetVersion, refreshVersion]),
      }, h(OpportunityCard, { item, readDetails: onOpportunityDetails, sessionId: opportunitySessionId, t })))),
      !state.loading && !state.items.length && h('p', { className: 'meta' }, t('opportunityEmpty'))),
    open && (state.offset > 0 || state.nextOffset != null) && h('nav', { className: 'opportunity-pagination', 'aria-label': t('opportunityTitle') },
      button(t('previous'), () => onOpportunityPage(Math.max(0, state.offset - 20)), !state.offset),
      button(t('next'), () => onOpportunityPage(state.nextOffset), state.nextOffset == null)));
}
