import { randomUUID } from 'node:crypto';
import { array, canonicalJson, digest, fail, integer, oneOf, shape, sourceRefs, text, CATEGORIES, STATUSES } from './contracts.mjs';
import { recordKey } from './repository.mjs';

// The current goal of a turn that a goal is, or sits below; null when the goal
// is outside the turn. main may move such a goal, so tidying the tree from an
// upper goal can fix a misplaced goal under it.
export function currentGoalAbove(repo, nodeIds, id) {
  const node = repo.get('tree_nodes', id); if (!node || node.deleted) return null;
  if (nodeIds.includes(id)) return id;
  return repo.ancestors(id).reverse().find(n => nodeIds.includes(n.id))?.id ?? null;
}

// The adapter supplies context and source resolution. Nothing in command.input
// can impersonate a user, expand the current turn, or create source evidence.
export class DomainService {
  constructor({ repository, context, resolveSource }) { this.repo = repository; this.context = context; this.resolveSource = resolveSource; }
  actor(roles = [], userOnly = false) {
    const ctx = this.context();
    if (!ctx?.actor || userOnly && ctx.actor.kind !== 'user' || ctx.actor.kind === 'model' && !roles.includes(ctx.actor.role)) fail('FORBIDDEN', 'Operation not permitted for this trusted actor', 403);
    return ctx.actor;
  }
  refs(refs, options) { return sourceRefs(refs, this.resolveSource, options); }
  node(id) { const n = this.repo.get('tree_nodes', id); if (!n || n.deleted) fail('NODE_NOT_FOUND', 'Node not found'); return n; }
  scoped(id) { if (this.context().actor.kind === 'model' && !(this.context().nodeIds ?? []).includes(id)) fail('OUT_OF_SCOPE', 'Node is outside this invocation', 403); }
  candidate(id) { if (this.context().actor.kind === 'model' && !(this.context().candidateNodeIds ?? []).includes(id)) fail('OUT_OF_SCOPE', 'Node was not in the frozen attribution candidates', 403); }
  replace(kind, row, updates) { return this.repo.save(kind, { ...row, ...updates }, row.revision); }
}

export class TreeService extends DomainService {
  #touchStructure() { const meta = this.repo.meta(); this.replace('tree_meta', meta, { treeRevision: meta.treeRevision + 1 }); }
  #reactivate(id) {
    for (const n of this.repo.ancestors(id)) if (n.status !== 'active') this.replace('tree_nodes', n, { status: 'active', statusOrigin: this.context().actor.kind === 'user' ? 'user' : 'model', cascadeFromId: null });
  }
  #status(id, status, refs) {
    const node = this.node(id); oneOf(status, STATUSES, 'status');
    if (id === this.repo.rootId() && status !== 'active') fail('ROOT_INVARIANT', 'The root stays active');
    if (status === 'active') { this.#reactivate(id); return; }
    this.replace('tree_nodes', node, { status, statusOrigin: this.context().actor.kind === 'user' ? 'user' : 'model', cascadeFromId: null, statusSourceRefs: refs, statusChangedAt: this.repo.now() });
    // A terminal descendant is a boundary: its separately completed/abandoned
    // subtree is not relabelled as a consequence of its parent's status.
    const visit = parent => { for (const child of this.repo.list('tree_nodes', n => !n.deleted && n.parentId === parent)) {
      if (['completed', 'abandoned'].includes(child.status)) continue;
      this.replace('tree_nodes', child, { status, statusOrigin: 'cascade', cascadeFromId: id, statusSourceRefs: refs, statusChangedAt: this.repo.now() }); visit(child.id);
    } }; visit(id);
  }
  #invalidateScope(ids, reason) {
    for (const e of this.repo.list('tree_exposures', e => !e.revoked && e.nodeIds.some(id => ids.includes(id)))) this.replace('tree_exposures', e, { revoked: true, invalidationReason: reason });
    for (const j of this.repo.list('tree_jobs', j => !['committed', 'failed', 'cancelled', 'unknown', 'invalid_output', 'stale'].includes(j.status) && (j.nodeIds ?? [j.scopeKey]).some(id => ids.includes(id)))) this.replace('tree_jobs', j, { status: j.status === 'submitted' ? 'submitted' : 'stale', invalidated: true, error: reason });
  }
  applyAttribution(command) {
    const actor = this.actor(['attribution']);
    return this.repo.command('applyAttribution', command, actor, () => {
      const input = command.input;
      shape(input, ['sessionId', 'nativeTurn', 'userSourceRefs', 'sourceRefs', 'actions', 'statusChanges'], ['failure', 'attributionRunId']);
      text(input.sessionId, 'sessionId', 512); integer(input.nativeTurn, 'nativeTurn', 0);
      const userRefs = this.refs(input.userSourceRefs, { user: true }), refs = this.refs(input.sourceRefs);
      if (userRefs.some(r => !refs.some(s => canonicalJson(r) === canonicalJson(s)))) fail('INVALID_SOURCE', 'User references must be included in the turn');
      const logicalTurnId = digest(['turn', input.sessionId, input.nativeTurn]), id = logicalTurnId;
      if (this.repo.get('tree_turns', id)) fail('TURN_EXISTS', 'This native turn has already been attributed');
      let nodeIds, createdNodeIds = [], fallback = null;
      try {
        nodeIds = this.repo.transaction(() => {
          if (input.failure) fail('ATTRIBUTION_FAILED', text(input.failure, 'failure', 2000));
          array(input.actions, 'actions', 8); if (!input.actions.length) fail('INVALID_FIELD', 'An attribution action is required', 400);
          const selected = [];
          for (const action of input.actions) {
            oneOf(action.action, ['continue', 'switch', 'create', 'create_child'], 'action');
            let target;
            if (['continue', 'switch'].includes(action.action)) { shape(action, ['action', 'nodeId']); this.candidate(action.nodeId); target = this.node(action.nodeId).id; }
            else {
              shape(action, action.action === 'create' ? ['action', 'name'] : ['action', 'parentId', 'name']); text(action.name, 'name', 80);
              const parentId = action.action === 'create' ? this.repo.rootId() : this.node(action.parentId).id;
              this.candidate(parentId);
              target = randomUUID(); this.repo.save('tree_nodes', { id: target, parentId, name: action.name, status: 'active', statusOrigin: actor.kind === 'user' ? 'user' : 'model', sourceRefs: userRefs, lastOwnTurnAt: null, lastSummaryWatermark: null }); createdNodeIds.push(target);
            }
            this.#reactivate(target); selected.push(target);
          }
          for (const change of array(input.statusChanges, 'statusChanges', 8)) {
            shape(change, ['nodeId', 'status', 'sourceRefs']); oneOf(change.status, ['paused', 'completed', 'abandoned'], 'status'); this.refs(change.sourceRefs, { user: true });
            this.candidate(change.nodeId);
            this.#status(change.nodeId, change.status, change.sourceRefs);
          }
          return [...new Set(selected)];
        });
      } catch (error) {
        // Only invalid attribution output falls back. Database/CAS/actor failures
        // must remain explicit failures rather than masquerading as safe routing.
        if (!['ATTRIBUTION_FAILED', 'INVALID_SHAPE', 'INVALID_FIELD', 'NODE_NOT_FOUND', 'ROOT_INVARIANT', 'INVALID_SOURCE', 'SOURCE_CHANGED', 'USER_SOURCE_REQUIRED'].includes(error.code)) throw error;
        fallback = { code: error.code, reason: error.message, visible: true }; createdNodeIds = [];
        const prior = this.repo.list('tree_turns', t => t.sessionId === input.sessionId && t.nativeTurn < input.nativeTurn).sort((a, b) => b.nativeTurn - a.nativeTurn)[0];
        nodeIds = (prior?.nodeIds ?? []).filter(id => { const n = this.repo.get('tree_nodes', id); return n && !n.deleted; });
        if (!nodeIds.length) nodeIds = [this.repo.rootId()];
      }
      const turn = this.repo.save('tree_turns', { id, sessionId: input.sessionId, nativeTurn: input.nativeTurn, logicalTurnId, userSourceRefs: userRefs, sourceRefs: refs, nodeIds, createdNodeIds, assignmentRevision: 1, status: 'open', startedAt: this.repo.now(), attributionRunId: input.attributionRunId ?? null, fallback });
      for (const nodeId of nodeIds) {
        this.repo.save('tree_links', { id: digest(['link', id, 1, nodeId]), turnId: id, nodeId, assignmentRevision: 1, active: true, sourceRefs: refs });
        this.replace('tree_nodes', this.node(nodeId), { lastOwnTurnAt: turn.startedAt });
      }
      this.#touchStructure(); return { turnId: id, logicalTurnId, nodeIds, createdNodeIds, fallback };
    });
  }
  moveNode(command) {
    return this.repo.command('moveNode', command, this.actor([], true), () => {
      shape(command.input, ['nodeId', 'parentId', 'sourceRefs']); const { nodeId, parentId } = command.input;
      this.repo.requireExpected(command, 'tree_nodes', nodeId); const node = this.node(nodeId); this.node(parentId);
      if (nodeId === this.repo.rootId()) fail('ROOT_INVARIANT', 'Root cannot move');
      if (this.repo.ancestors(parentId).some(n => n.id === nodeId)) fail('TREE_CYCLE', 'A node cannot move below itself');
      this.refs(command.input.sourceRefs, { required: false });
      const affected = this.repo.list('tree_nodes', n => !n.deleted && this.repo.ancestors(n.id).some(a => a.id === nodeId)).map(n => n.id);
      this.replace('tree_nodes', node, { parentId }); this.#touchStructure(); this.#invalidateScope(affected, 'node_moved'); return { nodeId, parentId };
    });
  }
  setStatus(command) {
    return this.repo.command('setStatus', command, this.actor(['main']), () => {
      shape(command.input, ['nodeId', 'status', 'sourceRefs']); const { nodeId, status } = command.input; this.scoped(nodeId);
      if (this.context().actor.kind === 'model' && status !== 'completed') fail('FORBIDDEN', 'Main may only mark the current node complete', 403);
      this.repo.requireExpected(command, 'tree_nodes', nodeId); this.refs(command.input.sourceRefs, { required: false }); this.#status(nodeId, status, command.input.sourceRefs);
      this.#touchStructure(); return { nodeId, status: this.node(nodeId).status, statusOrigin: this.node(nodeId).statusOrigin };
    });
  }
  // Main may restate its current goal in place. The name is re-projected on the
  // next native step; scope, assignment and in-flight jobs stay untouched.
  renameGoal(command) {
    return this.repo.command('renameGoal', command, this.actor(['main']), () => {
      shape(command.input, ['nodeId', 'name', 'sourceRefs']); const { nodeId } = command.input; this.scoped(nodeId);
      this.repo.requireExpected(command, 'tree_nodes', nodeId); const node = this.node(nodeId), name = text(command.input.name, 'name', 80);
      if (nodeId === this.repo.rootId()) fail('ROOT_INVARIANT', 'The root goal keeps its name');
      if (node.nameUserProtected) fail('USER_PROTECTED', 'The user named this goal; ask before renaming it');
      this.refs(command.input.sourceRefs, { required: false });
      // The summary was written under the old name; it is refreshed once this
      // turn's learning settles, and its one line is hidden until then.
      this.replace('tree_nodes', node, { name, nameOrigin: 'model', summaryNameStale: true }); this.#touchStructure(); return { nodeId, name, previousName: node.name };
    });
  }
  recordGoalRevision(command) {
    return this.repo.command('recordGoalRevision', command, this.actor(['main']), () => {
      shape(command.input, ['turnId', 'revision']); const { turnId, revision } = command.input;
      shape(revision, ['id', 'op', 'nodeId', 'reason', 'callId', 'state'], ['name', 'previousName', 'parentId']); oneOf(revision.op, ['rename', 'add_parent', 'create_child', 'switch', 'move'], 'op');
      oneOf(revision.state, revision.op === 'rename' ? ['applied'] : ['pending'], 'state'); text(revision.reason, 'reason', 2000);
      if (!['switch', 'move'].includes(revision.op)) text(revision.name, 'name', 80);
      if (revision.op === 'move') { text(revision.parentId, 'parentId', 200); if (revision.name !== undefined) fail('INVALID_FIELD', 'move keeps the goal name'); }
      else if (revision.parentId !== undefined) fail('INVALID_FIELD', 'parentId is only for move');
      this.repo.requireExpected(command, 'tree_turns', turnId); const turn = this.repo.get('tree_turns', turnId); if (!turn) fail('TURN_NOT_FOUND', 'Turn not found');
      const revisions = turn.goalRevisions ?? []; if (revisions.some(r => r.id === revision.id)) return { turnId, revisionId: revision.id, duplicate: true };
      if (revisions.length >= 8) fail('GOAL_REVISION_LIMIT', 'At most eight goal revisions per turn');
      this.replace('tree_turns', turn, { goalRevisions: [...revisions, { ...revision, at: this.repo.now() }] }); return { turnId, revisionId: revision.id, duplicate: false };
    });
  }
  // Structural goal revisions requested by main during a turn. They change the
  // turn assignment or ancestry, which the running main job is bound to, so
  // they wait until the main job has settled and before learning is queued.
  applyGoalRevisions(command) {
    return this.repo.command('applyGoalRevisions', command, this.actor(['main']), () => {
      shape(command.input, ['turnId', 'mainCommitted']); const { turnId, mainCommitted } = command.input;
      this.repo.requireExpected(command, 'tree_turns', turnId); let turn = this.repo.get('tree_turns', turnId); if (!turn) fail('TURN_NOT_FOUND', 'Turn not found');
      const revisions = (turn.goalRevisions ?? []).map(r => ({ ...r })); let nodeIds = [...turn.nodeIds], createdNodeIds = [...(turn.createdNodeIds ?? [])], moved = [], relocated = [];
      for (const revision of revisions) {
        if (revision.state !== 'pending') continue;
        if (!mainCommitted) { Object.assign(revision, { state: 'dropped', reason: 'main_not_committed' }); continue; }
        const target = this.repo.get('tree_nodes', revision.nodeId);
        if (!target || target.deleted) { Object.assign(revision, { state: 'dropped', reason: 'node_missing' }); continue; }
        if (revision.op === 'move') {
          // The goal keeps its id, name, items and summaries; the turn stays on
          // its current goal. Only the parent changes, so later turns carry the
          // new path. The goal must still be at or below a goal main was given.
          if (!currentGoalAbove(this.repo, turn.nodeIds, target.id)) { Object.assign(revision, { state: 'dropped', reason: 'out_of_scope' }); continue; }
          const parent = this.repo.get('tree_nodes', revision.parentId);
          if (!parent || parent.deleted || parent.status !== 'active') { Object.assign(revision, { state: 'dropped', reason: 'parent_unavailable' }); continue; }
          if (target.id === this.repo.rootId() || this.repo.ancestors(parent.id).some(a => a.id === target.id)) { Object.assign(revision, { state: 'dropped', reason: 'tree_cycle' }); continue; }
          if (target.parentId === parent.id) { Object.assign(revision, { state: 'dropped', reason: 'already_there' }); continue; }
          revision.fromParentId = target.parentId;
          this.replace('tree_nodes', target, { parentId: parent.id }); relocated.push(target.id);
        } else if (revision.op === 'switch') {
          nodeIds = [target.id]; this.#reactivate(target.id);
        } else {
          const id = randomUUID(), parentId = revision.op === 'add_parent' ? target.parentId : target.id;
          if (revision.op === 'add_parent' && !parentId) { Object.assign(revision, { state: 'dropped', reason: 'root_has_no_parent' }); continue; }
          this.repo.save('tree_nodes', { id, parentId, name: revision.name, status: 'active', statusOrigin: 'model', sourceRefs: turn.userSourceRefs, lastOwnTurnAt: turn.startedAt, lastSummaryWatermark: null });
          this.#reactivate(id); createdNodeIds.push(id); revision.createdNodeId = id;
          if (revision.op === 'add_parent') { this.replace('tree_nodes', this.node(target.id), { parentId: id }); moved.push(target.id); }
          // Both ops move the turn to the new goal. A child created on an
          // ancestor takes the place of the current goal under that ancestor.
          nodeIds = nodeIds.includes(target.id) ? nodeIds.map(n => n === target.id ? id : n)
            : nodeIds.map(n => this.repo.ancestors(n).some(a => a.id === target.id) ? id : n);
        }
        Object.assign(revision, { state: 'applied', appliedAt: this.repo.now() });
      }
      nodeIds = [...new Set(nodeIds)];
      const reassigned = canonicalJson(nodeIds) !== canonicalJson(turn.nodeIds), assignmentRevision = turn.assignmentRevision + (reassigned ? 1 : 0);
      if (reassigned) {
        for (const link of this.repo.list('tree_links', l => l.turnId === turnId && l.active)) this.replace('tree_links', link, { active: false });
        for (const nodeId of nodeIds) this.repo.save('tree_links', { id: digest(['link', turnId, assignmentRevision, nodeId]), turnId, nodeId, assignmentRevision, active: true, sourceRefs: turn.sourceRefs });
      }
      const created = createdNodeIds.length !== (turn.createdNodeIds ?? []).length;
      this.replace('tree_turns', turn, { goalRevisions: revisions, nodeIds, createdNodeIds, assignmentRevision });
      if (moved.length) {
        const affected = this.repo.list('tree_nodes', n => !n.deleted && this.repo.ancestors(n.id).some(a => moved.includes(a.id))).map(n => n.id);
        this.#invalidateScope(affected, 'goal_parent_added');
      }
      if (relocated.length) {
        const affected = this.repo.list('tree_nodes', n => !n.deleted && this.repo.ancestors(n.id).some(a => relocated.includes(a.id))).map(n => n.id);
        this.#invalidateScope(affected, 'goal_moved');
      }
      if (reassigned || moved.length || relocated.length || created) this.#touchStructure();
      return { turnId, nodeIds, assignmentRevision, revisions: revisions.map(({ id, op, state, reason, createdNodeId }) => ({ id, op, state, ...(reason ? { reason } : {}), ...(createdNodeId ? { createdNodeId } : {}) })) };
    });
  }
  correctAssignment(command) {
    return this.repo.command('correctAssignment', command, this.actor([], true), () => {
      shape(command.input, ['turnId', 'nodeIds', 'sourceRefs'], ['undoCreate']); const { turnId } = command.input;
      this.repo.requireExpected(command, 'tree_turns', turnId); const turn = this.repo.get('tree_turns', turnId); if (!turn) fail('TURN_NOT_FOUND', 'Turn not found');
      this.refs(command.input.sourceRefs, { required: false }); const nodeIds = [...new Set(array(command.input.nodeIds, 'nodeIds', 8))];
      if (!nodeIds.length) fail('INVALID_FIELD', 'At least one target node is required'); nodeIds.forEach(id => this.node(id));
      const removed = turn.nodeIds.filter(id => !nodeIds.includes(id)), added = nodeIds.filter(id => !turn.nodeIds.includes(id));
      if (!removed.length && !added.length) return { turnId, nodeIds, jobs: [], unchanged: true };
      // Attribution predates tool/results. Preserve its immutable original refs,
      // and include the separately settled native experience in correction.
      const experienceRefs = [...new Map([...turn.sourceRefs, ...(turn.experienceRefs ?? [])].map(r => [canonicalJson(r), r])).values()];
      const assignmentRevision = turn.assignmentRevision + 1;
      for (const link of this.repo.list('tree_links', l => l.turnId === turnId && l.active)) this.replace('tree_links', link, { active: false });
      for (const nodeId of nodeIds) this.repo.save('tree_links', { id: digest(['link', turnId, assignmentRevision, nodeId]), turnId, nodeId, assignmentRevision, active: true, sourceRefs: experienceRefs });
      this.replace('tree_turns', turn, { nodeIds, assignmentRevision }); this.#invalidateScope(removed, 'assignment_corrected');
      const jobs = [], matching = new Set(experienceRefs.map(canonicalJson));
      for (const item of this.repo.list('tree_items', i => removed.includes(i.nodeId) && i.lifecycle === 'active')) {
        const version = this.repo.get('tree_item_versions', digest(['item_version', item.id, item.activeVersion]));
        if (!version?.sourceRefs.some(r => matching.has(canonicalJson(r)))) continue;
        if (version.sourceRefs.every(r => matching.has(canonicalJson(r)))) {
          this.replace('tree_items', item, { lifecycle: 'invalid', invalidationReason: 'assignment_corrected' });
          for (const h of this.repo.list('tree_hooks', h => h.methodId === item.id && h.enabled)) this.replace('tree_hooks', h, { enabled: false });
          for (const run of this.repo.list('tree_script_runs', r => r.methodVersion?.itemId === item.id && !['succeeded', 'failed', 'revoked'].includes(r.state))) this.replace('tree_script_runs', run, { state: 'revoked', denial: 'assignment_corrected' });
        } else {
          this.replace('tree_items', item, { stale: true, staleReason: 'assignment_corrected' });
          jobs.push(this.#queue('verification', item.nodeId, { turnId, itemId: item.id, itemVersion: item.activeVersion, assignmentRevision }));
        }
      }
      for (const nodeId of added) jobs.push(this.#queue('learning', nodeId, { turnId, assignmentRevision, sourceRefs: experienceRefs }));
      if (command.input.undoCreate) for (const id of turn.createdNodeIds ?? []) {
        if (!removed.includes(id) || this.repo.list('tree_links', l => l.nodeId === id && l.active).length || this.repo.list('tree_nodes', n => !n.deleted && n.parentId === id).length) continue;
        this.replace('tree_nodes', this.node(id), { deleted: true, deletionReason: 'undo_create_without_other_experience' });
      }
      this.#touchStructure(); return { turnId, nodeIds, removed, jobs };
    });
  }
  #queue(kind, nodeId, input) {
    const id = digest(['correction_job', kind, nodeId, input]);
    this.repo.save('tree_jobs', { id, kind, scopeKey: nodeId, nodeIds: [nodeId], input, inputHash: digest(input), inputRevisionSet: { [recordKey('tree_nodes', nodeId)]: this.node(nodeId).revision }, status: 'queued' }); return id;
  }
  setParameter(command) {
    return this.repo.command('setParameter', command, this.actor(['improvement']), () => {
      shape(command.input, ['name', 'scopeNodeId', 'value', 'sourceRefs']); const { name, scopeNodeId, value } = command.input; this.node(scopeNodeId); this.scoped(scopeNodeId);
      oneOf(name, ['retentionDays', 'leaveTimeoutHours'], 'parameter'); integer(value, name, 1, name === 'retentionDays' ? 365 : 168);
      this.refs(command.input.sourceRefs, { required: this.context().actor.kind !== 'user' });
      const id = digest(['parameter', name, scopeNodeId]), old = this.repo.get('tree_parameters', id);
      if (old) { this.repo.requireExpected(command, 'tree_parameters', id); if (old.actor.kind === 'user' && this.context().actor.kind !== 'user') fail('USER_PROTECTED', 'Explicit user settings cannot be changed in background'); }
      const saved = this.repo.save('tree_parameters', { id, name, scopeNodeId, value, sourceRefs: command.input.sourceRefs, actor: this.context().actor }, old?.revision ?? null); return { parameterId: saved.id, value };
    });
  }
  parameter(name, nodeId) {
    oneOf(name, ['retentionDays', 'leaveTimeoutHours'], 'parameter');
    for (const n of this.repo.ancestors(nodeId).reverse()) { const p = this.repo.get('tree_parameters', digest(['parameter', name, n.id])); if (p) return p.value; }
    return name === 'retentionDays' ? 7 : 24;
  }
}

export class SignalService extends DomainService {
  #write(input, correctionOf = null) {
    shape(input, ['eventId', 'subjectRefs', 'dimension', 'subitem', 'category', 'polarity', 'evidenceKind', 'sourceRefs', 'nodeIds', 'confidence']);
    text(input.eventId, 'eventId', 512); array(input.subjectRefs, 'subjects', 20).forEach(s => text(s, 'subject', 512));
    oneOf(input.category, CATEGORIES, 'category'); oneOf(input.polarity, ['negative', 'weak', 'strong'], 'polarity'); oneOf(input.evidenceKind, ['language', 'ui', 'program'], 'evidenceKind');
    if (input.evidenceKind === 'language') this.refs(input.sourceRefs); else this.refs(input.sourceRefs, { required: false });
    if (input.evidenceKind === 'ui' && this.context().actor.kind !== 'user') fail('FORGED_UI', 'Only a trusted user operation is UI evidence');
    if (this.context().actor.kind === 'model' && this.context().eventIds && !this.context().eventIds.includes(input.eventId)) fail('UNKNOWN_EVENT', 'Event was not supplied to this invocation');
    for (const nodeId of array(input.nodeIds, 'nodeIds', 8)) this.node(nodeId);
    if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) fail('INVALID_FIELD', 'Invalid confidence');
    const subjectRefs = [...new Set(input.subjectRefs)].sort(), id = digest(['signal', input.eventId, input.category, subjectRefs, correctionOf]);
    const old = this.repo.get('tree_signals', id);
    if (old) {
      const comparable = s => ({ ...s, nodeIds: [] });
      const original = Object.fromEntries(Object.keys(input).map(k => [k, old[k]]));
      if (canonicalJson(comparable({ ...input, subjectRefs })) !== canonicalJson(comparable(original))) fail('SIGNAL_CONFLICT', 'The same observation has conflicting evidence');
      const nodeIds = [...new Set([...old.nodeIds, ...input.nodeIds])].sort();
      if (canonicalJson(nodeIds) !== canonicalJson(old.nodeIds)) this.replace('tree_signals', old, { nodeIds }); return { signalId: id, duplicate: true };
    }
    this.repo.save('tree_signals', { ...input, subjectRefs, nodeIds: [...new Set(input.nodeIds)].sort(), id, ...(correctionOf ? { correctionOf } : {}) }); return { signalId: id, duplicate: false };
  }
  record(command) { return this.repo.command('recordSignal', command, this.actor(['learning', 'verification', 'consolidation']), () => this.#write(command.input)); }
  correct(command) {
    return this.repo.command('correctSignal', command, this.actor([], true), () => {
      shape(command.input, ['signalId', 'replacement']); const old = this.repo.get('tree_signals', command.input.signalId); if (!old) fail('SIGNAL_NOT_FOUND', 'Signal missing');
      this.repo.requireExpected(command, 'tree_signals', old.id); const replacement = command.input.replacement;
      if (replacement.eventId !== old.eventId || canonicalJson([...replacement.subjectRefs].sort()) !== canonicalJson(old.subjectRefs)) fail('SIGNAL_CONFLICT', 'Correction must keep the original observation identity');
      const result = this.#write(replacement, old.id);
      for (const kind of ['tree_metric_windows', 'tree_clusters']) for (const row of this.repo.list(kind)) this.replace(kind, row, { needsRecheck: true });
      return { ...result, correctionOf: old.id };
    });
  }
}
