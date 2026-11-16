import { realpathSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { isBundledDesktopPython } from './python-runtime.mjs';
import { createNativeDesktopSetup } from './native-setup.mjs';

export const name = 'arcfold-desktop-bootstrap';
export const inject = ['loader'];
const same = (a, b) => isDeepStrictEqual(a, b, true);

export async function activateDesktop(ctx, result, { home, previousPython } = {}) {
  const all = [...ctx.loader.entries()];
  const one = id => {
    const matches = all.filter(row => row.options.id === id);
    if (matches.length !== 1) throw new Error('无法确认 Desktop 配置位置：' + id);
    return matches[0];
  };
  const business = one('arcfold-business'), originalProvider = one('arcfold-metered-provider');
  const businessConfig = business.options.config ?? {};
  const intendedConfig = { goalTreeV3: result.tree };
  const previous = businessConfig.goalTreeV3?.tokenCounter?.python;
  const managedPrevious = typeof previous === 'string' && (previous === previousPython || isBundledDesktopPython(home, previous));
  const previousConfig = { goalTreeV3: { ...result.tree, tokenCounter: { ...result.tree.tokenCounter, python: previous } } };
  if (Object.keys(businessConfig).length && !same(businessConfig, intendedConfig) &&
      !(managedPrevious && same(businessConfig, previousConfig)))
    throw new Error('Arcfold 已有不同的运行设置，不能自动覆盖。');
  if (originalProvider.options.disabled !== true && Object.keys(originalProvider.options.config ?? {}).length)
    throw new Error('Arcfold 已有不同的模型连接设置，不能自动覆盖。');
  const desktopPatch = result.patches.find(row => row.insert).insert[0];
  const existing = all.filter(row => row.options.id === desktopPatch.id);
  if (existing.length > 1 || existing.length && (!same(existing[0].options.config, desktopPatch.config) || existing[0].options.name !== desktopPatch.name))
    throw new Error('Desktop 模型连接与保存的设置不一致。');
  // Each native Loader operation persists through its own owning config tree.
  // No arbitrary profile file is replaced. A partial failure is reported and
  // the saved initialization remains available for an exact retry.
  if (originalProvider.options.disabled !== true)
    await originalProvider.parent.tree.update(originalProvider.options.id, { disabled: true });
  if (!same(businessConfig, intendedConfig))
    await business.parent.tree.update(business.options.id, { config: intendedConfig });
  if (!existing.length) {
    const group = business.parent === business.parent.tree.root ? null : business.parent.ctx.fiber.entry?.id ?? null;
    await business.parent.tree.create(desktopPatch, group);
  }
  const defaultModel = one('agent-default-model'), currentDefault = defaultModel.options.config ?? {};
  const unset = value => value === undefined || value === '' || value && typeof value === 'object' && typeof value.__jsExpr === 'string';
  if (unset(currentDefault.provider) && unset(currentDefault.model)) {
    const main = result.tree.models.main;
    await defaultModel.parent.tree.update(defaultModel.options.id, { config: { provider: main.provider, model: main.model, reasoningEffort: main.reasoningEffort } });
  }
  await ctx.loader.await();
  // Tree UI registration is reactive and can follow the business plugin's
  // own startup. Do not report ready until the browser-facing service exists.
  const deadline = Date.now() + 5000;
  while (!ctx.get('arcfoldTreeWeb') && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 25));
  if (!ctx.get('arcfoldTreeRuntime') || !ctx.get('arcfoldTreeV3') || !ctx.get('arcfoldTreeWeb') || !ctx.get('arcfoldDeepSeekTransport'))
    throw new Error('Desktop 未能启动 Arcfold，请保留当前设置并检查错误。');
}

export async function activateNativeDesktop(ctx, result, { home } = {}) {
  const rows = [...ctx.loader.entries()];
  const business = rows.filter(row => row.options.id === 'arcfold-business');
  if (business.length !== 1) throw new Error('无法确认 Arcfold 配置位置。');
  const entry = business[0], current = entry.options.config ?? {}, intended = { goalTreeV3: result.tree };
  let previous = result.previousTree && { goalTreeV3: result.previousTree };
  const python = current.goalTreeV3?.tokenCounter?.python;
  if (previous && python && python !== previous.goalTreeV3.tokenCounter.python && isBundledDesktopPython(home, python))
    previous = { goalTreeV3: { ...previous.goalTreeV3, tokenCounter: { python } } };
  if (Object.keys(current).length && !same(current, intended) && !same(current, previous))
    throw new Error('Arcfold 已有不同的运行设置，不能自动覆盖。');
  const providers = rows.filter(row => ['arcfold-metered-provider', 'arcfold-desktop-metered-provider'].includes(row.options.id));
  if (providers.some(row => !['@arcfold/dsh/deepseek', '@arcfold/dsh/desktop-deepseek'].includes(row.options.name)))
    throw new Error('原模型连接的归属已改变，未修改已有设置。');
  for (const provider of providers) if (provider.options.disabled !== true)
    await provider.parent.tree.update(provider.options.id, { disabled: true });
  if (!same(current, intended)) await entry.parent.tree.update(entry.options.id, { config: intended });
  // Provider settings and the native default model are owned by DSH. The
  // distribution restores their original entries without copying their values.
  await ctx.loader.await();
  const deadline = Date.now() + 5000;
  while (!ctx.get('arcfoldTreeWeb') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  if (!ctx.get('arcfoldTreeRuntime') || !ctx.get('arcfoldTreeV3') || !ctx.get('arcfoldTreeWeb') || !ctx.get('arcfoldNativeModelRecords'))
    throw new Error('DSH 原生模型通道尚未完成启动，请保留当前设置后重启检查。');
}

export function apply(ctx) {
  const isDesktop = Boolean(process.versions.electron && process.argv.some(value => value.includes('dsh-desktop-host')));
  if (!isDesktop) {
    ctx.provide('arcfoldDesktopSetup', Object.freeze({ status: () => ({ state: 'not_desktop' }) }));
    return;
  }
  let setup;
  try {
    const home = realpathSync(resolveDshHome());
    setup = createNativeDesktopSetup({ home, activate: result => activateNativeDesktop(ctx.root, result, { home }) });
  } catch (error) {
    setup = Object.freeze({ status: () => ({ state: 'unavailable', modelRouting: 'dsh-native-v1', activationError: error.message }) });
  }
  ctx.provide('arcfoldDesktopSetup', setup);
  if (setup.status().state === 'configured') {
    // Do not wait for the Loader from inside its own initialization task.
    setImmediate(() => { void ctx.loader.await().then(() => setup.resume()); });
  }
}
