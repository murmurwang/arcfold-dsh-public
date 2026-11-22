import test from 'node:test';
import assert from 'node:assert/strict';
import { integratedFixture } from './fixtures/tree-integration/native.mjs';
import { emptyLearning, emptyVerification } from './fixtures/tree-learning/helpers.mjs';
import { bootstrapFixture } from './fixtures/tree-integration/bootstrap.mjs';
import { ItemService } from '../src/tree/items.mjs';
import { method } from './fixtures/tree-domain/helpers.mjs';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import BasicCompaction from '@deepseek-ai/dsh-compaction-basic';
import { appendPluginRecord } from '@deepseek-ai/dsh-session';
import { ownedCompactionClass } from '../src/tree/host-context.mjs';
import { active } from './fixtures/tree-model/native.mjs';
import { digest } from '../src/tree/contracts.mjs';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { correctE01Assignment } from '../scripts/tree-experiment/e01-exercise.mjs';

const summary = () => ({ summary: { oneLine: '合成事项已整理', status: '合成测试已进行', outputs: [], decisions: [], next: '继续合成测试', pending: [] }, broaden: [], retrospect: { understandings: [], methods: [] } });

const answer = ({ role, input }) => {
  if (role === 'attribution') return { actions: [{ action: 'continue', nodeId: input.scope.nodeIds[0] }], statusChanges: [] };
  if (role === 'learning') return emptyLearning();
  if (role === 'verification') return emptyVerification();
  return '合成答复。';
};

test('E01 owner can remove a duplicate target and move the turn back through actual UI commands', async t => {
  let calls = 0;
  const f = await integratedFixture(t, row => {
    if (row.role === 'attribution') return { actions: [{ action: 'create', name: calls++ ? '误建的步骤' : '原目标' }], statusChanges: [] };
    return answer(row);
  });
  // This test exercises UI recovery rather than the separate 12-second
  // attribution deadline; allow the shared full suite to finish its mock call.
  f.runtime.attribution.timers = { setTimeout: fn => setTimeout(fn, 30000), clearTimeout };
  const agent = await f.main('e01-correction-test');
  const first = await f.turn(agent, '我要开始原目标。');
  assert.notEqual(first.nodeIds[0], f.repo.rootId());
  const second = await f.turn(agent, '这是原目标的下一步。');
  const duplicate = second.nodeIds[0], evidence = { nodeIds: [first.nodeIds[0]], uiActions: [] };
  await correctE01Assignment(f, { ordinal: 2, goal: 0 }, agent, second, evidence);
  assert.deepEqual(f.repo.get('tree_turns', second.id).nodeIds, first.nodeIds);
  assert.equal(f.repo.get('tree_nodes', duplicate).deleted, true);
  assert.deepEqual(evidence.uiActions.map(action => action.kind), ['synthetic-owner-undo-created-node', 'synthetic-owner-corrects-assignment']);
  const next = await f.turn(agent, '纠正之后继续。');
  assert.equal(next.status, 'settled');
});
function addHooks(f, turn, hooks) {
  const items = new ItemService({ repository: f.repo, resolveSource: f.runtime.resolveSource, context: () => ({ actor: { kind: 'program', id: 'fixture' } }) });
  return items.commitProposal({ requestId: 'fixture-hooks-' + f.repo.meta().lastEventOrdinal, expected: {}, input: { nodeId: turn.nodeIds[0], understandings: [], supplements: [], methods: [{ ...method(turn.userSourceRefs), hooks }] } }).result;
}

test('a deleted target in a mixed old scope does not hide surviving leave hooks or block the next turn', async t => {
  let calls = 0, target;
  const f = await integratedFixture(t, row => {
    if (row.role !== 'attribution') return answer(row);
    calls++;
    if (calls === 1) return { actions: [{ action: 'create', name: '原目标' }], statusChanges: [] };
    if (calls === 2) return { actions: [{ action: 'continue', nodeId: target }, { action: 'create', name: '误建目标' }], statusChanges: [] };
    return { actions: [{ action: 'create', name: '下一个目标' }], statusChanges: [] };
  });
  f.runtime.attribution.timers = { setTimeout: fn => setTimeout(fn, 30000), clearTimeout };
  const agent = await f.main('e01-mixed-scope-test');
  const first = await f.turn(agent, '我要开始原目标。'); target = first.nodeIds[0];
  assert.notEqual(target, f.repo.rootId());
  addHooks(f, first, [{ moment: 'node_leave', conditions: [], action: 'leave_note', message: '离开原目标的提醒' }]);
  const mixed = await f.turn(agent, '这是原目标的下一步。');
  const duplicate = mixed.createdNodeIds[0], evidence = { nodeIds: [target], uiActions: [] };
  await correctE01Assignment(f, { ordinal: 2, goal: 0 }, agent, mixed, evidence);
  assert.equal(f.repo.get('tree_nodes', duplicate).deleted, true);
  const next = await f.turn(agent, '进入另一个目标。');
  assert.equal(next.status, 'settled');
  assert.ok(f.repo.list('tree_hook_runs', run => run.result?.action === 'leave_note').length, 'Surviving target hooks still run');
});

test('B7 corrected mixed-source item reaches a bounded recheck owner', async t => {
  const f = await integratedFixture(t, (row, native) => {
    if (row.role === 'attribution') {
      const label = row.input.sources.filter(s => s.origin === 'user').at(-1).text.match(/目标([AB])/)[1];
      const node = native.repo.list('tree_nodes', n => n.name === '目标' + label)[0];
      return { actions: [node ? { action: 'switch', nodeId: node.id } : { action: 'create_child', parentId: native.repo.rootId(), name: '目标' + label }], statusChanges: [] };
    }
    if (row.role === 'verification' && row.input.sourceRecheck) {
      const target = row.input.knownItems[0], sourceIds = row.input.sources.map(s => s.id);
      assert.ok(row.input.sources.every(s => !s.text.includes('只在工作日')));
      return { ...emptyVerification(), operations: [{ op: 'rewrite', targetId: target.id, targetVersion: target.version, stage: 'none',
        reason: '移走原文后，剩余证据仅明确周末可以处理。', evidence: sourceIds, detail: { replacement: { content: '用户周末也可以处理该事项。', source: 'user_expressed', sourceIds } } }] };
    }
    return answer(row);
  });
  const agent = await f.main('mixed-source-correction');
  const removed = await f.turn(agent, '目标A：只在工作日处理。');
  const retained = await f.turn(agent, '目标A：周末也可以处理。');
  const other = await f.turn(agent, '目标B：另一件独立事项。');
  const items = new ItemService({ repository: f.repo, resolveSource: f.runtime.resolveSource, context: () => ({ actor: { kind: 'program', id: 'mixed-source-fixture' } }) });
  const proposed = items.commitProposal({ requestId: 'mixed-source-fixture', expected: {}, input: {
    nodeId: retained.nodeIds[0], understandings: [{ content: '用户可以在工作日和周末处理该事项。', source: 'assistant_inferred', sourceRefs: [...removed.userSourceRefs, ...retained.userSourceRefs] }], methods: [], supplements: [],
  } }).result;
  assert.equal(proposed.understandings.status, 'applied');
  const itemId = proposed.understandings.itemIds[0];
  const originalVersion = f.repo.get('tree_item_versions', digest(['item_version', itemId, 1]));
  await f.turn(agent, '目标A：继续核对已有安排。');
  const corrected = await f.runtime.ui.dispatch('turn.correct', { requestId: 'mixed-source-correct', turnId: removed.id, nodeIds: other.nodeIds, expectedAssignmentRevision: 1 },
    { actor: { kind: 'user', id: f.repo.userId }, sessionId: agent.session.id, signal: new AbortController().signal });
  assert.equal(corrected.state, 'success');
  await f.runtime.idle();
  const intents = f.repo.list('tree_jobs', j => !j.role && j.kind === 'verification' && j.input.itemId === itemId);
  const owners = f.repo.list('tree_jobs', j => j.role === 'verification' && j.nodeIds.includes(retained.nodeIds[0]));
  t.diagnostic(JSON.stringify({ stale: f.repo.get('tree_items', itemId).stale, intents: intents.map(j => ({ id: j.id, status: j.status })), owners: owners.map(j => ({ id: j.id, status: j.status })) }));
  assert.equal(intents.length, 1);
  assert.equal(f.repo.list('tree_jobs', j => j.role === 'learning' && j.trigger.turnId === removed.id && j.nodeIds.includes(other.nodeIds[0])).length, 1);
  assert.equal(owners.length, 1, 'A mixed-source correction must reach a real verification owner, not remain a queued scheduling intent');
  assert.equal(owners[0].status, 'committed', JSON.stringify(owners[0].error));
  const item = f.repo.get('tree_items', itemId), currentVersion = f.repo.get('tree_item_versions', digest(['item_version', itemId, item.activeVersion]));
  assert.equal(item.stale, false); assert.equal(item.activeVersion, 2); assert.equal(item.validation, 'unverified');
  assert.equal(currentVersion.content, '用户周末也可以处理该事项。');
  assert.deepEqual(currentVersion.sourceRefs, retained.userSourceRefs);
  assert.deepEqual(f.repo.get('tree_item_versions', originalVersion.id), originalVersion, 'The original mixed provenance stays immutable');
  assert.ok(f.repo.list('tree_exposures', e => e.role === 'main' && e.itemVersions.some(v => v.itemId === itemId && v.version === 1)).every(e => e.revoked));
  const sourceExposure = f.repo.get('tree_exposures', item.sourceReview.exposureId);
  assert.equal(sourceExposure.role, 'verification'); assert.equal(sourceExposure.kind, 'source_recheck');
  assert.equal(f.repo.get('tree_invocations', sourceExposure.invocationId).inputHash, owners[0].inputHash);
  assert.equal(f.repo.list('tree_repairs', r => r.itemId === itemId).length, 0, 'Assignment correction alone is not a model error');
  assert.equal(f.runtime.ui.turnJobs(f.repo.get('tree_turns', removed.id)).filter(j => j.role === 'verification').length, 1);
  await f.runtime.idle();
  assert.equal(f.repo.list('tree_jobs', j => j.role === 'verification' && j.trigger.intentId === intents[0].id).length, 1, 'Scanning a completed intent cannot submit it again');
});

test('new tree real-chat route uses owned website accounting without creating a finite test allowance', async t => {
  const f = await bootstrapFixture(t, answer, { webOnly: true }), agent = await f.main('website-accounting');
  const turn = await f.turn(agent, '合成真实对话入口检查');
  assert.equal(turn.status, 'settled');
  assert.deepEqual(f.requests.map(r => r.role), ['attribution', 'main', 'learning']);
  assert.ok(f.repo.list('tree_jobs').filter(j => j.role).every(j => j.status === 'committed'));
  const summary = f.ctx.arcfoldDeepSeekTransport.summary();
  assert.equal(summary.scope, 'web-unlimited');
  assert.equal(summary.ceilingMicroCny, null);
  assert.equal(summary.reservedMicroCny, 0);
  assert.equal(existsSync(join(f.privateRoot, 'test-ledger.sqlite')), false);
});

test('website main job records the actual selected model version when a native branch retains the previous default', async t => {
  const f = await bootstrapFixture(t, answer, { webOnly: true, webMainModel: 'deepseek-v4-pro' }), agent = await f.main('website-model-version');
  const pro = f.runtime.modelConfig('main', agent);
  const flash = f.runtime.modelConfig('main', agent, { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' });
  assert.equal(pro.model, 'deepseek-v4-pro'); assert.equal(pro.modelVersion, 'synthetic-pro-version');
  assert.equal(flash.model, 'deepseek-flash'); assert.equal(flash.modelVersion, f.runtime.modelConfig('learning').modelVersion);
  assert.notEqual(flash.modelVersion, pro.modelVersion); assert.notEqual(flash.priceVersion, pro.priceVersion);
  assert.equal(flash.reasoningEffort, 'max'); assert.equal(flash.budgetScope, 'web-unlimited');
  const turn = await f.turn(agent, '用Pro处理这条合成原话，后台继续使用Flash。');
  assert.equal(turn.status, 'settled');
  assert.deepEqual(f.requests.map(r => [r.role, r.body.model]), [['attribution', 'deepseek-flash'], ['main', 'deepseek-v4-pro'], ['learning', 'deepseek-flash']]);
  assert.ok(f.repo.list('tree_jobs', j => j.role).every(j => j.status === 'committed'));
  for (const request of f.requests) assert.ok([...f.runtime.tokenCounter.cache.values()].some(reading => reading.wireHash === digest(request.body)), 'Each actual Pro/Flash wire request was counted with its matching frozen encoder');
  assert.equal(f.repo.list('tree_jobs', j => j.role === 'main')[0].modelConfig.reasoningEffort, 'max');
});

test('a rejected learning response stays rejected while the next real user turn continues the same native worker with its failure receipt', async t => {
  let learningCalls = 0;
  const f = await integratedFixture(t, row => row.role === 'learning' ? ++learningCalls === 1 ? '{"understandings":[' : emptyLearning() : answer(row));
  const agent = await f.main('learning-after-rejection');
  const firstTurn = await f.turn(agent, '第一轮合成原话。');
  const first = f.repo.list('tree_jobs', j => j.role === 'learning')[0];
  assert.equal(first.status, 'invalid_output'); assert.ok(first.rawHash);
  const firstView = f.runtime.ui.turnJobs(firstTurn).filter(j => j.current && j.role === 'learning');
  assert.deepEqual(firstView.map(j => [j.id, j.status]), [[first.id, 'invalid_output']]);
  await f.turn(agent, '第二轮是新的原话，不重发上一轮。');
  const second = f.repo.list('tree_jobs', j => j.role === 'learning' && j.id !== first.id)[0];
  assert.equal(second.status, 'committed', JSON.stringify(second.error)); assert.equal(second.nativeSessionId, first.nativeSessionId);
  assert.deepEqual(second.input.previousReceipt.rejectedOutputs.map(r => [r.jobId, r.state, r.adopted]), [[first.id, 'invalid_output', false]]);
  assert.equal(f.repo.list('tree_learning_sessions')[0].history.length, 1);
  assert.equal(f.repo.list('tree_items').length, 0); assert.equal(learningCalls, 2);
  await f.runtime.owner.recover(); await f.runtime.owner.run(first.id);
  assert.equal(learningCalls, 2); assert.deepEqual(f.repo.get('tree_jobs', first.id), first);
  assert.deepEqual(f.runtime.ui.turnJobs(firstTurn).filter(j => j.current && j.role === 'learning'), firstView);
});

test('G6 native overflow keeps the original without dispatch, then an authenticated branch choice resumes it exactly once', async t => {
  const f = await integratedFixture(t, answer), agent = await f.main('overflow-main'), root = f.repo.get('tree_nodes', f.repo.rootId());
  f.repo.transaction(() => { for (let n = 0; n < 2000; n++) f.repo.save('tree_nodes', { ...root, id: `overflow-${n}`, parentId: root.id, name: `事项${n}`, status: n % 2 ? 'paused' : 'active' }); });
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '请继续选定的事项，保留这条原话。' }] });
  agent.followup(message); await agent.whenIdle(); await f.runtime.idle();
  assert.equal(f.requests.length, 0); assert.equal(f.repo.list('tree_turns').length, 0);
  const context = { sessionId: agent.session.id, actor: { kind: 'user', id: f.repo.userId }, signal: new AbortController().signal };
  const current = await f.runtime.ui.dispatch('session.current', {}, context), pending = current.attribution.pending[0];
  assert.equal(current.attribution.count, 2001); assert.equal(pending.state, 'waiting'); assert.match(pending.text, /保留这条原话/);
  const payload = { nodeId: root.id, expectedTreeRevision: f.repo.meta().treeRevision, expectedSelectionRevision: 0, pendingId: pending.id };
  await assert.rejects(f.runtime.ui.dispatch('session.selectBranch', { ...payload, requestId: 'still-overflow' }, context), { code: 'CANDIDATE_CAPACITY' });
  assert.equal(f.requests.length, 0); assert.equal(f.runtime.attribution.selection(agent.session.id).revision, 0);
  const other = await f.main('other-overflow-chat'), otherContext = { ...context, sessionId: other.session.id };
  await assert.rejects(f.runtime.ui.dispatch('session.selectBranch', { ...payload, nodeId: 'overflow-0', requestId: 'foreign-pending' }, otherContext), { code: 'CONTINUATION_UNAVAILABLE' });
  const selected = { ...payload, nodeId: 'overflow-0', requestId: 'choose-and-continue' };
  const receipts = await Promise.all([f.runtime.ui.dispatch('session.selectBranch', selected, context), f.runtime.ui.dispatch('session.selectBranch', selected, context)]);
  assert.ok(receipts.some(r => r.state === 'success'));
  await agent.whenIdle(); await f.runtime.idle();
  assert.deepEqual(f.requests.map(r => r.role), ['attribution', 'main', 'learning']);
  const turn = f.repo.list('tree_turns', t => t.sessionId === agent.session.id)[0]; assert.equal(turn.status, 'settled'); assert.deepEqual(turn.nodeIds, ['overflow-0']);
  assert.equal(turn.userSourceRefs[0].messageId, message.id);
  assert.equal(agent.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.id === message.id).length, 1);
  const attribution = f.repo.list('tree_jobs', j => j.role === 'attribution')[0]; assert.deepEqual(attribution.input.allowedIds.nodeIds, ['overflow-0']);
  const projection = f.runtime.builder.capture(agent.session.id).segments.find(s => s.key === 'global-overview'); assert.deepEqual(JSON.parse(projection.text).globalOverview.map(n => n.id), ['overflow-0']);
  assert.equal(f.runtime.attribution.capacity(agent.session.id).pending.length, 0); assert.equal(f.runtime.attribution.capacity(other.session.id).blocked, true);
  await f.runtime.ui.dispatch('session.selectBranch', selected, context); assert.equal(f.requests.length, 3);
  await assert.rejects(f.runtime.ui.dispatch('session.selectBranch', { ...selected, requestId: 'try-again', expectedTreeRevision: f.repo.meta().treeRevision, expectedSelectionRevision: 1 }, context), { code: 'CONTINUATION_UNAVAILABLE' });
  assert.equal(f.requests.length, 3);
});

for (const interrupted of [false, true]) test(`G6 cold restart preserves ${interrupted ? 'an uncertain continuation intent without replay' : 'an unsubmitted original for explicit continuation'}`, async t => {
  const first = await integratedFixture(t, answer, { evidenceName: 'overflow-before.json' }), agent = await first.main('overflow-restart'), root = first.repo.get('tree_nodes', first.repo.rootId());
  first.repo.transaction(() => { for (let n = 0; n < 2000; n++) first.repo.save('tree_nodes', { ...root, id: `restart-${n}`, parentId: root.id, name: `事项${n}` }); });
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '原话在重启后仍可核对。' }] })); await agent.whenIdle(); await first.runtime.idle();
  const pending = first.runtime.attribution.capacity(agent.session.id).pending[0], context = { sessionId: agent.session.id, actor: { kind: 'user', id: first.repo.userId }, signal: new AbortController().signal };
  const payload = { requestId: 'continue-after-restart', nodeId: 'restart-0', pendingId: pending.id, expectedTreeRevision: first.repo.meta().treeRevision, expectedSelectionRevision: 0 };
  if (interrupted) {
    agent.send = () => { throw new Error('Synthetic interruption after durable intent and before native append'); };
    await assert.rejects(first.runtime.ui.dispatch('session.selectBranch', payload, context), /Synthetic interruption/);
    assert.equal(first.runtime.attribution.capacity(agent.session.id).pending[0].state, 'dispatch_intent');
  }
  assert.equal(first.requests.length, 0); await first.shutdown();
  const second = await integratedFixture(t, answer, { root: first.root, evidenceName: 'overflow-after.json' });
  await second.runtime.recover(); const resumed = await second.main('overflow-restart', async () => {}, true); await resumed.whenIdle(); await second.runtime.idle();
  assert.equal(second.requests.length, 0); assert.match(second.runtime.attribution.capacity(resumed.session.id).pending[0].text, /重启后/);
  if (interrupted) {
    assert.equal((await second.runtime.ui.dispatch('session.selectBranch', payload, context)).state, 'unknown');
    await assert.rejects(second.runtime.ui.dispatch('session.selectBranch', { ...payload, requestId: 'new-click', expectedSelectionRevision: 1 }, context), { code: 'CONTINUATION_UNAVAILABLE' });
    assert.equal(second.requests.length, 0);
  } else {
    assert.equal((await second.runtime.ui.dispatch('session.selectBranch', payload, context)).state, 'success');
    await resumed.whenIdle(); await second.runtime.idle();
    assert.deepEqual(second.requests.map(r => r.role), ['attribution', 'main', 'learning']);
    assert.equal(second.repo.list('tree_turns')[0].status, 'settled');
    assert.equal(second.runtime.attribution.capacity(resumed.session.id).pending.length, 0);
  }
});

test('B7 native learning records corrections and categories without extracting extra observations', async t => {
  let phase = 1;
  const blank = () => ({ proposals: [], firstResults: [], proposalResponses: [], resultFeedback: [], confirmedDecisions: [] });
  const f = await integratedFixture(t, row => {
    if (row.role === 'main') return phase === 1 ? '建议增加一张清单。结果甲：摘要草稿。结果乙：详细表格。' : '已记录本轮反馈。';
    if (row.role !== 'learning') return answer(row);
    const user = row.input.sources.find(s => s.role === 'user' && s.origin === 'user' && row.input.currentTurn.sourceIds.includes(s.id));
    const assistant = row.input.sources.find(s => s.role === 'assistant' && row.input.currentTurn.sourceIds.includes(s.id));
    if (phase === 1) return { ...emptyLearning(), correctionClaim: { kind: 'understanding', quote: { sourceId: user.id, text: '我纠正之前的要求：先给整体说明和详细表格。' } }, understandings: [{ content: '用户不要细节（合成错误推断）', source: 'assistant_inferred', sourceIds: [user.id] }],
      observations: { ...blank(), proposals: [{ sourceId: assistant.id, text: '建议增加一张清单。' }], firstResults: ['结果甲：摘要草稿。', '结果乙：详细表格。'].map(text => ({ sourceId: assistant.id, text })) } };
    if (phase === 2) {
      const old = row.input.knownItems.find(i => i.kind === 'understanding');
      return { ...emptyLearning(), understandings: [{ content: '纠正此前误读：用户要先整体后细节', source: 'user_expressed', sourceIds: [user.id] }],
        revisions: [{ targetId: old.id, targetVersion: old.version, mark: 'invalid', replacedByIndex: 0, sourceIds: [user.id], correctionEvidence: { scope: 'local', quotes: [{ sourceId: user.id, text: '我没说不要细节，是先整体后细节。' }] } }],
        categories: [{ category: 'redo', note: '乙需要重做', sourceId: user.id, subjectIds: [] }, { category: 'proceeded', note: '甲继续推进', sourceId: user.id, subjectIds: [] }, { category: 'adopted_proposal', note: '明确接受清单建议', sourceId: user.id, subjectIds: [] }] };
    }
    return { ...emptyLearning(), observations: blank() };
  });
  const agent = await f.main('semantic-bindings');
  await f.turn(agent, '我纠正之前的要求：先给整体说明和详细表格。');
  const old = f.repo.list('tree_items', i => i.kind === 'understanding')[0], original = f.repo.get('tree_item_versions', digest(['item_version', old.id, 1]));
  assert.equal(f.runtime.metrics.freeze().observations.unresolvedProposals, 0);
  assert.equal(f.runtime.metrics.freeze().observations.rates.firstPass.value, null);
  phase = 2; const corrected = await f.turn(agent, '我没说不要细节，是先整体后细节。采用你建议的清单。甲可以继续下一步。乙需要重做。');
  assert.equal(f.repo.get('tree_items', old.id).lifecycle, 'invalid');
  assert.deepEqual(f.repo.get('tree_item_versions', original.id), original);
  const replacement = f.repo.get('tree_items', f.repo.get('tree_items', old.id).replacedBy), version = f.repo.get('tree_item_versions', digest(['item_version', replacement.id, 1]));
  assert.equal(version.sourceKind, 'user_expressed'); assert.deepEqual(version.sourceRefs, corrected.userSourceRefs);
  const metrics = f.runtime.metrics.freeze().observations;
  assert.equal(metrics.rates.adoption.value, null); assert.equal(metrics.rates.adoption.denominator, 0);
  assert.equal(metrics.rates.firstPass.value, null); assert.equal(metrics.rates.firstPass.denominator, 0);
  assert.equal(f.repo.meta().progressEvidence[corrected.id].confirmedOutputs.length, 0);
  assert.equal(f.repo.meta().progressEvidence[corrected.id].confirmedDecisions.length, 0);
  assert.deepEqual(f.repo.list('tree_signals').map(signal => signal.category).sort(), ['adopted_proposal', 'proceeded', 'redo']);
  phase = 3; const later = await f.turn(agent, '收到。');
  assert.equal(f.repo.meta().progressEvidence[later.id].confirmedOutputs.length, 0);
  assert.equal(f.runtime.metrics.freeze().observations.rates.firstPass.denominator, 0);
  assert.deepEqual(f.requests.map(r => r.role), ['attribution', 'main', 'learning', 'attribution', 'main', 'learning', 'attribution', 'main', 'learning']);
  assert.equal(f.repo.list('tree_jobs', j => j.role === 'learning' && j.status === 'committed').length, 3);
});

for (const boundary of ['prepared', 'submitted', 'result_received', 'committed']) test(`B7 E04 fresh native host reopens ${boundary} learning with exactly-once effects`, async t => {
  const classify = row => row.role === 'learning' ? { ...emptyLearning(), categories: [{ category: 'approved', note: '合成固定反馈', sourceId: row.input.currentTurn.sourceIds.find(id => row.input.sources.some(s => s.id === id && s.role === 'user' && s.origin === 'user')), subjectIds: [] }] } : answer(row);
  const first = await integratedFixture(t, classify, { evidenceName: 'before-restart.json' });
  // Stop the scheduler before its next append, not the host's main loop.
  first.runtime.scanOne = async () => false;
  const agent = await first.main('restart-main'), turn = await first.turn(agent, '合成重启验证：这一点很好。');
  const job = first.runtime.learning.enqueue(turn.id, turn.nodeIds[0]);
  first.jobs.prepare(job.id);
  if (boundary === 'submitted') first.jobs.submit(job.id);
  else if (boundary === 'result_received') {
    const validate = first.jobs.validate.bind(first.jobs);
    first.jobs.validate = id => { if (id === job.id) throw new Error('Synthetic crash before validation'); return validate(id); };
    await first.owner.run(job.id);
  } else if (boundary === 'committed') await first.owner.run(job.id);
  assert.equal(first.jobs.get(job.id).status, boundary);
  const beforeRequests = first.requests.length;
  await first.shutdown();
  const restarted = await integratedFixture(t, classify, { root: first.root, evidenceName: 'after-restart.json' });
  await restarted.transport.recover({ exclusive: true });
  await restarted.runtime.recover(); await restarted.runtime.idle();
  const state = restarted.jobs.get(job.id);
  // A job submitted without a released request is resolved as not sent and
  // its turn is learned once by a fresh job.
  assert.equal(state.status, boundary === 'submitted' ? 'failed' : 'committed');
  if (boundary === 'submitted') {
    assert.equal(state.error.code, 'LEARNING_INTERRUPTED'); assert.equal(state.notSent, true);
    const retried = restarted.repo.list('tree_jobs', j => j.role === 'learning' && j.trigger.turnId === turn.id && j.id !== job.id);
    assert.deepEqual(retried.map(j => j.status), ['committed']);
  }
  assert.equal(restarted.requests.filter(r => r.role === 'learning').length, ['prepared', 'submitted'].includes(boundary) ? 1 : 0);
  const signals = restarted.repo.list('tree_signals').length, sequence = restarted.repo.list('tree_learning_sessions')[0].appendSeq;
  assert.equal(signals, 1); assert.equal(sequence, 1);
  await restarted.runtime.recover(); await restarted.runtime.idle();
  assert.equal(restarted.repo.list('tree_signals').length, signals);
  assert.equal(restarted.repo.list('tree_learning_sessions')[0].appendSeq, sequence);
  const allRequests = [...first.requests, ...restarted.requests];
  assert.equal(allRequests.filter(r => r.role === 'main').length, 1);
  assert.equal(allRequests.filter(r => r.role === 'learning').length, 1);
  const attributionCalls = allRequests.filter(r => r.role === 'attribution').length;
  assert.ok(attributionCalls <= 1);
  // Under full-suite CPU load the 12s attribution guard may cancel before
  // dispatch. That valid fallback must not obscure the recovery assertion.
  if (attributionCalls === 0) {
    const attribution = restarted.repo.list('tree_jobs', j => j.role === 'attribution')[0];
    assert.equal(attribution.status, 'cancelled');
    assert.equal(attribution.cancellationReason, 'ATTRIBUTION_DEADLINE');
    assert.equal(attribution.invocationIds.length, 0);
  }
  assert.equal(restarted.requests.length + beforeRequests, 2 + attributionCalls);
  assert.equal(restarted.repo.list('tree_turns').length, 1);
});

test('B7 E03 native cancellation releases admission and retains uncertain cost without learning or replay', async t => {
  let release, entered;
  const gate = new Promise(r => { release = r; }), dispatched = new Promise(r => { entered = r; });
  let hold = true;
  const f = await integratedFixture(t, async row => {
    if (row.role === 'main' && hold) { entered(); await gate; }
    return answer(row);
  });
  const agent = await f.main('cancel-main'), pending = f.turn(agent, '合成中途取消的委托。');
  await dispatched;
  agent.cancel({ kind: 'user', message: '合成用户明确取消' }, { keepInbox: false });
  hold = false; release();
  const cancelled = await pending;
  assert.equal(cancelled.status, 'interrupted');
  assert.equal(f.repo.list('tree_jobs', j => j.role === 'learning').length, 0);
  const uncertain = f.ledger.list().filter(r => r.status === 'unknown'); assert.equal(uncertain.length, 1);
  const reservation = uncertain[0].reservedMicroCny; assert.ok(reservation > 0);
  const later = await f.turn(agent, '这是取消之后新的合成委托。');
  assert.equal(later.status, 'settled');
  assert.deepEqual(f.requests.map(r => r.role), ['attribution', 'main', 'attribution', 'main', 'learning']);
  assert.equal(f.ledger.get(uncertain[0].requestId).reservedMicroCny, reservation);
  assert.equal(f.repo.list('tree_jobs', j => j.role === 'learning' && j.status === 'committed').length, 1);
  assert.equal(f.runtime.mainAdmissions.size, 0);
});

test('B7 E04 restart cancels a known-unsent main intent and keeps original user evidence', async t => {
  const first = await integratedFixture(t, answer, { evidenceName: 'unsent-before-restart.json' }), submit = first.jobs.submit.bind(first.jobs);
  first.jobs.submit = id => { if (first.jobs.get(id).role === 'main') throw new Error('Synthetic stop before main submit'); return submit(id); };
  const agent = await first.main('unsent-main'), turn = await first.turn(agent, '这个合成委托尚未发送到主模型。');
  const job = first.repo.list('tree_jobs', j => j.role === 'main')[0]; assert.equal(job.status, 'prepared');
  assert.equal(first.requests.filter(r => r.role === 'main').length, 0);
  const refs = turn.userSourceRefs;
  await first.shutdown();
  const second = await integratedFixture(t, answer, { root: first.root, evidenceName: 'unsent-after-restart.json' });
  await second.transport.recover({ exclusive: true }); await second.runtime.recover(); await second.runtime.idle();
  assert.equal(second.jobs.get(job.id).status, 'cancelled'); assert.equal(second.jobs.get(job.id).error.code, 'UNSENT_RESTART');
  assert.equal(second.requests.length, 0); assert.deepEqual(second.repo.get('tree_turns', turn.id).userSourceRefs, refs);
  assert.ok(refs.every(ref => second.runtime.resolveSource(ref)?.origin === 'user'));
  const fresh = await second.main('new-after-unsent'); assert.equal((await second.turn(fresh, '这是重启后的新委托。')).status, 'settled');
  assert.deepEqual(second.requests.map(r => r.role), ['attribution', 'main', 'learning']);
});

test('B7 E03 cancellation while waiting for admission removes the waiter and sends no attribution', async t => {
  let entered, release, hold = true;
  const dispatched = new Promise(r => { entered = r; }), gate = new Promise(r => { release = r; });
  const f = await integratedFixture(t, async row => { if (row.role === 'attribution' && hold) { entered(); await gate; } return answer(row); });
  const a = await f.main('admission-first'), b = await f.main('admission-cancelled');
  const first = f.turn(a, '第一个合成委托。'); await dispatched;
  b.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'NEVER_SEND_CANCELLED_INPUT' }] }));
  const deadline = Date.now() + 2000;
  while (!f.runtime.admissions.waiters.length && Date.now() < deadline) await new Promise(r => setTimeout(r, 1));
  assert.equal(f.runtime.admissions.waiters.length, 1);
  b.cancel({ kind: 'user', message: '取消排队中的合成输入' }, { keepInbox: false }); await b.whenIdle();
  const remainingSlots = f.runtime.requestSlots.active;
  hold = false; release(); await first;
  assert.equal(remainingSlots, 1); // the cancelled turn's settlement may itself queue, but owns no request slot
  assert.equal(JSON.stringify(f.requests).includes('NEVER_SEND_CANCELLED_INPUT'), false);
  const later = await f.turn(b, '排队取消后新的合成输入。'); assert.equal(later.status, 'settled');
  assert.equal(f.runtime.requestSlots.active, 0); assert.equal(f.runtime.admissions.active, 0);
});

test('B7 actual business/agent entry points select the separate tree, owned provider and no legacy writers', async t => {
  const f = await bootstrapFixture(t, answer), agent = await f.main('bootstrap-main');
  const turn = await f.turn(agent, '只使用合成资料验证新入口。');
  assert.equal(turn.status, 'settled', JSON.stringify({ jobs: f.repo.list('tree_jobs'), events: agent.session.snapshotEvents() }));
  assert.deepEqual(f.requests.map(r => r.role), ['attribution', 'main', 'learning']);
  for (const service of ['arcfoldBridge', 'arcfoldMethods', 'arcfoldWork', 'arcfoldLearn']) assert.equal(f.ctx.get(service), undefined);
  assert.equal(existsSync(join(f.root, 'legacy.sqlite')), false);
  assert.equal(f.ctx.arcfoldTreeMode.enabled, true);
  const mainBody = JSON.stringify(f.requests.find(r => r.role === 'main').body);
  assert.ok(mainBody.includes('evidence') && mainBody.includes('expectedRevision'));
});

test('B7 actual root filesystem, shell, compaction and working-directory providers compose without legacy writers', async t => {
  const f = await bootstrapFixture(t, answer, { nativeHost: true });
  for (const name of ['fs', 'shell', 'compaction', 'workingDirectory', 'arcfoldTreeRuntime']) assert.ok(f.ctx.get(name), name);
  for (const name of ['arcfoldBridge', 'arcfoldLearning', 'arcfoldPreparation', 'goalRoundDriver']) assert.equal(f.ctx.get(name), undefined, name);
  assert.equal(f.ctx.fs.constructor.name, 'ProtectedFileSystem');
  assert.equal(f.ctx.shell.constructor.name, 'ProtectedBash');
  assert.equal(f.ctx.compaction.constructor.name, 'MainCompaction');
  assert.equal(f.ctx.workingDirectory.defaultDirectory, f.workspace);
  assert.equal(f.requests.length, 0); assert.equal(existsSync(join(f.root, 'legacy.sqlite')), false);
});

test('B7 native tool before/after hooks deny bodies and retain admitted context inside the same turn', async t => {
  let mode = 'seed', bodies = 0, mainSteps = 0;
  const f = await integratedFixture(t, row => {
    if (row.role !== 'main') return answer(row);
    if (mode === 'seed') return '先建立真实来源。';
    return ++mainSteps === 1 ? { tool: { id: 'native-synthetic-call', name: 'synthetic_action', args: {} } } : '已按实际结果停止。';
  });
  const agent = await f.main('hook-tools', async ctx => ctx.tools.register(defineTool({ name: 'synthetic_action', description: 'Synthetic body counter', parameters: {},
    output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: 'completed' }] }, execute: () => { bodies++; return { ok: true }; } })));
  const seed = await f.turn(agent, '合成工具的前置检查。');
  addHooks(f, seed, [{ moment: 'before_tool', conditions: [{ field: 'toolName', op: 'equals', value: 'synthetic_action' }], action: 'block', message: '这次合成操作必须阻止' }]);
  mode = 'blocked'; const blocked = await f.turn(agent, '尝试受禁止的合成操作。');
  assert.equal(bodies, 0); assert.equal(blocked.status, 'settled');
  const result = agent.session.snapshotEvents().find(e => e.type === 'tool/result' && e.data.message.toolCallId === 'native-synthetic-call');
  assert.equal(result.data.message.isError, true);
  assert.ok(f.repo.list('tree_hook_runs', r => r.logicalTurnId === blocked.logicalTurnId && r.result.action === 'block').length);
  assert.equal(agent.session.snapshotEvents().filter(e => e.type === 'turn/start').length, 2);
});

test('B7 five native stop checks merge into one steer, then stop at the second consecutive failure', async t => {
  const f = await integratedFixture(t, answer), agent = await f.main('native-hook-stop');
  const seed = await f.turn(agent, '合成同轮补做规则的来源。');
  addHooks(f, seed, Array.from({ length: 5 }, (_, n) => ({ moment: 'turn_end', conditions: [], action: 'continue', message: `补做合成项${n + 1}` })));
  const before = f.requests.length, turn = await f.turn(agent, '本轮检查没有补做。');
  const requests = f.requests.slice(before);
  assert.deepEqual(requests.map(r => r.role), ['attribution', 'main', 'main', 'learning']);
  assert.equal(turn.status, 'settled');
  const continuations = Object.values(f.repo.meta().hookContinuations).filter(c => f.repo.get('tree_hook_runs', c.runIds[0]).logicalTurnId === turn.logicalTurnId);
  assert.equal(continuations.length, 1); assert.equal(continuations[0].runIds.length, 5);
  assert.equal(agent.session.snapshotEvents().filter(e => e.type === 'turn/start').length, 2);
});

test('B7 E01/E05 thirty logical turns, three goals, two native sessions and real compaction preserve current owned scope', async t => {
  const f = await integratedFixture(t, (row, native) => {
    if (row.role === 'attribution') {
      const label = row.input.sources.filter(s => s.origin === 'user').at(-1).text.match(/事项([ABC])/)[1];
      const node = native.repo.list('tree_nodes', n => n.name === '事项' + label)[0];
      return { actions: [node ? { action: 'switch', nodeId: node.id } : { action: 'create_child', parentId: native.repo.rootId(), name: '事项' + label }], statusChanges: [] };
    }
    if (row.role === 'learning') {
      if (row.input.knownItems.some(i => i.kind === 'understanding')) return emptyLearning();
      const label = native.repo.get('tree_nodes', row.input.scope.nodeIds[0]).name.at(-1);
      const user = row.input.sources.find(s => s.origin === 'user' && row.input.currentTurn.sourceIds.includes(s.id));
      return { ...emptyLearning(), correctionClaim: { kind: 'understanding', quote: { sourceId: user.id, text: '我纠正之前的要求' } }, understandings: [{ content: 'SCOPE_PRIVATE_' + label + '：材料已完成（合成错误推断）', source: 'assistant_inferred', sourceIds: [user.id] }] };
    }
    if (row.role === 'verification') {
      const target = row.input.knownItems.find(i => i.kind === 'understanding' && i.version === 1 && i.nodeId === row.input.scope.nodeIds[0]);
      if (!target) return emptyVerification();
      const evidence = row.input.effects.filter(e => e.itemVersions.some(v => v.itemId === target.id && v.version === target.version))
        .flatMap(e => e.input).filter(s => s.text.includes('仍在进行')).map(s => s.id);
      return { ...emptyVerification(), operations: [{ op: 'rewrite', targetId: target.id, targetVersion: target.version, stage: 'generate',
        reason: '合成学习输出错误地将材料判为完成，后续原话仍在进行', evidence,
        detail: { replacement: { content: target.content.split('：')[0] + '：材料仍在进行', source: 'user_expressed', sourceIds: evidence } } }] };
    }
    if (row.role === 'improvement') return { same: true, diagnosis: '两个独立目标的学习均无据判为完成', kind: 'universal', supplements: [], parameters: [],
      report: { step: 'learning', problem: '学习把材料出现误判为完成', evidence: row.input.sources.map(s => s.id),
        whyUniversal: '不依赖个人表达习惯，完成需要明确依据', stopgap: '保留未完成状态', suggestedFix: '学习输出前核对明确完成依据' } };
    if (row.role === 'consolidation') return summary();
    return '已收到这条合成信息。';
  });
  const first = await f.main('scope-main-one'), second = await f.main('scope-main-two');
  for (let n = 0; n < 3; n++) await f.turn(first, `事项${'ABC'[n]}：我纠正之前的要求，合成材料${'原文保留。'.repeat(80)}`);
  for (let n = 3; n < 29; n += 2) await Promise.all([
    f.turn(first, `事项${'ABC'[n % 3]}：第${n + 1}条合成材料，仍在进行。`),
    f.turn(second, `事项${'ABC'[(n + 1) % 3]}：第${n + 2}条合成材料，仍在进行。`),
  ]);
  await f.turn(second, '事项C：第30条合成材料，仍在进行。');
  assert.equal(f.repo.list('tree_turns', r => r.status === 'settled').length, 30, JSON.stringify(f.repo.meta().runtimeDiagnostics));
  assert.equal(f.repo.list('tree_nodes').length, 4);
  assert.equal(f.repo.list('tree_jobs', j => j.role === 'learning' && j.status === 'committed').length, 30);
  assert.equal(f.requests.filter(r => r.role === 'attribution').length, 30);
  assert.equal(f.requests.filter(r => r.role === 'main').length, 30);
  const improvements = f.repo.list('tree_jobs', j => j.role === 'improvement');
  assert.equal(improvements.filter(j => j.status === 'committed').length, 1, JSON.stringify(improvements));
  assert.ok(improvements[0].input.repairs.length >= 2);
  assert.ok(new Set(improvements[0].input.repairs.flatMap(r => r.nodeIds)).size >= 2);
  const report = f.repo.get('tree_reports', improvements[0].resultRef.reportId);
  assert.equal(report.status, 'unhandled'); assert.deepEqual(report.exportAudit, []);
  assert.equal(f.repo.list('tree_repairs').length, 3);
  for (const row of f.requests.filter(r => r.role === 'main')) {
    const text = JSON.stringify(row.body.messages), segments = row.body.messages.flatMap(m => m.content ?? []).flatMap(b => {
      if (b.type !== 'text') return []; try { return [JSON.parse(b.text)]; } catch { return []; }
    });
    const current = segments.findLast(s => s.logicalTurnId)?.nodes[0].id;
    assert.ok(current); const label = f.repo.get('tree_nodes', current).name.at(-1);
    for (const other of 'ABC') if (other !== label) assert.equal(text.includes('SCOPE_PRIVATE_' + other), false, `Brother ${other} leaked into ${label}`);
  }
  await active(await f.ctx.plugin(TokenMeter));
  const Compactor = ownedCompactionClass(BasicCompaction, { appendPluginRecord, summarize: (input, agent, signal) => f.runtime.summarizeNative(input, agent, signal) });
  await active(await f.ctx.plugin(Compactor, { retainTokens: 256 }));
  const compacted = await f.ctx.compaction.compactNow(first, new AbortController().signal, 'synthetic-b7-compaction');
  assert.ok(compacted);
  const compaction = f.repo.list('tree_jobs', j => j.trigger?.nativeCompaction)[0];
  assert.equal(compaction.status, 'committed');
  assert.equal(JSON.stringify(compaction.input).includes('SCOPE_PRIVATE_'), false);
  await f.turn(first, '事项A：压缩后回到A。');
  const last = JSON.stringify(f.requests.filter(r => r.role === 'main').at(-1).body);
  assert.equal(last.includes('SCOPE_PRIVATE_B'), false); assert.equal(last.includes('SCOPE_PRIVATE_C'), false); assert.ok(last.includes('SCOPE_PRIVATE_A'));
  for (const row of f.requests) assert.ok([...f.runtime.tokenCounter.cache.values()].some(reading => reading.wireHash === digest(row.body) && reading.tokens <= 128000), 'Every actual wire body has an exact offline measurement');
});

for (const succeeds of [true, false]) test(`B7 E06 exact learning pressure ${succeeds ? 'replaces an epoch and retains three turns' : 'retains originals and pauses after a failed summary'}`, async t => {
  const f = await integratedFixture(t, row => row.role === 'consolidation' ? (succeeds ? summary() : 'broken synthetic JSON') : answer(row));
  const agent = await f.main('pressure-main');
  let attempted = 0;
  for (; attempted < 12; attempted++) {
    const turn = await f.turn(agent, `合成长资料第${attempted + 1}轮：${'材料保留。'.repeat(700)}`);
    assert.equal(turn.status, 'settled');
    if (f.repo.list('tree_jobs', j => j.role === 'consolidation').length) { attempted++; break; }
  }
  const summaries = f.repo.list('tree_jobs', j => j.role === 'consolidation'); assert.equal(summaries.length, 1);
  const job = summaries[0], state = f.repo.list('tree_learning_sessions')[0];
  const deferred = f.repo.list('tree_jobs', j => j.role === 'learning' && j.error?.code === 'LEARNING_PRESSURE');
  assert.equal(deferred.length, 1); assert.equal(deferred[0].submittedAt, undefined); assert.deepEqual(deferred[0].invocationIds, []);
  const readings = Object.values(f.repo.meta().runtimeDiagnostics).filter(d => d.kind === 'learning_pressure');
  assert.ok(readings[0].measurement.tokens > 128000); assert.equal(readings[0].measurement.limit, 128000);
  const original = await f.owner.readEvents(deferred[0].nativeSessionId);
  assert.ok(original.some(e => e.type === 'user/message' && e.data.source?.kind === 'arcfold/tree-job'));
  assert.equal(original.some(e => e.type === 'user/message' && e.data.source?.jobId === deferred[0].id), false);
  if (succeeds) {
    assert.equal(job.status, 'committed'); assert.equal(state.contextEpoch, 2); assert.equal(state.paused, false);
    assert.equal(state.recentJobIds.length, 3); assert.deepEqual(state.recentJobIds, job.input.summaryPlan.recentJobIds);
    assert.equal(f.repo.list('tree_jobs', j => j.role === 'learning' && j.status === 'committed').length, attempted);
    assert.notEqual(state.sessionId, deferred[0].nativeSessionId);
  } else {
    assert.equal(job.status, 'invalid_output'); assert.equal(state.contextEpoch, 1); assert.equal(state.paused, true);
    const count = f.requests.length; await f.runtime.idle(); await f.runtime.idle(); assert.equal(f.requests.length, count);
    assert.equal(f.repo.list('tree_turns').filter(t => t.status === 'settled').length, attempted);
  }
  const requests = f.requests.length;
  f.runtime.handlePressure(deferred[0]); f.runtime.handlePressure(deferred[0]);
  assert.equal(f.repo.list('tree_learning_sessions')[0].paused, !succeeds);
  assert.equal(f.repo.list('tree_jobs', j => j.role === 'consolidation').length, 1);
  assert.equal(f.requests.length, requests);
});

test('B7 E06 official full-request tokenizer measures actual 127K/129K and model-cap boundaries', async t => {
  const f = await integratedFixture(t, answer), counter = f.runtime.tokenCounter;
  const options = n => ({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off', maxTokens: 8192,
    messages: [{ role: 'system', content: [{ type: 'text', text: '固定合成系统要求。' }] }, { role: 'user', content: [{ type: 'text', text: 'a '.repeat(n) }] }],
    tools: [{ name: 'synthetic_read', description: '合成工具的完整说明', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }] });
  const base = await counter.prepare(options(100));
  for (const target of [127000, 129000]) {
    const input = options(target - base.tokens + 100), reading = await counter.prepare(input); assert.equal(reading.tokens, target);
    const fullRequest = counter.request(input), pressure = f.runtime.consolidation.pressure({ fullRequest, measure: () => reading, contextWindow: 1000000, maxOutputTokens: 8192 });
    assert.equal(pressure.needsSummary, target > 128000);
    const capped = f.runtime.consolidation.pressure({ fullRequest, measure: () => reading, contextWindow: 200000, maxOutputTokens: 8192 });
    assert.equal(capped.limit, 126272); assert.equal(capped.needsSummary, true);
  }
  assert.equal(f.requests.length, 0); assert.equal(f.ledger.list().length, 0);
});

test('B7 native user input runs attribution, one owned main, durable experience and persistent learning without an extra main turn', async t => {
  const f = await integratedFixture(t, ({ role, input }) => {
    if (role === 'attribution') return { actions: [{ action: 'continue', nodeId: input.scope.nodeIds[0] }], statusChanges: [] };
    if (role === 'learning') return emptyLearning();
    if (role === 'verification') return emptyVerification();
    return '这是完整装配入口的固定合成回答。';
  });
  const agent = await f.main('integrated-main');
  const turn = await f.turn(agent, '这是第一条合成委托。');
  assert.equal(turn?.status, 'settled', JSON.stringify({ jobs: f.repo.list('tree_jobs').map(j => ({ role: j.role, status: j.status, error: j.error })), events: agent.session.snapshotEvents().filter(e => ['turn/end','assistant/attempt'].includes(e.type)), diagnostics: f.repo.meta().runtimeDiagnostics }));
  assert.deepEqual(f.requests.map(r => r.role), ['attribution', 'main', 'learning']);
  assert.equal(f.repo.list('tree_exposures').length, 1);
  assert.equal(f.repo.list('tree_jobs', j => j.role === 'main')[0].status, 'committed');
  assert.equal(f.repo.list('tree_jobs', j => j.role === 'learning')[0].status, 'committed');
  assert.equal(agent.session.snapshotEvents().filter(e => e.type === 'turn/start').length, 1);
  assert.equal(f.repo.list('tree_snapshots', s => s.logicalTurnId === turn.id).length, 1);
  assert.equal(f.requests.find(r => r.role === 'main').body.tools.length, 6, 'five tree tools plus arcfold_revise_goal');
  const again = await f.turn(agent, '继续同一个合成委托。');
  assert.equal(again.nativeTurn, 2); assert.equal(f.requests.length, 6);
  assert.equal(new Set(f.repo.list('tree_jobs', j => j.role === 'learning').map(j => j.nativeSessionId)).size, 1);
});
