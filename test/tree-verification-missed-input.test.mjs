import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeContext, complete } from './fixtures/tree-context/native.mjs';
import { textOf } from './fixtures/tree-host/support.mjs';
import { emptyVerification } from './fixtures/tree-learning/helpers.mjs';
import { VerificationService } from '../src/tree/verification.mjs';

test('the next native main request includes a newly learned missed finding in its node background', async t => {
  const label = 'missed-next-main', f = await nativeContext(t, label);
  const node = f.create('Synthetic task');
  f.target(node);
  const agent = await f.host.agent(label, f.mount);
  await f.host.run(agent, 'Keep the established structure.');
  await f.freeze(agent);
  f.settle(f.attribution.existing(agent.session.id, 1).id);
  const v = new VerificationService({ repository: f.repo, experience: f.experience, contextBuilder: f.builder, jobs: f.jobs, modelConfig: f.config });
  const job = v.enqueue(node), source = job.input.sources.find(s => s.role === 'user' && s.origin === 'user');
  const what = 'Preserve the section sequence during subsequent edits.';
  assert.ok(!textOf(f.host.requests.at(-1).messages).includes(what));
  const done = complete(f, job.id, { ...emptyVerification(), missed: [{ what, evidence: [source.id] }] }, (output, ctx) => v.applyResult(output, ctx));
  assert.equal(done.status, 'committed');
  await f.host.run(agent, 'Prepare another draft.');
  const background = f.host.requests.at(-1).messages.filter(m => m.source?.kind === 'arcfold/tree-context');
  assert.ok(textOf(background).includes(what));
});
