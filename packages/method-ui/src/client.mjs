import { CollaborationView, CollaborationHero } from './CollaborationView.mjs';
import { createBrowseScopeSource } from './browse-source.mjs';
import { createOpportunitySource } from './opportunity-source.mjs';
import { opportunitiesZh, opportunitiesEn } from './opportunity-locales.mjs';
import { createImportSource } from './import-source.mjs';
import { importsZh, importsEn } from './import-locales.mjs';
import { createUnderstandingSource } from './understanding-source.mjs';
import { understandingZh, understandingEn } from './understanding-locales.mjs';
import { ModelSettings } from './ModelSettings.mjs';
import { createModelSettingsSource } from './model-settings-source.mjs';
import { modelsZh, modelsEn } from './model-settings-locales.mjs';
import { createGoalSource } from './goal-source.mjs';
import { goalZh, goalEn } from './goal-locales.mjs';
import { createMethodSource } from './method-source.mjs';
import { zh, en } from './locales.mjs';
import { installTreeClient } from './tree-client.mjs';
import { DesktopSetup } from './DesktopSetup.mjs';
import { DesktopModels } from './DesktopModels.mjs';
import { openDesktopWorkspaceAndRefresh } from './desktop-ui-transition.mjs';
export const inject = ['slots', 'connection', 'locale', 'fileUpload'];
const NS = 'arcfold-methods';
export async function apply(ctx) {
  let desktop;
  try { desktop = await ctx.connection.rpc.call('/api', 'arcfoldDesktop/status', { args: { request: {} } }); } catch {}
  if (desktop?.ok === true && ['needs_setup', 'needs_upgrade', 'configured', 'activation_failed', 'interrupted', 'unavailable', 'ready'].includes(desktop.value?.state)) {
    ctx.effect(() => { const style = document.createElement('style'); style.dataset.plugin = 'arcfold-desktop-setup';
      style.textContent = '.arcfold-desktop-setup{max-width:42rem;margin:1rem auto;padding:1.5rem;line-height:1.6}.arcfold-desktop-setup code{overflow-wrap:anywhere}.arcfold-desktop-setup button{margin-top:1rem;padding:.5rem .9rem}.arcfold-desktop-setup label{display:block}';
      document.head.append(style); return () => style.remove(); }, 'Arcfold Desktop setup style');
    if (desktop.value.modelRouting !== 'dsh-native-v1') ctx.slots.inject('settings.models.footer', () => ctx.slots.register({ name: 'settings.models.footer', id: 'arcfold-deepseek-credential',
      order: 11, inject: () => ({ rpc: ctx.connection.rpc }) }, DesktopModels));
  }
  if (desktop?.ok === true && ['needs_setup', 'needs_upgrade', 'configured', 'activation_failed', 'interrupted', 'unavailable'].includes(desktop.value?.state)) {
    const props = { initial: desktop.value, rpc: ctx.connection.rpc,
      openWorkspace: path => openDesktopWorkspaceAndRefresh(ctx, path) };
    for (const name of ['settings.section', 'conversation.hero.options'])
      ctx.slots.inject(name, () => ctx.slots.register({ name, id: 'arcfold-desktop-setup', order: 11, label: 'Arcfold 设置', inject: () => props }, DesktopSetup));
    return;
  }
  const mode = await ctx.connection.rpc.call('/api', 'arcfoldMode/current', { args: {} });
  if (mode?.ok !== true || typeof mode.value?.goalTreeV3 !== 'boolean') throw new Error('Arcfold 页面模式尚未确认，请重新连接。');
  if (mode.value.goalTreeV3) {
    ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'goal', priority: -1 }, () => null));
    return installTreeClient(ctx);
  }
  // Goals live in the Arcfold view. The official list-slot override removes
  // only its composer control; ui-goal keeps rendering original goal history.
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'goal', priority: -1,
  }, () => null));
  const sources = new Set(), sessions = new Map();
  const browseScope = createBrowseScopeSource(sources);
  ctx.effect(() => ctx.locale.register(NS, { zh: { ...zh, ...goalZh, ...modelsZh, ...understandingZh, ...importsZh, ...opportunitiesZh }, en: { ...en, ...goalEn, ...modelsEn, ...understandingEn, ...importsEn, ...opportunitiesEn } }), 'Arcfold method UI copy');
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.plugin = '@arcfold/dsh-method-ui';
    style.textContent = typeof __ARCFOLD_METHOD_CSS__ === 'string' ? __ARCFOLD_METHOD_CSS__ : '';
    document.head.append(style);
    return () => style.remove();
  }, 'Arcfold method UI style');
  ctx.effect(() => () => { browseScope.dispose(); for (const source of sources) source.dispose(); sources.clear(); sessions.clear(); }, 'Arcfold method reads');
  const modelSettings = createModelSettingsSource({ rpc: ctx.connection.rpc,
    subscribeReset: listener => ctx.on('connection/reset', listener) });
  sources.add(modelSettings);
  const modelProps = {
    hooks: { models: modelSettings },
    onRefresh: () => modelSettings.refresh(),
    onSaveLearning: request => modelSettings.saveLearning(request),
    onStoreCredential: (provider, value) => modelSettings.storeCredential(provider, value),
    onRemoveCredential: provider => modelSettings.removeCredential(provider),
  };
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'arcfold-models', order: 11, locale: NS,
    label: () => ctx.locale.bind(NS)('modelsTitle'),
    inject: () => modelProps,
  }, ModelSettings));
  // Hero and tab share the same session-bound sources. Slot changes only
  // unsubscribe; the source remains reusable until the plugin is unloaded.
  const sessionProps = sessionId => {
    if (sessions.has(sessionId)) return sessions.get(sessionId);
    const viewScope = browseScope.getSnapshot().viewScope;
    const source = createMethodSource({ rpc: ctx.connection.rpc, sessionId, viewScope,
      subscribeReset: listener => ctx.on('connection/reset', listener) });
    sources.add(source);
    const goals = createGoalSource({ rpc: ctx.connection.rpc, sessionId, viewScope,
      subscribeReset: listener => ctx.on('connection/reset', listener) });
    sources.add(goals);
    const understandings = createUnderstandingSource({ rpc: ctx.connection.rpc, sessionId, viewScope,
      subscribeReset: listener => ctx.on('connection/reset', listener) });
    sources.add(understandings);
    const imports = createImportSource({ rpc: ctx.connection.rpc, fileUpload: ctx.fileUpload, sessionId, viewScope,
      subscribeReset: listener => ctx.on('connection/reset', listener) });
    sources.add(imports);
    const opportunities = createOpportunitySource({ rpc: ctx.connection.rpc, sessionId, viewScope, subscribeReset: listener => ctx.on('connection/reset', listener) });
    sources.add(opportunities);
    const props = { ...modelProps, onModelsRefresh: modelProps.onRefresh, opportunitySessionId: sessionId, understandingSessionId: sessionId, importSessionId: sessionId, hooks: { models: modelSettings, browseScope, methods: source, goals, understandings, imports, opportunities },
      onViewScopeChange: viewScope => browseScope.setViewScope(viewScope),
      onOpportunityDetails: id => opportunities.details(id),
      onOpportunityAct: (endpoint, request) => opportunities.act(endpoint, request),
      onOpportunityRefresh: () => opportunities.refresh(),
      onOpportunityPage: offset => opportunities.refresh(offset),
      onImportUpload: (file, onProgress) => imports.upload(file, onProgress),
      onImportPrepare: request => imports.prepare(request),
      onImportDetails: request => imports.details(request),
      onImportConfirm: request => imports.confirm(request),
      onImportWithdraw: request => imports.withdraw(request),
      onImportRefresh: () => imports.refresh(),
      onImportPage: offset => imports.refresh(offset),
      onDetails: (methodId, offset) => source.details(methodId, offset),
      onDecide: request => source.decide(request),
      onAcknowledge: id => source.acknowledge(id),
      onRefresh: () => source.refresh(),
      onPage: offset => source.refresh(offset),
      onGoalDetails: id => goals.details(id), onGoalDecide: request => goals.decide(request),
      onGoalDiscuss: request => goals.discuss(request), onGoalRefresh: () => goals.refresh(),
      onGoalStopWork: request => goals.stopWork(request),
      onGoalResumeWork: request => goals.resumeWork(request),
      onGoalPage: offset => goals.refresh(offset),
      onUnderstandingDetails: id => understandings.details(id),
      onUnderstandingDecide: request => understandings.decide(request),
      onUnderstandingCorrect: request => understandings.correct(request),
      onUnderstandingRefresh: () => understandings.refresh(),
      onUnderstandingPage: offset => understandings.refresh(offset),
    };
    sessions.set(sessionId, props);
    return props;
  };
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view', id: 'arcfold', order: 20, locale: NS,
    label: () => ctx.locale.bind(NS)('collaborationTitle'),
    inject: sessionProps,
  }, CollaborationView));
  // The host renders hero.options only for a real blank session. Its normal
  // view tabs are hidden then, so browsing never requires a model message.
  ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
    name: 'conversation.hero.options', id: 'arcfold', order: 20, locale: NS,
    inject: sessionProps,
  }, CollaborationHero));
}
