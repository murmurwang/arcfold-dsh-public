import test from 'node:test';
import assert from 'node:assert/strict';
import { modelView } from '../src/tree/model-view.mjs';
import { canonicalJson, digest } from '../src/tree/contracts.mjs';
import { validateOutput } from '../src/tree/prompts.mjs';
import { envelope, minimal } from './fixtures/tree-model/contracts.mjs';
import { nativeFixture } from './fixtures/tree-model/native.mjs';

// Synthetic native source projection, shaped like experience.mjs project().
const ref = (seq, messageId) => ({ sessionId: 'synthetic-main', seq, ...(messageId ? { messageId } : {}), sha256: digest(['synthetic', seq]) });
const source = (id, role, origin, text, seq, extra = {}) => ({ id, role, origin, content: [{ type: 'text', text }], text, ref: ref(seq, 'm' + seq), sha256: ref(seq).sha256, nativeType: 'user/message', at: '2026-11-21T00:00:00.000Z', ...extra });
const user = source('s1', 'user', 'user', '只使用合成资料，之前的理解不对', 1);
const answer = source('s2', 'assistant', 'model', '好的，我只用合成资料。', 2, { nativeType: 'assistant/message' });
const call = { id: 's3', role: 'assistant', origin: 'tool-call', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: { path: 'a.md' } }], text: canonicalJson({ type: 'tool-call', id: 'c1', name: 'read', arguments: { path: 'a.md' } }), ref: ref(3), sha256: ref(3).sha256, nativeType: 'tool/call', at: '2026-11-21T00:00:01.000Z' };
const elided = source('s4', 'tool', 'tool', '[工具输出 5000 字符；原文按引用保留，未放入学习输入]', 4, { nativeType: 'tool/result', toolCallId: 'c1', isError: false, elided: { chars: 5000, sha256: 'f'.repeat(64) } });
const segment = (key, nodeId, text) => ({ key, nodeId, version: digest([key, text]), text, sourceRefs: [ref(1, 'm1'), ref(2, 'm2')], itemVersions: [{ itemId: 'i1', version: 1 }], summaryVersions: [] });
const DROPPED_SOURCE = ['content', 'ref', 'sha256', 'nativeType'];

function inputs() {
  const sources = [user, answer, call, elided], constraints = [segment('node:n1', 'n1', '{"target":{"id":"n1","name":"合成目标"}}')];
  const attribution = { ...envelope('attribution'), sources: [user, answer], context: [segment('global-overview', null, '{"globalOverview":[]}'), ...constraints] };
  const learning = { ...envelope('learning'), sources, constraints, currentTurn: { id: 't1', sourceIds: ['s1', 's2', 's3', 's4'], assignmentRevision: 1 },
    changeReceipts: [{ id: 'r'.repeat(64), receiptId: 'q'.repeat(64), commandType: 'commitLearning', entityIds: ['tree_items:i1'], beforeVersions: {}, afterVersions: { 'tree_items:i1': 1 }, actor: { kind: 'model' }, sourceRefs: [ref(1)], createdAt: 'x', updatedAt: 'x', revision: 1, ordinal: 3 }],
    epochSeed: { summary: { id: 'sum', oneLine: '合成概况' }, recent: [{ jobId: 'old', input: { sources: [user], constraints } }], constraints } };
  const consolidation = { ...envelope('consolidation'), sources, constraints, learningHistory: [{ jobId: 'old', input: { currentTurn: { id: 't0', sourceIds: ['s1'] }, sourceIds: ['s1'] }, output: {}, receipt: {} }] };
  const base = envelope('verification'), versions = base.exposures[0].itemVersions;
  const verification = { ...base, sources, constraints,
    exposures: [{ id: 'ex1', itemVersions: versions, visibleItemVersions: versions, nodeIds: ['n1'], role: 'main', contextKey: 'k'.repeat(64), renderedHash: 'h'.repeat(64), invocationId: 'v'.repeat(64), modelSessionId: 'synthetic-main', createdAt: 'x', updatedAt: 'x', revision: 1, treeRevision: 1, boundaryIndex: 0, bytes: 10 }],
    effects: [{ turnId: 't1', itemVersions: versions, exposureIds: ['ex1'], input: [user], answer: [answer], feedback: [user], signals: [{ id: 'sig', category: 'approved', eventId: 'e'.repeat(64), createdAt: 'x' }] }],
    clusters: [{ id: 'c1', episodes: [{ sources: [user] }] }] };
  return { attribution, learning, consolidation, verification };
}
function sourcesIn(value, found = []) {
  if (Array.isArray(value)) value.forEach(v => sourcesIn(v, found));
  else if (value && typeof value === 'object') { if (typeof value.id === 'string' && typeof value.role === 'string' && typeof value.text === 'string' && 'origin' in value) found.push(value); Object.values(value).forEach(v => sourcesIn(v, found)); }
  return found;
}

for (const [role, input] of Object.entries(inputs())) test(`${role}: the model view drops program-only fields and keeps wording, ids and versions`, () => {
  const before = canonicalJson(input), view = modelView(input), text = canonicalJson(view);
  assert.equal(canonicalJson(input), before, 'the frozen input is not changed');
  for (const s of sourcesIn(view)) for (const key of DROPPED_SOURCE) assert.equal(Object.hasOwn(s, key), false, `${role} source ${s.id} keeps ${key}`);
  for (const key of ['"sourceRefs"', '"contextKey"', '"renderedHash"', '"receiptId"', '"eventId"', '"invocationId"']) assert.equal(text.includes(key), false, `${role} keeps ${key}`);
  for (const s of input.sources) { const kept = view.sources.find(v => v.id === s.id); assert.ok(kept, s.id); assert.equal(kept.text, s.text); assert.equal(kept.role, s.role); assert.equal(kept.origin, s.origin); }
  const toolResult = view.sources.find(s => s.id === 's4');
  if (toolResult) { assert.equal(toolResult.toolCallId, 'c1'); assert.equal(toolResult.isError, false); assert.deepEqual(toolResult.elided, { chars: 5000 }); }
  for (const item of input.knownItems) assert.ok(view.knownItems.some(v => v.id === item.id && v.version === item.version));
  assert.deepEqual(view.scope, input.scope); assert.deepEqual(view.allowedIds, input.allowedIds);
  for (const key of ['context', 'constraints']) for (const s of view[key] ?? []) assert.deepEqual(Object.keys(s).sort(), ['key', 'nodeId', 'text']);
  assert.equal(canonicalJson(modelView(structuredClone(input))), text, 'the same input renders the same message');
});

test('verification keeps exposure ids and versions, receipts keep their versions, nested sources are trimmed too', () => {
  const { verification, learning } = inputs(), view = modelView(verification);
  assert.deepEqual(view.exposures, [{ id: 'ex1', nodeIds: ['n1'], itemVersions: verification.exposures[0].itemVersions, visibleItemVersions: verification.exposures[0].itemVersions, role: 'main' }]);
  assert.deepEqual(view.effects[0].exposureIds, ['ex1']); assert.deepEqual(view.effects[0].signals, [{ id: 'sig', category: 'approved' }]);
  assert.deepEqual(view.effects[0].input[0], { id: 's1', role: 'user', origin: 'user', text: user.text, at: user.at });
  assert.deepEqual(view.clusters[0].episodes[0].sources[0], view.effects[0].input[0]);
  const receipts = modelView(learning).changeReceipts;
  assert.deepEqual(receipts, [{ commandType: 'commitLearning', entityIds: ['tree_items:i1'], beforeVersions: {}, afterVersions: { 'tree_items:i1': 1 } }]);
  assert.deepEqual(Object.keys(modelView(learning).epochSeed.recent[0].input.sources[0]).sort(), ['at', 'id', 'origin', 'role', 'text']);
});

test('output is still checked against the complete frozen input', () => {
  const input = envelope('consolidation'), view = modelView(input);
  const output = { ...minimal.consolidation, summary: { ...minimal.consolidation.summary, decisions: [{ what: '只用合成资料', by: 'user', when: '本轮', sourceIds: [view.sources[0].id] }] } };
  assert.equal(validateOutput('consolidation', output, input).summary.decisions[0].sourceIds[0], 's1');
  output.summary.decisions[0].sourceIds = ['not-in-input'];
  assert.throws(() => validateOutput('consolidation', output, input), { code: 'OUTPUT_REFERENCE' });
});

test('native auxiliary requests carry the model view; a message bound earlier is never re-rendered', async t => {
  const f = await nativeFixture(t, ({ role, input }) => role === 'attribution' ? { actions: [{ action: 'continue', nodeId: input.scope.nodeIds[0] }], statusChanges: [] } : minimal[role]);
  for (const role of ['learning', 'attribution']) {
    const job = f.enqueue(role), done = await f.owner.run(job.id); assert.equal(done.status, 'committed', JSON.stringify(done.error));
    const row = f.requests.findLast(r => r.role === role), sent = row.body.messages.flatMap(m => m.content ?? []).find(b => b.type === 'text' && b.text.includes(job.id));
    assert.equal(sent.text, canonicalJson(modelView(job.input)));
    assert.ok(!sent.text.includes('"ref"') && !sent.text.includes('"sha256"'));
    assert.equal(done.nativeMessage.content[0].text, sent.text);
  }
  // A job whose message was bound before the upgrade, in the old full format,
  // is sent with that stored message and never re-rendered.
  const old = f.enqueue('learning'); f.jobs.prepare(old.id);
  const message = { role: 'user', id: 'old-format', source: { kind: 'arcfold/tree-job', jobId: old.id, role: 'learning', inputHash: old.inputHash, origin: 'program' }, content: [{ type: 'text', text: canonicalJson(old.input) }] };
  const prepared = f.jobs.get(old.id);
  f.repo.command('fixtureBindOldMessage', { requestId: 'fixture-old-message', input: { jobId: old.id }, expected: {} }, { kind: 'program', id: 'fixture' }, () => { f.repo.save('tree_jobs', { ...prepared, nativeMessage: message }, prepared.revision); return {}; });
  assert.throws(() => f.jobs.bindMessage(old.id, { ...message, content: [{ type: 'text', text: canonicalJson(modelView(old.input)) }] }), { code: 'MESSAGE_CONFLICT' });
  const done = await f.owner.run(old.id); assert.equal(done.status, 'committed', JSON.stringify(done.error));
  const sent = f.requests.at(-1).body.messages.flatMap(m => m.content ?? []).filter(b => b.type === 'text' && b.text.includes(old.id));
  assert.deepEqual(sent.map(b => b.text), [canonicalJson(old.input)]);
  // A new binding must be the model view; the old full rendering is refused.
  const fresh = f.enqueue('learning'); f.jobs.prepare(fresh.id);
  const full = { ...message, id: 'fresh-full', source: { ...message.source, jobId: fresh.id, inputHash: fresh.inputHash }, content: [{ type: 'text', text: canonicalJson(fresh.input) }] };
  assert.throws(() => f.jobs.bindMessage(fresh.id, full), { code: 'MESSAGE_CONFLICT' });
  assert.equal(f.jobs.bindMessage(fresh.id, { ...full, content: [{ type: 'text', text: canonicalJson(modelView(fresh.input)) }] }).nativeMessage.id, 'fresh-full');
});
