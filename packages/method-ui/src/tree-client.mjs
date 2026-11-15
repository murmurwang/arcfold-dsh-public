import React from 'react';
import { createTreeSource } from './tree-source.mjs';
import { TreeView, TreeDock, TreeTurnTail } from './tree-view.mjs';
// B7 calls this only in the explicit v3 profile, instead of old goal cards.
export function installTreeClient(ctx) {
  const sources = new Map();
  const props = sessionId => {
    if (!sources.has(sessionId)) sources.set(sessionId, createTreeSource({ rpc: ctx.connection.rpc, sessionId, subscribeReset: listener => ctx.on('connection/reset', listener) }));
    return { source: sources.get(sessionId) };
  };
  ctx.effect(() => () => { sources.forEach(source => source.dispose()); sources.clear(); }, 'Arcfold tree reads');
  ctx.effect(() => { const style = document.createElement('style'); style.dataset.plugin = 'arcfold-tree-v3'; style.textContent = typeof __ARCFOLD_TREE_CSS__ === 'string' ? __ARCFOLD_TREE_CSS__ : ''; document.head.append(style); return () => style.remove(); }, 'Arcfold tree appearance');
  for (const [name, component] of [['conversation.input.dock', TreeDock], ['conversation.view', TreeView], ['conversation.chat.turnTail', ({ source, turn }) => React.createElement(TreeTurnTail, { source, nativeTurn: turn.turn })]])
    ctx.slots.inject(name, () => ctx.slots.register({ name, id: 'arcfold-tree-v3', order: 20, label: 'Arcfold', inject: props }, component));
}
