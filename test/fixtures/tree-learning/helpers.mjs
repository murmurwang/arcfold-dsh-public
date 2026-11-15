import { setup } from '../tree-context/helpers.mjs';
import { EpisodeSignals } from '../../../src/tree/signals.mjs';
import { ClusterService } from '../../../src/tree/clusters.mjs';
import { LearningService } from '../../../src/tree/learning.mjs';
import { digest } from '../../../src/tree/contracts.mjs';

export const emptyLearning = () => ({ understandings: [], revisions: [], methods: [], supplements: [], categories: [] });
export const emptyVerification = () => ({ operations: [], missed: [], verifications: [], formatFixes: [], clusters: [], proposals: { understandings: [], methods: [] }, probes: [] });
export function learningFixture(t, options = {}) {
  const f = setup(t), signals = new EpisodeSignals({ repository: f.repo, resolveSource: f.resolveSource, experience: f.experience });
  const clusters = new ClusterService({ repository: f.repo, signals });
  const learning = new LearningService({ repository: f.repo, experience: f.experience, contextBuilder: f.builder, consolidation: f.consolidation, jobs: f.jobs, modelConfig: f.config, signals, outputProtocol: 'legacy-v3', ...options });
  let sequence = 0;
  async function turn(nodeId, text = '合成用户反馈', sessionId = 'native-main', extraNodes = []) {
    const input = f.begin(sessionId, ++sequence, text); f.owner.targetNodeId = nodeId;
    const result = await f.attributed(input), id = result.id;
    if (extraNodes.length) { f.asUser(); f.tree.correctAssignment(f.cmd({ turnId: id, nodeIds: [nodeId, ...extraNodes], sourceRefs: [] }, f.expected('tree_turns', id))); }
    f.finish(input); f.settle(id); return f.repo.get('tree_turns', id);
  }
  function complete(job, output) {
    f.jobs.prepare(job.id); f.jobs.submit(job.id);
    f.jobs.receive(job.id, { message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(output) }] }, nativeLogRef: 'synthetic-learning#1', eventsHash: digest(output) });
    const validated = f.jobs.validate(job.id);
    return validated.status === 'validated' ? f.jobs.commit(job.id, (result, ctx) => learning.applyResult(result, ctx)) : validated;
  }
  async function feedback(nodeId, category, text = '合成反馈', extraNodes = []) {
    const experience = await turn(nodeId, text, 'native-main', extraNodes), job = learning.enqueue(experience.id, nodeId);
    const source = job.input.sources.find(s => s.role === 'user' && job.input.currentTurn.sourceIds.includes(s.id));
    const output = { ...emptyLearning(), categories: [{ category, note: '合成分类，非真实语义判分', sourceId: source.id, subjectIds: [] }] };
    return { turn: experience, job: complete(job, output), source, output };
  }
  return { ...f, signals, clusters, learning, turn, complete, feedback };
}
