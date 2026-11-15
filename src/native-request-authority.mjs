import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { canonicalJson } from './store.mjs';
import { LearningService } from './learning.mjs';

const digest = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const treeAuthorities = new WeakMap();

// Only trusted composition registers this per-business capability. Model input
// cannot opt into it, and unrelated auxiliary sessions keep the v1 rejection.
export function registerTreeRequestAuthority(business, authority) {
  if (!business || typeof authority?.owns !== 'function' || typeof authority?.identity !== 'function' || typeof authority?.assertRequest !== 'function' || treeAuthorities.has(business)) throw new Error('One explicit tree request authority per business instance is required');
  treeAuthorities.set(business, authority);
  return () => { if (treeAuthorities.get(business) === authority) treeAuthorities.delete(business); };
}

export { ownEvidenceDirectory } from './evidence-ownership.mjs';

/** The ledger persists this identity before send; it is not another job state. */
export function nativeRequestIdentity(business, sessions, options) {
  if (options.purpose !== undefined || typeof options.sessionId !== 'string')
    throw new Error('Only an owned native Arcfold main or learning step may use this provider');
  const session = sessions.get(options.sessionId);
  if (!session) throw new Error('The request has no live native session owner');
  const main = business.get('host_bindings', session.id)?.role === 'main';
  const helpers = business.listAll('learning_runs', { where: { sessionId: session.id } });
  const preparations = business.listAll('preparation_runs', { where: { sessionId: session.id } });
  const tree = treeAuthorities.get(business);
  if (tree?.owns(session.id)) {
    if (main || helpers.length || preparations.length) throw new Error('Native request has both legacy and tree owners');
    return tree.identity(options, session);
  }
  if (Number(main) + helpers.length + preparations.length !== 1) throw new Error('The request has no unique Arcfold business owner');
  const helper = helpers[0], preparation = preparations[0];
  if (preparation && preparation.state !== 'submitted') throw new Error('Preparation is not submitted');
  if (helper && (helper.state !== 'submitted' || helper.dispatchCount !== 1))
    throw new Error('The learning request has not passed its single-call guard');
  const events = session.snapshotEvents();
  const start = events.findLast(event => event.type === 'step/start');
  if (!start || !Number.isSafeInteger(start.data.turn) || !Number.isSafeInteger(start.data.step))
    throw new Error('The request has no native step identity');
  const turn = events.findLast(event => event.type === 'turn/start');
  if (!turn || turn.data.turn !== start.data.turn || turn.seq >= start.seq)
    throw new Error('The native step does not belong to the current turn');
  if (events.slice(start.seq + 1).some(event => ['turn/end', 'step/end', 'assistant/message', 'assistant/attempt'].includes(event.type)))
    throw new Error('The native step already has a result or attempted result; automatic resending is forbidden');
  if (preparation && !preparation.requests?.some(value => value.stepStartSeq === start.seq))
    throw new Error('Preparation request has not passed its bounded native step guard');
  const header = session.requestHeader()?.config;
  if (!header || header.provider !== options.provider || header.model !== options.model ||
      header.maxTokens !== options.maxTokens || header.reasoningEffort !== options.reasoningEffort)
    throw new Error('The native request configuration and actual provider call disagree');
  const position = { sessionId: session.id, turn: start.data.turn, step: start.data.step, stepStartSeq: start.seq };
  return { requestId: `dsh-messages-${digest(position)}`, metadata: {
    owner: 'arcfold-dsh-messages-v1', ...position, role: main ? 'main' : helper ? 'learning' : 'preparation',
    nativeThroughSeq: events.at(-1).seq, nativePrefixHash: digest(events),
    ...(helper ? { learningPendingId: helper.id, learningInputHash: helper.inputHash } : {}),
    ...(preparation ? { preparationRunId: preparation.id, preparationInputHash: preparation.inputHash } : {}),
  } };
}

export function assertNativeRequestCurrent(ctx, options) {
        const tree = treeAuthorities.get(ctx.arcfoldBusiness);
        if (tree?.owns(options.sessionId)) return tree.assertRequest(options);
        if (ctx.arcfoldBridge.isBound(options.sessionId)) {
          const checked = ctx.arcfoldBridge.assertMethodRequestCurrent(options);
          // Return a mistaken async check to the transport so it fails closed;
          // never discard it and accidentally turn a Promise into permission.
          if (checked && typeof checked.then === 'function') return checked;
          const goalChecked = ctx.arcfoldBridge.assertGoalRequestCurrent(options);
          if (goalChecked && typeof goalChecked.then === 'function') return goalChecked;
          return ctx.arcfoldBridge.assertRequestCurrent(options);
        }
        const preparations = ctx.arcfoldBusiness.listAll('preparation_runs', { where: { sessionId: options.sessionId } });
        if (preparations.length) {
          const runner = ctx.get('arcfoldPreparation');
          if (preparations.length !== 1 || !runner) throw new Error('Preparation owner is unavailable');
          return runner.assertRequest(options);
        }
        // A helper has already passed its single-call guard. Recheck only its
        // existing frozen business input; never prepare, count or schedule again.
        const runs = ctx.arcfoldBusiness.listAll('learning_runs', { where: { sessionId: options.sessionId } });
        const run = runs[0], input = run && ctx.arcfoldBusiness.get('learning_inputs', run.id);
        if (runs.length !== 1 || !input || run.inputHash !== input.inputHash)
          throw new Error('The learning request has no matching frozen input before dispatch');
        const learning = new LearningService({ business: ctx.arcfoldBusiness });
        const checked = learning.assertInput(input);
        if (checked && typeof checked.then === 'function') return checked;
        return learning.assertVersions(input);
}
