import test from 'node:test';
import assert from 'node:assert/strict';
import { integratedFixture } from './fixtures/tree-integration/native.mjs';
import { emptyLearning, emptyVerification } from './fixtures/tree-learning/helpers.mjs';

const summary = () => ({ summary: { oneLine: '合成目标已整理', status: '合成进展', outputs: [], decisions: [], next: '', pending: [] },
  broaden: [], kept: [], retrospect: { understandings: [], methods: [] }, setDown: null });

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
    if (row.role === 'consolidation') return summary();
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

test('a new session leaving a goal schedules exactly one consolidation per switch', async t => {
  const f = await integratedFixture(t, (row, runtime) => {
    if (row.role === 'attribution') {
      const name = row.input.sources.find(s => s.origin === 'user').text.split('：')[0];
      const node = runtime.repo.list('tree_nodes', item => item.name === name)[0];
      return { actions: [node ? { action: 'switch', nodeId: node.id } : { action: 'create', name }], statusChanges: [] };
    }
    if (row.role === 'learning') return emptyLearning();
    if (row.role === 'verification') return emptyVerification();
    if (row.role === 'consolidation') return summary();
    return '合成答复';
  });
  f.runtime.attribution.timers = { setTimeout: callback => setTimeout(callback, 60_000), clearTimeout };
  const a = await f.main('session-a'), b = await f.main('session-b');
  const turn = async (agent, text) => {
    const result = await f.turn(agent, text);
    assert.equal(result.status, 'settled');
    return result;
  };
  const leaves = () => f.repo.list('tree_jobs', job => job.role === 'consolidation');
  const check = expected => {
    assert.deepEqual(leaves().map(job => [job.nodeIds[0], job.input.summaryPlan.reason, job.status]).sort(),
      expected.map(id => [id, 'node_leave', 'committed']).sort());
    assert.equal(f.requests.filter(request => request.role === 'consolidation').length, expected.length);
  };
  const first = await turn(a, '甲：第一轮'), second = await turn(a, '甲：第二轮'), third = await turn(a, '甲：第三轮');
  const [x] = first.nodeIds;
  assert.deepEqual([second.nodeIds, third.nodeIds], [[x], [x]]);
  check([]);
  const [y] = (await turn(b, '乙：第一轮')).nodeIds;
  assert.notEqual(x, y);
  check([x]);
  assert.deepEqual(leaves()[0].input.summaryPlan.throughTurnIds, [first.id, second.id, third.id]);
  assert.equal(f.runtime.builder.glance(f.repo.get('tree_nodes', x)).oneLine, '合成目标已整理');
  await turn(b, '乙：第二轮，仍是乙');
  check([x]);
  await turn(a, '甲：第四轮，回到甲');
  check([x, y]);
  await turn(b, '乙：第三轮，回到乙');
  check([x, y, x]);
});
