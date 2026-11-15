import test from 'node:test';
import assert from 'node:assert/strict';
import { BusinessStore } from '../src/business.mjs';
import { LearningDefaults, deploymentSelectionValidator, learningExecutionConfig } from '../src/learning-defaults.mjs';

const deployment = { preset: 'arcfold-learning', cwd: '/fixture-workspace', provider: 'fixture',
  model: 'first', reasoningEffort: 'off', maxTokens: 100 };
const next = { provider: 'fixture', model: 'second', reasoningEffort: 'high' };
function fixture(t, options = {}) {
  const business = new BusinessStore({ filename: ':memory:' }); t.after(() => business.close());
  const validate = value => {
    assert.equal(value.maxTokens, 100);
    if (value.provider !== 'fixture' || !['first', 'second'].includes(value.model) || !['off', 'high'].includes(value.reasoningEffort))
      throw new Error('Route is not authorized');
  };
  return { business, defaults: new LearningDefaults({ business, deployment, assertSelection: validate, ...options }) };
}

test('only explicit authorized learning deployment creates one default, without overwriting it on restart', t => {
  const { business, defaults } = fixture(t);
  assert.equal(defaults.read(), null);
  const initial = defaults.initialize();
  assert.equal(initial.revision, 1); assert.equal(initial.provenance.kind, 'explicit_learning_deployment');
  const saved = defaults.save({ expectedRevision: 1, ...next });
  assert.equal(saved.revision, 2); assert.equal(saved.maxTokens, undefined);
  const restarted = new LearningDefaults({ business, deployment: { ...deployment, model: 'third' },
    assertSelection: deploymentSelectionValidator({ ...deployment, model: 'third' }) });
  assert.deepEqual(restarted.initialize(), saved);
  assert.equal(business.storage.listAll('learn_defaults').length, 1);
  assert.equal(business.storage.listAll('main_model').length, 0);
  assert.throws(() => restarted.snapshot(), { code: 'learning_configuration_unavailable' });
  assert.deepEqual(restarted.read(), saved);
});

test('missing configuration or route validation cannot create or enable a default', t => {
  for (const options of [{ deployment: null }, { assertSelection: undefined }, { assertSelection: () => false },
    { deployment: { ...deployment, cwd: undefined } }]) {
    const { defaults, business } = fixture(t, options);
    assert.throws(() => defaults.initialize());
    assert.equal(defaults.read(), null); assert.equal(business.storage.currentSequence(), 0);
    assert.throws(() => defaults.save({ expectedRevision: 1, ...next }));
  }
});

test('stale revision, unauthorized route and deployment-field edits cannot overwrite the saved value', t => {
  const { defaults, business } = fixture(t); defaults.initialize();
  const saved = defaults.save({ expectedRevision: 1, ...next }), sequence = business.storage.currentSequence();
  for (const request of [
    { expectedRevision: 1, ...next },
    { expectedRevision: 2, ...next, provider: 'unapproved' },
    { expectedRevision: 2, ...next, maxTokens: 1000 },
    { expectedRevision: 2, ...next, preset: 'main' },
    { expectedRevision: 2, ...next, cwd: '/other' },
  ]) {
    assert.throws(() => defaults.save(request)); assert.deepEqual(defaults.read(), saved);
    assert.equal(business.storage.currentSequence(), sequence);
  }
});

test('snapshot is detached from later defaults and always retains explicit deployment controls', t => {
  const { defaults, business } = fixture(t); defaults.initialize();
  const before = defaults.snapshot(), sequence = business.storage.currentSequence();
  assert.equal(business.storage.currentSequence(), sequence);
  defaults.save({ expectedRevision: 1, ...next });
  const after = defaults.snapshot();
  assert.deepEqual(before, { executionConfig: deployment, defaultsRevision: 1 });
  assert.deepEqual(after, { executionConfig: { ...deployment, ...next }, defaultsRevision: 2 });
  assert.ok(Object.isFrozen(before.executionConfig));
  assert.throws(() => { before.executionConfig.model = 'edited'; }, TypeError);
  assert.equal(learningExecutionConfig(before).model, 'first');
  assert.throws(() => learningExecutionConfig({ executionConfig: deployment }), { code: 'learning_execution_config_missing' });
  assert.throws(() => learningExecutionConfig({ ...before, executionConfig: { ...deployment, newAuthorization: true } }));
});

test('current route revocation and asynchronous validation fail without writing or falling back', async t => {
  let allowed = true;
  const { defaults, business } = fixture(t, { assertSelection: () => allowed });
  defaults.initialize(); const before = defaults.read(), sequence = business.storage.currentSequence();
  allowed = false; assert.throws(() => defaults.snapshot()); assert.throws(() => defaults.save({ expectedRevision: 1, ...next }));
  assert.deepEqual(defaults.read(), before); assert.equal(business.storage.currentSequence(), sequence);
  const asyncDefaults = new LearningDefaults({ business, deployment, assertSelection: async () => { throw new Error('validator rejected'); } });
  assert.throws(() => asyncDefaults.save({ expectedRevision: 1, ...next }), { code: 'learning_validator_async' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(defaults.read(), before);
});
