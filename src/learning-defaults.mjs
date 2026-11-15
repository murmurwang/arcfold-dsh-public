import { isAbsolute } from 'node:path';
import { DomainError } from './store.mjs';

const KIND = 'learn_defaults', ID = 'web';
const CHOICE = ['provider', 'model', 'reasoningEffort'];
const EXECUTION = [...CHOICE, 'maxTokens', 'preset', 'cwd'];
const fail = (code, message) => { throw new DomainError(code, message); };
const choice = value => Object.fromEntries(CHOICE.map(key => [key, value?.[key]]));

function assertChoice(value) {
  if (!value || !CHOICE.every(key => typeof value[key] === 'string' && value[key].trim()))
    fail('learning_configuration_unavailable', '学习需要明确的模型提供方、型号和思考强度。');
}

/** A detached frozen execution identity; no lookup of today's defaults. */
export function learningExecutionConfig(run) {
  const value = run?.executionConfig;
  if (!Number.isSafeInteger(run?.defaultsRevision) || run.defaultsRevision < 1 || !value ||
      Object.keys(value).sort().join() !== [...EXECUTION].sort().join())
    fail('learning_execution_config_missing', '旧学习没有可核实的执行配置，不能采用今天的设置重发。');
  assertChoice(value);
  if (!Number.isSafeInteger(value.maxTokens) || value.maxTokens < 1 ||
      typeof value.preset !== 'string' || !value.preset ||
      typeof value.cwd !== 'string' || !isAbsolute(value.cwd))
    fail('learning_execution_config_missing', '学习执行配置不完整，不能自动恢复。');
  return Object.freeze({ ...value });
}

/** One independent default in the existing business store, not a main model or execution queue. */
export class LearningDefaults {
  constructor({ business, deployment, assertSelection } = {}) {
    if (!business?.storage) throw new TypeError('Learning defaults require business storage');
    this.store = business.storage;
    this.deployment = deployment ? Object.freeze({ ...choice(deployment), maxTokens: deployment.maxTokens,
      preset: deployment.preset, cwd: deployment.cwd }) : null;
    this.assertSelection = assertSelection;
  }

  read() { return this.store.get(KIND, ID); }

  validate(selected) {
    assertChoice(selected);
    const executionConfig = learningExecutionConfig({ defaultsRevision: 1,
      executionConfig: { ...choice(selected), maxTokens: this.deployment?.maxTokens,
        preset: this.deployment?.preset, cwd: this.deployment?.cwd } });
    if (typeof this.assertSelection !== 'function')
      fail('learning_configuration_unavailable', '学习设置尚未接入当前授权路线检查。');
    const result = this.assertSelection(executionConfig);
    if (result && typeof result.then === 'function') {
      Promise.resolve(result).catch(() => {});
      fail('learning_validator_async', '学习设置授权检查必须同步完成。');
    }
    if (result === false) fail('learning_configuration_unavailable', '当前路线不允许这项学习设置。');
    return executionConfig;
  }

  initialize() {
    return this.store.transaction(() => {
      const existing = this.read();
      if (existing) return existing;
      this.validate(this.deployment);
      return this.store.save(KIND, { id: ID, ...choice(this.deployment),
        provenance: { kind: 'explicit_learning_deployment', initialSelection: choice(this.deployment) } });
    });
  }

  save(request) {
    if (!request || Object.keys(request).sort().join() !== [...CHOICE, 'expectedRevision'].sort().join() ||
        !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1)
      fail('invalid_learning_defaults', '只接受模型三字段和明确的原版本；输出上限与工作目录属于部署配置。');
    return this.store.transaction(() => {
      const existing = this.read();
      if (!existing) fail('learning_configuration_unavailable', '未明确配置学习，不能通过日常设置启用。');
      if (existing.revision !== request.expectedRevision) fail('revision_conflict', '学习默认设置已变化，请刷新后保存。');
      this.validate(request);
      return this.store.save(KIND, { ...existing, ...choice(request),
        provenance: { kind: 'validated_learning_default_edit', previousRevision: existing.revision,
          initializedFrom: existing.provenance.initializedFrom ?? existing.provenance } },
      { expectedRevision: existing.revision });
    });
  }

  snapshot() {
    return this.store.transaction(() => {
      const record = this.read();
      if (!record) fail('learning_configuration_unavailable', '学习尚无明确的默认设置。');
      return Object.freeze({ executionConfig: this.validate(record), defaultsRevision: record.revision });
    });
  }
}

/** Compatibility until the runtime supplies its live authorized-route validator. */
export function deploymentSelectionValidator(deployment) {
  return selected => {
    if (!deployment || CHOICE.some(key => selected[key] !== deployment[key]))
      fail('learning_configuration_unavailable', '当前组件只允许显式部署的学习选择；动态路线尚未接通。');
  };
}
