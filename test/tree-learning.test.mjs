import test from 'node:test';
import assert from 'node:assert/strict';
import { learningFixture, emptyLearning } from './fixtures/tree-learning/helpers.mjs';
import { short } from './fixtures/tree-domain/helpers.mjs';
import { digest } from '../src/tree/contracts.mjs';
import { nativeLearning } from './fixtures/tree-learning/native.mjs';
import { WriterRouter } from '../src/tree/learning.mjs';

const human = job => job.input.sources.find(s => s.role === 'user' && job.input.currentTurn.sourceIds.includes(s.id));
const proposal = sourceId => ({ kind: 'collaboration', short, long: null, hooks: [], scriptRequests: [], expectedEffect: { category: 'redo', change: 'less', text: '减少重做' }, sourceIds: [sourceId] });

test('a single correction creates a method immediately; receipt and withdrawn changes enter the next learning turn', async t => {
  const f = learningFixture(t), node = f.create('我写说明'); const turn = await f.turn(node, '先核对原文，别再覆盖');
  const job = f.learning.enqueue(turn.id, node), source = human(job), done = f.complete(job, { ...emptyLearning(), correctionClaim: { kind: 'method', quote: { sourceId: source.id, text: '先核对原文，别再覆盖' } }, methods: [proposal(source.id)] });
  assert.equal(done.status, 'committed'); const id = done.resultRef.methods.itemIds[0]; assert.equal(f.repo.get('tree_items', id).lifecycle, 'active');
  f.asUser(); f.items.withdraw(f.cmd({ itemId: id, version: 1, reason: '用户撤回合成要求' }, f.expected('tree_items', id)));
  const next = await f.turn(node, '接着做'); const second = f.learning.enqueue(next.id, node);
  assert.deepEqual(second.input.previousReceipt.methods.itemIds, [id]); assert.ok(second.input.changeReceipts.some(e => e.commandType === 'withdrawItem'));
  assert.ok(!second.input.knownItems.some(i => i.id === id));
  const finished = f.complete(second, emptyLearning()); assert.equal(finished.nativeSessionId, done.nativeSessionId);
  const session = f.repo.list('tree_learning_sessions')[0]; assert.equal(session.appendSeq, 2); assert.equal(session.history.length, 2);
  assert.equal(f.learning.enqueue(turn.id, node).id, job.id);
});

test('explicit current-user correction marks misunderstanding invalid without rewriting original evidence', async t => {
  let correction;
  const f = learningFixture(t, { annotations: () => correction ? { correction } : {} }), node = f.create('我澄清要求');
  const first = await f.turn(node, '我纠正之前的要求：先介绍整体'), a = f.learning.enqueue(first.id, node), source = human(a);
  const before = f.complete(a, { ...emptyLearning(), correctionClaim: { kind: 'understanding', quote: { sourceId: source.id, text: '我纠正之前的要求：先介绍整体' } }, understandings: [{ content: '用户不需要细节（错误推断）', source: 'assistant_inferred', sourceIds: [source.id] }] });
  const id = before.resultRef.understandings.itemIds[0], original = f.repo.get('tree_item_versions', digest(['item_version', id, 1]));
  const next = await f.turn(node, '我没说不要细节，是先整体再细节'), current = f.experience.material(next).sources.find(s => s.role === 'user');
  correction = { itemIds: [id], sourceIds: [current.id], global: false };
  const b = f.learning.enqueue(next.id, node), output = { ...emptyLearning(), understandings: [{ content: '纠正此前误读：用户要先整体再细节', source: 'user_expressed', sourceIds: [current.id] }], revisions: [{ targetId: id, targetVersion: 1, mark: 'invalid', replacedByIndex: 0, sourceIds: [current.id] }] };
  const done = f.complete(b, output); assert.equal(done.status, 'committed'); assert.equal(f.repo.get('tree_items', id).lifecycle, 'invalid');
  assert.deepEqual(f.repo.get('tree_item_versions', original.id), original); assert.ok(f.repo.get('tree_items', id).replacedBy);
});

test('local exception cannot invalidate an ancestor and output cannot invent a correction authority', async t => {
  const f = learningFixture(t), root = f.repo.rootId(), node = f.create('我做局部任务');
  const first = await f.turn(root, '我纠正之前的要求：先整体'), a = f.learning.enqueue(first.id, root);
  const id = f.complete(a, { ...emptyLearning(), correctionClaim: { kind: 'understanding', quote: { sourceId: human(a).id, text: '我纠正之前的要求：先整体' } }, understandings: [{ content: '用户偏好先整体', source: 'assistant_inferred', sourceIds: [human(a).id] }] }).resultRef.understandings.itemIds[0];
  const next = await f.turn(node, '这里只写细节'), b = f.learning.enqueue(next.id, node), source = human(b);
  const result = f.complete(b, { ...emptyLearning(), understandings: [{ content: '本次只写细节', source: 'user_expressed', sourceIds: [source.id] }], revisions: [{ targetId: id, targetVersion: 1, mark: 'invalid', replacedByIndex: 0, sourceIds: [source.id] }] });
  assert.equal(result.status, 'committed'); assert.ok(result.rejectedItems.length); assert.equal(f.repo.get('tree_items', id).lifecycle, 'active');
  assert.ok(!b.input.sources.some(s => s.ref.messageId === human(a).ref.messageId));
});

test('backlog learning sees no future feedback and does not freeze ahead of earlier receipts', async t => {
  const f = learningFixture(t), node = f.create('我逐轮校对');
  const first = await f.turn(node, '第一轮'), later = await f.turn(node, '之后才出现的秘密纠正');
  assert.throws(() => f.learning.enqueue(later.id, node), { code: 'NODE_ORDER' });
  const a = f.learning.enqueue(first.id, node); assert.ok(!JSON.stringify(a.input).includes('之后才出现的秘密纠正'));
  assert.throws(() => f.learning.enqueue(later.id, node), { code: 'NODE_BUSY' }); f.complete(a, emptyLearning());
  assert.ok(f.learning.enqueue(later.id, node).input.sources.some(s => s.text.includes('之后才出现')));
});

test('concurrent assignment correction stales an already frozen learning result', async t => {
  const f = learningFixture(t), a = f.create('我写甲'), b = f.create('我写乙'), turn = await f.turn(a), job = f.learning.enqueue(turn.id, a);
  f.jobs.prepare(job.id); f.jobs.submit(job.id); f.asUser(); f.tree.correctAssignment(f.cmd({ turnId: turn.id, nodeIds: [b], sourceRefs: [] }, f.expected('tree_turns', turn.id)));
  f.jobs.receive(job.id, { message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(emptyLearning()) }] }, nativeLogRef: 'fixture#2', eventsHash: digest('stale') });
  assert.equal(f.jobs.validate(job.id).status, 'stale'); assert.equal(f.repo.list('tree_items').length, 0);
});

test('unknown learning is retained and blocks the next own turn rather than resending', async t => {
  const f = learningFixture(t), node = f.create('我等待结果'), turn = await f.turn(node), a = f.learning.enqueue(turn.id, node);
  f.jobs.prepare(a.id); f.jobs.submit(a.id); f.jobs.transition(a.id, 'unknown');
  assert.equal(f.learning.enqueue(turn.id, node).status, 'unknown'); const later = await f.turn(node);
  assert.throws(() => f.learning.enqueue(later.id, node), { code: 'NODE_BUSY' }); assert.equal(f.repo.list('tree_jobs', j => j.role === 'learning').length, 1);
});

test('actual DSH main → persistent learning → owned writer → activation → next main → verification, with synthetic provider', async t => {
  await nativeLearning(t);
});

test('explicit main script request creates one draft and owned job per native call, never runs it', async t => {
  const f = learningFixture(t), node = f.create('我请求脚本'), turn = await f.turn(node), sources = f.experience.material(turn).sources;
  const job = f.jobs.enqueue({ role: 'main', key: 'request-fixture', nodeIds: [node], config: f.config(), revisionSet: {}, trigger: { kind: 'user_turn', producerRole: 'user', origin: 'user', nativeSessionId: turn.sessionId, nativeTurn: turn.nativeTurn },
    input: { scope: { nodeIds: [node], ancestorPaths: [[f.repo.rootId(), node]], treeRevision: f.repo.meta().treeRevision }, sources, knownItems: [], allowedIds: { nodeIds: [node], fileIds: [], subjectIds: [] }, changeReceipts: [] } });
  const router = new WriterRouter({ repository: f.repo, jobs: f.jobs, modelConfig: f.config, artifacts: { resolveSource: f.resolveSource } });
  const input = { purpose: '把合成任务列表整理为 Markdown', evidenceIds: [sources.find(s => s.role === 'user').id], fileRefs: [] }, context = { job, callId: 'actual-call-fixture', nodeId: node };
  assert.throws(() => router.request({ ...input, fileRefs: ['tasks.json'] }, context), { code: 'WRITER_REQUEST_SOURCE' });
  assert.equal(f.repo.list('tree_jobs', j => j.role === 'script_writer').length, 0, 'Unregistered file references cannot start an author');
  const result = router.request(input, context); assert.equal(result.state, 'queued'); assert.deepEqual(router.request(input, context), result);
  assert.equal(f.repo.get('tree_items', result.methodId).lifecycle, 'draft'); assert.equal(f.repo.list('tree_jobs', j => j.role === 'script_writer').length, 1); assert.equal(f.repo.list('tree_script_runs').length, 0);
  assert.throws(() => router.request({ ...input, purpose: '不同请求' }, context), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.throws(() => router.request(input, { ...context, job: { ...job, role: 'learning' } }), { code: 'MAIN_REQUIRED' });
  f.jobs.prepare(result.jobId); f.jobs.submit(result.jobId); f.jobs.transition(result.jobId, 'unknown');
  assert.equal(router.activateReady(result.methodId, 1).state, 'unknown'); assert.equal(f.repo.get('tree_items', result.methodId).lifecycle, 'draft');
});
