import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { confinedArgv, processPolicy, protectedFileSystemClass, spawnConfined } from '../../../src/tree/host-process.mjs';

// Run this fixture with the installed signed Desktop binary, in its Node mode.
assert.ok(process.versions.electron && process.env.ELECTRON_RUN_AS_NODE === '1');
const [mode, dependencyRoot, artifactRoot] = process.argv.slice(2);
assert.ok(['compare', 'verify'].includes(mode));
const require = createRequire(join(realpathSync(dependencyRoot), 'package.json'));
const cordisUrl = pathToFileURL(require.resolve('@deepseek-ai/cordis')).href;
const fileSystemUrl = pathToFileURL(require.resolve('@deepseek-ai/dsh-fs-local')).href;
const [{ Context }, { default: Local }] = await Promise.all([import(cordisUrl), import(fileSystemUrl)]);
const ctx = new Context();
const root = mkdtempSync(join(realpathSync(artifactRoot), 'signed-filesystem-'));
const workspace = join(root, 'workspace');
const protectedRoot = join(root, 'protected');
const runtimeRoot = join(root, 'runtime');
for (const path of [workspace, protectedRoot, runtimeRoot]) mkdirSync(path, { mode: 0o700 });
const file = join(workspace, 'probe.txt');
const privateFile = join(protectedRoot, 'private.txt');
writeFileSync(file, 'synthetic workspace read\n');
writeFileSync(privateFile, 'synthetic protected data\n');
const policy = processPolicy({
  workspace, protectedRoots: [protectedRoot], runtimeRoot,
  sessionPolicy: { mode: 'workspace-write', workspaceRoot: workspace },
  authorizedWriteRoots: [workspace],
});

try {
  if (mode === 'compare') {
    const worker = fileURLToPath(new URL('../../../src/tree/host-process.mjs', import.meta.url));
    const immutableRoots = [dirname(worker), dirname(fileURLToPath(fileSystemUrl))];
    const wrapped = confinedArgv({
      policy: { ...policy, immutableRoots }, kind: 'main', argv: [process.execPath, worker, '--tree-filesystem-worker'],
    });
    const local = new Local(ctx, { cwd: workspace, diffBasisMaxBytes: 65536 });
    const request = JSON.stringify({
      method: 'readText', args: [await local.resolve(file)], cordisUrl, fileSystemUrl, cwd: workspace,
    });
    const env = { PATH: '/usr/bin:/bin', HOME: workspace, TMPDIR: workspace, LANG: 'en_US.UTF-8', TZ: 'UTC' };
    const run = overrides => spawnSync(wrapped.argv[0], wrapped.argv.slice(1), {
      cwd: workspace, env: { ...env, ...overrides }, input: request, timeout: 12000,
      encoding: 'utf8', maxBuffer: 1048576,
    });
    const missingMode = run({});
    const nodeMode = run({ ELECTRON_RUN_AS_NODE: '1' });
    const result = run => ({
      code: run.status, signal: run.signal, error: run.error?.code,
      stdout: run.stdout.slice(0, 350), stderr: run.stderr.slice(0, 350),
    });
    console.log(JSON.stringify({ missingMode: result(missingMode), nodeMode: result(nodeMode) }));
    assert.notEqual(missingMode.status, 0);
    assert.equal(nodeMode.status, 0);
    assert.deepEqual(JSON.parse(nodeMode.stdout), { value: readFileSync(file, 'utf8') });
  } else {
    const Protected = protectedFileSystemClass(Local, { readPolicy: async () => policy, cordisUrl, fileSystemUrl });
    const fs = new Protected(ctx, { cwd: workspace, diffBasisMaxBytes: 65536 });
    assert.equal(await fs.readText(await fs.resolve(file)), 'synthetic workspace read\n');
    await assert.rejects(async () => fs.readText(await fs.resolve(privateFile)));
    assert.equal(readFileSync(privateFile, 'utf8'), 'synthetic protected data\n');
    process.env.ARCFOLD_SYNTHETIC_PROBE_SECRET = 'synthetic-parent-only';
    const launch = argv => spawnConfined(confinedArgv({ policy, kind: 'main', argv }), {
      cwd: workspace, runDirectory: workspace,
    });
    const child = await launch([process.execPath, '-p', 'JSON.stringify([process.env.ELECTRON_RUN_AS_NODE, process.env.ARCFOLD_SYNTHETIC_PROBE_SECRET])']);
    assert.equal(child.code, 0);
    assert.deepEqual(JSON.parse(child.stdout), ['1', null]);
    const shell = await launch(['/bin/sh', '-c', 'test -z "$ELECTRON_RUN_AS_NODE$ARCFOLD_SYNTHETIC_PROBE_SECRET"']);
    assert.equal(shell.code, 0);
    console.log(JSON.stringify({ workspaceRead: true, protectedReadDenied: true, scopedNodeMode: true, inheritedSecretDenied: true }));
  }
} finally {
  await ctx.fiber.dispose();
}
