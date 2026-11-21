import test from 'node:test';
import assert from 'node:assert/strict';
import { validateOutput, parseFinalOutput, compilePrompt, OUTPUT_SCHEMAS, resolveSourceIds, promptOutputSchema, outputBindings } from '../src/tree/prompts.mjs';
import { full, minimal, envelope, understanding, method, short } from './fixtures/tree-model/contracts.mjs';
import { digest } from '../src/tree/contracts.mjs';
import { readFileSync } from 'node:fs';

test('the shorter verification instruction expands to the exact unchanged validation contract', () => {
  const schema = promptOutputSchema('verification');
  const expand = value => {
    if (Array.isArray(value)) return value.map(expand);
    if (!value || typeof value !== 'object') return value;
    if (value.$ref) { assert.match(value.$ref, /^#\/\$defs\/\w+$/); const definition = schema.$defs[value.$ref.split('/').at(-1)]; assert.ok(definition); return expand(definition); }
    return Object.fromEntries(Object.entries(value).filter(([k]) => k !== '$defs').map(([k, v]) => [k, expand(v)]));
  };
  assert.deepEqual(expand(schema), OUTPUT_SCHEMAS.verification);
  assert.ok(JSON.stringify(schema).length < JSON.stringify(OUTPUT_SCHEMAS.verification).length / 2);
  const prompt = compilePrompt('verification'); assert.ok(prompt.text.length < 3000); assert.equal(prompt.schemaHash, digest(OUTPUT_SCHEMAS.verification));
  for (const role of ['attribution', 'learning', 'consolidation', 'improvement', 'script_writer']) assert.equal(promptOutputSchema(role), OUTPUT_SCHEMAS[role]);
});

for (const role of Object.keys(minimal)) test(`C01 ${role}: minimal and complete output; schema and fixed prompt share a hash`, () => {
  const input = envelope(role); if (role === 'consolidation') input.trigger.reason = 'node_complete';
  assert.deepEqual(validateOutput(role, minimal[role], input), minimal[role]); assert.deepEqual(validateOutput(role, full[role], input), full[role]);
  const prompt = compilePrompt(role); assert.equal(prompt.schemaHash, digest(OUTPUT_SCHEMAS[role])); assert.equal(prompt.hash, digest(prompt.text)); assert.ok(Object.isFrozen(OUTPUT_SCHEMAS[role]));
  assert.deepEqual(JSON.parse(readFileSync(new URL(`./fixtures/tree-model/schemas/${role}.json`, import.meta.url))), OUTPUT_SCHEMAS[role]);
});
test('C07 node/summary format versions and unique parameter overrides are validated', () => {
  const output = { ...minimal.verification, formatFixes: [{ target: 'name', id: 'n1', version: 1, fixed: '合成节点名', reason: '修正名称', sourceIds: ['s1'] }] }, e = envelope('verification');
  assert.throws(() => validateOutput('verification', output, e), { code: 'OUTPUT_VERSION' });
  e.allowedIds.nodeVersions = [{ id: 'n1', version: 1 }]; validateOutput('verification', output, e);
  output.formatFixes[0].version = 2; assert.throws(() => validateOutput('verification', output, e), { code: 'OUTPUT_VERSION' });
  const improvement = structuredClone(full.improvement); improvement.parameters.push(improvement.parameters[0]);
  assert.throws(() => validateOutput('improvement', improvement, envelope('improvement')), { code: 'OUTPUT_PARAMETER_DUPLICATE' });
});
test('C02/C04/C10 closed fields, enums and arrays reject authority, budgets and malformed output', () => {
  for (const key of ['actor', 'permission', 'budget', 'createdAt']) assert.throws(() => validateOutput('learning', { ...minimal.learning, [key]: 'forged' }, envelope('learning')), { code: 'INVALID_OUTPUT' });
  assert.throws(() => validateOutput('attribution', { actions: [{ action: 'switch', nodeId: 'n1', name: '' }], statusChanges: [] }, envelope('attribution')), { code: 'INVALID_OUTPUT' });
  assert.throws(() => validateOutput('learning', { ...minimal.learning, understandings: Array(21).fill(understanding) }, envelope('learning')), { code: 'INVALID_OUTPUT' });
  assert.throws(() => validateOutput('learning', { ...minimal.learning, understandings: [{ ...understanding, source: 'sure' }] }, envelope('learning')), { code: 'INVALID_OUTPUT' });
});
test('C03/C07 every reference and target version must be in the frozen input', () => {
  assert.throws(() => validateOutput('attribution', { actions: [{ action: 'switch', nodeId: 'private-sibling' }], statusChanges: [] }, envelope('attribution')), { code: 'OUTPUT_REFERENCE' });
  assert.throws(() => validateOutput('learning', { ...minimal.learning, understandings: [{ ...understanding, sourceIds: ['invented-file-path'] }] }, envelope('learning')), { code: 'OUTPUT_REFERENCE' });
  const output = structuredClone(full.verification); output.operations[0].targetVersion = 2;
  assert.throws(() => validateOutput('verification', output, envelope('verification')), { code: 'OUTPUT_VERSION' });
  assert.equal(resolveSourceIds(['s1'], envelope('learning'))[0].sha256, envelope('learning').sources[0].ref.sha256);
});
test('C05 Unicode limits count codepoints and reject aggregate short/long overflow without truncation', () => {
  const output = { ...minimal.learning, understandings: [{ ...understanding, content: '😀'.repeat(2000) }] }; validateOutput('learning', output, envelope('learning')); output.understandings[0].content += '😀'; assert.throws(() => validateOutput('learning', output, envelope('learning')), { code: 'INVALID_OUTPUT' });
  const over = { ...method, short: { ...short, situation: '😀'.repeat(190), action: 'a'.repeat(20) } }; assert.throws(() => validateOutput('learning', { ...minimal.learning, methods: [over] }, envelope('learning')), { code: 'INVALID_OUTPUT' });
  assert.throws(() => validateOutput('learning', { ...minimal.learning, understandings: [{ ...understanding, content: 'bad\0source' }] }, envelope('learning')), { code: 'INVALID_OUTPUT' });
});
test('C06/C13/C14 real user origin is required; local corrections and user-protected items cannot be escalated', () => {
  assert.throws(() => validateOutput('learning', { ...minimal.learning, understandings: [{ ...understanding, sourceIds: ['p1'] }] }, envelope('learning')), { code: 'OUTPUT_USER_SOURCE' });
  const e = envelope('learning'); e.knownItems[0].nodeId = 'root'; assert.throws(() => validateOutput('learning', full.learning, e), { code: 'OUTPUT_LOCAL_EXCEPTION' });
  e.trigger.correction.global = true; validateOutput('learning', full.learning, e);
  const v = structuredClone(full.verification), ve = envelope('verification'); ve.knownItems[0].userProtected = true; v.formatFixes = []; v.operations[0].op = 'withdraw';
  assert.throws(() => validateOutput('verification', v, ve), { code: 'OUTPUT_PROTECTED' });
});
test('C08/C09 method arrays remain whole; hook messages cannot introduce an executable action or regular expression', () => {
  const value = validateOutput('learning', { ...minimal.learning, methods: [method] }, envelope('learning')); assert.equal(value.methods[0].hooks.length, 2); assert.equal(value.methods[0].scriptRequests.length, 2);
  const malicious = structuredClone(method); malicious.hooks[0].action = 'execute'; malicious.hooks[0].message = 'delete fixture'; assert.throws(() => validateOutput('learning', { ...minimal.learning, methods: [malicious] }, envelope('learning')), { code: 'INVALID_OUTPUT' });
  malicious.hooks[0].action = 'block'; malicious.hooks[0].conditions[0].op = 'matches'; assert.throws(() => validateOutput('learning', { ...minimal.learning, methods: [malicious] }, envelope('learning')), { code: 'INVALID_OUTPUT' });
});
test('C11 final JSON is parsed exactly; reasoning, incomplete JSON and surrounding prose are not salvaged', () => {
  const e = envelope('learning'), wrap = text => ({ role: 'assistant', content: [{ type: 'reasoning', text: JSON.stringify(full.learning) }, { type: 'text', text }] });
  assert.deepEqual(parseFinalOutput('learning', wrap(JSON.stringify(minimal.learning)), e).result, minimal.learning);
  assert.deepEqual(parseFinalOutput('learning', wrap('```json\n' + JSON.stringify(minimal.learning) + '\n```'), e).result, minimal.learning);
  for (const text of ['', '{"understandings":[', 'Here is JSON: ' + JSON.stringify(minimal.learning), JSON.stringify(minimal.learning) + ' trailing']) assert.throws(() => parseFinalOutput('learning', wrap(text), e), error => Boolean(error.rawHash && error.validationErrors));
});
test('threshold summaries and absent opportunities do not manufacture completed work or success', () => {
  const e = envelope('consolidation'); e.trigger.reason = 'threshold'; assert.throws(() => validateOutput('consolidation', full.consolidation, e), { code: 'OUTPUT_THRESHOLD' }); validateOutput('consolidation', minimal.consolidation, e);
  const v = structuredClone(full.verification); v.verifications[0].opportunityCount = 0; assert.throws(() => validateOutput('verification', v, envelope('verification')), { code: 'OUTPUT_OPPORTUNITY' }); v.verifications[0].result = 'unclear'; validateOutput('verification', v, envelope('verification'));
});
test('method evaluation cannot silently reclassify an understanding', () => {
  const value = structuredClone(full.verification); value.verifications[0].methodId = 'i1';
  assert.throws(() => validateOutput('verification', value, envelope('verification')), { code: 'OUTPUT_METHOD_KIND' });
});
test('verification requires a repair for an own failed method and still enforces protected lifecycle', () => {
  const input = envelope('verification'); input.reviewNodeIds = ['n1'];
  const understandingItem = input.knownItems.find(i => i.id === 'i1'); understandingItem.userProtected = true;
  const binding = outputBindings(input), methodItem = input.knownItems.find(i => i.kind === 'method');
  assert.deepEqual(binding.repairRequiredWhenNotMet, [methodItem.id]);
  assert.deepEqual(binding.protectedItems[0].operationChoices, ['support']);
  const failed = structuredClone(minimal.verification);
  failed.verifications = [{ methodId: methodItem.id, methodVersion: methodItem.version, result: 'not_met', observed: 'actual failure', opportunityCount: 1, evidence: ['s1'] }];
  const message = value => ({ role: 'assistant', content: [{ type: 'text', text: JSON.stringify(value) }] });
  assert.throws(() => validateOutput('verification', failed, input), { code: 'REPAIR_REQUIRED' });
  const salvaged = parseFinalOutput('verification', message(failed), input);
  assert.deepEqual(salvaged.rejectedItems.map(r => r.code), ['REPAIR_REQUIRED']); assert.deepEqual(salvaged.result.verifications, []);
  failed.operations = [{ op: 'rewrite', targetId: methodItem.id, targetVersion: methodItem.version, stage: 'generate', reason: 'correct the demonstrated failure', evidence: ['s1'], detail: { replacement: method } }];
  validateOutput('verification', failed, input);
  for (const op of ['mark_changed', 'mark_invalid', 'withdraw']) {
    const forbidden = structuredClone(minimal.verification);
    forbidden.operations = [{ op, targetId: understandingItem.id, targetVersion: understandingItem.version, stage: 'use', reason: 'status-only is still a mutation', evidence: ['s1'], detail: {} }];
    assert.throws(() => validateOutput('verification', forbidden, input), { code: 'OUTPUT_PROTECTED' });
    const partial = parseFinalOutput('verification', message(forbidden), input);
    assert.equal(partial.rejectedItems[0].code, 'OUTPUT_PROTECTED'); assert.deepEqual(partial.result.operations, []);
  }
  methodItem.userProtected = true;
  assert.ok(!outputBindings(input).repairRequiredWhenNotMet.includes(methodItem.id));
  failed.operations = []; validateOutput('verification', failed, input);
  methodItem.userProtected = false; input.reviewNodeIds = [];
  assert.ok(!outputBindings(input).repairRequiredWhenNotMet.includes(methodItem.id));
  validateOutput('verification', failed, input);
});
// 053: completing or leaving a goal may look back; a threshold summary may not.
test('consolidation on completing or leaving a goal permits retrospective learning; a threshold summary does not', () => {
  const input = envelope('consolidation');
  for (const reason of ['leave_timeout', 'node_leave', 'node_complete']) { input.trigger.reason = reason; assert.deepEqual(validateOutput('consolidation', full.consolidation, input), full.consolidation); }
  const summaryAndPromotion = { ...full.consolidation, retrospect: { understandings: [], methods: [] } };
  input.trigger.reason = 'leave_timeout'; assert.deepEqual(validateOutput('consolidation', summaryAndPromotion, input), summaryAndPromotion);
  input.trigger.reason = 'threshold'; assert.throws(() => validateOutput('consolidation', { ...full.consolidation, broaden: [] }, input), { code: 'OUTPUT_THRESHOLD' });
});
test('improvement cannot replace user parameters, modify checkers, or claim universal fixes without reports', () => {
  const e = envelope('improvement'); e.trigger.explicitParameters = [{ name: 'retentionDays', scopeNodeId: 'n1' }]; assert.throws(() => validateOutput('improvement', full.improvement, e), { code: 'OUTPUT_PROTECTED' });
  e.trigger.explicitParameters = []; e.trigger.producerRole = 'verification'; assert.throws(() => validateOutput('improvement', full.improvement, e), { code: 'OUTPUT_CHECKER' });
  const v = { ...full.improvement, kind: 'universal' }; assert.throws(() => validateOutput('improvement', v, envelope('improvement')), { code: 'OUTPUT_REPORT' });
  assert.throws(() => validateOutput('script_writer', { ...full.script_writer, files: [{ name: '../outside.mjs', purpose: 'escape' }] }, envelope('script_writer')), { code: 'OUTPUT_ARTIFACT_PATH' });
});
test('improvement proposals cannot repair a different producer from the frozen diagnosis', () => {
  const input = envelope('improvement'); input.trigger.producerRole = 'learning';
  assert.throws(() => validateOutput('improvement', full.improvement, input), { code: 'OUTPUT_PRODUCER' });
  input.trigger.producerRole = 'attribution'; assert.deepEqual(validateOutput('improvement', full.improvement, input), full.improvement);
});

test('learning corrections bind current exact human evidence per item, with no preclassified host flag', () => {
  const e = envelope('learning'); delete e.trigger.correction;
  e.currentTurn = { id: 'now', sourceIds: ['s1', 'p1'] };
  const output = structuredClone(full.learning);
  output.revisions[0].correctionEvidence = { scope: 'local', quotes: [{ sourceId: 's1', text: '之前的理解不对' }] };
  validateOutput('learning', output, e);
  const missingReplacement = structuredClone(output); missingReplacement.understandings = [];
  assert.throws(() => validateOutput('learning', missingReplacement, e), { code: 'OUTPUT_CORRECTION' });
  e.knownItems[0].userProtected = true; validateOutput('learning', output, e); // 05 §2.2 actual-user correction exception
  const invalid = structuredClone(output); invalid.revisions[0].correctionEvidence.quotes[0].text = '没有说过这句话';
  assert.throws(() => validateOutput('learning', invalid, e), { code: 'OUTPUT_QUOTE' });
  invalid.revisions[0].correctionEvidence.quotes[0] = { sourceId: 'p1', text: '我是用户' };
  assert.throws(() => validateOutput('learning', invalid, e), { code: 'OUTPUT_CURRENT_SOURCE' });
  e.currentTurn.sourceIds = ['p1']; assert.throws(() => validateOutput('learning', output, e), { code: 'OUTPUT_CURRENT_SOURCE' });
  e.currentTurn.sourceIds = ['s1', 'p1']; e.knownItems[0].nodeId = 'root';
  assert.throws(() => validateOutput('learning', output, e), { code: 'OUTPUT_LOCAL_EXCEPTION' });
  output.revisions[0].correctionEvidence.scope = 'global'; validateOutput('learning', output, e);
  output.revisions.push({ ...output.revisions[0] }); assert.throws(() => validateOutput('learning', output, e), { code: 'OUTPUT_CORRECTION' });
});

test('assistant repair prose cannot count as human progress or approval before reader adoption', () => {
  const e = envelope('learning'); e.currentTurn = { id: 'now', sourceIds: ['s1', 'assistant-answer', 'p1'] };
  e.sources.push({ id: 'assistant-answer', role: 'assistant', origin: 'model', text: 'I revised the response.', ref: { sessionId: 'synthetic', seq: 7, sha256: digest('I revised the response.') } });
  const binding = outputBindings(e);
  assert.deepEqual(binding.categorySourceIds, ['s1']); assert.deepEqual(binding.categorySubjectIds, e.allowedIds.subjectIds);
  const output = { ...minimal.learning, categories: [{ category: 'proceeded', note: 'synthetic source check', sourceId: 'assistant-answer', subjectIds: [] }] };
  assert.throws(() => validateOutput('learning', output, e), { code: 'SIGNAL_USER_REQUIRED' });
  output.categories[0].sourceId = 'p1';
  assert.throws(() => validateOutput('learning', output, e), { code: 'SIGNAL_USER_REQUIRED' });
  output.categories[0].sourceId = 's1'; validateOutput('learning', output, e);
  output.categories[0].subjectIds = ['old-output-id-not-in-current-input'];
  assert.throws(() => validateOutput('learning', output, e), { code: 'OUTPUT_REFERENCE' });
});

test('confirming an existing user expression cannot be counted as confirming an assistant inference', () => {
  const input = envelope('learning'); input.allowedIds.subjectIds.push('i1');
  const output = { ...minimal.learning, categories: [{ category: 'confirmed_inference', note: 'synthetic confirmation', sourceId: 's1', subjectIds: ['i1'] }] };
  validateOutput('learning', output, input);
  for (const source of ['user_expressed', 'unknown']) {
    input.knownItems.find(i => i.id === 'i1').sourceKind = source;
    assert.throws(() => validateOutput('learning', output, input), { code: 'OUTPUT_INFERENCE_SUBJECT' });
  }
});

test('reader validation rejects production review conflicts before reporting acceptance', () => {
  const input = envelope('verification'), message = result => ({ role: 'assistant', content: [{ type: 'text', text: JSON.stringify(result) }] });
  const output = structuredClone(full.verification);
  output.operations.push({ ...output.operations[0], op: 'rewrite', detail: { replacement: understanding } });
  assert.throws(() => validateOutput('verification', output, input), { code: 'DUPLICATE_REVIEW' });
  assert.ok(parseFinalOutput('verification', message(output), input).rejectedItems.some(item => item.code === 'DUPLICATE_REVIEW'));
  output.operations.pop(); output.formatFixes[0].id = 'i1';
  assert.throws(() => validateOutput('verification', output, input), { code: 'DUPLICATE_REVIEW' });
  output.formatFixes[0].id = 'i2'; output.proposals.methods[0].origin = 'routine';
  assert.throws(() => validateOutput('verification', output, input), { code: 'ROUTINE_LIMIT' });
  output.proposals.methods[0].origin = 'cluster:c1'; output.clusters[0].verdict = 'none';
  assert.throws(() => validateOutput('verification', output, input), { code: 'CLUSTER_PROPOSAL' });
  output.clusters[0].verdict = 'common'; validateOutput('verification', output, input);
  input.exposures = [];
  assert.throws(() => validateOutput('verification', output, input), { code: 'METHOD_NOT_EXPOSED' });
});

test('checker diagnostics cannot change parameters even when they contain no supplements', () => {
  const input = envelope('improvement'); input.trigger.producerRole = 'verification';
  assert.deepEqual(outputBindings(input).fixedFields, { supplements: [], parameters: [] });
  const output = { ...full.improvement, supplements: [] };
  assert.throws(() => validateOutput('improvement', output, input), { code: 'OUTPUT_CHECKER' });
  assert.deepEqual(validateOutput('improvement', minimal.improvement, input), minimal.improvement);
});

test('checker no-change diagnosis is allowed for similar material but cannot carry actions or a personal change', () => {
  for (const producerRole of ['verification', 'improvement']) {
    const input = envelope('improvement'); input.trigger.producerRole = producerRole;
    const none = { ...minimal.improvement, same: true, diagnosis: '相似材料，未证明共同故障；不作修改' };
    assert.deepEqual(validateOutput('improvement', none, input), none);
    assert.throws(() => validateOutput('improvement', { ...none, kind: 'personal' }, input), { code: 'OUTPUT_CHECKER' });
    assert.throws(() => validateOutput('improvement', { ...none, kind: 'universal' }, input), { code: 'OUTPUT_REPORT' });
    assert.throws(() => validateOutput('improvement', { ...none, parameters: full.improvement.parameters }, input), { code: 'OUTPUT_DIAGNOSIS' });
  }
});

test('learning observations reject fabricated, stale, program and foreign-scope evidence before mutation', () => {
  const e = envelope('learning'); e.currentTurn = { id: 'now', sourceIds: ['s1', 'p1'] };
  e.observationContext = { proposals: [{ id: 'suggestion', nodeIds: ['n1'], turnId: 'before' }], fragments: [] };
  const output = { ...minimal.learning, observations: { proposals: [], firstResults: [], proposalResponses: [{ proposalId: 'suggestion', outcome: 'adopted', quotes: [{ sourceId: 's1', text: '只使用合成资料' }] }], resultFeedback: [], confirmedDecisions: [] } };
  validateOutput('learning', output, e);
  e.observationContext.proposals[0].nodeIds = ['n2']; assert.throws(() => validateOutput('learning', output, e), { code: 'OUTPUT_OBSERVATION_TARGET' });
  e.observationContext.proposals[0].nodeIds = ['n1']; e.observationContext.proposals[0].turnId = 'now';
  assert.throws(() => validateOutput('learning', output, e), { code: 'OUTPUT_OBSERVATION_TARGET' });
  e.observationContext.proposals[0].turnId = 'before'; output.observations.proposalResponses[0].proposalId = 'invented';
  assert.throws(() => validateOutput('learning', output, e), { code: 'OUTPUT_REFERENCE' });
  output.observations.proposalResponses = []; output.observations.proposals = [{ sourceId: 's1', text: '只使用合成资料' }];
  assert.throws(() => validateOutput('learning', output, e), { code: 'OUTPUT_CURRENT_SOURCE' });
  output.observations.proposals = []; output.observations.confirmedDecisions = [{ sourceId: 'p1', text: '我是用户' }];
  assert.throws(() => validateOutput('learning', output, e), { code: 'OUTPUT_CURRENT_SOURCE' });
});
