import { presentationLabel } from './locales.mjs';
import { GoalWorkList } from './GoalWorkList.mjs';
import React, { useRef, useState } from 'react';
const h = React.createElement;
const content = value => typeof value === 'string' ? value : value?.content ?? '';
const version = goal => JSON.stringify([goal.id, goal.revision, goal.definitionVersion]);

function GoalCard({ detail, works, canDiscuss, onGoalDiscuss, onGoalRefresh, onAction, workBusy, t }) {
  const goal = detail.goal, allowed = detail.availability?.allowed === true;
  const [draft, setDraft] = useState(''), [draftVersion, setDraftVersion] = useState(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(null), [notice, setNotice] = useState(null);
  const pending = useRef(false), retryIds = useRef(new Map());
  const staleDraft = Boolean(draft && draftVersion !== version(goal));
  async function discuss() {
    if (pending.current || !draft.trim() || staleDraft || !canDiscuss || !(allowed || detail.repairAllowed)) return;
    const request = { goalId: goal.id, expectedRevision: goal.revision, definitionVersion: goal.definitionVersion,
      mode: allowed ? 'discuss' : 'repair', text: draft };
    const key = JSON.stringify(request);
    if (!retryIds.current.has(key)) retryIds.current.set(key, globalThis.crypto.randomUUID());
    request.requestId = retryIds.current.get(key);
    pending.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      const result = await onGoalDiscuss(request), admission = result.binding?.admission?.state;
      setNotice(t(admission === 'accepted' ? 'goalAccepted' : admission === 'failed' ? 'goalFailed' : 'goalUnknown'));
      await onGoalRefresh();
    } catch (failure) {
      setError(failure.remote ? failure.message : `${failure.message || t('failed')} ${t('goalUnknown')}`);
      if (['revision_conflict', 'goal_source_invalid', 'goal_unavailable'].includes(failure.code)) await onGoalRefresh();
    } finally { pending.current = false; setBusy(false); }
  }
  const text = (key, value) => h('div', { key, className: 'text' }, content(value));
  const label = (kind, value) => presentationLabel(kind, value, t);
  return h('article', { className: 'goal-card', id: `arcfold-goal-${goal.id}`, 'aria-label': goal.title || t('goalUnavailable') },
    h('header', { className: 'goal-card-heading' }, h('h3', null, goal.title || t('goalUnavailable')),
      h('span', { className: 'goal-status-badge' }, label('goal', goal.status))),
    detail.browse?.related === false && h('p', { className: 'meta' }, t('browseReturnToOrigin')),
    !allowed && h('p', { role: 'alert' }, detail.availability?.message || t('goalUnavailable')),
    allowed && h('div', { className: 'goal-outcome text' }, content(goal.outcome)),
    h('div', { className: 'goal-card-section' },
      works.length ? h(GoalWorkList, { works, title: t('goalCurrentWork'), onAction, busy: workBusy, t })
        : h(React.Fragment, null, h('h4', null, t('goalCurrentWork')), h('p', { className: 'meta' }, t('goalNoCurrentWork')))),
    allowed && h('div', { className: 'goal-card-section goal-progress' },
      h('h4', null, t('goalProgress')),
      text('progress', detail.coverage?.progressUnavailable > 0 ? t('goalProgressUnavailable') : content(goal.progress) || t('goalNoProgress'))),
    h('details', { className: 'goal-card-evidence' }, h('summary', null, t('goalEvidence')),
      h('p', { className: 'meta' }, `${t('goalDefinition')} ${goal.definitionVersion} · ${t('revision')} ${goal.revision}`),
      allowed && h(React.Fragment, null,
        h('h4', null, t('goalRelations')),
        !(detail.relations || []).length && h('p', { className: 'meta' }, t('goalNoRelations')),
        (detail.relations || []).map((item, index) => h('p', { className: 'meta', key: index },
          `${label('relation', item.type)} · ${item.targetId} · ${item.state === 'needs_review' ? t('goalRelationReview') : item.state === 'unavailable' ? t('goalRelationUnavailable') : ''}`)),
        h('h4', null, t('sources')),
        (detail.sources || []).map(source => h('div', { className: 'source', key: source.id },
          h('p', { className: 'meta' }, `${source.id} · ${label('role', source.role)} · ${t('revision')} ${source.revision} · ${source.occurredAt || ''}`),
          text('content', source.content), h('p', { className: 'meta' }, JSON.stringify(source.provenance || null))))),
      (detail.links || []).map(link => h('div', { className: 'source', key: link.id },
        h('p', { className: 'meta' }, `${link.sessionId} · ${t('turn')} ${link.turn} · ${t('goalDefinition')} ${link.definitionVersion} · ${label('outcome', link.outcome?.outcome ?? 'pending')} · ${t('goalUnassessed')}`),
        h('p', { className: 'meta' }, t('goalContribution')),
        text('contribution', link.contribution?.available === true ? link.contribution.reason : t('goalContributionUnavailable')))),
      !(detail.links || []).length && !works.length && h('p', { className: 'meta' }, t('goalNoLinks')),
      (detail.discussions || []).length > 0 && h('div', null,
        h('h4', null, `${t('goalHistory')} · ${detail.discussions.length}/${detail.discussionsTotal ?? detail.discussions.length}`),
        detail.discussions.map(item => h('div', { className: 'source', key: item.id },
          h('p', { className: 'meta' }, `${item.requestId} · ${t('goalAdmission')}: ${label('admission', item.admission?.state ?? 'unknown')}`),
          text('submitted', item.content?.map(part => part.text || '').join('') || ''),
          item.admission?.state !== 'accepted' && h('p', null, t('goalUnknown')))))),
    (allowed || detail.repairAllowed) && h('details', { className: 'goal-discussion' },
      h('summary', null, t('goalCorrection')),
      h('p', { className: 'meta' }, t(allowed ? 'goalDiscussHelp' : 'goalRepairHelp')),
      !canDiscuss && h('p', { className: 'meta' }, t('goalMainRequired')),
      staleDraft && h('p', { role: 'alert' }, t('goalDraftChanged')),
      error && h('p', { role: 'alert' }, error), notice && h('p', { role: 'status' }, notice),
      h('label', null, t('goalDiscussLabel'), h('textarea', { value: draft, maxLength: 24000, disabled: busy,
        onChange: event => { setDraft(event.target.value); setDraftVersion(version(goal)); } })),
      h('button', { type: 'button', onClick: () => { void discuss(); }, disabled: busy || staleDraft || !draft.trim() || !canDiscuss },
        t(allowed ? 'goalDiscuss' : 'goalRepair'))));
}

export function GoalDock({ useGoals, onGoalDiscuss, onGoalStopWork, onGoalResumeWork, onGoalRefresh, onGoalPage, t }) {
  const state = useGoals(value => value);
  const [expanded, setExpanded] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(null), [notice, setNotice] = useState(null);
  const pending = useRef(false), retryIds = useRef(new Map());
  async function controlWork(action, work) {
    const control = action === 'resume' ? onGoalResumeWork : onGoalStopWork;
    if (pending.current || !control) return;
    const request = { workId: work.id, nativeGoalId: work.nativeGoalId, nativeRevision: work.nativeRevision };
    const key = JSON.stringify({ action, ...request });
    if (!retryIds.current.has(key)) retryIds.current.set(key, globalThis.crypto.randomUUID());
    request.requestId = retryIds.current.get(key);
    pending.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      const result = await control(request);
      if (result?.state === 'applied') {
        retryIds.current.delete(key); setNotice(t(action === 'resume' ? 'goalWorkResumed' : 'goalWorkStopped'));
      } else setNotice(t('goalWorkUnknown'));
    } catch (failure) {
      if (failure.remote) retryIds.current.delete(key);
      setError(`${failure.message || t('failed')}${failure.remote ? '' : ` ${t('goalWorkUnknown')}`}`);
      await onGoalRefresh();
    } finally { pending.current = false; setBusy(false); }
  }
  // The existing list read already includes full goal details and related work.
  // Keep one card per goal; no second detail fetch or duplicate goal navigation.
  const works = [...new Map([...state.items.flatMap(item => item.works || []), ...(state.works || [])]
    .map(work => [work.id, work])).values()];
  const belongs = (work, id) => work.relation?.state === 'current' && work.relation.goalId === id;
  const others = works.filter(work => !state.items.some(item => belongs(work, item.goal.id)));
  const button = (label, action, disabled = false, props = {}) => h('button', { type: 'button', disabled,
    onClick: () => { void action(); }, ...props }, label);
  return h('section', { className: 'arcfold-methods arcfold-goals', 'aria-label': t('goalTitle') },
    h('header', null, h('strong', null, `${t('goalTitle')} · ${state.total}`),
      button(expanded ? t('goalHide') : t('goalOpen'), () => setExpanded(!expanded), false, { 'aria-expanded': expanded }),
      button(t('refresh'), onGoalRefresh)),
    state.loading && h('p', { role: 'status' }, t('goalLoading')),
    state.error && h('p', { role: 'alert' }, state.error),
    // Collapsing the panel preserves unsent drafts and each card's request identity.
    h('div', { className: 'detail', hidden: !expanded },
      h('p', { className: 'meta' }, t('goalBoundary')),
      error && h('p', { role: 'alert' }, error), notice && h('p', { role: 'status' }, notice),
      h('div', { className: 'goal-cards' }, state.items.map(item => h(GoalCard, { key: item.goal.id, detail: item,
        works: works.filter(work => belongs(work, item.goal.id)), canDiscuss: state.canDiscuss === true && item.browse?.related !== false,
        onGoalDiscuss, onGoalRefresh, onAction: controlWork, workBusy: busy, t }))),
      !state.loading && !state.error && !state.items.length && h('p', null, t('goalEmpty')),
      others.length > 0 && h('details', { className: 'goal-other-work' },
        h('summary', null, `${t('goalOtherWork')} · ${others.length}`), h(GoalWorkList, { works: others, onAction: controlWork, busy, t })),
      (state.offset > 0 || state.nextOffset != null) && h('nav', null,
        button(t('previous'), () => onGoalPage(Math.max(0, state.offset - 20)), state.offset === 0),
        button(t('next'), () => onGoalPage(state.nextOffset), state.nextOffset == null))));
}
