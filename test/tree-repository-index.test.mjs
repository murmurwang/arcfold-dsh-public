import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/tree-domain/helpers.mjs';
import { TreeRepository } from '../src/tree/repository.mjs';

test('node index follows local writes, rollback and another repository connection', t => {
  const f = fixture(t), a = f.create('甲'), b = f.create('乙');
  f.asModel('learning', [a]);
  const id = f.propose(a, { understandings: [{ content: '合成理解', source: 'user_expressed', sourceRefs: [f.ref] }] }).understandings.itemIds[0];
  const byNode = node => f.repo.listByNodeIds('tree_items', [node]).map(item => item.id);
  assert.deepEqual(byNode(a), [id]); assert.deepEqual(byNode(b), []);

  const before = f.repo.get('tree_items', id);
  assert.throws(() => f.repo.transaction(() => {
    f.repo.save('tree_items', { ...before, nodeId: b }, before.revision);
    assert.deepEqual(byNode(b), [id]);
    throw new Error('roll back');
  }), /roll back/);
  assert.deepEqual(byNode(a), [id]); assert.deepEqual(byNode(b), []);

  const other = new TreeRepository({ treeFilename: f.repo.filename, userId: f.repo.userId });
  t.after(() => other.close());
  const current = other.get('tree_items', id);
  other.transaction(() => other.save('tree_items', { ...current, nodeId: b }, current.revision));
  assert.deepEqual(byNode(a), []); assert.deepEqual(byNode(b), [id]);
  assert.deepEqual(f.repo.listByNodeIds('tree_items', [a, b]), f.repo.list('tree_items', item => [a, b].includes(item.nodeId)));
});
