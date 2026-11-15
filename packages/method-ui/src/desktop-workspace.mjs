/** Use the host's native Workspace registration and navigation services. */
export async function openDesktopWorkspace(workspaces, navigation, path) {
  if (!workspaces || !navigation || typeof path !== 'string' || !path.startsWith('/'))
    throw new Error('DSH 工作区服务尚未就绪。');
  const workspace = await workspaces.create({ path });
  if (!workspace?.workspaceId) throw new Error('无法确认新工作区。');
  await navigation.openWorkspace(workspace.workspaceId, undefined, { agentPreset: 'arcfold-main' });
}
