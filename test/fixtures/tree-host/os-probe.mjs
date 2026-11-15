// Run from the outer host, as 06/B0 and 04 require: macOS cannot nest Seatbelt
// inside the engineering command wrapper. This is a probe, not a new runner.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, existsSync, symlinkSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { load, active, save, fingerprint, hash, bounded } from './support.mjs';

assert.equal(process.platform, 'darwin', 'This retained receipt is a real macOS probe; Linux needs its own runner');
const fixtureDir = dirname(fileURLToPath(import.meta.url));
const runBase = resolve(process.argv[2] ?? join(fixtureDir, 'os-runs'));
assert.ok(runBase.startsWith(fixtureDir + '/'), 'Only write probe artifacts under the registered fixture scope');
mkdirSync(runBase, { recursive: true });
const root = realpathSync(mkdtempSync(join(runBase, 'run-'))), workspace = join(root, 'workspace'), outside = join(root, 'outside');
for (const path of [workspace, outside, join(workspace, 'home'), join(workspace, 'tmp')]) mkdirSync(path);
writeFileSync(join(outside, 'secret'), 'SYNTHETIC_SECRET_CANARY');
writeFileSync(join(outside, 'artifact.mjs'), 'export const marker = "PRIVATE_ARTIFACT_EXECUTED";\n');
symlinkSync(outside, join(workspace, 'escape'));
const inputPath = join(workspace, 'input.json'), bodyPath = join(fixtureDir, 'os-body.mjs');
const [{ Context }, { default: LocalSandbox }] = await Promise.all([load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-sandbox-local')]);
const ctx = new Context(), cases = [], before = fingerprint();
await active(await ctx.plugin(LocalSandbox, {}));
let tcpConnections = 0, unixConnections = 0;
const tcp = createServer(socket => { tcpConnections++; socket.resume(); });
const unix = createServer(socket => { unixConnections++; socket.resume(); });
// Relative AF_UNIX names avoid sockaddr_un's 104-byte path limit while
// remaining inside the same registered, private fixture directory.
process.chdir(root);
const unixPath = 'manager.sock';
const servers = [tcp, unix];
await new Promise((resolve, reject) => { tcp.once('error', reject); tcp.listen(0, '127.0.0.1', resolve); });
await new Promise((resolve, reject) => { unix.once('error', reject); unix.listen(unixPath, resolve); });
async function execute(label, input, policy, { missingRunner = false } = {}) {
  writeFileSync(inputPath, JSON.stringify(input));
  const baseArgv = [process.execPath, bodyPath, '--input', inputPath];
  const policyArg = { mode: 'workspace-write', workspaceRoot: workspace, ...policy };
  const wrapped = await ctx.sandbox.confine(baseArgv, policyArg, new AbortController().signal);
  assert.equal(wrapped.enforcement, 'full');
  // Change only the probe's returned runner pathname for a real ENOENT. The
  // user body is never used as a fallback when a runner cannot be spawned.
  const argv = missingRunner ? [join(root, 'missing-sandbox-executable'), ...wrapped.argv.slice(1)] : wrapped.argv;
  const result = await bounded(new Promise(resolve => {
    let stdout = '', stderr = '', error;
    const child = spawn(argv[0], argv.slice(1), { cwd: workspace, detached: true,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: join(workspace, 'home'), TMPDIR: join(workspace, 'tmp'), LANG: 'en_US.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { if (child.pid) process.kill(-child.pid, 'SIGKILL'); }, 5000);
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 65536) process.kill(-child.pid, 'SIGKILL'); });
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 65536) process.kill(-child.pid, 'SIGKILL'); });
    child.on('error', e => { error = { code: e.code, syscall: e.syscall }; });
    child.on('close', (status, signal) => { clearTimeout(timer); resolve({ status, signal, stdout, stderr, error }); });
  }), label);
  const events = result.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line));
  const row = { label, policy: policyArg, wrappedArgv: argv, enforcement: wrapped.enforcement, ...result, events,
    bodyCount: events.filter(e => e.event === 'body-entered').length, allowed: events.some(e => e.event === 'effect-allowed') };
  cases.push(row); return row;
}
try {
  const wrappedOnly = await ctx.sandbox.confine([process.execPath, bodyPath, '--input', inputPath], { mode: 'workspace-write', workspaceRoot: workspace });
  assert.ok(wrappedOnly.argv.includes('--')); assert.ok(!existsSync(join(workspace, 'allowed')));
  const inside = await execute('workspace-write-positive-control', { op: 'write', path: join(workspace, 'allowed') });
  assert.equal(inside.bodyCount, 1); assert.ok(inside.allowed); assert.ok(existsSync(join(workspace, 'allowed')));
  for (const [label, path, op, policy] of [
    ['outside-write', join(outside, 'denied'), 'write', {}],
    ['symlink-escape', join(workspace, 'escape/denied-link'), 'write', {}],
    ['read-only-malicious-dry-run', join(workspace, 'dry-run-write'), 'write', { mode: 'read-only' }],
    ['child-process-inherits-write-denial', join(outside, 'child-denied'), 'child-write', {}],
  ]) {
    const row = await execute(label, { op, path, dryRun: true }, policy);
    assert.equal(row.bodyCount, 1, 'OS policy must run the body to demonstrate an effect denial');
    assert.equal(row.allowed, false); assert.ok(!existsSync(path));
    assert.ok(row.events.some(e => e.event === 'effect-denied'));
  }
  const missing = await execute('missing-runner-no-fallback', { op: 'write', path: join(workspace, 'must-not-exist') }, {}, { missingRunner: true });
  assert.equal(missing.bodyCount, 0); assert.equal(missing.error?.code, 'ENOENT'); assert.ok(!existsSync(join(workspace, 'must-not-exist')));
  const read = await execute('protected-secret-read', { op: 'read', path: join(outside, 'secret') });
  const direct = await execute('direct-private-artifact-import', { op: 'import', path: join(outside, 'artifact.mjs') });
  const network = await execute('network-loopback-canary', { op: 'network', port: tcp.address().port });
  const signal = await execute('parent-process-visibility-signal-zero', { op: 'signal', pid: process.pid });
  const broad = await execute('workspace-parent-includes-protected-data', { op: 'write', path: join(outside, 'broad-write') }, { workspaceRoot: root });
  const management = await execute('management-socket-canary', { op: 'unix', path: '../manager.sock' });
  // Characterize known baseline gaps. These checks keep them visible, and the
  // receipt marks the safety gates FAIL even when the probe program succeeds.
  for (const row of [read, direct, network, signal, broad, management]) assert.equal(row.allowed, true, 'Frozen file-effect profile gap changed; re-evaluate gate');
  assert.deepEqual(fingerprint(), before, 'Frozen host must remain unchanged');
  const receipt = { kind: 'real-macos-OS-probe', checkedAt: new Date().toISOString(), dependencies: before,
    fixtureCodeHashes: { body: hash(readFileSync(bodyPath)), runner: hash(readFileSync(fileURLToPath(import.meta.url))) },
    root, cases, tcpConnections, unixConnections,
    gates: { P5FileWrites: 'pass', G2PrivateArtifact: 'fail', G3FullConfinement: 'fail' },
    limitations: ['Linux was not executed.', 'Only synthetic loopback traffic; no external network or paid provider.',
      'Signal zero checks visibility/permission only; no ptrace or destructive signal was attempted.',
      'Unavailable/partial pre-spawn handling is separately covered by fake policy; missing executable is real OS evidence.'] };
  save(join(root, 'receipt.json'), receipt);
  console.log(JSON.stringify({ root, receipt: join(root, 'receipt.json'), gates: receipt.gates, cases: cases.map(c => ({ label: c.label, bodyCount: c.bodyCount, allowed: c.allowed })) }, null, 2));
} finally {
  for (const server of servers) await new Promise(resolve => server.close(resolve));
  await ctx.fiber.dispose();
}
