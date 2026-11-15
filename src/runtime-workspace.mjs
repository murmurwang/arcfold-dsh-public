import assert from 'node:assert/strict';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export const name = 'arcfold-runtime-workspace';
export const inject = ['workspaceRegistry', 'sessions'];

/** Establish the native first-use workspace before its browser API is exposed.
 * The registry owns persistence and deliberately preserves existing selections,
 * session history, and a user's deletion of the automatic workspace. */
export async function apply(ctx, config = {}) {
  assert.ok(typeof config.workspace === 'string' && isAbsolute(config.workspace), 'An explicit workspace is required');
  const path = await realpath(config.workspace);
  assert.equal(path, config.workspace, 'The deployment workspace must be canonical');
  assert.ok((await stat(path)).isDirectory(), 'The deployment workspace must exist');
  const initial = await ctx.workspaceRegistry.initializeDefault(async () => path);
  ctx.provide('arcfoldRuntimeWorkspace', Object.freeze({ requestedPath: path, defaultWorkspaceId: initial?.id ?? null }));
}
