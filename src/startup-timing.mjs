// Records how long each Arcfold startup step took, one JSON line per startup.
// Only step names, durations, the version and an error code are written; never
// conversation, goal or credential content. Recording must never affect startup.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const STARTUP_TIMING_FILE = 'startup-timings.jsonl';
export const STARTUP_TIMING_LIMIT = 50;

function packageVersion() {
  try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? 'unknown'; }
  catch { return 'unknown'; }
}
const errorCode = error => typeof error?.code === 'string' && error.code ? error.code : error?.name ?? 'Error';

export class StartupTiming {
  constructor({ directory, version = packageVersion(), now = Date.now, uptimeMs = () => Math.round(process.uptime() * 1000), logger } = {}) {
    Object.assign(this, { directory, version, now, logger });
    this.started = now();
    this.hostUptimeMs = uptimeMs();
    this.steps = [];
    this.failedStep = undefined;
    this.done = false;
  }
  step(name, fn) {
    const begin = this.now();
    const end = failed => { this.steps.push({ name, ms: this.now() - begin }); if (failed && this.failedStep === undefined) this.failedStep = name; };
    let value;
    try { value = fn(); } catch (error) { end(true); throw error; }
    if (typeof value?.then !== 'function') { end(false); return value; }
    return value.then(result => { end(false); return result; }, error => { end(true); throw error; });
  }
  finish(error) {
    if (this.done) return; this.done = true;
    const totalMs = this.now() - this.started;
    const entry = { version: this.version, startedAt: new Date(this.started).toISOString(), hostUptimeMs: this.hostUptimeMs,
      steps: this.steps, totalMs, result: error ? 'failed' : 'ok',
      ...(error ? { failedStep: this.failedStep ?? 'unknown', errorCode: errorCode(error) } : {}) };
    try { this.logger?.info?.(`Arcfold startup ${entry.result} in ${totalMs} ms (DSH had been running ${this.hostUptimeMs} ms)`); } catch {}
    try { this.write(entry); }
    catch (failure) { try { this.logger?.warn?.(`Arcfold startup timing was not recorded: ${errorCode(failure)}`); } catch {} }
  }
  write(entry) {
    const file = join(this.directory, STARTUP_TIMING_FILE);
    let previous = [];
    try { previous = readFileSync(file, 'utf8').split('\n').filter(line => { try { JSON.parse(line); return true; } catch { return false; } }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const kept = [...previous, JSON.stringify(entry)].slice(-STARTUP_TIMING_LIMIT);
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, kept.join('\n') + '\n', { mode: 0o600 });
    renameSync(temporary, file);
  }
}

export const untimed = Object.freeze({ step: (name, fn) => fn() });
