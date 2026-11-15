#!/usr/bin/env node
import { runRuntimeCommand } from '../src/runtime-command.mjs';

const controller = new AbortController();
process.once('SIGINT', () => controller.abort(new Error('Command interrupted')));
process.once('SIGTERM', () => controller.abort(new Error('Command stopped')));
try {
  const result = await runRuntimeCommand(process.argv.slice(2), { signal: controller.signal });
  console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({ completed: false, code: error.code ?? 'command_failed', message: String(error.message) }));
  process.exitCode = 1;
}
