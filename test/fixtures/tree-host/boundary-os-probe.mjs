// Must run outside the engineering sandbox: macOS forbids nested Seatbelt.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, symlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { processPolicy, confinedArgv, spawnConfined, ScriptBoundary, contentHash, denyPrivatePath } from '../../../src/tree/host-process.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const scratch = join(here, 'os-runs'); mkdirSync(scratch, { recursive: true });
const root = realpathSync(mkdtempSync(join(scratch, 'fixed-')));
const workspace = join(root, 'workspace'), privateRoot = join(workspace, 'protected'), runtimeRoot = join(root, 'private-runs');
for (const path of [workspace, privateRoot, runtimeRoot]) mkdirSync(path, { recursive: true, mode: 0o700 });
const secret = join(privateRoot, 'secret'), artifact = join(privateRoot, 'artifact.mjs');
writeFileSync(secret, 'SYNTHETIC_SECRET_CANARY'); writeFileSync(artifact, 'export const marker = "private module";');
symlinkSync(privateRoot, join(workspace, 'escape'));
const policy = processPolicy({ workspace: root, protectedRoots: [privateRoot], runtimeRoot,
  sessionPolicy: { mode: 'danger-full-access', workspaceRoot: root, additionalWritableRoots: ['/'] }, authorizedWriteRoots: [root] });
const run = join(runtimeRoot, 'probe'); mkdirSync(run);
const body = join(run, 'body.mjs'), input = join(run, 'input.json');
writeFileSync(body, readFileSync(join(here, 'os-body.mjs')));
const cases = [], tcp = createServer(socket => socket.end()), unix = createServer(socket => socket.end());
await new Promise(resolve => tcp.listen(0, '127.0.0.1', resolve));
// Unix socket names have a small kernel length cap; use a relative fixture name.
process.chdir(root);
await new Promise((resolve, reject) => { unix.once('error', reject); unix.listen('manager.sock', resolve); });
async function execute(label, data, { kind = 'script', readOnly = false } = {}) {
  writeFileSync(input, JSON.stringify(data));
  const wrapped = confinedArgv({ policy: readOnly ? { ...policy, writeRoots: [] } : policy, runDirectory: run,
    kind, argv: [process.execPath, body, '--input', input] });
  const result = await spawnConfined(wrapped, { cwd: workspace, runDirectory: run, timeoutMs: 5000 });
  const events = result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const row = { label, ...result, events, allowed: events.some(e => e.event === 'effect-allowed'), bodyCount: events.filter(e => e.event === 'body-entered').length };
  cases.push(row); console.log(JSON.stringify(row)); return row;
}
try {
  const ok = await execute('workspace-write-control', { op: 'write', path: join(workspace, 'allowed') });
  assert.equal(ok.bodyCount, 1); assert.equal(ok.allowed, true);
  for (const [label, data, options] of [
    ['secret-read', { op: 'read', path: secret }],
    ['private-import', { op: 'import', path: artifact }],
    ['broad-workspace-protected-write', { op: 'write', path: join(privateRoot, 'bad') }],
    ['symlink-read', { op: 'read', path: join(workspace, 'escape/secret') }],
    ['symlink-write', { op: 'write', path: join(workspace, 'escape/bad-link') }],
    ['network', { op: 'network', port: tcp.address().port }],
    ['management-socket', { op: 'unix', path: '../manager.sock' }],
    ['parent-signal-zero', { op: 'signal', pid: process.pid }],
    ['child-process-attack', { op: 'child-write', path: join(privateRoot, 'bad-child') }],
    ['malicious-dry-run', { op: 'write', path: join(workspace, 'bad-dry') }, { readOnly: true }],
  ]) {
    const row = await execute(label, data, options); assert.equal(row.bodyCount, 1); assert.equal(row.allowed, false);
  }
  assert.throws(() => denyPrivatePath(secret, policy), { code: 'PRIVATE_ARTIFACT_DENIED' });
  assert.throws(() => denyPrivatePath(join(workspace, 'escape/secret'), policy), { code: 'PRIVATE_ARTIFACT_DENIED' });
  for (const op of ['hardlink', 'rename-parent']) {
    const attacks = join(run, 'attacks.mjs'); writeFileSync(attacks, readFileSync(join(here, 'boundary-path-attacks.mjs')));
    const moved = join(root, 'moved-workspace');
    writeFileSync(input, JSON.stringify(op === 'hardlink' ? { op, source: secret, target: join(workspace, 'linked-secret') }
      : { op, source: workspace, target: moved, readPath: join(moved, 'protected/secret') }));
    const result = await spawnConfined(confinedArgv({ policy, runDirectory: run, argv: [process.execPath, attacks, '--input', input] }),
      { cwd: root, runDirectory: run, timeoutMs: 5000 });
    cases.push({ label: op, ...result }); console.log(JSON.stringify({ label: op, ...result }));
    assert.ok(result.stdout.includes('effect-denied'), result.stdout);
  }
  // Ordinary command body lives outside the hidden staging area, exactly as a
  // general tool command would. It has no access to broker staging or artifacts.
  const mainBody = join(workspace, 'main-body.mjs'), mainInput = join(workspace, 'main-input.json');
  writeFileSync(mainBody, readFileSync(body));
  for (const op of ['read', 'import']) {
    writeFileSync(mainInput, JSON.stringify({ op, path: op === 'read' ? secret : artifact }));
    const wrapped = confinedArgv({ policy, kind: 'main', argv: [process.execPath, mainBody, '--input', mainInput] });
    const result = await spawnConfined(wrapped, { cwd: workspace, runDirectory: workspace, timeoutMs: 5000 });
    console.log(JSON.stringify({ label: 'ordinary-command-' + op, ...result }));
    assert.ok(result.stdout.includes('body-entered'), result.stderr); assert.ok(result.stdout.includes('effect-denied'), result.stdout);
    cases.push({ label: 'ordinary-command-' + op, ...result });
  }
  let epoch = 1, active = true; const receipts = [];
  const brokerBody = join(privateRoot, 'broker.mjs');
  writeFileSync(brokerBody, 'import{readFileSync,writeFileSync}from"node:fs";const a=JSON.parse(readFileSync(process.argv[process.argv.indexOf("--input")+1]));writeFileSync(a.target,"broker wrote");console.log("broker-body");');
  const ticket = { scopeEpoch: 1, methodId: 'fixture', version: 1 };
  const broker = new ScriptBoundary({ policy, resolveArtifact: async () => ({ entry: 'entry.mjs', files: [{ path: 'entry.mjs', sourcePath: brokerBody, sha256: contentHash(readFileSync(brokerBody)) }] }),
    assertCurrent: async t => { if (!active || t.scopeEpoch !== epoch) throw Object.assign(new Error('stale authorization'), { code: 'STALE' }); },
    record: async receipt => { receipts.push(receipt); } });
  const result = await broker.run(ticket, { target: join(workspace, 'broker-control') });
  assert.equal(result.code, 0, result.stderr); assert.ok(existsSync(join(workspace, 'broker-control')));
  await assert.rejects(broker.run(ticket, { target: join(workspace, 'race-bad') }, { beforeSpawn: async () => { epoch++; } }), { code: 'STALE' });
  assert.ok(!existsSync(join(workspace, 'race-bad')));
  epoch = 1;
  await assert.rejects(broker.run(ticket, { target: join(workspace, 'withdraw-bad') }, { beforeSpawn: async () => { active = false; } }), { code: 'STALE' });
  assert.ok(!existsSync(join(workspace, 'withdraw-bad')));
  active = true;
  const infinite = 'console.log("long-body"); setInterval(()=>{},1000);';
  writeFileSync(brokerBody, infinite);
  const timeout = await broker.run(ticket, {}, { timeoutMs: 150 });
  assert.equal(timeout.reason, 'timeout'); assert.equal(timeout.signal, 'SIGKILL');
  assert.ok(timeout.stdout.includes('long-body'));
  const running = broker.run(ticket, {});
  // Wait for the real OS child to be running before revocation.
  await new Promise(resolve => setTimeout(resolve, 150)); broker.revoke(t => t.methodId === ticket.methodId);
  const revoked = await running;
  assert.equal(revoked.reason, 'cancelled'); assert.equal(revoked.signal, 'SIGKILL');
  assert.ok(revoked.stdout.includes('long-body'));
  cases.push({ label: 'timeout-running-body', ...timeout }, { label: 'withdraw-running-body', ...revoked });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(broker.run(ticket, {}, { signal: abort.signal }), { name: 'AbortError' });
  const broken = new ScriptBoundary({ policy, resolveArtifact: async () => ({ entry: 'entry.mjs', files: [
    { path: 'entry.mjs', sourcePath: brokerBody, sha256: contentHash('old contents') }] }), assertCurrent: async () => {}, record: async () => {} });
  await assert.rejects(broken.run(ticket, {}), { code: 'ARTIFACT_HASH_MISMATCH' });
  await assert.rejects(spawnConfined({ argv: [join(root, 'missing-runner')], enforcement: 'full' }, { cwd: workspace, runDirectory: run }), { code: 'ENOENT' });
  await assert.rejects(spawnConfined({ argv: [process.execPath, '-e', 'throw Error("must not run")'], enforcement: 'partial' }, { cwd: workspace, runDirectory: run }), { code: 'SANDBOX_UNAVAILABLE' });
  const report = { checkedAt: new Date().toISOString(), root, platform: process.platform, cases, receipts,
    gateChecks: { scopeRaceBodyZero: true, withdrawRaceBodyZero: true, hashMismatchBodyZero: true, partialBodyZero: true, missingRunnerBodyZero: true },
    gates: { G2: 'component-pass', G3: 'macos-component-pass' }, limitations: ['Linux deferred by Murphy; not implemented or claimed supported.', 'Generated script child creation is denied; no child capability is currently granted.', 'Full B4 snapshot and persistent run recovery remain separate batch obligations.'] };
  writeFileSync(join(root, 'receipt.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ root, receipt: join(root, 'receipt.json'), gates: report.gates }));
} finally { for (const server of [tcp, unix]) await new Promise(resolve => server.close(resolve)); }
