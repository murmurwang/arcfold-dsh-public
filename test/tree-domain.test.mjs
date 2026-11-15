import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { fixture, method, short, hook } from './fixtures/tree-domain/helpers.mjs';
import { canonicalJson, digest, RECORD_FIELDS, validateRecord } from '../src/tree/contracts.mjs';
import { futureRecords } from './fixtures/tree-domain/record-fixtures.mjs';

test('D01: 100 deliveries commit one attribution, receipt, link and event; changed input conflicts', t => {
  const f = fixture(t), command = f.attribution([{ action: 'create', name: '写作' }]); const first = f.tree.applyAttribution(command);
  for (let i = 0; i < 100; i++) assert.deepEqual(f.tree.applyAttribution(command), first);
  assert.equal(f.repo.list('tree_nodes').length, 2); assert.equal(f.repo.list('tree_links').length, 1); assert.equal(f.repo.list('tree_receipts').length, 1); assert.equal(f.repo.list('tree_change_events').length, 1);
  assert.throws(() => f.tree.applyAttribution({ ...command, input: { ...command.input, actions: [{ action: 'create', name: '另一目标' }] } }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.throws(() => f.tree.applyAttribution(f.cmd(command.input)), { code: 'TURN_EXISTS' });
});

test('D02: two independent processes submit the same revision; exactly one wins', async t => {
  const f = fixture(t), id = f.create('并发写入'), expected = f.expected('tree_nodes', id);
  const path = fileURLToPath(new URL('./fixtures/tree-domain/concurrent-writer.mjs', import.meta.url));
  const children = [fork(path, [f.repo.filename], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }), fork(path, [f.repo.filename], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })];
  t.after(() => children.forEach(c => { if (c.exitCode === null) c.kill(); }));
  await Promise.all(children.map(c => once(c, 'message')));
  const responses = children.map(c => once(c, 'message')); const exits = children.map(c => once(c, 'exit'));
  children.forEach((c, i) => c.send(f.cmd({ nodeId: id, status: i ? 'abandoned' : 'completed', sourceRefs: [] }, expected)));
  const results = (await Promise.all(responses)).map(r => r[0]); await Promise.all(exits);
  assert.equal(results.filter(r => r.ok).length, 1); assert.deepEqual(results.find(r => !r.ok), { ok: false, code: 'REVISION_CONFLICT', status: 409 });
  assert.equal(f.repo.get('tree_nodes', id).revision, Object.values(expected)[0] + 1);
});

test('D03/D04: 1000 seeded move/status attempts preserve a single active root, cycles and terminal boundaries', t => {
  const f = fixture(t), root = f.repo.rootId(), ids = Array.from({ length: 30 }, (_, i) => f.create(`目标${i}`));
  let seed = 0x5eed1234; const rand = max => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % max; };
  for (let i = 0; i < 1000; i++) {
    const id = ids[rand(ids.length)], before = canonicalJson(f.repo.list('tree_nodes')), revision = f.repo.meta().treeRevision;
    try {
      if (i % 2) f.tree.moveNode(f.cmd({ nodeId: id, parentId: [root, ...ids][rand(ids.length + 1)], sourceRefs: [] }, f.expected('tree_nodes', id)));
      else f.tree.setStatus(f.cmd({ nodeId: id, status: ['active', 'paused', 'completed', 'abandoned'][rand(4)], sourceRefs: [] }, f.expected('tree_nodes', id)));
    } catch (e) { assert.equal(e.code, 'TREE_CYCLE'); assert.equal(canonicalJson(f.repo.list('tree_nodes')), before); assert.equal(f.repo.meta().treeRevision, revision); }
    f.repo.assertTree(); assert.equal(f.repo.get('tree_nodes', root).status, 'active'); assert.equal(f.repo.get('tree_nodes', root).parentId, null);
  }
  assert.throws(() => f.tree.moveNode(f.cmd({ nodeId: root, parentId: ids[0], sourceRefs: [] }, f.expected('tree_nodes', root))), { code: 'ROOT_INVARIANT' });
  const parent = f.create('父'), terminal = f.create('独立完成', parent), open = f.create('未完成', parent);
  f.tree.setStatus(f.cmd({ nodeId: terminal, status: 'completed', sourceRefs: [] }, f.expected('tree_nodes', terminal)));
  const saved = f.repo.get('tree_nodes', terminal);
  f.tree.setStatus(f.cmd({ nodeId: parent, status: 'abandoned', sourceRefs: [] }, f.expected('tree_nodes', parent)));
  assert.deepEqual(f.repo.get('tree_nodes', terminal), saved); assert.equal(f.repo.get('tree_nodes', open).statusOrigin, 'cascade'); assert.equal(f.repo.get('tree_nodes', open).cascadeFromId, parent);
  f.tree.applyAttribution(f.attribution([{ action: 'switch', nodeId: terminal }])); assert.equal(f.repo.get('tree_nodes', parent).status, 'active');
});

test('D05: three roles observing one event/category/subject create one signal across nodes; corrections preserve history', t => {
  const f = fixture(t), a = f.create('A'), b = f.create('B');
  const input = { eventId: 'original-user-event', subjectRefs: ['result-1'], dimension: 'cooperation', subitem: 'understanding', category: 'misread', polarity: 'negative', evidenceKind: 'language', sourceRefs: [f.ref], nodeIds: [a], confidence: 0.8 };
  const ids = ['learning', 'verification', 'consolidation'].map((role, i) => { f.asModel(role, [a, b]); return f.signals.record(f.cmd({ ...input, nodeIds: [i ? b : a] })).result.signalId; });
  assert.equal(new Set(ids).size, 1); const old = f.repo.get('tree_signals', ids[0]); assert.deepEqual(new Set(old.nodeIds), new Set([a, b])); assert.equal(f.repo.list('tree_signals').length, 1);
  f.asUser(); const correction = f.signals.correct(f.cmd({ signalId: ids[0], replacement: { ...input, category: 'restart' } }, f.expected('tree_signals', ids[0])));
  assert.deepEqual(f.repo.get('tree_signals', ids[0]), old); assert.equal(f.repo.get('tree_signals', correction.result.signalId).correctionOf, old.id);
});

test('D06: reassignment preserves raw refs, invalidates exclusive derivatives, rechecks multi-source items and queues one relearning', t => {
  const f = fixture(t), a = f.create('A'), b = f.create('B'); const turn = f.tree.applyAttribution(f.attribution([{ action: 'continue', nodeId: a }])).result;
  const independent = f.source('另一段独立经历'); f.asModel('learning', [a]);
  const proposals = f.propose(a, { understandings: [{ content: '只依赖这一轮', source: 'assistant_inferred', sourceRefs: [f.ref] }, { content: '还有独立支撑', source: 'assistant_inferred', sourceRefs: [f.ref, independent] }], methods: [method([f.ref])] });
  const [exclusive, mixed] = proposals.understandings.itemIds, methodId = proposals.methods.itemIds[0], exposureId = f.expose(a, [exclusive, mixed, methodId]);
  const beforeRefs = f.repo.get('tree_turns', turn.turnId).sourceRefs; f.asUser();
  const command = f.cmd({ turnId: turn.turnId, nodeIds: [b], sourceRefs: [] }, f.expected('tree_turns', turn.turnId));
  const receipt = f.tree.correctAssignment(command); for (let i = 0; i < 100; i++) assert.deepEqual(f.tree.correctAssignment(command), receipt);
  assert.equal(f.repo.get('tree_items', exclusive).lifecycle, 'invalid'); assert.equal(f.repo.get('tree_items', mixed).lifecycle, 'active'); assert.equal(f.repo.get('tree_items', mixed).stale, true);
  assert.equal(f.repo.get('tree_exposures', exposureId).revoked, true); assert.equal(f.repo.list('tree_jobs', j => j.kind === 'learning' && j.scopeKey === b).length, 1); assert.equal(f.repo.list('tree_jobs', j => j.kind === 'verification').length, 1);
  assert.deepEqual(f.repo.get('tree_turns', turn.turnId).sourceRefs, beforeRefs); assert.equal(f.repo.list('tree_links', l => l.turnId === turn.turnId && !l.active).length, 1);
  assert.equal(f.repo.list('tree_hooks', h => h.methodId === methodId && h.enabled).length, 0);
});

test('D07/C06/C14: confirming an inference adds a human confirmation version without inventing a user utterance', t => {
  const f = fixture(t), node = f.create('理解'); f.asModel('learning', [node]);
  const id = f.propose(node, { understandings: [{ content: '推测用户偏好', source: 'assistant_inferred', sourceRefs: [f.ref] }] }).understandings.itemIds[0];
  const original = f.items.version(id, 1); const command = f.cmd({ itemId: id, version: 1 }, f.expected('tree_items', id));
  assert.throws(() => f.items.confirm(command), { code: 'FORBIDDEN' });
  f.asUser(); const receipt = f.items.confirm(command), confirmed = f.items.version(id, 2);
  assert.deepEqual(f.items.version(id, 1), original); assert.deepEqual(confirmed.sourceRefs, original.sourceRefs); assert.equal(confirmed.sourceKind, 'user_expressed'); assert.equal(confirmed.confirmationRef, receipt.eventIds[0]);
  const exposureId = f.expose(node, [id]); f.asModel('verification', [node]);
  assert.throws(() => f.items.review(f.cmd({ itemId: id, version: 2, exposureId, operation: 'withdraw', reason: '不应自动修改用户保护项', sourceRefs: [f.ref], windowId: 'w1', opportunityRefs: [] }, f.expected('tree_items', id))), { code: 'USER_PROTECTED' });
  const fake = f.source('程序说自己是用户', 'user', 'program');
  const rejected = f.propose(node, { understandings: [{ content: '伪造的用户偏好', source: 'user_expressed', sourceRefs: [fake] }] }); assert.equal(rejected.understandings.code, 'USER_SOURCE_REQUIRED');
  assert.throws(() => f.tree.setStatus({ ...f.cmd({ nodeId: node, status: 'completed', sourceRefs: [] }, f.expected('tree_nodes', node)), actor: { kind: 'user', id: 'fixture-user' } }), { code: 'FORBIDDEN' });
});

test('D08: two hooks and two scripts activate/withdraw atomically; unready artifacts and stale drafts have no effects', t => {
  const f = fixture(t), node = f.create('方法'); f.asModel('learning', [node]);
  const proposal = { ...method([f.ref]), scriptRequests: [1, 2].map(i => ({ purpose: `脚本${i}`, evidence: ['s1'], files: ['file1'] })) };
  const id = f.propose(node, { methods: [proposal] }).methods.itemIds[0]; assert.equal(f.repo.get('tree_items', id).lifecycle, 'draft'); assert.equal(f.repo.list('tree_hooks', h => h.enabled).length, 0);
  const artifacts = [1, 2].map(i => ({ id: `artifact-${i}`, scriptId: `script-${i}`, methodId: id, version: 1, language: 'node-esm', entry: 'main.mjs', files: [{ relativePath: 'main.mjs', hash: digest(i), size: 5 }], argSchema: { type: 'object' }, dryRunSupport: true, buildRunId: `build-${i}`, activationState: 'ready' }));
  f.repo.transaction(() => artifacts.forEach(a => f.repo.save('tree_script_artifacts', a)));
  f.context.actor = { kind: 'program', id: 'verified-artifact-broker' }; f.context.verifiedArtifacts = artifacts.map(a => ({ id: a.id, revision: 1, filesHash: digest(a.files) }));
  assert.throws(() => f.items.activateDraft(f.cmd({ itemId: id, version: 1, artifactIds: [artifacts[0].id] }, f.expected('tree_items', id))), { code: 'BUNDLE_INCOMPLETE' }); assert.equal(f.repo.list('tree_hooks', h => h.enabled).length, 0);
  f.items.activateDraft(f.cmd({ itemId: id, version: 1, artifactIds: artifacts.map(a => a.id) }, f.expected('tree_items', id)));
  assert.equal(f.repo.get('tree_items', id).activeVersion, 2); assert.equal(f.repo.list('tree_hooks', h => h.enabled).length, 2); assert.equal(f.repo.get('tree_methods', digest(['method', id, 2])).scripts.length, 2);
  const run = { id: 'queued-run', runId: 'queued-run', methodVersion: { itemId: id, version: 2 }, nodeEpoch: 1, workspaceIdentity: 'fixture', policyHash: digest('policy'), snapshotId: 'fixture-snapshot', argvHash: digest([]), state: 'queued' };
  f.repo.transaction(() => f.repo.save('tree_script_runs', run)); f.asUser(); f.items.withdraw(f.cmd({ itemId: id, version: 2, reason: '用户撤回' }, f.expected('tree_items', id)));
  assert.equal(f.repo.get('tree_items', id).lifecycle, 'withdrawn'); assert.equal(f.repo.list('tree_hooks', h => h.enabled).length, 0); assert.equal(f.repo.get('tree_script_runs', run.id).state, 'revoked'); assert.equal(f.repo.list('tree_methods').length, 2);
});

test('D10: failed first attribution visibly uses root; later failure reuses previous valid nodes and rolls back partial actions', t => {
  const f = fixture(t), first = f.tree.applyAttribution(f.attribution([], { failure: '供应商超时' })).result;
  assert.deepEqual(first.nodeIds, [f.repo.rootId()]); assert.equal(first.fallback.visible, true);
  const node = f.create('上一轮目标'), count = f.repo.list('tree_nodes').length;
  const result = f.tree.applyAttribution(f.attribution([{ action: 'create', name: '应该回滚' }, { action: 'switch', nodeId: 'missing' }])).result;
  assert.deepEqual(result.nodeIds, [node]); assert.equal(result.fallback.code, 'NODE_NOT_FOUND'); assert.equal(f.repo.list('tree_nodes').length, count);
});

test('partitions are all-or-none, Unicode limits apply, and forged authority stays outside commands', t => {
  const f = fixture(t), node = f.create('分区'); f.asModel('learning', [node]);
  const result = f.propose(node, { understandings: [{ content: '有效', source: 'assistant_inferred', sourceRefs: [f.ref] }, { content: '😀'.repeat(2001), source: 'assistant_inferred', sourceRefs: [f.ref] }], methods: [method([f.ref])], supplements: [{ target: 'verification', text: short, sourceRefs: [f.ref], traitEvidence: [f.ref], universalStopgap: false }] });
  assert.equal(result.understandings.status, 'rejected'); assert.equal(result.methods.status, 'applied'); assert.equal(result.supplements.status, 'rejected'); assert.equal(f.repo.list('tree_items').length, 1);
  assert.equal(f.propose(node, { methods: [{ ...method([f.ref]), hooks: [hook, { ...hook, action: 'execute_shell' }] }] }).methods.status, 'rejected');
  assert.throws(() => f.items.commitProposal({ ...f.cmd({ nodeId: node, understandings: [], methods: [], supplements: [] }), actor: { kind: 'user', id: 'fixture-user' } }), { code: 'ACTOR_MISMATCH' });
  const valid = f.propose(node, { understandings: [{ content: '😀'.repeat(2000), source: 'assistant_inferred', sourceRefs: [f.ref] }] }); assert.equal(valid.understandings.status, 'applied');
});

test('review binds exact exposure/version, counts distinct unclear windows, and promotion cannot pollute siblings', t => {
  const f = fixture(t), a = f.create('A'), child = f.create('子目标', a), sibling = f.create('兄弟'); f.asModel('learning', [child]);
  const id = f.propose(child, { understandings: [{ content: '局部推断', source: 'assistant_inferred', sourceRefs: [f.ref] }] }).understandings.itemIds[0], exposureId = f.expose(child, [id]); f.asModel('verification', [child]);
  const review = extra => f.cmd({ itemId: id, version: 1, exposureId, operation: 'support', reason: '尚未遇到情境', sourceRefs: [f.ref], opportunityRefs: [], windowId: 'w1', result: 'met', ...extra }, f.expected('tree_items', id));
  assert.equal(f.items.review(review({})).result.result, 'unclear'); assert.equal(f.items.review(review({})).result.duplicateWindow, true);
  f.items.review(review({ windowId: 'w2' })); assert.equal(f.items.review(review({ windowId: 'w3' })).result.needsReflection, true); assert.equal(f.repo.get('tree_items', id).validation, 'unverified');
  assert.throws(() => f.items.review(review({ operation: 'promote', toNodeId: sibling, windowId: 'w4' })), { code: 'INVALID_PROMOTION' });
  f.items.review(review({ operation: 'promote', toNodeId: a, windowId: 'w4' })); assert.equal(f.repo.get('tree_items', id).nodeId, a); assert.equal(f.repo.get('tree_exposures', exposureId).revoked, true);
  assert.throws(() => f.items.review(review({ windowId: 'w5' })), { code: 'EXPOSURE_REQUIRED' });
});

test('user parameter overrides inherit nearest scope; local reports require a matching preview and never send', t => {
  const f = fixture(t), a = f.create('A'), b = f.create('B', a);
  f.tree.setParameter(f.cmd({ name: 'retentionDays', scopeNodeId: a, value: 12, sourceRefs: [] })); assert.equal(f.tree.parameter('retentionDays', b), 12); assert.equal(f.tree.parameter('leaveTimeoutHours', b), 24);
  const parameter = f.repo.list('tree_parameters')[0]; f.asModel('improvement', [a]);
  assert.throws(() => f.tree.setParameter(f.cmd({ name: 'retentionDays', scopeNodeId: a, value: 5, sourceRefs: [f.ref] }, f.expected('tree_parameters', parameter.id))), { code: 'USER_PROTECTED' });
  f.asUser(); const report = { id: 'report', category: 'context', fingerprint: digest('issue'), step: '归属', problem: '用户原话 /Users/private/name.txt', evidenceRefs: [f.ref], whyUniversal: '普遍问题', stopgapIds: [], suggestedFix: '保留来源', status: 'unhandled', exportAudit: [] };
  f.repo.transaction(() => f.repo.save('tree_reports', report)); const preview = f.reports.preview(report.id); assert.equal(canonicalJson(preview).includes('/Users'), false); assert.equal(canonicalJson(preview).includes('用户原话'), false);
  assert.throws(() => f.reports.export(f.cmd({ reportId: report.id, includeEvidence: false, previewHash: digest('outdated') }, f.expected('tree_reports', report.id))), { code: 'PREVIEW_CHANGED' });
  const exported = f.reports.export(f.cmd({ reportId: report.id, includeEvidence: false, previewHash: digest(preview) }, f.expected('tree_reports', report.id))); assert.deepEqual(exported.result.content, preview); assert.equal(f.repo.get('tree_reports', report.id).exportAudit.length, 1);
  assert.equal(Object.keys(RECORD_FIELDS).length, 27); assert.throws(() => validateRecord('unregistered_kind', { id: 'x' }), { code: 'UNKNOWN_KIND' });
});

test('local exceptions cannot invalidate ancestor content; explicit global user correction preserves old version', t => {
  const f = fixture(t), parent = f.create('父'), child = f.create('子', parent); f.asModel('learning', [parent]);
  const oldId = f.propose(parent, { understandings: [{ content: '上级理解', source: 'assistant_inferred', sourceRefs: [f.ref] }] }).understandings.itemIds[0]; const oldVersion = f.items.version(oldId, 1);
  const correctionRef = f.source('刚才那条理解整体不对'); f.asModel('learning', [child]); f.context.correction = { itemIds: [oldId], sourceRefs: [correctionRef], global: false };
  const input = { nodeId: child, understandings: [{ content: '修正后的理解', source: 'user_expressed', sourceRefs: [correctionRef] }], methods: [], supplements: [], revisions: [{ targetId: oldId, targetVersion: 1, mark: 'invalid', replacedByIndex: 0, sourceRefs: [correctionRef] }] };
  const local = f.items.commitProposal(f.cmd(input, f.expected('tree_items', oldId))); assert.equal(local.result.understandings.code, 'LOCAL_EXCEPTION'); assert.equal(f.repo.list('tree_items').length, 1);
  f.context.correction.global = true; const global = f.items.commitProposal(f.cmd(input, f.expected('tree_items', oldId))); assert.equal(global.result.understandings.status, 'applied'); assert.equal(f.repo.get('tree_items', oldId).lifecycle, 'invalid'); assert.deepEqual(f.items.version(oldId, 1), oldVersion);
});

test('bundle rewrite and merge preserve historical versions and stop prior hooks', t => {
  const f = fixture(t), node = f.create('改版'); f.asModel('learning', [node]);
  const methodId = f.propose(node, { methods: [method([f.ref])] }).methods.itemIds[0]; let exposureId = f.expose(node, [methodId]); f.asModel('verification', [node]);
  const input = { itemId: methodId, version: 1, exposureId, operation: 'harden', replacement: { ...method([f.ref]), hooks: [hook] }, reason: '增加前置检查', sourceRefs: [f.ref], windowId: 'harden-window', opportunityRefs: [f.ref] };
  f.items.review(f.cmd(input, f.expected('tree_items', methodId))); assert.equal(f.repo.get('tree_items', methodId).activeVersion, 2); assert.equal(f.repo.list('tree_hooks', h => h.enabled).length, 1); assert.equal(f.repo.list('tree_methods').length, 2);
  assert.equal(f.repo.get('tree_exposures', exposureId).revoked, true); assert.equal(f.items.version(methodId, 1).content.hooks.length, 2);
  f.asModel('learning', [node]); const ids = f.propose(node, { understandings: [1, 2].map(i => ({ content: `理解${i}`, source: 'assistant_inferred', sourceRefs: [f.ref] })) }).understandings.itemIds;
  exposureId = f.expose(node, ids); f.asModel('verification', [node]);
  f.items.review(f.cmd({ itemId: ids[0], version: 1, exposureId, operation: 'merge', mergeTargetId: ids[1], mergeTargetVersion: 1, replacement: '合并后理解', reason: '同一范围重复内容', sourceRefs: [f.ref], windowId: 'merge-window', opportunityRefs: [f.ref] }, { ...f.expected('tree_items', ids[0]), ...f.expected('tree_items', ids[1]) }));
  assert.equal(f.items.version(ids[0], 2).content, '合并后理解'); assert.equal(f.repo.get('tree_items', ids[1]).lifecycle, 'withdrawn'); assert.equal(f.items.version(ids[1], 1).content, '理解2');
});

test('undo-create tombstones only an empty node; another turn keeps the node and its evidence', t => {
  const f = fixture(t), result = f.tree.applyAttribution(f.attribution([{ action: 'create', name: '误建' }])).result, node = result.nodeIds[0];
  f.tree.correctAssignment(f.cmd({ turnId: result.turnId, nodeIds: [f.repo.rootId()], sourceRefs: [], undoCreate: true }, f.expected('tree_turns', result.turnId)));
  assert.equal(f.repo.get('tree_nodes', node).deleted, true); assert.equal(f.repo.get('tree_turns', result.turnId).sourceRefs.length, 1);
  const other = f.tree.applyAttribution(f.attribution([{ action: 'create', name: '已有经历' }])).result;
  f.tree.applyAttribution(f.attribution([{ action: 'continue', nodeId: other.nodeIds[0] }]));
  f.tree.correctAssignment(f.cmd({ turnId: other.turnId, nodeIds: [f.repo.rootId()], sourceRefs: [], undoCreate: true }, f.expected('tree_turns', other.turnId)));
  assert.equal(f.repo.get('tree_nodes', other.nodeIds[0]).deleted, undefined);
});

test('all 27 persisted contracts round-trip; future-role identities retain uniqueness and malformed records roll back', t => {
  const f = fixture(t), nodeId = f.create('协议'); f.asModel('learning', [nodeId]);
  const proposals = f.propose(nodeId, { understandings: [{ content: '理解', source: 'assistant_inferred', sourceRefs: [f.ref] }], methods: [method([f.ref])], supplements: [{ target: 'learning', text: short, sourceRefs: [f.ref], traitEvidence: [f.ref], universalStopgap: false }] });
  f.expose(nodeId, [...proposals.understandings.itemIds, ...proposals.methods.itemIds]);
  f.signals.record(f.cmd({ eventId: 'fixture-event', subjectRefs: ['answer'], dimension: 'cooperation', subitem: 'understanding', category: 'approved', polarity: 'strong', evidenceKind: 'language', sourceRefs: [f.ref], nodeIds: [nodeId], confidence: 1 }));
  f.asUser(); f.tree.setParameter(f.cmd({ name: 'retentionDays', scopeNodeId: nodeId, value: 10, sourceRefs: [] }));
  const rows = futureRecords(nodeId, f.ref); f.repo.transaction(() => rows.forEach(([kind, row]) => f.repo.save(kind, row)));
  for (const kind of Object.keys(RECORD_FIELDS)) { assert.ok(f.repo.list(kind).length, kind); for (const row of f.repo.list(kind)) { validateRecord(kind, row); assert.ok(row.revision > 0); assert.equal(new Date(row.createdAt).toISOString(), row.createdAt); } }
  const before = f.repo.list('tree_learning_sessions');
  assert.throws(() => f.repo.transaction(() => f.repo.save('tree_learning_sessions', { ...before[0], id: 'second-writer' })), /UNIQUE constraint failed/); assert.deepEqual(f.repo.list('tree_learning_sessions'), before);
  const hookRun = f.repo.list('tree_hook_runs')[0]; assert.throws(() => f.repo.transaction(() => f.repo.save('tree_hook_runs', { ...hookRun, id: 'duplicate-event' })), /UNIQUE constraint failed/);
  const job = f.repo.list('tree_jobs')[0]; assert.throws(() => f.repo.transaction(() => f.repo.save('tree_jobs', { ...job, status: 'invented_state' }, job.revision)), { code: 'INVALID_FIELD' });
});

test('ancestor support needs independent sources from two distinct nodes; repeating one source is not independent evidence', t => {
  const f = fixture(t), a = f.create('A'), b = f.create('B'), root = f.repo.rootId(); f.asModel('learning', [root]);
  const id = f.propose(root, { understandings: [{ content: '较广的推断', source: 'assistant_inferred', sourceRefs: [f.ref] }] }).understandings.itemIds[0];
  const exposeA = f.expose(a, [id]), exposeB = f.expose(b, [id]); f.asModel('verification', [a, b]);
  const review = (exposureId, windowId, source) => f.items.review(f.cmd({ itemId: id, version: 1, exposureId, operation: 'support', reason: '检验依据', sourceRefs: [source], windowId, opportunityRefs: [source], result: 'met' }, f.expected('tree_items', id)));
  review(exposeA, 'a1', f.ref); assert.equal(f.repo.get('tree_items', id).validation, 'unverified');
  review(exposeB, 'b1', f.ref); assert.equal(f.repo.get('tree_items', id).validation, 'unverified');
  review(exposeB, 'b2', f.source('独立的第二次观察')); assert.equal(f.repo.get('tree_items', id).validation, 'supported');
});
