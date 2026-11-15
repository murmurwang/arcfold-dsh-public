import React, { useEffect, useId, useRef, useState } from 'react';
import { OpportunityDock } from './OpportunityDock.mjs';
import { MethodDock } from './MethodDock.mjs';
import { GoalDock } from './GoalDock.mjs';
import { UnderstandingDock } from './UnderstandingDock.mjs';
import { ImportDock } from './ImportDock.mjs';
import { ModelSettings } from './ModelSettings.mjs';

const h = React.createElement;
function Panels(props) {
  return h(React.Fragment, null, h(OpportunityDock, props), h(MethodDock, props),
    h(GoalDock, props), h(UnderstandingDock, props), h(ImportDock, props));
}
function Models(props) {
  return h(ModelSettings, { ...props, onRefresh: props.onModelsRefresh });
}
function Dialog({ title, onClose, children, t }) {
  const ref = useRef(null), titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    dialog.showModal();
    return () => { dialog.close(); };
  }, []);
  return h('dialog', { ref, className: 'arcfold-dialog', 'aria-labelledby': titleId,
    onCancel: event => { event.preventDefault(); onClose(); } },
    h('header', { className: 'arcfold-toolbar' },
      h('h2', { id: titleId }, title),
      h('button', { type: 'button', onClick: onClose, autoFocus: true }, t('collaborationClose'))),
    children);
}
export function CollaborationView(props) {
  const scope = props.useBrowseScope ? props.useBrowseScope(value => value) : { viewScope: 'all', epoch: 0 };
  const [modelsOpen, setModelsOpen] = useState(false);
  useEffect(() => { setModelsOpen(false); }, [props.opportunitySessionId]);
  return h('section', { className: 'arcfold-view', 'aria-label': props.t('collaborationTitle') },
    h('header', { className: 'arcfold-toolbar' },
      h('h2', null, props.t('collaborationTitle')),
      h('button', { type: 'button', onClick: () => props.onOpenModels ? props.onOpenModels() : setModelsOpen(true) }, props.t('modelsTitle'))),
    h('div', { className: 'arcfold-view-scope', role: 'group', 'aria-label': props.t('collaborationViewScope') },
      ['all', 'current'].map(viewScope => h('button', { key: viewScope, type: 'button',
        'aria-pressed': scope.viewScope === viewScope,
        onClick: () => props.onViewScopeChange?.(viewScope) }, props.t(viewScope === 'all' ? 'collaborationAll' : 'collaborationCurrent')))),
    h(Panels, { ...props, viewScope: scope.viewScope, key: `${props.opportunitySessionId}:${scope.epoch}` }),
    modelsOpen && h(Dialog, { title: props.t('modelsTitle'), t: props.t, onClose: () => setModelsOpen(false) }, h(Models, props)));
}
export function CollaborationHero(props) {
  const [panel, setPanel] = useState(null);
  // A session switch must not carry an open dialog or unfinished draft forward.
  useEffect(() => { setPanel(null); }, [props.opportunitySessionId]);
  return h('div', { className: 'arcfold-hero-entry' },
    h('button', { type: 'button', onClick: () => setPanel('collaboration') }, props.t('collaborationTitle')),
    h('button', { type: 'button', onClick: () => setPanel('models') }, props.t('modelsTitle')),
    panel && h(Dialog, { title: props.t(panel === 'models' ? 'modelsTitle' : 'collaborationTitle'),
      t: props.t, onClose: () => setPanel(null) },
      panel === 'models' ? h(Models, props) : h(CollaborationView, { ...props, onOpenModels: () => setPanel('models') })));
}
