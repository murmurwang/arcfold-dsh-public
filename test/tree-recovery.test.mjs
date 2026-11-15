import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './fixtures/tree-domain/helpers.mjs';
import { TreeRepository } from '../src/tree/repository.mjs';
import { TreeService } from '../src/tree/tree.mjs';
import { digest } from '../src/tree/contracts.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('D09: new tree starts with one root, never migrates legacy bytes, and refuses aliases/future/altered schemas before writing', t => {
  const f = fixture(t), legacy = join(f.dir, 'legacy.sqlite'); writeFileSync(legacy, 'old data, must remain exact'); const before = readFileSync(legacy);
  assert.equal(f.repo.list('tree_nodes').length, 1); assert.equal(f.repo.list('tree_items').length, 0);
  assert.throws(() => new TreeRepository({ treeFilename: legacy, legacyFilename: legacy, userId: 'fixture-user' }), { code: 'LEGACY_DATABASE' });
  const alias = join(f.dir, 'legacy-alias.sqlite'); linkSync(legacy, alias); assert.throws(() => new TreeRepository({ treeFilename: alias, legacyFilename: legacy, userId: 'fixture-user' }), { code: 'LEGACY_DATABASE' });
  assert.throws(() => new TreeRepository({ treeFilename: legacy, userId: 'fixture-user' }), { code: 'UNKNOWN_SCHEMA' }); assert.deepEqual(readFileSync(legacy), before);
  f.repo.close(); const db = new DatabaseSync(f.repo.filename); db.exec('PRAGMA user_version=999'); db.close(); const futureBytes = readFileSync(f.repo.filename);
  assert.throws(() => new TreeRepository({ treeFilename: f.repo.filename, userId: 'fixture-user' }), { code: 'UNKNOWN_SCHEMA' }); assert.deepEqual(readFileSync(f.repo.filename), futureBytes);
  const tamper = new DatabaseSync(f.repo.filename); tamper.exec('PRAGMA user_version=1; DROP INDEX turn_native_identity; CREATE INDEX turn_native_identity ON records(id)'); tamper.close();
  const altered = readFileSync(f.repo.filename); assert.throws(() => new TreeRepository({ treeFilename: f.repo.filename, userId: 'fixture-user' }), { code: 'UNKNOWN_SCHEMA' }); assert.deepEqual(readFileSync(f.repo.filename), altered);
});

test('reopen and retry returns identical receipt; rollback and nested savepoints leave no partial facts', t => {
  const f = fixture(t), command = f.attribution([{ action: 'create', name: '恢复' }]), receipt = f.tree.applyAttribution(command);
  assert.throws(() => f.repo.transaction(() => { const node = f.repo.get('tree_nodes', receipt.result.nodeIds[0]); f.repo.save('tree_nodes', { ...node, name: '应回滚' }, node.revision); throw new Error('crash fixture'); }), /crash fixture/);
  assert.equal(f.repo.get('tree_nodes', receipt.result.nodeIds[0]).name, '恢复');
  assert.throws(() => f.repo.transaction(async () => 1), { code: 'ASYNC_TRANSACTION' });
  assert.throws(() => f.repo.transaction(() => Promise.resolve(1)), { code: 'ASYNC_TRANSACTION' });
  f.repo.close(); const reopened = new TreeRepository({ treeFilename: f.repo.filename, userId: 'fixture-user' }); t.after(() => reopened.close());
  const tree = new TreeService({ repository: reopened, context: () => f.context, resolveSource: () => { throw new Error('idempotent replay must not reread or rewrite'); } });
  assert.deepEqual(tree.applyAttribution(command), receipt); assert.equal(reopened.list('tree_nodes').length, 2); assert.equal(reopened.list('tree_change_events').length, 1);
});

test('source identity, immutable versions and append-only audit reject in-place replacement', t => {
  const f = fixture(t), receipt = f.tree.applyAttribution(f.attribution([{ action: 'create', name: '审计' }])); const turn = f.repo.get('tree_turns', receipt.result.turnId);
  assert.throws(() => f.repo.transaction(() => f.repo.save('tree_turns', { ...turn, sourceRefs: [f.source('改过原文')] }, turn.revision)), { code: 'IMMUTABLE_SOURCE' });
  const event = f.repo.get('tree_change_events', receipt.eventIds[0]); assert.throws(() => f.repo.transaction(() => f.repo.save('tree_change_events', event, event.revision)), { code: 'IMMUTABLE_RECORD' });
  assert.equal(f.repo.get('tree_turns', turn.id).sourceRefs[0].sha256, f.ref.sha256);
  const snapshot = digest(f.repo.list('tree_nodes'));
  assert.throws(() => f.tree.moveNode(f.cmd({ nodeId: receipt.result.nodeIds[0], parentId: f.repo.rootId(), sourceRefs: [] }, { 'tree_nodes:missing': 1 })), { code: 'REVISION_CONFLICT' }); assert.equal(digest(f.repo.list('tree_nodes')), snapshot);
});

test('a process dies after uncommitted pages spill; recovery preserves committed receipts and discards all partial writes', t => {
  const f = fixture(t), command = f.attribution([{ action: 'create', name: '已提交' }]), receipt = f.tree.applyAttribution(command); f.repo.close();
  const crash = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/tree-domain/crash-writer.mjs', import.meta.url)), f.repo.filename], { encoding: 'utf8' }); assert.equal(crash.status, 42, crash.stderr);
  const recovered = new TreeRepository({ treeFilename: f.repo.filename, userId: 'fixture-user' }); t.after(() => recovered.close());
  assert.equal(recovered.get('tree_nodes', recovered.rootId()).name, '我'); assert.equal(recovered.list('tree_item_versions').length, 0);
  assert.deepEqual(recovered.get('tree_receipts', receipt.id), receipt); assert.equal(recovered.list('tree_receipts').length, 1);
});
