import React from 'react';
const h = React.createElement;

function workStatus(work, t) {
  if (work.stage) {
    const keys = { waiting: 'goalStageWaiting', completed: 'goalStageComplete', paused: 'goalWorkPaused', needs_review: 'goalStageReview' };
    if (Object.hasOwn(keys, work.stage.status)) return t(keys[work.stage.status]);
  } else if (work.phase === 'active') return t('goalStageReview');
  if (work.phase === 'active') return t(work.activation === 'armed' ? 'goalWorkEnabled' :
    work.activation === 'disarmed' ? 'goalWorkDisarmed' : 'presentationUnknown');
  const keys = { paused: 'goalWorkPaused', blocked: 'goalWorkBlocked', complete: 'goalWorkComplete', cleared: 'goalWorkCleared' };
  return t(Object.hasOwn(keys, work.phase) ? keys[work.phase] : 'presentationUnknown');
}

// Arcfold stage decisions and the corresponding native execution are one view.
export function GoalWorkList({ works = [], title, onAction, busy, t }) {
  if (!works.length) return null;
  return h('section', { className: 'goal-work-list', 'aria-label': t('goalWorkTitle') },
    title && h('h4', null, title),
    works.map(work => {
      const relation = work.relation;
      const linked = relation?.state === 'current';
      const blocker = work.blockedReason;
      const reasonKey = ({ 'round-limit': 'goalBlockRoundLimit', 'queue-failed': 'goalBlockQueueFailed',
        'prompt-rejected': 'goalBlockPromptRejected' })[blocker?.code];
      return h('div', { className: 'goal-work', key: work.id },
        h('span', { className: 'goal-status-badge' }, workStatus(work, t)),
        work.otherSession && h('p', { className: 'meta' }, t('browseReturnToOrigin')),
        h('p', { className: 'text' }, work.stage?.available === false ? t('goalStageReview') :
          work.stage?.objective || (linked ? relation.reason : work.objective)),
        work.stage?.reason && h('p', { className: 'meta' }, work.stage.reason),
        !relation && h('p', { className: 'meta' }, t('goalWorkUnlinked')),
        relation && !linked && h('p', { className: 'meta' },
          t(relation.state === 'needs_review' ? 'goalWorkRelationReview' : 'goalRelationUnavailable')),
        work.phase === 'blocked' && h('div', { className: 'goal-work-blocker' }, h('h5', null, t('goalBlockReason')),
          h('p', { className: 'text' }, reasonKey ? t(reasonKey) : blocker?.message || t('goalBlockUnknown'))),
        work.canStop && onAction && h('button', { type: 'button', disabled: busy,
          onClick: () => { void onAction('stop', work); } }, t('goalWorkStop')),
        work.canResume && onAction && h('button', { type: 'button', disabled: busy,
          onClick: () => { void onAction('resume', work); } }, t('goalWorkResume')),
        h('details', { className: 'goal-work-details' }, h('summary', null, t('goalWorkOriginal')),
          h('p', { className: 'text' }, work.stage?.available === false ? t('goalStageReview') : work.stage?.objective || work.objective),
          work.stage?.doneWhen && h('p', { className: 'text' }, `${t('goalStageDoneWhen')} ${work.stage.doneWhen}`),
          work.stage?.boundaries && h('p', { className: 'text' }, `${t('goalStageBoundaries')} ${work.stage.boundaries}`),
          work.phase === 'blocked' && blocker?.message && h('p', { className: 'text' }, blocker.message),
          h('p', { className: 'meta' }, `${t('goalWorkRounds')} ${work.roundsStarted} / ${work.maxGoalRounds}`),
          h('p', { className: 'meta' }, t(work.provenance === 'verified-native-delegation' ? 'goalWorkVerified' :
            work.provenance === 'source-unavailable' ? 'goalWorkSourceUnavailable' : 'goalWorkLegacy')),
          h('p', { className: 'meta' }, `${work.sessionId} · ${work.nativeGoalId} · ${t('revision')} ${work.nativeRevision}`),
          relation && h('p', { className: 'meta' }, `${relation.goalId} · ${t('goalDefinition')} ${relation.definitionVersion}`)));
    }));
}
