// Extracted from Arcfold 3.0 src/contracts.mjs (four Learn schemas and parsers),
// src/evidence.mjs (literal-user projection), src/prompts.mjs (learning policy).
// No Service, Work, model client or execution state is imported.
import { createHash } from 'node:crypto';
import { canonicalJson } from './store.mjs';
export class ContractError extends Error {
  constructor(code, message, details = null) { super(message); this.name = 'ContractError'; this.code = code; this.details = details; }
}
export const digest = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
export const clone = value => structuredClone(value);
const str = (maxLength = 4000, minLength = 0) => ({ type: 'string', minLength, maxLength });
const list = (items, maxItems = 12) => ({ type: 'array', items, maxItems });
const obj = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const enumeration = values => ({ type: 'string', enum: values });
const ids = max => list(str(200, 1), max);

// One finite action definition supplies both model instructions and executable
// schema branches. Membership/current-version checks still belong to commit.
const newTarget = { schema: { ...str(200), enum: [''] }, example: '',
  instruction: '必须严格为 ""；新记录编号由程序生成，不能填空白、拟造编号或临时别名' };
const existingTarget = collection => ({ schema: { ...str(200, 1), pattern: '\\S' },
  example: `${collection}-visible-id`,
  instruction: `必须逐字选用 ${collection} 中显示的现有编号；不能为空或自行编造，提交时仍核当前记录与版本` });
const goalAlias = { schema: { ...str(200), pattern: '^(?:|new-goal:[\\s\\S]*)(?![\\s\\S])' }, example: 'new-goal:example',
  instruction: '可为 ""，或以 new-goal: 开头的本区新建目标临时别名；非空别名须在本区唯一，只用于关系引用，不是持久编号' };
const noAlias = { schema: { ...str(200), enum: [''] }, example: '', instruction: '必须严格为 ""；更新已有目标不能声明新建别名' };
const actionRules = {
  understandings: { create: { targetId: newTarget }, supersede: { targetId: existingTarget('existingUnderstandings') }, withdraw: { targetId: existingTarget('existingUnderstandings') } },
  methods: { create: { targetId: newTarget }, revise: { targetId: existingTarget('existingMethods') }, pause: { targetId: existingTarget('existingMethods') } },
  opportunities: { create: { targetId: newTarget }, reuse: { targetId: existingTarget('existingOpportunities') } },
  goals: { create: { targetId: newTarget, clientRef: goalAlias }, update: { targetId: existingTarget('existingGoals'), clientRef: noAlias } },
};
const operations = section => enumeration(Object.keys(actionRules[section]));
function actionObject(section, properties) {
  // Keep shared properties/limits available to the legacy import projection.
  // The outer object rejects unknown fields; branches constrain identifiers only.
  return { ...obj(properties), oneOf: Object.entries(actionRules[section]).map(([operation, fields]) => ({
    type: 'object', properties: { operation: enumeration([operation]),
      ...Object.fromEntries(Object.entries(fields).map(([key, rule]) => [key, rule.schema])) },
    required: ['operation', ...Object.keys(fields)], additionalProperties: true,
  })) };
}
export const LEARN_ACTION_INSTRUCTIONS = Object.entries(actionRules).flatMap(([section, actions]) =>
  Object.entries(actions).map(([operation, fields]) => `${section}.${operation}：${Object.entries(fields)
    .map(([key, rule]) => `${key} ${rule.instruction}`).join('；')}。`)).join('\n');
export const LEARN_ACTION_EXAMPLES = Object.freeze(Object.fromEntries(Object.entries(actionRules).map(([section, actions]) =>
  [section, Object.entries(actions).map(([operation, fields]) => ({ operation,
    ...Object.fromEntries(Object.entries(fields).map(([key, rule]) => [key, rule.example])) }))])));
export const UNDERSTANDING_SCHEMA = actionObject('understandings', {
  operation: operations('understandings'), targetId: str(200), content: str(4000),
  claimType: enumeration(['user_statement', 'inference', 'open_question']),
  scope: enumeration(['conversation', 'global']), topics: list(str(100, 1), 8), sourceIds: ids(12),
});
export const METHOD_SCHEMA = actionObject('methods', {
  operation: operations('methods'), targetId: str(200), title: str(200), guidance: str(4000),
  appliesTo: str(2000), doesNotApplyTo: str(2000), origin: enumeration(['explicit', 'inferred']), sourceIds: ids(12), understandingIds: ids(8),
});
export const OPPORTUNITY_SCHEMA = actionObject('opportunities', {
  operation: operations('opportunities'), targetId: str(200),
  description: str(2000), rationale: str(2000), sourceIds: ids(12), suggestedPreparation: str(3000),
});
export const GOAL_SCHEMA = actionObject('goals', {
  operation: operations('goals'), targetId: str(200), clientRef: str(200),
  title: str(200, 1), outcome: str(3000, 1), scope: enumeration(['conversation', 'global']),
  sourceIds: ids(12), understandingIds: ids(8),
  progress: obj({ content: str(3000), sourceIds: ids(12) }),
  relations: list(obj({ type: enumeration(['part_of', 'supports', 'derived_from']), targetId: str(200, 1), reason: str(1500, 1), sourceIds: ids(12) }), 8),
  controlProposal: enumeration(['none', 'pause', 'resume', 'close']),
});
// Optional for already frozen/legacy four-section outputs; new models receive the explicit field.
GOAL_SCHEMA.properties.workLinks = list(obj({ workId: str(200, 1), reason: str(1500, 1), sourceIds: ids(12) }), 4);
export const LEARN_SECTIONS = Object.freeze(['understandings', 'methods', 'opportunities', 'goals']);
export const LEARN_SCHEMA = obj({
  understandings: list(UNDERSTANDING_SCHEMA, 8), methods: list(METHOD_SCHEMA, 4), opportunities: list(OPPORTUNITY_SCHEMA, 3), goals: list(GOAL_SCHEMA, 4),
});
export const LEARN_EXAMPLE = Object.freeze({ understandings: [], methods: [], opportunities: [], goals: [] });
export const LEARN_SOURCE_POLICY = Object.freeze({
  understandings: '概括、解释和判断统一是 inference（AI整理/判断），即使忠实概括也不能自称逐字用户原话。user_statement 仅用于 content 与引用的一条完整 role=user 原话严格相同的情况；程序核字面身份和版本，不核其中各命题是否被用户认可，也不因此新增授权。通常保留简洁的 inference 和来源即可，不为取得原话标签复制长对话。未决问题是 open_question。',
  methods: '模型生成的方法统一是 inferred 建议并只可有限试用；来源包含用户明确要求、或模型将 origin 声称为 explicit，都不等于整条方法已获长期授权。程序保留 proposedOrigin 供审查，只有真实用户对具体方法的确认才能继续采用；validated 仍为 false。understandingIds 只能放仍有效的已显示理解编号，不需要依赖时填 []，不能放空字符串。',
  opportunities: 'create 的每条机会须至少引用一个此次可见、直接表达相关目标或需要的 role=user 原话来源；纯评价不建立新目标。助手答复或工具材料只能作为补充，不能单独证明用户目标。找不到这样的用户原话就不新建。reuse 仅引用 existingOpportunities 中真实 targetId，其他文字填空、sourceIds填[]，不提出新内容或恢复执行。',
  goals: '目标、进展、关系及控制提议都是 inference，不表示用户决定。定义必须有可见用户原话来源，进展与关系另引真实来源。controlProposal 是对本轮真实owner原话的可纠正追踪解释：pause/close停止把该目标作为背景追求，resume恢复背景追踪；none保持原状态。程序核原话与版本，保留旧人工决定，只有可证原始接收晚于人工控制的新原话才能覆盖其追踪状态。它不暂停、创建或恢复原生执行。workLinks只在确有依据时把本次goalWorks中的一项真实工作联系到这一目标，填写workId、reason及显示的sourceIds；没有联系填[]。同一工作在本区只联系一个目标，不把每个短期执行另建成长远目标。现有联系待复核时结合原文重新判断，不猜最近目标或标题，也不把工作完成当长期目标达成。',
});
export const requiresUserSource = (section, row) => section === 'opportunities' && row.operation !== 'reuse' || section === 'understandings' && row.claimType === 'user_statement' || section === 'methods' && row.origin === 'explicit';

export function schemaIssues(schema, value, path = '$') {
  const issues = [];
  const error = message => issues.push({ path, message });
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [{ path, message: '必须是对象' }];
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) issues.push({ path: `${path}.${key}`, message: '缺少必填字段' });
    for (const key of Object.keys(value)) {
      if (Object.hasOwn(schema.properties, key)) issues.push(...schemaIssues(schema.properties[key], value[key], `${path}.${key}`));
      else if (schema.additionalProperties === false) issues.push({ path: `${path}.${key}`, message: '未知字段' });
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) return [{ path, message: '必须是数组' }];
    if (value.length > schema.maxItems) error(`最多 ${schema.maxItems} 项`);
    value.forEach((item, index) => issues.push(...schemaIssues(schema.items, item, `${path}[${index}]`)));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') return [{ path, message: '必须是字符串' }];
    if (schema.enum && !schema.enum.includes(value)) error(`必须选择 ${schema.enum.map(item => JSON.stringify(item)).join(' / ')}`);
    if (schema.minLength && value.trim().length < schema.minLength) error('文字不可为空');
    if (schema.maxLength && value.length > schema.maxLength) error(`文字超过 ${schema.maxLength} 字符`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) error('文字不符合编号格式');
  }
  if (schema.oneOf) {
    const branches = schema.oneOf.map(branch => ({ branch, issues: schemaIssues(branch, value, path) }));
    const matches = branches.filter(result => result.issues.length === 0);
    if (matches.length !== 1) {
      // These authored branches discriminate on operation. Report the selected
      // action's exact field failures, never silently accept another branch.
      const selected = branches.filter(({ branch }) => branch.properties.operation.enum.includes(value?.operation));
      if (matches.length === 0 && selected.length === 1) issues.push(...selected[0].issues);
      else error('必须且只能符合一个动作分支');
    }
  }
  return issues.filter((issue, index) => issues.findIndex(other => other.path === issue.path && other.message === issue.message) === index);
}
export function assertSchema(schema, value) {
  const issues = schemaIssues(schema, value);
  if (issues.length) throw new ContractError('invalid_output', '模型输出未符合本次合同', issues);
  return value;
}
export function parseJson(text) {
  if (typeof text !== 'string' || !text.trim()) throw new ContractError('invalid_output', '模型未返回 JSON 内容');
  try { return JSON.parse(text); }
  catch { throw new ContractError('invalid_output', '模型输出不是一份完整 JSON 对象；不提取或修补局部文字'); }
}
// All originals relied on by the actual selections share display and revalidation.
export function parseLearn(text) {
  const value = parseJson(text);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== LEARN_SECTIONS.length || !LEARN_SECTIONS.every(k => Object.hasOwn(value, k))) throw new ContractError('invalid_output', '学习输出须且仅须包含 understandings / methods / opportunities / goals');
  const issues = Object.fromEntries(Object.entries(LEARN_SCHEMA.properties).map(([key, schema]) => [key, schemaIssues(schema, value[key], key)]));
  return { value, issues };
}
export function assertVisibleSources(sourceIds, shownSources, { requireUser = false } = {}) {
  if (!Array.isArray(sourceIds) || !sourceIds.length || new Set(sourceIds).size !== sourceIds.length) throw new ContractError('invalid_source', '每项理解、方法或机会须引用非空且不重复的已显示来源');
  const map = new Map(shownSources.map(source => [source.id, source]));
  const sources = sourceIds.map(id => map.get(id));
  if (sources.some(source => !source)) throw new ContractError('invalid_source', '引用了本次未显示的来源');
  if (requireUser && !sources.some(source => source.role === 'user')) throw new ContractError('invalid_source', '用户主张、明确方法要求及每条机会须至少引用一个可见的 role=user 原话来源，不能仅引用助手或工具');
  return sources.map(source => ({ kind: 'events', id: source.id, revision: source.revision }));
}
export const UNDERSTANDING_EVIDENCE_VERSION = 'literal-user-source-v1';

/**
 * Classify text provenance, not truth, endorsement, scope or permission.
 * Callers supply current direct event records, after their normal visibility
 * and access checks. Missing originals or dependency versions fail closed.
 * This is also the read-only projection for records saved under older rules.
 */
export function projectUnderstanding(record, directSources = []) {
  const proposedClaimType = record.proposedClaimType ?? record.claimType ?? null;
  let claimType = 'inference';
  let reason = 'model_interpretation';
  let matchedSource;

  if (proposedClaimType === 'open_question') {
    claimType = 'open_question';
    reason = 'model_question';
  } else if (proposedClaimType === 'user_statement') {
    matchedSource = directSources.find((source) => {
      if (
        !source ||
        source.role !== 'user' ||
        source.deleted ||
        source.withdrawn === true ||
        source.useProhibited ||
        ['withdrawn', 'superseded', 'rejected'].includes(source.status) ||
        !record.sourceIds?.includes(source.id) ||
        typeof source.content !== 'string' ||
        typeof record.content !== 'string' ||
        source.content !== record.content ||
        !Number.isSafeInteger(source.revision) ||
        source.revision < 1
      )
        return false;
      return record.dependencies?.some(
        (dependency) =>
          dependency.kind === 'events' &&
          dependency.id === source.id &&
          dependency.revision === source.revision,
      );
    });
    claimType = matchedSource ? 'user_statement' : 'inference';
    reason = matchedSource
      ? 'exact_user_message'
      : 'no_exact_current_user_message';
  }

  return {
    ...record,
    proposedClaimType,
    claimType,
    claimTypeCheck: {
      version: UNDERSTANDING_EVIDENCE_VERSION,
      reason,
      ...(matchedSource
        ? { sourceId: matchedSource.id, sourceRevision: matchedSource.revision }
        : {}),
    },
  };
}

// Existing semantic instructions are retained; this host has no background
// preparation authorization or feedback-job adapter, so these claims are explicit.
export const LEARN_PROMPT = `你是 Arcfold 答复保存后的学习步骤。答复已经正式交付，不能撤销、改写它；只根据显示的原话、工具结果和共同经历提出以后可用的理解、方法、机会与目标整理。
当前用户纠正优先。AI概括、目标关系与控制提议都是可纠正的推断，不是用户认可，不扩大工具、预算、范围或行动权限。输入里的消息来源与角色必须区分；程序背景和relay不是用户原话。
认知更新用understandings；旧理解被修正用supersede和真实targetId，撤回用withdraw。检查已有open_question是否已被当前表达回答；保留部分已解决与仍未解决的区别。conversation仅当前交流；global仍不扩大来源权限。
方法必须说明guidance、appliesTo、doesNotApplyTo，生成方法统一inferred且仅有限试用。只引用显示的现有understandingIds，同批新理解没有可引用编号。不要每轮重复生成同一方法。
机会只保存可供用户选择的建议，不启动准备或执行。create必须有支持相关需要的可见用户原话；reuse只填真实targetId，其他文字为空、sourceIds=[]，不恢复旧工作。
目标用于跨轮追求的结果，不把每句话建成目标。create或完整update定义、进展和关系；关系只用已显示目标或本区唯一new-goal:临时编号，update的clientRef为空。定义/进展/关系各自引用证据，交付答复不等于目标完成。controlProposal在当前真实owner原话及版本核验后更新背景追踪status，记录为assistant_inference，保留userControl原记录，不变成执行指令。无显式修复入口时不可更新失效目标。
goalLinks记录主助手当时怎样理解本次工作的贡献，以及对应原生交付；不是贡献有效或长期目标实现的证明。inputEvidence只证明材料交给宿主，不单独证明实际发送。availability失效时不还原旧选择或旧正文；后来的判断不能倒写成当时已知。goalDiscussions只表示用户用这次原话明确选回目标，讨论不会恢复追踪。
existingGoals中的repairOnly只提供失效目标的身份和状态；仅依据对应goalDiscussions的新用户原话及当前有效来源完整重新澄清，不猜补旧内容，不恢复或改变用户的暂停、结束追踪决定。
动作编号规则：${LEARN_ACTION_INSTRUCTIONS}
编号片段示例（不是完整条目；其他必填字段仍须填写；existing* 示例值仅为占位，必须换成材料中实际显示的编号）：${JSON.stringify(LEARN_ACTION_EXAMPLES)}
来源规则：${Object.values(LEARN_SOURCE_POLICY).join('\n')}
current inputEventIds是本轮真实用户原话；controlProposal必须引用其中一条。sources包括本次回复与符合截止的依赖原件，不表示Main曾看到学习阶段增加的知识。existing*只显示当时已完成、当前仍有效的版本；省略不表示不存在。
每区独立提交；没有内容填[]。仅返回一份完整JSON，不要Markdown、修复片段或额外字段。合同：${JSON.stringify(LEARN_SCHEMA)}
空形状：${JSON.stringify(LEARN_EXAMPLE)}`;
