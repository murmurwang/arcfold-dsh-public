import React, { useState } from 'react';

const h = React.createElement;
export function DesktopSetup({ initial, rpc, openWorkspace }) {
  const [info, setInfo] = useState(initial), [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const native = info.modelRouting === 'dsh-native-v1', upgrade = info.state === 'needs_upgrade';
  async function refresh() {
    const reply = await rpc.call('/api', 'arcfoldDesktop/status', { args: { request: {} } });
    if (reply?.ok !== true) throw new Error('无法读取设置状态。');
    setInfo(reply.value); return reply.value;
  }
  async function open(path) {
    if (typeof openWorkspace !== 'function') throw new Error('DSH 工作区服务尚未就绪。');
    await openWorkspace(path); globalThis.location.reload();
  }
  async function start() {
    if (!checked || busy) return;
    setBusy(true); setMessage(upgrade ? '正在保存模型通道设置并启动 Arcfold…' : '正在创建独立数据并启动 Arcfold…');
    let initialized = false;
    try {
      const result = await rpc.call('/api', 'arcfoldDesktop/start', { args: { request: { confirmed: true } } });
      if (result?.ok !== true) throw new Error('设置结果尚未确认。');
      setInfo(result.value);
      if (result.value?.state === 'ready') { initialized = true; setMessage('设置完成，正在打开独立工作区。'); await open(result.value.workspace); return; }
      setMessage('设置尚未完成，请查看当前状态。');
    } catch { setMessage(initialized ? '设置已完成，但工作区未能打开。请重试打开工作区。' : '设置结果尚未确认，请刷新状态，不要重复提交。'); try { await refresh(); } catch {} }
    finally { setBusy(false); }
  }
  const refreshButton = h('button', { type: 'button', onClick: () => void refresh().catch(() => setMessage('无法读取设置状态。')) }, '刷新状态');
  if (!['needs_setup', 'needs_upgrade'].includes(info.state)) return h('section', { className: 'arcfold-desktop-setup' },
    h('h2', null, 'Arcfold 设置'), h('p', null, info.state === 'configured' ? '正在读取已保存的设置。' :
      info.state === 'ready' ? 'Arcfold 已就绪。' : 'Arcfold 尚未完成启动，请保留已有数据并检查设置。'),
    info.activationError && h('p', { role: 'alert' }, info.activationError), message && h('p', { role: 'status' }, message),
    info.state === 'ready' && h('button', { type: 'button', disabled: busy, onClick: () => { setBusy(true); void open(info.workspace).catch(() => setMessage('无法打开工作区，请稍后重试。')).finally(() => setBusy(false)); } }, '打开 Arcfold 工作区'), refreshButton);
  return h('section', { className: 'arcfold-desktop-setup' },
    h('h2', null, upgrade ? '沿用 DSH 的模型设置' : '开始使用 Arcfold'),
    h('p', null, upgrade ? '已有聊天、目标、经历和旧费用记录继续保留。确认后，Arcfold 使用 DSH 原生模型通道。'
      : 'Arcfold 会在 Desktop 中保存独立的目标、经历和调用记录。其他版本已有的数据不会自动导入。'),
    h('p', null, '工作区：', h('code', null, info.workspace)),
    h('p', null, '数据位置：', h('code', null, info.dataRoot)),
    h('p', null, native ? '在 DSH“设置 → 模型”配置服务商，在聊天输入框选择模型和思考强度。主回答及相关后台处理沿用这一轮的选择。'
      : '主对话和相关后台处理使用当前对话选择的模型；不同后台任务保留各自的思考设置。完成后可在“设置 → 模型”配置 DeepSeek 密钥。'),
    h('p', null, native ? '一轮进行中换模型，从下一轮开始生效。已经排队的后台任务继续使用其来源对话的选择。跨多轮整理使用最新相关对话的选择；缺少来源时会停止并说明原因。'
      : '跨多段对话自动整理时，使用最新相关对话的模型；没有关联对话时使用默认模型。'),
    h('p', null, native ? '后台处理也会调用所选模型，可能产生额外费用。本机不设消费上限；只记录服务商返回的用量，缺少用量或价格时标为未知，实际扣费以服务商为准。'
      : '模型服务会产生费用。这里记录请求和估算费用，但不设本地消费上限；实际扣费以服务商为准。'),
    !native && h('p', null, '当前估算价格资料核对日期：', info.priceReviewedAt, '。'),
    h('button', { type: 'button', 'aria-pressed': checked, onClick: () => setChecked(value => !value) },
      checked ? '已确认：模型调用可能产生费用，本机不设消费上限' : '确认：模型调用可能产生费用，本机不设消费上限'),
    h('div', null, h('button', { type: 'button', disabled: !checked || busy, onClick: () => void start() }, busy ? '正在设置…' : upgrade ? '确认并启用' : '创建并开始'), ' ', refreshButton),
    message && h('p', { role: 'status' }, message));
}
