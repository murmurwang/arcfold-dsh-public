import test from 'node:test';
import assert from 'node:assert/strict';
import { integratedFixture } from './fixtures/tree-integration/native.mjs';
import { emptyLearning, emptyVerification } from './fixtures/tree-learning/helpers.mjs';
import { method } from './fixtures/tree-domain/helpers.mjs';
import { ItemService } from '../src/tree/items.mjs';

test('a verified harden reminder reaches the next main request only in its method scope', async t => {
  const reminder = '交付草稿前逐项核对合成清单。';
  let createGoal = '整理草稿', verification = emptyVerification();
  const f = await integratedFixture(t, ({ role, input }) => {
    if (role === 'attribution') return { actions: [createGoal ? { action: 'create', name: createGoal } : { action: 'continue', nodeId: input.scope.nodeIds[0] }], statusChanges: [] };
    if (role === 'learning') return emptyLearning();
    if (role === 'verification') return verification;
    return '合成答复。';
  });
  const agent = await f.main('harden-main'), first = await f.turn(agent, '整理草稿。');
  const nodeId = first.nodeIds[0];
  const items = new ItemService({ repository: f.repo, resolveSource: f.runtime.resolveSource,
    context: () => ({ actor: { kind: 'model', role: 'learning', id: 'fixture-learning' }, nodeIds: [nodeId] }) });
  const proposal = { ...method(first.userSourceRefs), hooks: [] };
  const [id] = items.commitProposal({ requestId: 'fixture-method', expected: {},
    input: { nodeId, understandings: [], methods: [proposal], supplements: [] } }).result.methods.itemIds;
  createGoal = null;
  await f.turn(agent, '修改草稿，请核对清单。');
  const job = f.runtime.verification.enqueue(nodeId, { reason: 'stagnation' });
  const evidence = [job.input.effects.at(-1).input[0].id];
  verification = { ...emptyVerification(),
    operations: [{ op: 'harden', targetId: id, targetVersion: 1, stage: 'use', reason: '本轮漏做核对', evidence,
      detail: { hooks: [{ moment: 'turn_end', action: 'remind_user', conditions: [], message: reminder }], scriptRequests: [] } }],
    verifications: [{ methodId: id, methodVersion: 1, result: 'not_met', opportunityCount: 1, observed: '答复漏了清单', evidence }] };
  const applied = await f.owner.run(job.id);
  assert.equal(applied.status, 'committed', JSON.stringify(applied.error));
  verification = emptyVerification();

  const mainRequests = () => f.requests.filter(row => row.role === 'main');
  const hasReminder = request => request.body.messages.some(m => m.content?.some(block => block.type === 'text' && block.text.includes(reminder)));
  const runsFor = turn => f.repo.list('tree_hook_runs', run => run.logicalTurnId === turn.logicalTurnId && run.result.message === reminder);
  const previous = mainRequests().length;
  const next = await f.turn(agent, '继续修改草稿。');
  assert.deepEqual(runsFor(next).map(r => [r.result.status, r.result.action]), [['matched', 'add_context']]);
  assert.equal(mainRequests().length, previous + 1);
  assert.ok(hasReminder(mainRequests().at(-1)), 'the synthetic provider received the reminder in the real main request');

  createGoal = '整理照片';
  const other = await f.turn(await f.main('harden-other'), '为照片建立目录。');
  assert.notDeepEqual(other.nodeIds, next.nodeIds);
  assert.deepEqual(runsFor(other), []);
  assert.equal(hasReminder(mainRequests().at(-1)), false);
});
