import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';

export function matchingProcesses(rows, { uid, userData }) {
  return rows.split('\n').map(row => row.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/u)).filter(Boolean)
    .filter(([, , owner, args]) => Number(owner) === uid &&
      args.startsWith('/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness ') &&
      args.includes('--user-data-dir=' + userData + ' ') &&
      args.includes('--remote-debugging-address=127.0.0.1 ') &&
      /(?:^| )--remote-debugging-port=48622(?: |$)/u.test(args))
    .map(([, pid]) => Number(pid));
}

export async function probe(root, uid) {
  assert.equal(userInfo().uid, uid);
  const rows = execFileSync('/bin/ps', ['-ww', '-U', String(uid), '-o', 'pid=,uid=,args='], { encoding: 'utf8' });
  const pids = matchingProcesses(rows, { uid, userData: join(root, 'electron') });
  assert.equal(pids.length, 1, '尚未核对到唯一的测试 DSH 进程。');
  const listeners = execFileSync('/usr/sbin/lsof', ['-nP', '-iTCP:48622', '-sTCP:LISTEN', '-Fp'],
    { encoding: 'utf8' }).split('\n').filter(line => /^p\d+$/u.test(line)).map(line => Number(line.slice(1)));
  assert.deepEqual([...new Set(listeners)], pids, '窗口读取端口不属于当前测试 DSH 进程。');
  const targets = await (await fetch('http://127.0.0.1:48622/json/list',
    { signal: AbortSignal.timeout(2500) })).json();
  const page = targets.find(row => row.type === 'page' && row.url.startsWith('dsh-app://app/'));
  assert.ok(page && /^ws:\/\/127\.0\.0\.1:48622\//u.test(page.webSocketDebuggerUrl));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  try {
    const text = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('测试窗口尚未就绪。')), 3000);
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('窗口读取失败。')); }, { once: true });
      ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate',
        params: { expression: 'JSON.stringify({ready:document.readyState,text:document.body?.innerText??""})',
          returnByValue: true } })), { once: true });
      ws.addEventListener('message', event => {
        const data = JSON.parse(event.data);
        if (data.id !== 1) return;
        clearTimeout(timer);
        if (typeof data.result?.result?.value !== 'string') reject(new Error('没有窗口内容。'));
        else resolve(data.result.result.value);
      });
    });
    const state = JSON.parse(text);
    assert.ok(['interactive', 'complete'].includes(state.ready) && state.text.trim().length > 0);
    return { ready: true, uid, pid: pids[0], page: page.url,
      ui_sha256: createHash('sha256').update(state.text).digest('hex'),
      meaning: '仅确认真实窗口可读；不表示安装、对话、更新或实际验收通过。' };
  } finally { ws.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = resolve(process.argv[2]);
    const uid = Number(process.argv[3]);
    console.log(JSON.stringify(await probe(root, uid)));
  } catch {
    console.error('测试窗口尚未通过进程身份和页面就绪核对。');
    process.exitCode = 1;
  }
}

