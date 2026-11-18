import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import * as OfficialConnection from '@deepseek-ai/dsh-client-connection';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import TypertGateway from '@deepseek-ai/dsh-api-gateway';
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access';
import { learningFixture } from './fixtures/tree-learning/helpers.mjs';
import { snapshotFixture } from './fixtures/tree-scripts/helpers.mjs';
import { method } from './fixtures/tree-domain/helpers.mjs';
import { TreeUIService, bindTurnSnapshot, TREE_ENDPOINTS } from '../src/tree/ui.mjs';
import { MetricsService } from '../src/tree/metrics.mjs';
import { LocalReports } from '../src/tree/reports.mjs';
import { EpisodeSignals, evidenceResolver } from '../src/tree/signals.mjs';
import { createTreeHandler, installTreeWeb, treeInvocations } from '../packages/method-ui/src/tree-host.mjs';
import { digest } from '../src/tree/contracts.mjs';
import { ItemService } from '../src/tree/items.mjs';
import { VerificationService } from '../src/tree/verification.mjs';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createTreeSource } from '../packages/method-ui/src/tree-source.mjs';
import { TreeView, TreeDock, TreeTurnTail } from '../packages/method-ui/src/tree-view.mjs';
import { installTreeClient } from '../packages/method-ui/src/tree-client.mjs';
import { improvementFixture, universal, noChange } from './fixtures/tree-improvement/helpers.mjs';

const live = () => new AbortController().signal;
function uiFixture(t, supplied) {
  const f = supplied ?? learningFixture(t), signals = supplied ? new EpisodeSignals({ repository: f.repo, resolveSource: f.resolveSource ?? (ref => f.source(ref)) }) : f.signals;
  const resolveSource = f.resolveSource ?? (ref => f.items.resolveSource(ref)), metrics = new MetricsService({ repository: f.repo, experience: f.experience, signals });
  let admitted = null;
  const service = new TreeUIService({ repository: f.repo, resolveSource, metrics, reports: new LocalReports({ repository: f.repo, resolveSource }), snapshotsFor: () => f.snapshots,
    browserScope: context => context.sessionId === 'native-main' ? { nodeIds: admitted ?? f.repo.list('tree_nodes', n => !n.deleted).map(n => n.id) } : null });
  const peer = { id: 'test-browser', principal: { kind: 'owner' }, interactions: 'answer', signal: live() }, connection = { browserPeer: peer }, handler = createTreeHandler({ service, connection });
  return { ...f, service, metrics, peer, connection, handler, restrict: ids => { admitted = ids; }, call: (name, payload = {}, p = peer, signal = live()) => handler(name, { ...payload, sessionId: 'native-main' }, signal, p) };
}
async function gateway(t, service) {
  const ctx = new Context(); let credential;
  ctx.provide('credentials', { readRecord: async () => credential, async modifyRecord(_key, mutate) { credential = await mutate(credential); return credential; }, async deleteRecord() {} });
  await ctx.plugin({ apply(owner) { owner.provide('webServer', { host: '127.0.0.1', protocol: 'http:', port: 3080, register: () => () => {}, registerUpgrade: () => () => {}, tapIndex: () => () => {} }); } }).await();
  ctx.provide('arcfoldTreeV3', service);
  for (const plugin of [OfficialConnection, TypertRegistry, RemoteAccessService, TypertGateway]) await ctx.plugin(plugin).await();
  await ctx.plugin({ inject: ['arcfoldTreeV3', 'connection', 'typert', 'typertGateway'], apply(owner) { owner.typert.register({ package: '@arcfold/dsh-method-ui', face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, invocations: treeInvocations }); installTreeWeb(owner); } }).await();
  t.after(() => ctx.fiber.dispose());
  return { ctx, invoke: (method, request, peer = ctx.connection.browserPeer) => ctx.typertGateway.invoke({ namespace: 'arcfoldTreeV3', method, args: { request: { sessionId: 'native-main', ...request } }, peer }) };
}
test('U01 official gateway registers dotted endpoints and authenticates the actual browser owner', async t => {
  assert.deepEqual(treeInvocations.map(i => i.method), TREE_ENDPOINTS);
  const f = uiFixture(t), g = await gateway(t, f.service), value = await g.invoke('tree.list', {});
  assert.equal(value.nodes.length, 1); assert.equal(value.nodes[0].name, '我');
  await assert.rejects(g.invoke('tree.list', {}, { ...g.ctx.connection.browserPeer }), /已认证/);
  for (const updates of [{ principal: { kind: 'guest' } }, { interactions: 'observe' }, { signal: AbortSignal.abort() }]) await assert.rejects(f.call('tree.list', {}, { ...f.peer, ...updates }), /已认证/);
  for (const updates of [{ principal: { kind: 'guest' } }, { interactions: 'observe' }, { signal: AbortSignal.abort() }]) { const before = { ...f.peer }; Object.assign(f.peer, updates); await assert.rejects(f.call('tree.list'), /已认证/); Object.assign(f.peer, before); }
  await assert.rejects(f.call('tree.list', {}, f.peer, AbortSignal.abort()), /已认证/);
  await assert.rejects(f.handler('tree.list', { sessionId: 'unbound-helper' }, live(), f.peer), /范围/);
  assert.equal(f.repo.list('tree_change_events').filter(r => r.commandType === 'renameTreeNode').length, 0);
});
test('U02 paths and cascaded status remain distinct; browser currentPath cannot grant access', async t => {
  const f = uiFixture(t), a = f.create('我办父事项'), b = f.create('我办子事项', a), turn = await f.turn(a, '同时讨论两个事项', 'native-main', [b]);
  const current = await f.call('session.current'); assert.equal(current.paths.length, 2);
  await f.call('node.status', { requestId: 'pause', nodeId: a, status: 'paused', expectedRevision: f.repo.get('tree_nodes', a).revision });
  const details = await f.call('turn.details', { turnId: turn.id }); assert.equal(details.nodes.find(n => n.id === b).statusOrigin, 'cascade');
  f.restrict([a]); await assert.rejects(f.call('node.details', { nodeId: b, currentPath: [b] }));
  await assert.rejects(f.call('node.status', { requestId: 'partial-scope', nodeId: a, status: 'completed', expectedRevision: f.repo.get('tree_nodes', a).revision }), /范围/);
});

test('owner can undo an automatic correction without overwriting later user edits or moved evidence', async t => {
  for (const variant of ['restore', 'edited', 'moved']) await t.test(variant, async t => {
    const f = uiFixture(t), node = f.create('我核对理解'), prior = await f.turn(node, '原来的理解来源');
    const priorJob = f.learning.enqueue(prior.id, node);
    f.complete(priorJob, { understandings: [], revisions: [], methods: [], supplements: [], categories: [] });
    f.asModel('learning', [node]);
    const items = new ItemService({ repository: f.repo, resolveSource: f.resolveSource, context: () => f.context });
    const proposed = items.commitProposal(f.cmd({ nodeId: node, understandings: [{ content: '原来的理解', source: 'assistant_inferred', sourceRefs: prior.userSourceRefs }], methods: [], supplements: [] })).result;
    assert.equal(proposed.understandings.status, 'applied'); const original = proposed.understandings.itemIds[0];
    const turn = await f.turn(node, '我不是这个意思，我要先看整体'), job = f.learning.enqueue(turn.id, node);
    const source = job.input.sources.find(s => s.role === 'user' && job.input.currentTurn.sourceIds.includes(s.id));
    const output = { understandings: [{ content: '先看整体', source: 'user_expressed', sourceIds: [source.id] }], methods: [], supplements: [], categories: [],
      revisions: [{ targetId: original, targetVersion: 1, mark: 'invalid', replacedByIndex: 0, sourceIds: [source.id], correctionEvidence: { scope: 'local', quotes: [{ sourceId: source.id, text: '我不是这个意思，我要先看整体' }] } }] };
    assert.equal(f.complete(job, output).status, 'committed');
    const previous = f.repo.get('tree_items', original), replacement = f.repo.get('tree_items', previous.replacedBy);
    const payload = { requestId: 'undo-correction', itemId: original, expectedRevision: previous.revision, replacementId: replacement.id, expectedReplacementRevision: replacement.revision };
    if (variant === 'edited') {
      await f.call('item.edit', { requestId: 'user-edit-replacement', itemId: replacement.id, expectedVersion: 1, replacement: '用户随后自己编辑的内容', reason: '纠正' });
      await assert.rejects(f.call('item.undoCorrection', payload));
      assert.equal(f.repo.get('tree_items', original).lifecycle, 'invalid');
      assert.equal(f.repo.get('tree_items', replacement.id).activeVersion, 2);
    } else if (variant === 'moved') {
      const other = f.create('其他事项');
      await f.call('turn.correct', { requestId: 'move-evidence', turnId: prior.id, nodeIds: [other], expectedAssignmentRevision: prior.assignmentRevision });
      await assert.rejects(f.call('item.undoCorrection', payload));
      assert.equal(f.repo.get('tree_items', original).lifecycle, 'invalid');
      assert.equal(f.repo.get('tree_items', replacement.id).lifecycle, 'active');
    } else {
      assert.equal((await f.call('item.undoCorrection', payload)).state, 'success');
      assert.equal(f.repo.get('tree_items', original).lifecycle, 'active');
      assert.equal(f.repo.get('tree_items', replacement.id).lifecycle, 'withdrawn');
      assert.equal((await f.call('item.undoCorrection', payload)).state, 'success');
    }
  });
});
test('U03 item confirmation preserves inference history; edits protect content and stale cards fail', async t => {
  const f = uiFixture(t), a = f.create('我确认理解'); f.asModel('learning', [a]);
  const id = f.propose(a, { understandings: [{ content: '用户可能偏好简短表述', source: 'assistant_inferred', sourceRefs: [f.ref] }] }).understandings.itemIds[0];
  const result = await f.call('item.confirm', { itemId: id, expectedVersion: 1, requestId: 'confirm' }); assert.equal(result.state, 'success');
  assert.equal((await f.call('item.confirm', { itemId: id, expectedVersion: 1, requestId: 'confirm' })).value.id, result.value.id);
  const details = await f.call('node.details', { nodeId: a }); assert.equal(details.items[0].history.length, 2); assert.equal(details.items[0].current.sourceKind, 'user_expressed');
  assert.equal((await f.call('source.read', { itemId: id, version: 1, sourceIndex: 0 })).text, f.resolveSource(f.ref).text);
  await assert.rejects(f.call('item.edit', { itemId: id, expectedVersion: 1, replacement: '旧卡', reason: '修改', requestId: 'stale' }), /变化/);
  await f.call('item.edit', { itemId: id, expectedVersion: 2, replacement: '只在摘要中简短', reason: '补充范围', requestId: 'edit' });
  assert.equal(f.repo.get('tree_items', id).userProtected, true); assert.equal(f.repo.list('tree_repairs').at(-1).countsAsError, false);
});

test('source recheck pending content is resolved by explicit owner edit, without restoring removed evidence', async t => {
  const f = uiFixture(t), a = f.create('原目标'), b = f.create('新目标');
  const first = await f.turn(a, '移走这条原话'), second = await f.turn(a, '保留这条独立原话');
  const items = new ItemService({ repository: f.repo, resolveSource: f.resolveSource, context: () => f.context }); f.asModel('learning', [a]);
  const id = items.commitProposal(f.cmd({ nodeId: a, understandings: [{ content: '混合来源理解', source: 'assistant_inferred', sourceRefs: [...first.userSourceRefs, ...second.userSourceRefs] }], methods: [], supplements: [] })).result.understandings.itemIds[0];
  const old = f.repo.get('tree_item_versions', digest(['item_version', id, 1]));
  await f.call('turn.correct', { requestId: 'source-correction', turnId: first.id, nodeIds: [b], expectedAssignmentRevision: 1 });
  await assert.rejects(f.call('item.confirm', { requestId: 'source-confirm', itemId: id, expectedVersion: 1 }), /核对/);
  await f.call('item.edit', { requestId: 'source-owner-edit', itemId: id, expectedVersion: 1, replacement: '用户重新确认的范围', reason: '核对归属后的剩余依据' });
  const item = f.repo.get('tree_items', id), current = f.repo.get('tree_item_versions', digest(['item_version', id, 2]));
  assert.equal(item.stale, false); assert.equal(item.userProtected, true); assert.equal(item.sourceReview.status, 'resolved_by_user');
  assert.deepEqual(current.sourceRefs, second.userSourceRefs); assert.ok(current.userEditRef);
  assert.deepEqual(f.repo.get('tree_item_versions', old.id), old);
  assert.equal(f.repo.list('tree_repairs', r => r.itemId === id).at(-1).countsAsError, false);
  assert.ok(f.builder.activeItems([a]).some(r => r.item.id === id));
});

test('turn status undo restores the exact cascade, rejects stale changes and never rewinds later work', async t => {
  const f = uiFixture(t), parent = f.create('我办一件事'), child = f.create('我办子事项', parent), turn = await f.turn(parent);
  f.asModel('main', [parent]); const before = f.repo.list('tree_nodes'), receipt = f.tree.setStatus(f.cmd({ nodeId: parent, status: 'completed', sourceRefs: [] }, f.expected('tree_nodes', parent)));
  f.metrics.observeTree(receipt, before, { logicalTurnId: turn.id }); const original = (await f.call('turn.details', { turnId: turn.id })).statusChanges[0];
  const input = { requestId: 'undo-status', turnId: turn.id, observationId: original.id, expectedRevisions: original.expectedRevisions };
  f.restrict([parent]); await assert.rejects(f.call('turn.undoStatus', input), /范围/); f.restrict(null);
  await f.call('turn.undoStatus', input); assert.equal(f.repo.get('tree_nodes', parent).status, 'active'); assert.equal(f.repo.get('tree_nodes', child).status, 'active');
  const details = await f.call('turn.details', { turnId: turn.id }); assert.equal(details.statusChanges.length, 1); assert.equal(details.statusChanges[0].reversed, true); assert.equal(f.metrics.growth().excludingCascadeAndReversed, 0);
  assert.equal((await f.call('turn.undoStatus', input)).state, 'success'); await assert.rejects(f.call('turn.undoStatus', { ...input, requestId: 'another-undo' }), /变化/);
  const beforeAgain = f.repo.list('tree_nodes'), again = f.tree.setStatus(f.cmd({ nodeId: parent, status: 'completed', sourceRefs: [] }, f.expected('tree_nodes', parent))); f.metrics.observeTree(again, beforeAgain, { logicalTurnId: turn.id });
  const later = (await f.call('turn.details', { turnId: turn.id })).statusChanges.find(c => !c.reversed);
  await f.call('node.status', { requestId: 'later-user-reopen', nodeId: child, status: 'active', expectedRevision: f.repo.get('tree_nodes', child).revision });
  await assert.rejects(f.call('turn.undoStatus', { requestId: 'stale-undo', turnId: turn.id, observationId: later.id, expectedRevisions: later.expectedRevisions }), /变化/);
});
test('U04 correcting to a new child atomically invalidates old learning and schedules relearning', async t => {
  const f = uiFixture(t), a = f.create('我讨论原事'), parent = f.create('我讨论新事'), turn = await f.turn(a);
  f.asModel('learning', [a]); const itemService = new ItemService({ repository: f.repo, resolveSource: f.resolveSource, context: () => f.context });
  const id = itemService.commitProposal(f.cmd({ nodeId: a, understandings: [{ content: '只属于这轮', source: 'assistant_inferred', sourceRefs: turn.userSourceRefs }], methods: [], supplements: [] })).result.understandings.itemIds[0];
  const result = await f.call('turn.correct', { requestId: 'new-child', turnId: turn.id, nodeIds: [], expectedAssignmentRevision: turn.assignmentRevision, create: { parentId: parent, name: '我处理新事的子事项', expectedTreeRevision: f.repo.meta().treeRevision } });
  assert.equal(result.state, 'success'); const target = result.value.result.nodeIds[0]; assert.equal(f.repo.get('tree_nodes', target).parentId, parent);
  assert.equal(f.repo.get('tree_items', id).lifecycle, 'invalid'); const jobs = (await f.call('turn.details', { turnId: turn.id })).jobs;
  assert.equal(jobs.filter(j => j.role === 'learning' && result.value.result.jobs.includes(j.id)).length, 1); assert.equal(jobs.find(j => j.role === 'learning' && !result.value.result.jobs.includes(j.id)).status, 'stale');
  assert.equal(f.repo.list('tree_repairs').at(-1).countsAsError, null);
  assert.equal((await f.call('receipts.read', { requestId: 'new-child' })).state, 'success');
});
test('method editing preserves disabled hooks and blocks arbitrary script replacement', async t => {
  const f = uiFixture(t), a = f.create('我使用方法'); f.asModel('learning', [a]); const id = f.propose(a, { methods: [method([f.ref])] }).methods.itemIds[0];
  let detail = (await f.call('node.details', { nodeId: a })).items.find(i => i.id === id); const hookId = detail.hooks[0].hookId;
  await f.call('hook.disable', { requestId: 'disable', methodId: id, hookId, expectedVersion: 1 });
  await assert.rejects(f.call('item.edit', { requestId: 'arbitrary', itemId: id, expectedVersion: 1, replacement: { short: detail.method.short, long: null, scripts: ['evil'] }, reason: 'invalid' }));
  await f.call('item.edit', { requestId: 'edit-method', itemId: id, expectedVersion: 1, replacement: { short: { ...detail.method.short, action: '核对后再修改' }, long: null }, reason: '明确做法' });
  detail = (await f.call('node.details', { nodeId: a })).items.find(i => i.id === id); assert.equal(detail.hooks.find(h => h.hookId === hookId).enabled, false); assert.equal(detail.current.version, 2);
});
test('U06 real snapshot worker prepares readable differences and refuses stale restoration', async t => {
  const base = snapshotFixture(t), f = uiFixture(t, base), a = f.create('我恢复内容'), turn = f.repo.list('tree_turns', t => t.nodeIds.includes(a))[0];
  const path = join(f.workspace, 'draft.txt'); writeFileSync(path, '最初版本'); const saved = await f.snapshots.capture({ requestId: 'before', reason: 'main_turn' }); bindTurnSnapshot(f.repo, saved.id, turn.id);
  writeFileSync(path, '第二版本'); const listed = await f.call('snapshots.list', { logicalTurnId: turn.id }); assert.equal(listed.snapshots.length, 1);
  const preview = await f.call('snapshots.preview', { requestId: 'preview', snapshotId: saved.id, paths: ['draft.txt'] });
  assert.equal(preview.value.diffs[0].current.text, '第二版本'); assert.equal(preview.value.diffs[0].restoreTo.text, '最初版本'); assert.equal(readFileSync(path, 'utf8'), '第二版本');
  writeFileSync(path, '预览后新增'); await assert.rejects(f.call('snapshots.restore', { requestId: 'conflict-restore', previewId: preview.value.id, expectedHashes: preview.value.expectedCurrentHashes }), /变化/); assert.equal(readFileSync(path, 'utf8'), '预览后新增');
  const fresh = await f.call('snapshots.preview', { requestId: 'fresh-preview', snapshotId: saved.id, paths: ['draft.txt'] });
  const restored = await f.call('snapshots.restore', { requestId: 'restore', previewId: fresh.value.id, expectedHashes: fresh.value.expectedCurrentHashes }); assert.equal(restored.state, 'success'); assert.equal(readFileSync(path, 'utf8'), '最初版本');
  assert.equal((await f.call('receipts.read', { requestId: 'restore' })).state, 'success');
});
test('U07 pagination rejects a changed list and empty metrics have no invented percentage', async t => {
  const f = uiFixture(t); f.create('我有一个事项'); const page = await f.call('tree.list', { limit: 1 }); assert.ok(page.nextCursor); f.create('我又有一个事项');
  await assert.rejects(f.call('tree.list', { limit: 1, cursor: page.nextCursor }), /变化/);
  const m = await f.call('metrics.read'); assert.equal(m.observations.rates.adoption.value, null); assert.equal(m.observations.rates.adoption.denominator, 0);
});

async function domFixture(t, f) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' });
  const keys = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'], prior = Object.fromEntries(keys.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const { createRoot } = await import('react-dom/client'), root = createRoot(document.getElementById('root')), g = await gateway(t, f.service), calls = [];
  const transport = { async call(_channel, endpoint, body) { calls.push({ endpoint, request: body.args.request }); try { return { ok: true, value: await g.invoke(endpoint.split('/')[1], body.args.request) }; } catch (error) { return { ok: false, error: { code: error.code, message: error.message } }; } } };
  const source = createTreeSource({ rpc: transport, sessionId: 'native-main', intervalMs: 60000 });
  const flush = () => act(async () => { await new Promise(resolve => setImmediate(resolve)); });
  t.after(async () => { await act(async () => root.unmount()); source.dispose(); dom.window.close(); for (const key of keys) if (prior[key]) Object.defineProperty(globalThis, key, prior[key]); else delete globalThis[key]; });
  const click = async text => { const element = [...document.querySelectorAll('button')].find(b => b.textContent === text || b.getAttribute('aria-label') === text); assert.ok(element, 'Button: ' + text); await act(async () => element.click()); await flush(); return element; };
  const type = async (label, value) => { const element = [...document.querySelectorAll('label')].find(l => l.firstChild?.textContent === label)?.querySelector('input,textarea'); assert.ok(element, label); await act(async () => { const proto = element.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value); element.dispatchEvent(new dom.window.Event('input', { bubbles: true })); element.dispatchEvent(new dom.window.Event('change', { bubbles: true })); }); };
  return { dom, root, source, calls, transport, flush, click, type, render: async component => { await act(async () => root.render(component)); await flush(); await flush(); } };
}

test('jsdom through official RPC renders empty metrics, edits a node and preserves source text as text', async t => {
  const f = uiFixture(t), a = f.create('我核对页面'), dom = await domFixture(t, f);
  await dom.render(React.createElement(TreeView, { source: dom.source }));
  assert.ok(document.querySelector('.tree-columns')); assert.equal(document.querySelector('.tree-metrics'), null);
  await dom.click('指标'); assert.match(document.body.textContent, /暂无数据/); assert.doesNotMatch(document.body.textContent, /100%/); await dom.click('目标树');
  await dom.click('我核对页面'); assert.equal(document.querySelector('.tree-node-title').open, false); await act(async () => document.querySelector('.tree-node-title > summary').click()); assert.equal(document.querySelector('.tree-node-title').open, true); await dom.type('事项名称', '我核对新的页面名称'); await dom.click('保存名称');
  assert.equal(f.repo.get('tree_nodes', a).name, '我核对新的页面名称'); assert.match(document.body.textContent, /我核对新的页面名称/);
  f.asModel('learning', [a]); f.propose(a, { understandings: [{ content: '<script>window.bad=true</script> 保留原话', source: 'assistant_inferred', sourceRefs: [f.ref] }] }); await dom.click('刷新');
  assert.match(document.body.textContent, /<script>window.bad=true/); assert.equal(document.querySelector('script'), null);
  const item = document.querySelector('.tree-item'); assert.ok(item); assert.equal(item.open, false); await act(async () => item.querySelector('summary').click()); assert.equal(item.open, true); await dom.click('确认'); assert.equal(f.repo.list('tree_items')[0].activeVersion, 2); assert.doesNotMatch(document.body.textContent, /来源与历史|用户表达|助手推断|版本 2/);
  assert.equal(dom.calls.filter(c => c.endpoint.endsWith('/item.confirm')).length, 1);
});

test('G6 browser shows the full overflow reason and original, and submits an explicit branch without retry', async t => {
  const f = uiFixture(t), branch = f.create('我继续这一支'); let selected = null, mutations = 0;
  f.service.attribution = { capacity: () => ({ limit: 2000, count: selected ? 1 : 2001, totalCount: 2001, blocked: !selected,
    selection: { nodeId: selected, revision: selected ? 1 : 0 }, selectionMissing: false, path: selected ? [{ id: branch, name: '我继续这一支' }] : [],
    pending: selected ? [] : [{ id: 'pending-original', revision: 1, state: 'waiting', text: '<script>这只是用户原话</script>' }] }) };
  f.service.selectBranch = async (p, context) => { assert.equal(context.sessionId, 'native-main'); assert.equal(p.nodeId, branch); assert.equal(p.pendingId, 'pending-original'); selected = p.nodeId; mutations++; return { selection: { nodeId: selected, revision: 1 }, continued: p.pendingId }; };
  const dom = await domFixture(t, f); await dom.render(React.createElement(TreeDock, { source: dom.source }));
  assert.match(document.body.textContent, /2001.*2000/); assert.match(document.body.textContent, /这只是用户原话/); assert.equal(document.querySelectorAll('script').length, 0);
  const control = document.querySelector('select[aria-label="本聊天使用哪支目标"]');
  await act(async () => { control.value = branch; control.dispatchEvent(new dom.dom.window.Event('change', { bubbles: true })); });
  await dom.click('选定并继续这条消息'); await dom.flush(); assert.equal(mutations, 1);
  assert.match(document.body.textContent, /本聊天只在这支目标下判断归属：我继续这一支/);
  const sent = dom.calls.filter(c => c.endpoint.endsWith('/session.selectBranch')); assert.equal(sent.length, 1); assert.equal(sent[0].request.nodeId, branch);
  await dom.click('更改范围'); assert.equal(document.querySelector('select').value, branch);
});

test('turn strips are absent while the current goals and turn records remain intact', async t => {
  const f = uiFixture(t), a = f.create('我办甲'), b = f.create('我办乙'), turn = await f.turn(a, '合成用户话', 'native-main', [b]);
  const before = f.repo.list('tree_jobs'), dom = await domFixture(t, f);
  await dom.render(React.createElement(React.Fragment, null, React.createElement(TreeDock, { source: dom.source }), React.createElement(TreeTurnTail, { source: dom.source, turnId: turn.id })));
  assert.equal(document.querySelector('.tree-turn-tail'), null);
  const detail = await f.call('turn.details', { turnId: turn.id }); assert.ok(detail.nodes.some(node => node.id === a)); assert.ok(detail.nodes.some(node => node.id === b));
  assert.deepEqual(f.repo.list('tree_jobs'), before);
});

test('U08 jsdom previews a redacted local report and exports only after an explicit click', async t => {
  const base = improvementFixture(t), a = base.create('我合成报告'), b = base.create('我另一个报告来源'); base.repair(a); base.repair(b); const job = base.improvement.enqueue('learning'); base.completeImprovement(job, universal(job));
  const f = uiFixture(t, { ...base, resolveSource: base.resolveSource }), dom = await domFixture(t, f);
  // uiFixture normally supplies a snapshot-only signals adapter; this fixture
  // has actual learning evidence, so install its real metric adapter explicitly.
  f.service.metrics = new MetricsService({ repository: f.repo, experience: base.experience, signals: base.signals });
  await dom.render(React.createElement(TreeView, { source: dom.source })); await dom.click('给开发者的报告'); await dom.click('遗漏范围限定检查');
  assert.match(document.body.textContent, /原始问题描述已隐藏/); assert.equal(f.repo.list('tree_reports')[0].exportAudit.length, 0);
  const urls = [], old = URL.createObjectURL, oldRevoke = URL.revokeObjectURL; URL.createObjectURL = blob => { urls.push(blob); return 'blob:local-report'; }; URL.revokeObjectURL = () => {};
  t.after(() => { URL.createObjectURL = old; URL.revokeObjectURL = oldRevoke; });
  await dom.click('生成本地下载'); assert.equal(urls.length, 1); assert.equal(f.repo.list('tree_reports')[0].exportAudit.length, 1); assert.equal(f.repo.list('tree_reports')[0].exportAudit[0].includeEvidence, false); assert.equal(document.querySelector('a[download]').href, 'blob:local-report');
});

test('client lost-response recovery only reads receipt and never automatically resends mutation', async t => {
  const f = uiFixture(t), a = f.create('我测试断线'), calls = []; let lost = true;
  const source = createTreeSource({ sessionId: 'native-main', rpc: { async call(_channel, endpoint, body) { const method = endpoint.split('/')[1]; calls.push(method); const value = await f.call(method, body.args.request); if (method === 'node.rename' && lost) { lost = false; throw new Error('synthetic lost reply'); } return { ok: true, value }; } } }); t.after(() => source.dispose());
  const input = { nodeId: a, name: '我读回操作结果', expectedRevision: f.repo.get('tree_nodes', a).revision };
  const [first, duplicate] = await Promise.all([source.act('node.rename', input, 'same-request'), source.act('node.rename', input, 'same-request')]);
  assert.equal(first.state, 'success'); assert.equal(duplicate.state, 'success'); assert.equal(calls.filter(name => name === 'node.rename').length, 1); assert.ok(calls.includes('receipts.read'));
  await assert.rejects(source.act('node.rename', { ...input, name: 'different' }, 'same-request'), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('v3 client installs exactly the three prescribed slots using the actual native turn prop', () => {
  const registrations = [], effects = [], ctx = { slots: { inject: (_name, fn) => fn(), register: (definition, component) => registrations.push({ definition, component }) }, effect: fn => effects.push(fn), on: () => () => {}, connection: { rpc: {} } };
  installTreeClient(ctx); assert.deepEqual(registrations.map(r => r.definition.name), ['conversation.input.dock', 'conversation.view', 'conversation.chat.turnTail']);
  const tail = registrations.at(-1), props = tail.definition.inject('main'), rendered = tail.component({ ...props, turn: { turn: 7, status: 'closed', steps: [] } }); assert.equal(rendered.props.nativeTurn, 7); effects[0]()();
});

test('two actual UI corrections enter diagnosis with exact before/after versions without predeclaring errors', async t => {
  const base = improvementFixture(t), f = uiFixture(t, base), a = f.create('我修改甲理解'), b = f.create('我修改乙理解');
  for (const node of [a, b]) { f.asModel('learning', [node]); const id = f.propose(node, { understandings: [{ content: '原来的助手推断', source: 'assistant_inferred', sourceRefs: [f.ref] }] }).understandings.itemIds[0];
    await f.call('item.edit', { requestId: 'edit-' + node, itemId: id, expectedVersion: 1, replacement: '用户现在明确的具体范围', reason: '补足范围', }); }
  const resolve = evidenceResolver(f.repo, base.resolveSource); base.jobs.assertSources = sources => sources.every(s => resolve(s.ref)?.sha256 === s.ref.sha256);
  const job = base.improvement.enqueue('learning'); assert.equal(job.input.repairs.length, 2); assert.ok(job.input.repairs.every(r => r.countsAsError === null));
  assert.ok(job.input.sources.every(s => s.origin === 'ui')); assert.equal(job.input.repairedItems[0].before.content, '原来的助手推断'); assert.equal(job.input.repairedItems[0].after.content, '用户现在明确的具体范围');
  // B7 must give its sole job owner this same trusted resolver for native and
  // UI receipts. This is a source recheck, never an unconditional test bypass.
  const done = base.completeImprovement(job, noChange()); assert.equal(done.status, 'committed'); assert.equal(f.repo.list('tree_reports').length, 0);
});

test('jsdom keeps pending writes visible, then renders a revision conflict without optimistic success', async t => {
  const f = uiFixture(t), a = f.create('我看到待确认状态'), dom = await domFixture(t, f); await dom.render(React.createElement(TreeView, { source: dom.source })); await dom.click('我看到待确认状态'); await act(async () => document.querySelector('.tree-node-title > summary').click());
  const original = dom.transport.call; let release; const held = new Promise(r => { release = r; });
  dom.transport.call = async (...args) => { if (args[1].endsWith('/node.rename')) await held; return original(...args); };
  await dom.type('事项名称', '等待中的修改'); await dom.click('保存名称');
  assert.match(document.body.textContent, /正在提交，尚未确认/); assert.equal(f.repo.get('tree_nodes', a).name, '我看到待确认状态');
  await f.call('node.rename', { requestId: 'concurrent', nodeId: a, name: '另一个已保存的修改', expectedRevision: f.repo.get('tree_nodes', a).revision });
  await act(async () => { release(); await new Promise(r => setImmediate(r)); }); await dom.flush();
  assert.match(document.body.textContent, /内容已变化/); assert.equal(f.repo.get('tree_nodes', a).name, '另一个已保存的修改');
});

test('designed navigation searches with ancestors, folds branches and preserves selection through refresh', async t => {
  const f = uiFixture(t), parent = f.create('投递岗位'), child = f.create('写求职信', parent), other = f.create('整理开支'), dom = await domFixture(t, f);
  await dom.render(React.createElement(TreeView, { source: dom.source }));
  const rows = () => [...document.querySelectorAll('[role=treeitem]')];
  await act(async () => document.querySelector('[aria-label="收起投递岗位"]').click());
  assert.equal(rows().some(row => row.dataset.nodeId === child), false);
  await dom.type('搜索目标', '求职信');
  assert.deepEqual(rows().map(row => row.textContent), ['我', '投递岗位', '写求职信']);
  await dom.click('写求职信'); await dom.type('搜索目标', '');
  assert.equal(document.querySelector('[aria-selected=true]').dataset.nodeId, child);
  await act(async () => dom.source.refresh()); await dom.flush();
  assert.equal(document.querySelector('[aria-selected=true]').dataset.nodeId, child);
  assert.ok(rows().some(row => row.dataset.nodeId === other));
  assert.equal(document.querySelector('.tree-detail h2').textContent, '写求职信');
  assert.doesNotMatch(document.querySelector('.tree-detail').textContent, /重新打开|改状态|移动到|这个事项的设置/);
});

test('expanded item actions persist real edits and delete without displaying provenance tags', async t => {
  const f = uiFixture(t), node = f.create('修改求职信'); f.asModel('learning', [node]);
  const id = f.propose(node, { understandings: [{ content: '原样保留的理解', source: 'assistant_inferred', sourceRefs: [f.ref] }] }).understandings.itemIds[0];
  const dom = await domFixture(t, f); await dom.render(React.createElement(TreeView, { source: dom.source })); await dom.click('修改求职信');
  await act(async () => document.querySelector('.tree-item>summary').click());
  assert.equal(document.querySelector('.tree-item').open, true);
  assert.doesNotMatch(document.querySelector('.tree-item').textContent, /版本|用户表达|助手推断|来源与历史/);
  await dom.click('修改'); await dom.type('理解内容', '用户逐字修改的理解'); await dom.type('修改理由', '说明更具体');
  await act(async () => dom.source.refresh()); await dom.flush();
  assert.equal(document.querySelector('.tree-item').open, true);
  assert.equal(document.querySelector('textarea').value, '用户逐字修改的理解');
  await dom.click('保存修改');
  assert.equal((await f.call('node.details', { nodeId: node })).items.find(i => i.id === id).current.content, '用户逐字修改的理解');
  await dom.click('删除'); assert.equal(f.repo.get('tree_items', id).lifecycle, 'active'); await dom.click('确认删除');
  assert.equal(f.repo.get('tree_items', id).lifecycle, 'withdrawn'); assert.equal(document.querySelector('.tree-item'), null);
  assert.equal(dom.calls.filter(c => c.endpoint.endsWith('/item.withdraw')).length, 1);
});

test('method description remains exact and stop action changes the existing hook once', async t => {
  const f = uiFixture(t), node = f.create('检查求职信'); f.asModel('learning', [node]);
  const input = method([f.ref]); input.hooks = input.hooks.slice(0, 1);
  const id = f.propose(node, { methods: [input] }).methods.itemIds[0];
  const dom = await domFixture(t, f); await dom.render(React.createElement(TreeView, { source: dom.source })); await dom.click('检查求职信');
  await act(async () => document.querySelector('.tree-item>summary').click());
  const description = document.querySelector('.tree-method-description').textContent;
  assert.ok(description.includes(input.short.situation)); assert.ok(description.includes(input.short.action)); assert.ok(description.includes(input.expectedEffect.text));
  assert.doesNotMatch(document.querySelector('.tree-item').textContent, /停用此提醒|版本|依据与历史/);
  await dom.click('停用'); assert.equal((await f.call('node.details', { nodeId: node })).items.find(i => i.id === id).hooks[0].enabled, false);
  assert.equal(document.querySelector('.tree-method-description').textContent, description);
  assert.equal(dom.calls.filter(c => c.endpoint.endsWith('/hook.disable')).length, 1);
  assert.equal([...document.querySelectorAll('button')].find(b => b.textContent === '已停用').disabled, true);
});

test('an edit opened before another save retains its draft and cannot overwrite the newer version', async t => {
  const f = uiFixture(t), node = f.create('保留编辑草稿'); f.asModel('learning', [node]);
  const id = f.propose(node, { understandings: [{ content: '原理解', source: 'assistant_inferred', sourceRefs: [f.ref] }] }).understandings.itemIds[0];
  const dom = await domFixture(t, f); await dom.render(React.createElement(TreeView, { source: dom.source })); await dom.click('保留编辑草稿');
  await act(async () => document.querySelector('.tree-item>summary').click()); await dom.click('修改'); await dom.type('理解内容', '未提交的草稿'); await dom.type('修改理由', '补充');
  await f.call('item.edit', { requestId: 'external-save', itemId: id, expectedVersion: 1, replacement: '另一处保存的理解', reason: '另一次修改' });
  await act(async () => dom.source.refresh()); await dom.flush(); assert.equal(document.querySelector('textarea').value, '未提交的草稿');
  await dom.click('保存修改'); assert.match(document.body.textContent, /版本已变化|内容已变化/);
  assert.equal((await f.call('node.details', { nodeId: node })).items.find(i => i.id === id).current.content, '另一处保存的理解');
});

test('a long-only learned method can be edited without inventing a short rule', async t => {
  const f = uiFixture(t), node = f.create('合成方法'); f.asModel('learning', [node]);
  const long = { name: '用户纠正的做法', description: '按用户明确纠正的方式协作', whenToUse: '', steps: '先核对来源', pitfalls: '', verify: '' };
  const id = f.propose(node, { methods: [{ kind: 'collaboration', short: null, long, hooks: [], scriptRequests: [], expectedEffect: { category: 'omitted', change: 'less', text: '减少漏核来源' }, sourceRefs: [f.ref] }] }).methods.itemIds[0];
  const dom = await domFixture(t, f); await dom.render(React.createElement(TreeView, { source: dom.source })); await dom.click('合成方法');
  await act(async () => document.querySelector('.tree-item>summary').click());
  await dom.click('修改'); await dom.type('步骤', '先核对来源，再改写'); await dom.type('修改理由', '补全步骤');
  await dom.click('保存修改');
  const item = f.repo.get('tree_items', id), bundle = f.repo.get('tree_methods', digest(['method', id, item.activeVersion]));
  assert.equal(item.activeVersion, 2); assert.equal(bundle.short, null); assert.equal(bundle.long.steps, '先核对来源，再改写');
});

test('a verification result for a learned method is shown on its card', async t => {
  const f = uiFixture(t), node = f.create('合成检验方法'); f.asModel('learning', [node]);
  const [id] = f.propose(node, { methods: [method([f.ref])] }).methods.itemIds;
  const turn = await f.turn(node, '请按这个做法继续'); await f.builder.activate(turn.sessionId, turn.id, { cancelPrevious: () => {} });
  const invocation = digest(['synthetic-main-invocation', turn.id]);
  f.repo.command('fixtureMainInvocation', f.cmd({ turnId: turn.id }), { kind: 'program', id: 'fixture' }, () => {
    f.repo.save('tree_invocations', { id: invocation, jobId: 'fixture-main', role: 'main', nativeSessionId: turn.sessionId, nativeTurn: turn.nativeTurn, nativeStep: 1, ordinal: 1, modelConfigHash: digest('fixture'), promptHash: digest('fixture'), inputHash: digest('fixture'), allowedTools: [], state: 'result_received' }); return {};
  });
  f.builder.expose(turn.sessionId, invocation, 1, f.builder.capture(turn.sessionId));
  const verification = new VerificationService({ repository: f.repo, experience: f.experience, contextBuilder: f.builder, jobs: f.jobs, modelConfig: f.config, clusters: f.clusters });
  const job = verification.enqueue(node), evidence = job.input.effects.at(-1).input[0].id;
  const output = { operations: [], missed: [], verifications: [{ methodId: id, methodVersion: 1, result: 'met', observed: '本轮按做法核对了已有决定', opportunityCount: 1, evidence: [evidence] }], formatFixes: [], clusters: [], proposals: { understandings: [], methods: [] }, probes: [] };
  f.jobs.prepare(job.id); f.jobs.submit(job.id);
  f.jobs.receive(job.id, { message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(output) }] }, nativeLogRef: 'synthetic-ui-verification#1', eventsHash: digest(output) });
  assert.equal(f.jobs.validate(job.id).status, 'validated');
  assert.equal(f.jobs.commit(job.id, (result, context) => verification.applyResult(result, context)).status, 'committed');
  const dom = await domFixture(t, f); await dom.render(React.createElement(TreeView, { source: dom.source })); await dom.click('合成检验方法');
  await act(async () => document.querySelector('.tree-item>summary').click());
  assert.match(document.body.textContent, /达到预期 · 本轮按做法核对了已有决定/);
});
