import test from 'node:test';
import assert from 'node:assert/strict';
import { TreeRepository } from '../src/tree/repository.mjs';
import { ReadScope } from '../src/tree/read-scope.mjs';
import { fixture } from './fixtures/tree-domain/helpers.mjs';
import { learningFixture } from './fixtures/tree-learning/helpers.mjs';
import { MetricsService } from '../src/tree/metrics.mjs';
import { digest } from '../src/tree/contracts.mjs';
import { SignalService } from '../src/tree/tree.mjs';

const update = (repo, value) => repo.transaction(() => { const meta = repo.meta(); repo.save('tree_meta', { ...meta, testValue: value }, meta.revision); });

test('a synchronous scope reuses reads, isolates returned objects and expires on exit or failure', t => {
  const f = fixture(t), scope = new ReadScope(f.repo); let calls = 0;
  const read = () => scope.memo('value', () => ({ count: ++calls, values: [1] }));
  scope.run(() => { read().values.push(2); assert.deepEqual(scope.run(read), { count: 1, values: [1] }); });
  assert.equal(read().count, 2); scope.run(() => assert.equal(read().count, 3));
  assert.throws(() => scope.run(() => { read(); throw new Error('test'); }), /test/);
  assert.equal(scope.active, null); assert.equal(read().count, 5);
  assert.throws(() => scope.run(async () => {}), { code: 'ASYNC_READ_SCOPE' });
  assert.throws(() => scope.run(() => Promise.resolve()), { code: 'ASYNC_READ_SCOPE' });
  assert.equal(scope.active, null);
});

test('own writes, rollback and a second database connection invalidate scoped reads', t => {
  const { repo } = fixture(t), scope = new ReadScope(repo); let calls = 0;
  const read = () => scope.memo('value', () => ({ value: repo.meta().testValue, call: ++calls }));
  const other = new TreeRepository({ treeFilename: repo.filename, userId: repo.userId }); t.after(() => other.close());
  scope.run(() => {
    assert.equal(read().call, 1); update(repo, 'own'); assert.equal(read().value, 'own');
    assert.throws(() => repo.transaction(() => { update(repo, 'rolled back'); assert.equal(read().value, 'rolled back'); throw new Error('rollback'); }), /rollback/);
    assert.equal(read().value, 'own'); update(other, 'other'); assert.equal(read().value, 'other'); assert.equal(calls, 5);
  });
});

test('source replacement, append, and reads that write cannot leave a reusable old view', t => {
  const { repo } = fixture(t); let events = [{ seq: 0 }], calls = 0;
  const scope = new ReadScope(repo, () => [events, events.length, events.at(-1)]);
  const read = () => scope.memo('source', () => ++calls);
  scope.run(() => {
    assert.equal(read(), 1); assert.equal(read(), 1); events = [...events]; assert.equal(read(), 2);
    events.push({ seq: 1 }); assert.equal(read(), 3); events[1] = { seq: 1, changed: true }; assert.equal(read(), 4);
    scope.memo('write', () => { update(repo, 'changed during read'); return 1; }); assert.equal(read(), 5);
  });
});

test('episode reuse respects category corrections, withdrawn original evidence, and goal reassignment', async t => {
  const f = learningFixture(t), a = f.create('甲'), b = f.create('乙'); const { turn, source } = await f.feedback(a, 'misread');
  const scope = new ReadScope(f.repo, () => [f.revoked.size]); f.signals.readScope = scope;
  scope.run(() => {
    assert.equal(f.signals.episodes()[0].signals[0].category, 'misread');
    const signal = f.repo.list('tree_signals')[0], service = new SignalService({ repository: f.repo, resolveSource: f.resolveSource, context: () => f.context });
    f.asUser(); const replacement = Object.fromEntries(['eventId','subjectRefs','dimension','subitem','category','polarity','evidenceKind','sourceRefs','nodeIds','confidence'].map(k => [k, signal[k]]));
    service.correct(f.cmd({ signalId: signal.id, replacement: { ...replacement, category: 'approved', polarity: 'strong' } }, f.expected('tree_signals', signal.id)));
    assert.equal(f.signals.episodes()[0].signals[0].category, 'approved');
    f.tree.correctAssignment(f.cmd({ turnId: turn.id, nodeIds: [b], sourceRefs: [] }, f.expected('tree_turns', turn.id)));
    assert.deepEqual(f.signals.episodes()[0].nodeIds, [b]);
    f.revoked.add(digest(source.ref)); assert.equal(f.signals.episodes().length, 0);
  });
});

test('scoped ordinal lookup has the same first/latest semantics and sees later events', async t => {
  const f = learningFixture(t), node = f.create('统计'); const turn = await f.turn(node);
  const metrics = new MetricsService({ repository: f.repo, experience: f.experience, signals: f.signals });
  const expected = [metrics.ordinal('tree_turns', turn.id), metrics.ordinal('tree_turns', turn.id, { first: true })];
  metrics.readScope = new ReadScope(f.repo);
  metrics.readScope.run(() => {
    assert.deepEqual([metrics.ordinal('tree_turns', turn.id), metrics.ordinal('tree_turns', turn.id, { first: true })], expected);
    f.asUser(); f.tree.correctAssignment(f.cmd({ turnId: turn.id, nodeIds: [f.repo.rootId()], sourceRefs: [] }, f.expected('tree_turns', turn.id)));
    assert.ok(metrics.ordinal('tree_turns', turn.id) > expected[0]);
    assert.equal(metrics.ordinal('tree_turns', turn.id, { first: true }), expected[1]);
    assert.equal(metrics.ordinal('tree_turns', 'missing'), 0);
  });
});
