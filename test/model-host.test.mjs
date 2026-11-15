import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import * as Connection from '@deepseek-ai/dsh-client-connection';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import TypertGateway from '@deepseek-ai/dsh-api-gateway';
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import * as Host from '../packages/method-ui/src/index.mjs';
import { BusinessStore } from '../src/business.mjs';
import { LearningDefaults } from '../src/learning-defaults.mjs';
const selection = { provider: 'fixture', model: 'one', reasoningEffort: 'off' };
const request = { expectedRevision: 1, ...selection };
function response() {
  const state = {}, chunks = [];
  return { state, response: Object.assign(new EventEmitter(), { writableEnded: false,
    writeHead(status, headers) { Object.assign(state, { status, headers }); return this; },
    write(chunk) { chunks.push(Buffer.from(chunk)); return true; },
    end(chunk) { if (chunk !== undefined) chunks.push(Buffer.from(chunk)); this.writableEnded = true;
      state.body = Buffer.concat(chunks).toString('utf8'); return this; } }) };
}
test('one actual UI Host batch and official authenticated Gateway preserve model settings, revision errors and unload', async t => {
  const ctx = new Context(), routes = [], upgrades = [], business = new BusinessStore({ filename: ':memory:' });
  t.after(async () => { await ctx.fiber.dispose(); business.close(); });
  let record, writes = 0, reads = 0;
  ctx.provide('credentials', { readRecord: async () => record, async modifyRecord(_key, mutate) { record = await mutate(record); return record; },
    async deleteRecord() { record = undefined; } });
  const register = rows => row => { assert.ok(!rows.some(previous => previous.path === row.path && previous.kind === row.kind)); rows.push(row);
    return () => rows.splice(rows.indexOf(row), 1); };
  await ctx.plugin({ name: 'fixture-model-carrier', apply(owner) { owner.provide('webServer', { host: '127.0.0.1', protocol: 'http:', port: 3080,
    register: register(routes), registerUpgrade: register(upgrades), tapIndex: () => () => {} }); } }).await();
  const defaults = new LearningDefaults({ business, deployment: { ...selection, preset: 'fixture', cwd: '/fixture', maxTokens: 64 }, assertSelection: () => {} });
  defaults.initialize();
  ctx.provide('arcfoldMethods', {});
  ctx.provide('arcfoldRuntimeModels', { read() { reads++; return { learning: { defaults: defaults.read() } }; },
    saveLearning(value, assertCaller) { assertCaller(); const saved = defaults.save(value); writes++; return saved; } });
  for (const plugin of [Connection, TypertRegistry, RemoteAccess, TypertGateway]) await ctx.plugin(plugin).await();
  const before = routes.length, fiber = ctx.plugin(Host); await fiber.await();
  assert.equal(fiber.state, 2); assert.equal(routes.length, before);
  for (const endpoint of ['arcfoldMethods/decide', 'arcfoldGoals/list', 'arcfoldModels/read', 'arcfoldModels/saveLearning'])
    assert.ok(ctx.typert.local.get(endpoint), endpoint);
  const connection = ctx.connection, boot = new URL(connection.authenticatedUrl('http://127.0.0.1:3080/')), auth = response();
  connection.authorizeIndex({ url: boot.pathname + boot.search, method: 'GET', headers: { host: boot.host } }, auth.response);
  const cookie = auth.state.headers['set-cookie'].split(';', 1)[0], route = routes.find(value => value.path === '/api');
  const invoke = async (method, payload, authenticated = true) => {
    const envelope = { type: 'client-request', rpcId: 'models-' + method, method: 'arcfoldModels/' + method, payload: { args: { request: payload } } };
    const input = Object.assign(Readable.from([Buffer.from(JSON.stringify(envelope))]), { url: '/api/' + envelope.method, method: 'POST',
      headers: { host: boot.host, 'content-type': 'application/json', ...(authenticated ? { cookie } : {}) } });
    const result = response(); await route.handler(input, result.response); return result.state;
  };
  assert.equal((await invoke('saveLearning', request, false)).status, 401); assert.equal(writes, 0);
  const view = JSON.parse((await invoke('read', {})).body).result; assert.equal(view.ok, true); assert.equal(reads, 1);
  assert.equal(JSON.parse((await invoke('read', { sessionId: 'must-not-activate' })).body).result.error.code, 'invalid_model_request');
  assert.equal(reads, 1);
  const saved = JSON.parse((await invoke('saveLearning', request)).body).result;
  assert.equal(saved.ok, true); assert.equal(saved.value.revision, 2); assert.equal(writes, 1);
  const stale = JSON.parse((await invoke('saveLearning', request)).body).result;
  assert.equal(stale.ok, false); assert.equal(stale.error.code, 'revision_conflict'); assert.deepEqual(stale.error.details, {});
  assert.equal(writes, 1);
  const other = connection.createPeer({ principal: { kind: 'owner' }, interactions: 'answer' });
  await assert.rejects(ctx.typertGateway.invoke({ namespace: 'arcfoldModels', method: 'saveLearning', args: { request: { ...request, expectedRevision: 2 } }, peer: other }),
    error => error.code === 'trusted_browser_required'); await other.dispose(); assert.equal(writes, 1);
  await fiber.dispose(); assert.equal(ctx.typert.local.get('arcfoldModels/read'), undefined);
  assert.equal(routes.length, before); assert.equal(ctx.connection.browserPeer, connection.browserPeer);
});
