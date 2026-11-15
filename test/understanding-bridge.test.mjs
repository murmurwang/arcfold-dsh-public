// Actual fixed official Controller text admission, Agent, session and JSONL.
// Model responses, pre-existing business knowledge and attachment peripherals
// are fixtures. No browser, network or semantic model-success claim is made.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm';
import SessionStore from '@deepseek-ai/dsh-session';
import SessionProjections from '@deepseek-ai/dsh-session-projection';
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import { SessionController } from '@deepseek-ai/dsh-api-session-controller';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { BusinessStore } from '../src/business.mjs';
import { UnderstandingService } from '../src/understandings.mjs';
import * as BusinessPlugin from '../src/index.mjs';
import * as MainPlugin from '../src/agent.mjs';

const source = dirname(dirname(fileURLToPath(import.meta.url)));
const correctionText = '  这次只核对原文。\n请把猜测标为你的推断。  ';
const historyText = '原生用户历史依然保留：现在请先核对一个入口。';
const sha = value => createHash('sha256').update(value).digest('hex');
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
async function bounded(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out')), 10000); })]); }
  finally { clearTimeout(timer); }
}

async function fixture(t, { hold = false } = {}) {
  const directory = mkdtempSync(join(source, 'arcfold-understanding-native-'));
  const filename = join(directory, 'business.sqlite'), ctx = new Context();
  const release = Promise.withResolvers(), entered = Promise.withResolvers(), requests = [];
  let handle;
  t.after(async () => {
    release.resolve();
    try { await handle?.dispose(); } finally { await ctx.fiber.dispose(); }
    save(join(directory, 'prepared-model-requests.json'), requests);
  });
  for (const plugin of [LlmRuntime, SessionStore, SessionProjections]) await ctx.plugin(plugin);
  await ctx.plugin(JsonlPersistence, { root: join(directory, 'sessions'), compression: 'none' });
  await ctx.plugin(SystemPrompt, { personaPrefix: 'Synthetic understanding correction engineering fixture.' });
  for (const plugin of [ToolRuntime, NativeToolExecutor, AgentRegistry]) await ctx.plugin(plugin);
  await ctx.plugin(AgentLoop, { agents: [] });
  class FixtureAdapter extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: ['text'], defaultMaxTokens: 64,
      reasoning: { efforts: [{ id: 'off', name: 'Off' }], defaultEffort: 'off' } }; }
    async *stream(options) {
      requests.push(JSON.parse(JSON.stringify({ sessionId: options.sessionId, messages: options.messages })));
      assert.ok(requests.length <= 2, 'No additional model/evaluation step is authorized');
      if (requests.length === 1) { entered.resolve(); if (hold) await release.promise; }
      options.signal?.throwIfAborted();
      const text = 'Synthetic native reply ' + requests.length;
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['fixture'], new FixtureAdapter());
  await ctx.plugin(BusinessPlugin, { filename });
  const store = ctx.arcfoldBusiness.storage;
  const original = store.save('events', { id: 'fixture-old-original', role: 'user', author: 'user',
    content: '我希望原件能回查。', provenance: { kind: 'synthetic-preexisting-business-fixture' } });
  const understanding = store.save('understandings', { id: 'fixture-old-understanding', status: 'active', version: 1,
    previousId: null, content: '旧推断：所有行动都必须先核对原文。', claimType: 'inference', scope: {},
    sourceIds: [original.id], dependencies: [{ kind: 'events', id: original.id, revision: 1 }] });
  handle = await ctx.agents.create({ sessionId: 'native-understanding-main', meta: { cwd: directory },
    agentOptions: { provider: 'fixture', model: 'fixture', maxTokens: 64, reasoningEffort: 'off' },
    setup: async child => { await child.plugin(MainPlugin); child.tools.restrict({ allow: [] }); } });
  const agent = handle.agent;
  // Add only an export to the exact isolated controller bundle, as in the
  // existing native selection seam test; no command implementation is replaced.
  const controllerBytes = readFileSync(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-api-session-controller')));
  const exposed = join(directory, 'controller-text-command.mjs');
  writeFileSync(exposed, controllerBytes.toString('utf8') + '\nexport { SessionCommandController };\n');
  const { SessionCommandController } = await import(pathToFileURL(exposed).href);
  await ctx.plugin({ name: 'fixture-text-intake-peripherals', apply(child) {
    child.provide('fileUploads', { resolve() { throw new Error('No file upload expected'); }, bindPrompt() {
      return { commit() {}, [Symbol.dispose]() {} }; } });
    child.provide('attachments', { async admitPromptContent(content) { return content; } });
  } });
  const commands = new SessionCommandController(ctx, { async resolveAgent(id) {
    assert.equal(id, agent.id); return { agent }; }, serializeImageAdmission() { throw new Error('No images expected'); } }, directory);
  const prompt = (requestId, text, mode = 'queue') => SessionController.prototype.prompt.call({ ctx, commands },
    { sessionId: agent.id, requestId, content: [{ type: 'text', text }], mode }, new AbortController().signal);
  t.diagnostic('Retained actual native understanding evidence: ' + directory);
  return { ctx, store, directory, filename, original, understanding, agent, prompt, release, entered, requests,
    service: ctx.arcfoldUnderstandings, bridge: ctx.arcfoldBridge, controllerSha256: sha(controllerBytes) };
}

function bind(f) { return f.service.bindCorrection({ sessionId: f.agent.id, requestId: 'native-correction-request',
  understandingId: f.understanding.id, expectedRevision: f.understanding.revision,
  text: correctionText, userIdentity: 'fixture-owner-browser' }); }
async function persisted(f) {
  assert.equal(await f.ctx.sessions.flush(f.agent.session), true);
  await f.bridge.pending.get(f.agent.id);
  const reader = await f.ctx.sessionPersistence.open(f.agent.id, 'read');
  try { return (await reader.read(0)).events; } finally { await reader.close(); }
}

test('official steer during active answer enters the next native step, replaces business background and retains raw history', { timeout: 30000 }, async t => {
  const f = await fixture(t, { hold: true });
  assert.deepEqual(await f.prompt('initial-native-request', historyText), { accepted: true });
  await bounded(f.entered.promise, 'First actual native model step');
  assert.equal(f.requests.length, 1);
  assert.ok(JSON.stringify(f.requests[0].messages).includes(f.understanding.content));
  const command = bind(f);
  assert.deepEqual(await f.prompt('native-correction-request', correctionText, 'steer'), { accepted: true });
  f.service.recordCorrectionAdmission({ commandId: command.command.id, state: 'accepted' });
  assert.equal(f.store.get('understanding_commands', command.command.id).result, null,
    'Controller acknowledgement cannot substitute for actual next-step claiming');
  f.release.resolve(); await bounded(f.agent.whenIdle(), 'Actual native correction turn');
  const events = await persisted(f), stored = f.store.get('understanding_commands', command.command.id);
  assert.equal(f.requests.length, 2); assert.equal(stored.result.state, 'applied');
  const second = f.requests[1].messages;
  assert.ok(second.some(row => row.source?.kind === 'user' && row.source.rpcId === 'native-correction-request' && row.content[0].text === correctionText));
  assert.ok(second.some(row => row.source?.kind === 'user' && row.content[0].text === historyText));
  const contexts = second.filter(row => row.source?.kind === 'arcfold/context');
  assert.equal(contexts.length, 1); assert.ok(contexts[0].content[0].text.includes(JSON.stringify(correctionText).slice(1, -1)));
  assert.equal(contexts[0].content[0].text.includes(f.understanding.content), false);
  assert.ok(events.some(event => event.type === 'user/message' && event.data.source?.kind === 'arcfold/context-retired'));
  assert.ok(events.some(event => event.type === 'user/message' && event.data.source?.kind === 'arcfold/context' && event.data.content[0].text.includes(f.understanding.content)));
  const claim = stored.result.claim, inbox = events.find(event => event.seq === claim.inboxRef.seq);
  assert.equal(inbox.type, 'agent/inbox/spliced'); assert.equal(inbox.data.target, 'next-step');
  assert.equal(inbox.data.inserted[claim.inboxRef.index].content[0].text, correctionText);
  assert.equal(inbox.data.inserted[claim.inboxRef.index].source.kind, 'user');
  assert.equal(inbox.data.inserted[claim.inboxRef.index].source.principal, undefined);
  assert.equal(f.store.get('events', claim.sourceId).provenance.sourceRef.type, 'agent/inbox/spliced');
  assert.equal(events.filter(event => event.type === 'user/message' && event.data.id === claim.messageId).length, 1);
  const coldBusiness = new BusinessStore({ filename: f.filename });
  try {
    const cold = new UnderstandingService({ business: coldBusiness });
    const detail = cold.details({ sessionId: f.agent.id, understandingId: stored.result.after.id });
    assert.equal(detail.understanding.content, correctionText); assert.equal(detail.historyTotal, 2);
    assert.deepEqual(detail.commands[0], stored);
    const { action, ...originalRequest } = command.command.request;
    assert.equal(action, 'correct');
    assert.equal(cold.bindCorrection(originalRequest).created, false);
  } finally { coldBusiness.close(); }
  save(join(f.directory, 'evidence.json'), { controllerSha256: f.controllerSha256, passed: true,
    modelSteps: f.requests.length, command: stored, nativeEvents: events, browserVerified: false, realModelCalls: 0 });
});

test('source stop after native preparation makes the actual final guard dispatch zero adapter calls', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const durable = f.bridge.durablePrefix.bind(f.bridge); let calls = 0, control;
  f.bridge.durablePrefix = async session => {
    const events = await durable(session);
    if (++calls === 2) control = f.service.decide({ sessionId: f.agent.id, requestId: 'withdraw-after-preparation',
      understandingId: f.understanding.id, expectedRevision: f.understanding.revision, action: 'withdraw-source',
      sourceRef: { id: f.original.id, revision: f.original.revision, expectedControlRevision: null }, userIdentity: 'fixture-owner-browser' });
    return events;
  };
  await f.prompt('source-stop-native-request', historyText);
  await bounded(f.agent.whenIdle(), 'Native source-stop turn');
  const events = await persisted(f);
  assert.equal(control.command.result.state, 'applied'); assert.equal(f.requests.length, 0);
  assert.deepEqual(f.store.get('events', f.original.id), f.original);
  assert.ok(events.some(event => event.type === 'user/message' && event.data.content[0]?.text === historyText));
  assert.equal(events.findLast(event => event.type === 'turn/end').data.reason.kind, 'error');
  assert.equal(f.store.listAll('deliveries').length, 0);
  save(join(f.directory, 'evidence.json'), { controllerSha256: f.controllerSha256, passed: true, modelSteps: 0,
    control: control.command, nativeEvents: events, browserVerified: false, realModelCalls: 0 });
});
