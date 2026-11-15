import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { nativeFixture, response, callResponse, bounded, eventually, waitGate } from './helpers/goal-work-native.mjs';
import { saveGoalTransition } from '../src/learning-goals.mjs';
import { linkWork, workState, workRelation } from '../src/goal-work.mjs';
import { BusinessStore } from '../src/business.mjs';
import { collectContext } from '../src/context-material.mjs';

const materialOf = options => {
  const text = options.messages.find(m => m.source?.kind === 'arcfold/context').content[0].text;
  return JSON.parse(text.slice(text.indexOf('\n') + 1));
};
const decision = (goal, action) => ({ goal_id: goal.id, revision: goal.revision, action,
  reason: action === 'continue' ? '当前阶段尚有下一项可独立核对的研究材料。' : '当前研究核对阶段已完成。',
  stageDone: action === 'complete', needsUserDecision: false,
  nextStep: action === 'continue' ? '核对当前阶段下一项材料并保存结果。' : '' });
async function linkedRound(t, { crowded = false, oversized = false } = {}) {
  let f, agent, calls = 0;
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  const ready = Promise.withResolvers(), dispatch = Promise.withResolvers();
  let finalCheck = null, checked = false;
  f = await nativeFixture(t, async options => {
    calls++;
    if (calls === 1) return callResponse('start-linked-context-stage', 'arcfold_start_work', {
      objective: 'Complete the existing delegated research work', max_goal_rounds: 2,
      doneWhen: '当前两项研究材料均完成核对并保留结果。', boundaries: '只核对已委托的材料，需要新选择时等待用户。' });
    if (calls === 2) return callResponse('permit-first-context-round', 'arcfold_decide_work', decision(f.ctx.goals.get(agent), 'continue'));
    if (calls === 3) return response('当前研究阶段已明确。');
    if (calls === 4) {
      started.resolve(); await waitGate(release, options.signal);
      return callResponse('permit-next-context-round', 'arcfold_decide_work', decision(f.ctx.goals.get(agent), 'continue'));
    }
    if (calls === 5) return response('第一轮完成。');
    if (calls === 6) return callResponse('finish', 'arcfold_decide_work', decision(f.ctx.goals.get(agent), 'complete'));
    if (calls === 7) return response('工作完成，目标历史保留。');
    assert.fail('No additional execution expected');
  }, { business: true });
  const store = f.ctx.arcfoldBusiness.storage;
  const source = store.save('events', { id: 'goal-evidence', role: 'user',
    content: oversized ? 'EXACT-MANDATORY-EVIDENCE'.repeat(1500) : '这项长期研究必须保留实际依据。' });
  const goal = saveGoalTransition(store, null, { id: 'background-goal', title: '长期研究',
    outcome: '依据完整并逐步推进', status: 'tracking', definitionVersion: 1, scope: {}, userControl: null,
    sourceIds: [source.id], dependencies: [{ kind: 'events', id: source.id, revision: source.revision }],
    progress: { content: '已确定方向', sourceIds: [source.id], dependencies: [{ kind: 'events', id: source.id, revision: source.revision }] },
    relations: [] }, { commandId: 'fixture-goal', pendingId: null, reason: 'fixture-definition' });
  if (crowded) for (let index = 0; index < 30; index++) {
    const evidence = store.save('events', { id: 'unrelated-original-' + index, role: 'user', content: '无关的旧历史材料'.repeat(90) });
    store.save('understandings', { id: 'unrelated-' + index, status: 'active', content: '另一件事的既有理解'.repeat(90),
      sourceIds: [evidence.id], dependencies: [{ kind: 'events', id: evidence.id, revision: evidence.revision }] });
  }
  agent = await f.agent('context-round');
  agent.followup(createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text: 'Complete the existing delegated research work' }] }));
  await bounded(started.promise, 'first actual native request');
  const work = store.listAll('goal_works')[0]; assert.ok(work);
  const associate = (target, origin) => linkWork(store, { work, goal: target, state: workState(store, work.id),
    reason: origin, sourceIds: [source.id], expectedRelationId: workRelation(store, work.id)?.id ?? null,
    origin: { kind: 'fixture-explicit-association', id: origin } });
  associate(goal, 'first');
  f.adapter.beforeSend = async options => {
    if (checked || f.adapter.requests.length !== 5) return;
    checked = true; ready.resolve(options);
    await waitGate(dispatch, options.signal);
    // Same synchronous guard called by the paid sender after its awaited I/O.
    // The adapter is scripted; this proves native input + final guard, not a paid wire.
    try { f.ctx.arcfoldBridge.assertRequestCurrent(options); finalCheck = 'allowed'; }
    catch (error) { finalCheck = error.code; throw error; }
  };
  return { ...f, store, source, goal, work, agent, associate, ready, dispatch, release,
    calls: () => calls, finalCheck: () => finalCheck };
}
for (const change of ['progress', 'repeat-association', 'different-goal']) test(
  'actual native input at the final dispatch guard: ' + change, async t => {
    const f = await linkedRound(t);
    f.release.resolve();
    const options = await bounded(f.ready.promise, 'second native input prepared');
    const frozen = structuredClone(options.messages), before = materialOf(options).workGoalContext;
    assert.ok(before); assert.equal(before.goal.progress.content, '已确定方向');
    if (change === 'progress') {
      const current = f.store.get('goals', f.goal.id);
      saveGoalTransition(f.store, current, { ...current, progress: { ...current.progress, content: '晚到新进展' } },
        { commandId: 'late-progress', pendingId: 'learn', reason: 'learn_update' });
    } else if (change === 'repeat-association') f.associate(f.goal, 'repeat');
    else {
      const other = saveGoalTransition(f.store, null, { ...f.goal, id: 'new-goal', title: '另一个目标' },
        { commandId: 'new-goal', pendingId: null, reason: 'fixture-definition' });
      f.associate(other, 'different');
    }
    f.dispatch.resolve();
    await eventually(() => f.agent.status === 'idle' && (change === 'different-goal' ?
      f.ctx.goals.get(f.agent)?.activation === 'disarmed' : f.ctx.goals.get(f.agent)?.phase === 'complete'), 'actual native final state');
    await f.ctx.arcfoldBridge.pending.get(f.agent.id);
    assert.deepEqual(options.messages, frozen, 'No late material is inserted into this request');
    assert.equal(f.finalCheck(), change === 'different-goal' ? 'ARCFOLD_CONTEXT_CHANGED' : 'allowed');
    assert.equal(f.calls(), change === 'different-goal' ? 5 : 7);
    writeFileSync(join(f.root, 'final-context-guard.json'), JSON.stringify({ change, finalCheck: f.finalCheck(),
      requests: f.adapter.requests.map(o => ({ sessionId: o.sessionId, messages: o.messages })),
      links: f.store.listAll('goal_work_links') }, null, 2));
  });
test('real prepare reserves complete work context before unrelated near-capacity history', async t => {
  const f = await linkedRound(t, { crowded: true });
  const first = materialOf(f.adapter.requests[3]); assert.ok(first.nativeContinuation);
  assert.ok(first.coverage.omitted.capacity > 0);
  f.release.resolve(); const options = await bounded(f.ready.promise, 'second crowded native input');
  const material = materialOf(options);
  assert.equal(material.workGoalContext.goal.title, f.goal.title);
  assert.equal(material.workGoalContext.sources[0].content, f.source.content);
  assert.ok(material.nativeContinuation);
  assert.ok(material.coverage.omitted.capacity > 0);
  assert.ok(options.messages.find(m => m.source?.kind === 'arcfold/context').content[0].text.length <= 24000);
  f.dispatch.resolve();
  await eventually(() => f.agent.status === 'idle' && f.ctx.goals.get(f.agent)?.phase === 'complete', 'crowded native work completes');
  assert.equal(f.calls(), 7);
});
test('real prepare rejects mandatory full work evidence above capacity without another adapter call', async t => {
  const f = await linkedRound(t, { oversized: true }); f.release.resolve();
  await eventually(() => f.agent.status === 'idle' && f.ctx.goals.get(f.agent)?.activation === 'disarmed', 'oversized material refuses the next native request');
  await f.ctx.arcfoldBridge.pending.get(f.agent.id);
  assert.equal(f.calls(), 5); assert.equal(f.adapter.requests.length, 5);
  assert.ok(JSON.stringify(f.agent.session.snapshotEvents()).includes('nothing was truncated'));
});
test('required context additions cannot override session identity, cutoff, or coverage', t => {
  // A narrow helper contract; genuine native assembly is exercised above.
  const business = new BusinessStore({ filename: ':memory:' });
  t.after(() => business.close());
  const store = business.storage;
  const material = collectContext(store, { sessionId: 'real', turn: 1, maxCharacters: 1000,
    requiredMaterial: { version: 'forged', sessionId: 'other', cutoffSequence: -1, coverage: null } });
  assert.equal(material.version, 'arcfold-context-v1'); assert.equal(material.sessionId, 'real');
  assert.equal(material.cutoffSequence, 0); assert.ok(material.coverage);
});
