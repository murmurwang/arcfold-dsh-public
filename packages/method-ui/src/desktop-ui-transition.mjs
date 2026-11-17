import { openDesktopWorkspace } from './desktop-workspace.mjs';

/** Keep the host page alive while this plugin switches from setup to its ready UI. */
export async function openDesktopWorkspaceAndRefresh(ctx, path) {
  await openDesktopWorkspace(ctx.get('workspaces'), ctx.get('uiWorkspace'), path);
  // Cordis disposes this plugin's setup slots and awaits its new registrations.
  // A page reload here can race the host's replacement of client asset revisions.
  await ctx.fiber.restart();
  if (ctx.fiber.state !== 2) throw new Error('Arcfold 界面尚未就绪，请重新连接。');
}
