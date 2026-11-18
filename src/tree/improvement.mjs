import { CONTRACT, canonicalJson, digest, fail, oneOf } from './contracts.mjs';
import { ItemService } from './items.mjs';
import { TreeService } from './tree.mjs';
import { compilePrompt, producerRuntimeSpecification, validateOutput, resolveSourceIds } from './prompts.mjs';
import { itemInput } from './learning.mjs';
import { evidenceResolver } from './signals.mjs';
import { REPORT_ONLY_PROMPTS } from './verification.mjs';

const unique = values => [...new Map(values.map(value => [canonicalJson(value), value])).values()];
const roles = ['attribution', 'learning', 'consolidation', 'verification', 'improvement'];

export class ImprovementService {
  constructor({ repository, jobs, contextBuilder, modelConfig, reports }) {
    Object.assign(this, { repo: repository, jobs, builder: contextBuilder, config: modelConfig, reports });
    this.resolveSource = evidenceResolver(repository, contextBuilder.resolveSource);
  }

  enqueue(producerRole) {
    oneOf(producerRole, roles, 'producerRole');
    const prior = this.repo.list('tree_jobs', job => job.role === 'improvement' && job.trigger.producerRole === producerRole);
    const active = prior.find(job => !['committed', 'stale', 'invalid_output', 'failed', 'cancelled'].includes(job.status));
    if (active) return active;

    const processed = new Set(prior.filter(job => job.status === 'committed').flatMap(job => job.input.repairs.map(repair => repair.id)));
    const repairs = this.repo.list('tree_repairs', repair =>
      repair.producerRole === producerRole &&
      (repair.countsAsError === true || repair.eligibleForDiagnosis === true && repair.countsAsError !== false) &&
      !['changed', 'mark_changed'].includes(repair.type) && repair.attribution !== 'unresolved' && !processed.has(repair.id));
    if (repairs.length < 2) return null;
    const key = digest(['producer-repairs', producerRole, repairs.map(repair => [repair.id, repair.revision])]);
    // A terminal diagnosis remains the owner of these exact repairs. Do not
    // rebuild its frozen input or resend it when unrelated state later changes.
    const existing = this.repo.get('tree_jobs', digest(['model_job', 'improvement', key]));
    if (existing) return existing;

    const nodeIds = [this.repo.rootId()];
    const relatedNodeIds = [...new Set([...nodeIds, ...repairs.flatMap(repair => repair.nodeIds)])];
    // A user can undo a mistakenly created node before diagnosis runs. Keep
    // that historical node in affectedNodes/repairs, but do not traverse its
    // deleted path as if it were still part of the active tree.
    const liveNodeIds = relatedNodeIds.filter(id => { const node = this.repo.get('tree_nodes', id); return node && !node.deleted; });
    const ancestors = liveNodeIds.map(id => this.repo.ancestors(id).map(node => node.id));
    const ancestorIds = [...new Set(ancestors.flat())];
    const rows = this.builder.activeItems(ancestorIds, producerRole).filter(row =>
      row.item.kind === 'supplement' || row.item.kind === 'understanding' && row.item.nodeId === this.repo.rootId());
    const sourceRefs = unique([...repairs.flatMap(repair => repair.evidenceRefs ?? []), ...rows.flatMap(row => row.version.sourceRefs)]);
    const sources = sourceRefs.map(ref => {
      const source = this.resolveSource(ref);
      if (!source) fail('SOURCE_CHANGED', 'Repair evidence was withdrawn');
      return { ...source, ref, id: source.id ?? digest(ref) };
    });
    if (!sources.length) fail('REPAIR_EVIDENCE_REQUIRED', 'No immutable evidence for a diagnosis');

    const parameters = this.repo.list('tree_parameters', parameter => ancestorIds.includes(parameter.scopeNodeId));
    const repairedItems = repairs.filter(repair => repair.itemId && repair.itemVersion).map(repair => {
      const item = this.repo.get('tree_items', repair.itemId);
      return {
        repairId: repair.id,
        item,
        before: this.repo.get('tree_item_versions', digest(['item_version', repair.itemId, repair.itemVersion])),
        after: item && this.repo.get('tree_item_versions', digest(['item_version', item.id, item.activeVersion ?? item.draftVersion])),
      };
    });
    const input = {
      inputVersion: CONTRACT,
      role: 'improvement',
      scope: { nodeIds, ancestorPaths: ancestors, treeRevision: this.repo.meta().treeRevision },
      sources,
      knownItems: rows.map(itemInput),
      allowedIds: { nodeIds: ancestorIds, subjectIds: rows.map(row => row.item.id), fileIds: [] },
      changeReceipts: [],
      repairs,
      relatedNodeIds,
      fixedProducerSpecification: compilePrompt(producerRole),
      fixedProducerRuntime: producerRuntimeSpecification(producerRole),
      parameters,
      existingReports: this.repo.list('tree_reports', report => report.producerRole === producerRole),
      repairedItems,
      affectedNodes: relatedNodeIds.map(id => this.repo.get('tree_nodes', id)),
      rootUnderstandingIds: rows.filter(row => row.item.kind === 'understanding').map(row => row.item.id),
    };
    const revisions = Object.fromEntries([
      ...unique([...ancestorIds, ...relatedNodeIds]).map(id => this.repo.get('tree_nodes', id)).filter(Boolean)
        .map(node => ['tree_nodes:' + node.id, node.revision]),
      ...repairs.map(repair => ['tree_repairs:' + repair.id, repair.revision]),
      ...rows.map(row => ['tree_items:' + row.item.id, row.item.revision]),
      ...repairedItems.filter(row => row.item).map(row => ['tree_items:' + row.item.id, row.item.revision]),
      ...parameters.map(parameter => ['tree_parameters:' + parameter.id, parameter.revision]),
    ]);
    const modelOrigin = this.config.source?.({ nodeIds: relatedNodeIds });
    return this.jobs.enqueue({
      role: 'improvement', key, nodeIds, input, revisionSet: revisions, config: this.config('improvement', { nodeIds: relatedNodeIds }),
      trigger: { kind: 'repair_group', producerRole, ...(modelOrigin ? { modelSourceJobId: modelOrigin.id } : {}), explicitParameters: parameters.filter(parameter => parameter.actor.kind === 'user')
        .map(parameter => ({ name: parameter.name, scopeNodeId: parameter.scopeNodeId })) },
    });
  }

  applyResult(result, { job, requestId }) {
    if (REPORT_ONLY_PROMPTS.includes(job.prompt.version)) {
      const output = validateOutput('improvement', result, job.input);
      return this.repo.transaction(() => {
        this.jobs.assertCurrent(job);
        const report = this.reports.recordReview(output, { job, requestId: digest([requestId, 'report']) });
        return { same: output.same, kind: output.kind, diagnosis: output.diagnosis, reportId: report.reportId, supplements: [], parameters: [], reportOnly: true };
      });
    }
    const output = validateOutput('improvement', result, job.input), actor = { kind: 'model', role: 'improvement', id: job.id }, refs = ids => resolveSourceIds(ids, job.input);
    if (output.supplements.some(s => s.target !== job.trigger.producerRole)) fail('PRODUCER_SCOPE', 'Supplement must address the diagnosed producer');
    if (output.kind === 'personal') for (const ids of [...output.supplements.map(s => s.traitEvidence), ...output.parameters.map(p => p.sourceIds)]) {
      if (!ids.some(id => job.input.sources.some(s => s.id === id && s.role === 'user' && ['user', 'ui'].includes(s.origin)))) fail('TRAIT_SOURCE_REQUIRED', 'Personal changes need actual human expression or an owner action');
    }
    return this.repo.transaction(() => {
      this.jobs.assertCurrent(job);
      const report = output.report ? this.reports.create(output.report, { job, requestId: digest([requestId, 'report']), evidenceRefs: refs(output.report.evidence) }) : null;
      const context = () => ({ actor, nodeIds: job.input.allowedIds.nodeIds }), items = new ItemService({ repository: this.repo, resolveSource: this.resolveSource, context }), tree = new TreeService({ repository: this.repo, resolveSource: this.resolveSource, context });
      const supplements = [];
      for (const [index, proposal] of output.supplements.entries()) {
        if (proposal.op === 'add') {
          if (report && this.repo.get('tree_reports', report.reportId).stopgapIds.some(id => { const item = this.repo.get('tree_items', id); return item?.lifecycle === 'active' && item.nodeId === proposal.scopeNodeId; })) fail('DUPLICATE_STOPGAP', 'Revise the existing stopgap for this report instead of adding a duplicate');
          const sourceRefs = proposal.traitEvidence.length ? refs(proposal.traitEvidence) : refs(output.report.evidence);
          const value = { target: proposal.target, text: proposal.text, sourceRefs, traitEvidence: refs(proposal.traitEvidence), universalStopgap: proposal.universalStopgap, ...(report ? { reportId: report.reportId } : {}) };
          const result = items.commitProposal({ requestId: digest([requestId, 'supplement', index]), expected: {}, input: { nodeId: proposal.scopeNodeId, understandings: [], methods: [], supplements: [value] } }).result.supplements;
          if (result.status !== 'applied') fail(result.code, result.reason); supplements.push(...result.itemIds);
        } else {
          const item = this.repo.get('tree_items', proposal.targetId), bundle = item && this.repo.get('tree_supplements', digest(['supplement', item.id, item.activeVersion]));
          if (!item || item.kind !== 'supplement' || item.lifecycle !== 'active' || item.activeVersion !== proposal.targetVersion || item.userProtected || bundle.target !== proposal.target || item.nodeId !== proposal.scopeNodeId) fail('SUPPLEMENT_STALE', 'Supplement scope/version/protection changed');
          this.repo.command('reviseImprovementSupplement', { requestId: digest([requestId, 'supplement', index]), expected: { ['tree_items:' + item.id]: item.revision }, input: { ...proposal, sourceRefs: refs(proposal.traitEvidence.length ? proposal.traitEvidence : output.report?.evidence ?? []) } }, actor, () => {
            if (proposal.op === 'withdraw') this.repo.save('tree_items', { ...item, lifecycle: 'withdrawn', withdrawalReason: output.diagnosis }, item.revision);
            else {
              const version = item.activeVersion + 1, sourceRefs = refs(proposal.traitEvidence.length ? proposal.traitEvidence : output.report.evidence);
              this.repo.save('tree_item_versions', { id: digest(['item_version', item.id, version]), itemId: item.id, version, content: proposal.text, sourceKind: 'assistant_inferred', sourceRefs, reason: output.diagnosis, supersedes: item.activeVersion });
              this.repo.save('tree_supplements', { ...bundle, id: digest(['supplement', item.id, version]), version, traitEvidence: refs(proposal.traitEvidence), universalStopgap: proposal.universalStopgap, reportId: report?.reportId ?? null });
              this.repo.save('tree_items', { ...item, activeVersion: version, validation: 'unverified', producerJobId: job.id, producerRole: 'improvement' }, item.revision);
            }
            for (const e of this.repo.list('tree_exposures', e => !e.revoked && e.itemVersions.some(v => v.itemId === item.id))) this.repo.save('tree_exposures', { ...e, revoked: true, invalidationReason: 'supplement_revised' }, e.revision);
            return { itemId: item.id };
          }); supplements.push(item.id);
        }
      }
      const parameters = output.parameters.map((proposal, index) => { const id = digest(['parameter', proposal.name, proposal.scopeNodeId]), old = this.repo.get('tree_parameters', id); return tree.setParameter({ requestId: digest([requestId, 'parameter', index]), expected: old ? { ['tree_parameters:' + id]: old.revision } : {}, input: { name: proposal.name, scopeNodeId: proposal.scopeNodeId, value: proposal.value, sourceRefs: refs(proposal.sourceIds) } }).result; });
      this.repo.command('recordImprovementOutcome', { requestId, expected: {}, input: { jobId: job.id, repairIds: job.input.repairs.map(r => r.id), same: output.same, kind: output.kind, supplements, parameters } }, actor, () => {
        for (const id of supplements) { const item = this.repo.get('tree_items', id); this.repo.save('tree_items', { ...item, producerJobId: job.id, producerRole: 'improvement' }, item.revision); }
        if (report) { const row = this.repo.get('tree_reports', report.reportId); this.repo.save('tree_reports', { ...row, stopgapIds: [...new Set([...row.stopgapIds, ...supplements.filter(id => this.repo.get('tree_items', id).lifecycle === 'active')])] }, row.revision); }
        return { same: output.same, kind: output.kind, diagnosis: output.diagnosis, reportId: report?.reportId ?? null, supplements, parameters };
      });
      return { same: output.same, kind: output.kind, diagnosis: output.diagnosis, reportId: report?.reportId ?? null, supplements, parameters };
    });
  }
}
