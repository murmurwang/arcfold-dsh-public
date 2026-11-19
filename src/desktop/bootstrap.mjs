import { realpathSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { isBundledDesktopPython } from './python-runtime.mjs';
import { createNativeDesktopSetup } from './native-setup.mjs';

export const name = 'arcfold-desktop-bootstrap';
export const inject = ['loader'];
const same = (a, b) => isDeepStrictEqual(a, b, true);
const legacyProviders = new Map([
  ['arcfold-metered-provider', '@arcfold/dsh/deepseek'],
  ['arcfold-desktop-metered-provider', '@arcfold/dsh/desktop-deepseek'],
]);
const disableFailure = detail => new Error('旧模型连接未能安全停用，请保留已有设置并检查 DSH 插件状态。'
  + (detail === undefined ? '' : '（DSH 回复：' + JSON.stringify(detail) + '）'));
// A disabled Loader entry has no running fiber, or one that Cordis has disposed (FiberState 4).
const stopped = row => row.options.disabled === true && row.disabled === true && (!row.fiber || row.fiber.state === 4);

// 0.4.x created this entry through the business entry's Include. It can live
// in that Include's base file, outside the profile-patch manager's addressable
// rows. Never use this path for an ambiguous or overridden profile entry.
async function disableCreatedDesktopProvider(ctx, provider, business, previousTree, manager) {
  const tree = provider.parent?.tree;
  if (provider.options.id !== 'arcfold-desktop-metered-provider' || previousTree?.adapter !== 'desktop-private-v1'
      || provider.parent !== business.parent || tree?.ctx.fiber.entry?.id !== 'include'
      || !tree.update || !tree.flush || !tree.refresh) throw disableFailure();
  const mentions = rows => rows.some(row => row.id === provider.options.id
    || Array.isArray(row.insert) && mentions(row.insert)
    || row.group && Array.isArray(row.config) && mentions(row.config));
  const run = async () => {
    await tree.flush(); await tree.refresh(); await ctx.loader.await();
    const current = [...ctx.loader.entries()].filter(row => row.options.id === provider.options.id);
    const inventory = (await manager.listPlugins()).filter(row => row.entryId === provider.id);
    if (current.length !== 1 || current[0] !== provider || provider.parent !== business.parent
        || provider.options.name !== legacyProviders.get(provider.options.id)
        || inventory.length !== 1 || inventory[0].moduleName !== provider.options.name
        || inventory[0].readOnlyReason !== 'unaddressable'
        || !Array.isArray(tree.config?.patches) || mentions(tree.config.patches)) throw disableFailure();
    await tree.update(provider.options.id, { disabled: true });
    await tree.flush(); await ctx.loader.await();
    if (![...ctx.loader.entries()].includes(provider) || provider.options.disabled !== true
        || !provider.disabled || provider.fiber && provider.fiber.state !== 4) throw disableFailure();
  };
  const hmr = ctx.get('hmr');
  await (hmr?.runExclusive ? hmr.runExclusive(run) : run());
}

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
  const business = () => {
    const matches = [...ctx.loader.entries()].filter(row => row.options.id === 'arcfold-business');
    if (matches.length !== 1 || matches[0].options.name !== '@arcfold/dsh')
      throw new Error('无法确认 Arcfold 配置位置和归属。');
    return matches[0];
  };
  const intended = { goalTreeV3: result.tree };
  const checkedConfig = current => {
    let previous = result.previousTree && { goalTreeV3: result.previousTree };
    const python = current.goalTreeV3?.tokenCounter?.python;
    if (previous && python && python !== previous.goalTreeV3.tokenCounter.python && isBundledDesktopPython(home, python))
      previous = { goalTreeV3: { ...previous.goalTreeV3, tokenCounter: { python } } };
    if (Object.keys(current).length && !same(current, intended) && !same(current, previous))
      throw new Error('Arcfold 已有不同的运行设置，不能自动覆盖。');
    return intended;
  };
  checkedConfig(business().options.config ?? {});
  const providers = rows.filter(row => legacyProviders.has(row.options.id));
  if (providers.some(row => row.options.name !== legacyProviders.get(row.options.id)
      || providers.filter(other => other.options.id === row.options.id).length !== 1))
    throw new Error('原模型连接的归属已改变，未修改已有设置。');
  const editor = ctx.get('configEditor'), manager = ctx.get('pluginManager');
  if (!editor?.edit || !editor?.configuration || !manager?.setPluginEnabled || !manager?.listPlugins)
    throw new Error('DSH 原生配置保存服务尚未就绪。');
  // An already-disabled live entry can still have an enabled disk declaration
  // left by the old in-memory update. Let the native manager reconcile both.
  for (const provider of providers) {
    // On resume the Loader entries were composed from the saved profile, so a
    // literally disabled, stopped entry is already the saved choice. After an
    // in-place update this resume runs inside DSH's own update transaction,
    // where a second plugin-manager change is refused as nested.
    if (result.resuming === true && stopped(provider)) continue;
    const inventory = (await manager.listPlugins()).filter(row => row.entryId === provider.id);
    if (inventory.length !== 1 || inventory[0].moduleName !== provider.options.name)
      throw disableFailure({ entries: inventory.length, readOnlyReason: inventory[0]?.readOnlyReason });
    if (inventory[0].readOnlyReason === 'unaddressable')
      await disableCreatedDesktopProvider(ctx, provider, business(), result.previousTree, manager);
    else {
      const saved = await manager.setPluginEnabled(provider.id, false);
      if (saved.application !== 'applied')
        throw disableFailure({ application: saved.application, error: saved.error?.code, diagnostic: saved.error?.diagnostic });
    }
  }
  const entry = business();
  const saved = editor.configuration().find(row => row.entry === entry);
  // Loader tree.update changes only the owning Include's current config. The
  // native editor persists the profile patch that later reloads/restarts read,
  // and checks the current config again under the host's configuration lock.
  if (!same(entry.options.config ?? {}, intended) || !same(saved?.override, intended))
    await editor.edit(entry, checkedConfig);
  // Provider settings and the native default model are owned by DSH. The
  // distribution restores their original entries without copying their values.
  await ctx.loader.await();
  const deadline = Date.now() + 5000;
  while (!ctx.get('arcfoldTreeWeb') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  if (!nativeRuntimeReady(ctx))
    throw new Error('DSH 原生模型通道尚未完成启动，请保留当前设置后重启检查。');
}

function nativeRuntimeReady(ctx) {
  return ['arcfoldTreeRuntime', 'arcfoldTreeV3', 'arcfoldTreeWeb', 'arcfoldNativeModelRecords'].every(key => Boolean(ctx.get(key)));
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
    setup = createNativeDesktopSetup({ home, activate: result => activateNativeDesktop(ctx.root, result, { home }),
      isActive: () => nativeRuntimeReady(ctx.root) });
  } catch (error) {
    setup = Object.freeze({ status: () => ({ state: 'unavailable', modelRouting: 'dsh-native-v1', activationError: error.message }) });
  }
  ctx.provide('arcfoldDesktopSetup', setup);
  if (setup.status().state === 'configured') {
    // Do not wait for the Loader from inside its own initialization task.
    setImmediate(() => { void ctx.loader.await().then(() => setup.resume()); });
  }
}
