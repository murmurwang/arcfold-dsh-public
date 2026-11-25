import { fail } from './contracts.mjs';

// Derived views live only inside one synchronous recovery/scan. Repository
// writes and changes to the host-frozen source arrays discard every view.
// Nothing survives an await, and callers never receive the cached objects.
export class ReadScope {
  constructor(repository, sourceVersion = () => []) {
    this.repo = repository; this.sourceVersion = sourceVersion; this.active = null;
  }
  run(read) {
    if (read.constructor.name === 'AsyncFunction') fail('ASYNC_READ_SCOPE', 'Read scopes must be synchronous');
    if (this.active) return this.invoke(read);
    this.active = { stamp: null, values: new Map() };
    try { return this.invoke(read); } finally { this.active = null; }
  }
  invoke(read) {
    const result = read();
    if (result?.then) fail('ASYNC_READ_SCOPE', 'Read scopes cannot cross an await');
    return result;
  }
  stamp() { return [this.repo.readVersion(), ...this.sourceVersion()]; }
  same(a, b) { return a?.length === b.length && b.every((value, i) => Object.is(value, a[i])); }
  memo(key, read, select = structuredClone) {
    if (!this.active) return select(read());
    const stamp = this.stamp();
    if (!this.same(this.active.stamp, stamp)) { this.active.stamp = stamp; this.active.values.clear(); }
    if (this.active.values.has(key)) return select(this.active.values.get(key));
    const value = this.invoke(read);
    // A derived read can discover or write evidence. Never cache a result
    // assembled across that change; the next call recomputes it.
    if (this.same(stamp, this.stamp())) this.active.values.set(key, value);
    return select(value);
  }
}
