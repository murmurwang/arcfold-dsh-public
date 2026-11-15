import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act, useSyncExternalStore } from 'react';
import { JSDOM } from 'jsdom';
import { GoalDock } from '../packages/method-ui/src/GoalDock.mjs';
import { createGoalSource } from '../packages/method-ui/src/goal-source.mjs';
import { zh } from '../packages/method-ui/src/locales.mjs';
import { goalZh } from '../packages/method-ui/src/goal-locales.mjs';

const work = extra => ({ id: 'work-1', sessionId: 'main', nativeGoalId: 'native-1', nativeRevision: 3,
  objective: '核对原始材料 <script>不应执行</script>', phase: 'active', activation: 'disarmed',
  roundsStarted: 2, maxGoalRounds: 6, relation: null, provenance: 'legacy-unverified', canStop: true, ...extra });

async function fixture(t, overrides = {}) {
  const page = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' });
  const values = { window: page.window, document: page.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const prior = Object.fromEntries(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const { createRoot } = await import('react-dom/client'), root = createRoot(document.getElementById('root'));
  t.after(async () => {
    await act(() => root.unmount()); page.window.close();
    for (const [key, descriptor] of Object.entries(prior)) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
  });
  let state = { loading: false, error: null, items: [], works: [work()], total: 0, offset: 0, nextOffset: null };
  const listeners = new Set(), calls = [], copy = { ...zh, ...goalZh };
  const useGoals = select => select(useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => state));
  const props = { useGoals, t: key => { assert.ok(copy[key], key); return copy[key]; },
    onGoalRefresh: async () => { calls.push({ kind: 'refresh' }); }, onGoalPage: async () => {},
    onGoalStopWork: async value => { calls.push({ kind: 'stop', value }); return { state: 'applied' }; },
    onGoalResumeWork: async value => { calls.push({ kind: 'resume', value }); return { state: 'applied' }; }, ...overrides };
  await act(async () => root.render(React.createElement(GoalDock, props)));
  const click = async label => {
    const button = [...document.querySelectorAll('button')].find(node => node.textContent === label);
    assert.ok(button, label); await act(async () => button.click());
  };
  await click(goalZh.goalOpen);
  return { calls, click, update: async next => act(async () => { state = { ...state, ...next }; for (const listener of listeners) listener(); }) };
}

test('goal view presents native work without inventing a goal link or treating disarmed work as running', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.calls, []);
  for (const text of [work().objective, goalZh.goalStageReview, goalZh.goalWorkLegacy, goalZh.goalWorkUnlinked])
    assert.ok(document.body.textContent.includes(text), text);
  assert.equal(document.querySelectorAll('script,input,textarea,select').length, 0);
  assert.equal(document.body.textContent.includes(goalZh.goalWorkEnabled), false);
  await f.update({ works: [work({ phase: 'complete', activation: 'disarmed', canStop: false, provenance: 'verified-native-delegation',
    relation: { goalId: 'goal-1', definitionVersion: 1, reason: 'REVOKED_CONTEXT', state: 'unavailable' } })] });
  assert.ok(document.body.textContent.includes(goalZh.goalWorkComplete));
  assert.ok(document.body.textContent.includes(goalZh.goalWorkVerified));
  assert.ok(document.body.textContent.includes(goalZh.goalRelationUnavailable));
  assert.equal(document.body.textContent.includes('REVOKED_CONTEXT'), false);
  assert.equal([...document.querySelectorAll('button')].some(node => node.textContent === goalZh.goalWorkStop), false);
  assert.deepEqual(f.calls, []);
  await f.update({ works: [work({ phase: 'cleared', provenance: 'source-unavailable', canStop: false, canResume: false })] });
  assert.ok(document.body.textContent.includes(goalZh.goalWorkCleared));
  assert.ok(document.body.textContent.includes(goalZh.goalWorkSourceUnavailable));
  assert.equal(document.body.textContent.includes(goalZh.goalWorkComplete), false);
  assert.equal(document.body.textContent.includes(goalZh.goalWorkLegacy), false);
});

test('stopping uses the displayed native revision and preserves an uncertain request identity without automatic replay', async t => {
  const sent = [];
  const f = await fixture(t, { onGoalStopWork: async request => { sent.push(request); throw new Error('lost response'); } });
  await f.click(goalZh.goalWorkStop);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].workId, 'work-1'); assert.equal(sent[0].nativeGoalId, 'native-1'); assert.equal(sent[0].nativeRevision, 3);
  assert.ok(sent[0].requestId); assert.equal(Object.hasOwn(sent[0], 'userIdentity'), false);
  assert.ok(document.body.textContent.includes(goalZh.goalWorkUnknown));
  assert.deepEqual(f.calls, [{ kind: 'refresh' }]);
  await f.click(goalZh.goalWorkStop);
  assert.equal(sent.length, 2); assert.equal(sent[1].requestId, sent[0].requestId);
  await f.update({ works: [work({ nativeRevision: 4, phase: 'paused', canStop: false })] });
  assert.ok(document.body.textContent.includes(goalZh.goalWorkPaused));
  assert.equal(sent.length, 2);
});

test('goal source refreshes work facts in the existing read and binds a stop to its exact session', async t => {
  const calls = [], source = createGoalSource({ sessionId: 'native-session', subscribeReset: () => () => {},
    rpc: { async call(channel, method, payload) {
      calls.push({ channel, method, request: payload.args.request });
      return { ok: true, value: method.endsWith('/list') ? { items: [], works: [work()], total: 0, nextOffset: null } : { state: 'applied' } };
    } } });
  t.after(() => source.dispose());
  await source.refresh(); assert.equal(source.getSnapshot().works[0].nativeGoalId, 'native-1');
  await source.stopWork({ workId: 'work-1', nativeGoalId: 'native-1', nativeRevision: 3, requestId: 'stop-one', sessionId: 'wrong-session' });
  assert.deepEqual(calls.map(row => row.method), ['arcfoldGoals/list', 'arcfoldGoals/stopWork', 'arcfoldGoals/list']);
  assert.equal(calls[1].request.sessionId, 'native-session'); assert.equal(calls[1].request.requestId, 'stop-one');
  await source.resumeWork({ workId: 'work-1', nativeGoalId: 'native-1', nativeRevision: 4, requestId: 'resume-one' });
  assert.equal(calls[3].method, 'arcfoldGoals/resumeWork'); assert.equal(calls[3].request.sessionId, 'native-session');
  assert.equal(calls[4].method, 'arcfoldGoals/list');
});

test('continue is an explicit versioned action and an unknown receipt is never shown as success', async t => {
  const sent = [];
  const f = await fixture(t, { onGoalResumeWork: async request => { sent.push(request); return { state: 'unknown' }; } });
  await f.update({ works: [work({ nativeRevision: 4, phase: 'paused', canStop: false, canResume: true })] });
  assert.equal(sent.length, 0);
  await f.click(goalZh.goalWorkResume);
  assert.equal(sent.length, 1); assert.equal(sent[0].nativeRevision, 4);
  assert.ok(document.body.textContent.includes(goalZh.goalWorkUnknown));
  assert.equal(document.body.textContent.includes(goalZh.goalWorkResumed), false);
  await f.click(goalZh.goalWorkResume);
  assert.equal(sent[1].requestId, sent[0].requestId);
});

test('the Arcfold tab shows the current stage and waiting reason, and retires unavailable stage text', async t => {
  const f = await fixture(t);
  await f.update({ works: [work({ objective: 'OLD_NATIVE_WISH', phase: 'paused', canStop: false, canResume: true,
    stage: { id: 'stage-1', available: true, status: 'waiting', objective: '核对当前材料',
      reason: '等待用户选择下一份材料', doneWhen: '记录已保存并核对', boundaries: '选择后再继续' } })] });
  for (const value of ['核对当前材料', '等待用户选择下一份材料', '记录已保存并核对', '选择后再继续', goalZh.goalStageWaiting])
    assert.ok(document.body.textContent.includes(value));
  assert.equal(document.body.textContent.includes('OLD_NATIVE_WISH'), false);
  await f.click(goalZh.goalWorkResume);
  assert.equal(f.calls.filter(call => call.kind === 'resume').length, 1);
  await f.update({ works: [work({ objective: 'WITHDRAWN_TEXT', canStop: false, canResume: false,
    stage: { id: 'stage-1', available: false, status: 'needs_review', reason: '阶段依据需要重新明确' } })] });
  assert.equal(document.body.textContent.includes('WITHDRAWN_TEXT'), false);
  assert.ok(document.body.textContent.includes(goalZh.goalStageReview));
  assert.equal([...document.querySelectorAll('button')].some(button => button.textContent === goalZh.goalWorkResume), false);
});

test('blocked work displays the recorded explanation or explicit unknown, and clears it after resuming', async t => {
  const f = await fixture(t);
  await f.update({ works: [work({ phase: 'blocked', blockedReason: { code: 'model-reported', message: '等待用户确定投递日期。' } })] });
  assert.ok(document.querySelector('.goal-work-blocker').textContent.includes('等待用户确定投递日期。'));
  await f.update({ works: [work({ phase: 'blocked', blockedReason: null })] });
  assert.ok(document.querySelector('.goal-work-blocker').textContent.includes(goalZh.goalBlockUnknown));
  await f.update({ works: [work({ phase: 'active', activation: 'armed', blockedReason: { message: '过期阻塞' } })] });
  assert.equal(document.querySelector('.goal-work-blocker'), null);
  assert.equal(document.body.textContent.includes('过期阻塞'), false);
  assert.deepEqual(f.calls, []);
});
