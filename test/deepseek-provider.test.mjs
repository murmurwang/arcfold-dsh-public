// Real Cordis services + patched npm adapter + loopback SSE + isolated ledger.
// Native sessions are read-only fixtures; this does not start an Agent or Learn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { registerDeepSeekProvider } from '@deepseek-ai/dsh-llm-deepseek';
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BusinessStore } from '../src/business.mjs';
import { BudgetLedger } from '../src/budget.mjs';
import { LearningRunner } from '../src/learning-runner.mjs';
import { SessionBridge } from '../src/session-bridge.mjs';
import { collectContext, contextMessage } from '../src/context-material.mjs';
import { digest } from '../src/learning-contracts.mjs';
import { pauseMethod } from '../src/method-lifecycle.mjs';
import { methodContextMessage, METHOD_TOOL } from '../src/method-context.mjs';
import { methodContentHash, usageForVersion } from '../src/methods.mjs';
import { goalContextMessage, GOAL_TOOL } from '../src/goal-context.mjs';
import { DeepSeekTransport } from '../src/deepseek-transport.mjs';
import * as BudgetPlugin from '../src/deepseek-budget-plugin.mjs';
import * as ProviderPlugin from '../src/deepseek-provider.mjs';

assert.equal(registerDeepSeekProvider.transportSeam, 'deepseek-messages-create-transport-v1',
  'Run only from the root-prepared private installation with the exact patched npm adapter; do not skip');
const provider = 'deepseek-official', model = 'deepseek-v4-pro', maxTokens = 32;
const policy = { contextWindow: 1024, maxOutputTokens: 32, requestMaxTokens: 32,
  prices: { input: 9, output: 27, cachedInput: 0.3 }, priceVersion: 'synthetic-provider-test', reasoningEfforts: ['off'] };
const auth = { ceilingCny: 150, authorizationRef: 'synthetic-provider-test-150', scope: 'limited' };
const credential = 'fixture-key-never-a-real-credential';
const rawUsage = { input_tokens: 80, output_tokens: 3, cache_read_input_tokens: 20, cache_creation_input_tokens: 0 };
const text = value => [{ type: 'text', text: value }];
const sha = value => createHash('sha256').update(value).digest('hex');
const user = (id, value) => ({ id, role: 'user', source: { kind: 'user' }, content: text(value) });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const collect = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; };
const finish = chunks => { const final = chunks.filter(chunk => chunk.type === 'finish'); assert.equal(final.length, 1); return final[0].reason.kind; };
const numbered = rows => rows.map(([type, data], seq) => ({ seq, type, data, time: 1800000000000 + seq }));
const sseEvent = (type, fields) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
const responsePrefix = sseEvent('message_start', { message: { id: 'fixture-sse', model,
  usage: { ...rawUsage, input_tokens: 999, output_tokens: 0 } } }) +
  sseEvent('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
  sseEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'fixture response' } });
const completeSse = responsePrefix + sseEvent('content_block_stop', { index: 0 }) +
  sseEvent('message_delta', { delta: { stop_reason: 'end_turn' }, usage: rawUsage }) + sseEvent('message_stop', {});

function ledgerRows(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare('SELECT body,scope FROM budget_requests ORDER BY id').all()
    .map(row => ({ ...JSON.parse(row.body), sqlScope: row.scope })); }
  finally { db.close(); }
}
async function active(fiber) {
  const deadline = Date.now() + 3000;
  for (;;) {
    await fiber.await();
    if (fiber.state === 2) return fiber;
    assert.ok([0, 1].includes(fiber.state)); assert.ok(Date.now() < deadline, 'Fixture plugin did not become active');
    await delay(1);
  }
}
async function fixture(t, { mode = 'complete', credentials = true, selectedModel = model, reasoningEffort = 'off', modelPolicies = { [model]: policy } } = {}) {
  const model = selectedModel;
  const directory = await mkdtemp(join(realpathSync(tmpdir()), 'arcfold-provider-assembly-'));
  t.diagnostic(`Retained provider assembly evidence: ${directory}`);
  const oldHome = process.env.DSH_HOME, oldAgents = process.env.DSH_AGENTS_HOME;
  process.env.DSH_HOME = join(directory, 'dsh-home'); process.env.DSH_AGENTS_HOME = join(directory, 'agents-home');
  const business = new BusinessStore({ filename: join(directory, 'business.sqlite') });
  const sessions = new Map(), requests = [], credentialReads = [], received = deferred();
  sessions.flush = async () => true;
  const bridge = new SessionBridge({ business, sessions, persistence: {} });
  const ctx = new Context(), extraContexts = [];
  const server = createServer((req, res) => {
    void (async () => {
      const parts = []; for await (const bytes of req) parts.push(bytes);
      requests.push({ path: req.url, method: req.method, headers: req.headers, body: Buffer.concat(parts).toString() });
      if (mode === 'http-error') res.writeHead(500, { 'content-type': 'text/plain' }).end('fixture original 500');
      else { res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'fixture-receipt' });
        if (mode === 'held') res.write(responsePrefix); else res.end(completeSse.replaceAll('"model":"deepseek-v4-pro"', '"model":"' + model + '"')); }
      received.resolve();
    })().catch(error => res.destroy(error));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/anthropic/v1/messages`;
  const ledgerPath = join(directory, 'budget.sqlite');
  const seed = new BudgetLedger(ledgerPath, { ...auth, create: true }); seed.close();
  const config = { ...auth, ledgerPath, artifactDirectory: join(directory, 'receipts'), provider,
    endpoint, allowLocalTestEndpoint: true, timeoutMs: 5000, modelPolicies };
  const providerConfig = { apiKeyRef: 'FIXTURE_DEEPSEEK_REFERENCE', maxTokens, reasoningEffort };
  await mkdir(join(directory, 'workspace'));
  const cwd = join(directory, 'workspace');
  const credentialsPlugin = { name: 'fixture-credentials', apply(child) {
    child.provide('credentials', { async resolve(ref) { credentialReads.push(ref);
      assert.equal(ref, providerConfig.apiKeyRef); return { value: credential }; } });
  } };
  const servicesPlugin = { name: 'fixture-native-business-services', apply(child) {
    child.provide('arcfoldBusiness', business); child.provide('sessions', sessions);
    child.provide('arcfoldBridge', bridge);
    child.provide('workingDirectory', { get: () => cwd });
    child.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]));
  } };
  await ctx.plugin(servicesPlugin); await ctx.plugin(LlmRuntime);
  await ctx.plugin({ name: 'fixture-main-source-guard', inject: ['llm', 'arcfoldBridge'], apply(child) {
    child.on('llm/stream', (options, next) => bridge.guardStream(options, next));
  } });
  if (credentials) await ctx.plugin(credentialsPlugin);
  let budgetFiber;
  const mountBudget = async () => budgetFiber = await active(await ctx.plugin(BudgetPlugin, config));
  const mountProvider = () => ctx.plugin(ProviderPlugin, providerConfig);
  const addSession = (id, role = 'main') => {
    const events = numbered([['turn/start', { turn: 1 }], ['step/start', { turn: 1, step: 1 }]]);
    const session = { id, config: { provider, model, maxTokens, reasoningEffort },
      snapshotEvents: () => structuredClone(events), requestHeader() { return { config: this.config }; } };
    sessions.set(id, session);
    if (role === 'main') business.storage.save('host_bindings', { id, sessionId: id, role: 'main' });
    return session;
  };
  const call = async (id, messages) => {
    if (!messages) {
      messages = [user(`user-${id}`, 'synthetic ordinary input')];
      if (bridge.isBound(id)) {
        const material = collectContext(business.storage, { sessionId: id, turn: 1 });
        const message = contextMessage(material);
        business.storage.save('context_snapshots', { id: `context-${id}`, sessionId: id, turn: 1,
          contextMessageId: message.id, material });
        messages.push(message);
      }
    }
    const prepared = await ctx.llm.prepareCall({ provider, model, maxTokens, reasoningEffort });
    if (sessions.has(id)) sessions.get(id).config = prepared.config;
    return collect(prepared.stream({ ...prepared.config, sessionId: id, messages, tools: [] }));
  };
  const competingContext = async () => {
    const other = new Context(); extraContexts.push(other);
    await other.plugin(servicesPlugin); await other.plugin(LlmRuntime); return other;
  };
  t.after(async () => {
    try { await ctx.fiber.dispose(); for (const other of extraContexts) await other.fiber.dispose(); }
    finally {
      business.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
      if (oldAgents === undefined) delete process.env.DSH_AGENTS_HOME; else process.env.DSH_AGENTS_HOME = oldAgents;
    }
  });
  return { ctx, business, bridge, directory, ledgerPath, config, cwd, sessions, requests, credentialReads, received,
    credentialsPlugin, mountBudget, mountProvider, addSession, call, competingContext, budget: () => budgetFiber };
}

function helper(f, id, { versions = [] } = {}) {
  f.addSession(id, 'helper');
  const pendingId = `pending-${id}`, prompt = 'Synthetic frozen learning instruction; no semantic result is assessed.';
  const material = { fixture: true }, inputText = JSON.stringify(material);
  const input = f.business.storage.save('learning_inputs', { id: pendingId, pendingId, prompt, material, inputText, versions,
    inputHash: digest(inputText), materialHash: digest(material), promptHash: digest(prompt) });
  const message = { id: `learning-${id}`, role: 'user', source: { kind: 'arcfold/learning', pendingId, deliveryId: 'fixture-delivery' },
    content: text(JSON.stringify({ fixture: true })) };
  const section = { name: 'working-directory:current', text: `Current working directory: ${JSON.stringify(f.cwd)}.` };
  const hostContext = { role: 'user', source: { kind: 'runtime-context', form: 'snapshot', sections: [section] },
    content: text('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n' + section.text) };
  const runtime = { ...hostContext, id: `runtime-${id}` };
  f.business.storage.save('learning_runs', { id: pendingId, pendingId, sessionId: id, state: 'submitted', dispatchCount: 0,
    messageId: message.id, message, inputHash: input.inputHash, hostCwd: f.cwd, hostContext,
    executionConfig: { preset: 'fixture', cwd: f.cwd, provider, model, reasoningEffort: 'off', maxTokens }, defaultsRevision: 1 });
  const runner = new LearningRunner({ business: f.business, learning: { prepare: key => { assert.equal(key, pendingId); return input; } },
    host: { sessions: f.sessions, workingDirectory: { get: () => f.cwd } },
    config: { preset: 'fixture', cwd: f.cwd, provider, model, reasoningEffort: 'off', maxTokens } });
  const mountGuard = () => f.ctx.plugin({ name: 'fixture-real-learning-guard', inject: ['llm'], apply(child) {
    child.on('llm/stream', (options, next) => runner.guardStream(options, next));
    child.effect(() => () => runner.close());
  } });
  return { pendingId, mountGuard, messages: [{ id: `system-${id}`, role: 'system', content: text(input.prompt) }, message, runtime] };
}

test('real installed provider sends official serialized text and settles final raw usage through credential service', async t => {
  const f = await fixture(t); await f.mountBudget(); await active(await f.mountProvider()); f.addSession('main-success');
  const chunks = await f.call('main-success'); assert.equal(finish(chunks), 'stop'); assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].path, '/anthropic/v1/messages'); assert.equal(f.requests[0].headers['x-api-key'], credential);
  assert.deepEqual(f.credentialReads, ['FIXTURE_DEEPSEEK_REFERENCE']);
  const wire = JSON.parse(f.requests[0].body); assert.equal(wire.model, model); assert.equal(wire.max_tokens, maxTokens);
  assert.deepEqual(wire.thinking, { type: 'disabled' });
  const rows = ledgerRows(f.ledgerPath); assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'settled'); assert.equal(rows[0].sqlScope, 'limited'); assert.equal(rows[0].spentMicroCny, 807);
  assert.equal(rows[0].metadata.role, 'main'); assert.equal(rows[0].metadata.sessionId, 'main-success');
  assert.deepEqual(rows[0].usage, { promptTokens: 100, completionTokens: 3, cachedTokens: 20 });
  const nativeUsage = chunks.find(chunk => chunk.type === 'usage').usage;
  assert.deepEqual(nativeUsage, { inputTokens: 80, outputTokens: 3, cacheReadTokens: 20, cacheWriteTokens: 0, totalTokens: 103 });
  const dir = join(f.config.artifactDirectory, sha(rows[0].requestId));
  assert.equal(await readFile(join(dir, 'response-body.bin'), 'utf8'), completeSse);
  for (const name of await readdir(dir)) assert.equal((await readFile(join(dir, name), 'utf8')).includes(credential), false);
});

test('provider waits for the declared credential service instead of registering an ambient unmetered fallback', async t => {
  const f = await fixture(t, { credentials: false }); await f.mountBudget();
  const providerFiber = await f.mountProvider(); await providerFiber.await(); assert.equal(providerFiber.state, 0);
  assert.deepEqual(f.ctx.llm.listProviders(), []);
  await f.ctx.plugin(f.credentialsPlugin); await active(providerFiber);
  assert.deepEqual(f.ctx.llm.listProviders().map(row => row.id), [provider]);
  assert.equal(f.requests.length, 0); assert.deepEqual(ledgerRows(f.ledgerPath), []);
});

test('an unbound native session is rejected before credentials, reservation or HTTP', async t => {
  const f = await fixture(t); await f.mountBudget(); await active(await f.mountProvider()); f.addSession('unbound', 'none');
  assert.equal(finish(await f.call('unbound')), 'error');
  assert.equal(f.requests.length, 0); assert.deepEqual(f.credentialReads, []); assert.deepEqual(ledgerRows(f.ledgerPath), []);
});

test('an independent provider passes the shared LLM hooks without entering the DeepSeek ledger', async t => {
  const f = await fixture(t); await f.mountBudget(); await active(await f.mountProvider());
  const otherProvider = 'independent-web-fixture', otherModel = 'scripted-text';
  let calls = 0;
  class IndependentAdapter extends LlmAdapter {
    async resolveModel(route, id) {
      return { provider: route, id, name: id, inputModalities: ['text'], defaultMaxTokens: 32,
        reasoning: { efforts: [{ id: 'off', name: 'Off' }], defaultEffort: 'off' } };
    }
    async *stream(options) {
      assert.equal(options.provider, otherProvider); assert.equal(options.model, otherModel); calls++;
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'independent fixture answer' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'independent fixture answer' } };
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  await f.ctx.plugin({ name: 'independent-provider-fixture', inject: ['llm'], apply(child) {
    child.llm.registerAdapter([otherProvider], new IndependentAdapter());
  } });
  const prepared = await f.ctx.llm.prepareCall({ provider: otherProvider, model: otherModel, maxTokens: 32, reasoningEffort: 'off' });
  const chunks = await collect(prepared.stream({ ...prepared.config, sessionId: 'independent-not-arcfold-bound',
    messages: [user('independent-user', 'synthetic independent input')], tools: [] }));
  assert.equal(finish(chunks), 'stop'); assert.equal(calls, 1);
  assert.equal(chunks.find(chunk => chunk.type === 'text-delta').text, 'independent fixture answer');
  assert.equal(f.requests.length, 0); assert.deepEqual(f.credentialReads, []); assert.deepEqual(ledgerRows(f.ledgerPath), []);
});

test('helper cannot bypass its single-call guard even through the registered real adapter', async t => {
  const f = await fixture(t); await f.mountBudget(); await active(await f.mountProvider()); const h = helper(f, 'unguarded-helper');
  assert.equal(finish(await f.call('unguarded-helper', h.messages)), 'error');
  assert.equal(f.business.get('learning_runs', h.pendingId).dispatchCount, 0);
  assert.equal(f.requests.length, 0); assert.deepEqual(f.credentialReads, []); assert.deepEqual(ledgerRows(f.ledgerPath), []);
});

for (const guardFirst of [false, true]) test(`real helper guard precedes native identity at send, guard mounted first=${guardFirst}`, async t => {
  const f = await fixture(t), h = helper(f, `guarded-helper-${guardFirst}`);
  if (guardFirst) await h.mountGuard();
  await f.mountBudget(); await active(await f.mountProvider());
  if (!guardFirst) await h.mountGuard();
  assert.equal(finish(await f.call(`guarded-helper-${guardFirst}`, h.messages)), 'stop');
  const run = f.business.get('learning_runs', h.pendingId); assert.equal(run.dispatchCount, 1); assert.ok(run.requestHash);
  const rows = ledgerRows(f.ledgerPath); assert.equal(rows.length, 1); assert.equal(rows[0].status, 'settled');
  assert.equal(rows[0].metadata.role, 'learning'); assert.equal(rows[0].metadata.learningPendingId, h.pendingId);
  assert.equal(rows[0].metadata.learningInputHash, run.inputHash); assert.equal(f.requests.length, 1);
});

test('official translated HTTP failure remains one paid unknown attempt, never a successful default-zero usage', async t => {
  const f = await fixture(t, { mode: 'http-error' }); await f.mountBudget(); await active(await f.mountProvider()); f.addSession('main-http-error');
  assert.equal(finish(await f.call('main-http-error')), 'error'); assert.equal(f.requests.length, 1);
  const rows = ledgerRows(f.ledgerPath); assert.equal(rows.length, 1); assert.equal(rows[0].status, 'unknown');
  assert.equal(rows[0].spentMicroCny, 0); assert.ok(rows[0].reservedMicroCny > 0);
  assert.equal(await readFile(join(f.config.artifactDirectory, sha(rows[0].requestId), 'response-body.bin'), 'utf8'), 'fixture original 500');
});

for (const change of ['source-withdrawal', 'method-pause', 'helper-source-change', 'async-main-check', 'runtime-stop'])
  test(`production final dispatch callback rejects ${change} after request.json persistence with zero HTTP`, async t => {
    const f = await fixture(t); await f.mountBudget(); await active(await f.mountProvider());
    const id = `late-${change}`, sourceId = `source-${change}`;
    let h, method, runtimeStopped = false, runtimeChecks = 0;
    if (change === 'runtime-stop') f.ctx.provide('arcfoldRuntimeGuard', Object.freeze({
      assertDispatch(options) {
        runtimeChecks++; assert.equal(options.sessionId, id);
        if (runtimeStopped) throw Object.assign(new Error('The runtime stopped before dispatch.'), { code: 'ARCFOLD_RUNTIME_NOT_READY' });
      },
    }));
    if (change === 'helper-source-change') {
      h = helper(f, id, { versions: [{ kind: 'source_controls', id: sourceId, revision: null, hash: null }] });
      await h.mountGuard();
    } else {
      f.addSession(id);
      const source = f.business.storage.save('events', { id: sourceId, role: 'user', content: 'Synthetic original source',
        occurredAt: '2026-11-06T00:00:00.000Z' });
      const dependencies = [{ kind: 'events', id: sourceId, revision: source.revision }];
      if (change === 'method-pause') method = f.business.storage.save('methods', { id: 'late-method',
        title: 'Synthetic method', guidance: 'Synthetic guidance', appliesTo: 'fixture', doesNotApplyTo: 'other contexts',
        status: 'trial', version: 1, maxTrialUses: 3, sourceIds: [sourceId], dependencies });
      else f.business.storage.save('understandings', { id: 'late-understanding', content: 'Synthetic source-backed context',
        status: 'active', scope: { conversationId: id }, sourceIds: [sourceId], dependencies });
    }
    const entered = deferred(), release = deferred(), originalPersist = DeepSeekTransport.prototype.persistJson;
    const gate = t.mock.method(DeepSeekTransport.prototype, 'persistJson', async function (path, value) {
      const result = await originalPersist.call(this, path, value);
      if (this.artifactDirectory === f.config.artifactDirectory && path.endsWith('/request.json')) {
        entered.resolve(); await release.promise;
      }
      return result;
    });
    const output = f.call(id, h?.messages); void output.catch(() => {});
    try {
      await Promise.race([entered.promise, output.then(() => { throw new Error('Expected the request persistence gate'); })]);
      assert.equal(f.requests.length, 0); assert.equal(ledgerRows(f.ledgerPath)[0].status, 'reserved');
      if (change === 'runtime-stop') { assert.equal(runtimeChecks, 0); runtimeStopped = true; }
      else if (change === 'method-pause') pauseMethod(f.business.storage, method, { reason: 'negative_feedback' });
      else if (change === 'async-main-check') f.bridge.assertMethodRequestCurrent = async () => ({});
      else f.business.storage.save('source_controls', { id: sourceId, withdrawn: true });
    } finally { release.resolve(); }
    try { assert.equal(finish(await output), 'error'); } finally { gate.mock.restore(); }
    assert.equal(f.requests.length, 0);
    const rows = ledgerRows(f.ledgerPath); assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'released'); assert.equal(rows[0].reservedMicroCny, 0);
    assert.equal(rows[0].spentMicroCny, 0); assert.equal(rows[0].dispatchedAt, null);
    if (change === 'source-withdrawal') {
      assert.equal(rows[0].releaseReason, 'arcfold_context_changed');
      const directory = join(f.config.artifactDirectory, sha(rows[0].requestId));
      const errors = (await readdir(directory)).filter(name => name.startsWith('error-'));
      assert.equal(errors.length, 1);
      assert.equal(JSON.parse(await readFile(join(directory, errors[0]), 'utf8')).code, 'arcfold_context_changed');
    }
    if (change === 'runtime-stop') assert.equal(runtimeChecks, 1, 'The production callback must recheck the root gate after persistence');
    if (h) assert.equal(f.business.get('learning_runs', h.pendingId).dispatchCount, 1);
  });

test('a linked goal paused during final request persistence is never sent and its original contribution is retained', async t => {
  const f = await fixture(t); await f.mountBudget(); await active(await f.mountProvider());
  const id = 'late-linked-goal', session = f.addSession(id), store = f.business.storage;
  const source = store.save('events', { id: 'linked-source', role: 'user', content: 'Build an evidence-backed project.' });
  const goal = store.save('goals', { id: 'linked-goal', title: 'Project', outcome: 'Explain real system behavior',
    definitionVersion: 1, status: 'tracking', scope: {}, userControl: null,
    sourceIds: [source.id], dependencies: [{ kind: 'events', id: source.id, revision: source.revision }],
    progress: { content: '', sourceIds: [], dependencies: [] }, relations: [] });
  const material = collectContext(store, { sessionId: id, turn: 1 }), message = contextMessage(material);
  store.save('context_snapshots', { id: 'goal-context', sessionId: id, turn: 1, material, contextMessageId: message.id });
  const shown = material.goals[0], selection = { id: shown.id, revision: shown.revision, definitionVersion: shown.definitionVersion,
    contentHash: shown.contentHash, reason: 'This work can contribute source evidence', sourceIds: shown.sourceIds };
  const linked = f.bridge.goals.link({ sessionId: id, turn: 1, startSeq: 0, callId: 'goal-selection',
    contextSnapshotId: 'goal-context', contextMessageId: message.id, selection, maxCharacters: 24000 });
  const args = JSON.stringify({ selection }), events = numbered([
    ['turn/start', { turn: 1 }], ['step/start', { turn: 1, step: 1 }],
    ['assistant/message', { turn: 1, step: 1, message: { id: 'select-goal', role: 'assistant',
      source: { kind: 'model', provider, model }, content: [{ type: 'tool-call', id: 'goal-selection', name: GOAL_TOOL, arguments: args }] } }],
    ['tool/call', { turn: 1, step: 1, callId: 'goal-selection', name: GOAL_TOOL, arguments: args }],
    ['tool/result', { turn: 1, step: 1, message: { id: 'goal-result', role: 'tool',
      source: { kind: 'tool', callId: 'goal-selection' }, toolCallId: 'goal-selection', isError: false,
      content: text(JSON.stringify(linked.receipt)) } }],
    ['step/end', { turn: 1, step: 1 }], ['step/start', { turn: 1, step: 2 }],
  ]);
  session.snapshotEvents = () => structuredClone(events);
  const originalLink = store.get('goal_links', linked.receipt.linkId);
  const entered = deferred(), release = deferred(), originalPersist = DeepSeekTransport.prototype.persistJson;
  const gate = t.mock.method(DeepSeekTransport.prototype, 'persistJson', async function (path, value) {
    const result = await originalPersist.call(this, path, value);
    if (this.artifactDirectory === f.config.artifactDirectory && path.endsWith('/request.json')) { entered.resolve(); await release.promise; }
    return result;
  });
  const output = f.call(id, [user('follow-goal', 'Work on the bounded current task'), message, goalContextMessage(linked.bundle)]);
  void output.catch(() => {});
  try {
    await Promise.race([entered.promise, output.then(() => { throw new Error('Expected the linked request persistence gate'); })]);
    assert.equal(store.listAll('goal_inputs').length, 1); assert.equal(ledgerRows(f.ledgerPath)[0].status, 'reserved');
    f.bridge.goals.decide({ goalId: goal.id, expectedRevision: goal.revision, definitionVersion: 1,
      action: 'pause', requestId: 'pause-goal-at-dispatch', userIdentity: 'browser:fixture-owner' });
  } finally { release.resolve(); }
  try { assert.equal(finish(await output), 'error'); } finally { gate.mock.restore(); }
  assert.equal(f.requests.length, 0);
  const row = ledgerRows(f.ledgerPath)[0];
  assert.equal(row.status, 'released'); assert.equal(row.reservedMicroCny, 0);
  assert.equal(row.releaseReason, 'arcfold_goal_context_changed');
  assert.deepEqual(store.get('goal_links', originalLink.id), originalLink);
  assert.equal(store.listAll('goal_link_outcomes').length, 0);
});

test('production final method check rejects an actually adopted full method paused after request persistence without refunding its use', async t => {
  const f = await fixture(t); await f.mountBudget(); await active(await f.mountProvider());
  const id = 'late-adopted-method', session = f.addSession(id), store = f.business.storage;
  const source = store.save('events', { id: 'adopted-source', role: 'user', content: 'Synthetic method basis',
    occurredAt: '2026-11-06T00:00:00.000Z' });
  const method = store.save('methods', { id: 'adopted-method', title: 'Synthetic selected method', guidance: 'Full selected guidance',
    appliesTo: 'fixture', doesNotApplyTo: 'other contexts', status: 'trial', version: 1, maxTrialUses: 3,
    sourceIds: [source.id], dependencies: [{ kind: 'events', id: source.id, revision: source.revision }] });
  const material = collectContext(store, { sessionId: id, turn: 1 }), message = contextMessage(material);
  store.save('context_snapshots', { id: 'adoption-context', sessionId: id, turn: 1, material, contextMessageId: message.id });
  const selected = { id: method.id, revision: method.revision, contentHash: methodContentHash(method),
    reason: 'The original fixture requires this method', sourceIds: [source.id] };
  const adopted = f.bridge.methods.reserve({ sessionId: id, turn: 1, startSeq: 0, callId: 'method-selection',
    contextSnapshotId: 'adoption-context', contextMessageId: message.id, selections: [selected] });
  const events = numbered([
    ['turn/start', { turn: 1 }], ['step/start', { turn: 1, step: 1 }],
    ['assistant/message', { turn: 1, step: 1, message: { id: 'select-method', role: 'assistant',
      source: { kind: 'model', provider, model }, content: [{ type: 'tool-call', id: 'method-selection', name: METHOD_TOOL,
        arguments: JSON.stringify({ selections: [selected] }) }] } }],
    ['tool/call', { turn: 1, step: 1, callId: 'method-selection', name: METHOD_TOOL, arguments: JSON.stringify({ selections: [selected] }) }],
    ['tool/result', { turn: 1, step: 1, message: { id: 'method-result', role: 'tool',
      source: { kind: 'tool', callId: 'method-selection' }, toolCallId: 'method-selection', isError: false,
      content: text(JSON.stringify(adopted.receipt)) } }],
    ['step/end', { turn: 1, step: 1 }], ['step/start', { turn: 1, step: 2 }],
  ]);
  session.snapshotEvents = () => structuredClone(events);
  const messages = [user('follow-method', 'Use the applicable method'), message, methodContextMessage(adopted.bundle)];
  const originalAdoption = store.get('method_adoptions', adopted.receipt.adoptionIds[0]);
  const rejected = [], actualCheck = f.bridge.assertMethodRequestCurrent;
  const checkObserver = t.mock.method(f.bridge, 'assertMethodRequestCurrent', function (...args) {
    try { return actualCheck.apply(this, args); } catch (error) { rejected.push(error.code); throw error; }
  });
  const entered = deferred(), release = deferred(), originalPersist = DeepSeekTransport.prototype.persistJson;
  const gate = t.mock.method(DeepSeekTransport.prototype, 'persistJson', async function (path, value) {
    const result = await originalPersist.call(this, path, value);
    if (this.artifactDirectory === f.config.artifactDirectory && path.endsWith('/request.json')) { entered.resolve(); await release.promise; }
    return result;
  });
  const output = f.call(id, messages); void output.catch(() => {});
  try {
    await Promise.race([entered.promise, output.then(() => { throw new Error('Expected the adopted request persistence gate'); })]);
    assert.deepEqual(rejected, []); assert.equal(store.listAll('method_inputs').length, 1);
    assert.equal(ledgerRows(f.ledgerPath)[0].status, 'reserved');
    pauseMethod(store, method, { reason: 'negative_feedback' });
  } finally { release.resolve(); }
  try { assert.equal(finish(await output), 'error'); } finally { gate.mock.restore(); checkObserver.mock.restore(); }
  assert.deepEqual(rejected, ['ARCFOLD_METHOD_CONTEXT_CHANGED']);
  assert.equal(f.requests.length, 0); assert.equal(ledgerRows(f.ledgerPath)[0].status, 'released');
  assert.equal(ledgerRows(f.ledgerPath)[0].reservedMicroCny, 0);
  assert.equal(ledgerRows(f.ledgerPath)[0].releaseReason, 'arcfold_method_context_changed');
  const directory = join(f.config.artifactDirectory, sha(ledgerRows(f.ledgerPath)[0].requestId));
  const errors = (await readdir(directory)).filter(name => name.startsWith('error-'));
  assert.equal(errors.length, 1);
  assert.equal(JSON.parse(await readFile(join(directory, errors[0]), 'utf8')).code, 'arcfold_method_context_changed');
  assert.deepEqual(store.get('method_adoptions', originalAdoption.id), originalAdoption);
  assert.equal(usageForVersion(store, store.get('methods', method.id)).trialUses, 1);
});

test('plugin disposal retains evidence ownership while draining, records unknown, then releases the kernel lock', async t => {
  const f = await fixture(t, { mode: 'held' }); await f.mountBudget(); await active(await f.mountProvider()); f.addSession('main-held');
  const output = f.call('main-held'); void output.catch(() => {}); await f.received.promise;
  const closeEntered = deferred(), releaseClose = deferred(), originalClose = DeepSeekTransport.prototype.close;
  // Scheduling gate only: the original close still owns cancellation, draining,
  // unknown persistence and socket cleanup; no mocked business result.
  const mock = t.mock.method(DeepSeekTransport.prototype, 'close', function () {
    if (this.artifactDirectory !== f.config.artifactDirectory) return originalClose.call(this);
    closeEntered.resolve(); return releaseClose.promise.then(() => originalClose.call(this));
  });
  let closing;
  try {
    closing = f.budget().dispose(); await closeEntered.promise;
    const competitor = await f.competingContext();
    await assert.rejects(async () => await competitor.plugin(BudgetPlugin, f.config), error =>
      error.syscall === 'flock' && ['EAGAIN', 'EWOULDBLOCK'].includes(error.code));
  } finally { releaseClose.resolve(); try { await closing; } finally { mock.mock.restore(); } }
  assert.equal(finish(await output), 'error'); assert.equal(f.requests.length, 1);
  const rows = ledgerRows(f.ledgerPath); assert.equal(rows.length, 1); assert.equal(rows[0].status, 'unknown');
  assert.ok(rows[0].reservedMicroCny > 0);
  const replacement = await f.competingContext(); await active(await replacement.plugin(BudgetPlugin, f.config));
  assert.equal(f.requests.length, 1); assert.deepEqual(ledgerRows(f.ledgerPath), rows);
});

test('Flash retains Pro in the native catalog and exact off/max selection reaches wire and CNY accounting', async t => {
  const initial=JSON.parse(await readFile(new URL('../runtime/initial-policy.json',import.meta.url),'utf8'));
  for(const reasoningEffort of ['off','max']) {
    const f=await fixture(t,{selectedModel:'deepseek-flash',reasoningEffort,modelPolicies:initial.routes['deepseek-official'].modelPolicies});
    await f.mountBudget();await active(await f.mountProvider());f.addSession('flash-'+reasoningEffort);
    assert.deepEqual((await f.ctx.llm.listModels(provider)).map(row=>row.id),['deepseek-v4-pro','deepseek-flash']);
    assert.equal(finish(await f.call('flash-'+reasoningEffort)),'stop');
    assert.equal(f.requests.length,1);
    const body=JSON.parse(f.requests[0].body);assert.equal(body.model,'deepseek-flash');
    assert.equal(body.thinking.type,reasoningEffort==='off'?'disabled':'enabled');
    assert.deepEqual(body.output_config,reasoningEffort==='off'?undefined:{effort:'max'});
    const rows=ledgerRows(f.ledgerPath);assert.equal(rows.length,1);assert.equal(rows[0].model,'deepseek-flash');
    assert.deepEqual(rows[0].usage,{promptTokens:100,completionTokens:3,cachedTokens:20});
    assert.equal(rows[0].status,'settled');
    assert.deepEqual(rows[0].prices,{input:2,output:8,cachedInput:0.04});
  }
});
