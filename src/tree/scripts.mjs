import { constants, closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson, digest, fail, shape, integer, jsonClone } from './contracts.mjs';
import { contentHash, processPolicy, confinedArgv, spawnConfined } from './host-process.mjs';
import { relativeFile } from './snapshots.mjs';
import { ItemService } from './items.mjs';

const program = { kind: 'program', id: 'tree-script-broker' };
export const SCRIPT_LIMITS = Object.freeze({ files: 16, bytes: 262144, args: 65536, timeoutMs: 30000, maximumTimeoutMs: 120000 });
export const ARG_SCHEMA_FIELDS = Object.freeze({ object: ['type', 'properties', 'required', 'additionalProperties'], array: ['type', 'items', 'maxItems'], string: ['type', 'maxLength', 'enum'], boolean: ['type'], integer: ['type', 'minimum', 'maximum'], number: ['type', 'minimum', 'maximum'] });
export const ARG_SCHEMA_GUIDANCE = `argSchema is a bounded subset, not arbitrary JSON Schema. Allowed keys by type: ${canonicalJson(ARG_SCHEMA_FIELDS)}. Every object requires properties (at most32 keys), required:[], and additionalProperties:false. Each string REQUIRES integer maxLength0..65536; optional enum has at most256 strings. Do NOT add minLength, pattern, default, description, $schema or $ref. Arrays require maxItems0..256 and items. Numbers/integers require finite minimum and maximum. Boolean has only type. Nesting at most6. Example: {"type":"object","properties":{"source":{"type":"string","maxLength":512},"destination":{"type":"string","maxLength":512}},"required":["source","destination"],"additionalProperties":false}. All successful probe.args must validate against the final schema; do not retroactively require untested fields.`;
export function scriptPath(path) { relativeFile(path); if (!path.endsWith('.mjs')) fail('SCRIPT_LANGUAGE', 'Only Node ESM .mjs files are supported'); return path; }

/** A closed, bounded JSON-schema subset; no references, coercion or regex. */
export function validateArgSchema(schema, depth = 0) {
  if (depth > 6 || !schema || typeof schema !== 'object' || Array.isArray(schema)) fail('ARG_SCHEMA', 'Bounded argument schema required');
  const allowed = ARG_SCHEMA_FIELDS[schema.type];
  if (!allowed || Object.keys(schema).some(k => !allowed.includes(k))) fail('ARG_SCHEMA', `Unsupported ${schema.type} argument schema keys; allowed: ${(allowed ?? []).join(', ')}. ${ARG_SCHEMA_GUIDANCE}`);
  if (schema.type === 'object') {
    if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties) || Object.keys(schema.properties).length > 32 || schema.additionalProperties !== false || !Array.isArray(schema.required) || schema.required.some(k => !Object.hasOwn(schema.properties, k))) fail('ARG_SCHEMA', 'Closed object properties and required fields must be explicit');
    for (const [key, value] of Object.entries(schema.properties)) { if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('ARG_SCHEMA', 'Unsafe property'); validateArgSchema(value, depth + 1); }
  } else if (schema.type === 'array') { integer(schema.maxItems, 'maxItems', 0, 256); validateArgSchema(schema.items, depth + 1); }
  else if (schema.type === 'string') { if (!Number.isInteger(schema.maxLength) || schema.maxLength < 0 || schema.maxLength > 65536) fail('ARG_SCHEMA', 'Every string requires integer maxLength between 0 and 65536; minLength is not supported.'); if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length > 256 || schema.enum.some(v => typeof v !== 'string' || [...v].length > schema.maxLength))) fail('ARG_SCHEMA', 'Invalid string enumeration'); }
  else if (['integer', 'number'].includes(schema.type)) { if (!Number.isFinite(schema.minimum) || !Number.isFinite(schema.maximum) || schema.minimum > schema.maximum) fail('ARG_SCHEMA', 'Finite numeric bounds required'); }
  return schema;
}
export function normalizeArgs(schema, args) {
  validateArgSchema(schema); const bytes = canonicalJson(args); if (Buffer.byteLength(bytes) > SCRIPT_LIMITS.args) fail('ARGS_INVALID', 'Arguments exceed 64 KiB');
  const check = (s, value) => {
    if (s.type === 'object') { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !Object.hasOwn(s.properties, k)) || s.required.some(k => !Object.hasOwn(value, k))) fail('ARGS_INVALID', 'Unexpected or missing argument'); for (const [k, v] of Object.entries(value)) check(s.properties[k], v); }
    else if (s.type === 'array') { if (!Array.isArray(value) || value.length > s.maxItems) fail('ARGS_INVALID', 'Invalid bounded array'); value.forEach(v => check(s.items, v)); }
    else if (s.type === 'string') { if (typeof value !== 'string' || [...value].length > s.maxLength || s.enum && !s.enum.includes(value)) fail('ARGS_INVALID', 'Invalid bounded string'); }
    else if (s.type === 'boolean') { if (typeof value !== 'boolean') fail('ARGS_INVALID', 'Boolean required'); }
    else if (!Number.isFinite(value) || s.type === 'integer' && !Number.isSafeInteger(value) || value < s.minimum || value > s.maximum) fail('ARGS_INVALID', 'Number outside declared bounds');
  };
  check(schema, args); return JSON.parse(bytes);
}

/** Private content-addressed bytes; no model-selected host path is persisted. */
export class ScriptArtifacts {
  constructor({ repository, directory, resolveSource, assertBuild }) { this.repo = repository; mkdirSync(directory, { recursive: true, mode: 0o700 }); this.directory = realpathSync(directory); this.resolveSource = resolveSource;
    this.assertBuild = assertBuild ?? ((id, artifact) => { const job = this.repo.get('tree_jobs', id); return job?.role === 'script_writer' && job.status === 'committed' && job.resultRef?.artifactId === artifact.id && job.resultRef?.filesHash === digest(artifact.files); }); }
  sourcePath(hash) { if (!/^[a-f0-9]{64}$/.test(hash)) fail('ARTIFACT_HASH', 'Invalid content identity'); return join(this.directory, hash + '.mjs'); }
  put(content) {
    if (typeof content !== 'string' || content.includes('\0') || Buffer.from(content).toString('utf8') !== content || Buffer.byteLength(content) > SCRIPT_LIMITS.bytes) fail('ARTIFACT_CONTENT', 'Bounded UTF-8 source text required');
    const sha256 = contentHash(content), path = this.sourcePath(sha256);
    try { writeFileSync(path, content, { flag: 'wx', mode: 0o400 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    this.read({ sha256, size: Buffer.byteLength(content) }); return { sha256, size: Buffer.byteLength(content) };
  }
  read(file) {
    const path = this.sourcePath(file.sha256), fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const stat = fstatSync(fd); if (!stat.isFile() || stat.nlink !== 1 || stat.size > SCRIPT_LIMITS.bytes || stat.size !== file.size) fail('ARTIFACT_HASH', 'Artifact file identity changed'); const bytes = readFileSync(fd); if (contentHash(bytes) !== file.sha256) fail('ARTIFACT_HASH', 'Artifact bytes changed'); return bytes; }
    finally { closeSync(fd); }
  }
  verify(artifact) {
    if (artifact?.language !== 'node-esm' || !Array.isArray(artifact.files) || !artifact.files.length || artifact.files.length > SCRIPT_LIMITS.files) fail('ARTIFACT_INVALID', 'Bounded Node artifact required');
    const names = new Set(); let bytes = 0;
    for (const file of artifact.files) { scriptPath(file.path); if (names.has(file.path)) fail('ARTIFACT_INVALID', 'Duplicate artifact path'); names.add(file.path); bytes += this.read(file).length; }
    if (bytes > SCRIPT_LIMITS.bytes || !names.has(artifact.entry)) fail('ARTIFACT_INVALID', 'Entry or size invalid'); validateArgSchema(artifact.argSchema);
    return { id: artifact.id, revision: artifact.revision, filesHash: digest(artifact.files) };
  }
  activate({ methodId, draftVersion, artifactIds, requestId }) {
    const item = this.repo.get('tree_items', methodId), bundle = this.repo.get('tree_methods', digest(['method', methodId, draftVersion]));
    if (!item || !bundle) fail('METHOD_MISSING', 'Draft method missing');
    const artifacts = artifactIds.map(id => this.repo.get('tree_script_artifacts', id));
    if (artifacts.some(a => !a || this.assertBuild(a.buildRunId, a) !== true)) fail('ARTIFACT_BUILD_REQUIRED', 'The exact native writer job must commit its final result before activation');
    if (new Set(artifacts.map(a => a?.requestIndex)).size !== bundle.pendingScriptRequests.length || artifacts.some(a => a?.requestIndex < 0 || a?.requestIndex >= bundle.pendingScriptRequests.length || a?.draftVersion !== draftVersion)) fail('BUNDLE_INCOMPLETE', 'Each requested script must have its own completed artifact');
    const verifiedArtifacts = artifacts.map(a => this.verify(a)), service = new ItemService({ repository: this.repo, resolveSource: this.resolveSource, context: () => ({ actor: program, verifiedArtifacts }) });
    const version = this.repo.get('tree_item_versions', digest(['item_version', methodId, draftVersion]));
    if (!version || version.sourceRefs.some(ref => !this.resolveSource(ref))) fail('SOURCE_STALE', 'Draft evidence was withdrawn');
    return service.activateDraft({ requestId, expected: { ['tree_items:' + methodId]: item.revision }, input: { itemId: methodId, version: draftVersion, artifactIds } });
  }
}

// Module resolution is a dependency rule, not an OS security boundary. The
// deny-by-default process policy remains authoritative even for eval or native
// builtin access. Normal imports can use only fixed Node builtins or this bundle.
function loaderSource(urls) {
  return `import { registerHooks, isBuiltin } from 'node:module';\nimport { pathToFileURL } from 'node:url';\nconst allowed = new Set(${JSON.stringify(urls)});\nregisterHooks({ resolve(specifier, context, next) { if (!isBuiltin(specifier)) { let url; if (specifier.startsWith('/')) url = pathToFileURL(specifier).href; else if (specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('file:')) url = new URL(specifier, context.parentURL).href; if (!allowed.has(url)) throw new Error('SCRIPT_DEPENDENCY_DENIED'); } const result = next(specifier, context); if (!isBuiltin(result.url) && !allowed.has(result.url)) throw new Error('SCRIPT_DEPENDENCY_DENIED'); return result; }, load(url, context, next) { if (!isBuiltin(url) && !allowed.has(url)) throw new Error('SCRIPT_DEPENDENCY_DENIED'); return next(url, context); } });\n`;
}

/** Only this owned execution path copies artifact bytes across the private fence. */
export class ConfinedScriptRunner {
  enforcement = 'full';
  async run({ artifact, args, artifacts, policy, readPaths, readOnly = false, timeoutMs = SCRIPT_LIMITS.timeoutMs, signal, assertCurrent, beforeSpawn = () => {} }) {
    if (!Array.isArray(readPaths)) fail('SCRIPT_READ_SCOPE', 'An inspected ordinary-file read set is required');
    const reads = [...new Set(readPaths.map(p => join(policy.workspace, relativeFile(p))))];
    artifacts.verify(artifact); const root = mkdtempSync(join(policy.runtimeRoot, 'method-'));
    try {
      const urls = [];
      for (const file of artifact.files) { const target = join(root, file.path); mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); writeFileSync(target, artifacts.read(file), { flag: 'wx', mode: 0o400 }); urls.push(pathToFileURL(target).href); }
      const loader = join(root, '.arcfold-loader.mjs'), input = join(root, '.arcfold-input.json');
      writeFileSync(loader, loaderSource(urls), { flag: 'wx', mode: 0o400 }); writeFileSync(input, canonicalJson(args), { flag: 'wx', mode: 0o400 });
      const effective = { ...policy, writeRoots: readOnly ? [] : policy.writeRoots, immutableRoots: [...policy.immutableRoots, ...artifact.files.map(f => join(root, f.path)), loader, input] };
      // Do not grant the entire workspace: credentials, private state, excluded
      // directories, later-created files and uninspected links stay unreadable.
      const wrapped = confinedArgv({ policy: { ...effective, workspace: root }, runDirectory: root, argv: [process.execPath, '--max-old-space-size=256', '--import', loader, join(root, artifact.entry), '--input', input, ...(readOnly ? ['--dry-run'] : [])] });
      const exclusions = [...policy.protectedRoots, policy.runtimeRoot].map(p => `(require-not (subpath ${JSON.stringify(p)}))`).join(' ');
      // Reading the root directory itself is needed by macOS getcwd; a literal
      // directory grant does not authorize reading its descendant file bytes.
      wrapped.argv[2] += '\n(allow file-read* ' + [policy.workspace, ...reads].map(p => `(require-all (literal ${JSON.stringify(p)}) ${exclusions})`).join(' ') + ')';
      const profileHash = digest(wrapped.argv[2]), profileFile = join(root, '.arcfold-policy.sb');
      writeFileSync(profileFile, wrapped.argv[2], { flag: 'wx', mode: 0o400 }); wrapped.argv[1] = '-f'; wrapped.argv[2] = profileFile;
      signal?.throwIfAborted(); await assertCurrent(); signal?.throwIfAborted(); await beforeSpawn({ profileHash, readPaths, argvHash: digest(wrapped.argv) });
      return await spawnConfined(wrapped, { cwd: policy.workspace, runDirectory: root, signal, timeoutMs: readOnly ? Math.min(timeoutMs, 10000) : timeoutMs, outputLimit: readOnly ? 65536 : 1048576, assertCurrent });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
}

export class MethodScriptBroker {
  constructor({ repository, artifacts, snapshots, context, readScope, resolveSource, authorizeWrites, runtimeRoot, protectedRoots, runner = new ConfinedScriptRunner(), allowUnconfinedFixture = false }) {
    if ([context, readScope, resolveSource, authorizeWrites].some(f => typeof f !== 'function')) fail('SCRIPT_HOST', 'Trusted authority, scope, sources and write authorization are required');
    Object.assign(this, { repo: repository, artifacts, snapshots, context, readScope, resolveSource, authorizeWrites, runtimeRoot, protectedRoots, runner });
    if (runner.enforcement !== 'full' && !allowUnconfinedFixture) fail('SANDBOX_UNAVAILABLE', 'Scripts require full process confinement'); this.active = new Map();
  }
  freeze(input) {
    shape(input, ['methodId', 'expectedVersion', 'scriptId', 'args']); const ctx = this.context();
    if (ctx.actor?.kind !== 'model' || ctx.actor.role !== 'main' || !ctx.sessionId || !ctx.nativeToolCallId) fail('MAIN_REQUIRED', 'Only an owned main-agent tool call may execute a method script');
    const scope = this.readScope(ctx.sessionId), item = this.repo.get('tree_items', input.methodId), bundle = this.repo.get('tree_methods', digest(['method', input.methodId, input.expectedVersion]));
    if (!scope || scope.phase !== 'active' || !scope.nodeIds.length) fail('SCOPE_STALE', 'No admitted main scope');
    if (!item || item.kind !== 'method' || item.lifecycle !== 'active' || item.stale || item.activeVersion !== input.expectedVersion || !bundle || bundle.pendingScriptRequests.length) fail('METHOD_STALE', 'Method is not currently executable');
    if (!scope.nodeIds.some(id => this.repo.ancestors(id).some(n => n.id === item.nodeId))) fail('OUT_OF_SCOPE', 'Method is outside current node ancestry');
    const version = this.repo.get('tree_item_versions', digest(['item_version', item.id, item.activeVersion])); if (!version || version.sourceRefs.some(ref => !this.resolveSource(ref))) fail('SOURCE_STALE', 'Method source is no longer eligible');
    const ref = bundle.scripts.find(s => s.id === input.scriptId), artifact = ref && this.repo.list('tree_script_artifacts', a => a.scriptId === ref.id && a.version === ref.version && a.methodId === item.id)[0];
    if (!artifact || artifact.activationState !== 'ready' || digest(artifact.files) !== ref.hash) fail('ARTIFACT_STALE', 'No active artifact version'); this.artifacts.verify(artifact);
    const args = normalizeArgs(artifact.argSchema, input.args), authorization = this.authorizeWrites({ context: ctx, scope, item, artifact, args });
    if (!authorization || authorization.then || !Array.isArray(authorization.paths) || !authorization.authorizationRef) fail('SCRIPT_AUTHORIZATION', 'Synchronous host write authorization required');
    const paths = [...new Set(authorization.paths.map(relativeFile))].sort();
    const policy = processPolicy({ workspace: this.snapshots.workspace, runtimeRoot: this.runtimeRoot, protectedRoots: [...this.protectedRoots, this.artifacts.directory, this.snapshots.storageRoot], sessionPolicy: ctx.sessionPolicy, authorizedWriteRoots: paths.map(p => join(this.snapshots.workspace, p)) });
    // Read-only calls may inspect data but cannot acquire any declared writes.
    if (paths.length && !policy.writeRoots.length) fail('SCRIPT_POLICY', 'Current session does not authorize these writes');
    const ticket = { sessionId: ctx.sessionId, nativeToolCallId: ctx.nativeToolCallId, actor: ctx.actor, scope, itemId: item.id, methodVersion: item.activeVersion, itemRevision: item.revision, artifactId: artifact.id, artifactRevision: artifact.revision, filesHash: digest(artifact.files), argsHash: digest(args), authorization, policyHash: digest(policy), workspaceIdentity: this.snapshots.identity };
    return { ticket: jsonClone({ ...ticket, key: digest(ticket) }), artifact, args, paths, policy };
  }
  assertCurrent(frozen, input) { this.snapshots.assertIdentity(); if (this.freeze(input).ticket.key !== frozen.ticket.key) fail('SCRIPT_STALE', 'Execution authority changed'); }
  update(id, updates) {
    const old = this.repo.get('tree_script_runs', id); if (!old) fail('SCRIPT_RUN', 'Missing durable run intent');
    this.repo.command('recordTreeScriptResult', { requestId: digest([id, old.revision, updates]), expected: {}, input: { id, ...updates } }, program, () => {
      const row = this.repo.get('tree_script_runs', id); if (row.revision !== old.revision) fail('REVISION_CONFLICT', 'Script result changed');
      this.repo.save('tree_script_runs', { ...row, ...updates, ...(row.state === 'revoked' ? { state: 'revoked' } : {}) }, row.revision); return { runId: id };
    }); return this.repo.get('tree_script_runs', id);
  }
  invalidate() { for (const run of this.active.values()) { try { this.assertCurrent(run.frozen, run.input); } catch { run.abort.abort(); } } }
  cancelSession(sessionId) { for (const run of this.active.values()) if (run.frozen.ticket.sessionId === sessionId) run.abort.abort(); }
  async run(input, { signal } = {}) {
    input = jsonClone(input); const frozen = this.freeze(input), id = digest(['script-run', frozen.ticket.sessionId, frozen.ticket.nativeToolCallId]);
    if (this.active.has(id)) fail('SCRIPT_ACTIVE', 'This native tool call is already executing');
    const previous = this.repo.get('tree_script_runs', id);
    if (previous) { if (previous.inputHash !== digest(input)) fail('IDEMPOTENCY_CONFLICT', 'Native tool call changed'); return previous; }
    const abort = new AbortController(), combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal; this.active.set(id, { abort, frozen, input });
    // Native withdrawal/scope events call invalidate immediately. This bounded
    // watcher also catches changes committed by another session/process.
    const watcher = setInterval(() => this.invalidate(), 25); watcher.unref();
    try {
      return await this.snapshots.locked(async () => {
        combined.throwIfAborted(); this.snapshots.assertAvailable(); this.assertCurrent(frozen, input);
        const snapshot = await this.snapshots.captureLocked({ requestId: id, reason: 'script', protectedPaths: frozen.paths, signal: combined });
        combined.throwIfAborted(); this.assertCurrent(frozen, input);
        this.repo.command('prepareTreeScript', { requestId: id, expected: {}, input: { input, ticket: frozen.ticket, snapshotId: snapshot.id } }, program, () => {
          this.repo.save('tree_script_runs', { id, runId: id, methodVersion: { itemId: input.methodId, version: input.expectedVersion }, nodeEpoch: frozen.ticket.scope.epoch, workspaceIdentity: frozen.ticket.workspaceIdentity,
            policyHash: frozen.ticket.policyHash, snapshotId: snapshot.id, argvHash: digest({ interpreter: process.execPath, artifact: frozen.ticket.filesHash, entry: frozen.artifact.entry, args: frozen.args }), inputHash: digest(input), ticket: frozen.ticket, state: 'prepared', processState: 'prepared' }); return { runId: id };
        });
        try {
          const readPaths = [...new Set([...snapshot.manifest.files.map(f => f.path), ...frozen.paths])];
          const result = await this.runner.run({ ...frozen, readPaths, artifacts: this.artifacts, signal: combined, timeoutMs: frozen.artifact.timeoutMs ?? SCRIPT_LIMITS.timeoutMs,
            assertCurrent: () => this.assertCurrent(frozen, input), beforeSpawn: evidence => this.update(id, { state: 'spawn_intent', processState: 'spawn_intent', executionPolicy: evidence, policyHash: digest({ policy: frozen.policy, ...evidence }) }) });
          return this.update(id, { state: result.code === 0 && !result.reason && !result.truncated ? 'succeeded' : result.reason === 'cancelled' ? 'cancelled' : 'failed', processState: 'completed', result, completedAt: this.repo.now() });
        } catch (error) {
          const current = this.repo.get('tree_script_runs', id), notStarted = current.processState === 'prepared'; return this.update(id, { state: notStarted ? 'failed' : 'unknown', processState: notStarted ? 'not_started' : 'unknown', error: { code: error.code ?? 'SCRIPT_PROCESS', message: error.message }, completedAt: this.repo.now() });
        }
      });
    } finally { clearInterval(watcher); this.active.delete(id); }
  }
  recover(id) {
    if (this.active.has(id)) fail('SCRIPT_ACTIVE', 'Current process still owns this execution'); const run = this.repo.get('tree_script_runs', id);
    if (!run) fail('SCRIPT_RUN', 'Unknown execution');
    // A completed process receipt is written in the same command as its result.
    // Without it, preserve uncertainty; never run the generated program again.
    const pending = ['prepared', 'spawn_intent'].includes(run.processState ?? run.state);
    return pending ? this.update(id, { state: (run.processState ?? run.state) === 'prepared' ? 'failed' : 'unknown', processState: (run.processState ?? run.state) === 'prepared' ? 'not_started' : 'unknown', error: { code: 'HOST_INTERRUPTED', message: 'No durable completed process result' } }) : run;
  }
}

/** Public tool surface; bind only to B7's admitted main-agent instance. */
export function mountMethodScriptTool(agentContext, { host, defineTool, isMain, resolveBroker }) {
  if ([defineTool, isMain, resolveBroker].some(fn => typeof fn !== 'function')) fail('SCRIPT_HOST', 'Native tool registration requires trusted main ownership');
  agentContext.tools.register(defineTool({ name: 'arcfold_run_method_script', description: 'Execute one active method script in the current goal scope. The host checks its exact version, current file permissions and snapshot coverage. This does not grant new permissions.',
    parameters: { methodId: { type: 'string', required: true }, expectedVersion: { type: 'integer', required: true }, scriptId: { type: 'string', required: true }, args: { type: 'object', additionalProperties: true, required: true } },
    output: { schema: { type: 'json' }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    async execute(input, exec) {
      const check = () => {
        exec.signal?.throwIfAborted(); const agent = exec.agent;
        if (!agent || host.agents.get(agent.id) !== agent || host.agents.currentInitiator() !== agent || agent.status !== 'running' || isMain(agent.session.id) !== true || exec.parent !== undefined || exec.callId !== exec.rootCallId) fail('MAIN_REQUIRED', 'Only the exact live native main tool call may cross the script boundary');
        return agent;
      };
      const agent = check(); if (await host.sessions.flush(agent.session) !== true) fail('SCRIPT_NATIVE_EVIDENCE', 'The native tool call must be durable before script execution'); check();
      const events = agent.session.snapshotEvents(), call = events.filter(e => e.type === 'tool/call' && e.data.callId === exec.callId);
      const step = events.findLast(e => e.type === 'step/start'), turn = events.findLast(e => e.type === 'turn/start'), assistant = call.length === 1 && events.findLast(e => e.type === 'assistant/message' && e.seq < call[0].seq);
      const block = assistant?.data.message.content?.filter(b => b.type === 'tool-call' && b.id === exec.callId);
      if (call.length !== 1 || !step || !turn || !assistant || assistant.data.message.source?.kind !== 'model' || assistant.data.interrupted || block?.length !== 1 || block[0].name !== 'arcfold_run_method_script' || call[0].data.name !== block[0].name || call[0].data.arguments !== block[0].arguments || canonicalJson(JSON.parse(call[0].data.arguments)) !== canonicalJson(input) || canonicalJson(exec.arguments) !== canonicalJson(input) || step.seq <= turn.seq || assistant.seq <= step.seq || call[0].data.turn !== turn.data.turn || call[0].data.step !== step.data.step || events.some(e => e.seq > step.seq && ['step/end', 'turn/end'].includes(e.type)) || events.some(e => e.seq > call[0].seq && e.type === 'tool/result' && e.data.message?.toolCallId === exec.callId)) fail('SCRIPT_NATIVE_EVIDENCE', 'Script arguments and identity must match one unfinished durable native tool call');
      const broker = resolveBroker({ agent, sessionId: agent.session.id, callId: exec.callId, turn: turn.data.turn, step: step.data.step });
      if (!(broker instanceof MethodScriptBroker)) fail('SCRIPT_HOST', 'No trusted script broker for this main call');
      const run = await broker.run(input, { signal: exec.signal });
      return { runId: run.id, state: run.state, processState: run.processState, snapshotId: run.snapshotId, coverage: broker.snapshots.snapshot(run.snapshotId).coverage, result: run.result ?? null, error: run.error ?? null };
    },
  }));
}
