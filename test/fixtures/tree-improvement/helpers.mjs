import { learningFixture } from '../tree-learning/helpers.mjs';
import { ImprovementService } from '../../../src/tree/improvement.mjs';
import { LocalReports } from '../../../src/tree/reports.mjs';
import { digest } from '../../../src/tree/contracts.mjs';

export const noChange = () => ({ same: false, diagnosis: '两个不同的合成问题', kind: 'none', supplements: [], parameters: [], report: null });
export function improvementFixture(t) {
  const f = learningFixture(t), reports = new LocalReports({ repository: f.repo, resolveSource: f.resolveSource });
  const improvement = new ImprovementService({ repository: f.repo, jobs: f.jobs, contextBuilder: f.builder, modelConfig: f.config, reports });
  let seq = 0;
  function repair(nodeId, updates = {}) {
    const id = digest(['synthetic-repair', ++seq]);
    f.repo.command('fixtureProducerRepair', f.cmd({ nodeId, sourceRefs: [f.ref] }), { kind: 'program', id: 'fixture' }, () => { f.repo.save('tree_repairs', { id, producerRole: 'learning', producerJobId: 'synthetic-producer-' + seq, stage: 'generate', type: 'rewrite', sourceSignalIds: [], nodeIds: [nodeId], reason: '合成修正：遗漏输入中的限定条件', requestId: id, evidenceRefs: [f.ref], countsAsError: true, ...updates }); return { id }; }); return id;
  }
  function complete(job, output) {
    f.jobs.prepare(job.id); f.jobs.submit(job.id); f.jobs.receive(job.id, { message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(output) }] }, nativeLogRef: 'synthetic-improvement#1', eventsHash: digest(output) });
    const validated = f.jobs.validate(job.id); return validated.status === 'validated' ? f.jobs.commit(job.id, (value, ctx) => improvement.applyResult(value, ctx)) : validated;
  }
  return { ...f, reports, improvement, repair, completeImprovement: complete };
}
export function personal(job) {
  return { ...noChange(), same: true, diagnosis: '该合成用户的简短回应只确认最后一个问题', kind: 'personal', supplements: [{ op: 'add', target: 'learning', scopeNodeId: job.nodeIds[0], text: { situation: '用户简短回应多个问题时', action: '只确认最后一问，其他留待核实', basis: '两次独立纠正明确指出范围', notApplicable: '用户逐项确认时' }, traitEvidence: [job.input.sources[0].id], universalStopgap: false }] };
}
export function universal(job) {
  const value = personal(job); value.kind = 'universal'; value.diagnosis = '输出缺少来源校验'; value.supplements[0].traitEvidence = []; value.supplements[0].universalStopgap = true;
  value.report = { step: job.trigger.producerRole, problem: '遗漏范围限定检查', evidence: [job.input.sources[0].id], whyUniversal: '换用户仍须核实输入范围', stopgap: '先逐条核对', suggestedFix: '在登记前增加结构检查' }; return value;
}
