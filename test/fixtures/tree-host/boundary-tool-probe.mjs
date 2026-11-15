import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, symlinkSync, renameSync, readFileSync } from 'node:fs';
import { nativeFixture, active, load, host, answer, chunks, textOf, save } from './support.mjs';
import { processPolicy, protectedFileSystemClass, protectedBashClass } from '../../../src/tree/host-process.mjs';
const requireHost = createRequire(join(host, 'package.json'));
const url = name => pathToFileURL(requireHost.resolve('@deepseek-ai/' + name)).href;

test('G2 real DSH read tool and native filesystem deny direct/alias private reads while normal reads work', async t => {
  let secret, publicFile;
  const f = await nativeFixture(t, 'private-tools-fixed', (_options, ordinal) => ordinal === 1 ? chunks([
    { type: 'tool-call', id: 'private', name: 'read', arguments: JSON.stringify({ file_path: secret }) },
    { type: 'tool-call', id: 'alias', name: 'read', arguments: JSON.stringify({ file_path: join(f.root, 'alias/secret') }) },
    { type: 'tool-call', id: 'public', name: 'read', arguments: JSON.stringify({ file_path: publicFile }) },
  ]) : answer('Synthetic tools completed.'));
  const privateRoot = join(f.root, 'private'), runtimeRoot = join(f.root, 'runs');
  for (const p of [privateRoot, runtimeRoot]) mkdirSync(p);
  secret = join(privateRoot, 'secret'); publicFile = join(f.root, 'public');
  writeFileSync(secret, 'SYNTHETIC_PRIVATE_TOOL_CANARY'); writeFileSync(publicFile, 'PUBLIC_TOOL_CANARY');
  symlinkSync(privateRoot, join(f.root, 'alias'));
  const [{ default: Local }, { default: WorkingDirectory }, Tools] = await Promise.all([
    load('@deepseek-ai/dsh-fs-local'), load('@deepseek-ai/dsh-working-directory'), load('@deepseek-ai/dsh-tool-fs'),
  ]);
  const policy = processPolicy({ workspace: f.root, protectedRoots: [privateRoot], runtimeRoot, immutableRoots: [host],
    sessionPolicy: { mode: 'workspace-write', workspaceRoot: f.root }, authorizedWriteRoots: [f.root] });
  const Protected = protectedFileSystemClass(Local, { readPolicy: async sessionPolicy => sessionPolicy?.mode === 'read-only' ? { ...policy, writeRoots: [] } : policy,
    cordisUrl: url('cordis'), fileSystemUrl: url('dsh-fs-local') });
  await active(await f.ctx.plugin(Protected, { cwd: f.root }));
  await active(await f.ctx.plugin(WorkingDirectory, { defaultDirectory: f.root }));
  const agent = await f.agent('private-tools', async owner => {
    await active(await owner.plugin(Tools, { read: true, readImage: false, write: false, edit: false, applyPatch: false }));
  });
  await f.run(agent, 'Read three synthetic files');
  const results = agent.session.snapshotEvents().filter(e => e.type === 'tool/result');
  assert.equal(results.length, 3);
  const byId = id => results.find(e => e.data.message.toolCallId === id)?.data.message;
  assert.equal(byId('private')?.isError, true); assert.equal(byId('alias')?.isError, true);
  assert.ok(!byId('public')?.isError); assert.ok(textOf([byId('public')]).includes('PUBLIC_TOOL_CANARY'));
  assert.ok(!textOf(f.requests.at(-1).messages).includes('SYNTHETIC_PRIVATE_TOOL_CANARY'));
  // Resolve while ordinary, then swap an ancestor before the actual syscall.
  const victim = join(f.root, 'victim'); mkdirSync(victim); writeFileSync(join(victim, 'secret'), 'public before race');
  const target = await f.ctx.fs.resolve(join(victim, 'secret'));
  renameSync(victim, join(f.root, 'old-victim')); symlinkSync(privateRoot, victim);
  await assert.rejects(f.ctx.fs.readText(target));
  await assert.rejects(f.ctx.fs.writeText(target, 'must not overwrite private data'));
  assert.equal(readFileSync(secret, 'utf8'), 'SYNTHETIC_PRIVATE_TOOL_CANARY');
  const targetPublic = await f.ctx.fs.resolve(publicFile), before = await f.ctx.fs.stat(targetPublic);
  const competing = await Promise.allSettled([
    f.ctx.fs.writeText(targetPublic, 'one', { kind: 'replaceIfVersion', version: before.version }),
    f.ctx.fs.writeText(targetPublic, 'two', { kind: 'replaceIfVersion', version: before.version }),
  ]);
  assert.equal(competing.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(competing.find(x => x.status === 'rejected').reason.code, 'FS_STALE_VERSION');
  save(join(f.root, 'gate.json'), { G2FileTools: 'pass', resultIds: results.map(e => ({ id: e.data.message.toolCallId, isError: e.data.message.isError })),
    racedReadAndWriteDenied: true, competing: competing.map(x => ({ status: x.status, error: x.reason?.message })) });
});

test('G2 actual DSH bash tool cannot bypass private boundary when session requests danger-full-access', async t => {
  let secret;
  const f = await nativeFixture(t, 'private-bash-fixed', (_options, ordinal) => ordinal === 1 ? chunks([
    { type: 'tool-call', id: 'bash-private', name: 'bash', arguments: JSON.stringify({ command: '/bin/cat ' + "'" + secret.replaceAll("'", "'\\''") + "'", description: 'Read synthetic private canary' }) },
    { type: 'tool-call', id: 'bash-public', name: 'bash', arguments: JSON.stringify({ command: '/bin/echo PUBLIC_BASH_CANARY', description: 'Synthetic positive control' }) },
  ]) : answer('Synthetic bash checks complete.'));
  const privateRoot = join(f.root, 'private'), runtimeRoot = join(f.root, 'runs');
  for (const p of [privateRoot, runtimeRoot]) mkdirSync(p);
  secret = join(privateRoot, 'secret'); writeFileSync(secret, 'PRIVATE_BASH_CANARY');
  const [{ default: Local }, { default: Working }, { default: Subprocess }, { default: Sandbox }, { default: Policy }, { default: Bash }, ShellEnv, BashTools] = await Promise.all([
    load('@deepseek-ai/dsh-fs-local'), load('@deepseek-ai/dsh-working-directory'), load('@deepseek-ai/dsh-subprocess-local'),
    load('@deepseek-ai/dsh-sandbox-local'), load('@deepseek-ai/dsh-sandbox-policy'), load('@deepseek-ai/dsh-bash-sandbox'),
    load('@deepseek-ai/dsh-shell-env'), load('@deepseek-ai/dsh-tool-bash'),
  ]);
  await active(await f.ctx.plugin(Local, { cwd: f.root }));
  await active(await f.ctx.plugin(Working, { defaultDirectory: f.root }));
  await active(await f.ctx.plugin(Subprocess)); await active(await f.ctx.plugin(Sandbox));
  await active(await f.ctx.plugin(Policy, { mode: 'danger-full-access', workspaceRoot: f.root }));
  const Protected = protectedBashClass(Bash, async sessionPolicy => processPolicy({ workspace: f.root, protectedRoots: [privateRoot], runtimeRoot,
    immutableRoots: [host], sessionPolicy, authorizedWriteRoots: [f.root] }));
  await active(await f.ctx.plugin(Protected, { cwd: f.root, timeoutMs: 5000 }));
  await active(await f.ctx.plugin(ShellEnv, { dshHome: f.root }));
  const agent = await f.agent('private-bash', async owner => { await active(await owner.plugin(BashTools, { enableRunInBackground: false })); });
  agent.session.append('sandbox/mode', { mode: 'danger-full-access' });
  await f.run(agent, 'Exercise native bash with broad user policy');
  const results = agent.session.snapshotEvents().filter(e => e.type === 'tool/result');
  assert.equal(results.length, 2);
  const denied = results.find(e => e.data.message.toolCallId === 'bash-private');
  const control = results.find(e => e.data.message.toolCallId === 'bash-public');
  assert.ok(denied.data.message.isError, JSON.stringify(denied));
  assert.ok(textOf([control.data.message]).includes('PUBLIC_BASH_CANARY'));
  assert.ok(!textOf(f.requests.at(-1).messages).includes('PRIVATE_BASH_CANARY'));
  save(join(f.root, 'gate.json'), { G2Bash: 'pass', requestedMode: 'danger-full-access', results });
});
