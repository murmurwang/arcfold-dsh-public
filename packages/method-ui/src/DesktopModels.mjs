import React, { useEffect, useState } from 'react';
const h = React.createElement, REF = 'DEEPSEEK_API_KEY';

/** Secrets stay in this local input until submitted to DSH's credential API. */
export function DesktopModels({ rpc }) {
  const [info, setInfo] = useState(null), [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  async function refresh() {
    const result = await rpc.call('/api', 'credentials/describe', { args: { refs: [REF] } });
    if (result?.ok !== true) throw new Error('无法读取密钥状态。');
    const value = result.value?.[REF];
    setInfo({ configured: value?.configured === true, writable: value?.writable === true });
  }
  useEffect(() => { let active = true;
    void rpc.call('/api', 'credentials/describe', { args: { refs: [REF] } }).then(result => {
      if (!active) return;
      if (result?.ok !== true) throw new Error('unavailable');
      const value = result.value?.[REF]; setInfo({ configured: value?.configured === true, writable: value?.writable === true });
    }).catch(() => { if (active) setMessage('无法读取密钥状态，请稍后重试。'); });
    return () => { active = false; };
  }, [rpc]);
  async function save() {
    if (!info?.writable || !secret.trim() || busy) return;
    setBusy(true); setMessage('正在保存…');
    try {
      const result = await rpc.call('/api', 'credentials/set', { args: { ref: REF, value: secret } });
      if (result?.ok !== true) throw new Error('unconfirmed');
      await refresh(); setMessage('已保存到 Desktop 的凭据服务。');
    } catch { setMessage('保存结果尚未确认，请刷新状态后再决定。'); }
    finally { setSecret(''); setBusy(false); }
  }
  return h('section', { className: 'arcfold-desktop-setup' }, h('h2', null, 'DeepSeek'),
    h('p', null, '密钥由 DSH 统一保存和使用；Arcfold 不把密钥写进自身数据或费用记录。'),
    h('p', null, !info ? '正在读取密钥状态…' : info.configured ? 'DeepSeek 密钥已配置。' : '尚未配置 DeepSeek 密钥。'),
    h('label', null, 'DeepSeek API 密钥', h('input', { type: 'password', autoComplete: 'off', value: secret,
      disabled: !info?.writable || busy, onChange: event => setSecret(event.target.value) })),
    h('button', { type: 'button', disabled: !info?.writable || !secret.trim() || busy, onClick: () => void save() }, '保存密钥'),
    h('button', { type: 'button', disabled: busy, onClick: () => void refresh().catch(() => setMessage('无法读取密钥状态。')) }, '刷新状态'),
    message && h('p', { role: 'status' }, message));
}
