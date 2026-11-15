import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, accessSync, closeSync, createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, join, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { answer, bundle, candidate, dummyKey, goal, hash, hostVersion, message, modelEndpoint, modelOrigin,
  newer, older, registryOrigin } from './fixture.mjs';

const app = '/Applications/DeepSeek Harness.app';
const applicationArchive = 'f21d83abfb33d463822a52c439cc9b15c8245dbce4ae4cf9424c90eae8eba94f';
const officialEndpoint = 'https://api.deepseek.com/anthropic/v1/messages';
const names = ['desktop-configuration.json', 'desktop-initialization.json', 'desktop-initialization-completed.json'];
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const save = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
const privatePath = (path, type) => {
  const stat = lstatSync(path);
  assert.ok(type === 'file' ? stat.isFile() && stat.nlink === 1 : stat.isDirectory(), '测试路径类型与预期不符');
  assert.equal(stat.uid, process.getuid(), '测试文件必须属于当前账户');
  assert.ok(!(stat.mode & 0o077), '测试路径需要保留为私人资料');
  return stat;
};

export function requireTestAccount() {
  const { username, uid, homedir } = userInfo();
  assert.ok(username === 'arcfold-test' && uid > 501, '请从 macOS 的普通账户 arcfold-test 打开测试。');
  assert.equal(process.platform, 'darwin');
  assert.equal(process.arch, 'arm64');
  assert.ok(!execFileSync('/usr/bin/id', ['-Gn'], { encoding: 'utf8' }).trim().split(/\s+/u).includes('admin'),
    '这个演练需要 macOS 普通账户。');
  const home = realpathSync(homedir);
  assert.equal(lstatSync(home).uid, uid);
  assert.equal(basename(home), username);
  assert.throws(() => accessSync(app, constants.W_OK), { code: 'EACCES' }, '测试账户必须无法覆盖原版应用');
  return home;
}

async function checkHost() {
  const version = execFileSync('/usr/bin/plutil',
    ['-extract', 'CFBundleShortVersionString', 'raw', join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
  assert.equal(version, hostVersion, '当前 DSH 版本和已验证的发行候选不一致。');
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  const checksum = createHash('sha256');
  for await (const bytes of createReadStream(join(app, 'Contents/Resources/app.asar'))) checksum.update(bytes);
  assert.equal(checksum.digest('hex'), applicationArchive, '原版 DSH 归档未通过核对。');
}

async function checkProductFileProtection(root, installed) {
  const link = pathToFileURL(join(installed.core, 'src/tree/host-process.mjs'));
  const { confinedArgv, processPolicy } = await import(link);
  const trial = mkdtempSync(join(root, 'permission-check-'));
  try {
    const workspace = join(trial, 'workspace'), protectedRoot = join(workspace, 'owned');
    const runtimeRoot = join(trial, 'runtime');
    for (const path of [workspace, protectedRoot, runtimeRoot]) mkdirSync(path, { mode: 0o700 });
    const allowed = join(workspace, 'test.txt'), protectedFile = join(protectedRoot, 'test.txt');
    writeFileSync(protectedFile, 'kept', { mode: 0o600 });
    const policy = processPolicy({ workspace, protectedRoots: [protectedRoot], runtimeRoot,
      sessionPolicy: { mode: 'workspace-write', workspaceRoot: workspace }, authorizedWriteRoots: [workspace] });
    const command = 'printf allowed > "$1" || exit 3\nif printf replaced > "$2"; then exit 4; fi';
    const wrapped = confinedArgv({ policy, kind: 'main', argv: ['/bin/sh', '-c', command, 'probe', allowed, protectedFile] });
    const check = spawnSync(wrapped.argv[0], wrapped.argv.slice(1), { encoding: 'utf8', timeout: 10000 });
    assert.equal(check.status, 0, 'Arcfold 文件保护预检失败。' + (check.stderr ?? ''));
    assert.equal(readFileSync(allowed, 'utf8'), 'allowed');
    assert.equal(readFileSync(protectedFile, 'utf8'), 'kept');
    console.log('Arcfold 文件保护生效。工作区可写，受保护资料的写入被拒绝。');
  } finally {
    rmSync(trial, { recursive: true, force: true });
  }
}

export async function configureTestModel(root, dsh, installed) {
  const data = join(dsh, 'arcfold-desktop');
  if (!existsSync(data)) return false;
  assert.ok(installed, '已存在测试设置，须核对两份插件包后再启动。');
  privatePath(data, 'directory');
  const paths = names.map(name => join(data, name));
  paths.forEach(path => privatePath(path, 'file'));
  const [config, intent, complete] = paths.map(json);
  const local = config.options.local;
  assert.equal(config.schema, 'arcfold-desktop-configuration-v1');
  assert.equal(intent.schema, 'arcfold-desktop-initialization-v1');
  assert.equal(complete.schema, 'arcfold-desktop-initialization-completed-v1');
  assert.equal(local.dataRoot, data);
  assert.equal(local.workspace, join(dsh, 'arcfold-workspace'));
  assert.equal(config.options.runtimeRoot, join(dsh, 'arcfold-desktop-processes'));
  assert.equal(local.installationFile, join(installed.core, 'package.json'));
  const route = local.transport.routes['deepseek-official'];
  assert.equal(route.apiKeyRef, 'DEEPSEEK_API_KEY');
  assert.equal(route.ledgerPath, join(data, 'requests/deepseek-web.sqlite'));
  const ledger = privatePath(route.ledgerPath, 'file');
  assert.deepEqual(complete.ledger, { dev: ledger.dev, ino: ledger.ino });
  assert.equal(intent.inputHash, hash(readFileSync(paths[0])));
  assert.equal(complete.inputHash, intent.inputHash);
  if (route.endpoint === modelEndpoint && route.allowLocalTestEndpoint === true) return true;
  assert.equal(route.endpoint, officialEndpoint);
  assert.equal(route.allowLocalTestEndpoint, undefined);
  assert.equal(installed.version, older, '只在首次安装的合成配置中设置模型地址。');
  const store = join(installed.core, 'src/store.mjs');
  const { canonicalJson } = await import(pathToFileURL(store));
  const backup = join(root, 'original-setup');
  mkdirSync(backup, { mode: 0o700 });
  for (let i = 0; i < paths.length; i++)
    writeFileSync(join(backup, names[i]), readFileSync(paths[i]), { mode: 0o600, flag: 'wx' });
  route.endpoint = modelEndpoint;
  route.allowLocalTestEndpoint = true;
  const bytes = canonicalJson(config) + '\n';
  complete.inputHash = intent.inputHash = hash(bytes);
  const updates = [bytes, JSON.stringify(intent) + '\n', JSON.stringify(complete) + '\n'];
  for (let i = 0; i < paths.length; i++) {
    const temporary = paths[i] + '.test-new';
    writeFileSync(temporary, updates[i], { mode: 0o600, flag: 'wx' });
    renameSync(temporary, paths[i]);
  }
  return true;
}

export function installation(dsh) {
  const modules = join(dsh, 'profiles/desktop/node_modules/@arcfold');
  if (!existsSync(join(modules, 'dsh'))) return null;
  const [core, ui] = ['dsh', 'dsh-method-ui'].map(name => realpathSync(join(modules, name)));
  assert.ok([core, ui].every(path => path.startsWith(dsh + sep)), '插件必须来自测试账户的专用目录。');
  const corePackage = json(join(core, 'package.json')), uiPackage = json(join(ui, 'package.json'));
  const version = corePackage.version;
  assert.ok([older, newer].includes(version));
  assert.equal(corePackage.name, '@arcfold/dsh');
  assert.equal(uiPackage.name, '@arcfold/dsh-method-ui');
  assert.equal(uiPackage.version, version, '两份插件安装包需要是同一版本。');
  assert.equal(corePackage.engines.dsh, hostVersion);
  for (const [dir, pkg] of [[core, corePackage], [ui, uiPackage]]) {
    const row = bundle.packages.find(row => row.name === pkg.name && row.version === version);
    assert.ok(row);
    for (const [path, sha256] of Object.entries(row.files)) {
      const full = realpathSync(join(dir, path));
      assert.ok(full.startsWith(dir + sep));
      assert.equal(hash(readFileSync(full)), sha256, '实际安装内容不符 ' + path);
    }
  }
  return { core, version };
}

export function capture(root, dsh, installed) {
  const file = join(dsh, 'arcfold-desktop/tree.sqlite');
  if (!installed || !existsSync(file)) return;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const node = db.prepare("SELECT body FROM records WHERE kind='tree_nodes' AND json_extract(body,'$.name')=?").all(goal);
    if (node.length === 0) return;
    assert.equal(node.length, 1, '发现多个同名测试目标。');
    const { id, name, parentId } = JSON.parse(node[0].body);
    const turns = db.prepare("SELECT body FROM records WHERE kind='tree_turns' AND json_extract(body,'$.status')='settled' ORDER BY id")
      .all().map(row => JSON.parse(row.body)).filter(row => row.nodeIds.includes(id));
    if (turns.length === 0) return;
    const evidence = { candidate, version: installed.version, goal: { id, name, parentId },
      turns: turns.map(turn => ({ id: turn.id, sessionId: turn.sessionId, nativeTurn: turn.nativeTurn,
        sourceHash: hash(JSON.stringify([turn.userSourceRefs, turn.experienceRefs ?? turn.sourceRefs])) })) };
    if (installed.version === newer) {
      const before = json(join(root, older + '-readback.json'));
      assert.deepEqual({ ...before, version: newer }, evidence, '更新前后的目标或会话来源不同。');
    }
    const path = join(root, installed.version + '-readback.json');
    if (existsSync(path)) assert.deepEqual(json(path), evidence, '同一测试版本的回执已变化。');
    else save(path, evidence);
    console.log('已核对目标和会话来源。回执 ' + path);
    return evidence;
  } finally {
    db.close();
  }
}

export async function launch(root, gitMode = false) {
  const home = requireTestAccount();
  const dsh = join(root, 'dsh'), tmp = join(root, 'tmp');
  const identity = join(root, 'rehearsal.json');
  const rc = join(root, 'npmrc');
  const expectedRc = 'registry=' + registryOrigin + '/\nfetch-retries=0\naudit=false\n';
  for (const url of [registryOrigin + '/-/ping', modelOrigin + '/health'])
    assert.ok((await fetch(url, { signal: AbortSignal.timeout(2500) })).ok, '请先从工作入口启动本机测试服务。');
  await checkHost();
  if (!existsSync(root)) {
    mkdirSync(root, { mode: 0o700 });
    for (const path of [dsh, tmp, join(root, 'electron')]) mkdirSync(path, { mode: 0o700 });
    writeFileSync(rc, expectedRc, { flag: 'wx', mode: 0o600 });
    writeFileSync(join(root, 'npmrc-global'), '', { flag: 'wx', mode: 0o600 });
    save(identity, { candidate, uid: process.getuid() });
  }
  for (const path of [root, dsh, tmp, join(root, 'electron')]) privatePath(path, 'directory');
  privatePath(identity, 'file');
  privatePath(rc, 'file');
  assert.deepEqual(json(identity), { candidate, uid: process.getuid() });
  assert.equal(readFileSync(rc, 'utf8'), expectedRc);
  const lockPath = join(root, 'launch-in-use');
  const lock = openSync(lockPath, 'wx', 0o600);
  try {
    const installed = gitMode ? null : installation(dsh);
    if (installed) await checkProductFileProtection(root, installed);
    const configured = gitMode ? false : await configureTestModel(root, dsh, installed);
    if (configured) {
      console.log('模型指向本机模拟服务。要发送的测试消息如下。\n' + message + '\n应看到的回复如下。\n' + answer);
    } else if (!gitMode) {
      console.log('先按包名安装 @arcfold/dsh ' + older + '，完成首次设置后退出 DSH。重新打开本入口再发送测试消息。');
    }
    const appPath = join(app, 'Contents/MacOS/DeepSeek Harness');
    const env = { PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, TMPDIR: tmp,
      DSH_HOME: dsh, DSH_TELEMETRY_DISABLED: '1', LANG: 'zh_CN.UTF-8',
      npm_config_userconfig: rc, npm_config_globalconfig: join(root, 'npmrc-global'), npm_config_registry: registryOrigin + '/', npm_config_fetch_retries: '0',
      ...(configured ? { DEEPSEEK_API_KEY: dummyKey } : {}) };
    const product = spawn(appPath, ['--user-data-dir=' + join(root, 'electron'),
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=48622'], {
      cwd: root, env, stdio: ['ignore', 'inherit', 'inherit'],
    });
    const exitCode = await new Promise((resolve, reject) => {
      product.once('exit', resolve);
      product.once('error', reject);
    });
    assert.equal(exitCode, 0, 'DSH 在演练完成前退出。');
    if (configured) capture(root, dsh, installation(dsh));
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
  }
}
