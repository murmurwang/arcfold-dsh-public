import { constants, openSync, closeSync, readSync, fstatSync, lstatSync, realpathSync, mkdirSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve, join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { DomainError, canonicalJson } from './store.mjs';

export const PREPARATION_LIMITS = Object.freeze({ fileBytes: 262144, totalFileBytes: 524288,
  inputBytes: 1048576, artifactBytes: 65536, requests: 4, tools: 6, lifetimeMs: 300000 });
export const PREPARATION_READ_CAPS = Object.freeze({ readLimit: 262144, readMaxLineLength: 262144, readMaxBytes: 262144 });
export const digest = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
export const byteHash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new DomainError('preparation_material_invalid', message); };
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const stamp = s => ({ dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, mode: s.mode, nlink: s.nlink });
const directoryStamp = s => ({ dev: s.dev, ino: s.ino, mode: s.mode });

export function canonicalWorkspace(path) {
  if (typeof path !== 'string' || resolve(path) !== path || realpathSync(path) !== path || !lstatSync(path).isDirectory())
    fail('准备工作目录必须是当前真实的绝对目录。');
  return path;
}
export function confinedPath(workspace, path) {
  canonicalWorkspace(workspace);
  if (typeof path !== 'string' || !path || path.includes('\0')) fail('材料路径无效。');
  const absolute = resolve(workspace, path), rel = relative(workspace, absolute);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || resolve(absolute) !== absolute) fail('材料必须位于已授权目录内。');
  let current = workspace;
  for (const component of rel.split(sep).slice(0, -1)) {
    current = join(current, component);
    const s = lstatSync(current);
    if (s.isSymbolicLink() || !s.isDirectory()) fail('材料目录不能通过符号链接或其它文件转向。');
  }
  return absolute;
}
export function fileIdentity(workspace, path) {
  const absolute = confinedPath(workspace, path), s = lstatSync(absolute);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || realpathSync(absolute) !== absolute)
    fail('材料必须是没有符号链接或硬链接别名的普通文件。');
  return { path: absolute, ...stamp(s) };
}
function decoded(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail('材料必须是完整的 UTF-8 文本，不能替换损坏的原字符。'); }
}
function finishRead(workspace, path, before, after, bytes, limit) {
  if (bytes.length > limit) fail(`单个文件超过 ${limit} 字节，未截断材料。`);
  const current = fileIdentity(workspace, path);
  if (!same(before, { path, ...stamp(after) }) || !same(before, current) || bytes.length !== before.size)
    fail('读取期间文件身份或内容发生变化。');
  return { identity: current, bytes: bytes.length, sha256: byteHash(bytes), text: decoded(bytes) };
}
export async function readBounded(workspace, path, limit = PREPARATION_LIMITS.fileBytes) {
  path = confinedPath(workspace, path);
  const before = fileIdentity(workspace, path);
  if (before.size > limit) fail(`单个文件超过 ${limit} 字节，未截断材料。`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!same(before, { path, ...stamp(await handle.stat()) })) fail('打开的材料已被替换。');
    const bytes = Buffer.alloc(limit + 1); let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break; offset += bytesRead;
    }
    return finishRead(workspace, path, before, await handle.stat(), bytes.subarray(0, offset), limit);
  } finally { await handle.close(); }
}
// The final transport/body check cannot await. It reads only the already bounded
// selected files, never scans a directory or opens arbitrary user material.
export function readBoundedSync(workspace, path, limit = PREPARATION_LIMITS.fileBytes) {
  path = confinedPath(workspace, path);
  const before = fileIdentity(workspace, path);
  if (before.size > limit) fail(`单个文件超过 ${limit} 字节，未截断材料。`);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!same(before, { path, ...stamp(fstatSync(fd)) })) fail('打开的材料已被替换。');
    const bytes = Buffer.alloc(limit + 1); let offset = 0;
    while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) break; offset += count; }
    return finishRead(workspace, path, before, fstatSync(fd), bytes.subarray(0, offset), limit);
  } finally { closeSync(fd); }
}
export async function freezeFiles(workspace, paths) {
  if (!Array.isArray(paths) || paths.length > 4 || new Set(paths).size !== paths.length) fail('最多选择四个不同的材料文件。');
  const files = []; let bytes = 0;
  for (const path of paths) {
    const value = await readBounded(workspace, path); bytes += value.bytes;
    if (bytes > PREPARATION_LIMITS.totalFileBytes) fail('选定文件合计超过 512 KiB，未截断材料。');
    files.push(value);
  }
  if (new Set(files.map(file => file.identity.path)).size !== files.length) fail('同一个材料不能用多个路径重复选择。');
  return files;
}
export function ownArtifactDirectory(workspace, runId) {
  canonicalWorkspace(workspace);
  if (!/^preparation-[a-f0-9-]+$/.test(runId)) fail('准备编号无效。');
  let path = workspace;
  const directories = [];
  for (const part of ['.arcfold', 'preparations', runId]) {
    path = join(path, part);
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) { if (part === runId || error.code !== 'EEXIST') throw error; }
    if (realpathSync(path) !== path || !lstatSync(path).isDirectory()) fail('准备目录已被替换。');
    directories.push({ path, ...directoryStamp(lstatSync(path)) });
  }
  return { path: join(path, 'draft.md'), directories };
}
export function assertArtifactDirectory(workspace, artifact) {
  confinedPath(workspace, artifact.path);
  for (const expected of artifact.directories) {
    const s = lstatSync(expected.path);
    if (!s.isDirectory() || s.isSymbolicLink() || !same(expected, { path: expected.path, ...directoryStamp(s) }))
      fail('本次独占准备目录已被替换。');
  }
}
export function assertNewArtifact(workspace, artifact) {
  assertArtifactDirectory(workspace, artifact);
  try { lstatSync(artifact.path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  fail('准备目标已存在，不能覆盖。');
}
export function nativeLines(text) {
  const rows = text.split('\n'); if (rows.at(-1) === '') rows.pop();
  return rows.map((text, index) => ({ number: index + 1, text: text.endsWith('\r') ? text.slice(0, -1) : text }));
}
export function fullReadContent(path, text) {
  const lines = nativeLines(text), footer = `(End of file - total ${lines.length} lines)`;
  const body = lines.length ? lines.map(line => `${line.number}: ${line.text}`).join('\n') + '\n\n' + footer : footer;
  return [{ type: 'text', text: `<path>${path}</path>\n<type>file</type>\n<content>\n${body}\n</content>` }];
}
export function assertFullRead(result, path, text) {
  const lines = nativeLines(text), meta = result.meta;
  if (result.message?.isError || !meta || meta.path !== path || meta.offset !== 1 || meta.totalLines !== lines.length ||
      !same(meta.lines, lines) || !same(result.message.content, fullReadContent(path, text)))
    fail('原生回读没有向模型展示稿件全文，不能公布完成。');
}

/** Consumes only the actual persisted official native log; no model invocation. */
export function verifyArtifact(run, events, { flushed }) {
  if (flushed !== true || !Array.isArray(events) || !events.length) fail('尚未确认原生结果完整持久化。');
  for (const [index, event] of events.entries()) if (event.seq !== index || !event.data || typeof event.type !== 'string') fail('原生事件前缀不完整。');
  const starts = events.filter(e => e.type === 'turn/start'), ends = events.filter(e => e.type === 'turn/end');
  if (starts.length !== 1 || ends.length !== 1 || ends[0].data.reason?.kind !== 'completed' ||
      starts[0].data.turn !== ends[0].data.turn || starts[0].seq >= ends[0].seq ||
      events.some(e => e.type === 'session/end-seed' && e.data.inherited || /^(job\/|subagent\/|goal\/|tool\/ptc)/.test(e.type)))
    fail('准备必须由一个完整、非继承的原生轮次完成。');
  const originals = events.filter(e => e.type === 'user/message' && e.data.id === run.message.id);
  if (originals.length !== 1 || !same(originals[0].data, run.message) || run.message.source.kind !== 'arcfold/preparation' ||
      events.some(e => e.type === 'user/message' && e.data.id !== run.message.id && e.data.source?.kind !== 'runtime-context'))
    fail('准备原始输入与冻结记录不符。');
  const inside = events.slice(starts[0].seq + 1, ends[0].seq);
  let step = null;
  for (const event of inside) {
    if (event.type === 'step/start') { if (step !== null || !Number.isSafeInteger(event.data.step)) fail('原生步骤边界不完整。'); step = event.data.step; }
    else if (event.type === 'step/end') { if (step !== event.data.step) fail('原生步骤边界不一致。'); step = null; }
    else if (['assistant/message', 'assistant/attempt', 'tool/call', 'tool/result'].includes(event.type) &&
      (step === null || event.data.step !== step || event.data.turn !== starts[0].data.turn)) fail('结果不属于本轮实际步骤。');
  }
  if (step !== null) fail('原生步骤尚未结束。');
  const final = inside.findLast(e => e.type === 'assistant/message');
  if (!final || final.surfaceOp !== 'append' || final.data.interrupted || final.data.message?.source?.kind !== 'model' ||
      final.data.message.content.some(b => b.type === 'tool-call') ||
      !final.data.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim()) fail('缺少完整正式答复。');
  const modelEvents = inside.filter(e => ['assistant/message', 'assistant/attempt'].includes(e.type));
  if (!Array.isArray(run.requests) || modelEvents.length !== run.requests.length || new Set(run.requests.map(row => row.stepStartSeq)).size !== run.requests.length ||
      modelEvents.some(event => !run.requests.some(row => row.turn === event.data.turn && row.step === event.data.step &&
        events[row.stepStartSeq]?.type === 'step/start' && events[row.stepStartSeq].data.step === row.step)))
    fail('实际模型步骤与已登记请求不能逐项对应。');
  const headers = events.filter(event => event.type === 'request/header');
  if (!headers.length || headers.some(event => ['provider', 'model', 'maxTokens', 'reasoningEffort'].some(key =>
    event.data.header?.config?.[key] !== run.executionConfig[key]))) fail('持久化模型配置与冻结配置不符。');
  const requested = inside.filter(event => event.type === 'assistant/message').flatMap(event => event.data.message.content
    .filter(block => block.type === 'tool-call').map(block => ({ block, event })));
  if (new Set(requested.map(value => value.block.id)).size !== requested.length) fail('模型工具调用身份重复。');
  const calls = inside.filter(e => e.type === 'tool/call'), results = inside.filter(e => e.type === 'tool/result');
  if (!Array.isArray(run.tools) || run.tools.length > PREPARATION_LIMITS.tools || new Set(run.tools).size !== run.tools.length ||
      run.tools.some(id => !calls.some(call => call.data.callId === id)) || new Set(calls.map(c => c.data.callId)).size !== calls.length ||
      results.length !== calls.length || inside.filter(e => ['assistant/message', 'assistant/attempt'].includes(e.type)).length > PREPARATION_LIMITS.requests)
    fail('准备调用超过界限或存在未结工具。');
  if (requested.length !== calls.length) fail('模型请求和实际根工具调用数不一致。');
  const paired = calls.map(call => {
    const asked = requested.filter(value => value.block.id === call.data.callId && value.block.name === call.data.name &&
      value.block.arguments === call.data.arguments && value.event.data.step === call.data.step && value.event.seq < call.seq);
    if (asked.length !== 1) fail('原生根工具调用不是本步骤的实际模型请求。');
    const matches = results.filter(result => result.data.message?.toolCallId === call.data.callId);
    if (matches.length !== 1 || matches[0].seq <= call.seq || matches[0].seq >= final.seq || matches[0].data.step !== call.data.step ||
        matches[0].data.message.source?.kind !== 'tool' || matches[0].data.message.source.callId !== call.data.callId ||
        !['read', 'write'].includes(call.data.name)) fail('原生工具调用及回执不能对应。');
    let args; try { args = JSON.parse(call.data.arguments); } catch { fail('原始工具参数损坏。'); }
    return { call, result: matches[0], args };
  });
  if (paired.some(pair => !run.tools.includes(pair.call.data.callId) && pair.result.data.message.isError !== true))
    fail('未获准的原生工具意图不能含成功执行回执。');
  const admitted = paired.filter(pair => run.tools.includes(pair.call.data.callId));
  const writes = admitted.filter(p => p.call.data.name === 'write');
  if (writes.length !== 1) fail('必须且只能实际写入一份准备稿。');
  const write = writes[0], path = run.artifact.path;
  assertArtifactDirectory(run.executionConfig.cwd, run.artifact);
  const disk = readBoundedSync(run.executionConfig.cwd, path, PREPARATION_LIMITS.artifactBytes);
  if (write.args.file_path !== path || typeof write.args.content !== 'string' ||
      byteHash(Buffer.from(write.args.content)) !== disk.sha256 || write.result.data.message.isError ||
      write.result.data.meta?.operation !== 'create' || write.result.data.meta.path !== path ||
      !same(write.result.data.message.content, [{ type: 'text', text: `<path>${path}</path>\n<type>file</type>\n<content>\nCreated file\n</content>` }]))
    fail('实际写入回执、原参数和磁盘字节不一致。');
  const reads = admitted.filter(p => p.call.data.name === 'read' && p.args.file_path === path &&
    p.call.data.step > write.call.data.step && p.call.seq > write.result.seq);
  if (!reads.length) fail('写入以后没有在后续步骤全文回读。');
  assertFullRead(reads.at(-1).result.data, path, disk.text);
  if (!run.writeObservation || run.writeObservation.callId !== write.call.data.callId || run.writeObservation.sha256 !== disk.sha256 || !same(run.writeObservation.identity, disk.identity)) fail('稿件在实际写入后被替换或修改。');
  const after = readBoundedSync(run.executionConfig.cwd, path, PREPARATION_LIMITS.artifactBytes);
  if (!same(after, disk)) fail('公布前稿件再次变化。');
  return { path, sha256: disk.sha256, bytes: disk.bytes, text: disk.text, identity: disk.identity,
    sessionId: run.sessionId, nativeHash: digest(events), throughSeq: events.at(-1).seq,
    writeSeq: write.call.seq, readSeq: reads.at(-1).call.seq, finalSeq: final.seq,
    finalText: final.data.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n') };
}
