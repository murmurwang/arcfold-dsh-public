import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { boot } from '@deepseek-ai/dsh-app-boot';
import { runtimeDeploymentPatches } from '../src/runtime-config.mjs';
import * as Workspace from '../src/runtime-workspace.mjs';

// Exercise the real Loader dependency order while holding native registration.
// Full installed-browser verification supplies the actual native registry evidence.
test('browser workspace API stays unavailable until explicit workspace initialization completes', { timeout: 5000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'arcfold-workspace-gate-')));
  const workspace = join(root, 'selected'); mkdirSync(workspace);
  writeFileSync(join(root, 'cordis.yml'), '[]\n');
  const patches = runtimeDeploymentPatches({ config: { main: null, learn: null, transport: null,
    listen: { host: '127.0.0.1', port: 0 } }, workspace, businessFilename: join(root, 'business.sqlite') });
  const gate = patches.flatMap(row => row.insert ?? []).find(row => row.id === 'arcfold-runtime-workspace');
  const api = patches.find(row => row.id === 'workspace-controller');
  let release, entered, directory, calls = 0;
  const waiting = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const ctx = new Context();
  t.after(async () => ctx.fiber.dispose());
  ctx.provide('workspaceRegistry', { async initializeDefault(resolvePath) {
    calls++; directory = await resolvePath(); entered(); await waiting; return { id: 'native-default' };
  } });
  const loading = boot('test', join(root, 'cordis.yml'), [{ insert: [
    { ...gate, name: 'cordis:workspace' },
    { ...api, name: 'cordis:controller' },
  ] }], owner => {
    owner.provide('sessions', { list: () => [] });
    owner.provide('workspaceRegistry', ctx.workspaceRegistry);
    Object.assign(owner.loader.builtins, { workspace: Workspace,
      controller: { apply(child) { child.provide('workspaceController', { initialized: child.arcfoldRuntimeWorkspace }); } } });
  });
  await started; assert.equal(directory, workspace); assert.equal(calls, 1);
  // boot must wait for the dependency; resolving its gate is the only advance.
  let resolved = false; void loading.then(() => { resolved = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(resolved, false);
  release(); const host = await loading; t.after(async () => host.fiber.dispose());
  assert.equal(host.workspaceController.initialized.requestedPath, workspace);
  assert.equal(host.arcfoldRuntimeWorkspace.defaultWorkspaceId, 'native-default');
});

test('ineligible native first use is respected without creating, moving or rewriting a workspace', { timeout: 5000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'arcfold-workspace-existing-')));
  const ctx = new Context(); t.after(async () => ctx.fiber.dispose());
  ctx.provide('sessions', { list: () => [] });
  let calls = 0;
  ctx.provide('workspaceRegistry', { async initializeDefault() { calls++; return undefined; },
    create() { throw new Error('Existing native workspaces must not be replaced'); } });
  await ctx.plugin(Workspace, { workspace: root });
  assert.equal(calls, 1); assert.deepEqual(ctx.arcfoldRuntimeWorkspace, { requestedPath: root, defaultWorkspaceId: null });
});
