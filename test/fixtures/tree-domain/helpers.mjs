import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TreeRepository, recordKey } from '../../../src/tree/repository.mjs';
import { TreeService, SignalService } from '../../../src/tree/tree.mjs';
import { ItemService, ReportService } from '../../../src/tree/items.mjs';
import { digest } from '../../../src/tree/contracts.mjs';
export function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tree-domain-')); const sources = new Map(); let seq = 0, turn = 0;
  const context = { actor: { kind: 'user', id: 'fixture-user' }, nodeIds: [] };
  const repo = new TreeRepository({ treeFilename: join(dir, 'tree.sqlite'), userId: 'fixture-user', ...options });
  t.after(() => { repo.close(); rmSync(dir, { recursive: true, force: true }); });
  const serviceOptions = { repository: repo, context: () => context, resolveSource: ref => sources.get(digest(ref)) };
  const tree = new TreeService(serviceOptions), items = new ItemService(serviceOptions), signals = new SignalService(serviceOptions), reports = new ReportService(serviceOptions);
  function source(content = '用户的新经历', role = 'user', origin = 'user') {
    const ref = { sessionId: 'fixture-session', seq: seq++, sha256: createHash('sha256').update(content).digest('hex') }; sources.set(digest(ref), { text: content, role, origin, sha256: ref.sha256 }); return ref;
  }
  const ref = source();
  const cmd = (input, expected = {}, requestId = randomUUID()) => ({ requestId, expected, input });
  const expected = (kind, id) => ({ [recordKey(kind, id)]: repo.get(kind, id).revision });
  function attribution(actions, extra = {}) { return cmd({ sessionId: 'fixture-session', nativeTurn: turn++, sourceRefs: [ref], userSourceRefs: [ref], actions, statusChanges: [], ...extra }); }
  function create(name, parentId) { return tree.applyAttribution(attribution([parentId ? { action: 'create_child', name, parentId } : { action: 'create', name }])).result.nodeIds[0]; }
  function asModel(role = 'learning', nodeIds = [repo.rootId()]) { context.actor = { kind: 'model', id: 'fixture-invocation', role }; context.nodeIds = nodeIds; context.candidateNodeIds = repo.list('tree_nodes', n => !n.deleted).map(n => n.id); }
  function asUser() { context.actor = { kind: 'user', id: 'fixture-user' }; }
  function propose(nodeId, updates = {}) { return items.commitProposal(cmd({ nodeId, understandings: [], methods: [], supplements: [], ...updates })).result; }
  function expose(nodeId, itemIds, versions = itemIds.map(id => repo.get('tree_items', id).activeVersion)) {
    const id = randomUUID(); repo.transaction(() => repo.save('tree_exposures', { id, invocationId: 'main-fixture', role: 'main', nodeIds: [nodeId], itemVersions: itemIds.map((itemId, i) => ({ itemId, version: versions[i] })), summaryVersions: [], renderedHash: digest(itemIds), treeRevision: repo.meta().treeRevision, modelSessionId: 'native-fixture', boundaryIndex: 1 })); return id;
  }
  return { dir, repo, context, tree, items, signals, reports, source, ref, cmd, expected, attribution, create, asModel, asUser, propose, expose };
}
export const short = { situation: '开始修改前', action: '读取现有内容', basis: '避免覆盖已有决定', notApplicable: '全新空文件' };
export const hook = { moment: 'before_tool', conditions: [{ field: 'toolName', op: 'equals', value: 'write' }], action: 'add_context', message: '先核对已有内容' };
export const method = refs => ({ kind: 'collaboration', short, long: null, hooks: [hook, { ...hook, moment: 'turn_end', conditions: [], action: 'remind_user', message: '说明本轮结果' }], scriptRequests: [], expectedEffect: { category: 'redo', change: 'less', text: '减少覆盖已有决定导致的重做' }, sourceRefs: refs });
