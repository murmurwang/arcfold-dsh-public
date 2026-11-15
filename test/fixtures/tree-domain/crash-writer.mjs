import { TreeRepository } from '../../../src/tree/repository.mjs';
const repo = new TreeRepository({ treeFilename: process.argv[2], userId: 'fixture-user' });
repo.command('crash-fixture', { requestId: 'interrupted-request', expected: {}, input: {} }, { kind: 'program', id: 'crash-fixture' }, () => {
  const root = repo.get('tree_nodes', repo.rootId()); repo.save('tree_nodes', { ...root, name: '未提交的名字' }, root.revision);
  // Spill SQLite pages so reopening must actually recover a hot journal, not
  // merely discard an in-memory transaction that never reached the file.
  for (let i = 0; i < 1400; i++) repo.save('tree_item_versions', { id: `crash-${i}`, itemId: 'crash-item', version: i + 1, content: 'x'.repeat(2000), sourceKind: 'unknown', sourceRefs: [], reason: 'fault injection' });
  process.exit(42);
});
