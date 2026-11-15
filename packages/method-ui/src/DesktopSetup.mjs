import React, { useState } from 'react';

const h = React.createElement;
export function DesktopSetup({ initial, rpc, openWorkspace }) {
  const [info, setInfo] = useState(initial), [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
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
    setBusy(true); setMessage('正在创建独立数据并启动 Arcfold…');
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
  if (info.state !== 'needs_setup') return h('section', { className: 'arcfold-desktop-setup' },
    h('h2', null, 'Arcfold 设置'), h('p', null, info.state === 'configured' ? '正在读取已保存的设置。' :
      info.state === 'ready' ? 'Arcfold 已就绪。' : 'Arcfold 尚未完成启动，请保留已有数据并检查设置。'),
    info.activationError && h('p', { role: 'alert' }, info.activationError), message && h('p', { role: 'status' }, message),
    info.state === 'ready' && h('button', { type: 'button', disabled: busy, onClick: () => { setBusy(true); void open(info.workspace).catch(() => setMessage('无法打开工作区，请稍后重试。')).finally(() => setBusy(false)); } }, '打开 Arcfold 工作区'), refreshButton);
  return h('section', { className: 'arcfold-desktop-setup' },
    h('h2', null, '开始使用 Arcfold'),
    h('p', null, 'Arcfold 会在 Desktop 中保存独立的目标、经历和费用记录。其他版本已有的数据不会自动导入。'),
    h('p', null, '工作区：', h('code', null, info.workspace)),
    h('p', null, '数据位置：', h('code', null, info.dataRoot)),
    h('p', null, '主对话和与其相关的后台处理使用当前对话选择的模型；不同后台任务保留各自的思考设置。完成后可在“设置 → 模型”中配置 DeepSeek 密钥。'),
    h('p', null, '跨多段对话自动整理时，使用最新相关对话的模型；没有关联对话时使用默认模型。'),
    h('p', null, '模型服务会产生费用。这里记录请求和估算费用，但不设本地消费上限；实际扣费以服务商为准。'),
    h('p', null, '当前估算价格资料核对日期：', info.priceReviewedAt, '。'),
    h('button', { type: 'button', 'aria-pressed': checked, onClick: () => setChecked(value => !value) },
      checked ? '已确认：模型调用可能产生费用，本机不设消费上限' : '确认：模型调用可能产生费用，本机不设消费上限'),
    h('div', null, h('button', { type: 'button', disabled: !checked || busy, onClick: () => void start() }, busy ? '正在设置…' : '创建并开始'), ' ', refreshButton),
    message && h('p', { role: 'status' }, message));
}
