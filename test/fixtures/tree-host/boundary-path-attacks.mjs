import { readFileSync, renameSync, linkSync } from 'node:fs';
const input = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--input') + 1], 'utf8'));
console.log(JSON.stringify({ event: 'body-entered', op: input.op }));
try {
  if (input.op === 'rename-parent') renameSync(input.source, input.target);
  else if (input.op === 'hardlink') linkSync(input.source, input.target);
  else throw new Error('Unknown fixture operation');
  const value = readFileSync(input.readPath ?? input.target, 'utf8');
  console.log(JSON.stringify({ event: 'effect-allowed', detail: value === 'SYNTHETIC_SECRET_CANARY' ? 'canary-read' : 'unexpected' }));
} catch (error) { console.log(JSON.stringify({ event: 'effect-denied', code: error.code, message: error.message })); process.exitCode = 13; }
