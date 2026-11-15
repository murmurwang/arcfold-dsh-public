import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { isBundledDesktopPython, prepareBundledDesktopPython } from './python-runtime.mjs';
import { createDesktopSetup } from './setup-service.mjs';

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

export function apply(ctx) {
  const isDesktop = Boolean(process.versions.electron && process.argv.some(value => value.includes('dsh-desktop-host')));
  if (!isDesktop) {
    ctx.provide('arcfoldDesktopSetup', Object.freeze({ status: () => ({ state: 'not_desktop' }) }));
    return;
  }
  const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  let setup;
  try {
    const home = realpathSync(resolveDshHome());
    const policy = JSON.parse(readFileSync(join(packageRoot, 'runtime/initial-policy.json'), 'utf8'));
    setup = createDesktopSetup({ home, installationFile: join(packageRoot, 'package.json'), policy,
      preparePython: () => prepareBundledDesktopPython(packageRoot, home),
      activate: (result, previousPython) => activateDesktop(ctx.root, result, { home, previousPython }) });
  } catch (error) {
    setup = Object.freeze({ status: () => ({ state: 'unavailable', activationError: error.message }) });
  }
  ctx.provide('arcfoldDesktopSetup', setup);
  if (setup.status().state === 'configured') {
    // Do not wait for the Loader from inside its own initialization task.
    setImmediate(() => { void ctx.loader.await().then(() => setup.resume()); });
  }
}
