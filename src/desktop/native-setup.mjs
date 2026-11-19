import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { desktopConfigurationForUpgrade } from './configuration.mjs';

export const NATIVE_ROUTING = 'dsh-native-v1';
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const hash = value => createHash('sha256').update(value).digest('hex');
function privateFile(path) {
  const st = lstatSync(path);
  assert(st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.uid === process.getuid() && !(st.mode & 0o077), '保存的 Arcfold 设置必须是本用户的私有文件。');
  return st;
}
function writeNew(path, value) {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
  const directory = openSync(dirname(path), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
function directory(path, privateOnly = false) {
  const st = lstatSync(path);
  assert(st.isDirectory() && !st.isSymbolicLink() && realpathSync(path) === path && st.uid === process.getuid() && (!privateOnly || !(st.mode & 0o077)), 'Arcfold 数据和工作区位置已改变，请检查保存的设置。');
}

/** Keep v1 data and accounting files intact. The new receipt authorizes only
 * native routing; it contains no provider directory, model default or secret. */
export function createNativeDesktopSetup({ home, activate, isActive = () => true }) {
  assert(realpathSync(home) === home, 'DSH 数据目录必须使用真实路径。');
  const dataRoot = join(home, 'arcfold-desktop'), workspace = join(home, 'arcfold-workspace');
  const runtimeRoot = join(home, 'arcfold-desktop-processes');
  const configPath = join(dataRoot, 'native-model-configuration.json'), receiptPath = join(dataRoot, 'native-model-configuration-completed.json');
  const oldConfigPath = join(dataRoot, 'desktop-configuration.json'), oldCompletedPath = join(dataRoot, 'desktop-initialization-completed.json');
  let state = existsSync(receiptPath) ? 'configured' : existsSync(configPath) ? 'interrupted'
    : existsSync(oldCompletedPath) ? 'needs_upgrade' : existsSync(dataRoot) || existsSync(workspace) ? 'interrupted' : 'needs_setup';
  let busy = false, activationError = null, authorizedTree = null;
  const status = () => {
    const unavailable = state === 'ready' && !isActive();
    return { state: unavailable ? 'activation_failed' : state, busy, workspace, dataRoot,
      modelRouting: NATIVE_ROUTING, followConversationModel: true,
      activationError: unavailable ? 'Arcfold 服务当前不可用，请保留已有数据并重启后检查。' : activationError };
  };
  function previous() {
    directory(dataRoot, true); directory(workspace);
    for (const path of [oldConfigPath, oldCompletedPath, join(dataRoot, 'desktop-initialization.json')]) privateFile(path);
    const bytes = readFileSync(oldConfigPath), saved = JSON.parse(bytes), completed = JSON.parse(readFileSync(oldCompletedPath, 'utf8'));
    const intent = JSON.parse(readFileSync(join(dataRoot, 'desktop-initialization.json'), 'utf8'));
    assert(saved.schema === 'arcfold-desktop-configuration-v1' && completed.schema === 'arcfold-desktop-initialization-completed-v1'
      && intent.schema === 'arcfold-desktop-initialization-v1' && intent.inputHash === hash(bytes) && completed.inputHash === hash(bytes), '旧设置与初始化回执不一致，未修改已有数据。');
    const options = saved.options;
    assert(options.local.dataRoot === dataRoot && options.local.workspace === workspace && options.runtimeRoot === runtimeRoot, '旧 Arcfold 数据位置与当前安装不一致。');
    const projection = desktopConfigurationForUpgrade(options), st = privateFile(projection.tree.budget.ledgerPath);
    assert(st.dev === completed.ledger.dev && st.ino === completed.ledger.ino, '旧费用记录被替换，未认领该记录。');
    return { tree: projection.tree, inputHash: hash(bytes) };
  }
  function readSaved() {
    directory(dataRoot, true); directory(workspace); privateFile(configPath); privateFile(receiptPath);
    const bytes = readFileSync(configPath), saved = JSON.parse(bytes), receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    assert(saved.schema === 'arcfold-native-model-configuration-v1' && receipt.schema === 'arcfold-native-model-configuration-completed-v1'
      && receipt.inputHash === hash(bytes), '模型通道设置与回执不一致。');
    const tree = saved.tree;
    assert(tree.adapter === NATIVE_ROUTING && tree.privateRoot === dataRoot && tree.workspace === workspace
      && tree.runtimeRoot === runtimeRoot && tree.treeFilename === join(dataRoot, 'tree.sqlite')
      && tree.accounting?.artifactDirectory === join(dataRoot, 'requests') && tree.enabled === true && tree.followConversationModel === true
      && !tree.models && !tree.budget && !tree.tokenCounter, '保存的原生模型通道设置不完整。');
    const old = saved.previous ? previous() : null;
    assert(!old || saved.previous.inputHash === old.inputHash && isDeepStrictEqual(saved.previous.tree, old.tree), '升级来源与原始设置不一致。');
    return saved;
  }
  async function activateSaved(saved, { resuming = false } = {}) {
    authorizedTree = saved.tree;
    await activate({ tree: saved.tree, previousTree: saved.previous?.tree, resuming });
    state = 'ready'; activationError = null; return status();
  }
  async function resume() {
    if (!['configured', 'activation_failed'].includes(status().state) || busy) return status();
    busy = true;
    try { return await activateSaved(readSaved(), { resuming: true }); }
    catch (error) { state = 'activation_failed'; activationError = error.message; return status(); }
    finally { busy = false; }
  }
  async function start({ confirmed } = {}) {
    assert(confirmed === true && ['needs_setup', 'needs_upgrade'].includes(state) && !busy, '请先确认当前模型和相关后台调用可能产生的费用。');
    busy = true;
    try {
      const old = state === 'needs_upgrade' ? previous() : null;
      if (!old) {
        assert(!existsSync(dataRoot) && !existsSync(workspace), '数据或工作区已经存在，不能自动认领。');
        mkdirSync(dataRoot, { mode: 0o700 }); mkdirSync(workspace, { mode: 0o700 });
      }
      const tree = { enabled: true, adapter: NATIVE_ROUTING, followConversationModel: true, workspace, privateRoot: dataRoot,
        runtimeRoot, treeFilename: join(dataRoot, 'tree.sqlite'), userId: old?.tree.userId ?? 'desktop-' + randomUUID(), stage: 'desktop',
        accounting: { artifactDirectory: join(dataRoot, 'requests'), authorization: {
          authorizationRef: 'arcfold-native-models:' + randomUUID(), authorizedAt: new Date().toISOString(),
          authorizationEvidence: 'Desktop owner confirmed native chat model usage for the conversation and its background tasks; no local spending cap.' } } };
      const saved = { schema: 'arcfold-native-model-configuration-v1', tree, ...(old ? { previous: old } : {}) }, bytes = JSON.stringify(saved) + '\n';
      writeNew(configPath, bytes);
      writeNew(receiptPath, JSON.stringify({ schema: 'arcfold-native-model-configuration-completed-v1', inputHash: hash(bytes) }) + '\n');
      state = 'configured'; return await activateSaved(readSaved());
    } catch (error) {
      state = existsSync(receiptPath) ? 'activation_failed' : 'interrupted'; activationError = error.message; throw error;
    } finally { busy = false; }
  }
  // The business plugin can load before async resume. Verify the persisted
  // consent now; an invalid or incomplete receipt must never start its workers.
  if (state === 'configured') authorizedTree = readSaved().tree;
  return Object.freeze({ status, start, resume, authorizes: tree => authorizedTree !== null && isDeepStrictEqual(tree, authorizedTree) });
}
