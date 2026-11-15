import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { saveGoalTransition } from '../src/learning-goals.mjs';
import { nativeFixture, nativeRemote, response, callResponse, bounded, eventually, waitGate } from './helpers/goal-work-native.mjs';

// These are complete native Agent turns. Only the provider response is fixed;
// the official goal driver, tools, inbox, persistence and Arcfold guards execute.
const owner = (text, source = { kind: 'user' }) => createUserMessage({ content: [{ type: 'text', text }], source });
const reference = goal => ({ goal_id: goal.id, revision: goal.revision });
const nativeReference = goal => ({ id: goal.id, revision: goal.revision });
const stageInput = {
  objective: '核对两份已有材料的出处并保存一份核对记录。',
  doneWhen: '两份材料均有来源核对结果，记录已保存并回读。',
  boundaries: '只读已有材料；仅在测试工作目录写核对记录；需要用户选择新材料时等待。',
  max_goal_rounds: 3,
};
const decide = (goal, action, extra = {}) => ({
  ...reference(goal), action, reason: action === 'continue' ? '当前阶段尚有第二份材料可独立核对。' : '本轮检查结果已明确。',
  stageDone: action === 'complete', needsUserDecision: action === 'wait',
  nextStep: action === 'continue' ? '核对第二份材料的来源并保存结果。' : '', ...extra,
});
const events = agent => agent.session.snapshotEvents();
const automatic = agent => events(agent).filter(e => e.type === 'user/message' && e.data.source?.kind === 'goal' && e.data.source.round > 0);
const toolResults = (agent, id) => events(agent).filter(e => e.type === 'tool/result' && e.data.message?.toolCallId === id);
const toolSucceeded = (agent, id) => {
  const results = toolResults(agent, id);
  assert.equal(results.length, 1, `one native result for ${id}`);
  assert.equal(results[0].data.message.isError, false, `native ${id} succeeds`);
  return results[0];
};
const toolRejected = (agent, id) => {
  const results = toolResults(agent, id);
  assert.equal(results.length, 1, `one native result for ${id}`);
  assert.equal(results[0].data.message.isError, true, `native ${id} is rejected`);
};
async function settled(f, agent) {
  await bounded(agent.whenIdle(), 'native Agent becomes idle');
  await f.ctx.arcfoldBridge.pending.get(agent.id);
  assert.equal(await f.ctx.sessions.flush(agent.session), true, 'native evidence is durable');
}
const multiCalls = calls => [...calls.flatMap((call, index) => [
  { type: 'block-start', index, blockType: 'tool-call' },
  { type: 'block-end', index, block: { type: 'tool-call', ...call, arguments: JSON.stringify(call.arguments) } },
]), { type: 'finish', reason: { kind: 'tool-calls' } }];

test('clearing during an in-flight owner response prevents recreating from the old input, while a new owner can start', async t => {
  const held = Promise.withResolvers(), release = Promise.withResolvers();
  let f, agent;
  f = await nativeFixture(t, async (options, call) => {
    if (call === 1) return callResponse('initial-start-before-clear', 'arcfold_start_work', stageInput);
    if (call === 2) { held.resolve(); await waitGate(release, options.signal);
      return callResponse('old-input-recreate', 'arcfold_start_work', stageInput); }
    if (call === 3) return callResponse('fresh-input-start', 'arcfold_start_work', stageInput);
    if (call === 4) return response('新的具体阶段已明确，本轮到此。');
    assert.fail('cleared work cannot silently start another round');
  }, { business: true });
  agent = await f.agent('clear-recreate-main');
  agent.followup(owner('请核对这两份材料。'));
  await bounded(held.promise, 'model response before native clear');
  f.ctx.goals.clear(agent, nativeReference(f.ctx.goals.get(agent)));
  release.resolve(); await settled(f, agent);
  toolRejected(agent, 'old-input-recreate');
  assert.equal(events(agent).filter(e => e.type === 'goal/change' && e.data.operation === 'create').length, 1);
  assert.equal(automatic(agent).length, 0);
  agent.followup(owner('重新委托：现在核对两份新材料，完成后等我。'));
  await settled(f, agent); toolSucceeded(agent, 'fresh-input-start');
  assert.equal(events(agent).filter(e => e.type === 'goal/change' && e.data.operation === 'create').length, 2);
  assert.equal(automatic(agent).length, 0);
});
function registerWrite(f, agent, value = 'verified second source') {
  const destination = join(f.root, 'stage-result.txt');
  let writes = 0;
  agent.ctx.tools.register(defineTool({
    name: 'fixture_write_stage_result', description: 'Save the result of the currently delegated fixture stage.', parameters: {},
    output: { schema: { type: 'json' }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    execute() { writes++; writeFileSync(destination, value); return { written: true }; },
  }));
  return { destination, writes: () => writes };
}
function sourceFor(f, message) {
  const sources = f.ctx.arcfoldBusiness.storage.listAll('events').filter(row => row.message?.id === message.id);
  assert.equal(sources.length, 1, 'one exact business original for the real owner message');
  assert.deepEqual(sources[0].message, message);
  return sources[0];
}
function assertDeliveredText(f, agent, text) {
  const store = f.ctx.arcfoldBusiness.storage;
  const delivery = store.listAll('deliveries', { where: { sessionId: agent.id } }).find(row =>
    store.get('events', row.eventId)?.message?.content?.some(block => block.type === 'text' && block.text === text));
  assert.ok(delivery, 'the final explanation is a formal native delivery');
  return delivery;
}

test('ordinary main answer exposes Arcfold stage controls, retains native read-only inspection, and creates no work', async t => {
  const f = await nativeFixture(t, async options => {
    const names = options.tools.map(tool => tool.name);
    for (const name of ['get_goal', 'arcfold_start_work', 'arcfold_revise_work', 'arcfold_decide_work', 'arcfold_resume_work'])
      assert.ok(names.includes(name), `main can use ${name}`);
    assert.ok(!names.includes('create_goal') && !names.includes('update_goal'), 'native mutators are absent from the model catalog');
    return response('这里直接回答问题。');
  }, { business: true });
  const agent = await f.agent('ordinary-stage-main');
  agent.followup(owner('解释一下这份材料的出处。'));
  await settled(f, agent);
  assert.equal(f.adapter.requests.length, 1);
  assert.equal(f.ctx.goals.get(agent), undefined);
  assert.equal(f.ctx.arcfoldBusiness.storage.listAll('execution_stages').length, 0);
  assert.equal(automatic(agent).length, 0);
});

test('a completed stage refuses revision without mutation and a new owner starts the next stage in the same turn', async t => {
  let f, agent, completed, beforeRevision;
  f = await nativeFixture(t, async (_options, call) => {
    if (call === 1) return callResponse('first-complete-start', 'arcfold_start_work', stageInput);
    if (call === 2) return callResponse('first-complete-decision', 'arcfold_decide_work', decide(f.ctx.goals.get(agent), 'complete'));
    if (call === 3) return response('第一阶段完成。');
    if (call === 4) { beforeRevision = f.ctx.arcfoldWork.current(agent);
      return callResponse('revise-completed', 'arcfold_revise_work', { ...reference(f.ctx.goals.get(agent)), ...stageInput }); }
    if (call === 5) {
      assert.deepEqual(f.ctx.arcfoldWork.current(agent), beforeRevision, 'rejected revision preserves the completed stage');
      return callResponse('next-stage-start', 'arcfold_start_work', { ...stageInput, objective: '核对新一批材料。' });
    }
    if (call === 6) return response('新阶段已建立，等待下一步。');
    assert.fail('no unrequested automatic round');
  }, { business: true });
  agent = await f.agent('completed-to-next-stage');
  agent.followup(owner('核对当前一批材料。')); await settled(f, agent);
  completed = f.ctx.arcfoldWork.current(agent);
  agent.followup(owner('开始下一阶段，核对新一批材料。')); await settled(f, agent);
  toolRejected(agent, 'revise-completed'); toolSucceeded(agent, 'next-stage-start');
  assert.notEqual(f.ctx.arcfoldWork.current(agent).id, completed.id);
  assert.equal(automatic(agent).length, 0);
});

test('a stage followed by a plain-text user question has no automatic continuation without an explicit decision', async t => {
  let f, agent;
  f = await nativeFixture(t, async (_options, call) => {
    if (call === 1) return callResponse('start-question-stage', 'arcfold_start_work', stageInput);
    if (call === 2) return response('已有材料已归拢。你希望先核对哪一份？');
    assert.fail('a text question and active native objective must not launch another request');
  }, { business: true });
  agent = await f.agent('default-wait-main');
  agent.followup(owner('先核对已有材料，一步步来，需要选择时我们一起决定。'));
  await settled(f, agent);
  toolSucceeded(agent, 'start-question-stage');
  assert.equal(f.adapter.requests.length, 2);
  assert.equal(f.ctx.goals.get(agent).activation, 'disarmed');
  assert.equal(automatic(agent).length, 0);
  assert.equal(f.ctx.arcfoldBusiness.storage.listAll('execution_stages').length, 1);
});

test('one continue decision admits exactly one real native round and the next undecided end stops', async t => {
  let f, agent, writer;
  f = await nativeFixture(t, async (_options, call) => {
    if (call === 1) return callResponse('start-one-round', 'arcfold_start_work', stageInput);
    if (call === 2) return callResponse('permit-one-round', 'arcfold_decide_work', decide(f.ctx.goals.get(agent), 'continue'));
    if (call === 3) return response('第一份来源已核对，继续本阶段第二份材料。');
    if (call === 4) return callResponse('write-second-source', 'fixture_write_stage_result', {});
    if (call === 5) return response('第二份来源已核对，结果已保存。');
    assert.fail('the already consumed permit must not admit another automatic round');
  }, { business: true });
  agent = await f.agent('single-permit-main'); writer = registerWrite(f, agent);
  agent.followup(owner('持续完成这个材料核对阶段，遇到需要我选择的内容先停下。'));
  await eventually(() => f.adapter.requests.length >= 5 && agent.status === 'idle', 'one permitted native round finishes');
  await settled(f, agent);
  toolSucceeded(agent, 'permit-one-round'); toolSucceeded(agent, 'write-second-source');
  assert.equal(f.adapter.requests.length, 5);
  assert.equal(automatic(agent).length, 1);
  assert.equal(automatic(agent)[0].data.source.round, 1);
  assert.equal(writer.writes(), 1);
  assert.equal(readFileSync(writer.destination, 'utf8'), 'verified second source');
  assert.equal(f.ctx.goals.get(agent).activation, 'disarmed');
});

for (const action of ['wait', 'complete']) {
  test(`explicit ${action} closes automatic execution while still allowing the final explanation`, async t => {
    let f, agent;
    f = await nativeFixture(t, async (_options, call) => {
      if (call === 1) return callResponse('start-terminal-stage', 'arcfold_start_work', stageInput);
      if (call === 2) return callResponse('terminal-stage-decision', 'arcfold_decide_work', decide(f.ctx.goals.get(agent), action));
      if (call === 3) return response(action === 'wait' ? '需要你选择材料后再继续。' : '当前核对阶段完成，长期求职目标仍保留。');
      assert.fail('terminal stage must not start another request');
    }, { business: true });
    agent = await f.agent(`terminal-${action}-main`);
    agent.followup(owner('执行当前材料核对阶段，阶段完成或需要选择时交代结果。'));
    await settled(f, agent);
    toolSucceeded(agent, 'terminal-stage-decision');
    assert.equal(f.adapter.requests.length, 3);
    assert.equal(automatic(agent).length, 0);
    assert.equal(f.ctx.goals.get(agent).activation, 'disarmed');
    if (action === 'complete') assert.equal(f.ctx.goals.get(agent).phase, 'complete');
    assert.ok(events(agent).some(e => e.type === 'turn/end' && e.data.reason?.kind === 'completed'), 'normal final delivery remains possible');
  });
}

for (const [label, extra] of [
  ['stage already complete', { stageDone: true }],
  ['user decision required', { needsUserDecision: true }],
  ['next step absent', { nextStep: '' }],
]) {
  test(`continue is rejected when ${label}`, async t => {
    let f, agent;
    f = await nativeFixture(t, async (_options, call) => {
      if (call === 1) return callResponse('start-invalid-continue', 'arcfold_start_work', stageInput);
      if (call === 2) return callResponse('invalid-continue', 'arcfold_decide_work', decide(f.ctx.goals.get(agent), 'continue', extra));
      if (call === 3) return response('本轮到此，等待明确下一步。');
      assert.fail('invalid continuation fields must not grant execution');
    }, { business: true });
    agent = await f.agent('invalid-continue-main');
    agent.followup(owner('核对当前材料，完成或需要我决定时停下。'));
    await settled(f, agent);
    toolRejected(agent, 'invalid-continue');
    assert.equal(f.adapter.requests.length, 3);
    assert.equal(f.ctx.goals.get(agent).activation, 'disarmed');
    assert.equal(automatic(agent).length, 0);
  });
}

test('a wait decision is standalone and successful wait rejects all later tool effects in that turn', async t => {
  let f, agent, writer;
  f = await nativeFixture(t, async (_options, call) => {
    if (call === 1) return callResponse('start-batch-stage', 'arcfold_start_work', stageInput);
    if (call === 2) return multiCalls([
      { id: 'mixed-wait', name: 'arcfold_decide_work', arguments: decide(f.ctx.goals.get(agent), 'wait') },
      { id: 'mixed-write', name: 'fixture_write_stage_result', arguments: {} },
    ]);
    if (call === 3) return callResponse('clean-wait', 'arcfold_decide_work', decide(f.ctx.goals.get(agent), 'wait'));
    if (call === 4) return callResponse('after-wait-write', 'fixture_write_stage_result', {});
    if (call === 5) return response('已停下，等待你的选择。');
    assert.fail('no continuation after wait');
  }, { business: true });
  agent = await f.agent('terminal-tool-fence-main'); writer = registerWrite(f, agent);
  agent.followup(owner('核对已有材料，需要选择时先等我。'));
  await settled(f, agent);
  for (const id of ['mixed-wait', 'mixed-write', 'after-wait-write']) toolRejected(agent, id);
  toolSucceeded(agent, 'clean-wait');
  assert.equal(writer.writes(), 0);
  assert.equal(existsSync(writer.destination), false);
  assert.equal(automatic(agent).length, 0);
  assert.equal(f.adapter.requests.length, 5);
});

test('native remote edit and resume cannot activate a stage outside Arcfold control', async t => {
  let f, agent;
  f = await nativeFixture(t, async (_options, call) => {
    if (call === 1) return callResponse('start-remote-stage', 'arcfold_start_work', stageInput);
    if (call === 2) return response('本轮阶段准备已完成。');
    assert.fail('native remote control does not provide an Arcfold continuation decision');
  }, { business: true });
  agent = await f.agent('remote-fence-main');
  agent.followup(owner('只推进眼前的材料核对阶段。'));
  await settled(f, agent);
  const remote = await nativeRemote(f);
  await remote('edit', agent, nativeReference(f.ctx.goals.get(agent)), { objective: 'Expand to a new unrelated task.' });
  assert.equal(f.ctx.goals.get(agent).activation, 'disarmed');
  await remote('resume', agent, nativeReference(f.ctx.goals.get(agent)));
  await settled(f, agent);
  assert.equal(f.ctx.goals.get(agent).activation, 'disarmed');
  assert.equal(f.adapter.requests.length, 2);
  assert.equal(automatic(agent).length, 0);
  assert.ok(events(agent).some(e => e.type === 'goal/change' && e.data.operation === 'edit'), 'actual remote mutation is retained as a fact');
  assert.ok(events(agent).some(e => e.type === 'goal/change' && e.data.operation === 'resume'), 'actual remote resume is fenced after native commit');
});

test('a newly queued owner input invalidates the previous unconsumed continue decision', async t => {
  let f, agent;
  const finalStarted = Promise.withResolvers(), releaseFinal = Promise.withResolvers();
  f = await nativeFixture(t, async (options, call) => {
    if (call === 1) return callResponse('start-concurrent-stage', 'arcfold_start_work', stageInput);
    if (call === 2) return callResponse('permit-before-user', 'arcfold_decide_work', decide(f.ctx.goals.get(agent), 'continue'));
    if (call === 3) { finalStarted.resolve(); await waitGate(releaseFinal, options.signal); return response('已核对第一项。'); }
    if (call === 4) return response('先回答你刚才的新问题；当前阶段等进一步决定。');
    assert.fail('old continue decision must not survive a new owner turn');
  }, { business: true });
  agent = await f.agent('new-input-fence-main');
  agent.followup(owner('先持续核对这两份材料。'));
  await bounded(finalStarted.promise, 'continue decision exists before final text');
  agent.followup(owner('等一下，先解释材料来源的含义。'));
  releaseFinal.resolve();
  await settled(f, agent);
  assert.equal(f.adapter.requests.length, 4);
  assert.equal(automatic(agent).length, 0);
  assert.equal(f.ctx.goals.get(agent).activation, 'disarmed');
});

async function heldAutomaticStage(t, id) {
  let f, agent, mode = 'initial';
  const started = Promise.withResolvers(), held = Promise.withResolvers();
  let initial = 0, later = async () => assert.fail('no implicit resumed provider request');
  f = await nativeFixture(t, async options => {
    if (mode !== 'initial') return later(options);
    initial++;
    if (initial === 1) return callResponse('start-held-stage', 'arcfold_start_work', stageInput);
    if (initial === 2) return callResponse('permit-held-round', 'arcfold_decide_work', decide(f.ctx.goals.get(agent), 'continue'));
    if (initial === 3) return response('接着执行当前核对阶段。');
    if (initial === 4) { started.resolve(); await waitGate(held, options.signal); return response('unreachable until the held request is released'); }
    assert.fail('unexpected initial provider request');
  }, { business: true });
  agent = await f.agent(id);
  agent.followup(owner('持续核对现有材料，可以在当前阶段独立准备，暂停时停下。'));
  await bounded(started.promise, 'first permitted automatic request begins');
  return { ...f, agent, held, setScript(fn) { mode = 'later'; later = fn; } };
}

test('pause, a genuine later owner resume, and a fresh continue decision preserve the same bounded stage', async t => {
  const f = await heldAutomaticStage(t, 'pause-resume-stage-main');
  const { agent } = f, remote = await nativeRemote(f);
  const originalId = f.ctx.goals.get(agent).id;
  await remote('pause', agent, nativeReference(f.ctx.goals.get(agent)));
  f.held.resolve(); await settled(f, agent);
  assert.equal(f.ctx.goals.get(agent).phase, 'paused');
  let afterResume = 0;
  f.setScript(async () => {
    afterResume++;
    if (afterResume === 1) return callResponse('owner-resume-stage', 'arcfold_resume_work', reference(f.ctx.goals.get(agent)));
    if (afterResume === 2) return callResponse('fresh-resume-permit', 'arcfold_decide_work', decide(f.ctx.goals.get(agent), 'continue'));
    if (afterResume === 3) return response('按原范围继续当前阶段。');
    if (afterResume === 4) return callResponse('complete-resumed-stage', 'arcfold_decide_work', decide(f.ctx.goals.get(agent), 'complete'));
    if (afterResume === 5) return response('当前阶段完成。');
    assert.fail('completed resumed stage cannot repeat');
  });
  agent.followup(owner('继续刚才暂停的核对阶段，范围保持不变。'));
  await eventually(() => f.ctx.goals.get(agent)?.phase === 'complete' && agent.status === 'idle', 'freshly authorized resumed stage completes');
  await settled(f, agent);
  for (const id of ['owner-resume-stage', 'fresh-resume-permit', 'complete-resumed-stage']) toolSucceeded(agent, id);
  assert.equal(f.ctx.goals.get(agent).id, originalId);
  assert.equal(afterResume, 5);
  assert.equal(automatic(agent).length, 2);
});

test('cold restoration of an interrupted active stage does not reuse the already saved continuation decision', async t => {
  const f = await heldAutomaticStage(t, 'cold-stage-main');
  const original = f.agent;
  assert.equal(await f.ctx.sessions.flush(original.session), true);
  await f.release(original); f.held.resolve();
  const before = f.adapter.requests.length;
  f.setScript(async () => assert.fail('cold resume must not send a new model request'));
  const restored = await f.resume(original.id);
  await settled(f, restored);
  assert.equal(f.ctx.goals.get(restored).activation, 'disarmed');
  assert.equal(f.adapter.requests.length, before);
  assert.equal(automatic(restored).length, 1, 'only the pre-restart admitted round remains in history');
});

test('a real legacy delegation requires an explicit stage revision and later resume, preserving its original history', async t => {
  let f, agent, mode = 'legacy', count = 0;
  const revised = { ...stageInput, objective: '只核对第一份材料的出处。', doneWhen: '第一份材料的出处已核实并回读记录。' };
  f = await nativeFixture(t, async () => {
    count++;
    if (mode === 'legacy') {
      if (count === 1) return callResponse('old-create', 'create_goal', { objective: 'Prepare the whole application over time.', max_goal_rounds: 3 });
      if (count === 2) return callResponse('old-pause', 'update_goal', { ...reference(f.ctx.goals.get(agent)), action: 'pause' });
      if (count === 3) return response('旧版执行已暂停。');
    }
    if (mode === 'clarify') {
      if (count === 1) return callResponse('clarify-legacy-stage', 'arcfold_revise_work', { ...reference(f.ctx.goals.get(agent)), ...revised });
      if (count === 2) return response('当前阶段已明确，执行保持暂停。');
    }
    if (mode === 'resume') {
      if (count === 1) return callResponse('resume-legacy-stage', 'arcfold_resume_work', reference(f.ctx.goals.get(agent)));
      if (count === 2) return callResponse('permit-legacy-stage', 'arcfold_decide_work', decide(f.ctx.goals.get(agent), 'continue', { nextStep: '核对第一份材料出处。' }));
      if (count === 3) return response('按新的阶段定义继续。');
      if (count === 4) return callResponse('complete-legacy-stage', 'arcfold_decide_work', decide(f.ctx.goals.get(agent), 'complete'));
      if (count === 5) return response('第一份材料已核对。');
    }
    assert.fail('unexpected legacy or migrated-stage request');
  }, { business: true });
  await f.declare('legacy-native', [
    { name: import.meta.resolve('@deepseek-ai/dsh-tool-goal') },
  ]);
  agent = await f.agent('legacy-upgrade-main', 'legacy-native');
  agent.followup(owner('建立一项持续的申请准备工作，先暂停等待后续安排。'));
  await settled(f, agent);
  toolSucceeded(agent, 'old-create'); toolSucceeded(agent, 'old-pause');
  const originalId = f.ctx.goals.get(agent).id;
  const originalCreate = events(agent).find(e => e.type === 'goal/change' && e.data.operation === 'create');
  await f.release(agent);
  mode = 'clarify'; count = 0;
  agent = await f.resume(agent.id);
  assert.equal(f.adapter.requests.length, 3, 'upgrade alone does not start the old whole objective');
  agent.followup(owner('把当前阶段改成只核对第一份材料的出处，修改后保持暂停。'));
  await settled(f, agent);
  toolSucceeded(agent, 'clarify-legacy-stage');
  assert.equal(count, 2);
  assert.equal(f.ctx.goals.get(agent).id, originalId);
  assert.equal(f.ctx.goals.get(agent).objective, revised.objective);
  assert.equal(f.ctx.goals.get(agent).activation, 'disarmed');
  assert.equal(f.ctx.goals.get(agent).phase, 'paused');
  assert.equal(automatic(agent).length, 0);
  assert.deepEqual(events(agent).find(e => e.seq === originalCreate.seq), originalCreate, 'legacy creation is preserved unchanged');
  mode = 'resume'; count = 0;
  agent.followup(owner('继续刚才明确的第一份材料核对阶段。'));
  await eventually(() => f.ctx.goals.get(agent)?.phase === 'complete' && agent.status === 'idle', 'legacy stage completes under new authority');
  await settled(f, agent);
  toolSucceeded(agent, 'resume-legacy-stage'); toolSucceeded(agent, 'complete-legacy-stage');
  assert.equal(count, 5);
  assert.equal(automatic(agent).length, 1);
});

for (const [label, source] of [
  ['program input', { kind: 'fixture-program' }],
  ['foreign agent input', { kind: 'user', principal: { kind: 'agent', agentId: 'another-agent' } }],
]) {
  test(`${label} cannot establish a new execution stage`, async t => {
    const f = await nativeFixture(t, async (_options, call) => {
      if (call === 1) return callResponse('unowned-stage', 'arcfold_start_work', stageInput);
      if (call === 2) return response('需要真实用户的当前委托。');
      assert.fail('unowned input cannot authorize automatic work');
    }, { business: true });
    const agent = await f.agent('unowned-stage-main');
    agent.followup(owner('Create a new ongoing stage.', source));
    await settled(f, agent);
    toolRejected(agent, 'unowned-stage');
    assert.equal(f.adapter.requests.length, 2);
    assert.equal(f.ctx.goals.get(agent), undefined);
    assert.equal(f.ctx.arcfoldBusiness.storage.listAll('execution_stages').length, 0);
    assert.equal(automatic(agent).length, 0);
  });
}

test('withdrawal during the owner request after start prevents the returned write tool from taking effect', async t => {
  let f, agent;
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  f = await nativeFixture(t, async (options, call) => {
    if (call === 1) return callResponse('start-source-race', 'arcfold_start_work', stageInput);
    if (call === 2) {
      started.resolve(); await waitGate(release, options.signal);
      return callResponse('withdrawn-owner-write', 'fixture_write_stage_result', {});
    }
    if (call === 3) return response('本次委托已撤回，工作停下。');
    assert.fail('withdrawn owner authority cannot launch more work');
  }, { business: true });
  agent = await f.agent('owner-withdrawal-before-tool');
  const writer = registerWrite(f, agent), original = owner('核对现有材料并保存核对结果。');
  agent.followup(original);
  await bounded(started.promise, 'the provider request is in flight after the stage starts');
  let source;
  try {
    toolSucceeded(agent, 'start-source-race');
    source = sourceFor(f, original);
    assert.ok(f.ctx.arcfoldWork.current(agent).sourceRefs.some(ref => ref.id === source.id));
    f.ctx.arcfoldBusiness.storage.save('source_controls', { id: source.id, withdrawn: true,
      actor: 'user', reason: 'The owner withdrew this delegation while its next provider request was pending.' });
  } finally { release.resolve(); }
  await settled(f, agent);
  toolRejected(agent, 'withdrawn-owner-write');
  assert.equal(writer.writes(), 0); assert.equal(existsSync(writer.destination), false);
  assert.equal(automatic(agent).length, 0);
  assert.equal(f.ctx.goals.get(agent).activation, 'disarmed');
  assert.deepEqual(f.ctx.arcfoldBusiness.storage.get('events', source.id).message, original,
    'withdrawing authority preserves the original message');
});

for (const resume of [false, true]) {
  test(`owner steering inside an automatic round can revise and ${resume ? 'explicitly resume the new stage' : 'deliver an explanation while staying stopped'}`, async t => {
    let f, agent, firstAdmission;
    const started = Promise.withResolvers(), release = Promise.withResolvers();
    const revised = { ...stageInput, objective: '只整理第三份材料的来源记录。',
      doneWhen: '第三份材料的来源记录已保存并回读。',
      boundaries: '只整理第三份材料；第二份材料留待用户后续决定。' };
    const correction = owner(resume
      ? '调整当前阶段：只整理第三份材料，保存并回读来源记录，第二份以后再决定。按这个完整新阶段继续。'
      : '调整当前阶段：只整理第三份材料，保存并回读来源记录，第二份以后再决定。先修改定义并交代结果，保持停止。');
    const finalText = resume ? '第三份材料的来源记录已完成。' : '当前阶段已改为第三份材料，执行保持停止。';
    f = await nativeFixture(t, async (options, call) => {
      if (call === 1) return callResponse('start-steered-stage', 'arcfold_start_work', stageInput);
      if (call === 2) return callResponse('permit-before-steering', 'arcfold_decide_work', decide(f.ctx.goals.get(agent), 'continue'));
      if (call === 3) return response('继续本次材料核对阶段。');
      if (call === 4) {
        firstAdmission = structuredClone(f.ctx.arcfoldWork.current(agent).admission);
        assert.ok(firstAdmission); started.resolve(); await waitGate(release, options.signal);
        return response('这一项的初步核对已完成。');
      }
      if (call === 5) {
        assert.ok(options.messages.some(message => message.id === correction.id), 'the actual next step sees owner steering');
        return callResponse('revise-from-steering', 'arcfold_revise_work', { ...reference(f.ctx.goals.get(agent)), ...revised });
      }
      if (call === 6) {
        assert.equal(f.ctx.arcfoldWork.current(agent).objective, revised.objective);
        assert.equal(f.ctx.goals.get(agent).activation, 'disarmed');
        return callResponse('write-before-steered-resume', 'fixture_write_stage_result', {});
      }
      if (call === 7 && !resume) return response(finalText);
      if (call === 7) return callResponse('resume-steered-stage', 'arcfold_resume_work', reference(f.ctx.goals.get(agent)));
      if (call === 8) {
        assert.notDeepEqual(f.ctx.arcfoldWork.current(agent).admission, firstAdmission,
          'the old automatic admission cannot become authority for the new definition');
        return callResponse('write-after-steered-resume', 'fixture_write_stage_result', {});
      }
      if (call === 9) return callResponse('permit-steered-stage', 'arcfold_decide_work', decide(f.ctx.goals.get(agent), 'continue', {
        nextStep: '回读第三份材料的来源记录并判断该阶段是否完成。' }));
      if (call === 10) return response('第三份材料已记录，接着核对保存结果。');
      if (call === 11) return callResponse('complete-steered-stage', 'arcfold_decide_work', decide(f.ctx.goals.get(agent), 'complete'));
      if (call === 12) return response(finalText);
      assert.fail('steering never grants an implicit old or extra automatic round');
    }, { business: true });
    agent = await f.agent('steered-stage-' + resume);
    const writer = registerWrite(f, agent, 'verified third source');
    agent.followup(owner('持续核对这两份已有材料并保存来源记录。'));
    await bounded(started.promise, 'an admitted automatic round is in flight');
    try { agent.steer(correction); } finally { release.resolve(); }
    await eventually(() => f.adapter.requests.length >= (resume ? 12 : 7) && agent.status === 'idle', 'steered stage reaches its intended stop');
    await settled(f, agent);
    toolSucceeded(agent, 'revise-from-steering'); toolRejected(agent, 'write-before-steered-resume');
    const corrected = events(agent).find(event => event.type === 'user/message' && event.data.id === correction.id);
    const precedingTurn = events(agent).findLast(event => event.seq < corrected.seq && event.type === 'turn/start');
    assert.equal(precedingTurn.data.turn, firstAdmission.turn, 'owner correction enters the existing automatic turn');
    const stage = f.ctx.arcfoldWork.current(agent), source = sourceFor(f, correction);
    assert.equal(stage.objective, revised.objective);
    assert.deepEqual(stage.sourceRefs.map(ref => ref.id), [source.id]);
    assert.equal(f.ctx.goals.get(agent).activation, 'disarmed');
    assert.equal(f.adapter.requests.length, resume ? 12 : 7);
    assert.equal(automatic(agent).length, resume ? 2 : 1);
    assert.equal(writer.writes(), resume ? 1 : 0);
    assert.equal(existsSync(writer.destination), resume);
    if (resume) {
      for (const id of ['resume-steered-stage', 'write-after-steered-resume', 'permit-steered-stage', 'complete-steered-stage']) toolSucceeded(agent, id);
      assert.equal(f.ctx.goals.get(agent).phase, 'complete');
      assert.equal(readFileSync(writer.destination, 'utf8'), 'verified third source');
    } else {
      assert.equal(stage.status, 'waiting');
      assert.equal(events(agent).filter(event => event.type === 'goal/change' && event.data.operation === 'resume').length, 0);
    }
    assertDeliveredText(f, agent, finalText);
  });
}

test('a complete new owner stage can replace withdrawn old authority while preserving the old historical proof', async t => {
  let f, agent, oldSource;
  const withdrawnMarker = 'WITHDRAWN_ORIGINAL_DELEGATION_DO_NOT_REUSE';
  const original = owner(withdrawnMarker + '：持续核对第二份材料，先暂停。');
  const replacement = { ...stageInput, objective: '整理第三份材料的来源记录。',
    doneWhen: '第三份材料的来源记录已保存并检查。', boundaries: '只整理第三份材料；其他材料另行决定。' };
  const fresh = owner('当前完整委托：只整理第三份材料，保存来源记录并检查；其他材料另行决定。请修改当前阶段并继续这一项工作。');
  f = await nativeFixture(t, async (options, call) => {
    if (call === 1) return callResponse('start-to-be-withdrawn', 'arcfold_start_work', { ...stageInput, objective: withdrawnMarker });
    if (call === 2) return callResponse('wait-before-withdrawal', 'arcfold_decide_work', decide(f.ctx.goals.get(agent), 'wait'));
    if (call === 3) return response('之前的委托已暂停。');
    if (call === 4) return callResponse('replace-withdrawn-stage', 'arcfold_revise_work', { ...reference(f.ctx.goals.get(agent)), ...replacement });
    if (call === 5) return callResponse('resume-fresh-authority', 'arcfold_resume_work', reference(f.ctx.goals.get(agent)));
    if (call === 6) return callResponse('write-fresh-authority', 'fixture_write_stage_result', {});
    if (call === 7) return callResponse('permit-fresh-authority', 'arcfold_decide_work', decide(f.ctx.goals.get(agent), 'continue', {
      nextStep: '检查第三份材料已保存的来源记录。' }));
    if (call === 8) return response('第三份材料记录已保存，接着检查结果。');
    if (call === 9) {
      const background = options.messages.find(message => message.source?.kind === 'arcfold/context');
      assert.ok(background);
      assert.equal(JSON.stringify(background).includes(withdrawnMarker), false,
        'the active Arcfold background does not reuse the withdrawn original');
      const stage = f.ctx.arcfoldWork.current(agent);
      assert.equal(stage.objective, replacement.objective);
      assert.deepEqual(stage.sourceRefs.map(ref => ref.id), [sourceFor(f, fresh).id]);
      assert.ok(stage.sourceRefs.every(ref => ref.id !== oldSource.id));
      return callResponse('complete-fresh-authority', 'arcfold_decide_work', decide(f.ctx.goals.get(agent), 'complete'));
    }
    if (call === 10) return response('按新委托完成第三份材料的来源记录。');
    assert.fail('withdrawn or completed work is never replayed');
  }, { business: true });
  agent = await f.agent('fresh-stage-after-source-withdrawal');
  const writer = registerWrite(f, agent, 'verified third source'); agent.followup(original);
  await settled(f, agent);
  toolSucceeded(agent, 'start-to-be-withdrawn'); toolSucceeded(agent, 'wait-before-withdrawal');
  const store = f.ctx.arcfoldBusiness.storage, originalId = f.ctx.goals.get(agent).id;
  oldSource = sourceFor(f, original);
  const oldPrefix = structuredClone(events(agent)), oldDelivery = structuredClone(store.listAll('deliveries')[0]);
  store.save('source_controls', { id: oldSource.id, withdrawn: true, actor: 'user', reason: 'Replace this old delegation with a complete new one.' });
  agent.followup(fresh);
  await eventually(() => f.adapter.requests.length >= 10 && f.ctx.goals.get(agent)?.phase === 'complete' && agent.status === 'idle',
    'the new independent stage completes under fresh owner authority');
  await settled(f, agent);
  for (const id of ['replace-withdrawn-stage', 'resume-fresh-authority', 'write-fresh-authority', 'permit-fresh-authority', 'complete-fresh-authority'])
    toolSucceeded(agent, id);
  assert.equal(f.ctx.goals.get(agent).id, originalId);
  assert.equal(f.adapter.requests.length, 10); assert.equal(automatic(agent).length, 1);
  assert.equal(writer.writes(), 1); assert.equal(readFileSync(writer.destination, 'utf8'), 'verified third source');
  assert.deepEqual(events(agent).slice(0, oldPrefix.length), oldPrefix, 'the old native history stays immutable');
  assert.deepEqual(store.get('events', oldSource.id).message, original, 'the withdrawn original remains inspectable as history');
  assert.deepEqual(store.get('deliveries', oldDelivery.id), oldDelivery, 'the old delivered fact is preserved');
  assert.equal(store.get('source_controls', oldSource.id).withdrawn, true);
  assert.deepEqual(f.ctx.arcfoldWork.view(f.ctx.arcfoldWork.current(agent)).sources.map(source => source.id), [sourceFor(f, fresh).id]);
  assertDeliveredText(f, agent, '按新委托完成第三份材料的来源记录。');
});

test('browser resume waits for its durable applied receipt before a native round reaches the model', async t => {
  let f, agent;
  const requestId = 'resume-with-delayed-durable-receipt';
  f = await nativeFixture(t, async (_options, call) => {
    if (call === 1) return callResponse('start-browser-receipt', 'arcfold_start_work', stageInput);
    if (call === 2) return callResponse('wait-browser-receipt', 'arcfold_decide_work', decide(f.ctx.goals.get(agent), 'wait'));
    if (call === 3) return response('当前阶段已停下，等待网页中的新决定。');
    if (call === 4) {
      const controls = f.ctx.arcfoldBusiness.storage.listAll('goal_work_controls').filter(row => row.request.requestId === requestId);
      assert.equal(controls.length, 1); assert.equal(controls[0].state, 'applied', 'model dispatch requires a confirmed browser decision');
      return callResponse('complete-browser-resume', 'arcfold_decide_work', decide(f.ctx.goals.get(agent), 'complete'));
    }
    if (call === 5) return response('网页明确恢复的当前阶段已完成。');
    assert.fail('one browser resume cannot authorize repeated automatic rounds');
  }, { business: true });
  agent = await f.agent('browser-receipt-before-admission');
  agent.followup(owner('执行当前核对阶段；停下后等我在网页中恢复。'));
  await settled(f, agent);
  const store = f.ctx.arcfoldBusiness.storage, goal = f.ctx.goals.get(agent);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const originalFlush = f.ctx.sessions.flush.bind(f.ctx.sessions);
  t.mock.method(f.ctx.sessions, 'flush', async session => {
    if (session === agent.session && store.listAll('goal_work_controls').some(row => row.request.requestId === requestId && row.state === 'pending')) {
      entered.resolve(); await release.promise;
    }
    return originalFlush(session);
  });
  const control = f.ctx.arcfoldGoals.controlWork({ sessionId: agent.id,
    workId: store.listAll('goal_works', { where: { sessionId: agent.id } })[0].id,
    nativeGoalId: goal.id, nativeRevision: goal.revision, requestId, userIdentity: 'fixture-browser-owner', action: 'resume', agent });
  try {
    await bounded(entered.promise, 'browser decision is pending at the real persistence barrier');
    assert.equal(store.listAll('goal_work_controls').find(row => row.request.requestId === requestId).state, 'pending');
    assert.equal(f.adapter.requests.length, 3, 'pending browser authority has not dispatched a model request');
    assert.equal(automatic(agent).length, 0, 'pending browser authority has not admitted an automatic message');
  } finally { release.resolve(); }
  const receipt = await bounded(control, 'browser resume obtains its durable receipt');
  assert.equal(receipt.state, 'applied');
  await eventually(() => f.ctx.goals.get(agent)?.phase === 'complete' && agent.status === 'idle', 'confirmed browser resume completes one real round');
  await settled(f, agent);
  toolSucceeded(agent, 'complete-browser-resume');
  assert.equal(f.adapter.requests.length, 5); assert.equal(automatic(agent).length, 1);
  assert.equal(events(agent).filter(event => event.type === 'goal/change' && event.data.operation === 'resume').length, 1);
  assert.equal(store.get('goal_work_controls', receipt.decisionId).state, 'applied');
  assertDeliveredText(f, agent, '网页明确恢复的当前阶段已完成。');
});

test('a late continue response cannot survive owner steering received while that response was being generated', async t => {
  let f, agent;
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  const correction = owner('先停下当前核对工作，只解释你刚才整理的材料范围。');
  const finalText = '当前核对工作已停下，先解释材料范围。';
  f = await nativeFixture(t, async (options, call) => {
    if (call === 1) return callResponse('start-late-continue', 'arcfold_start_work', stageInput);
    if (call === 2) {
      assert.equal(options.messages.some(message => message.id === correction.id), false);
      const args = decide(f.ctx.goals.get(agent), 'continue');
      started.resolve(); await waitGate(release, options.signal);
      return callResponse('late-continue-after-steering', 'arcfold_decide_work', args);
    }
    if (call === 3) {
      assert.ok(options.messages.some(message => message.id === correction.id));
      return response(finalText);
    }
    assert.fail('a decision generated before the new owner requirement cannot schedule an automatic round');
  }, { business: true });
  agent = await f.agent('late-continue-after-owner-steering');
  agent.followup(owner('持续核对两份材料并保存来源记录。'));
  await bounded(started.promise, 'the current provider is generating its continuation decision');
  try { agent.steer(correction); } finally { release.resolve(); }
  await settled(f, agent);
  toolSucceeded(agent, 'start-late-continue'); toolRejected(agent, 'late-continue-after-steering');
  const received = events(agent).find(event => event.type === 'agent/inbox/spliced' &&
    event.data.inserted?.some(message => message.id === correction.id));
  const lateCall = events(agent).find(event => event.type === 'tool/call' && event.data.callId === 'late-continue-after-steering');
  const claimed = events(agent).find(event => event.type === 'user/message' && event.data.id === correction.id);
  assert.ok(received.seq < lateCall.seq && lateCall.seq < claimed.seq, 'the old provider result races ahead of claiming the new steering');
  assert.equal(f.adapter.requests.length, 3); assert.equal(automatic(agent).length, 0);
  assert.equal(f.ctx.goals.get(agent).activation, 'disarmed');
  assert.equal(f.ctx.arcfoldWork.current(agent).permit, null);
  assertDeliveredText(f, agent, finalText);
});

test('native clear during the first owner turn rejects a late write returned after stage creation', async t => {
  let f, agent;
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  f = await nativeFixture(t, async (options, call) => {
    if (call === 1) return callResponse('start-before-native-clear', 'arcfold_start_work', stageInput);
    if (call === 2) {
      started.resolve(); await waitGate(release, options.signal);
      return callResponse('late-write-after-native-clear', 'fixture_write_stage_result', {});
    }
    if (call === 3) return response('当前执行已清除，后续工作等待新的委托。');
    assert.fail('a cleared goal cannot authorize an automatic request');
  }, { business: true });
  agent = await f.agent('clear-while-owner-request-pending');
  const writer = registerWrite(f, agent);
  agent.followup(owner('核对当前材料并保存来源记录。'));
  await bounded(started.promise, 'a write response is in flight after the stage starts');
  let goal, tombstone;
  try {
    toolSucceeded(agent, 'start-before-native-clear');
    goal = f.ctx.goals.get(agent);
    tombstone = f.ctx.goals.clear(agent, nativeReference(goal));
    assert.equal(f.ctx.goals.get(agent), undefined);
  } finally { release.resolve(); }
  await settled(f, agent);
  toolRejected(agent, 'late-write-after-native-clear');
  assert.equal(writer.writes(), 0); assert.equal(existsSync(writer.destination), false);
  assert.equal(automatic(agent).length, 0); assert.equal(f.ctx.goals.get(agent), undefined);
  assert.deepEqual(tombstone, { id: goal.id, revision: goal.revision + 1 });
  assert.equal(events(agent).filter(event => event.type === 'goal/change' && event.data.operation === 'clear').length, 1,
    'the real native clearing event is retained');
});

test('revising after three used native rounds grants the new default stage three fresh rounds', async t => {
  let f, agent;
  const revised = {
    objective: '整理第三份材料的来源记录。', doneWhen: '第三份材料的来源记录已保存并回读。',
    boundaries: '只整理第三份材料；其他材料另行决定。',
  };
  f = await nativeFixture(t, async (_options, call) => {
    if (call === 1) return callResponse('start-three-round-stage', 'arcfold_start_work', stageInput);
    if ([2, 4, 6].includes(call)) return callResponse('permit-old-stage-' + call, 'arcfold_decide_work',
      decide(f.ctx.goals.get(agent), 'continue'));
    if ([3, 5, 7].includes(call)) return response('继续当前阶段内下一项核对。');
    if (call === 8) return response('本阶段已用完三轮，停下等待下一步安排。');
    if (call === 9) return callResponse('revise-exhausted-stage', 'arcfold_revise_work', { ...reference(f.ctx.goals.get(agent)), ...revised });
    if (call === 10) {
      const goal = f.ctx.goals.get(agent);
      assert.equal(goal.roundsStarted, 3, 'native history retains the three previously admitted rounds');
      assert.equal(goal.maxGoalRounds - goal.roundsStarted, 3, 'the omitted new-stage limit grants its default three remaining rounds');
      assert.equal(f.ctx.goals.get(agent).activation, 'disarmed', 'revision alone stays stopped');
      return callResponse('resume-new-three-round-stage', 'arcfold_resume_work', reference(goal));
    }
    if (call === 11) return callResponse('permit-new-three-round-stage', 'arcfold_decide_work', decide(f.ctx.goals.get(agent), 'continue', {
      nextStep: '保存第三份材料的来源记录。' }));
    if (call === 12) return response('开始新明确的第三份材料阶段。');
    if (call === 13) return callResponse('write-after-round-budget-reset', 'fixture_write_stage_result', {});
    if (call === 14) return callResponse('complete-new-three-round-stage', 'arcfold_decide_work', decide(f.ctx.goals.get(agent), 'complete'));
    if (call === 15) return response('第三份材料的来源记录已完成。');
    assert.fail('completed new stage does not reuse unused remaining rounds');
  }, { business: true });
  agent = await f.agent('fresh-rounds-after-stage-revision');
  const writer = registerWrite(f, agent, 'verified third source');
  agent.followup(owner('持续推进当前材料核对阶段，最多三轮后停下。'));
  await eventually(() => f.adapter.requests.length === 8 && agent.status === 'idle', 'the first stage spends three actual native rounds');
  await settled(f, agent);
  const originalId = f.ctx.goals.get(agent).id;
  assert.equal(f.ctx.goals.get(agent).roundsStarted, 3); assert.equal(automatic(agent).length, 3);
  assert.equal(f.ctx.goals.get(agent).activation, 'disarmed');
  agent.followup(owner('现在把当前阶段改成只整理第三份材料，保存并回读来源记录；其他材料另行决定。继续执行这个新阶段。'));
  await eventually(() => f.ctx.goals.get(agent)?.phase === 'complete' && agent.status === 'idle', 'a resumed new stage executes a real fourth cumulative native round');
  await settled(f, agent);
  for (const id of ['revise-exhausted-stage', 'resume-new-three-round-stage', 'permit-new-three-round-stage', 'write-after-round-budget-reset', 'complete-new-three-round-stage'])
    toolSucceeded(agent, id);
  assert.equal(f.ctx.goals.get(agent).id, originalId);
  assert.equal(f.ctx.goals.get(agent).roundsStarted, 4); assert.equal(automatic(agent).length, 4);
  assert.equal(f.adapter.requests.length, 15); assert.equal(writer.writes(), 1);
  assert.equal(readFileSync(writer.destination, 'utf8'), 'verified third source');
  assertDeliveredText(f, agent, '第三份材料的来源记录已完成。');
});

test('a browser resume whose stage write failed stays unknown when the same request is queried', async t => {
  let f, agent;
  f = await nativeFixture(t, async (_options, call) => {
    if (call === 1) return callResponse('start-before-resume-write-failure', 'arcfold_start_work', stageInput);
    if (call === 2) return callResponse('wait-before-resume-write-failure', 'arcfold_decide_work', decide(f.ctx.goals.get(agent), 'wait'));
    if (call === 3) return response('当前阶段已暂停，等待明确恢复。');
    assert.fail('an incomplete browser resume must neither dispatch work nor replay on inquiry');
  }, { business: true });
  agent = await f.agent('resume-stage-save-failure');
  agent.followup(owner('核对当前材料，先暂停等待网页恢复。'));
  await settled(f, agent);
  const store = f.ctx.arcfoldBusiness.storage, goal = f.ctx.goals.get(agent);
  const request = { sessionId: agent.id,
    workId: store.listAll('goal_works', { where: { sessionId: agent.id } })[0].id,
    nativeGoalId: goal.id, nativeRevision: goal.revision, requestId: 'resume-stage-write-fails-once',
    userIdentity: 'fixture-browser-owner', action: 'resume', agent };
  let failures = 0;
  const save = store.save.bind(store);
  const mockedSave = t.mock.method(store, 'save', (kind, row, ...rest) => {
    if (kind === 'execution_stages' && row.status === 'running' && row.resumedBy?.kind === 'browser' && failures === 0) {
      failures++;
      throw new Error('Injected stage persistence failure after native resume committed');
    }
    return save(kind, row, ...rest);
  });
  const first = await bounded(f.ctx.arcfoldGoals.controlWork(request), 'the partially persisted browser resume returns a receipt');
  mockedSave.mock.restore();
  await settled(f, agent);
  assert.equal(failures, 1); assert.equal(first.state, 'unknown');
  assert.equal(events(agent).filter(event => event.type === 'goal/change' && event.data.operation === 'resume').length, 1);
  assert.equal(f.ctx.arcfoldWork.current(agent).permit, null,
    'the native resume event cannot grant a ticket when its stage transition was not saved');
  const observed = await bounded(f.ctx.arcfoldGoals.controlWork(request), 'same browser request observes the incomplete result');
  await settled(f, agent);
  assert.equal(observed.decisionId, first.decisionId); assert.equal(observed.state, 'unknown');
  assert.notEqual(store.get('goal_work_controls', first.decisionId).state, 'applied',
    'a native event alone is not evidence that the complete Arcfold control was applied');
  assert.equal(f.ctx.goals.get(agent).activation, 'disarmed');
  assert.equal(events(agent).filter(event => event.type === 'goal/change' && event.data.operation === 'resume').length, 1,
    'querying the original request never replays the mutation');
  assert.equal(f.adapter.requests.length, 3); assert.equal(automatic(agent).length, 0);
});

test('a completed local stage can repair a contradictory completion decision in the same native turn while its long-term goal stays tracking', async t => {
  let f, agent, writer, longGoal, beforeDecision;
  const stage = { ...stageInput, objective: '在本地保存第三份材料的来源记录。',
    doneWhen: '本地来源记录已保存。', boundaries: '保存记录即完成当前阶段；长期研究的下一阶段另行讨论。' };
  const finalText = '本地记录已保存，当前阶段完成。下一阶段等你决定，长期研究目标继续保留。';
  f = await nativeFixture(t, async (options, call) => {
    if (call === 1) return response('长期研究方向已记录，具体阶段分别确认。');
    if (call === 2) {
      const text = options.messages.find(message => message.source?.kind === 'arcfold/context').content[0].text;
      const shown = JSON.parse(text.slice(text.indexOf('\n') + 1)).goals.find(goal => goal.id === longGoal.id);
      assert.ok(shown, 'the native request contains the existing long-term goal');
      return callResponse('link-completion-repair-goal', 'arcfold_link_goal', { selection: {
        id: shown.id, revision: shown.revision, definitionVersion: shown.definitionVersion,
        contentHash: shown.contentHash, sourceIds: shown.sourceIds,
        reason: '保存第三份材料的出处，为长期研究留下可回查的依据。',
      } });
    }
    if (call === 3) {
      assert.ok(options.messages.some(message => message.source?.kind === 'arcfold/linked-goal'));
      return callResponse('start-completion-repair-stage', 'arcfold_start_work', stage);
    }
    if (call === 4) return callResponse('write-completion-repair-result', 'fixture_write_stage_result', {});
    if (call === 5) {
      toolSucceeded(agent, 'write-completion-repair-result');
      assert.equal(writer.writes(), 1); assert.equal(readFileSync(writer.destination, 'utf8'), 'verified third source');
      beforeDecision = { stage: structuredClone(f.ctx.arcfoldWork.current(agent)), native: structuredClone(f.ctx.goals.get(agent)),
        decisions: structuredClone(f.ctx.arcfoldBusiness.storage.listAll('stage_decisions')) };
      assert.deepEqual(beforeDecision.stage.goalRef, { id: longGoal.id, definitionVersion: longGoal.definitionVersion });
      assert.equal(beforeDecision.stage.status, 'running'); assert.equal(beforeDecision.stage.permit, null);
      return callResponse('contradictory-completion', 'arcfold_decide_work', decide(f.ctx.goals.get(agent), 'complete', {
        needsUserDecision: true, reason: '本地记录已完成，但长期研究的下一阶段还需用户决定。',
      }));
    }
    if (call === 6) {
      const error = options.messages.find(message => message.role === 'tool' && message.toolCallId === 'contradictory-completion');
      assert.ok(error && error.isError, 'the next actual model request receives the rejected tool result');
      const explanation = error.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      assert.match(explanation, /needsUserDecision=false/);
      assert.match(explanation, /当前阶段/);
      assert.deepEqual(f.ctx.arcfoldWork.current(agent), beforeDecision.stage, 'the invalid decision leaves the entire stage unchanged');
      assert.deepEqual(f.ctx.goals.get(agent), beforeDecision.native, 'the invalid decision leaves native execution unchanged');
      assert.deepEqual(f.ctx.arcfoldBusiness.storage.listAll('stage_decisions'), beforeDecision.decisions,
        'the rejected completion records no decision or continuation authority');
      return callResponse('corrected-completion', 'arcfold_decide_work', decide(f.ctx.goals.get(agent), 'complete', {
        needsUserDecision: false, reason: '当前阶段只要求保存本地记录，已完成；下一研究阶段的选择留待后续交流。',
      }));
    }
    if (call === 7) return response(finalText);
    assert.fail('correcting completion must not start another automatic round or repeat the finished local work');
  }, { business: true });
  agent = await f.agent('same-turn-completion-repair');
  writer = registerWrite(f, agent, 'verified third source');
  const original = owner('我想长期整理研究材料，逐步形成有依据的研究说明；各个阶段的取舍后续再讨论。');
  agent.followup(original); await settled(f, agent);
  const store = f.ctx.arcfoldBusiness.storage, source = sourceFor(f, original);
  // Seed existing understanding from the real first-turn original. Native
  // control, tool and completion events below all come from the official host.
  longGoal = saveGoalTransition(store, null, { id: 'completion-repair-long-goal', title: '形成有依据的研究说明',
    outcome: '长期整理研究材料并逐步形成可核查的判断。', status: 'tracking', definitionVersion: 1,
    scope: {}, userControl: null, sourceIds: [source.id],
    dependencies: [{ kind: 'events', id: source.id, revision: source.revision }],
    progress: { content: '方向已明确，后续阶段仍需讨论。', sourceIds: [source.id],
      dependencies: [{ kind: 'events', id: source.id, revision: source.revision }] }, relations: [],
  }, { commandId: 'fixture-existing-long-goal', pendingId: null, reason: 'fixture-preexisting-understanding' });
  const originalGoal = structuredClone(longGoal);
  agent.followup(owner('现在这一阶段只把第三份材料的来源记录保存在本地。保存后结束当前阶段，下个研究方向等我再决定。'));
  await settled(f, agent);
  for (const id of ['link-completion-repair-goal', 'start-completion-repair-stage', 'write-completion-repair-result', 'corrected-completion'])
    toolSucceeded(agent, id);
  toolRejected(agent, 'contradictory-completion');
  const invalid = events(agent).find(event => event.type === 'tool/call' && event.data.callId === 'contradictory-completion');
  const corrected = events(agent).find(event => event.type === 'tool/call' && event.data.callId === 'corrected-completion');
  assert.equal(invalid.data.turn, corrected.data.turn, 'the ordinary main Agent repairs the error within its current turn');
  assert.equal(f.adapter.requests.length, 7); assert.equal(writer.writes(), 1); assert.equal(automatic(agent).length, 0);
  assert.equal(f.ctx.goals.get(agent).phase, 'complete'); assert.equal(f.ctx.goals.get(agent).activation, 'disarmed');
  assert.equal(f.ctx.arcfoldWork.current(agent).status, 'completed'); assert.equal(f.ctx.arcfoldWork.current(agent).permit, null);
  assert.equal(store.listAll('stage_decisions').length, 1); assert.equal(store.listAll('stage_decisions')[0].action, 'complete');
  assert.deepEqual(store.get('goals', longGoal.id), originalGoal, 'stage completion preserves the linked long-term goal and its recorded progress');
  assert.equal(store.get('goals', longGoal.id).status, 'tracking');
  assertDeliveredText(f, agent, finalText);
});
