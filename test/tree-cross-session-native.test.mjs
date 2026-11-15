import test from 'node:test';
import assert from 'node:assert/strict';
import { integratedFixture } from './fixtures/tree-integration/native.mjs';
import { emptyLearning, emptyVerification } from './fixtures/tree-learning/helpers.mjs';

test('native provider receives the other session’s same-goal answer without sibling history', async t => {
  const f = await integratedFixture(t, (row, runtime) => {
    if (row.role === 'attribution') {
      const user = row.input.sources.find(source => source.role === 'user').text;
      const name = user.includes('相册') ? '相册' : '活动';
      const node = runtime.repo.list('tree_nodes', item => item.name === name)[0];
      return { actions: [node ? { action: 'switch', nodeId: node.id } : { action: 'create_child', parentId: runtime.repo.rootId(), name }], statusChanges: [] };
    }
    if (row.role === 'learning') return emptyLearning();
    if (row.role === 'verification') return emptyVerification();
    return JSON.stringify(row.body.messages).includes('相册私有') ? '相册独有答复' : '集合、慢行观察、结束收尾';
  });
  // This fixture checks context selection. The attribution deadline has its
  // own tests and can expire before a synthetic answer in the loaded full suite.
  f.runtime.attribution.timers = { setTimeout: callback => setTimeout(callback, 60_000), clearTimeout };
  const first = await f.main('prior-session'), second = await f.main('current-session');
  await f.turn(first, '活动：请列三步');
  await f.turn(first, '相册：相册私有');
  await f.turn(second, '活动：保持三步');
  const request = JSON.stringify(f.requests.filter(row => row.role === 'main').at(-1).body);
  assert.ok(request.includes('集合、慢行观察、结束收尾'));
  assert.ok(!request.includes('相册私有'));
  assert.ok(!request.includes('相册独有答复'));
});
