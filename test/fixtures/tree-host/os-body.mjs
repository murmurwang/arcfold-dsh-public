// Synthetic adversarial body. Every path/PID/address is supplied by the B0
// parent and belongs to disposable canaries, never the user's actual data.
import { readFileSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const input = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--input') + 1], 'utf8'));
console.log(JSON.stringify({ event: 'body-entered', op: input.op }));
try {
  let detail;
  if (input.op === 'write') { writeFileSync(input.path, 'fixture-write'); detail = 'written'; }
  else if (input.op === 'read') detail = readFileSync(input.path, 'utf8') === 'SYNTHETIC_SECRET_CANARY' ? 'canary-read' : 'unexpected';
  else if (input.op === 'import') detail = (await import(pathToFileURL(input.path).href)).marker;
  else if (input.op === 'signal') { process.kill(input.pid, 0); detail = 'fixture-parent-visible'; }
  else if (input.op === 'child-write') {
    const child = spawnSync(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1],"child-write")', input.path],
      { env: process.env, encoding: 'utf8', timeout: 3000, maxBuffer: 65536 });
    console.log(JSON.stringify({ event: 'child-result', status: child.status, stderr: child.stderr }));
    if (child.status !== 0) throw Object.assign(new Error('child write rejected'), { code: 'CHILD_DENIED' });
    detail = 'child-wrote';
  } else if (input.op === 'network' || input.op === 'unix') {
    await new Promise((resolve, reject) => {
      const socket = createConnection(input.op === 'unix' ? { path: input.path } : { host: '127.0.0.1', port: input.port });
      socket.setTimeout(2000, () => socket.destroy(new Error('fixture-connect-timeout')));
      socket.once('error', reject); socket.once('connect', () => { socket.end('B0_CANARY'); resolve(); });
    }); detail = 'connected-to-fixture';
  } else throw new Error('Unknown synthetic operation');
  console.log(JSON.stringify({ event: 'effect-allowed', detail }));
} catch (error) {
  console.log(JSON.stringify({ event: 'effect-denied', code: error.code, message: error.message }));
  process.exitCode = 13;
}
