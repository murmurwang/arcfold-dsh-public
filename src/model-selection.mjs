// Native main selection has one owner: its session projection and default service.
const fields = ['provider', 'model', 'reasoningEffort'];
const same = (a, b) => a && b && fields.every(key => a[key] === b[key]);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

/** The runtime supplies verified native services and its current route validator.
 * No listener is installed here: startup must independently verify the actual
 * consuming controller, unique hook owner and service identities before enabling it.
 */
export function createModelSelectionHandler({ sessions, defaults, assertSelection }) {
  if (typeof assertSelection !== 'function') throw new TypeError('A current route validator is required');
  return async ({ agent, selected }) => {
    if (!agent || sessions.get(agent.id) !== agent.session || !Object.isFrozen(selected))
      fail('invalid_model_selection_owner', '无法确认当前会话的模型设置归属。');
    let entered = false;
    try {
      return await agent.runMaintenance(async signal => {
        entered = true;
        signal.throwIfAborted();
        await assertSelection(agent, selected);
        signal.throwIfAborted();
        await defaults.saveSelection(selected);
        // Saving the default and appending a session event are separate native
        // writes. A later failure is reported; neither is falsely rolled back.
        signal.throwIfAborted();
        await assertSelection(agent, selected);
        signal.throwIfAborted();
        agent.model.select(selected);
        if (await sessions.flush(agent.session) !== true)
          fail('model_selection_not_durable', '默认设置可能已保存，但当前会话尚未确认写入；请检查当前设置后重试。');
        signal.throwIfAborted();
        if (!same(agent.model.current(), selected) || !same(defaults.currentSelection(), selected))
          fail('model_selection_readback_changed', '设置保存期间发生了变化，请刷新查看实际选择。');
        return { selected: { ...selected } };
      });
    } catch (error) {
      if (!entered) fail('model_selection_busy', '当前回答仍在进行，请在本次回答结束后保存模型设置。');
      throw error;
    }
  };
}
