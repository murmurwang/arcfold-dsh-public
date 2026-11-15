import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readBounded, freezeFiles, ownArtifactDirectory, assertNewArtifact, nativeLines,
  fullReadContent, assertFullRead, verifyArtifact, byteHash, readBoundedSync } from '../src/preparation-artifacts.mjs';

const directory = () => realpathSync(mkdtempSync(join(tmpdir(), 'arcfold-preparation-files-')));
const readResult = (path, text) => ({ message: { isError: false, content: fullReadContent(path, text) },
  meta: { path, offset: 1, lines: nativeLines(text), totalLines: nativeLines(text).length } });

test('bounded original bytes preserve Chinese, emoji, BOM and newline distinctions', async () => {
  const root = directory(), path = join(root, 'source.txt'), text = '\ufeff中文😀\r\n\n末尾';
  writeFileSync(path, text); const read = await readBounded(root, path);
  assert.equal(read.text, text); assert.equal(read.sha256, byteHash(Buffer.from(text)));
  assert.notEqual(read.sha256, byteHash(Buffer.from(text.replaceAll('\r\n', '\n'))));
});
test('invalid UTF8, oversized individual and combined originals refuse without truncated fallback', async () => {
  const root = directory(), bad = join(root, 'bad.txt'); writeFileSync(bad, Buffer.from([0xc3, 0x28]));
  await assert.rejects(readBounded(root, bad), /UTF-8/);
  writeFileSync(bad, 'x'.repeat(262145)); await assert.rejects(readBounded(root, bad), /超过/);
  for (const name of ['a','b','c']) writeFileSync(join(root, name), 'x'.repeat(200000));
  await assert.rejects(freezeFiles(root, ['a','b','c']), /512 KiB/);
});
test('selected files reject symlink, dangling, hardlink and outside paths', async () => {
  const root = directory(), outside = directory(); writeFileSync(join(root, 'a'), 'original');
  symlinkSync(join(root, 'a'), join(root, 'alias')); symlinkSync(join(root, 'absent'), join(root, 'dangling'));
  await assert.rejects(readBounded(root, 'alias')); await assert.rejects(readBounded(root, 'dangling'));
  await assert.rejects(readBounded(root, join(outside, 'source')));
  linkSync(join(root, 'a'), join(root, 'hard')); await assert.rejects(readBounded(root, 'a'));
});
test('artifact directory and target use exclusive ownership, never overwrite', () => {
  const root = directory(), id = 'preparation-' + randomUUID(), artifact = ownArtifactDirectory(root, id);
  assertNewArtifact(root, artifact); assert.throws(() => ownArtifactDirectory(root, id));
  symlinkSync(join(root, 'missing'), artifact.path); assert.throws(() => assertNewArtifact(root, artifact));
});
test('full native read matches empty files, LF, CRLF, trailing newline, long line and natural truncated text', () => {
  for (const text of ['', '\n', '\n\n', 'a\n', 'a\r\n\r\n', 'tail', '长😀'.repeat(3000) + '\ntruncated is ordinary text']) {
    const result = readResult('/f', text); assertFullRead(result, '/f', text);
    const bad = structuredClone(result); bad.meta.totalLines++;
    assert.throws(() => assertFullRead(bad, '/f', text));
  }
  assert.deepEqual(nativeLines('a\r\n\r\n'), [{ number: 1, text: 'a' }, { number: 2, text: '' }]);
  assert.deepEqual(nativeLines(''), []);
});
test('metadata, line window, visible envelope and raw content must all agree', () => {
  const text = 'a'.repeat(3000) + '\nsecond', source = readResult('/f', text);
  for (const mutate of [r => delete r.meta, r => r.meta.offset = 2,
    r => r.meta.lines[0].text = 'a'.repeat(2000) + '... (line truncated to 2000 chars)',
    r => r.meta.lines.pop(), r => r.message.content[0].text = 'success', r => r.meta.path = '/wrong']) {
    const changed = structuredClone(source); mutate(changed); assert.throws(() => assertFullRead(changed, '/f', text));
  }
});
function trace(root, text = '真实准备稿\r\n\n尾部') {
  const artifact = ownArtifactDirectory(root, 'preparation-' + randomUUID()); writeFileSync(artifact.path, text);
  const run = { sessionId: 'prep', executionConfig: { cwd: root, provider: 'fixture', model: 'fixture', maxTokens: 64, reasoningEffort: 'off' }, artifact,
    message: { id: 'input', role: 'user', source: { kind: 'arcfold/preparation' }, content: [{ type: 'text', text: 'frozen' }] } };
  const events = [], put = (type, data) => events.push({ seq: events.length, type, data, time: 1,
    ...(['user/message', 'assistant/message'].includes(type) ? { surfaceOp: 'append' } : {}) });
  put('turn/start', { turn: 1 }); put('user/message', run.message);
  const result = (id, step, content, meta) => put('tool/result', { turn: 1, step, meta,
    message: { role: 'tool', source: { kind: 'tool', callId: id }, toolCallId: id, content, isError: false } });
  put('step/start', { turn: 1, step: 1 });
  put('request/header', { header: { config: run.executionConfig } });
  put('assistant/message', { turn: 1, step: 1, message: { source: { kind: 'model' }, content: [{ type: 'tool-call', id: 'write', name: 'write', arguments: JSON.stringify({ file_path: artifact.path, content: text }) }] } });
  put('tool/call', { turn: 1, step: 1, callId: 'write', name: 'write', arguments: JSON.stringify({ file_path: artifact.path, content: text }) });
  result('write', 1, [{ type: 'text', text: `<path>${artifact.path}</path>\n<type>file</type>\n<content>\nCreated file\n</content>` }], { operation: 'create', path: artifact.path });
  put('step/end', { turn: 1, step: 1 }); put('step/start', { turn: 1, step: 2 });
  put('assistant/message', { turn: 1, step: 2, message: { source: { kind: 'model' }, content: [{ type: 'tool-call', id: 'read', name: 'read', arguments: JSON.stringify({ file_path: artifact.path }) }] } });
  put('tool/call', { turn: 1, step: 2, callId: 'read', name: 'read', arguments: JSON.stringify({ file_path: artifact.path }) });
  const read = readResult(artifact.path, text); result('read', 2, read.message.content, read.meta);
  put('step/end', { turn: 1, step: 2 }); put('step/start', { turn: 1, step: 3 });
  put('assistant/message', { turn: 1, step: 3, message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: '准备完毕。' }] } });
  put('step/end', { turn: 1, step: 3 }); put('turn/end', { turn: 1, reason: { kind: 'completed' } });
  run.requests = events.filter(event => event.type === 'step/start').map(event => ({ turn: event.data.turn, step: event.data.step, stepStartSeq: event.seq }));
  run.tools = ['write', 'read'];
  const disk = readBoundedSync(root, artifact.path);
  run.writeObservation = { callId: 'write', sha256: disk.sha256, identity: disk.identity };
  return { run, events };
}
test('artifact proof requires later full read, completed final and true durable prefix', () => {
  const { run, events } = trace(directory());
  assert.equal(verifyArtifact(run, events, { flushed: true }).text, '真实准备稿\r\n\n尾部');
  assert.throws(() => verifyArtifact(run, events, { flushed: false }));
  for (const mutate of [e => e.at(-1).data.reason.kind = 'max-tokens',
    e => e.findLast(r => r.type === 'assistant/message').data.interrupted = true,
    e => delete e.findLast(r => r.type === 'assistant/message').surfaceOp,
    e => delete e.find(r => r.type === 'tool/result' && r.data.message.toolCallId === 'read').data.meta,
    e => e.find(r => r.type === 'tool/result').data.meta.operation = 'update',
    e => e.find(r => r.type === 'tool/call' && r.data.name === 'read').data.step = 1]) {
    const changed = structuredClone(events); mutate(changed); assert.throws(() => verifyArtifact(run, changed, { flushed: true }));
  }
  writeFileSync(run.artifact.path, '改过的稿件'); assert.throws(() => verifyArtifact(run, events, { flushed: true }));
});
