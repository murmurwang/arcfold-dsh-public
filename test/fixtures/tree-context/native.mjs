import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';
import { nativeFixture, load, answer } from '../tree-host/support.mjs';
import { mountTreeContext } from '../../../src/tree/context.mjs';
import { digest } from '../../../src/tree/contracts.mjs';

export function complete(f, jobId, result, apply) {
  f.jobs.prepare(jobId); f.jobs.submit(jobId);
  f.jobs.receive(jobId, { message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(result) }] }, nativeLogRef: 'synthetic-no-network#' + jobId, eventsHash: digest(['synthetic', jobId]) });
  const validated = f.jobs.validate(jobId); assert.equal(validated.status, 'validated', JSON.stringify(validated.error));
  return f.jobs.commit(jobId, apply);
}
export async function nativeContext(t, label, script = () => answer('Synthetic answer.')) {
  const f = setup(t), host = await nativeFixture(t, label, script);
  const { createUserMessage } = await load('@deepseek-ai/dsh-llm');
  let target = f.repo.rootId();
  f.owner.run = async id => { f.owner.calls++; return complete(f, id, { actions: [{ action: 'continue', nodeId: target }], statusChanges: [] }, (output, ctx) => f.attribution.applyResult(output, ctx)); };
  const freeze = async agent => { assert.equal(await host.ctx.sessions.flush(agent.session), true); f.logs.set(agent.session.id, agent.session.snapshotEvents()); };
  const mount = async owner => {
    mountTreeContext(owner, { builder: f.builder, sessionId: label, createUserMessage });
    owner.on('agent/pre-step', async (payload, next) => {
      await freeze(payload.agent);
      const turn = await f.attribution.attribute({ sessionId: label, nativeTurn: payload.turn, messages: payload.messages, signal: payload.signal });
      if (turn) await f.builder.activate(label, turn.id, { cancelPrevious: () => {} });
      return next();
    });
  };
  return { ...f, host, mount, freeze, target: nodeId => { target = nodeId; } };
}
