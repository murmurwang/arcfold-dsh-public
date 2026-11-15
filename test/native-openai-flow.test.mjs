// Actual official Agent/session/persistence/tool runtime and pi-ai/OpenAI SDK.
// Only the remote Responses service and one narrowly scoped local tool are fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm';
import SessionStore from '@deepseek-ai/dsh-session';
import SessionProjections from '@deepseek-ai/dsh-session-projection';
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools';
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { crc32, deflateSync } from 'node:zlib';
import * as BusinessPlugin from '../src/index.mjs';
import * as MainPlugin from '../src/agent.mjs';
import * as HostPlugin from '../src/metered-provider-host.mjs';
import * as OpenAIPlugin from '../src/openai-provider.mjs';
import { OpenAITransport } from '../src/openai-transport.mjs';
import { OpenAIUsageLedger } from '../src/openai-usage.mjs';
import * as RuntimeGuard from '../src/runtime-guard.mjs';
import { nativeRequestIdentity } from '../src/native-request-authority.mjs';
import { canonicalJson } from '../src/store.mjs';

const provider = 'openai', model = 'gpt-6-astra', maxTokens = 64;
const toolName = 'fixture_write_and_read_marker', marker = 'native tool execution confirmed';
const answer = 'The fixture marker was written and read back.';
const callId = 'call_native_fixture', itemId = 'fc_native_fixture';
const encrypted = 'synthetic-encrypted-replay-marker';
const usage = { input_tokens: 11, output_tokens: 3, input_tokens_details: { cached_tokens: 3 }, total_tokens: 14 };
const authorization = { authorizationRef: 'native-openai-flow-fixture',
  authorizedAt: '2026-11-07T00:00:00Z', authorizationEvidence: 'Local synthetic Responses only; no live OpenAI authorization.' };
const sha = value => createHash('sha256').update(value).digest('hex');
const digest = value => sha(canonicalJson(value));
// Two tiny distinct, valid PNGs keep the fixture independent of image binaries
// and exercise the real attachment decoder, immutable store and request reader.
function png(red, green, blue) {
  const chunk = (name, bytes) => {
    const type = Buffer.from(name), size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length);
    checksum.writeUInt32BE(crc32(Buffer.concat([type, bytes])));
    return Buffer.concat([size, type, bytes, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, red, green, blue, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
const imageContent = items => items.flatMap(item => Array.isArray(item.content) ? item.content : [])
  .filter(block => block.type === 'input_image');
async function active(fiber) {
  const deadline = Date.now() + 5000;
  for (;;) {
    await fiber.await();
    if (fiber.state === 2) return fiber;
    assert.ok([0, 1].includes(fiber.state), 'Plugin must not fail');
    assert.ok(Date.now() < deadline, 'Native fixture plugin did not activate');
    await delay(2);
  }
}
async function bounded(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' timed out')), 20000);
  })]); } finally { clearTimeout(timer); }
}
function response(ordinal, model = 'gpt-6-astra') {
  let sequence = 0;
  const event = (type, fields) => 'event: ' + type + '\ndata: ' +
    JSON.stringify({ type, sequence_number: sequence++, ...fields }) + '\n\n';
  const id = 'resp_native_' + ordinal;
  let body = event('response.created', { response: { id, model, status: 'in_progress', output: [] } });
  let output;
  if (ordinal === 1) {
    const reasoning = { id: 'rs_native_fixture', type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'Synthetic tool fixture.' }], encrypted_content: encrypted };
    const call = { id: itemId, type: 'function_call', status: 'completed', call_id: callId,
      name: toolName, arguments: '{}' };
    body += event('response.output_item.added', { output_index: 0, item: { ...reasoning, summary: [] } });
    body += event('response.output_item.done', { output_index: 0, item: reasoning });
    body += event('response.output_item.added', { output_index: 1, item: { ...call, status: 'in_progress', arguments: '' } });
    body += event('response.function_call_arguments.delta', { output_index: 1, item_id: itemId, delta: '{}' });
    body += event('response.function_call_arguments.done', { output_index: 1, item_id: itemId, arguments: '{}' });
    body += event('response.output_item.done', { output_index: 1, item: call });
    output = [reasoning, call];
  } else {
    const message = { id: ordinal > 2 ? 'msg_native_fixture_' + ordinal : 'msg_native_fixture', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: answer, annotations: [] }] };
    body += event('response.output_item.added', { output_index: 0, item: { ...message, status: 'in_progress', content: [] } });
    body += event('response.output_text.delta', { output_index: 0, item_id: message.id, content_index: 0, delta: answer });
    body += event('response.output_item.done', { output_index: 0, item: message });
    output = [message];
  }
  return body + event('response.completed', { response: { id, model, status: 'completed', output, usage } });
}

for (const [model, reasoningEffort, stopBeforeDispatch, withImages] of [
  ['gpt-6-astra','high',false,false], ['gpt-6-astra','high',true,false], ['gpt-6.1-sol','max',false,false],
  ['gpt-6-astra','high',false,true],
]) test(stopBeforeDispatch ? 'real shared-host final root guard releases a persisted unsent OpenAI request with zero HTTP' :
  withImages ? 'official native user and tool images survive full request replay, accounting and a cold session resume' :
  'official native '+model+' '+reasoningEffort+' tool roundtrip, encrypted replay and durable delivery reach the independent OpenAI ledger', { timeout: 60000 }, async t => {
  assert.equal(PiAiAdapter.transportSeam, 'pi-ai-create-transport-v2', 'Use the exact isolated patched adapter');
  const directory = await mkdtemp(join(realpathSync(tmpdir()), 'arcfold-native-openai-'));
  t.diagnostic('Retained native OpenAI flow evidence: ' + directory);
  const workspace = join(directory, 'workspace'), persistenceRoot = join(directory, 'sessions');
  await mkdir(workspace);
  const markerPath = join(workspace, 'native-marker.txt');
  const ledgerPath = join(directory, 'openai-usage.sqlite'), artifactDirectory = join(directory, 'receipts');
  const seed = new OpenAIUsageLedger(ledgerPath, { webAuthorization: authorization, create: true }); seed.close();
  const ctx = new Context(), cold = new Context(), requests = [], serverFailures = [];
  let handle, toolExecutions = 0;
  const attachmentHome = join(directory, 'dsh-home');
  const attachments = withImages ? new LocalAttachmentStore(ctx, { dshHome: attachmentHome }) : null;
  let userImage, toolImage, expectedUserImage, expectedToolImage;
  if (withImages) {
    userImage = await attachments.saveImage({ data: png(210, 30, 30), mediaType: 'image/png', name: 'user.png' });
    toolImage = await attachments.saveImage({ data: png(30, 30, 210), mediaType: 'image/png', name: 'tool.png' });
    assert.notEqual(userImage.attachmentId, toolImage.attachmentId);
    const wireImage = async ref => ({ type: 'input_image', detail: 'auto',
      image_url: 'data:' + ref.mediaType + ';base64,' + Buffer.from((await attachments.readImage(ref)).data).toString('base64') });
    expectedUserImage = await wireImage(userImage); expectedToolImage = await wireImage(toolImage);
  }
  const wireFailures = [], originalValidateWire = OpenAITransport.prototype.validateWire;
  t.mock.method(OpenAITransport.prototype, 'validateWire', function(fixed, url, init) {
    try { return originalValidateWire.call(this, fixed, url, init); }
    catch (error) {
      wireFailures.push({ code: error.code, message: error.message, urlType: typeof url,
        endpointMatches: url === this.endpoint, method: init?.method, redirect: init?.redirect,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : typeof init?.body });
      throw error;
    }
  });
  const server = createServer((req, res) => {
    void (async () => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const serialized = Buffer.concat(chunks).toString('utf8');
      const ordinal = requests.length + 1;
      requests.push({ ordinal, method: req.method, path: req.url, body: JSON.parse(serialized), serialized });
      assert.ok(ordinal <= (withImages ? 3 : 2), 'Only the fixture model steps are authorized');
      assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/responses');
      assert.equal(req.headers.authorization, 'Bearer sk-fixture-native-openai-not-a-real-key');
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'native-fixture-' + ordinal });
      res.end(response(ordinal, model));
    })().catch(error => { serverFailures.push(error); res.writeHead(500).end('fixture failed'); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    try {
      await handle?.dispose();
      await cold.fiber.dispose();
      await ctx.fiber.dispose();
    } finally {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      await writeFile(join(directory, 'http-exchanges.json'), JSON.stringify(requests, null, 2));
      await writeFile(join(directory, 'wire-failures.json'), JSON.stringify(wireFailures, null, 2));
      t.diagnostic(JSON.stringify({ received: requests.length, wireFailures }));
      await writeFile(join(directory, 'fixture-errors.json'), JSON.stringify(serverFailures.map(e => e.message)));
    }
  });
  const hostConfig = { artifactDirectory, routes: { openai: {
    kind: 'openai', ledgerPath, scope: 'web-openai', webAuthorization: authorization,
    endpoint: 'http://127.0.0.1:' + server.address().port + '/v1/responses',
    allowLocalTestEndpoint: true, network: { mode: 'direct' }, timeoutMs: 10000,
    modelPolicies: { [model]: { contextWindow: 100000, maxOutputTokens: 1000,
      requestMaxTokens: maxTokens, reasoningEfforts: [reasoningEffort] } },
  } } };
  const route = hostConfig.routes.openai;
  await ctx.plugin(RuntimeGuard, { mainMaxTokens: maxTokens, learn: null,
    routeAvailability: { main: { available: true }, learn: { available: false } },
    routes: { openai: { provider, endpoint: route.endpoint, modelPolicies: route.modelPolicies, network: route.network } } });
  const criticalFibers = { llm: await active(await ctx.plugin(LlmRuntime)), session: await active(await ctx.plugin(SessionStore)) };

  await ctx.plugin(SessionProjections);
  await ctx.plugin(JsonlPersistence, { root: persistenceRoot, compression: 'none' });
  await ctx.plugin(SystemPrompt, { personaPrefix: 'Execute only the explicitly requested local fixture work.' });
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(NativeToolExecutor);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(AgentLoop, { agents: [] });
  criticalFibers.credentials = await active(await ctx.plugin({ name: 'native-openai-fixture-credential', apply(child) {
    child.provide('credentials', { async resolve(ref) {
      assert.equal(ref, 'FIXTURE_NATIVE_OPENAI');
      return { value: 'sk-fixture-native-openai-not-a-real-key' };
    } });
    child.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]));
  } }));
  criticalFibers['arcfold-business'] = await active(await ctx.plugin(BusinessPlugin, { filename: join(directory, 'business.sqlite') }));
  criticalFibers['arcfold-shared-metered-host'] = await active(await ctx.plugin(HostPlugin, hostConfig));
  criticalFibers['arcfold-openai-provider'] = await active(await ctx.plugin(OpenAIPlugin, { apiKeyRef: 'FIXTURE_NATIVE_OPENAI', maxTokens, reasoningEffort }));
  criticalFibers['arcfold-openai-native'] = ctx.arcfoldOpenAIProviderIdentity.nativeFiber;
  // The Agent below installs the actual main plugin. This inert root marker is
  // only the preset ownership boundary; no installed browser is claimed here.
  criticalFibers['preset-arcfold-main'] = await active(await ctx.plugin({ name: 'native-main-fixture-preset', apply() {} }));
  const guard = RuntimeGuard.getRuntimeGuard(ctx);
  guard.arm({ criticalFibers, expectedAdapterUpdates: guard.snapshot().adapterUpdates,
    identifyRequest: options => nativeRequestIdentity(ctx.arcfoldBusiness, ctx.sessions, options) });
  if (stopBeforeDispatch) {
    const persist = OpenAITransport.prototype.persistJson;
    t.mock.method(OpenAITransport.prototype, 'persistJson', async function(path, value) {
      await persist.call(this, path, value);
      if (this.artifactDirectory === artifactDirectory && path.endsWith('/request.json')) guard.close();
    });
  }
  const sessionId = 'native-openai-' + randomUUID();
  const setup = async agentCtx => {
      await active(await agentCtx.plugin(MainPlugin));
      agentCtx.tools.register(defineTool({ name: toolName, description: 'Write and read the one fixed synthetic marker file.',
        parameters: {}, output: { schema: { type: 'json' }, render: (_args, value) => [
          { type: 'text', text: JSON.stringify(value) }, ...(withImages ? [{ type: 'image', attachment: toolImage }] : []),
        ] },
        async execute(_args, exec) {
          exec.signal.throwIfAborted(); toolExecutions++;
          await writeFile(markerPath, marker, { flag: 'wx' });
          const contents = await readFile(markerPath, 'utf8'); exec.signal.throwIfAborted();
          return { filename: 'native-marker.txt', contents };
        },
      }));
    };
  handle = await ctx.agents.create({ sessionId, meta: { cwd: workspace },
    agentOptions: { provider, model, maxTokens, reasoningEffort }, setup });
  const agent = handle.agent;
  const input = createUserMessage({ content: [
    { type: 'text', text: 'Write and read the isolated fixture marker, then report its actual result.' },
    ...(withImages ? [{ type: 'image', attachment: userImage }] : []),
  ],
    source: { kind: 'user' } });
  agent.followup(input);
  await bounded(agent.whenIdle(), 'Native Agent');
  assert.equal(await ctx.sessions.flush(agent.session), true);
  await ctx.arcfoldBridge.pending.get(sessionId);
  assert.deepEqual(serverFailures, []);
  const live = agent.session.snapshotEvents();
  await writeFile(join(directory, 'native-before-close.json'), JSON.stringify(live, null, 2));
  if (stopBeforeDispatch) {
    assert.equal(requests.length, 0); assert.equal(toolExecutions, 0);
    const db = new DatabaseSync(ledgerPath, { readOnly: true });
    let rows; try { rows = db.prepare("SELECT body FROM records WHERE kind='openai_requests'").all().map(row => JSON.parse(row.body)); } finally { db.close(); }
    assert.equal(rows.length, 1); assert.equal(rows[0].status, 'released'); assert.equal(rows[0].dispatchedAt, null); assert.equal(rows[0].usage, null);
    assert.equal(guard.snapshot().phase, 'closed');
    const persistedRequest = JSON.parse(await readFile(join(artifactDirectory, sha(rows[0].requestId), 'request.json'), 'utf8'));
    assert.ok(persistedRequest); assert.equal(ctx.arcfoldBusiness.listAll('deliveries', { where: { sessionId } }).length, 0);
    await writeFile(join(directory, 'final-root-revocation.json'), JSON.stringify({ requests: requests.length, toolExecutions, ledger: rows, guard: guard.snapshot() }, null, 2));
    return;
  }
  assert.equal(live.filter(e => e.type === 'turn/end').at(-1)?.data.reason.kind, 'completed',
    JSON.stringify(live.filter(e => ['step/end', 'assistant/attempt', 'turn/end'].includes(e.type))));
  assert.equal(requests.length, 2); assert.equal(toolExecutions, 1);
  assert.equal(await readFile(markerPath, 'utf8'), marker);
  const calls = live.filter(e => e.type === 'tool/call'), results = live.filter(e => e.type === 'tool/result');
  assert.equal(calls.length, 1); assert.equal(calls[0].data.name, toolName);
  assert.equal(results.length, 1); assert.equal(results[0].data.message.isError, false);
  assert.equal(results[0].data.message.toolCallId, calls[0].data.callId);
  assert.ok(JSON.stringify(results[0].data.message.content).includes(marker));
  const assistants = live.filter(e => e.type === 'assistant/message');
  assert.equal(assistants.length, 2);
  assert.equal(assistants[0].data.message.source.kind, 'model');
  assert.ok(assistants[1].data.message.content.some(block => block.type === 'text' && block.text === answer));
  assert.equal(assistants[0].data.usage.inputTokens, 8, 'Native pi-ai input excludes three cached tokens');
  assert.equal(assistants[0].data.usage.cacheReadTokens, 3);
  const replay = requests[1].body.input;
  assert.ok(replay.some(item => item.type === 'reasoning' && item.encrypted_content === encrypted));
  assert.ok(replay.some(item => item.type === 'function_call' && item.call_id === callId && item.name === toolName));
  assert.ok(replay.some(item => item.type === 'function_call_output' && item.call_id === callId && JSON.stringify(item.output).includes(marker)));
  const assertImageReplay = request => {
    assert.deepEqual(imageContent(request.body.input.filter(item => item.role === 'user')), [expectedUserImage]);
    const output = request.body.input.find(item => item.type === 'function_call_output' && item.call_id === callId)?.output;
    assert.ok(Array.isArray(output), 'A tool image requires the native structured tool result');
    assert.deepEqual(output.filter(block => block.type === 'input_image'), [expectedToolImage]);
    assert.ok(output.some(block => block.type === 'input_text' && block.text.includes(marker)));
    assert.ok(request.body.input.some(item => item.type === 'reasoning' && item.encrypted_content === encrypted));
  };
  if (withImages) {
    assert.deepEqual((await ctx.llm.resolveModelInfo(provider, model)).inputModalities, ['text', 'image']);
    assert.deepEqual(imageContent(requests[0].body.input), [expectedUserImage]);
    assert.deepEqual(live.find(event => event.type === 'user/message' && event.data.id === input.id).data.content,
      input.content, 'The durable native user message retains the original image reference');
    assert.deepEqual(results[0].data.message.content.filter(block => block.type === 'image'),
      [{ type: 'image', attachment: toolImage }]);
    assertImageReplay(requests[1]);
  }
  for (const request of requests) {
    assert.equal(request.body.model, model); assert.equal(request.body.max_output_tokens, maxTokens);
    assert.deepEqual(request.body.input.at(-1), { type: 'configuration_update', reasoning: { effort: reasoningEffort } });
  }
  const deliveries = ctx.arcfoldBusiness.listAll('deliveries', { where: { sessionId } });
  assert.equal(deliveries.length, 1); assert.equal(deliveries[0].throughSeq, live.findLast(e => e.type === 'turn/end').seq);
  const sources = ctx.arcfoldBusiness.listAll('events', { where: { conversationId: sessionId } });
  const original = sources.filter(row => row.message?.id === input.id);
  assert.equal(original.length, 1, 'Inbox and formal user input share one original');
  assert.ok(deliveries[0].inputEventIds.includes(original[0].id));
  assert.equal(ctx.arcfoldBusiness.listAll('learning_runs').length, 0, 'This fixture does not claim Learn execution');
  const assertReceipts = async events => {
    const db = new DatabaseSync(ledgerPath, { readOnly: true });
    let rows, authorities;
    try {
      rows = db.prepare("SELECT body FROM records WHERE kind='openai_requests' ORDER BY rowid").all().map(row => JSON.parse(row.body));
      authorities = db.prepare("SELECT body FROM records WHERE kind='openai_request_authorities' ORDER BY rowid").all().map(row => JSON.parse(row.body));
    } finally { db.close(); }
    assert.equal(rows.length, requests.length); assert.equal(authorities.length, requests.length);
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index], authority = authorities.find(item => item.id === row.requestId);
      assert.equal(row.status, 'settled');
      assert.deepEqual(row.usage, { promptTokens: 11, completionTokens: 3, cachedTokens: 3 });
      assert.equal(authority.scope, 'web-openai'); assert.equal(authority.metadata.role, 'main');
      assert.equal(authority.metadata.sessionId, sessionId);
      const prefix = events.slice(0, authority.metadata.nativeThroughSeq + 1);
      assert.equal(digest(prefix), authority.metadata.nativePrefixHash);
      assert.equal(prefix.findLast(e => e.type === 'step/start').seq, authority.metadata.stepStartSeq);
      const position = { sessionId, turn: authority.metadata.turn, step: authority.metadata.step, stepStartSeq: authority.metadata.stepStartSeq };
      assert.equal(row.requestId, 'dsh-messages-' + digest(position));
      assert.equal(row.specification.bodyHash, sha(requests[index].serialized));
      const evidence = join(artifactDirectory, sha(row.requestId));
      const requestEvidence = JSON.parse(await readFile(join(evidence, 'request.json'), 'utf8'));
      assert.equal(requestEvidence.serialized, requests[index].serialized);
      assert.deepEqual(requestEvidence.body, requests[index].body);
      assert.equal(await readFile(join(evidence, 'response-body.bin'), 'utf8'), response(index + 1, model));
      const receipt = JSON.parse(await readFile(join(evidence, 'receipt.json'), 'utf8'));
      assert.deepEqual(receipt.rawUsage, usage);
      assert.equal((await readdir(evidence)).some(name => name.startsWith('error-')), false);
    }
  };
  await assertReceipts(live);
  await handle.dispose(); handle = null;
  await ctx.arcfoldBridge.pending.get(sessionId);
  await cold.plugin(JsonlPersistence, { root: persistenceRoot, compression: 'none' });
  const persisted = await cold.sessionPersistence.open(sessionId, 'read');
  try {
    const readback = (await persisted.read()).events;
    assert.deepEqual(readback.slice(0, live.length), live);
    assert.equal(persisted.header.cwd, workspace);
    await writeFile(join(directory, 'native-cold-readback.json'), JSON.stringify(readback, null, 2));
  } finally { await persisted.close(); }
  assert.equal(requests.length, 2, 'Readback never submits another model request');
  if (withImages) {
    const coldAttachments = new LocalAttachmentStore(cold, { dshHome: attachmentHome });
    for (const [ref, expected] of [[userImage, expectedUserImage], [toolImage, expectedToolImage]]) {
      const stored = await coldAttachments.readImage(ref);
      assert.equal('data:' + ref.mediaType + ';base64,' + Buffer.from(stored.data).toString('base64'), expected.image_url);
    }
    // Reload through the real native resume path after its old Agent and Session
    // were removed. Only this explicit new follow-up authorizes the third call.
    assert.equal(ctx.agents.get(sessionId), undefined);
    handle = await ctx.agents.resume({ resumeSessionId: sessionId,
      agentOptions: { provider, model, maxTokens, reasoningEffort }, setup });
    assert.notEqual(handle.agent.session, agent.session);
    assert.deepEqual(handle.agent.session.snapshotEvents().slice(0, live.length), live);
    await bounded(handle.agent.whenIdle(), 'Resumed native Agent before follow-up');
    assert.equal(requests.length, 2, 'Resuming completed history does not repeat a paid step');
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Recall both prior images without running the tool again.' }],
      source: { kind: 'user' } }));
    await bounded(handle.agent.whenIdle(), 'Resumed native image follow-up');
    assert.equal(await ctx.sessions.flush(handle.agent.session), true);
    await ctx.arcfoldBridge.pending.get(sessionId);
    assert.equal(requests.length, 3); assert.equal(toolExecutions, 1);
    assert.deepEqual(serverFailures, []);
    assertImageReplay(requests[2]);
    assert.equal(requests[2].body.model, model);
    assert.deepEqual(requests[2].body.input.at(-1), { type: 'configuration_update', reasoning: { effort: reasoningEffort } });
    const resumed = handle.agent.session.snapshotEvents();
    assert.equal(resumed.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed');
    assert.equal(ctx.arcfoldBusiness.listAll('deliveries', { where: { sessionId } }).length, 2);
    await assertReceipts(resumed);
    await writeFile(join(directory, 'native-after-image-resume.json'), JSON.stringify(resumed, null, 2));
  }
});
