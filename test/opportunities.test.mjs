import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { OpportunityService } from '../src/opportunities.mjs';

function fixture(t) {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'arcfold-opportunities-'))), store = new Store(':memory:');
  t.after(() => store.close()); const service = new OpportunityService({ business: store, workspace });
  store.save('host_bindings', { id: 'main', role: 'main' });
  const source = store.save('events', { id: 'original', conversationId: 'main', role: 'user', author: 'user', content: '想把想法整理成一页稿。' });
  let counter = 0;
  const opportunity = () => {
    const id = 'opportunity-' + ++counter, pending = 'learning-' + counter;
    const row = store.save('opportunities', { id, learnedFromRunId: pending, conversationId: 'main',
      description: '准备一页稿', rationale: '用户希望先看材料', suggestedPreparation: '形成可审阅的文字',
      sourceIds: [source.id], dependencies: [{ kind: 'events', id: source.id, revision: source.revision }], status: 'pending' });
    store.save('learning_sections', { id: pending + ':opportunities', status: 'completed', ids: [id] }); return row;
  };
  const grant = (changes = {}) => service.savePermission({ sessionId: 'main', expectedRevision: service.permission('main')?.revision ?? 0,
    enabled: true, extraSourceIds: [], files: [], requestId: 'permission-' + Math.random(), userIdentity: 'browser:owner', ...changes });
  const executionConfig = { preset: 'arcfold-preparation', provider: 'fixture', model: 'fixture', reasoningEffort: 'off', maxTokens: 64, cwd: workspace };
  return { store, service, workspace, source, opportunity, grant, executionConfig, freeze: (id, extra = {}) => service.freeze(id, { executionConfig, ...extra }) };
}
test('default off; permission is versioned, idempotent and cannot admit old backlog automatically', async t => {
  const f = fixture(t), old = f.opportunity(); assert.equal(f.service.permission('main'), null);
  await assert.rejects(f.freeze(old.id), /尚未允许/);
  const grant = f.grant({ requestId: 'stable' });
  assert.equal(f.grant({ expectedRevision: 0, requestId: 'stable' }).revision, grant.revision);
  assert.throws(() => f.grant({ expectedRevision: 0, requestId: 'stable', enabled: false }), /不能更换/);
  assert.deepEqual(f.service.candidates(), []); await assert.rejects(f.freeze(old.id), /逐项/);
  const next = f.opportunity(); assert.deepEqual(f.service.candidates(), [next.id]);
  const admitted = await f.freeze(next.id); assert.equal(admitted.created, true);
  assert.equal((await f.freeze(next.id)).created, false); assert.deepEqual(f.service.candidates(), []);
  assert.equal((await f.freeze(old.id, { explicit: true })).created, true);
});
test('uncommitted/reused section and changed exact dependencies cannot create a new attempt', async t => {
  const f = fixture(t); f.grant(); const row = f.opportunity();
  const section = f.store.get('learning_sections', row.learnedFromRunId + ':opportunities');
  f.store.save('learning_sections', { ...section, status: 'failed' }, { expectedRevision: section.revision });
  await assert.rejects(f.freeze(row.id), /分区/);
  const real = f.opportunity(); f.store.save('source_controls', { id: f.source.id, withdrawn: true });
  await assert.rejects(f.freeze(real.id), /失效/); assert.deepEqual(f.service.candidates(), []);
});
test('scope grant includes future messages but never other conversation or withdrawn originals', async t => {
  const f = fixture(t); f.grant();
  const source = f.store.save('events', { id: 'other', conversationId: 'other-main', role: 'user', content: '别处的原话' });
  const row = f.opportunity(); f.store.save('opportunities', { ...row, sourceIds: [source.id], dependencies: [{ kind: 'events', id: source.id, revision: 1 }] }, { expectedRevision: row.revision });
  await assert.rejects(f.freeze(row.id), /范围以外/);
  f.grant({ extraSourceIds: [source.id] }); const admitted = await f.freeze(row.id, { explicit: true });
  assert.equal(admitted.run.input.records.find(r => r.id === source.id).original.content, '别处的原话');
  f.store.save('source_controls', { id: source.id, useProhibited: true });
  assert.throws(() => f.service.assertCurrent(admitted.run.id), /失效/);
});
test('material freeze runs outside transaction, stops after selected file changes and preserves original byte hash', async t => {
  const f = fixture(t), path = join(f.workspace, 'source.md'); writeFileSync(path, '实际原话😀\r\n');
  f.grant({ files: [path] }); const row = f.opportunity(), { run } = await f.freeze(row.id);
  assert.equal(run.input.files[0].text, '实际原话😀\r\n'); f.service.assertCurrent(run.id);
  writeFileSync(path, '已经修改'); assert.throws(() => f.service.assertCurrent(run.id), /文件已变化/);
});
test('two concurrent freezes admit once, revoke and stop preserve old run without granting retries', async t => {
  const f = fixture(t); f.grant(); const row = f.opportunity();
  const values = await Promise.all([f.freeze(row.id), f.freeze(row.id)]); assert.equal(values.filter(v => v.created).length, 1);
  const run = values[0].run;
  f.service.stop({ runId: run.id, expectedRevision: run.revision, requestId: 'stop', userIdentity: 'browser:owner' });
  assert.throws(() => f.service.assertCurrent(run.id), /停止/);
  f.grant({ enabled: false }); assert.equal((await f.freeze(row.id, { explicit: true })).created, false);
  assert.equal(f.store.listAll('preparation_runs').length, 1);
});
test('large complete original input is refused, no truncation or synthetic summary', async t => {
  const f = fixture(t); f.grant(); const huge = f.store.save('events', { id: 'huge', conversationId: 'main', role: 'user', content: 'x'.repeat(1048577) });
  const row = f.opportunity(); f.store.save('opportunities', { ...row, sourceIds: [huge.id], dependencies: [] }, { expectedRevision: row.revision });
  await assert.rejects(f.freeze(row.id), /1 MiB/); assert.equal(f.store.listAll('preparation_runs').length, 0);
});
test('continuation keeps exact new user text; unknown admission is durable and cannot resend', t => {
  const f = fixture(t), row = f.opportunity();
  const request = { sessionId: 'main', opportunityId: row.id, expectedRevision: row.revision, requestId: 'rpc', text: '只继续整理第一段。', userIdentity: 'browser:owner' };
  const value = f.service.bindContinuation(request); assert.equal(value.created, true);
  f.service.continuationAdmission(value.binding.id, 'unknown'); assert.equal(f.service.bindContinuation(request).created, false);
  assert.throws(() => f.service.bindContinuation({ ...request, text: '换了原话' }));
  f.store.save('events', { id: 'program', conversationId: 'main', role: 'program', message: { source: { kind: 'user', rpcId: 'rpc' }, content: [{ type: 'text', text: request.text }] } });
  f.service.reconcileContinuations(); assert.equal(f.store.get('opportunity_continuations', value.binding.id).original, null);
  f.store.save('events', { id: 'actual-user', conversationId: 'main', role: 'user', message: { source: { kind: 'user', rpcId: 'rpc' }, content: [{ type: 'text', text: request.text }] } });
  f.service.reconcileContinuations(); assert.equal(f.store.get('opportunity_continuations', value.binding.id).original.id, 'actual-user');
});


test('default selection is rechecked after actual asynchronous file reading and before saving a frozen run', async t => {
  const f = fixture(t), file = join(f.workspace, 'input'); writeFileSync(file, 'original'); f.grant({ files: [file] }); const row = f.opportunity();
  let version = 1, observed = 0;
  const pending = f.freeze(row.id, { assertSelection() { observed++; if (version !== 1) throw new Error('selection changed'); } });
  version = 2; await assert.rejects(pending, /selection changed/); assert.equal(observed, 1); assert.equal(f.store.listAll('preparation_runs').length, 0);
  f.service.rejectBeforeExecution(row.id, new Error('selection changed'));
  assert.equal(f.service.details(row.id).rejection.executed, false); assert.deepEqual(f.service.candidates(), []);
});
test('manual preparation request identity and displayed revisions are durable even before a native run exists', t => {
  const f = fixture(t); f.grant(); const row = f.opportunity();
  const request = { opportunityId: row.id, expectedRevision: row.revision, permissionRevision: 1, requestId: 'manual', userIdentity: 'browser:owner' };
  const first = f.service.bindPreparation(request); assert.equal(first.created, true); assert.deepEqual(f.service.candidates(), []);
  f.service.preparationAdmission(first.binding.id, 'unknown'); assert.equal(f.service.bindPreparation(request).created, false);
  assert.throws(() => f.service.bindPreparation({ ...request, permissionRevision: 2 }), /不能更换/);
  assert.throws(() => f.service.bindPreparation({ ...request, expectedRevision: 7, requestId: 'new' }), /变化/);
  assert.equal(f.store.listAll('preparation_runs').length, 0);
});
