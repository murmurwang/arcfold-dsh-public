import { canonicalJson, digest, fail, shape, integer, text, jsonClone } from './contracts.mjs';
import { processPolicy } from './host-process.mjs';
import { relativeFile } from './snapshots.mjs';
import { SCRIPT_LIMITS, ARG_SCHEMA_GUIDANCE, scriptPath, validateArgSchema, normalizeArgs, ConfinedScriptRunner } from './scripts.mjs';
import { WRITER_TOOLS } from './jobs.mjs';

const program = { kind: 'program', id: 'tree-script-writer' };
const emptyArgs = { type: 'object', properties: {}, required: [], additionalProperties: false };
const strings = values => { if (!Array.isArray(values) || values.length > 20) fail('WRITER_MANIFEST', 'Bounded verification notes required'); return values.map(v => text(v, 'verification note', 2000)); };

/** One trusted binding per native writer job; models cannot choose its owner. */
export class ScriptWriter {
  constructor({ repository, artifacts, workspaceIO, binding, assertJob, runtimeRoot, protectedRoots, runner = new ConfinedScriptRunner(), allowUnconfinedFixture = false }) {
    Object.assign(this, { repo: repository, artifacts, io: workspaceIO, binding: jsonClone(binding), assertJob, runtimeRoot, protectedRoots, runner });
    if (typeof assertJob !== 'function' || !binding.jobId || !binding.scriptId || !binding.methodId || !Number.isSafeInteger(binding.draftVersion) || !Number.isSafeInteger(binding.requestIndex)) fail('WRITER_BINDING', 'Trusted writer ownership required');
    if ((runner.enforcement !== 'full' || workspaceIO.enforcement !== 'full') && !allowUnconfinedFixture) fail('SANDBOX_UNAVAILABLE', 'Writer I/O and probe require full confinement');
    this.timeoutMs = binding.timeoutMs ?? SCRIPT_LIMITS.timeoutMs; integer(this.timeoutMs, 'timeoutMs', 1, SCRIPT_LIMITS.maximumTimeoutMs);
    this.id = digest(['script-draft', binding.jobId]); this.active = new Set();
    const old = this.draft(); if (old && digest(old.binding) !== digest(this.binding)) fail('WRITER_BINDING', 'Existing job binding differs');
    if (!old) this.change('open', () => ({ binding: this.binding, state: 'open', files: [], probes: [], startedAt: this.repo.now() }));
  }
  draft() { return this.repo.meta().scriptDrafts?.[this.id] ?? null; }
  assertCurrent({ finished = false } = {}) {
    const result = this.assertJob(this.binding.jobId); if (result?.then || result !== true) fail('WRITER_STALE', 'Native writer job is no longer current');
    const item = this.repo.get('tree_items', this.binding.methodId), bundle = this.repo.get('tree_methods', digest(['method', this.binding.methodId, this.binding.draftVersion]));
    if (!item || item.lifecycle !== 'draft' || item.draftVersion !== this.binding.draftVersion || !bundle?.pendingScriptRequests[this.binding.requestIndex]) fail('WRITER_STALE', 'Requested method draft was withdrawn or replaced');
    const version = this.repo.get('tree_item_versions', digest(['item_version', item.id, item.draftVersion]));
    if (!version || version.sourceRefs.some(ref => !this.artifacts.resolveSource(ref))) fail('SOURCE_STALE', 'Writer source is no longer eligible');
    if (!finished && this.draft()?.state !== 'open') fail('WRITER_FINISHED', 'This artifact draft is already finished');
  }
  change(kind, update, expectedRevision) {
    const current = this.draft();
    return this.repo.command('recordTreeWriter', { requestId: digest([this.id, kind, current?.revision ?? 0]), expected: {}, input: { draftId: this.id, kind, revision: current?.revision ?? 0 } }, program, () => {
      const meta = this.repo.meta(), row = meta.scriptDrafts?.[this.id]; if ((row?.revision ?? 0) !== (current?.revision ?? 0)) fail('REVISION_CONFLICT', 'Writer draft changed');
      if (expectedRevision !== undefined && (row?.revision ?? 0) !== expectedRevision) fail('ARTIFACT_CONFLICT', 'Draft changed while artifact bytes were being prepared');
      const next = { ...row, ...update(row), id: this.id, revision: (row?.revision ?? 0) + 1, updatedAt: this.repo.now() };
      this.repo.save('tree_meta', { ...meta, scriptDrafts: { ...meta.scriptDrafts, [this.id]: next } }, meta.revision); return next;
    }).result;
  }
  async scan(copy, signal) { this.assertCurrent(); const result = await this.io.scan({ copy, signal }); this.assertCurrent(); return result; }
  async read(input, options = {}) {
    shape(input, ['relativePath'], ['offset', 'limit']); relativeFile(input.relativePath); const offset = input.offset ?? 0, limit = input.limit ?? 16000;
    integer(offset, 'offset', 0, 20 * 1024 * 1024); integer(limit, 'limit', 1, 16000);
    const { manifest, contents } = await this.scan(true, options.signal), file = manifest.files.find(f => f.path === input.relativePath);
    if (!file) fail('WRITER_READ_DENIED', 'File is absent or outside ordinary workspace content');
    const bytes = contents.get(file.path), value = bytes.toString('utf8'); if (!Buffer.from(value).equals(bytes) || value.includes('\0')) fail('WRITER_BINARY', 'Writer reads UTF-8 text only');
    const chars = [...value]; return { path: file.path, sha256: file.sha256, offset, content: chars.slice(offset, offset + limit).join(''), nextOffset: offset + limit < chars.length ? offset + limit : null };
  }
  async list(input = {}, options = {}) {
    shape(input, [], ['relativePath', 'offset', 'limit']); const root = input.relativePath ?? '', offset = input.offset ?? 0, limit = input.limit ?? 100;
    if (root) relativeFile(root); integer(offset, 'offset', 0, 1000000); integer(limit, 'limit', 1, 200);
    const { manifest } = await this.scan(false, options.signal), files = manifest.files.filter(f => !root || f.path.startsWith(root + '/')).map(f => ({ path: f.path, size: f.size }));
    return { files: files.slice(offset, offset + limit), nextOffset: offset + limit < files.length ? offset + limit : null, coverage: manifest.exclusions.length ? 'partial' : 'full' };
  }
  async search(input, options = {}) {
    shape(input, ['query'], ['relativePath', 'limit']); text(input.query, 'literal query', 512); const root = input.relativePath ?? '', limit = input.limit ?? 20;
    if (root) relativeFile(root); integer(limit, 'limit', 1, 100);
    const { manifest, contents } = await this.scan(true, options.signal), matches = []; let truncated = false;
    for (const file of manifest.files) {
      if (root && file.path !== root && !file.path.startsWith(root + '/')) continue; const bytes = contents.get(file.path), value = bytes.toString('utf8');
      if (value.includes('\0') || !Buffer.from(value).equals(bytes)) continue;
      const lines = value.split('\n'); for (let i = 0; i < lines.length; i++) if (lines[i].includes(input.query)) {
        if (matches.length === limit) { truncated = true; break; } matches.push({ path: file.path, line: i + 1, text: [...lines[i]].slice(0, 120).join('') });
      } if (truncated) break;
    }
    return { matches, truncated, mode: 'literal' };
  }
  put(input) {
    shape(input, ['relativePath', 'content'], ['expectedHash']); this.assertCurrent(); const path = scriptPath(input.relativePath);
    if (path.split('/').some(p => p.startsWith('.arcfold-'))) fail('ARTIFACT_PATH', 'Reserved execution filename');
    const draft = this.draft(), old = draft.files.find(f => f.path === path);
    if (old ? input.expectedHash !== old.sha256 : input.expectedHash !== undefined && input.expectedHash !== null) fail('ARTIFACT_CONFLICT', 'writer_put must compare the exact previous file hash');
    if (typeof input.content !== 'string') fail('ARTIFACT_CONTENT', 'Source text required');
    const files = draft.files.filter(f => f.path !== path), size = Buffer.byteLength(input.content);
    if (files.length + 1 > SCRIPT_LIMITS.files || files.reduce((n, f) => n + f.size, size) > SCRIPT_LIMITS.bytes) fail('ARTIFACT_LIMIT', 'Draft exceeds 16 files or 256 KiB');
    const file = { path, ...this.artifacts.put(input.content) }; files.push(file); files.sort((a, b) => a.path.localeCompare(b.path));
    this.change('put', () => ({ files }), draft.revision); return file;
  }
  artifact(entry, argSchema = emptyArgs) {
    return { id: digest(['script-artifact', this.binding.scriptId, this.binding.scriptVersion ?? 1]), scriptId: this.binding.scriptId, methodId: this.binding.methodId, version: this.binding.scriptVersion ?? 1, language: 'node-esm', entry: scriptPath(entry), files: this.draft().files, argSchema, dryRunSupport: true,
      buildRunId: this.binding.jobId, activationState: 'ready', draftVersion: this.binding.draftVersion, requestIndex: this.binding.requestIndex, timeoutMs: this.timeoutMs };
  }
  cancel() { for (const abort of this.active) abort.abort(); }
  async probe(input, { signal } = {}) {
    shape(input, ['entry', 'args']); this.assertCurrent(); if (Buffer.byteLength(canonicalJson(input.args)) > SCRIPT_LIMITS.args) fail('ARGS_INVALID', 'Probe input exceeds 64 KiB');
    const artifact = this.artifact(input.entry), filesHash = digest(artifact.files), args = jsonClone(input.args), abort = new AbortController(); this.active.add(abort);
    const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
    const check = () => { this.assertCurrent(); if (digest(this.draft().files) !== filesHash) fail('ARTIFACT_CONFLICT', 'Draft changed during probe'); };
    const watcher = setInterval(() => { try { check(); } catch { abort.abort(); } }, 25); watcher.unref();
    const policy = processPolicy({ workspace: this.io.workspace, runtimeRoot: this.runtimeRoot, protectedRoots: [...this.protectedRoots, this.artifacts.directory], sessionPolicy: { mode: 'read-only', workspaceRoot: this.io.workspace } });
    let result;
    try { const scan = await this.scan(false, combined); result = await this.runner.run({ artifact, args, artifacts: this.artifacts, policy, readPaths: scan.manifest.files.map(f => f.path), readOnly: true, timeoutMs: 10000, signal: combined, assertCurrent: check }); }
    catch (error) { result = { code: null, reason: 'probe_error', error: { code: error.code ?? 'PROBE_FAILED', message: error.message } }; }
    finally { clearInterval(watcher); this.active.delete(abort); }
    const probe = { id: digest([this.id, 'probe', this.draft().probes.length]), entry: input.entry, filesHash, args, argsHash: digest(args), result, readOnly: true, enforcement: this.runner.enforcement, at: this.repo.now() };
    // Interrupted/replaced drafts retain the attempt, but can never finish it.
    this.change('probe', row => ({ probes: [...row.probes, probe] })); return probe;
  }
  finish(input) {
    shape(input, ['manifest', 'verified', 'notVerified']); this.assertCurrent({ finished: true });
    if (this.active.size) fail('WRITER_BUSY', 'A running probe must finish before the artifact can be sealed');
    const draft = this.draft(); if (draft.state === 'finished') { if (draft.finishHash !== digest(input)) fail('ARTIFACT_CONFLICT', 'Finished manifest cannot change'); return this.repo.get('tree_script_artifacts', draft.artifactId); }
    shape(input.manifest, ['entry', 'files', 'argSchema', 'dryRunSupport', 'usage'], ['writePaths']); validateArgSchema(input.manifest.argSchema); text(input.manifest.usage, 'script usage', 2000);
    const writePaths = input.manifest.writePaths ?? [];
    if (!Array.isArray(writePaths) || writePaths.length > 64 || new Set(writePaths).size !== writePaths.length) fail('WRITER_MANIFEST', 'At most 64 distinct relative write files are allowed');
    writePaths.forEach(relativeFile);
    if (input.manifest.dryRunSupport !== true || !Array.isArray(input.manifest.files) || digest([...input.manifest.files].sort()) !== digest(draft.files.map(f => f.path).sort())) fail('WRITER_MANIFEST', 'Exact file list and dry-run contract required');
    const claims = strings(input.verified), notVerified = strings(input.notVerified), artifact = this.artifact(input.manifest.entry, input.manifest.argSchema); this.artifacts.verify(artifact);
    const successful = draft.probes.filter(p => p.entry === artifact.entry && p.filesHash === digest(artifact.files) && p.result.code === 0 && !p.result.reason && !p.result.truncated);
    if (!successful.length) fail('PROBE_REQUIRED', 'Current exact artifact needs a successful confined read-only probe');
    for (const probe of successful) normalizeArgs(artifact.argSchema, probe.args);
    const finished = { ...artifact, writePaths: [...writePaths].sort(), usage: input.manifest.usage, probeIds: successful.map(p => p.id), verified: ['Exact artifact read-only probe completed; enforcement=' + this.runner.enforcement], authoredVerificationClaims: claims, notVerified: [...new Set([...notVerified, 'Real write behavior was not verified by the writer probe'])] };
    if (finished.notVerified.length > 20) fail('WRITER_MANIFEST', 'At most 19 authored limitations plus the mandatory real-write limitation fit the final report; combine related notes without dropping limitations.');
    this.repo.transaction(() => {
      this.repo.command('finishTreeScriptArtifact', { requestId: digest(['finish-artifact', this.id]), expected: {}, input: { binding: this.binding, manifest: input, files: artifact.files } }, program, () => {
        this.assertCurrent(); if (this.repo.get('tree_script_artifacts', artifact.id)) fail('ARTIFACT_CONFLICT', 'Artifact version already exists'); this.repo.save('tree_script_artifacts', finished); return { artifactId: artifact.id };
      });
      this.change('finish', () => ({ state: 'finished', artifactId: artifact.id, finishHash: digest(input) }), draft.revision);
    }); return this.repo.get('tree_script_artifacts', artifact.id);
  }
  verifyFinal(output) {
    this.assertCurrent({ finished: true }); const draft = this.draft(), artifact = this.repo.get('tree_script_artifacts', draft.artifactId);
    if (draft.state !== 'finished' || !artifact || !Array.isArray(output.files) || digest(output.files.map(f => f.name).sort()) !== digest(artifact.files.map(f => f.path).sort()) || output.usage !== artifact.usage) fail('WRITER_FINAL_MISMATCH', 'Native final result must describe the exact finished artifact and usage');
    this.artifacts.verify(artifact); return { artifactId: artifact.id, filesHash: digest(artifact.files), probeIds: artifact.probeIds, notVerified: artifact.notVerified };
  }
  completionTemplate() {
    this.assertCurrent({ finished: true }); const draft = this.draft(), artifact = this.repo.get('tree_script_artifacts', draft.artifactId);
    if (draft.state !== 'finished' || !artifact) fail('WRITER_FINAL_MISMATCH', 'Finish the artifact before requesting its final report');
    this.artifacts.verify(artifact);
    return { files: artifact.files.map(file => ({ name: file.path, purpose: '已封存的方法脚本文件' })),
      usage: artifact.usage, stepsText: artifact.usage, verified: artifact.verified,
      notVerified: artifact.notVerified, problems: '' };
  }
  /** B2 owns the native loop; this mounts six closures, never general tools. */
  mount(agentContext, defineTool) {
    const schemas = {
      writer_read: { relativePath: { type: 'string', required: true }, offset: { type: 'integer' }, limit: { type: 'integer' } },
      writer_list: { relativePath: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } },
      writer_search: { query: { type: 'string', required: true }, relativePath: { type: 'string' }, limit: { type: 'integer' } },
      writer_put: { relativePath: { type: 'string', required: true }, content: { type: 'string', required: true }, expectedHash: { type: 'string' } },
      writer_probe: { entry: { type: 'string', required: true }, args: { type: 'object', additionalProperties: true, required: true } },
      writer_finish: { manifest: { type: 'object', additionalProperties: false, required: true, properties: { entry: { type: 'string', required: true }, files: { type: 'array', items: { type: 'string' }, required: true }, argSchema: { type: 'object', additionalProperties: true, required: true }, dryRunSupport: { type: 'boolean', required: true }, usage: { type: 'string', required: true }, writePaths: { type: 'array', items: { type: 'string' } } } }, verified: { type: 'array', items: { type: 'string' }, required: true }, notVerified: { type: 'array', items: { type: 'string' }, required: true } },
    };
    for (const name of WRITER_TOOLS) agentContext.tools.register(defineTool({ name, description: ({ writer_read: 'Read bounded UTF-8 workspace content. Paths are relative.', writer_list: 'List allowed workspace files. Omit relativePath or use an empty string for the root; do not use dot.', writer_search: 'Search allowed workspace text literally.', writer_put: 'Write one .mjs draft file; replacements require its previous hash.', writer_probe: 'Run this draft read-only for up to ten seconds. args is the JSON business argument object, not command-line flags. The host writes it to a temporary file outside the workspace and invokes entry --input <that-file> --dry-run. The script must parse that JSON, then resolve business file paths from its fields against process.cwd(). Do not treat the --input file itself as a workspace business file.', writer_finish: 'Finish the exact files with entry, closed argSchema for the JSON business arguments (not argv), dryRunSupport:true, usage, writePaths (at most 64 relative output files, no directories; omitted means read-only), and verification limits. The host intersects this declaration with current user permissions; it grants none. writePaths are business outputs, not private script files. ' + ARG_SCHEMA_GUIDANCE })[name],
      parameters: schemas[name], output: { schema: { type: 'json' }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) },
        ...(name === 'writer_finish' ? [{ type: 'text', text: '作者任务已经封存。下一条直接返回完整最终JSON；usage必须逐字复制，files必须包含这些原文件名。可以补充文件用途和操作说明，但不能改写usage或声称已验证真实写入。完整模板：' + JSON.stringify(this.completionTemplate()) }] : [])] },
      execute: async (args, context) => this[name.slice('writer_'.length)](args, { signal: context?.signal }) }));
  }
}
