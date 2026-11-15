import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture } from '../tree-domain/helpers.mjs';
import { ConfinedWorkspaceIO, SnapshotService } from '../../../src/tree/snapshots.mjs';
import { canonicalJson } from '../../../src/tree/contracts.mjs';

// Algorithm tests run the fixed worker under the enclosing engineering guard.
// They are explicitly NOT evidence of the worker's own OS confinement. The
// external B4 Mac probe must exercise unmodified ConfinedWorkspaceIO separately.
export class FixtureWorkspaceIO extends ConfinedWorkspaceIO {
  enforcement = 'fixture-algorithm-only';
  calls = 0;
  prepare(operation, extras) {
    const faultAt = operation === 'restore' ? this.nextRestoreFault : null; if (operation === 'restore') this.nextRestoreFault = null;
    return super.prepare(operation, { ...extras, ...(faultAt ? { faultAt } : {}) });
  }
  async execute(request, { sessionPolicy = { mode: 'read-only' }, signal } = {}) {
    signal?.throwIfAborted();
    if (request.operation === 'restore' && sessionPolicy.mode === 'read-only') throw Object.assign(new Error('Fixture read-only decision'), { code: 'RESTORE_POLICY', beforeSpawn: true });
    if (readFileSync(join(request.runDirectory, 'input.json'), 'utf8') !== canonicalJson(request)) throw new Error('Fixture input changed');
    this.calls++;
    const result = spawnSync(process.execPath, [join(request.runDirectory, 'worker.mjs'), '--input', join(request.runDirectory, 'input.json')], { cwd: this.workspace, encoding: 'utf8', maxBuffer: 1048576, timeout: 15000,
      env: { PATH: '/usr/bin:/bin', HOME: request.runDirectory, TMPDIR: request.runDirectory, LANG: 'en_US.UTF-8', TZ: 'UTC' } });
    if (result.error) throw result.error;
    let output; try { output = JSON.parse(result.stdout); } catch { output = { ok: false, error: { code: 'FIXTURE_WORKER_EXIT', message: result.stderr || 'Interrupted worker' } }; }
    return { code: result.status, stdout: result.stdout, stderr: result.stderr, truncated: false, output };
  }
}
export function snapshotFixture(t) {
  const f = fixture(t), workspace = join(f.dir, 'workspace'), storageRoot = join(f.dir, 'private'), runtimeRoot = join(f.dir, 'runtime');
  for (const path of [workspace, storageRoot, runtimeRoot]) mkdirSync(path, { mode: 0o700 });
  f.context.sessionPolicy = { mode: 'workspace-write', workspaceRoot: workspace };
  const io = new FixtureWorkspaceIO({ workspace, runtimeRoot, protectedRoots: [storageRoot, f.repo.filename] });
  const options = { repository: f.repo, workspace, storageRoot, runtimeRoot, protectedRoots: [f.repo.filename], context: () => f.context, io, allowUnconfinedFixture: true };
  const snapshots = new SnapshotService(options);
  return { ...f, workspace, storageRoot, runtimeRoot, io, snapshots, options };
}
