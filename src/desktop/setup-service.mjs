import { existsSync, lstatSync, mkdirSync, readFileSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initializeDesktop } from './configuration.mjs';

const roles = ['main', 'attribution', 'learning', 'consolidation', 'verification', 'improvement', 'script_writer'];
const fail = message => { throw new Error(message); };
const entryAt = path => lstatSync(path, { throwIfNoEntry: false });

/** Setup owns only a new Desktop namespace. The caller supplies host-discovered
 * paths and a reviewed policy; credentials remain in the native host. */
export function createDesktopSetup({ home, installationFile, python, preparePython = () => python, policy, activate }) {
  const dataRoot = join(home, 'arcfold-desktop'), workspace = join(home, 'arcfold-workspace');
  const runtimeRoot = join(home, 'arcfold-desktop-processes'), configPath = join(dataRoot, 'desktop-configuration.json');
  const completed = join(dataRoot, 'desktop-initialization-completed.json');
  function stateOnDisk() {
    if (existsSync(completed)) return 'configured';
    return entryAt(dataRoot) || entryAt(workspace) ? 'interrupted' : 'needs_setup';
  }
  let state = stateOnDisk();
  let busy = false, activationError = null;
  const route = policy.routes?.['deepseek-official'];
  const models = Object.fromEntries(roles.map(role => {
    const main = role === 'main', model = main ? 'deepseek-v4-pro' : 'deepseek-flash';
    const modelPolicy = route?.modelPolicies?.[model];
    if (!modelPolicy?.priceVersion) fail('缺少模型和费用信息，暂时无法设置。');
    const high = ['main', 'learning', 'consolidation'].includes(role);
    return [role, { provider: 'deepseek-official', model, modelVersion: modelPolicy.priceVersion.split('/')[0],
      reasoningEffort: high ? 'high' : 'off', maxTokens: main ? 128000 : role === 'attribution' ? 2048 : 8192 }];
  }));
  const status = () => ({ state, busy, workspace, dataRoot, mainModel: models.main.model,
    followConversationModel: true, priceReviewedAt: policy.reviewedAt, activationError });
  async function activateOptions(options, runtimePython = options.python) {
    const result = await initializeDesktop(options, { confirmed: true }, runtimePython);
    await activate(result, options.python); state = 'ready'; activationError = null; return status();
  }
  async function resume() {
    if (state !== 'configured') return status();
    try {
      const saved = JSON.parse(readFileSync(configPath, 'utf8'));
      if (saved.schema !== 'arcfold-desktop-configuration-v1' || saved.options?.local?.dataRoot !== dataRoot)
        fail('保存的 Desktop 配置与数据位置不一致。');
      return await activateOptions(saved.options, preparePython());
    } catch (error) { activationError = error.message; state = 'activation_failed'; return status(); }
  }
  async function start({ confirmed }) {
    if (confirmed !== true || state !== 'needs_setup' || busy) fail('请先确认模型费用，并检查当前设置状态。');
    busy = true;
    let createdWorkspace;
    try {
      if (entryAt(workspace)) fail('独立工作区已经存在；请先检查已有内容，不能自动认领。');
      const counterPython = preparePython();
      mkdirSync(workspace, { mode: 0o700 });
      createdWorkspace = lstatSync(workspace);
      const main = models.main, selection = { provider: main.provider, model: main.model, reasoningEffort: main.reasoningEffort, maxTokens: main.maxTokens };
      const authority = { authorizationRef: 'arcfold-desktop:' + randomUUID(), authorizedAt: new Date().toISOString(),
        authorizationEvidence: 'Desktop owner explicitly confirmed model usage without a local spending cap.' };
      const evidence = join(dataRoot, 'requests');
      const local = { schema: 'arcfold-local-v2', installationFile, dataRoot, workspace, listen: { host: '127.0.0.1', port: 0 },
        main: selection, learn: { ...selection }, transport: { artifactDirectory: evidence, routes: { 'deepseek-official': {
          kind: 'deepseek', mode: 'web-only', scope: 'web-unlimited', apiKeyRef: 'DEEPSEEK_API_KEY',
          ledgerPath: join(evidence, 'deepseek-web.sqlite'), webAuthorization: authority,
          endpoint: route.endpoint, network: { mode: 'direct' }, modelPolicies: route.modelPolicies, timeoutMs: 60000,
        } } } };
      return await activateOptions({ local, runtimeRoot, python: counterPython, userId: 'desktop-' + randomUUID(), models });
    } catch (error) {
      if (createdWorkspace && !entryAt(dataRoot)) {
        const current = entryAt(workspace);
        if (current?.isDirectory() && current.dev === createdWorkspace.dev && current.ino === createdWorkspace.ino) {
          // An empty-only removal leaves any work added meanwhile intact.
          try { rmdirSync(workspace); } catch { /* The remaining workspace requires inspection. */ }
        }
      }
      const diskState = stateOnDisk();
      state = diskState === 'configured' ? 'activation_failed' : diskState;
      activationError = error.message;
      throw error;
    } finally { busy = false; }
  }
  return Object.freeze({ status, start, resume });
}
