import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// These contracts need the original host packages. test-isolated passes the
// lock-matched install, leaving its copy available before applying Arcfold patches.
assert.ok(process.env.ARCFOLD_PATCH_TEST_INSTALLATION, 'Supply the frozen dependency installation');
export const host = realpathSync(process.env.ARCFOLD_PATCH_TEST_INSTALLATION);
const requireHost = createRequire(join(host, 'package.json'));
export const load = name => import(pathToFileURL(requireHost.resolve(name)).href);
export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export function save(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}
export function evidenceRoot(t, label) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tree-host-' + label + '-')));
  t?.diagnostic('B0 evidence: ' + root);
  return root;
}
export function fingerprint() {
  const packages = ['cordis', 'dsh', 'dsh-agent', 'dsh-agent-loop', 'dsh-session', 'dsh-tools',
    'dsh-compaction-basic', 'dsh-token-meter', 'dsh-sandbox', 'dsh-sandbox-local', 'dsh-llm-deepseek'];
  return { node: process.version, platform: process.platform, arch: process.arch,
    lockFile: 'package-lock.json', lockSha256: hash(readFileSync(join(host, 'package-lock.json'))),
    packages: packages.map(name => {
      const dir = join(host, 'node_modules/@deepseek-ai', name);
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json')));
      return { name: pkg.name, version: pkg.version, packageSha256: hash(readFileSync(join(dir, 'package.json'))),
        entrySha256: name === 'dsh' ? null : hash(readFileSync(requireHost.resolve('@deepseek-ai/' + name))) };
    }) };
}
export async function active(fiber) {
  const deadline = Date.now() + 5000;
  for (;;) {
    await fiber.await();
    if (fiber.state === 2) return fiber;
    assert.ok([0, 1].includes(fiber.state) && Date.now() < deadline, 'Frozen host plugin must activate');
    await delay(1);
  }
}
export async function bounded(promise, label = 'host operation') {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' timed out')), 15000);
  })]); } finally { clearTimeout(timer); }
}
export const textOf = messages => messages.flatMap(m => m.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
export function chunks(blocks) {
  return [...blocks.flatMap((block, index) => [
    { type: 'block-start', index, blockType: block.type }, { type: 'block-end', index, block },
  ]), { type: 'finish', reason: { kind: 'stop' } }];
}
export const answer = text => chunks([{ type: 'text', text }]);
export const calls = names => chunks(names.map((name, index) => ({ type: 'tool-call', id: 'call-' + index, name, arguments: '{}' })));
export function assertPairs(messages) {
  const pending = new Set();
  for (const message of messages) {
    for (const block of message.content ?? []) if (block.type === 'tool-call') {
      assert.ok(!pending.has(block.id)); pending.add(block.id);
    }
    if (message.role === 'tool') {
      assert.ok(pending.delete(message.toolCallId), 'Tool result retains its matching call');
    }
  }
  assert.equal(pending.size, 0, 'Request has no unresolved tool calls');
}

export async function nativeFixture(t, label, script) {
  const [{ Context }, { default: LlmRuntime, LlmAdapter, createUserMessage },
    { default: Sessions }, { default: Projections }, Persistence, { default: SystemPrompt },
    { default: Tools, defineTool }, Executor, { default: Agents }, { default: Loop }] = await Promise.all([
      load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-llm'), load('@deepseek-ai/dsh-session'),
      load('@deepseek-ai/dsh-session-projection'), load('@deepseek-ai/dsh-session-persistence-jsonl'),
      load('@deepseek-ai/dsh-system-prompt'), load('@deepseek-ai/dsh-tools'),
      load('@deepseek-ai/dsh-tool-executor-native'), load('@deepseek-ai/dsh-agent'), load('@deepseek-ai/dsh-agent-loop'),
    ]);
  const root = evidenceRoot(t, label), ctx = new Context(), handles = [], trace = [], requests = [];
  let order = 0;
  const record = (event, facts = {}) => trace.push({ order: ++order, event, ...facts });
  const user = (text, source = { kind: 'user' }) => createUserMessage({ source, content: [{ type: 'text', text }] });
  t.after(async () => {
    for (const handle of handles) await handle.dispose();
    try { save(join(root, 'evidence.json'), { kind: 'real-frozen-runtime-scripted-provider-no-network',
      dependencies: fingerprint(), trace, requests, sessions: handles.map(h => ({ id: h.agent.id, events: h.agent.session.snapshotEvents() })) }); }
    finally { await ctx.fiber.dispose(); }
  });
  for (const plugin of [LlmRuntime, Sessions, Projections]) await active(await ctx.plugin(plugin));
  await active(await ctx.plugin(Persistence, { root: join(root, 'sessions'), compression: 'none' }));
  await active(await ctx.plugin(SystemPrompt, { personaPrefix: 'Synthetic B0 host contract fixture only.' }));
  for (const plugin of [Tools, Executor, Agents]) await active(await ctx.plugin(plugin));
  await active(await ctx.plugin(Loop, { agents: [] }));
  ctx.on('session/event', (session, event) => record('session:' + event.type, { session: session.id, seq: event.seq,
    turn: event.data.turn, step: event.data.step }));
  class Scripted extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id, contextWindow: 1048576, inputModalities: ['text'],
      defaultMaxTokens: 128, reasoning: { efforts: [{ id: 'off', name: 'Off' }], defaultEffort: 'off' } }; }
    async *stream(options) {
      const request = { sessionId: options.sessionId, model: options.model, messages: structuredClone(options.messages),
        tools: options.tools, inputHash: hash(options.messages) };
      requests.push(request); record('provider:request', { session: options.sessionId, ordinal: requests.length, inputHash: request.inputHash });
      const result = await script(options, requests.length);
      assert.ok(Array.isArray(result), 'Fixture must explicitly supply every model step');
      yield* result;
    }
  }
  ctx.llm.registerAdapter(['fixture'], new Scripted());
  async function agent(id, setup = async () => {}) {
    const handle = await ctx.agents.create({ sessionId: id, agentOptions: { provider: 'fixture', model: 'fixture', maxTokens: 128, reasoningEffort: 'off' },
      setup }); handles.push(handle); return handle.agent;
  }
  const tool = (owner, name, execute) => owner.tools.register(defineTool({ name, description: 'Synthetic B0 marker', parameters: {},
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute }));
  async function run(agent, text) { agent.followup(user(text)); await bounded(agent.whenIdle()); assert.equal(await ctx.sessions.flush(agent.session), true); }
  return { root, ctx, agent, run, user, tool, trace, requests, record, handles };
}
