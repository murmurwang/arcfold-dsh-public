import { fixture } from '../tree-domain/helpers.mjs';
import { NativeSources, ExperienceService } from '../../../src/tree/experience.mjs';
import { ContextBuilder } from '../../../src/tree/context.mjs';
import { TreeService, } from '../../../src/tree/tree.mjs';
import { AttributionService } from '../../../src/tree/attribution.mjs';
import { ConsolidationService } from '../../../src/tree/consolidation.mjs';
import { TreeJobs } from '../../../src/tree/jobs.mjs';
import { digest } from '../../../src/tree/contracts.mjs';

export function setup(t) {
  const f = fixture(t), logs = new Map(), revoked = new Set();
  const sources = new NativeSources({ readSession: sessionId => ({ sessionId, durable: true, events: logs.get(sessionId) ?? [] }), isRevoked: ref => revoked.has(digest(ref)) });
  const resolveSource = ref => ref.sha256 === f.ref.sha256 ? { role: 'user', origin: 'user', text: '基础合成来源', sha256: ref.sha256 } : sources.resolve(ref);
  const opts = { repository: f.repo, context: () => f.context, resolveSource, sources };
  const tree = new TreeService(opts), experience = new ExperienceService(opts), builder = new ContextBuilder(opts);
  const jobs = new TreeJobs({ repository: f.repo, assertSources: rows => rows.every(s => Boolean(resolveSource(s.ref))) });
  const owner = { calls: 0, async run(id) {
    this.calls++; jobs.prepare(id); jobs.submit(id);
    const job = jobs.get(id), nodeId = this.targetNodeId ?? job.input.allowedIds.nodeIds.find(id => id !== f.repo.rootId()) ?? f.repo.rootId();
    jobs.receive(id, { message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify({ actions: [{ action: 'continue', nodeId }], statusChanges: [] }) }] }, nativeLogRef: 'synthetic-model-log#1', eventsHash: digest('synthetic-model-log') });
    jobs.validate(id); return jobs.commit(id, (result, context) => attribution.applyResult(result, context));
  } };
  const config = () => ({ provider: 'offline', model: 'fixture', reasoningEffort: 'off', maxTokens: 2048, preset: 'fixture', cwd: f.dir, modelVersion: 'synthetic', priceVersion: 'synthetic', budgetScope: 'offline-no-http', stage: 'offline' });
  const attribution = new AttributionService({ repository: f.repo, sources, contextBuilder: builder, jobs, modelOwner: owner, modelConfig: config, cancelJob: () => {} });
  const consolidation = new ConsolidationService({ repository: f.repo, experience, contextBuilder: builder, jobs });
  function append(sessionId, type, data) { const events = logs.get(sessionId) ?? []; const event = { seq: events.length, type, data, time: Date.parse('2026-11-12T10:00:00Z') + events.length }; events.push(event); logs.set(sessionId, events); return event; }
  function begin(sessionId = 'native-main', nativeTurn = 1, text = '合成用户委托') {
    const message = { id: `${sessionId}-user-${nativeTurn}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] };
    append(sessionId, 'agent/inbox/spliced', { inserted: [message], removed: [] }); append(sessionId, 'turn/start', { turn: nativeTurn });
    return { sessionId, nativeTurn, message };
  }
  function finish(input, { answer = '合成答复', reason = { kind: 'completed' }, toolText = '合成工具结果' } = {}) {
    const { sessionId, nativeTurn: turn, message } = input;
    append(sessionId, 'step/start', { turn, step: 1 }); append(sessionId, 'user/message', message);
    append(sessionId, 'user/message', { id: 'owned-background', role: 'user', source: { kind: 'arcfold/tree-context' }, content: [{ type: 'text', text: 'PRIVATE_PROGRAM_BACKGROUND' }] });
    append(sessionId, 'tool/call', { turn, step: 1, callId: 'call-1', name: 'fixture_read', arguments: '{}' });
    append(sessionId, 'tool/result', { turn, step: 1, message: { id: 'tool-1', role: 'tool', source: { kind: 'tool', callId: 'call-1' }, toolCallId: 'call-1', content: [{ type: 'text', text: toolText }] } });
    append(sessionId, 'assistant/message', { turn, step: 1, message: { id: 'assistant-1', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'reasoning', text: 'PRIVATE_REASONING' }, { type: 'text', text: answer }] } });
    append(sessionId, 'step/end', { turn, step: 1 }); append(sessionId, 'turn/end', { turn, reason });
  }
  async function attributed(input) { return attribution.attribute({ ...input, messages: [input.message] }); }
  function settle(turnId) { f.context.actor = { kind: 'program', id: 'fixture-host' }; return experience.settle(turnId); }
  return { ...f, logs, revoked, sources, resolveSource, tree, experience, builder, jobs, owner, attribution, consolidation, config, append, begin, finish, attributed, settle };
}
