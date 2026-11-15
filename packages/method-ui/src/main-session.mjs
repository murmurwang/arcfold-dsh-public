// Browsing checks the currently mounted main Agent, never historical work or
// client-supplied preset labels. This must not wake or bind a cold session.
export function currentMainAgent({ agents, agentPresets }, sessionId) {
  const agent = agents?.get(sessionId);
  return agent && agent.id === sessionId && agentPresets?.composedPreset(agent.ctx) === 'arcfold-main'
    ? agent : null;
}
