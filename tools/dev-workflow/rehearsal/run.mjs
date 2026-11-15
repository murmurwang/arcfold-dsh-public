import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { bundle, candidate, older, newer, hostVersion, message, answer, goal, hash, dummyKey, modelOrigin, registryOrigin } from './fixture.mjs';
import { capture, installation, launch, requireTestAccount } from './desktop.mjs';

const home = requireTestAccount();
const root = join(home, 'Arcfold-DSH-Rehearsal-' + bundle.id);
const gitRoot = root + '-git';
const stateDir = root + '-evidence';
if (!existsSync(stateDir)) mkdirSync(stateDir, { mode: 0o700 });
const statePath = join(stateDir, 'registry.json');
const logPath = join(stateDir, 'events.jsonl');
const get = file => JSON.parse(readFileSync(file, 'utf8'));
const events = () => existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const record = (name, value) => writeFileSync(join(stateDir, name + '.json'), JSON.stringify(value, null, 2) + '\n',
  { mode: 0o600, flag: 'wx' });
const setRegistry = value => {
  writeFileSync(statePath + '.new', JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  renameSync(statePath + '.new', statePath);
};
const read = path => fetch(path, { signal: AbortSignal.timeout(2500) });
const ready = async path => {
  for (let i = 0; i < 70; i++) {
    if (await read(path).then(res => res.ok, () => false)) return;
    await delay(100);
  }
  throw new Error('本机测试服务没有启动。');
};
const selectedBundle = join(root, 'dsh');
const failurePackage = '@arcfold/dsh@' + newer;
const action = process.argv[2] ?? 'launch';

async function withServices(callback) {
  for (const url of [registryOrigin + '/-/ping', modelOrigin + '/health', 'http://127.0.0.1:48622/json/version'])
    assert.equal(await read(url).then(() => true, () => false), false, '上一个测试窗口或服务仍在使用端口。');
  if (!existsSync(statePath)) setRegistry({ latest: older });
  const children = [];
  const start = (name, args, env) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL(name, import.meta.url)), ...args],
      { env, stdio: ['ignore', 'pipe', 'inherit'] });
    const stopped = new Promise(resolve => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
      child.once('error', error => resolve({ error: error.message }));
    });
    children.push({ child, stopped });
    createInterface({ input: child.stdout }).on('line', line => {
      if (!line.startsWith('{')) return;
      const row = JSON.parse(line);
      writeFileSync(logPath, JSON.stringify({ ...row, at: new Date().toISOString() }) + '\n', { mode: 0o600, flag: 'a' });
      if (row.component === 'loopback-model' && row.role === 'main' && get(statePath).latest === older)
        setRegistry({ latest: newer, failDownload: failurePackage });
    });
  };
  const env = { PATH: '/usr/local/bin:/usr/bin:/bin', ARCFOLD_FIXTURE_KEY: dummyKey };
  try {
    start('registry.mjs', [statePath], env);
    start('model.mjs', [], env);
    await Promise.all([ready(registryOrigin + '/-/ping'), ready(modelOrigin + '/health')]);
    await callback();
  } finally {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.all(children.map(({ stopped }) => stopped));
  }
}

async function display(rootPath) {
  const args = execFileSync('/bin/ps', ['-ww', '-U', 'arcfold-test', '-o', 'args='], { encoding: 'utf8' });
  assert.ok(args.split('\n').some(line => line.startsWith('/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness ') &&
    line.includes('--user-data-dir=' + join(rootPath, 'electron')) && line.includes('--remote-debugging-port=48622')),
  '当前窗口须由测试入口启动。');
  const targets = await (await read('http://127.0.0.1:48622/json/list')).json();
  const page = targets.find(row => row.type === 'page' && row.url.startsWith('dsh-app://app/'));
  assert.ok(page && /^ws:\/\/127\.0\.0\.1:48622\//.test(page.webSocketDebuggerUrl), '找不到本机测试窗口。');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('读取测试窗口超时。')), 5000);
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('读取测试窗口失败。')); }, { once: true });
      ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate',
        params: { expression: 'document.body.innerText', returnByValue: true } })), { once: true });
      ws.addEventListener('message', e => {
        const data = JSON.parse(e.data);
        if (data.id !== 1) return;
        clearTimeout(timer);
        if (typeof data.result?.result?.value !== 'string') reject(new Error('测试窗口未返回界面文字。'));
        else resolve(data.result.result.value);
      });
    });
  } finally {
    ws.close();
  }
}

function evidence(name, rows) {
  record(name, rows);
  return { status: 'pass', evidence: name + '.json' };
}

switch (action) {
  case 'launch':
    if (existsSync(join(stateDir, 'restored.json')) && !existsSync(join(stateDir, 'restart-start.json')) &&
        installation(selectedBundle)?.version === newer) {
      record('restart-start', { modelRequests: events().filter(row => row.component === 'loopback-model').length });
    }
    await withServices(() => launch(root));
    break;
  case 'git':
    await withServices(() => launch(gitRoot, true));
    break;
  case 'restored': {
    const installed = installation(selectedBundle);
    assert.equal(installed?.version, older, '失败更新后须已恢复两份旧包。');
    const model = events().filter(row => row.component === 'loopback-model');
    const failed = events().filter(row => row.event === 'download-failed' && row.package === failurePackage);
    const rollback = events().filter(row => row.event === 'download' && row.package === '@arcfold/dsh@' + older &&
      failed.length && row.at >= failed[0].at);
    assert.ok(model.some(row => row.role === 'main') && failed.length && (rollback.length || installed.version === older));
    const stored = capture(root, selectedBundle, installed);
    assert.ok(stored, '未找到更新前的测试目标和对话。');
    evidence('restored', { version: older, model, failed, rollback, stored });
    setRegistry({ latest: newer });
    console.log('旧版内容已核对，已恢复新版下载。回到同一插件页重新选择更新。');
    break;
  }
  case 'git-section': {
    const manifest = get(join(gitRoot, 'dsh/profiles/desktop/package.json'));
    const spec = manifest.dependencies['@arcfold/dsh'];
    assert.match(spec, /(?:github:|git\+https:\/\/github\.com\/|https:\/\/github\.com\/)/i);
    const body = await display(gitRoot);
    assert.ok(body.includes('@arcfold/dsh'), '先打开这份 GitHub 安装的 Arcfold 详情。');
    const versionSection = body.split('\n').some(line => /^(Versions|版本)$/i.test(line.trim()));
    const observed = versionSection ? 'present' : 'absent';
    record('github-source', { spec, versionSection, textSha256: hash(body), observed });
    const prior = join(stateDir, 'result.json');
    if (existsSync(prior)) {
      const result = get(prior);
      result.checks.github_source_version_section = { status: 'pass', evidence: 'github-source.json', observed };
      record('result-with-github', result);
    }
    console.log('GitHub 安装的版本区块 · ' + (versionSection ? '显示' : '未显示'));
    break;
  }
  case 'finish': {
    assert.ok(existsSync(join(stateDir, 'restored.json')), '先记录下载失败后恢复。');
    const installed = installation(selectedBundle);
    assert.equal(installed?.version, newer);
    const restart = get(join(stateDir, 'restart-start.json'));
    assert.equal(restart.modelRequests, events().filter(row => row.component === 'loopback-model').length,
      '重启读回期间模型收到新的请求。');
    const body = await display(root);
    assert.ok([message, answer, goal].every(text => body.includes(text)), '请打开同一会话和目标，让测试入口读到原话、回复与目标。');
    const readback = capture(root, selectedBundle, installed);
    assert.ok(readback);
    const restored = { status: 'pass', evidence: 'restored.json' };
    const current = evidence('readback', { ...readback, uiSha256: hash(body), version: newer, restart });
    const gitProof = join(stateDir, 'github-source.json');
    const receipt = { account: 'arcfold-test', host: hostVersion, older, newer, source: candidate,
      packages: Object.fromEntries(bundle.packages.filter(row => row.name.startsWith('@arcfold/') && row.version === newer)
        .map(row => [row.name, row.sha256])),
      checks: { fresh_install: restored, synthetic_dialogue: restored, failed_download_restored: restored,
        confirmed_update: current, restart_readback: current,
        github_source_version_section: existsSync(gitProof)
          ? { status: 'pass', evidence: 'github-source.json', observed: get(gitProof).observed }
          : { status: 'unknown', evidence: null } } };
    record('result', receipt);
    console.log(JSON.stringify(receipt));
    console.log('验收回执 ' + join(stateDir, 'result.json'));
    break;
  }
  default:
    throw new Error('选择 launch、restored、finish、git 或 git-section。');
}
