import { randomUUID } from 'node:crypto';
import { array, canonicalJson, digest, fail, integer, oneOf, shape, text, validateLong, validateShort, CATEGORIES } from './contracts.mjs';
import { DomainService } from './tree.mjs';

const versionId = (id, version) => digest(['item_version', id, version]);
const methodId = (id, version) => digest(['method', id, version]);
const supplementId = (id, version) => digest(['supplement', id, version]);
export const HOOK_RULES = Object.freeze({
  user_message: { fields: ['userMessage'], actions: ['add_context'] },
  before_tool: { fields: ['toolName', 'command', 'filePath', 'earlierToolsInTurn', 'earlierFilesInTurn'], actions: ['block', 'ask_user', 'add_context'] },
  after_tool: { fields: ['toolName', 'command', 'filePath', 'isError', 'output'], actions: ['add_context'] },
  turn_end: { fields: ['toolsCalled', 'filesWritten', 'earlierToolsInTurn', 'earlierFilesInTurn'], actions: ['remind_user', 'continue'] },
  node_enter: { fields: ['nodeId', 'nodeName'], actions: ['add_context'] },
  node_leave: { fields: ['filesWrittenInNode'], actions: ['remind_user', 'leave_note'] },
  node_complete: { fields: ['filesWrittenInNode', 'completedBy'], actions: ['remind_user', 'block'] },
});
export function validateHook(hook) {
  shape(hook, ['moment', 'conditions', 'action', 'message']); const rule = HOOK_RULES[hook.moment];
  if (!rule) fail('INVALID_HOOK', 'Unknown hook moment'); oneOf(hook.action, rule.actions, 'hook action'); text(hook.message, 'hook message', 80, true);
  for (const condition of array(hook.conditions, 'conditions', 16)) {
    shape(condition, ['field', 'op', 'value']); oneOf(condition.field, rule.fields, 'hook field'); oneOf(condition.op, ['equals', 'contains', 'not_contains', 'starts_with', 'ends_with'], 'operator');
    if (typeof condition.value !== 'boolean') text(condition.value, 'condition value', 512, true);
    if (typeof condition.value === 'boolean' && condition.op !== 'equals') fail('INVALID_HOOK', 'Boolean values only support equality');
  }
}

export class ItemService extends DomainService {
  item(id) { const item = this.repo.get('tree_items', id); if (!item) fail('ITEM_NOT_FOUND', 'Item not found'); return item; }
  version(id, version) { const row = this.repo.get('tree_item_versions', versionId(id, version)); if (!row) fail('ITEM_VERSION_NOT_FOUND', 'Item version not found'); return row; }
  #newItem(kind, nodeId, content, refs, sourceKind, { lifecycle = 'active' } = {}) {
    const id = randomUUID(); this.repo.save('tree_items', { id, kind, nodeId, activeVersion: lifecycle === 'active' ? 1 : null, draftVersion: lifecycle === 'draft' ? 1 : null, lifecycle, validation: 'unverified', userProtected: this.context().actor.kind === 'user', originNodeId: nodeId, originChain: [nodeId] });
    this.repo.save('tree_item_versions', { id: versionId(id, 1), itemId: id, version: 1, content, sourceKind, sourceRefs: refs, reason: 'proposal' }); return id;
  }
  #understanding(proposal, nodeId) {
    shape(proposal, ['content', 'source', 'sourceRefs']); text(proposal.content, 'content', 2000); oneOf(proposal.source, ['user_expressed', 'assistant_inferred', 'unknown'], 'source');
    const refs = this.refs(proposal.sourceRefs, { user: proposal.source === 'user_expressed' }); return this.#newItem('understanding', nodeId, proposal.content, refs, proposal.source);
  }
  #method(proposal, nodeId, previous = null) {
    shape(proposal, ['kind', 'short', 'long', 'hooks', 'scriptRequests', 'expectedEffect', 'sourceRefs']); oneOf(proposal.kind, ['collaboration', 'technique'], 'method kind');
    if (proposal.short === null && proposal.long === null) fail('TEXT_REQUIRED', 'A method requires short or long text');
    if (proposal.short !== null) validateShort(proposal.short); if (proposal.long !== null) validateLong(proposal.long);
    array(proposal.hooks, 'hooks', 8).forEach(validateHook);
    for (const request of array(proposal.scriptRequests, 'scriptRequests', 8)) {
      shape(request, ['purpose', 'evidence', 'files']); text(request.purpose, 'script purpose', 2000); array(request.evidence, 'evidence', 20).forEach(s => text(s, 'evidence id', 512)); array(request.files, 'files', 20).forEach(s => text(s, 'file reference', 512));
    }
    if (!proposal.expectedEffect) fail('EXPECTATION_REQUIRED', 'An explicit expected effect is required');
    shape(proposal.expectedEffect, ['category', 'change', 'text']); oneOf(proposal.expectedEffect.category, CATEGORIES, 'category'); oneOf(proposal.expectedEffect.change, ['gone', 'less', 'more'], 'expected change'); text(proposal.expectedEffect.text, 'expectation', 40);
    const refs = this.refs(proposal.sourceRefs), lifecycle = proposal.scriptRequests.length ? 'draft' : 'active';
    const id = previous?.id ?? this.#newItem('method', nodeId, proposal, refs, 'assistant_inferred', { lifecycle }), version = previous ? previous.activeVersion + 1 : 1;
    if (previous) {
      this.#withdraw(previous, 'bundle_replaced');
      this.repo.save('tree_item_versions', { id: versionId(id, version), itemId: id, version, content: proposal, sourceKind: 'assistant_inferred', sourceRefs: refs, reason: 'bundle_replaced', supersedes: previous.activeVersion });
      this.replace('tree_items', this.item(id), { lifecycle, activeVersion: lifecycle === 'active' ? version : null, draftVersion: lifecycle === 'draft' ? version : null, validation: 'unverified' });
    }
    const hooks = proposal.hooks.map((h, index) => {
      const hookId = digest(['hook', id, index]), key = digest(['hook_version', hookId, version]);
      this.repo.save('tree_hooks', { ...h, id: key, hookId, methodId: id, version, scopeNodeId: nodeId, enabled: lifecycle === 'active' }); return { id: hookId, version };
    });
    this.repo.save('tree_methods', { id: methodId(id, version), itemId: id, version, short: proposal.short, long: proposal.long, scripts: previous ? this.repo.get('tree_methods', methodId(id, previous.activeVersion)).scripts : [], hooks, expectation: proposal.expectedEffect, evaluation: { status: 'unverified', windowId: null, evidenceIds: [] }, pendingScriptRequests: proposal.scriptRequests }); return id;
  }
  #supplement(proposal, nodeId) {
    shape(proposal, ['target', 'text', 'sourceRefs', 'traitEvidence', 'universalStopgap'], ['reportId']);
    oneOf(proposal.target, ['learning', 'attribution', 'consolidation'], 'target'); validateShort(proposal.text); const refs = this.refs(proposal.sourceRefs);
    const evidence = this.refs(proposal.traitEvidence, { required: !proposal.universalStopgap });
    if (typeof proposal.universalStopgap !== 'boolean') fail('INVALID_FIELD', 'universalStopgap must be boolean');
    if (proposal.universalStopgap && (!proposal.reportId || !this.repo.get('tree_reports', proposal.reportId))) fail('REPORT_REQUIRED', 'A universal stopgap must link a local report');
    const id = this.#newItem('supplement', nodeId, proposal.text, refs, 'assistant_inferred');
    this.repo.save('tree_supplements', { id: supplementId(id, 1), itemId: id, version: 1, target: proposal.target, scopeNodeId: nodeId, traitEvidence: evidence, universalStopgap: proposal.universalStopgap, reportId: proposal.reportId ?? null }); return id;
  }
  commitProposal(command) {
    return this.repo.command('commitProposal', command, this.actor(['learning', 'consolidation', 'verification', 'improvement']), () => {
      const input = command.input; shape(input, ['nodeId', 'understandings', 'methods', 'supplements'], ['revisions']); this.node(input.nodeId); this.scoped(input.nodeId);
      const result = {};
      for (const [partition, limit, apply] of [['understandings', 20, p => this.#understanding(p, input.nodeId)], ['methods', 10, p => this.#method(p, input.nodeId)], ['supplements', 10, p => this.#supplement(p, input.nodeId)]]) {
        try {
          result[partition] = this.repo.transaction(() => {
            const ids = array(input[partition], partition, limit).map(apply);
            if (partition === 'understandings') for (const revision of array(input.revisions ?? [], 'revisions', 20)) this.#correctVersion(revision, ids, input.nodeId, command);
            return { status: 'applied', itemIds: ids };
          });
        } catch (error) {
          if (!error.code || ['SQLITE_BUSY', 'REVISION_CONFLICT'].includes(error.code)) throw error;
          result[partition] = { status: 'rejected', code: error.code, reason: error.message };
        }
      }
      return result;
    });
  }
  #correctVersion(revision, replacements, nodeId, command) {
    shape(revision, ['targetId', 'targetVersion', 'mark', 'replacedByIndex', 'sourceRefs']); oneOf(revision.mark, ['changed', 'invalid'], 'mark'); integer(revision.replacedByIndex, 'replacement index', 0, replacements.length - 1);
    const item = this.item(revision.targetId); this.repo.requireExpected(command, 'tree_items', item.id);
    if (item.kind !== 'understanding') fail('UNDERSTANDING_REQUIRED', 'Understanding corrections cannot rewrite a method bundle');
    if (item.activeVersion !== revision.targetVersion) fail('VERSION_CONFLICT', 'Target version changed'); this.refs(revision.sourceRefs, { user: true });
    // The learning adapter validates exact current-user evidence and binds each
    // classified correction to this item. Domain proposals cannot grant it.
    const correction = this.context().corrections?.[item.id] ?? this.context().correction;
    if (!correction || !correction.itemIds?.includes(item.id) || revision.sourceRefs.some(r => !correction.sourceRefs?.some(s => canonicalJson(r) === canonicalJson(s)))) fail('CORRECTION_REQUIRED', 'No trusted current-user correction for this item');
    if (item.nodeId !== nodeId && !correction.global) fail('LOCAL_EXCEPTION', 'A local exception cannot invalidate an ancestor item');
    if (item.nodeId !== nodeId) {
      const replacement = this.item(replacements[revision.replacedByIndex]);
      this.replace('tree_items', replacement, { nodeId: item.nodeId, originChain: [...new Set([...replacement.originChain, item.nodeId])] });
    }
    this.replace('tree_items', item, { lifecycle: revision.mark, replacedBy: replacements[revision.replacedByIndex], correctionSourceRefs: revision.sourceRefs });
  }
  #copyBundle(item, from, to, updates = {}) {
    if (item.kind === 'method') {
      const bundle = this.repo.get('tree_methods', methodId(item.id, from)); if (!bundle) fail('BUNDLE_MISSING', 'Method version missing');
      const hooks = bundle.hooks.map(ref => {
        const old = this.repo.get('tree_hooks', digest(['hook_version', ref.id, ref.version]));
        if (!old) fail('BUNDLE_MISSING', 'Hook missing'); this.replace('tree_hooks', old, { enabled: false });
        this.repo.save('tree_hooks', { ...old, id: digest(['hook_version', ref.id, to]), version: to, scopeNodeId: item.nodeId, enabled: !old.manuallyDisabled }); return { id: ref.id, version: to };
      });
      this.repo.save('tree_methods', { ...bundle, ...updates, id: methodId(item.id, to), version: to, hooks });
    } else if (item.kind === 'supplement') {
      const old = this.repo.get('tree_supplements', supplementId(item.id, from)); this.repo.save('tree_supplements', { ...old, ...updates, id: supplementId(item.id, to), version: to, scopeNodeId: item.nodeId });
    }
  }
  activateDraft(command) {
    return this.repo.command('activateDraft', command, this.actor([]), () => {
      if (this.context().actor.kind !== 'program') fail('FORBIDDEN', 'Only the artifact broker may activate a finished draft');
      shape(command.input, ['itemId', 'version', 'artifactIds']); const item = this.item(command.input.itemId); this.repo.requireExpected(command, 'tree_items', item.id);
      if (item.lifecycle !== 'draft' || item.draftVersion !== command.input.version) fail('VERSION_CONFLICT', 'Draft changed');
      const bundle = this.repo.get('tree_methods', methodId(item.id, item.draftVersion));
      const artifacts = array(command.input.artifactIds, 'artifacts', 8).map(id => this.repo.get('tree_script_artifacts', id));
      if (artifacts.length !== bundle.pendingScriptRequests.length || new Set(command.input.artifactIds).size !== artifacts.length) fail('BUNDLE_INCOMPLETE', 'Every requested script must be ready exactly once');
      for (const artifact of artifacts) if (!artifact || artifact.methodId !== item.id || artifact.activationState !== 'ready' || artifact.language !== 'node-esm' || !this.context().verifiedArtifacts?.some(v => v.id === artifact.id && v.revision === artifact.revision && v.filesHash === digest(artifact.files))) fail('ARTIFACT_UNVERIFIED', 'Broker must verify current artifact bytes before submitting activation');
      const version = item.draftVersion + 1, old = this.version(item.id, item.draftVersion);
      this.repo.save('tree_item_versions', { ...old, id: versionId(item.id, version), version, reason: 'all_scripts_ready', supersedes: old.version, bundleHash: digest(artifacts.map(a => a.files)) });
      this.#copyBundle(item, item.draftVersion, version, { scripts: [...bundle.scripts, ...artifacts.map(a => ({ id: a.scriptId, version: a.version, hash: digest(a.files) }))], pendingScriptRequests: [] });
      this.replace('tree_items', item, { lifecycle: 'active', activeVersion: version, draftVersion: null }); return { itemId: item.id, version };
    });
  }
  confirm(command) {
    return this.repo.command('confirmItem', command, this.actor([], true), () => {
      shape(command.input, ['itemId', 'version']); const item = this.item(command.input.itemId); this.repo.requireExpected(command, 'tree_items', item.id);
      if (item.lifecycle !== 'active' || item.activeVersion !== command.input.version) fail('VERSION_CONFLICT', 'Active version changed');
      const old = this.version(item.id, item.activeVersion), version = old.version + 1;
      this.repo.save('tree_item_versions', { ...old, id: versionId(item.id, version), version, sourceKind: 'user_expressed', confirmationRef: digest(['change', command.requestId]), supersedes: old.version, reason: 'trusted_user_confirmation' });
      this.#copyBundle(item, old.version, version); this.replace('tree_items', item, { activeVersion: version, userProtected: true, validation: 'supported' }); return { itemId: item.id, version };
    });
  }
  #withdraw(item, reason, lifecycle = 'withdrawn') {
    for (const hook of this.repo.list('tree_hooks', h => h.methodId === item.id && h.enabled)) this.replace('tree_hooks', hook, { enabled: false });
    for (const run of this.repo.list('tree_script_runs', r => r.methodVersion?.itemId === item.id && !['succeeded', 'failed', 'revoked'].includes(r.state))) this.replace('tree_script_runs', run, { state: 'revoked', denial: reason });
    for (const e of this.repo.list('tree_exposures', e => !e.revoked && e.itemVersions.some(v => v.itemId === item.id))) this.replace('tree_exposures', e, { revoked: true, invalidationReason: reason });
    this.replace('tree_items', item, { lifecycle });
  }
  withdraw(command) {
    return this.repo.command('withdrawItem', command, this.actor([], true), () => {
      shape(command.input, ['itemId', 'version', 'reason']); const item = this.item(command.input.itemId); this.repo.requireExpected(command, 'tree_items', item.id); text(command.input.reason, 'reason');
      if ((item.activeVersion ?? item.draftVersion) !== command.input.version) fail('VERSION_CONFLICT', 'Item version changed'); this.#withdraw(item, command.input.reason); return { itemId: item.id, lifecycle: 'withdrawn' };
    });
  }
  recheckSources(command) {
    return this.repo.command('recheckItemSources', command, this.actor(['verification']), () => {
      const input = command.input, authority = this.context().sourceRecheck;
      shape(input, ['itemId', 'version', 'operation', 'reason', 'sourceRefs'], ['replacement']);
      oneOf(input.operation, ['support', 'rewrite', 'withdraw', 'probe'], 'source review operation'); text(input.reason, 'reason');
      const job = authority && this.repo.get('tree_jobs', authority.jobId), exposure = authority && this.repo.get('tree_exposures', authority.exposureId);
      const invocation = exposure && this.repo.get('tree_invocations', exposure.invocationId);
      if (!job || job.role !== 'verification' || job.status !== 'validated' || job.input.sourceRecheck?.itemId !== input.itemId || job.input.sourceRecheck?.itemVersion !== input.version ||
          this.context().actor.id !== job.id || exposure?.kind !== 'source_recheck' || exposure.role !== 'verification' || exposure.revoked || exposure.inputHash !== job.inputHash ||
          invocation?.jobId !== job.id || invocation.state !== 'result_received' || invocation.inputHash !== job.inputHash) fail('RECHECK_AUTHORITY', 'An actual validated source-review owner is required');
      const item = this.item(input.itemId); this.repo.requireExpected(command, 'tree_items', item.id); this.scoped(item.nodeId);
      if (item.lifecycle !== 'active' || !item.stale || item.staleReason !== 'assignment_corrected' || item.activeVersion !== input.version) fail('VERSION_CONFLICT', 'Source-review target changed');
      if (item.userProtected && input.operation !== 'probe') fail('USER_PROTECTED', 'Protected source conflicts require owner review');
      const refs = this.refs(input.sourceRefs), allowed = new Set(job.input.sources.map(s => canonicalJson(s.ref)));
      if (refs.some(ref => !allowed.has(canonicalJson(ref)))) fail('RECHECK_SOURCE', 'Only still-assigned frozen evidence may support this version');
      const review = { jobId: job.id, intentId: job.input.sourceRecheck.intentId, exposureId: exposure.id, version: input.version,
        operation: input.operation, reason: input.reason, sourceRefs: refs, status: input.operation === 'probe' ? 'needs_evidence' : 'resolved' };
      if (input.operation === 'probe') {
        this.replace('tree_items', item, { sourceReview: review, probe: { what: input.reason, evidenceRefs: refs, version: item.activeVersion, windowId: job.input.window.id } });
        return { itemId: item.id, status: 'needs_evidence', active: false };
      }
      if (input.operation === 'withdraw') {
        this.#withdraw(item, 'assignment_source_review');
        this.replace('tree_items', this.item(item.id), { sourceReview: review, stale: false, staleReason: null });
        return { itemId: item.id, status: 'withdrawn', active: false };
      }
      const old = this.version(item.id, item.activeVersion), next = old.version + 1;
      let content = old.content;
      if (input.operation === 'rewrite') {
        if (item.kind === 'understanding') { text(input.replacement, 'replacement', 2000); content = input.replacement; }
        else if (item.kind === 'method') {
          const proposal = input.replacement;
          shape(proposal, ['kind', 'short', 'long', 'hooks', 'scriptRequests', 'expectedEffect', 'sourceRefs']);
          if (proposal.kind !== old.content.kind || canonicalJson(proposal.hooks) !== canonicalJson(old.content.hooks) || proposal.scriptRequests.length || this.repo.get('tree_methods', methodId(item.id, old.version)).scripts.length) fail('RECHECK_COMPONENT', 'Source recheck cannot create or silently change executable components');
          if (proposal.short === null && proposal.long === null) fail('TEXT_REQUIRED', 'A method requires text');
          if (proposal.short !== null) validateShort(proposal.short); if (proposal.long !== null) validateLong(proposal.long);
          shape(proposal.expectedEffect, ['category', 'change', 'text']); oneOf(proposal.expectedEffect.category, CATEGORIES, 'category'); oneOf(proposal.expectedEffect.change, ['gone', 'less', 'more'], 'change'); text(proposal.expectedEffect.text, 'expectation', 40);
          content = proposal;
        } else fail('RECHECK_KIND', 'A supplement needing different wording requires an explicit probe');
      }
      if (item.kind === 'method') content = { ...content, sourceRefs: refs };
      const supplement = item.kind === 'supplement' ? this.repo.get('tree_supplements', supplementId(item.id, old.version)) : null;
      const remainingTraits = supplement?.traitEvidence.filter(ref => refs.some(r => canonicalJson(r) === canonicalJson(ref)));
      if (supplement && !supplement.universalStopgap && !remainingTraits.length) fail('RECHECK_TRAIT', 'A personal supplement still needs its own user evidence');
      const sourceKind = input.operation === 'support' ? old.sourceKind : 'assistant_inferred';
      if (sourceKind === 'user_expressed') this.refs(refs, { user: true });
      this.repo.save('tree_item_versions', { id: versionId(item.id, next), itemId: item.id, version: next, content, sourceKind, sourceRefs: refs, supersedes: old.version, reason: 'assignment_source_review' });
      this.#copyBundle(item, old.version, next, item.kind === 'method' ? { short: content.short, long: content.long, expectation: content.expectedEffect, evaluation: { status: 'unverified', windowId: null, evidenceIds: [] } } : supplement ? { traitEvidence: remainingTraits } : {});
      this.replace('tree_items', item, { activeVersion: next, stale: false, staleReason: null, validation: 'unverified', sourceReview: review });
      for (const e of this.repo.list('tree_exposures', e => !e.revoked && e.itemVersions.some(v => v.itemId === item.id))) this.replace('tree_exposures', e, { revoked: true, invalidationReason: 'assignment_source_review' });
      return { itemId: item.id, version: next, status: 'resolved', active: true };
    });
  }
  review(command) {
    return this.repo.command('reviewItem', command, this.actor(['verification', 'consolidation']), () => {
      const input = command.input; shape(input, ['itemId', 'version', 'exposureId', 'operation', 'reason', 'sourceRefs', 'windowId', 'opportunityRefs'], ['toNodeId', 'replacement', 'result', 'mergeTargetId', 'mergeTargetVersion']);
      oneOf(input.operation, ['support', 'rewrite', 'mark_invalid', 'mark_changed', 'move', 'merge', 'promote', 'demote', 'withdraw', 'harden'], 'operation'); text(input.reason, 'reason'); text(input.windowId, 'windowId', 512);
      const item = this.item(input.itemId); this.repo.requireExpected(command, 'tree_items', item.id);
      if (item.lifecycle !== 'active' || item.activeVersion !== input.version) fail('VERSION_CONFLICT', 'Target is no longer active');
      // A verification transaction may change several items from the same
      // actual exposure. Its trusted adapter validates every snapshot before
      // any mutation and supplies those exact snapshots for this transaction.
      // No command/model field can provide this authority.
      const exposure = this.context().reviewExposure?.(input.exposureId) ?? this.repo.get('tree_exposures', input.exposureId);
      if (!exposure || exposure.kind === 'source_recheck' || exposure.revoked || !exposure.itemVersions.some(v => v.itemId === item.id && v.version === input.version)) fail('EXPOSURE_REQUIRED', 'Review must bind an actual exposure of this version');
      this.refs(input.sourceRefs); this.refs(input.opportunityRefs, { required: false });
      if (item.userProtected && this.context().actor.kind !== 'user' && input.operation !== 'support') fail('USER_PROTECTED', 'A model cannot modify protected content');
      if (this.context().actor.kind === 'model' && !exposure.nodeIds.some(id => (this.context().nodeIds ?? []).includes(id))) fail('OUT_OF_SCOPE', 'Exposure is outside reviewer scope');
      const result = input.opportunityRefs.length ? oneOf(input.result ?? 'unclear', ['met', 'not_met', 'unclear'], 'verification result') : 'unclear';
      const reviewId = digest(['review', item.id, input.version, input.windowId]);
      if ((item.reviews ?? []).some(r => r.id === reviewId)) return { itemId: item.id, duplicateWindow: true };
      const review = { id: reviewId, version: input.version, windowId: input.windowId, operation: input.operation, result, sourceRefs: input.sourceRefs, opportunityRefs: input.opportunityRefs, exposureId: exposure.id, reason: input.reason };
      let updates = { reviews: [...(item.reviews ?? []), review] };
      if (input.operation === 'support') {
        const supportingNodes = new Set(); const observedSources = new Set();
        for (const r of updates.reviews.filter(r => r.version === item.activeVersion && r.result === result && result !== 'unclear')) {
          const uniqueEvidence = r.opportunityRefs.some(ref => !observedSources.has(canonicalJson(ref)));
          r.opportunityRefs.forEach(ref => observedSources.add(canonicalJson(ref)));
          const nodes = this.repo.get('tree_exposures', r.exposureId)?.nodeIds ?? [];
          // One observation assigned to multiple nodes is still one observation;
          // without a per-source node mapping it cannot prove independent support.
          if (uniqueEvidence && nodes.length === 1) supportingNodes.add(nodes[0]);
        }
        const ancestorItem = item.nodeId === this.repo.rootId() || exposure.nodeIds.some(id => id !== item.nodeId);
        const supported = this.context().actor.kind === 'user' || !ancestorItem || supportingNodes.size >= 2;
        updates.validation = result === 'met' ? supported ? 'supported' : 'unverified' : result === 'not_met' ? supported ? 'refuted' : item.validation : item.validation;
      }
      else if (['mark_invalid', 'mark_changed'].includes(input.operation)) updates.lifecycle = input.operation === 'mark_invalid' ? 'invalid' : 'changed';
      else if (['move', 'promote', 'demote'].includes(input.operation)) {
        this.node(input.toNodeId); const ancestors = this.repo.ancestors(item.nodeId).map(n => n.id), chain = item.originChain ?? [item.originNodeId];
        if (input.operation === 'promote' && (input.toNodeId === item.nodeId || !ancestors.includes(input.toNodeId))) fail('INVALID_PROMOTION', 'Promotion is restricted to ancestors');
        if (input.operation === 'demote' && (input.toNodeId === item.nodeId || !chain.includes(input.toNodeId) || !this.repo.ancestors(input.toNodeId).some(n => n.id === item.nodeId))) fail('INVALID_DEMOTION', 'Demotion requires a recorded origin below current scope');
        if (input.operation === 'move' && !exposure.nodeIds.includes(input.toNodeId)) fail('OUT_OF_SCOPE', 'Move requires evidence in its target scope');
        updates = { ...updates, nodeId: input.toNodeId, validation: 'unverified', originChain: [...new Set([...chain, input.toNodeId])] };
        for (const h of this.repo.list('tree_hooks', h => h.methodId === item.id && h.enabled)) this.replace('tree_hooks', h, { scopeNodeId: input.toNodeId });
      } else if (['rewrite', 'harden', 'merge'].includes(input.operation)) {
        let merged = null;
        if (input.operation === 'merge') {
          merged = this.item(input.mergeTargetId); this.repo.requireExpected(command, 'tree_items', merged.id);
          if (merged.id === item.id || merged.activeVersion !== input.mergeTargetVersion || merged.kind !== item.kind || merged.nodeId !== item.nodeId || merged.lifecycle !== 'active' || !exposure.itemVersions.some(v => v.itemId === merged.id && v.version === merged.activeVersion)) fail('MERGE_CONFLICT', 'Merge requires two current exposed versions of the same kind and scope');
          if (merged.userProtected && this.context().actor.kind !== 'user') fail('USER_PROTECTED', 'Merge cannot consume protected content');
        }
        const version = item.activeVersion + 1, old = this.version(item.id, item.activeVersion);
        const refs = [...new Map([...old.sourceRefs, ...(merged ? this.version(merged.id, merged.activeVersion).sourceRefs : []), ...input.sourceRefs].map(ref => [canonicalJson(ref), ref])).values()];
        if (item.kind === 'method') this.#method({ ...input.replacement, sourceRefs: refs }, item.nodeId, item);
        else {
          if (input.operation === 'harden') fail('METHOD_REQUIRED', 'Only methods can be hardened');
          if (item.kind === 'understanding') text(input.replacement, 'replacement', 2000); else validateShort(input.replacement);
          this.repo.save('tree_item_versions', { id: versionId(item.id, version), itemId: item.id, version, content: input.replacement, sourceKind: 'assistant_inferred', sourceRefs: refs, supersedes: old.version, reason: input.reason });
          this.#copyBundle(item, old.version, version); updates.activeVersion = version; updates.validation = 'unverified';
        }
        if (merged) { this.#withdraw(merged, 'merged_into_version'); this.replace('tree_items', this.item(merged.id), { mergedInto: { itemId: item.id, version } }); }
      }
      const updated = this.replace('tree_items', this.item(item.id), updates);
      if (['withdraw', 'mark_invalid', 'mark_changed'].includes(input.operation)) this.#withdraw(updated, input.reason, input.operation === 'withdraw' ? 'withdrawn' : updates.lifecycle);
      if (input.operation !== 'support') for (const e of this.repo.list('tree_exposures', e => !e.revoked && e.itemVersions.some(v => v.itemId === item.id))) this.replace('tree_exposures', e, { revoked: true, invalidationReason: 'item_reviewed' });
      const unclear = new Set();
      for (const r of [...updates.reviews].reverse().filter(r => r.version === input.version)) { if (r.result !== 'unclear') break; unclear.add(r.windowId); }
      const unclearWindows = unclear.size;
      return { itemId: item.id, result, unclearWindows, needsReflection: unclearWindows >= 3 };
    });
  }
}

export class ReportService extends DomainService {
  preview(reportId, { includeEvidence = false } = {}) {
    this.actor([], true); const report = this.repo.get('tree_reports', reportId); if (!report) fail('REPORT_NOT_FOUND', 'Local report not found');
    const safeText = value => String(value).replace(/(?:\/[\w.\-\p{L}]+){2,}/gu, '[路径已隐藏]').replace(/[“「"]([^”」"]*)[”」"]/gu, '[原话已隐藏]');
    // Default export omits the original problem/evidence fields altogether:
    // unmarked free text cannot be reliably distinguished from a raw quote.
    return { reportId, revision: report.revision, category: safeText(report.category), step: safeText(report.step), problem: includeEvidence ? report.problem : '[原始问题描述已隐藏；可选择附证据]', whyUniversal: includeEvidence ? report.whyUniversal : '[详细诊断已隐藏]', suggestedFix: includeEvidence ? report.suggestedFix : '[详细建议已隐藏]', evidenceRefs: includeEvidence ? report.evidenceRefs : [], ...(includeEvidence && report.reviewOutput ? { reviewOutput: report.reviewOutput } : {}), status: report.status, includesEvidence: includeEvidence };
  }
  export(command) {
    return this.repo.command('exportReport', command, this.actor([], true), () => {
      shape(command.input, ['reportId', 'includeEvidence', 'previewHash']); if (typeof command.input.includeEvidence !== 'boolean') fail('INVALID_FIELD', 'Evidence choice must be boolean');
      const report = this.repo.get('tree_reports', command.input.reportId); if (!report) fail('REPORT_NOT_FOUND', 'Report missing'); this.repo.requireExpected(command, 'tree_reports', report.id);
      const preview = this.preview(report.id, command.input); if (digest(preview) !== command.input.previewHash) fail('PREVIEW_CHANGED', 'Preview changed before export');
      this.replace('tree_reports', report, { exportAudit: [...report.exportAudit, { requestId: command.requestId, at: this.repo.now(), includeEvidence: command.input.includeEvidence, contentHash: digest(preview) }] }); return { content: preview };
    });
  }
}
