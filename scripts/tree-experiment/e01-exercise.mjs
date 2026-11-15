import assert from 'node:assert/strict';
import { digest } from '../../src/tree/contracts.mjs';

export async function correctE01Assignment(f, spec, agent, original, evidence, checkpoint = () => {}) {
  const target = evidence.nodeIds[spec.goal];
  if (original.nodeIds.length === 1 && original.nodeIds[0] === target) return;
  const context = { actor: { kind: 'user', id: f.repo.userId }, sessionId: agent.session.id, signal: new AbortController().signal };
  let turn = f.repo.get('tree_turns', original.id);
  for (const nodeId of turn.createdNodeIds.filter(id => turn.nodeIds.includes(id))) {
    const node = f.repo.get('tree_nodes', nodeId);
    const receipt = await f.runtime.ui.dispatch('turn.undoCreate', { requestId: `e01-undo-created-${spec.ordinal}-${nodeId}`,
      turnId: turn.id, nodeId, expectedRevision: node.revision, expectedAssignmentRevision: turn.assignmentRevision }, context);
    assert.equal(receipt.state, 'success');
    evidence.uiActions.push({ kind: 'synthetic-owner-undo-created-node', ordinal: spec.ordinal, nodeId, receipt });
    turn = f.repo.get('tree_turns', original.id);
  }
  if (turn.nodeIds.length !== 1 || turn.nodeIds[0] !== target) {
    const receipt = await f.runtime.ui.dispatch('turn.correct', { requestId: `e01-correct-assignment-${spec.ordinal}`,
      turnId: turn.id, nodeIds: [target], expectedAssignmentRevision: turn.assignmentRevision }, context);
    assert.equal(receipt.state, 'success');
    evidence.uiActions.push({ kind: 'synthetic-owner-corrects-assignment', ordinal: spec.ordinal, from: original.nodeIds, to: [target], receipt });
  }
  await f.runtime.idle();
  assert.deepEqual(f.repo.get('tree_turns', original.id).nodeIds, [target]);
  checkpoint(evidence);
}

export async function compactE01Session(f, agent, evidence, checkpoint = () => {}) {
  const sessionId = agent.session.id;
  try {
    const result = await f.ctx.compaction.compactNow(agent, new AbortController().signal, 'synthetic-e01-frozen-compaction');
    assert.ok(result, 'The real host must produce a compaction checkpoint');
    const jobs = f.repo.list('tree_jobs', j => j.trigger?.nativeCompaction && j.input.nativeCompaction.sessionId === sessionId);
    assert.ok(jobs.length); assert.equal(jobs.at(-1).status, 'committed');
    evidence.compactions.push({ sessionId, status: 'committed', jobId: jobs.at(-1).id, inputHash: jobs.at(-1).inputHash });
  } catch (error) {
    const jobs = f.repo.list('tree_jobs', j => j.trigger?.nativeCompaction && j.input.nativeCompaction.sessionId === sessionId);
    const last = jobs.at(-1);
    // Only a known failed summary may leave the original history in place and
    // allow later turns. Never retry it or continue past an unknown outcome.
    if (error.code !== 'summary' || !last || !['invalid_output', 'committed'].includes(last.status)) throw error;
    evidence.compactions.push({ sessionId, status: 'failed', jobId: last.id, error: { code: error.code, message: error.message } });
  }
  checkpoint(evidence);
}

/** Drive only actual native turns and authenticated owner actions. No fixture
 * answer, fabricated repair or direct database mutation is accepted here. */
export async function exerciseE01(f, scenario, checkpoint = () => {}, { observeInvalidOutput = false, sessionPrefix = 'e01-native', ownerCorrectsAssignments = false, continueKnownFailures = false, resume = null } = {}) {
  assert.equal(scenario.turns.length, 30);
  const agents = [await f.main(`${sessionPrefix}-one`, async () => {}, Boolean(resume)), await f.main(`${sessionPrefix}-two`)];
  const evidence = resume?.evidence ?? { turns: [], uiActions: [], compactions: [], uiReads: [], nodeIds: [], invalidJobs: [] };
  const context = agent => ({ actor: { kind: 'user', id: f.repo.userId }, sessionId: agent.session.id, signal: new AbortController().signal });
  const healthy = () => {
    const jobs = f.repo.list('tree_jobs', j => j.role);
    evidence.invalidJobs = jobs.filter(j => ['invalid_output', 'stale', 'failed', 'cancelled'].includes(j.status) || j.rejectedItems?.length).map(j => ({ id: j.id, role: j.role, status: j.status, error: j.error ?? null, rejectedItems: j.rejectedItems ?? [] }));
    const bad = jobs.filter(j => j.status !== 'committed' && !(observeInvalidOutput && j.status === 'invalid_output') && !(ownerCorrectsAssignments && j.status === 'stale') && !(continueKnownFailures && ['failed', 'cancelled'].includes(j.status)) && !(resume && j.id === resume.interruptedJobId && j.status === 'unknown' && j.invocationIds.length === 0));
    assert.deepEqual(bad.map(j => ({ id: j.id, role: j.role, status: j.status, error: j.error })), [], 'Stop before sending more work after any unsuccessful owned job');
  };
  async function submit(spec, agent) {
    const startedAt = new Date().toISOString(), turn = await f.turn(agent, spec.text);
    if (continueKnownFailures) assert.ok(['settled', 'failed'].includes(turn.status), `Unknown or unfinished turn: ${turn.status}`);
    else assert.equal(turn.status, 'settled');
    if (!ownerCorrectsAssignments || spec.ordinal <= 3) assert.equal(turn.nodeIds.length, 1);
    if (spec.ordinal <= 3 && !(resume && spec.ordinal === 3)) {
      assert.notEqual(turn.nodeIds[0], f.repo.rootId(), 'Each independently requested goal must have a node');
      assert.ok(!evidence.nodeIds.includes(turn.nodeIds[0])); evidence.nodeIds[spec.goal] = turn.nodeIds[0];
    } else if (!ownerCorrectsAssignments) assert.deepEqual(turn.nodeIds, [evidence.nodeIds[spec.goal]], 'An ordinary step must stay in its existing goal');
    evidence.turns.push({ ordinal: spec.ordinal, goal: spec.goal, sessionId: agent.session.id, turnId: turn.id, status: turn.status, error: turn.status === 'failed' ? turn.nativeEndReason : null, initialNodeIds: turn.nodeIds, startedAt, settledAt: new Date().toISOString() });
    checkpoint(evidence); return turn;
  }
  async function rename() {
    for (const index of [0, 1]) {
      const node = f.repo.get('tree_nodes', evidence.nodeIds[index]);
      const receipt = await f.runtime.ui.dispatch('node.rename', { requestId: `e01-new-title-${index}`, nodeId: node.id,
        name: scenario.goals[index].laterName, expectedRevision: node.revision }, context(agents[index]));
      assert.equal(receipt.state, 'success');
      evidence.uiActions.push({ kind: 'new-user-requirement-title', nodeId: node.id, before: node.name, after: scenario.goals[index].laterName,
        reason: scenario.uiActions.renameReason, receipt });
    }
    await f.runtime.idle(); healthy(); checkpoint(evidence);
  }
  async function compact() {
    for (const agent of agents) {
      await compactE01Session(f, agent, evidence, checkpoint);
      healthy();
    }
    await f.runtime.idle(); healthy(); checkpoint(evidence);
  }
  if (resume) {
    assert.deepEqual(evidence.turns.map(turn => turn.ordinal).sort((a, b) => a - b), [1, 2]);
    const interrupted = f.repo.get('tree_turns', resume.interruptedTurnId), job = f.repo.get('tree_jobs', resume.interruptedJobId);
    assert.equal(interrupted.status, 'interrupted'); assert.equal(job.status, 'unknown'); assert.deepEqual(job.invocationIds, []);
    assert.equal(interrupted.nodeIds.length, 1); evidence.nodeIds[2] = interrupted.nodeIds[0];
    evidence.resume = { interruptedTurnId: interrupted.id, interruptedJobId: job.id, reason: 'Original native turn ended before any model invocation; the original remains preserved.' };
    const third = await submit(scenario.turns[2], agents[0]);
    if (ownerCorrectsAssignments) await correctE01Assignment(f, scenario.turns[2], agents[0], third, evidence, checkpoint);
    healthy();
  } else for (const spec of scenario.turns.slice(0, 3)) { await submit(spec, agents[0]); healthy(); }
  // The same two native sessions coexist; pairs enter concurrently. Actual
  // product admission and request limits decide their execution order.
  for (let index = 3; index < 29; index += 2) {
    const results = await Promise.allSettled([submit(scenario.turns[index], agents[0]), submit(scenario.turns[index + 1], agents[1])]);
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    if (ownerCorrectsAssignments) for (let offset = 0; offset < results.length; offset++) await correctE01Assignment(f, scenario.turns[index + offset], agents[offset], results[offset].value, evidence, checkpoint);
    healthy();
    if (evidence.turns.length === scenario.uiActions.renameAfterTurns) await rename();
    if (evidence.turns.length === scenario.uiActions.compactAfterTurns) await compact();
  }
  const last = await submit(scenario.turns[29], agents[1]);
  if (ownerCorrectsAssignments) await correctE01Assignment(f, scenario.turns[29], agents[1], last, evidence, checkpoint);
  healthy();
  assert.equal(f.repo.list('tree_turns').length, resume ? 31 : 30); assert.equal(f.repo.list('tree_nodes', n => !n.deleted).length, 4);
  assert.equal(new Set(evidence.turns.map(t => t.sessionId)).size, 2);
  assert.equal(evidence.compactions.length, 2);
  for (const nodeId of evidence.nodeIds) {
    const node = f.repo.get('tree_nodes', nodeId);
    if (node.status !== 'completed') {
      const receipt = await f.runtime.ui.dispatch('node.status', { requestId: 'e01-preparation-complete-' + nodeId, nodeId, status: 'completed', expectedRevision: node.revision }, context(agents[0]));
      assert.equal(receipt.state, 'success'); evidence.uiActions.push({ kind: 'user-completes-preparation', nodeId, receipt });
    }
    await f.runtime.idle(); healthy();
  }
  const jobs = f.repo.list('tree_jobs', j => j.role);
  for (const role of ['attribution', 'main']) assert.equal(jobs.filter(j => j.role === role).length, resume ? 31 : 30, `${role}: one owner per native turn, including the retained interrupted turn`);
  assert.ok(jobs.filter(j => j.role === 'learning').length >= 30, 'Every logical turn must have a learning owner; user corrections can queue a new one');
  for (const role of ['consolidation', 'verification', 'improvement']) assert.ok(jobs.some(j => j.role === role), role + ' must actually run');
  assert.ok(jobs.some(j => j.role === 'improvement' && j.input.repairs.filter(r => r.type === 'user_rename').length >= 2), 'Actual owner changes must reach diagnosis without a fabricated error');
  assert.equal(jobs.some(j => j.role === 'script_writer'), false, 'This episode does not authorize script creation');
  for (const item of evidence.turns) {
    const view = await f.runtime.ui.dispatch('turn.details', { turnId: item.turnId }, context(agents.find(a => a.session.id === item.sessionId)));
    assert.equal(digest(view.turn), digest(f.repo.get('tree_turns', item.turnId)));
    assert.deepEqual(view.nodes.map(n => n.id), [evidence.nodeIds[item.goal]]);
    assert.ok(view.jobs.filter(j => j.current).every(j => j.status === 'committed' || observeInvalidOutput && j.status === 'invalid_output' || ownerCorrectsAssignments && j.status === 'stale' || continueKnownFailures && ['failed', 'cancelled'].includes(j.status)));
    evidence.uiReads.push({ kind: 'turn.details', turnId: item.turnId, hash: digest(view) });
  }
  for (const nodeId of evidence.nodeIds) {
    const view = await f.runtime.ui.dispatch('node.details', { nodeId }, context(agents[0]));
    assert.equal(view.node.status, 'completed'); assert.ok(view.summary, 'Every completed preparation goal has an actual summary');
    for (const item of view.items) assert.equal(digest(item.current), digest(f.repo.get('tree_item_versions', digest(['item_version', item.id, item.activeVersion ?? item.draftVersion]))));
    evidence.uiReads.push({ kind: 'node.details', nodeId, hash: digest(view) });
  }
  checkpoint(evidence); return evidence;
}
