import { CONTRACT, canonicalJson, digest, fail, oneOf } from './contracts.mjs';
import { compilePrompt, producerRuntimeSpecification, validateOutput } from './prompts.mjs';
import { itemInput } from './learning.mjs';
import { evidenceResolver } from './signals.mjs';

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
    const output = validateOutput('improvement', result, job.input);
    return this.repo.transaction(() => {
      this.jobs.assertCurrent(job);
      const report = this.reports.recordReview(output, { job, requestId: digest([requestId, 'report']) });
      return {
        same: output.same, kind: output.kind, diagnosis: output.diagnosis,
        reportId: report.reportId, supplements: [], parameters: [], reportOnly: true,
      };
    });
  }
}
