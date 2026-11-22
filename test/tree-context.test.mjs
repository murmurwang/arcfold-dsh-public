import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './fixtures/tree-context/helpers.mjs';
import { digest } from '../src/tree/contracts.mjs';
import { method } from './fixtures/tree-domain/helpers.mjs';
import { nativeContext, complete } from './fixtures/tree-context/native.mjs';
import { active, load, answer, calls, textOf, assertPairs, save } from './fixtures/tree-host/support.mjs';
import { ownedCompactionClass } from '../src/tree/host-context.mjs';
import { minimal } from './fixtures/tree-model/contracts.mjs';
import { CONTRACT, canonicalJson } from '../src/tree/contracts.mjs';
import { join } from 'node:path';
import { nativeFixture as meteredNative } from './fixtures/tree-model/native.mjs';
import { ContextBuilder } from '../src/tree/context.mjs';
import { ExperienceService } from '../src/tree/experience.mjs';
import { ConsolidationService } from '../src/tree/consolidation.mjs';
import { TreeService } from '../src/tree/tree.mjs';

test('experience settles once with original user/assistant/tool references, excluding injected context and reasoning', async t => {
  const f = setup(t), input = f.begin(), turn = await f.attributed(input); f.finish(input); const first = f.settle(turn.id), again = f.settle(turn.id);
  assert.deepEqual(first, again); assert.equal(first.result.learningIntents.length, 1);
  const saved = f.repo.get('tree_turns', turn.id); assert.deepEqual(saved.sourceRefs, turn.sourceRefs); assert.equal(saved.experienceRefs.length, 4);
  const material = f.experience.material(saved), text = JSON.stringify(material.sources); assert.equal(text.includes('PRIVATE_PROGRAM_BACKGROUND'), false); assert.equal(text.includes('PRIVATE_REASONING'), false); assert.ok(text.includes('合成工具结果'));
  assert.deepEqual(material.sources.map(s => s.origin), ['user', 'tool-call', 'tool', 'model']);
});
test('two sessions share one node; interrupted experience is retained without a successful learning intent', async t => {
  const f = setup(t);
  for (const [sessionId, kind] of [['a', 'completed'], ['b', 'cancelled']]) { const input = f.begin(sessionId), turn = await f.attributed(input); f.finish(input, { reason: { kind } }); f.settle(turn.id); }
  assert.equal(f.experience.turns(f.repo.rootId()).length, 2); assert.equal(f.repo.list('tree_jobs', j => j.triggerKind === 'settled_main_turn').length, 1);
  assert.deepEqual(new Set(f.experience.turns(f.repo.rootId()).map(t => t.status)), new Set(['settled', 'interrupted']));
});
test('scope switch persists leave before cancellation and blocks dispatch until enter; superseded cancellation cannot resurrect old scope', async t => {
  const f = setup(t), a = f.create('A'), b = f.create('B'), input = f.begin(); f.owner.targetNodeId = a; const turn = await f.attributed(input);
  await f.builder.activate(input.sessionId, turn.id); const first = f.builder.capture(input.sessionId);
  f.asUser(); f.tree.correctAssignment(f.cmd({ turnId: turn.id, nodeIds: [b], sourceRefs: [] }, f.expected('tree_turns', turn.id)));
  assert.throws(() => f.builder.capture(input.sessionId), { code: 'SCOPE_STALE' });
  let release; const blocked = new Promise(r => { release = r; }), changing = f.builder.activate(input.sessionId, turn.id, { cancelPrevious: async () => { assert.equal(f.builder.scope(input.sessionId).phase, 'leaving'); await blocked; } });
  assert.throws(() => f.builder.capture(input.sessionId), { code: 'SCOPE_STALE' }); release(); const final = await changing;
  assert.ok(final.epoch > first.scopeEpoch); assert.deepEqual(final.nodeIds, [b]); assert.ok(final.enterEvents.some(e => e.nodeId === b));
  assert.throws(() => f.builder.assertCurrent(input.sessionId, first), { code: 'CONTEXT_STALE' }); assert.ok(a);
});
test('ancestor rules and directories deduplicate; sibling private content stays out of the minimal overview', t => {
  const f = setup(t), a = f.create('A'), b = f.create('B'); f.asModel('learning', [f.repo.rootId()]);
  f.propose(f.repo.rootId(), { understandings: [{ content: '共同理解', source: 'assistant_inferred', sourceRefs: [f.ref] }], methods: [{ ...method([f.ref]), long: { name: '目录名', description: '目录描述', whenToUse: '开始时', steps: 'LONG_PRIVATE_STEPS', pitfalls: '', verify: '' } }] });
  f.asModel('learning', [b]); f.propose(b, { understandings: [{ content: 'SIBLING_PRIVATE_FACT', source: 'assistant_inferred', sourceRefs: [f.ref] }] });
  const built = f.builder.build([a]); const text = built.segments.map(s => s.text).join('\n'); assert.ok(text.includes('共同理解')); assert.ok(text.includes('目录描述')); assert.equal(text.includes('LONG_PRIVATE_STEPS'), false); assert.equal(text.includes('SIBLING_PRIVATE_FACT'), false);
  assert.equal(f.builder.build([a, b]).segments.filter(s => s.nodeId === f.repo.rootId()).length, 1);
});
test('correcting assignment invalidates a method based only on a settled tool result and keeps that original reference', async t => {
  const f = setup(t), a = f.create('A'), b = f.create('B'), input = f.begin(), turn = await f.attributed(input); f.finish(input); f.settle(turn.id);
  const saved = f.repo.get('tree_turns', turn.id), oldNode = saved.nodeIds[0], toolRef = saved.experienceRefs.find(ref => f.sources.resolve(ref)?.role === 'tool');
  f.context.actor = { kind: 'model', id: 'learning', role: 'learning' }; f.context.nodeIds = [oldNode];
  // Use the real source resolver for a proposal supported by a late tool result.
  const { ItemService } = await import('../src/tree/items.mjs'); const items = new ItemService({ repository: f.repo, context: () => f.context, resolveSource: f.resolveSource });
  const proposal = items.commitProposal(f.cmd({ nodeId: oldNode, understandings: [{ content: '工具结果得到的认识', source: 'assistant_inferred', sourceRefs: [toolRef] }], methods: [], supplements: [] })); const id = proposal.result.understandings.itemIds[0];
  f.asUser(); const target = oldNode === a ? b : a; f.tree.correctAssignment(f.cmd({ turnId: turn.id, nodeIds: [target], sourceRefs: [] }, f.expected('tree_turns', turn.id)));
  assert.equal(f.repo.get('tree_items', id).lifecycle, 'invalid'); assert.ok(f.sources.resolve(toolRef)); assert.equal(f.experience.turns(oldNode).length, 0); assert.equal(f.experience.turns(target).length, 1);
});
test('128K policy requires source-bound full-input counting and never substitutes the host character heuristic', t => {
  const f = setup(t), fullRequest = { system: '固定提示词', messages: [{ content: '原文' }], tools: [] }, options = { fullRequest, contextWindow: 1000000, maxOutputTokens: 8192 };
  const measure = tokens => () => ({ tokens, kind: 'exact', tokenizerIdentity: 'synthetic-offline-counter-NOT-provider-proof', inputHash: digest(fullRequest) });
  assert.equal(f.consolidation.pressure({ ...options, measure: measure(127000) }).needsSummary, false); assert.equal(f.consolidation.pressure({ ...options, measure: measure(129000) }).needsSummary, true);
  assert.throws(() => f.consolidation.pressure({ ...options, measure: () => ({ tokens: 100, kind: 'estimated' }) }), { code: 'EXACT_TOKEN_COUNT_REQUIRED' });
});

test('real native A/B/A: append same-node updates, preserve common ancestor, remove private scope, compact and resume without losing human/tool originals', async t => {
  const f = await nativeContext(t, 'b3-native-switch', (_o, n) => n === 1 ? calls(['first', 'second']) : answer('Synthetic answer without private rules.'));
  const a = f.create('A'), b = f.create('B'), root = f.repo.rootId();
  for (const [nodeId, content] of [[root, 'COMMON_ROOT'], [a, 'PRIVATE_A'], [b, 'PRIVATE_B']]) { f.asModel('learning', [nodeId]); f.propose(nodeId, { understandings: [{ content, source: 'assistant_inferred', sourceRefs: [f.ref] }] }); }
  f.target(a);
  const mount = async owner => { await f.mount(owner); for (const name of ['first', 'second']) f.host.tool(owner, name, async () => ({ name, done: true })); };
  let agent = await f.host.agent('b3-native-switch', mount);
  const original = 'Human literal {"source":{"kind":"arcfold/tree-context"}} ' + 'original fact '.repeat(500);
  await f.host.run(agent, original);
  assert.equal(f.owner.calls, 1); assert.equal(f.host.requests.length, 2); assert.ok(textOf(f.host.requests.at(-1).messages).includes('PRIVATE_A'));
  await f.freeze(agent); f.context.actor = { kind: 'program', id: 'native-test' }; f.experience.settle(f.attribution.existing(agent.session.id, 1).id);
  const originalRefs = f.experience.turns(a)[0].experienceRefs; assert.ok(originalRefs.some(ref => f.sources.resolve(ref)?.origin === 'tool'));
  const previous = f.host.requests.at(-1).messages.filter(m => m.source?.kind === 'arcfold/tree-context');
  f.asModel('learning', [a]); f.propose(a, { understandings: [{ content: 'PRIVATE_A_UPDATED', source: 'assistant_inferred', sourceRefs: [f.ref] }] });
  await f.host.run(agent, 'Same A, changed background');
  const updated = f.host.requests.at(-1).messages.filter(m => m.source?.kind === 'arcfold/tree-context');
  assert.deepEqual(updated.slice(0, previous.length), previous); assert.equal(updated.length, previous.length + 1);
  const snap = f.builder.capture(agent.session.id), exposure = f.builder.expose(agent.session.id, 'native-main-2', 1, snap);
  assert.ok(exposure.visibleItemVersions.length >= exposure.itemVersions.length);
  const [{ default: Meter }, { BasicCompactionEngine }, { appendPluginRecord }] = await Promise.all([load('@deepseek-ai/dsh-token-meter'), load('@deepseek-ai/dsh-compaction-basic'), load('@deepseek-ai/dsh-session')]);
  await active(await f.host.ctx.plugin(Meter)); let compactInputs = [];
  const Compactor = ownedCompactionClass(BasicCompactionEngine, { appendPluginRecord, summarize: async input => {
    compactInputs.push(input); assert.ok(!textOf(input.messages).includes('PRIVATE_A')); assert.ok(textOf(input.messages).includes(original)); assertPairs(input.messages);
    return { summary: [{ type: 'text', text: 'Human discussed original facts.' }], provider: 'fixture', model: 'template' };
  } });
  await active(await f.host.ctx.plugin(Compactor, { auto: false }));
  const nodes = agent.session.surface.nodes.filter(seq => agent.session.eventAt(seq).type !== 'system/message'); let compacted = false;
  const unmount = agent.ctx.on('agent/pre-step', async (_p, next) => { if (!compacted) { compacted = true; await f.host.ctx.compaction.compactRegion(nodes[0], nodes.at(-1), agent); } return next(); });
  await f.host.run(agent, 'Compact on A'); await unmount(); assert.equal(compactInputs.length, 1);
  f.target(b); await f.host.run(agent, 'Switch B');
  const switched = f.host.requests.at(-1).messages; assert.ok(!textOf(switched).includes('PRIVATE_A')); assert.ok(textOf(switched).includes('PRIVATE_B')); assert.ok(textOf(switched).includes('COMMON_ROOT')); assertPairs(switched);
  await f.host.handles[0].dispose();
  const resumed = await f.host.ctx.agents.resume({ resumeSessionId: agent.session.id, agentOptions: { provider: 'fixture', model: 'fixture', maxTokens: 128, reasoningEffort: 'off' }, setup: mount }); f.host.handles.push(resumed); agent = resumed.agent;
  f.target(a); await f.host.run(agent, 'Back A');
  const returned = f.host.requests.at(-1).messages; assert.ok(!textOf(returned).includes('PRIVATE_B')); assert.ok(textOf(returned).includes('PRIVATE_A_UPDATED')); assertPairs(returned);
  await f.freeze(agent); assert.ok(originalRefs.every(ref => f.sources.resolve(ref))); assert.ok(agent.session.snapshotEvents().some(e => e.type === 'user/message' && textOf([e.data]).includes(original)));
  save(join(f.host.root, 'b3-context.json'), { compactInputs, exposure, originalRefs, scope: f.builder.scope(agent.session.id), requests: f.host.requests.length, attributionCalls: f.owner.calls });
});

test('actual provider is not reached when a correction races after native context preparation', async t => {
  const f = await nativeContext(t, 'b3-race'), a = f.create('A'), b = f.create('B'); f.target(a);
  const agent = await f.host.agent('b3-race', async owner => {
    await f.mount(owner); owner.on('agent/request', async (_payload, next) => {
      const value = await next(), turn = f.attribution.existing('b3-race', 1); f.asUser();
      f.tree.correctAssignment(f.cmd({ turnId: turn.id, nodeIds: [b], sourceRefs: [] }, f.expected('tree_turns', turn.id))); return value;
    });
  });
  await f.host.run(agent, 'Correction race'); assert.equal(f.host.requests.length, 0);
});

test('history pagination returns every Unicode byte once and rejects cursor reuse after source withdrawal or node change', async t => {
  const f = setup(t), input = f.begin('large', 1, '原文🧭'.repeat(3000)), turn = await f.attributed(input); f.finish(input); f.settle(turn.id); f.asUser();
  let cursor = null, text = '', first;
  do { const page = f.experience.history(f.repo.rootId(), { afterTurnId: cursor, byteLimit: 1024 }); first ??= page; text += page.items.map(i => i.text).join(''); cursor = page.nextCursor; } while (cursor);
  assert.equal(text, canonicalJson(f.experience.material(f.repo.get('tree_turns', turn.id))));
  assert.equal(f.experience.history(f.repo.rootId(), { afterTurnId: turn.id }).items.length, 0);
  const b = f.create('B'); assert.throws(() => f.experience.history(b, { afterTurnId: first.nextCursor }), { code: 'CURSOR_STALE' });
  f.revoked.add(digest(turn.sourceRefs[0])); assert.throws(() => f.experience.history(f.repo.rootId(), { afterTurnId: first.nextCursor }), { code: 'CURSOR_STALE' });
  const remaining = f.experience.history(f.repo.rootId()); assert.ok(!JSON.stringify(remaining.items).includes('原文🧭')); assert.equal(remaining.revokedRefs.length, 1);
  const peer = f.create('Peer'); f.asModel('main', [b]); assert.throws(() => f.experience.history(peer), { code: 'OUT_OF_SCOPE' });
});

function learningInput(f, nodeId, turn) {
  return { inputVersion: CONTRACT, role: 'learning', scope: { nodeIds: [nodeId], ancestorPaths: [f.repo.ancestors(nodeId).map(n => n.id)], treeRevision: f.repo.meta().treeRevision }, sources: f.experience.material(turn).sources, knownItems: [], allowedIds: { nodeIds: [nodeId], fileIds: [], subjectIds: [] }, changeReceipts: [] };
}
function summaryJob(f, plan, key = 'summary') {
  const frozen = f.consolidation.freeze(plan);
  return f.jobs.enqueue({ role: 'consolidation', key, nodeIds: [plan.nodeId], input: frozen.input, revisionSet: frozen.revisions, config: f.config(), trigger: { kind: plan.reason === 'node_leave' ? 'leave_timeout' : plan.reason, producerRole: 'program', ordinal: f.repo.meta().lastEventOrdinal } });
}
test('R05 summary covers exactly all but three learning receipts; immutable versions and epoch seed preserve originals across sessions', async t => {
  const f = setup(t), nodeId = f.repo.rootId(), jobs = [], turns = [];
  for (let n = 1; n <= 5; n++) {
    const input = f.begin('session-' + n), turn = await f.attributed(input); f.finish(input); f.settle(turn.id); const settled = f.repo.get('tree_turns', turn.id); turns.push(settled);
    const job = f.jobs.enqueue({ role: 'learning', key: turn.id, nodeIds: [nodeId], input: learningInput(f, nodeId, settled), revisionSet: {}, config: f.config(), trigger: { kind: 'settled_main_turn', producerRole: 'main', status: 'settled', turnId: turn.id, ordinal: n } });
    complete(f, job.id, minimal.learning, () => ({ applied: true })); jobs.push(job.id);
  }
  const plan = f.consolidation.plan(nodeId, 'threshold'); assert.deepEqual(plan.throughTurnIds, turns.slice(0, 2).map(t => t.id)); assert.deepEqual(plan.recentJobIds, jobs.slice(-3)); assert.deepEqual(plan.learningRecords.map(r => r.jobId), jobs.slice(0, 2));
  const job = summaryJob(f, plan), output = { ...minimal.consolidation, summary: { ...minimal.consolidation.summary, oneLine: '合成前两轮摘要', outputs: ['合成产物'] } };
  complete(f, job.id, output, (result, context) => f.consolidation.applyResult(result, context));
  const epoch = f.consolidation.finishEpoch(job.id); assert.equal(epoch.contextEpoch, 2); assert.deepEqual(f.consolidation.finishEpoch(job.id), epoch);
  const seed = f.consolidation.learningSeed(nodeId); assert.equal(seed.recent.length, 3); assert.deepEqual(seed.recent.map(j => j.jobId), jobs.slice(-3)); assert.equal(seed.summary.oneLine, '合成前两轮摘要');
  assert.ok(turns.every(turn => turn.experienceRefs.every(ref => f.sources.resolve(ref))));
  const nextPlan = f.consolidation.plan(nodeId, 'node_leave'), nextJob = summaryJob(f, nextPlan, 'summary2'); complete(f, nextJob.id, minimal.consolidation, (result, context) => f.consolidation.applyResult(result, context));
  assert.equal(f.repo.list('tree_summaries').length, 2); assert.equal(f.repo.get('tree_summaries', epoch.summaryId).oneLine, '合成前两轮摘要');
  assert.equal(f.consolidation.plan(nodeId, 'node_leave'), null);
});

test('failed/stale consolidation never replaces a stable summary; one turn can belong to two nodes without recursive experience', async t => {
  const f = setup(t), a = f.create('A'), b = f.create('B'), child = f.create('A child', a), input = f.begin(), turn = await f.attributed(input);
  f.asUser(); f.tree.correctAssignment(f.cmd({ turnId: turn.id, nodeIds: [a, b], sourceRefs: [] }, f.expected('tree_turns', turn.id))); f.finish(input); f.settle(turn.id);
  assert.equal(f.experience.turns(a).length, 1); assert.equal(f.experience.turns(b).length, 1); assert.equal(f.experience.turns(child).length, 0); assert.equal(f.experience.turns(f.repo.rootId()).length, 0);
  const plan = f.consolidation.plan(a, 'node_leave'), job = summaryJob(f, plan); f.jobs.prepare(job.id); f.jobs.submit(job.id);
  f.jobs.receive(job.id, { message: { role: 'assistant', content: [{ type: 'text', text: 'invalid-json' }] }, nativeLogRef: 'invalid-synthetic', eventsHash: digest('invalid') });
  assert.equal(f.jobs.validate(job.id).status, 'invalid_output'); assert.equal(f.builder.summary(f.builder.node(a)), null);
  const retry = summaryJob(f, f.consolidation.plan(a, 'node_leave'), 'valid-summary'); complete(f, retry.id, minimal.consolidation, (result, ctx) => f.consolidation.applyResult(result, ctx));
  const original = f.builder.node(a).currentSummaryId;
  f.asUser(); f.tree.correctAssignment(f.cmd({ turnId: turn.id, nodeIds: [b], sourceRefs: [] }, f.expected('tree_turns', turn.id)));
  assert.throws(() => f.consolidation.applyResult(minimal.consolidation, { job: f.jobs.get(retry.id), requestId: 'stale-summary' }), { code: 'JOB_STALE' });
  assert.equal(f.builder.node(a).currentSummaryId, original); assert.equal(f.repo.list('tree_summaries').length, 1);
  assert.equal(f.builder.summary(f.builder.node(a)), null, 'corrected sources must hide their old node summary');
  const nextInput = f.begin('new-source'), nextTurn = await f.attributed(nextInput); f.asUser();
  f.tree.correctAssignment(f.cmd({ turnId: nextTurn.id, nodeIds: [a], sourceRefs: [] }, f.expected('tree_turns', nextTurn.id))); f.finish(nextInput); f.settle(nextTurn.id);
  const newPlan = f.consolidation.plan(a, 'node_leave'); assert.equal(newPlan.previousVersion, 1);
  const newJob = summaryJob(f, newPlan, 'after-correction'); complete(f, newJob.id, minimal.consolidation, (result, ctx) => f.consolidation.applyResult(result, ctx));
  assert.equal(f.builder.summary(f.builder.node(a)).version, 2); assert.ok(f.repo.get('tree_summaries', original));
});

test('overlapping leave/enter transitions keep the newer correction authoritative', async t => {
  const f = setup(t), a = f.create('A'), b = f.create('B'), c = f.create('C'), input = f.begin(); f.owner.targetNodeId = a; const turn = await f.attributed(input);
  await f.builder.activate(input.sessionId, turn.id);
  const correct = nodeId => { f.asUser(); f.tree.correctAssignment(f.cmd({ turnId: turn.id, nodeIds: [nodeId], sourceRefs: [] }, f.expected('tree_turns', turn.id))); };
  correct(b); let release; const blocked = new Promise(r => { release = r; });
  const old = f.builder.activate(input.sessionId, turn.id, { cancelPrevious: async () => blocked });
  correct(c); const current = await f.builder.activate(input.sessionId, turn.id, { cancelPrevious: () => {} });
  release(); await assert.rejects(old, { code: 'SCOPE_STALE' }); assert.deepEqual(f.builder.scope(input.sessionId), current); assert.deepEqual(current.nodeIds, [c]); assert.ok(a);
});

test('global overview appends changed rows only and same-scope withdrawn sources leave no private text in the next request', async t => {
  const f = await nativeContext(t, 'b3-overview-withdraw'), a = f.create('A'), b = f.create('B'); f.target(a);
  const agent = await f.host.agent('b3-overview-withdraw', f.mount); await f.host.run(agent, 'User source for a learned rule'); await f.freeze(agent);
  const turn = f.attribution.existing(agent.session.id, 1), ref = turn.sourceRefs[0];
  const { ItemService } = await import('../src/tree/items.mjs'); const items = new ItemService({ repository: f.repo, context: () => f.context, resolveSource: f.resolveSource });
  f.asModel('learning', [a]); items.commitProposal(f.cmd({ nodeId: a, understandings: [{ content: 'PRIVATE_WITHDRAWN_RULE', source: 'assistant_inferred', sourceRefs: [ref] }], methods: [], supplements: [] }));
  await f.host.run(agent, 'Read new background'); assert.ok(textOf(f.host.requests.at(-1).messages).includes('PRIVATE_WITHDRAWN_RULE'));
  f.asUser(); f.tree.setStatus(f.cmd({ nodeId: b, status: 'paused', sourceRefs: [] }, f.expected('tree_nodes', b)));
  await f.host.run(agent, 'Update the overview'); const overview = f.host.requests.at(-1).messages.filter(m => m.source?.componentKey === 'global-overview');
  assert.equal(overview.length, 2); assert.deepEqual(JSON.parse(overview.at(-1).content[0].text).globalOverviewChanges, [{ id: b, removed: true }]);
  const snapshot = f.builder.capture(agent.session.id); f.revoked.add(digest(ref)); assert.throws(() => f.builder.assertCurrent(agent.session.id, snapshot), { code: 'CONTEXT_STALE' });
  await f.host.run(agent, 'After source withdrawal'); assert.ok(!textOf(f.host.requests.at(-1).messages).includes('PRIVATE_WITHDRAWN_RULE'));
  assert.ok(agent.session.snapshotEvents().some(e => e.type === 'user/message' && textOf([e.data]).includes('PRIVATE_WITHDRAWN_RULE')));
});

test('R05 real model owner starts a new native learning session with summary, recent three outputs/receipts and current constraints, without resend', async t => {
  const originals = setup(t), f = await meteredNative(t), nodeId = f.repo.rootId();
  const context = { actor: { kind: 'program', id: 'synthetic-main-fixture' }, nodeIds: [nodeId] };
  const options = { repository: f.repo, sources: originals.sources, resolveSource: ref => originals.sources.resolve(ref), context: () => context };
  f.sources = originals.sources; f.experience = new ExperienceService(options); f.builder = new ContextBuilder(options);
  const tree = new TreeService(options), consolidation = new ConsolidationService({ ...options, experience: f.experience, contextBuilder: f.builder, jobs: f.jobs });
  f.owner.applyResult = (result, ctx) => ctx.job.role === 'consolidation' ? consolidation.applyResult(result, ctx) : { changeReceipt: ctx.job.id };
  let last, lastTurn;
  for (let n = 0; n < 5; n++) {
    const original = originals.begin('seed-source-' + n), refs = originals.sources.claimed(original.sessionId, [original.message]).map(s => s.ref);
    const receipt = tree.applyAttribution({ requestId: 'attribution-' + n, expected: {}, input: { sessionId: original.sessionId, nativeTurn: 1, userSourceRefs: refs, sourceRefs: refs, actions: [], statusChanges: [], failure: 'synthetic root route' } });
    originals.finish(original); f.experience.settle(receipt.result.turnId); lastTurn = f.repo.get('tree_turns', receipt.result.turnId);
    const job = f.enqueue('learning', { input: learningInput(f, nodeId, lastTurn), trigger: { turnId: lastTurn.id } }); last = await f.owner.run(job.id); assert.equal(last.status, 'committed', JSON.stringify(last.error));
  }
  const plan = consolidation.plan(nodeId, 'threshold'), frozen = consolidation.freeze(plan);
  const job = f.enqueue('consolidation', { input: frozen.input, revisionSet: frozen.revisions, trigger: { kind: 'threshold' } });
  assert.equal((await f.owner.run(job.id)).status, 'committed'); const epoch = consolidation.finishEpoch(job.id), seed = consolidation.learningSeed(nodeId);
  const next = f.enqueue('learning', { input: { ...learningInput(f, nodeId, lastTurn), epochSeed: seed }, trigger: { turnId: lastTurn.id } }), final = await f.owner.run(next.id);
  assert.equal(final.status, 'committed', JSON.stringify(final.error)); assert.notEqual(final.nativeSessionId, last.nativeSessionId); assert.equal(final.nativeSessionId, epoch.sessionId);
  const actual = f.requests.at(-1); assert.equal(actual.input.epochSeed.recent.length, 3); assert.ok(actual.input.epochSeed.recent.every(r => r.output && r.receipt && r.nativeLogRef)); assert.ok(actual.input.epochSeed.constraints.length);
  assert.ok(!actual.body.messages.some(m => m.content?.some(b => b.type === 'text' && b.text === last.nativeMessage.content[0].text)), 'old full session is not copied into the new native log');
  assert.equal(f.requests.length, 7); const count = f.requests.length; await f.owner.recover(); assert.equal(f.requests.length, count); assert.equal(consolidation.learningSeed(nodeId), null);
  assert.equal(f.ledger.list().length, 7); assert.ok(f.ledger.list().every(row => row.status === 'settled')); // All receipts are synthetic loopback, never real spend.
});

test('the turn table stays in place while the goals stay the same, and is retired when they change', async t => {
  const { integratedFixture } = await import('./fixtures/tree-integration/native.mjs');
  const tables = body => body.messages.flatMap(m => m.content ?? []).flatMap(b => { if (b.type !== 'text') return []; try { const v = JSON.parse(b.text); return v.logicalTurnId ? [v] : []; } catch { return []; } });
  let phase = 'one', firstTable, staleResult;
  const mains = [];
  const f = await integratedFixture(t, (row, { repo }) => {
    if (row.role === 'attribution') return phase === 'three' ? { actions: [{ action: 'create', name: '目标乙' }], statusChanges: [] }
      : phase === 'one' ? { actions: [{ action: 'create', name: '目标甲' }], statusChanges: [] } : { actions: [{ action: 'continue', nodeId: row.input.scope.nodeIds[0] }], statusChanges: [] };
    if (row.role === 'learning') return { understandings: [], revisions: [], methods: [], supplements: [], categories: [] };
    if (row.role !== 'main') return minimal[row.role] ?? '合成答复。';
    mains.push({ phase, body: row.body });
    if (phase === 'one') { firstTable ??= tables(row.body).at(-1); return '合成答复一。'; }
    if (phase === 'two' && mains.filter(m => m.phase === 'two').length === 1) {
      const node = firstTable.nodes[0];
      return { tool: { id: 'stale-rename', name: 'arcfold_revise_goal', args: { op: 'rename', nodeId: node.id, expectedRevision: node.expectedRevision, name: '目标甲改名', reason: '合成：用旧编号表的版本号' } } };
    }
    if (phase === 'two') staleResult = row.body.messages.flatMap(m => m.content ?? []).filter(b => b.type === 'tool-result' || b.type === 'text').map(b => JSON.stringify(b)).join('\n');
    return '合成答复。';
  });
  f.runtime.attribution.timers = { setTimeout: fn => setTimeout(fn, 30000), clearTimeout };
  const agent = await f.main('turn-table-prefix');
  const first = await f.turn(agent, '先做目标甲。'), goal = first.nodeIds[0];
  phase = 'two'; await f.turn(agent, '继续目标甲。');
  const replaced = () => agent.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.source?.kind === 'arcfold/tree-context-retired');
  assert.equal(replaced().length, 0, 'the same goals keep the earlier table in place');
  const lastOfOne = mains.filter(m => m.phase === 'one').at(-1).body.messages, firstOfTwo = mains.find(m => m.phase === 'two').body.messages;
  assert.equal(canonicalJson(firstOfTwo.slice(0, lastOfOne.length)), canonicalJson(lastOfOne), 'the second turn extends the first turn unchanged');
  assert.equal(tables({ messages: firstOfTwo }).length, 2); assert.match(tables({ messages: firstOfTwo }).at(-1).instruction, /^以最后一份编号表为准/);
  assert.equal(f.repo.get('tree_nodes', goal).name, '目标甲', 'a stale revision from the earlier table cannot rename the goal');
  assert.match(staleResult, /REVISION_CONFLICT|Goal changed/);
  phase = 'three'; await f.turn(agent, '换个事：目标乙。');
  assert.ok(replaced().length >= 1, 'a different goal set retires the earlier table');
  assert.equal(tables({ messages: mains.at(-1).body.messages }).length, 1);
});
