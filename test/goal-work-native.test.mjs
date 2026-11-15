import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { nativeFixture, nativeRemote, response, callResponse, bounded, eventually, waitGate, emptyLearning } from './helpers/goal-work-native.mjs';

const ownerMessage = (text, source = { kind: 'user' }) => createUserMessage({ content: [{ type: 'text', text }], source });
const ref = goal => ({ id: goal.id, revision: goal.revision });
const stageSpec = (objective, max = 3) => ({ objective, max_goal_rounds: max,
  doneWhen: '本次明确委托的材料已核对，结果已保存并交代。',
  boundaries: '只推进本次委托；出现需要用户选择的新方向时等待。' });
const decision = (goal, action) => ({ goal_id: goal.id, revision: goal.revision, action,
  reason: action === 'continue' ? '当前阶段仍有可独立完成的核对工作。' : '当前阶段的完成条件已经满足。',
  stageDone: action === 'complete', needsUserDecision: action === 'wait',
  nextStep: action === 'continue' ? '完成本次阶段内下一项材料核对并检查结果。' : '' });
const results = agent => agent.session.snapshotEvents().filter(e => e.type === 'tool/result');
const resumes = agent => agent.session.snapshotEvents().filter(e => e.type === 'goal/change' && e.data.operation === 'resume');
const context = options => {
  const message = options.messages.find(m => m.source?.kind === 'arcfold/context');
  return message ? JSON.parse(message.content[0].text.slice(message.content[0].text.indexOf('\n') + 1)) : null;
};
const multiCalls = calls => [...calls.flatMap((call, index) => [
  { type: 'block-start', index, blockType: 'tool-call' },
  { type: 'block-end', index, block: { type: 'tool-call', ...call, arguments: JSON.stringify(call.arguments) } },
]), { type: 'finish', reason: { kind: 'tool-calls' } }];
const save = (f, name, value) => writeFileSync(join(f.root, name + '.json'), JSON.stringify(value, null, 2));

// All events below are written by official Commands, Agent, GoalService, tools,
// persistence and LearningRunner. The adapter substitutes only model responses.
test('real Arcfold stage, one Learn workLinks and two permitted native rounds supply the next complete goal context without waiting for held Learn', async t => {
  let f, agent, main = 0, learns = 0, material;
  const helperHeld = Promise.withResolvers(), releaseHelper = Promise.withResolvers();
  const firstRound = Promise.withResolvers(), releaseRound = Promise.withResolvers();
  const original = 'Please carry out two rounds of the delegated project and preserve why it matters.';
  f = await nativeFixture(t, async options => {
    const learned = options.messages.find(m => m.source?.kind === 'arcfold/learning');
    if (learned) {
      learns++;
      assert.equal(options.tools?.length ?? 0, 0);
      if (learns !== 1) return response(emptyLearning);
      material = JSON.parse(learned.content[0].text);
      helperHeld.resolve(); await waitGate(releaseHelper, options.signal);
      assert.equal(material.goalWorks.length, 1);
      const work = material.goalWorks[0], sourceIds = work.sourceIds;
      return response(JSON.stringify({ understandings: [], methods: [], opportunities: [], goals: [{
        operation: 'create', targetId: '', clientRef: '', title: '长期方向原文', outcome: '完整目标定义：保留关键依据并逐步推进。',
        scope: 'conversation', sourceIds, understandingIds: [],
        progress: { content: '已明确本次工作与长期方向的联系。', sourceIds }, relations: [], controlProposal: 'none',
        workLinks: [{ workId: work.id, reason: '此次真实委托支持该长期方向。', sourceIds }],
      }] }));
    }
    main++;
    if (main === 1) return callResponse('create-work', 'arcfold_start_work', stageSpec(original, 2));
    if (main === 2) return callResponse('permit-first-round', 'arcfold_decide_work', decision(f.ctx.goals.get(agent), 'continue'));
    if (main === 3) return response('已记录本次委托。');
    if (main === 4) {
      assert.equal(context(options).workGoalContext, undefined, 'Pending Learn must not invent or block an association');
      firstRound.resolve(); await waitGate(releaseRound, options.signal);
      return callResponse('permit-second-round', 'arcfold_decide_work', decision(f.ctx.goals.get(agent), 'continue'));
    }
    if (main === 5) return response('第一轮正式完成。');
    if (main === 6) {
      const full = context(options).workGoalContext;
      assert.ok(full, 'The next actual native request automatically contains the established association');
      assert.equal(full.goal.title, '长期方向原文');
      assert.equal(full.goal.outcome, '完整目标定义：保留关键依据并逐步推进。');
      assert.equal(full.goal.progress.content, '已明确本次工作与长期方向的联系。');
      assert.ok(JSON.stringify(full.sources).includes(original));
      assert.equal(full.authority, 'previously-established-model-association; no-new-delegation');
      return callResponse('complete-work', 'arcfold_decide_work', decision(f.ctx.goals.get(agent), 'complete'));
    }
    if (main === 7) return response('第二轮正式完成，长期目标仍需后续工作。');
    assert.fail('Unexpected main request');
  }, { business: true, learning: true });
  agent = await f.agent('linked-main'); agent.followup(ownerMessage(original));
  await bounded(Promise.all([firstRound.promise, helperHeld.promise]), 'native round starts while first Learn is held');
  assert.equal(learns, 1); assert.equal(main, 4);
  releaseHelper.resolve();
  await eventually(() => f.ctx.arcfoldBusiness.storage.listAll('goal_work_links').length === 1, 'actual Learn commits its work association');
  releaseRound.resolve();
  await eventually(() => f.ctx.goals.get(agent)?.phase === 'complete' && agent.status === 'idle', 'second native round ends');
  await f.ctx.arcfoldBridge.pending.get(agent.id);
  await eventually(() => f.ctx.arcfoldBusiness.storage.listAll('learning_pending').length === 3 &&
    f.ctx.arcfoldBusiness.storage.listAll('learning_pending').every(p => p.status === 'completed'), 'all three one-call helpers complete');
  const store = f.ctx.arcfoldBusiness.storage;
  assert.equal(store.listAll('goals')[0].status, 'tracking', 'Execution completion is not long-term goal completion');
  assert.equal(store.listAll('goal_works').length, 1); assert.equal(store.listAll('goal_work_links').length, 1);
  assert.equal(main, 7); assert.equal(learns, 3);
  for (const run of store.listAll('learning_runs')) assert.equal(run.dispatchCount, 1);
  const automatic = store.listAll('deliveries').filter(d => d.nativeContinuation);
  assert.equal(automatic.length, 2); assert.ok(automatic.every(d => d.inputEventIds.length === 0));
  assert.ok(agent.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.source?.kind === 'goal').length === 2);
  save(f, 'work-link-chain', { material, goals: store.listAll('goals'), links: store.listAll('goal_work_links'), automatic,
    requests: f.adapter.requests.map(o => ({ sessionId: o.sessionId, messages: o.messages, tools: o.tools?.map(t => t.name) })) });
});

async function pausedFixture(t, { queued = false, block = false } = {}) {
  let f, agent, current = () => response('普通回答，不自动恢复。');
  const started = Promise.withResolvers(), held = Promise.withResolvers();
  let initial = 0;
  f = await nativeFixture(t, async options => {
    initial++;
    if (initial === 1) return callResponse('start-paused-fixture', 'arcfold_start_work', stageSpec('Carry out the explicitly delegated continuing work'));
    if (initial === 2) return callResponse('permit-paused-fixture', 'arcfold_decide_work', decision(f.ctx.goals.get(agent), 'continue'));
    if (initial === 3) return response('当前阶段已明确，继续下一项工作。');
    if (initial === 4) { started.resolve(); await waitGate(held, options.signal); return response('must be cancelled'); }
    return current(options);
  }, { business: true });
  agent = await f.agent('resume-native'); const remote = await nativeRemote(f);
  agent.followup(ownerMessage('Carry out the explicitly delegated continuing work'));
  await bounded(started.promise, 'first delegated response held');
  let queuedInput;
  if (queued) { queuedInput = ownerMessage('Continue this work, queued before the pause.'); agent.followup(queuedInput); }
  if (block) {
    // Use the public native service; block is not a new message or made-up event.
    f.ctx.goals.block(agent, ref(f.ctx.goals.get(agent)), { reason: 'Waiting for the owner.' });
    agent.cancel({ keepInbox: true });
  } else await remote('pause', agent, ref(f.ctx.goals.get(agent)));
  held.resolve(); await bounded(agent.whenIdle(), 'native pause completes');
  await f.ctx.arcfoldBridge.pending.get(agent.id);
  return { ...f, agent, remote, queuedInput, setScript(fn) { current = fn; } };
}

async function deniedResume(t, { kind = 'owner', stale = false, mixed = false, withdrawn = false } = {}) {
  const f = await pausedFixture(t); const { agent } = f;
  let calls = 0, bodies = 0;
  agent.ctx.tools.register(defineTool({ name: 'fixture_mutate', description: 'Observe a forbidden companion tool body', parameters: {},
    output: { schema: { type: 'json' }, render: () => [] }, execute() { bodies++; return {}; } }));
  const goal = f.ctx.goals.get(agent), message = ownerMessage('Continue the existing work.', kind === 'owner' ? { kind: 'user' } :
    kind === 'foreign' ? { kind: 'user', principal: { kind: 'agent', agentId: 'foreign-agent' } } : { kind: 'fixture-program' });
  f.setScript(() => {
    calls++;
    if (calls === 1) {
      const args = { goal_id: goal.id, revision: goal.revision - Number(stale) };
      return mixed ? multiCalls([{ id: 'mutate-before-resume', name: 'fixture_mutate', arguments: {} },
        { id: 'resume-mixed', name: 'arcfold_resume_work', arguments: args }]) : callResponse('resume-denied', 'arcfold_resume_work', args);
    }
    if (calls === 2) return response('没有恢复，保留暂停。');
    assert.fail('Rejected work must not produce an automatic request');
  });
  if (withdrawn) f.ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name === 'arcfold_resume_work') {
      const source = f.ctx.arcfoldBusiness.storage.listAll('events').find(e => e.message?.id === message.id);
      assert.ok(source); f.ctx.arcfoldBusiness.storage.save('source_controls', { id: source.id, withdrawn: true });
    }
    return next();
  });
  agent.followup(message); await bounded(agent.whenIdle(), 'denied resume ordinary turn');
  await f.ctx.arcfoldBridge.pending.get(agent.id);
  assert.equal(resumes(agent).length, 0); assert.equal(f.ctx.goals.get(agent).phase, 'paused'); assert.equal(bodies, 0);
  assert.ok(results(agent).some(e => e.data.message.toolCallId === (mixed ? 'resume-mixed' : 'resume-denied') && e.data.message.isError));
  save(f, 'resume-denial', { kind, stale, mixed, withdrawn, calls, bodies, goal: f.ctx.goals.get(agent), events: agent.session.snapshotEvents() });
}
for (const [label, options] of [
  ['stale native revision', { stale: true }], ['non-owner user message', { kind: 'foreign' }],
  ['program message', { kind: 'program' }], ['mixed batch before any body', { mixed: true }],
  ['withdrawn current owner input', { withdrawn: true }],
]) test('real resume refuses ' + label, t => deniedResume(t, options));

test('real inbox received before pause stays ineligible even when claimed afterwards', async t => {
  let f, agent, calls = 0;
  const held = Promise.withResolvers(), started = Promise.withResolvers();
  f = await nativeFixture(t, async options => {
    calls++;
    if (calls === 1) return callResponse('start-queued-fixture', 'arcfold_start_work', stageSpec('Continue only the delegated work'));
    if (calls === 2) return callResponse('permit-queued-fixture', 'arcfold_decide_work', decision(f.ctx.goals.get(agent), 'continue'));
    if (calls === 3) return response('当前阶段已明确。');
    if (calls === 4) { started.resolve(); await waitGate(held, options.signal); return response('cancelled'); }
    if (calls === 5) return callResponse('old-queued-resume', 'arcfold_resume_work', { goal_id: f.ctx.goals.get(agent).id, revision: f.ctx.goals.get(agent).revision });
    if (calls === 6) return response('旧排队消息不能恢复刚暂停的工作。');
    assert.fail('Old queued input cannot cause another automatic request');
  }, { business: true });
  agent = await f.agent('queued-before-pause'); const remote = await nativeRemote(f);
  agent.followup(ownerMessage('Continue only the delegated work'));
  await bounded(started.promise, 'first automatic request');
  const old = ownerMessage('Continue it, received before pause.'); agent.followup(old);
  await remote('pause', agent, ref(f.ctx.goals.get(agent))); held.resolve();
  await bounded(agent.whenIdle(), 'paused activity stops with old input retained');
  assert.ok(agent.inbox.nextTurn.some(message => message.id === old.id));
  // Native pause retains the queue without waking it. A later non-owner host
  // notice wakes that existing input; it cannot turn the old owner input into
  // a new owner instruction received after pause. No goal event is fabricated.
  agent.steer(ownerMessage('A program notice wakes the preserved queue.', { kind: 'fixture-program' }));
  await eventually(() => calls === 6 && agent.status === 'idle', 'old queued input is answered');
  const events = agent.session.snapshotEvents();
  const received = events.find(e => e.type === 'agent/inbox/spliced' && e.data.inserted?.some(m => m.id === old.id));
  const pause = events.find(e => e.type === 'goal/change' && e.data.operation === 'pause');
  const claimed = events.find(e => e.type === 'user/message' && e.data.id === old.id);
  assert.ok(received.seq < pause.seq && claimed.seq > pause.seq);
  assert.equal(resumes(agent).length, 0); assert.equal(f.ctx.goals.get(agent).phase, 'paused'); assert.equal(calls, 6);
  assert.ok(results(agent).find(e => e.data.message.toolCallId === 'old-queued-resume').data.message.isError);
  save(f, 'old-queued', { received, pause, claimed, events });
});

test('actual owner input after pause resumes the edited exact work once; duplicate old ref cannot resume twice', async t => {
  const f = await pausedFixture(t); const { agent, remote } = f;
  const old = ref(f.ctx.goals.get(agent)); let reviseCalls = 0;
  f.setScript(() => {
    reviseCalls++;
    if (reviseCalls === 1) return callResponse('revise-paused-work', 'arcfold_revise_work', {
      goal_id: old.id, revision: old.revision, ...stageSpec('The clarified same delegated work.') });
    if (reviseCalls === 2) return response('本次工作定义已更新，保持暂停。');
    assert.fail('Editing a stopped stage must not resume it');
  });
  agent.followup(ownerMessage('Clarify this same work as requested, and keep it paused.'));
  await bounded(agent.whenIdle(), 'stage edit stays paused');
  assert.equal(reviseCalls, 2); assert.equal(f.ctx.goals.get(agent).phase, 'paused');
  assert.equal(f.ctx.goals.get(agent).activation, 'disarmed');
  assert.equal(f.ctx.arcfoldWork.current(agent).status, 'waiting');
  await assert.rejects(remote('resume', agent, old), /revision|conflict|stale/i);
  const stopped = f.ctx.goals.get(agent); let calls = 0;
  f.setScript(options => {
    calls++;
    if (calls === 1 || calls === 2) return callResponse('resume-once-' + calls, 'arcfold_resume_work', { goal_id: stopped.id, revision: stopped.revision });
    if (calls === 3) return callResponse('permit-resumed-work', 'arcfold_decide_work', decision(f.ctx.goals.get(agent), 'continue'));
    if (calls === 4) return response('按新原话恢复同一工作。');
    if (calls === 5) {
      assert.equal(context(options).nativeContinuation.currentDefinition.objective, 'The clarified same delegated work.');
      return callResponse('finish-resumed', 'arcfold_decide_work', decision(f.ctx.goals.get(agent), 'complete'));
    }
    if (calls === 6) return response('同一工作完成。');
    assert.fail('No duplicate resume or new delegation');
  });
  const fresh = ownerMessage('Continue the clarified existing work.'); agent.followup(fresh);
  await eventually(() => f.ctx.goals.get(agent).phase === 'complete' && agent.status === 'idle', 'resumed work finishes');
  await f.ctx.arcfoldBridge.pending.get(agent.id);
  assert.equal(resumes(agent).length, 1); assert.equal(calls, 6);
  const toolResults = results(agent);
  assert.equal(Boolean(toolResults.find(e => e.data.message.toolCallId === 'resume-once-1').data.message.isError), false);
  assert.equal(toolResults.find(e => e.data.message.toolCallId === 'resume-once-2').data.message.isError, true);
  assert.equal(f.ctx.arcfoldBusiness.storage.listAll('goal_works').length, 1);
  const events = agent.session.snapshotEvents(), pause = events.find(e => e.type === 'goal/change' && e.data.operation === 'pause');
  const received = events.find(e => e.type === 'agent/inbox/spliced' && e.data.inserted?.some(m => m.id === fresh.id));
  assert.ok(received.seq > pause.seq); save(f, 'resume-exact', { events, calls });
});

test('old in-flight owner turn cannot execute a resume produced after its native pause', async t => {
  let f, agent, calls = 0;
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  f = await nativeFixture(t, async () => {
    calls++;
    if (calls === 1) return callResponse('user-create', 'arcfold_start_work', stageSpec('Original owner delegation', 2));
    if (calls === 2) {
      started.resolve(); await release.promise; // Deliberately models a late provider response ignoring abort.
      return callResponse('late-resume', 'arcfold_resume_work', { goal_id: f.ctx.goals.get(agent).id, revision: f.ctx.goals.get(agent).revision });
    }
    assert.fail('Cancelled old input cannot continue');
  }, { business: true });
  agent = await f.agent('old-inflight'); const remote = await nativeRemote(f);
  agent.followup(ownerMessage('Please carry out this continuing work.'));
  await bounded(started.promise, 'old owner request held');
  await remote('pause', agent, ref(f.ctx.goals.get(agent))); release.resolve();
  await bounded(agent.whenIdle(), 'late old owner output cancelled');
  assert.equal(resumes(agent).length, 0); assert.equal(calls, 2); assert.equal(f.ctx.goals.get(agent).phase, 'paused');
});

test('official automatic goal message cannot invoke owner-only resume and cold restore stays disarmed without another call', async t => {
  let f, agent, calls = 0;
  const ready = Promise.withResolvers();
  f = await nativeFixture(t, options => {
    calls++;
    if (calls === 1) return callResponse('start-cold-work', 'arcfold_start_work', stageSpec('Continue this delegated work'));
    if (calls === 2) return callResponse('permit-cold-work', 'arcfold_decide_work', decision(f.ctx.goals.get(agent), 'continue'));
    if (calls === 3) return response('继续本次阶段内的工作。');
    if (calls === 4) {
      assert.ok(options.messages.some(m => m.source?.kind === 'goal'));
      return callResponse('automatic-resume', 'arcfold_resume_work', { goal_id: f.ctx.goals.get(agent).id, revision: f.ctx.goals.get(agent).revision });
    }
    if (calls === 5) { ready.resolve(); return [{ type: 'finish', reason: { kind: 'max-tokens' } }]; }
    assert.fail('No cold or automatic resend');
  }, { business: true });
  agent = await f.agent('cold-work');
  agent.followup(ownerMessage('Continue this delegated work'));
  await bounded(ready.promise, 'automatic resume denied');
  await bounded(agent.whenIdle(), 'round reaches quiescence');
  assert.equal(resumes(agent).length, 0);
  assert.ok(results(agent).find(e => e.data.message.toolCallId === 'automatic-resume').data.message.isError);
  assert.equal(await f.ctx.sessions.flush(agent.session), true);
  await f.release(agent); const before = calls; const restored = await f.resume('cold-work');
  assert.equal(f.ctx.goals.get(restored).activation, 'disarmed');
  assert.equal(restored.status, 'idle'); assert.equal(calls, before);
  assert.equal(f.ctx.arcfoldGoals.works(restored.id).length, 1);
  assert.equal(calls, before, 'Reading the restored work cannot dispatch a model');
});
