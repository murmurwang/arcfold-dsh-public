import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeFixture } from './fixtures/tree-model/native.mjs';
import { minimal } from './fixtures/tree-model/contracts.mjs';
import { nativeRequestIdentity } from '../src/native-request-authority.mjs';
import { digest } from '../src/tree/contracts.mjs';
import { TreeRepository } from '../src/tree/repository.mjs';
import { TreeJobs } from '../src/tree/jobs.mjs';
import { TreeModelOwner } from '../src/tree/model-owner.mjs';

test('frozen model input derives current source choices and producer targets from trusted input', async t => {
  const f = await nativeFixture(t), seed = f.enqueue('learning'), input = structuredClone(seed.input);
  input.sources.push({ ...input.sources[0], id: 'old-answer', role: 'assistant', origin: 'model' });
  input.currentTurn = { id: 'current', sourceIds: ['s1'] };
  input.outputBindings = { proposalAndFirstResultSourceIds: ['old-answer'] };
  const job = f.jobs.enqueue({ role: 'learning', key: 'current-binding', nodeIds: seed.nodeIds, input, revisionSet: {}, config: seed.modelConfig, trigger: seed.trigger });
  assert.deepEqual(job.input.outputBindings.proposalAndFirstResultSourceIds, []);
  assert.deepEqual(job.input.outputBindings.responseAndDecisionSourceIds, ['s1']);
  assert.equal(digest(job.input), job.inputHash);
  const repair = f.enqueue('improvement', { trigger: { producerRole: 'consolidation' } });
  assert.deepEqual(repair.input.outputBindings.supplementTargets, ['consolidation']);
  assert.equal(repair.input.outputBindings.mode, 'producer_adjustment');
});

test('G4/R12: all seven roles use real native Agent -> patched adapter -> owned transport -> one settled receipt per step', async t => {
  const f = await nativeFixture(t, ({ role, input }) => role === 'attribution' ? { actions: [{ action: 'continue', nodeId: input.scope.nodeIds[0] }], statusChanges: [] } : minimal[role] ?? '合成答复');
  for (const role of ['attribution', 'learning', 'consolidation', 'verification', 'improvement', 'script_writer']) {
    const job = f.enqueue(role), result = await f.owner.run(job.id); assert.equal(result.status, 'committed', JSON.stringify(result.error));
  }
  assert.equal((await f.runMain()).status, 'committed');
  assert.equal(f.requests.length, 7); assert.equal(f.ledger.list().length, 7); assert.ok(f.ledger.list().every(r => r.status === 'settled'));
  assert.equal(new Set(f.ledger.list().map(r => r.metadata.role)).size, 7); assert.equal(f.repo.list('tree_invocations').length, 7);
  assert.ok(f.ledger.list().every(r => r.metadata.treeJobId && r.metadata.treeInvocationId && r.metadata.budgetScope === 'arcfold-tree-v3-150cny'));
  const before = f.requests.length; await f.owner.recover(); assert.equal(f.requests.length, before);
  assert.throws(() => nativeRequestIdentity(f.business, f.ctx.sessions, { sessionId: 'unrelated', purpose: 'extra' }));
});

test('R05: two learning jobs reuse one durable node session; their persisted message identities do not change', async t => {
  const f = await nativeFixture(t); const a = await f.owner.run(f.enqueue('learning').id), b = await f.owner.run(f.enqueue('learning').id);
  assert.equal(a.status, 'committed', JSON.stringify(a.error)); assert.equal(b.status, 'committed', JSON.stringify(b.error)); assert.equal(a.nativeSessionId, b.nativeSessionId); assert.notEqual(a.nativeMessage.id, b.nativeMessage.id);
  const sessions = f.repo.list('tree_learning_sessions'); assert.equal(sessions.length, 1); assert.equal(sessions[0].appendSeq, 2); assert.equal(sessions[0].history.length, 2);
  assert.equal(f.requests.length, 2); assert.equal(f.requests[1].body.messages.filter(m => m.content?.some(b => b.type === 'text' && b.text.includes(a.id))).length, 1);
});

test('R11: writer continuation uses the real native tool loop, only broker tool names and a distinct ledger entry per step', async t => {
  let count = 0; const f = await nativeFixture(t, ({ role }) => role === 'script_writer' && count++ === 0 ? { tool: { name: 'writer_read' } } : minimal[role]);
  const result = await f.owner.run(f.enqueue('script_writer').id); assert.equal(result.status, 'committed', JSON.stringify(result.error)); assert.deepEqual(f.toolRuns, ['writer_read']); assert.equal(result.invocationIds.length, 2); assert.equal(f.ledger.list().length, 2);
  assert.ok(f.requests.every(r => (r.body.tools ?? []).every(t => ['writer_read', 'writer_finish'].includes(t.name))));
});

test('R04/C11: invalid final JSON is preserved without retry or domain commit', async t => {
  const f = await nativeFixture(t, () => '{"understandings":['); const result = await f.owner.run(f.enqueue('learning').id);
  assert.equal(result.status, 'invalid_output', JSON.stringify(result.error)); assert.equal(result.rawMessage.content[0].text, '{"understandings":['); assert.ok(result.rawHash); assert.equal(f.repo.list('tree_learning_sessions')[0].appendSeq, 0);
  await f.owner.run(result.id); await f.owner.recover(); assert.equal(f.requests.length, 1); assert.equal(f.ledger.list()[0].status, 'settled');
});

test('known output exhaustion preserves the native result and settled charge without accepting or resending it', async t => {
  for (const reasoningOnly of [false, true]) await t.test(reasoningOnly ? 'reasoning only' : 'closed JSON prefix', async t => {
    const f = await nativeFixture(t, () => minimal.verification, { sseOptions: { stopReason: 'max_tokens', reasoningOnly } });
    const job = f.enqueue('verification'), result = await f.owner.run(job.id);
    assert.equal(result.status, 'invalid_output'); assert.equal(result.error.code, 'OUTPUT_LIMIT');
    assert.ok(result.nativeLogRef); assert.ok(result.rawMessage); assert.equal(f.ledger.list()[0].status, 'settled');
    assert.equal((await f.owner.run(job.id)).status, 'invalid_output'); await f.owner.recover();
    assert.equal(f.requests.length, 1); assert.equal(f.repo.list('tree_invocations')[0].state, 'result_received');
  });
});
test('R06: input revision changed during provider response makes output stale and preserves its paid receipt', async t => {
  let f; f = await nativeFixture(t, ({ role }) => { const root = f.repo.get('tree_nodes', f.repo.rootId()); f.repo.transaction(() => f.repo.save('tree_nodes', { ...root, name: '我（当前版本）' }, root.revision)); return minimal[role]; });
  const root = f.repo.get('tree_nodes', f.repo.rootId()), job = f.enqueue('learning', { revisionSet: { [`tree_nodes:${root.id}`]: root.revision } });
  const result = await f.owner.run(job.id); assert.equal(result.status, 'stale', JSON.stringify(result.error)); assert.equal(f.ledger.list()[0].status, 'settled'); assert.equal(f.repo.list('tree_items').length, 0);
});

test('R10: auxiliary events cannot recursively schedule main user learning', async t => {
  const f = await nativeFixture(t);
  assert.throws(() => f.enqueue('learning', { trigger: { producerRole: 'learning' } }), { code: 'RECURSIVE_JOB' });
  assert.throws(() => f.enqueue('attribution', { trigger: { origin: 'program' } }), { code: 'PROGRAM_NOT_USER' }); assert.equal(f.requests.length, 0);
  const a = f.enqueue('learning', { key: 'dedup-learning' }), b = f.jobs.enqueue({ role: a.role, key: 'dedup-learning', nodeIds: a.nodeIds, input: a.input, revisionSet: a.inputRevisionSet, config: a.modelConfig, trigger: a.trigger }); assert.equal(b.id, a.id);
  assert.equal(digest(a.input), a.inputHash);
});

for (const boundary of ['receive', 'validate', 'commit']) test(`R04: reopen SQLite and recover after interrupted ${boundary} without a second provider request`, async t => {
  const f = await nativeFixture(t), original = f.jobs[boundary]; let commits = 0;
  f.jobs[boundary] = () => { throw new Error(`Synthetic stop at ${boundary}`); };
  const first = await f.owner.run(f.enqueue('learning').id); f.jobs[boundary] = original;
  assert.equal(first.status, { commit: 'validated', validate: 'result_received', receive: 'unknown' }[boundary]); assert.equal(f.requests.length, 1);
  const repo = new TreeRepository({ treeFilename: f.repo.filename, userId: 'fixture-user' }); t.after(() => repo.close());
  const jobs = new TreeJobs({ repository: repo, assertSources: f.jobs.assertSources });
  const recovered = new TreeModelOwner({ jobs, host: f.ctx, ledgerLookup: id => f.ledger.get(id), applyResult: () => { commits++; return { fixtureReceipt: true }; } });
  const results = await recovered.recover(); assert.equal(results[0].status, 'committed'); assert.equal(commits, 1); assert.equal(repo.list('tree_learning_sessions')[0].appendSeq, 1);
  await recovered.recover(); assert.equal((await recovered.run(first.id)).status, 'committed'); assert.equal(f.requests.length, 1); assert.equal(commits, 1);
});

test('R04: prepared input may send once; submitted learning that never released a request is recorded as not sent and never resends', async t => {
  const f = await nativeFixture(t), prepared = f.jobs.prepare(f.enqueue('attribution').id);
  assert.ok(prepared.nativeSessionId); await f.owner.run(prepared.id); assert.equal(f.requests.length, 1);
  const uncertain = f.enqueue('learning'); f.jobs.prepare(uncertain.id); f.jobs.submit(uncertain.id);
  await f.owner.recover();
  const resolved = f.jobs.get(uncertain.id);
  assert.equal(resolved.status, 'failed'); assert.equal(resolved.error.code, 'LEARNING_INTERRUPTED'); assert.equal(resolved.notSent, true);
  await f.owner.run(uncertain.id); assert.equal(f.requests.length, 1);
  assert.equal(f.jobs.prepare(f.enqueue('learning').id).status, 'prepared');
});

test('a durable native error before any guarded invocation is proved not sent, including cold reconciliation', async t => {
  const f = await nativeFixture(t);
  f.owner.prepareInput = () => { throw new Error('Synthetic input guard rejected before admission'); };
  const record = f.jobs.failBeforeInvocation.bind(f.jobs);
  f.jobs.failBeforeInvocation = () => { throw new Error('Synthetic interruption before recording not-sent proof'); };
  const uncertain = await f.owner.run(f.enqueue('learning').id);
  assert.equal(uncertain.status, 'unknown'); assert.equal(f.requests.length, 0); assert.equal(f.ledger.list().length, 0);
  f.jobs.failBeforeInvocation = record;
  const results = await f.owner.recover(), resolved = results.find(r => r.id === uncertain.id);
  assert.equal(resolved.status, 'failed'); assert.equal(resolved.error.code, 'NATIVE_PRE_DISPATCH'); assert.equal(resolved.notSent, true);
  assert.ok(resolved.nativeLogRef); assert.ok(resolved.eventsHash);
  await f.owner.run(uncertain.id); await f.owner.recover(); assert.equal(f.requests.length, 0);
});

test('R04: terminal text without complete usage remains unknown and keeps its reservation', async t => {
  const f = await nativeFixture(t, () => minimal.learning, { sseOptions: { usage: false } });
  const result = await f.owner.run(f.enqueue('learning').id); assert.equal(result.status, 'unknown'); assert.equal(f.ledger.list()[0].status, 'unknown');
  const reserved = f.ledger.summary().reservedMicroCny; assert.ok(reserved > 0); await f.owner.recover(); await f.owner.run(result.id);
  assert.equal(f.requests.length, 1); assert.equal(f.ledger.summary().reservedMicroCny, reserved);
});

test('R11: a reader receives no tools even if the model asks to call one; no tool body executes', async t => {
  const f = await nativeFixture(t, () => ({ tool: { name: 'writer_read' } }));
  await f.owner.run(f.enqueue('learning').id); assert.equal(f.requests.length, 1); assert.deepEqual(f.toolRuns, []); assert.equal(f.ledger.list().length, 1);
});

test('R11: writer stops before a thirteenth model request and records all twelve charged steps', async t => {
  const f = await nativeFixture(t, ({ ordinal }) => ({ tool: { name: 'writer_read', id: `synthetic-${ordinal}` } }));
  const result = await f.owner.run(f.enqueue('script_writer').id); assert.equal(result.status, 'unknown');
  assert.equal(f.requests.length, 12); assert.equal(f.ledger.list().length, 12); assert.equal(f.toolRuns.length, 12); assert.equal(result.invocationIds.length, 12);
});

test('R11: writer wall-clock deadline cancels the actual host while one model response is pending', async t => {
  let timeout, resolveEntered, release; const entered = new Promise(r => { resolveEntered = r; }), gate = new Promise(r => { release = r; });
  const f = await nativeFixture(t, async () => { resolveEntered(); await gate; return minimal.script_writer; }, { timers: { setTimeout(fn, ms) { assert.equal(ms, 120000); timeout = fn; return 'synthetic-clock'; }, clearTimeout(id) { assert.equal(id, 'synthetic-clock'); } } });
  const running = f.owner.run(f.enqueue('script_writer').id); await entered; timeout(); release();
  const result = await running; assert.equal(result.status, 'unknown'); assert.equal(f.requests.length, 1); assert.equal(f.ledger.list()[0].status, 'unknown');
});

test('R05: successful summary advances epoch with exact coverage and latest three receipts; failed summary keeps queued learning paused', async t => {
  const f = await nativeFixture(t); const completed = [];
  for (let n = 0; n < 4; n++) completed.push(await f.owner.run(f.enqueue('learning').id));
  const nodeId = f.repo.rootId(), prior = f.repo.list('tree_learning_sessions')[0], recentJobIds = completed.slice(-3).map(j => j.id);
  f.jobs.pauseLearning(nodeId, 'Summary has not yet succeeded'); const waiting = f.enqueue('learning'); assert.throws(() => f.jobs.prepare(waiting.id), { code: 'LEARNING_PAUSED' });
  let summary; f.repo.transaction(() => { summary = f.repo.save('tree_summaries', { id: 'verified-summary', nodeId, version: 1, oneLine: '合成摘要', body: {}, throughTurnIds: [], sourceRefs: completed[0].input.sources.map(s => s.ref), previousVersion: null, sourceWatermark: prior.sourceWatermark, coveredJobIds: [completed[0].id] }); });
  assert.throws(() => f.jobs.replaceEpoch(nodeId, { summaryId: summary.id, sourceWatermark: prior.sourceWatermark, recentJobIds: [], summaryHash: digest(summary) }), { code: 'EPOCH_COVERAGE' });
  assert.equal(f.repo.list('tree_learning_sessions')[0].sessionId, prior.sessionId);
  const next = f.jobs.replaceEpoch(nodeId, { summaryId: summary.id, sourceWatermark: prior.sourceWatermark, recentJobIds, summaryHash: digest(summary) });
  assert.equal(next.contextEpoch, 2); assert.notEqual(next.sessionId, prior.sessionId); assert.deepEqual(next.history, prior.history); assert.deepEqual(next.recentJobIds, recentJobIds); assert.equal(next.paused, false);
  assert.equal(f.jobs.get(waiting.id).status, 'queued'); assert.ok(next.history.every(h => h.sourceRefs.length && h.nativeLogRef));
});

test('full-request input bounds and missing long-context counter reject before the provider body executes', async t => {
  const f = await nativeFixture(t); f.owner.inputTokenCount = () => 128001;
  await f.owner.run(f.enqueue('verification').id); assert.equal(f.requests.length, 0); assert.equal(f.ledger.list().length, 0);
  f.owner.inputTokenCount = undefined;
  await f.owner.run(f.enqueue('improvement', { trigger: { longContextTest: true } }).id); assert.equal(f.requests.length, 0); assert.equal(f.ledger.list().length, 0);
});

test('frozen job model/price version cannot disagree with the finite experiment ledger', async t => {
  const f = await nativeFixture(t), original = f.enqueue('learning');
  const stalePrice = f.enqueue('verification', { config: { ...original.modelConfig, priceVersion: 'different-price-version' } });
  await f.owner.run(stalePrice.id); assert.equal(f.requests.length, 0); assert.equal(f.ledger.list().length, 0);
  assert.throws(() => f.enqueue('improvement', { config: { ...original.modelConfig, maxTokens: 384000 } }));
});
