import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapFixture } from './fixtures/tree-integration/bootstrap.mjs';
import { emptyLearning } from './fixtures/tree-learning/helpers.mjs';
import { active } from './fixtures/tree-model/native.mjs';
import * as Bash from '@deepseek-ai/dsh-tool-bash';
import * as FileTools from '@deepseek-ai/dsh-tool-fs';
import * as FileSearch from '@deepseek-ai/dsh-tool-fs-search';
import * as ShellEnvironment from '@deepseek-ai/dsh-shell-env';

const reply = row => row.role === 'attribution'
  ? { actions: [{ action: 'continue', nodeId: row.input.scope.nodeIds[0] }], statusChanges: [] }
  : row.role === 'learning' ? emptyLearning() : '合成回复';
const text = body => body.messages.flatMap(m => m.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');

test('continuing after a connection error refreshes a background change between preparation and dispatch', async t => {
  let continuing = false, changed = false, expected;
  const f = await bootstrapFixture(t, row => {
    if (row.role === 'main' && !continuing) throw new Error('synthetic connection interrupted');
    return reply(row);
  }, { nativeModels: true, nativeHost: true });
  const agent = await f.main('main-input-retry', async ctx => {
    // The small bootstrap preset intentionally omits ordinary tools. Mount the
    // same native tool plugins/settings used by presets/arcfold.patch.yml.
    await active(await ctx.plugin(ShellEnvironment, { dshHome: f.privateRoot }));
    await active(await ctx.plugin(Bash));
    await active(await ctx.plugin(FileTools, { read: true, readImage: false, write: true, edit: true, applyPatch: false }));
    await active(await ctx.plugin(FileSearch, { sampleOverCapGlobResults: false }));
    ctx.on('agent/request', async (_payload, next) => {
      const config = await next();
      if (continuing && !changed) {
        changed = true;
        const node = f.repo.get('tree_nodes', f.repo.rootId());
        f.repo.transaction(() => f.repo.save('tree_nodes', { ...node, name: '更新后的合成概貌' }, node.revision));
        expected = f.runtime.builder.capture(agent.session.id);
      }
      return config;
    });
  });
  await f.turn(agent, '合成首次请求');
  assert.equal(agent.session.snapshotEvents().findLast(e => e.type === 'turn/end').data.reason.kind, 'error');
  continuing = true;
  const turn = await f.turn(agent, '继续');
  assert.ok(changed);
  assert.equal(agent.session.snapshotEvents().findLast(e => e.type === 'turn/end').data.reason.kind, 'completed');
  assert.equal(turn.status, 'settled');
  assert.match(text(f.requests.filter(r => r.role === 'main').at(-1).body), /更新后的合成概貌/);
  const job = f.runtime.mainJob(agent.session.id, 2), invocation = f.repo.get('tree_invocations', job.invocationIds[0]);
  const exposure = f.repo.list('tree_exposures', e => e.invocationId === invocation.id)[0];
  assert.equal(exposure.contextKey, expected.key);
  const headerTools = agent.session.requestHeader().tools.map(t => t.name).sort();
  const wireTools = f.requests.filter(r => r.role === 'main').at(-1).body.tools.map(t => t.name).sort();
  for (const name of ['bash', 'read', 'write', 'edit', 'glob', 'grep']) assert.ok(headerTools.includes(name), name);
  assert.deepEqual(wireTools, headerTools, 'actual native header and loopback service retain the same complete tool list');
  const refresh = Object.values(f.repo.meta().runtimeDiagnostics).find(d => d.kind === 'main_input_refresh');
  assert.equal(refresh.currentSnapshotKey, expected.key);
  assert.notEqual(refresh.mountedSnapshotKey, expected.key);
});

for (const reason of ['turn', 'assignment', 'user_message', 'context_messages']) {
  test(`a ${reason} mismatch is diagnosed in Chinese and cannot be repaired by refreshing a snapshot`, async t => {
    const f = await bootstrapFixture(t, reply, { nativeModels: true });
    let prepared;
    const agent = await f.main('main-input-' + reason, ctx => {
      ctx.on('agent/pre-step', async (_payload, next) => {
        const decision = await next(); prepared = decision.messages; return decision;
      }, { prepend: true });
      ctx.on('agent/request', async (_payload, next) => {
        const config = await next(), scope = f.runtime.builder.scope(agent.session.id);
        const node = f.repo.get('tree_nodes', f.repo.rootId());
        f.repo.transaction(() => f.repo.save('tree_nodes', { ...node, name: '背景同时变化' }, node.revision));
        if (reason === 'turn') {
          const meta = f.repo.meta();
          f.repo.transaction(() => f.repo.save('tree_meta', { ...meta, contextSessions: { ...meta.contextSessions,
            [agent.session.id]: { ...scope, turnId: 'synthetic-replaced-turn' } } }, meta.revision));
        } else if (reason === 'assignment') {
          const turn = f.repo.get('tree_turns', scope.turnId);
          f.repo.transaction(() => f.repo.save('tree_turns', { ...turn, assignmentRevision: turn.assignmentRevision + 1 }, turn.revision));
        } else {
          const kind = reason === 'user_message' ? 'user' : 'arcfold/tree-context';
          const index = prepared.findIndex(m => m.source?.kind === kind);
          assert.ok(index >= 0);
          prepared[index] = { ...prepared[index], content: [{ type: 'text', text: 'SECRET_SYNTHETIC_BODY' }] };
        }
        return config;
      });
    });
    await f.turn(agent, 'SECRET_SYNTHETIC_ORIGINAL');
    assert.equal(f.requests.filter(r => r.role === 'main').length, 0);
    const error = agent.session.snapshotEvents().findLast(e => e.type === 'turn/end').data.reason.error;
    assert.equal(error.code, 'MAIN_INPUT_GUARD');
    assert.match(error.message, /本轮未发送/);
    const failures = Object.values(f.repo.meta().runtimeDiagnostics).filter(d => d.kind === 'main_input_guard');
    assert.equal(failures.length, 1); assert.equal(failures[0].reason, reason);
    assert.equal(failures[0].sessionId, agent.session.id);
    assert.ok(failures[0].turnId); assert.equal(failures[0].mountedSnapshotKey.length, 64);
    assert.ok(!JSON.stringify(f.repo.meta().runtimeDiagnostics).includes('SECRET_SYNTHETIC'));
  });
}

test('a late snapshot change is still blocked by the final synchronous guard with both snapshot keys', async t => {
  const f = await bootstrapFixture(t, reply, { nativeModels: true });
  const agent = await f.main('main-input-late-snapshot');
  let lateKey;
  f.runtime.owner.prepareInput = request => {
    if (request.sessionId !== agent.session.id) return;
    const node = f.repo.get('tree_nodes', f.repo.rootId());
    f.repo.transaction(() => f.repo.save('tree_nodes', { ...node, name: 'SECRET_SYNTHETIC_LATE' }, node.revision));
    lateKey = f.runtime.builder.capture(agent.session.id).key;
  };
  await f.turn(agent, 'SECRET_SYNTHETIC_ORIGINAL');
  assert.equal(f.requests.filter(r => r.role === 'main').length, 0);
  const failure = Object.values(f.repo.meta().runtimeDiagnostics).find(d => d.kind === 'main_input_guard');
  assert.equal(failure.reason, 'snapshot'); assert.notEqual(failure.currentSnapshotKey, failure.mountedSnapshotKey);
  assert.equal(failure.currentSnapshotKey, lateKey);
  assert.ok(!JSON.stringify(f.repo.meta().runtimeDiagnostics).includes('SECRET_SYNTHETIC'));
});
