import React, { useEffect, useState, useSyncExternalStore } from 'react';
const h = React.createElement;
const statuses = { active: '进行中', paused: '暂停', completed: '已完成', abandoned: '已放弃' };
const nodeStatus = node => (statuses[node.status] ?? node.status) + (node.statusOrigin === 'cascade' ? '（随上级）' : node.status === 'completed' && node.statusOrigin === 'model' ? '（助手判断）' : '');
const validation = { unverified: '尚待验证', supported: '有证据支持', contradicted: '不成立', changed: '已变化', invalid: '不成立' };
const categories = { not_understood: '没听懂', misread: '误解', restart: '需要重新对齐', redo: '要求重做', omitted: '漏做', repeated: '重复要求', overdone: '做过头', misreported: '说的与做的不一致', approved: '明确认可', adopted_proposal: '采纳提议', confirmed_inference: '证实推断', proceeded: '接受并推进' };
const sourceNames = { user_expressed: '用户表达', assistant_inferred: '助手推断', unknown: '尚不清楚' };
const useSource = source => useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
function useRead(source, endpoint, payload, refresh = 0) {
  const [value, setValue] = useState({ loading: true });
  const key = JSON.stringify([endpoint, payload, source.getSnapshot?.().epoch ?? 0]);
  const refreshRevision = source.getSnapshot?.().refreshRevision ?? 0;
  // Refresh the same object without unmounting an open item or unsent edit.
  useEffect(() => { let live = true; if (!payload) return;
    source.read(endpoint, payload).then(data => { if (live) setValue({ source, key, data }); }, error => { if (live) setValue({ source, key, error: error.message }); });
    return () => { live = false; };
  }, [source, endpoint, key, refresh, refreshRevision]);
  return value.source === source && value.key === key && payload ? value : { loading: true };
}
const button = (label, onClick, props = {}) => h('button', { type: 'button', onClick, ...props }, label);
const field = (label, value, change, props = {}) => h('label', { className: 'tree-field' }, label, h('input', { value, onChange: e => change(e.target.value), ...props }));
const select = (label, value, change, options, props = {}) => h('label', { className: 'tree-field' }, label, h('select', { 'aria-label': label, value, onChange: e => change(e.target.value), ...props }, options.map(([id, label]) => h('option', { key: id, value: id }, label))));
function ReadState({ value, children }) { return value.error ? h('p', { role: 'alert' }, value.error) : value.loading ? h('p', { role: 'status' }, '正在读取…') : children(value.data); }
function Command({ source, endpoint, payload, children, onDone, disabled = false, className, title }) {
  const state = useSource(source), [id, setId] = useState(null), op = state.operations[id];
  const waiting = op && ['pending', 'unknown', 'not_found', 'partial', 'prepared', 'spawn_intent'].includes(op.state);
  const run = async () => { const requestId = globalThis.crypto.randomUUID(); setId(requestId);
    try { const receipt = await source.act(endpoint, typeof payload === 'function' ? payload() : payload, requestId); if (receipt.state === 'success') onDone?.(receipt.value); } catch {} };
  return h('span', { className: 'tree-command' }, button(children, run, { disabled: disabled || waiting, className, title }), op && h('small', { role: op.state === 'conflict' ? 'alert' : 'status' }, op.state === 'success' ? '已保存' : op.message ?? '结果尚待确认'), waiting && op.state !== 'pending' && button('核对操作结果', () => source.readback(id).catch(() => {})));
}
function StatusDot({ status }) { return h('i', { className: 'tree-dot ' + status, 'aria-hidden': true }); }
function NodeChip({ node, path, source }) {
  const label = (path ?? [node]).map(n => n.name).join(' › ');
  return button(h(React.Fragment, null, h(StatusDot, { status: node.status }), h('span', null, label), h('small', null, nodeStatus(node))), () => source.openDetails(node.id), { className: 'tree-chip', title: label + ' · ' + nodeStatus(node) });
}
function AttributionRange({ source, state }) {
  const range = state.current.attribution, [editing, setEditing] = useState(false), [branch, setBranch] = useState('');
  useEffect(() => setBranch(range?.selection.nodeId ?? ''), [range?.selection.revision]);
  if (!range || !range.blocked && !range.selection.nodeId && !range.pending.length && !editing) return null;
  const payload = pendingId => ({ nodeId: branch || null, expectedTreeRevision: state.treeRevision, expectedSelectionRevision: range.selection.revision, pendingId });
  const options = [['', '整棵目标树'], ...orderedNodes(state.nodes).map(n => {
    const path = [n.name]; let parent = state.nodes.find(p => p.id === n.parentId); const seen = new Set([n.id]);
    while (parent && !seen.has(parent.id)) { seen.add(parent.id); path.unshift(parent.name); parent = state.nodes.find(p => p.id === parent.parentId); }
    return [n.id, path.join(' › ')];
  })];
  return h('section', { className: 'tree-attribution-range', 'aria-label': '本聊天目标范围' },
    range.blocked ? h('p', { role: 'alert' }, range.selectionMissing ? '此前选定的目标已不存在，请重新选择。' : `当前范围有 ${range.count} 个候选，超过一次可检查的 ${range.limit} 个。请选择一支目标后继续。`) : h('p', null, '本聊天只在这支目标下判断归属：' + (range.path.map(n => n.name).join(' › ') || '整棵目标树')),
    h('small', null, '选定范围后，其他分支暂不参与本聊天的归属判断。原话会保留，选择前不调用模型。'),
    (range.blocked || range.pending.length > 0 || editing) ? h(React.Fragment, null,
      select('本聊天使用哪支目标', branch, setBranch, options),
      h(Command, { source, endpoint: 'session.selectBranch', payload: () => payload(null), onDone: () => setEditing(false) }, '保存范围'),
      range.pending.map(p => h('article', { key: p.id }, h('p', null, '等待继续的原话'), h('blockquote', null, p.text),
        p.state === 'waiting' ? h(Command, { source, endpoint: 'session.selectBranch', payload: () => payload(p.id), onDone: () => setEditing(false) }, '选定并继续这条消息') : h('p', { role: 'status' }, p.state === 'queued' ? '已经排入对话，请勿重复发送。' : '继续请求已记录，发送状态待核对；不会自动重发。')))) : button('更改范围', () => { setBranch(range.selection.nodeId ?? ''); setEditing(true); }));
}
export function TreeDock({ source }) {
  const state = useSource(source), [revision, setRevision] = useState(0), detail = useRead(source, 'node.details', state.detailsNodeId ? { nodeId: state.detailsNodeId } : null, revision + state.epoch);
  return h('div', { className: 'arcfold-tree tree-dock', 'aria-label': '当前事项' }, h(AttributionRange, { source, state }), state.current.paths.map(path => path.length ? h(NodeChip, { key: path.at(-1).id, node: path.at(-1), path, source }) : null), state.error && h('small', { role: 'alert' }, state.error),
    state.detailsNodeId && h('div', { role: 'dialog', 'aria-modal': true, 'aria-label': '事项详情', className: 'tree-detail-dialog' }, button('关闭详情', () => source.closeDetails()), h(ReadState, { value: detail }, data => h(NodeDetail, { key: data.node.id, source, detail: data, navigate: id => source.openDetails(id), onDone: () => { setRevision(v => v + 1); void source.refresh(); } }))));
}
const emptyShort = { situation: '', action: '', basis: '', notApplicable: '' };
function ItemEditor({ source, item, onDone, onCancel }) {
  const [expectedVersion] = useState(item.current.version);
  const [text, setText] = useState(typeof item.current.content === 'string' ? item.current.content : ''),
    [short, setShort] = useState(item.kind === 'supplement' ? item.current.content : item.method?.short ?? emptyShort), [long, setLong] = useState(item.method?.long), [reason, setReason] = useState('');
  // A long-only method has no short rule. Send null unless the owner filled one in.
  const methodShort = () => Object.values(short).some(value => value.trim()) ? { ...emptyShort, ...short } : null;
  const replacement = () => item.kind === 'understanding' ? text : item.kind === 'supplement' ? short : { short: methodShort(), long: long ?? null };
  return h('section', { className: 'tree-editor' }, item.kind === 'understanding' ? h('label', null, '理解内容', h('textarea', { value: text, onChange: e => setText(e.target.value), maxLength: 2000 })) : h(React.Fragment, null,
    Object.entries({ situation: '何时适用', action: '怎样做', basis: '依据', notApplicable: '何时不适用' }).map(([key, label]) => field(label, short?.[key] ?? '', value => setShort({ ...short, [key]: value }), { key, maxLength: 200 })),
    long && h('details', null, h('summary', null, '详细方法文字'), Object.entries({ name: '名称', description: '说明', whenToUse: '适用情境', steps: '步骤', pitfalls: '注意点', verify: '如何检查' }).map(([key, label]) => h('label', { key }, label, h('textarea', { value: long[key] ?? '', onChange: e => setLong({ ...long, [key]: e.target.value }) }))))),
    field('修改理由', reason, setReason), h('div', { className: 'tree-item-actions' }, h(Command, { source, endpoint: 'item.edit', className: 'tree-primary', disabled: !reason.trim() || item.kind === 'understanding' && !text.trim(), payload: () => ({ itemId: item.id, expectedVersion, replacement: replacement(), reason }), onDone }, '保存修改'), button('取消', onCancel)));
}
function ItemCard({ source, item, relatedItems = [], onDone }) {
  const [editing, setEditing] = useState(false), [deleting, setDeleting] = useState(false), current = item.current, method = item.method;
  const evaluation = item.evaluations?.filter(e => e.version === current.version).at(-1), short = method?.short ?? current.content?.short ?? current.content;
  const label = typeof current.content === 'string' ? current.content : method?.long?.name ?? short?.action ?? '查看内容';
  const active = item.lifecycle === 'active';
  const replacement = relatedItems.find(candidate => candidate.id === item.replacedBy);
  const facts = method || typeof current.content !== 'string' ? [
    ['何时用', short?.situation], ['怎样做', short?.action],
    ['预期', method?.expectation?.text ?? '尚未设定'],
    ['检验', evaluation ? ({ met: '达到预期', not_met: '未达到预期', unclear: '尚不清楚' }[evaluation.result] ?? '尚不清楚') + (evaluation.observed ? ' · ' + evaluation.observed : '') : '尚待检验'],
  ] : [];
  return h('details', { className: 'tree-item', 'data-item-id': item.id },
    h('summary', null, h('span', null, label), !active && h('small', null, ({ invalid: '已更正', changed: '已变化', draft: '待采用' })[item.lifecycle] ?? '已停止采用')),
    h('div', { className: 'tree-item-detail' },
      h('div', { className: 'tree-item-actions' },
        item.kind === 'understanding' && current.sourceKind === 'assistant_inferred' && active && !item.stale && h(Command, { source, endpoint: 'item.confirm', className: 'tree-primary', payload: { itemId: item.id, expectedVersion: current.version }, onDone }, '确认'),
        method && active && (item.hooks ?? []).map(hook => h(Command, { key: hook.id, source, endpoint: 'hook.disable', disabled: !hook.enabled || item.stale, title: item.hooks.length > 1 ? hook.message : undefined, payload: { methodId: item.id, hookId: hook.hookId, expectedVersion: current.version }, onDone }, hook.enabled ? '停用' : '已停用')),
        active && button('修改', () => { setEditing(true); setDeleting(false); }, { disabled: editing }),
        ['active', 'draft'].includes(item.lifecycle) && button('删除', () => { setDeleting(true); setEditing(false); }, { className: 'tree-danger', disabled: deleting })),
      deleting && h('div', { className: 'tree-delete-confirm' }, h('p', null, '删除这条内容？'), h(Command, { source, endpoint: 'item.withdraw', className: 'tree-danger', payload: { itemId: item.id, expectedVersion: current.version, reason: '用户在目标树中删除此条内容' }, onDone }, '确认删除'), button('取消', () => setDeleting(false))),
      editing && h(ItemEditor, { source, item, onDone: () => { setEditing(false); onDone(); }, onCancel: () => setEditing(false) }),
      facts.length > 0 && h('div', { className: 'tree-method-description' }, h('dl', null, facts.map(([name, value]) => h('div', { key: name }, h('dt', null, name), h('dd', { className: name === '检验' && evaluation ? 'tree-evaluation-' + evaluation.result : undefined }, value || '尚未填写')))),
        (short?.basis || short?.notApplicable || method?.long || item.scripts?.length) && h('details', { className: 'tree-method-more' }, h('summary', null, '完整说明'),
          short?.basis && h('p', null, short.basis), short?.notApplicable && h('p', null, '不适用：' + short.notApplicable),
          method?.long && Object.entries({ description: '说明', whenToUse: '适用情境', steps: '步骤', pitfalls: '注意点', verify: '如何检查' }).filter(([key]) => method.long[key]).map(([key, name]) => h('div', { key }, h('strong', null, name), h('p', null, method.long[key]))),
          (item.scripts ?? []).filter(script => script.usage).map(script => h('p', { key: script.id }, script.usage)))),
      item.stale && h('p', { role: 'status', className: 'tree-muted' }, item.sourceReview?.status === 'needs_evidence' ? '归属已变化，现有证据不足，暂不使用：' + item.sourceReview.reason : '归属已变化，此条暂不使用；请核对内容。'),
      replacement && ['invalid', 'changed'].includes(item.lifecycle) && h('details', null, h('summary', null, '撤销自动更正'), h('p', null, '恢复原理解，并撤回系统生成的替代理解。'),
        h(Command, { source, endpoint: 'item.undoCorrection', payload: { itemId: item.id, expectedRevision: item.revision, replacementId: replacement.id, expectedReplacementRevision: replacement.revision }, onDone }, '确认撤销更正'))));
}
function NodeDetail({ source, detail, onDone, navigate = id => source.select(id) }) {
  const { node, summary } = detail, [name, setName] = useState(node.name), [nameRevision, setNameRevision] = useState(node.revision);
  const items = detail.items.filter(item => item.lifecycle !== 'withdrawn');
  return h('section', { className: 'tree-detail' },
    h('nav', { className: 'tree-breadcrumbs', 'aria-label': '目标路径' }, detail.path.slice(0, -1).map(n => h(React.Fragment, { key: n.id }, button(n.name, () => navigate(n.id), { title: n.name }), h('span', { 'aria-hidden': true }, '›')))),
    h('details', { className: 'tree-node-title' }, h('summary', { onClick: e => { if (!e.currentTarget.parentElement.open) { setName(node.name); setNameRevision(node.revision); } } }, h('h2', null, node.name)),
      h('div', { className: 'tree-editor' }, field('事项名称', name, setName, { maxLength: 80 }), h(Command, { source, endpoint: 'node.rename', className: 'tree-primary', disabled: !name.trim() || name === node.name, payload: () => ({ nodeId: node.id, name, expectedRevision: nameRevision }), onDone }, '保存名称'))),
    h('p', { className: 'tree-node-status' }, h(StatusDot, { status: node.status }), nodeStatus(node)),
    h('section', { className: 'tree-panel tree-summary' }, h('h3', null, '当前摘要'), summary ? h('div', { className: 'tree-summary-copy' },
      h('p', null, summary.oneLine), summary.body.status && summary.body.status !== summary.oneLine && h('p', null, summary.body.status),
      h('details', { className: 'tree-summary-more' }, h('summary', null, '展开完整摘要'),
        summary.body.outputs.length > 0 && h(React.Fragment, null, h('h4', null, '已有产出'), h('ul', null, summary.body.outputs.map((text, i) => h('li', { key: i }, text)))),
        summary.body.decisions.length > 0 && h(React.Fragment, null, h('h4', null, '已作出的决定'), h('ul', null, summary.body.decisions.map((decision, i) => h('li', { key: i }, decision.what)))),
        summary.body.next && h('p', null, '下一步：' + summary.body.next), summary.body.pending.length > 0 && h(React.Fragment, null, h('h4', null, '待确认'), h('ul', null, summary.body.pending.map((text, i) => h('li', { key: i }, text)))))) : h('p', { className: 'tree-empty' }, '还没有整理出的摘要。')),
    h('div', { className: 'tree-detail-grid' },
      ...[['理解', items.filter(item => item.kind === 'understanding')], ['方法', items.filter(item => item.kind !== 'understanding')]].map(([label, entries]) => h('section', { className: 'tree-panel', key: label }, h('h3', null, label, h('small', null, entries.length + ' 条')), entries.length ? entries.map(item => h(ItemCard, { key: item.id, source, item, relatedItems: detail.items, onDone })) : h('p', { className: 'tree-empty' }, label === '理解' ? '还没有理解。' : '还没有方法。'))),
      h('section', { className: 'tree-panel' }, h('h3', null, '子节点', h('small', null, detail.children.length ? detail.children.length + ' 个' : '无')), detail.children.length ? detail.children.map(child => button(h(React.Fragment, null, h(StatusDot, { status: child.status }), h('span', null, child.name), h('span', { 'aria-hidden': true }, '›')), () => navigate(child.id), { key: child.id, className: 'tree-child', title: child.name })) : h('p', { className: 'tree-empty' }, '还没有子节点。')),
      h('section', { className: 'tree-panel' }, h('h3', null, '扩大范围记录', h('small', null, detail.promotionHistory.length + ' 条')), detail.promotionHistory.length ? detail.promotionHistory.map(row => h('p', { key: row.itemId }, row.reason ?? '此条内容已扩大适用范围。')) : h('p', { className: 'tree-empty' }, '暂无扩大范围记录。'))));
}
function Parameter({ source, node, parameter, onDone }) {
  const [value, setValue] = useState(String(parameter.value)), days = parameter.name === 'retentionDays';
  return h('section', null, field(days ? '结束后保留在候选中的天数' : '离开多久后整理（小时）', value, setValue, { type: 'number', min: 1, max: days ? 365 : 168 }), h('small', null, parameter.local?.actor.kind === 'user' ? '由你设置，后台不会覆盖。' : '当前值来自默认设置或上级事项。'), h(Command, { source, endpoint: 'parameters.set', payload: () => ({ nodeId: node.id, name: parameter.name, value: Number(value), expectedRevision: parameter.local?.revision ?? 0 }), onDone }, '保存设置'));
}
const metricCards = [
  { title: '默契', label: '次需要重新对齐', count: o => o.rates.understandingProblems.numerator },
  { title: '可靠', label: '次要求重做', count: o => o.counts.redo },
  { title: '精进', label: '次重复纠正', count: o => o.rates.recurrence.numerator },
];
function Metrics({ source, refresh }) {
  const value = useRead(source, 'metrics.read', {}, refresh);
  return h(ReadState, { value }, data => {
    const current = data.observations, comparable = data.comparison?.comparable && data.windows?.length === 2 && data.windows[1].fromOrdinal === data.fromOrdinal && data.windows[1].toOrdinal === data.toOrdinal, previous = comparable ? data.windows[0].observations : null;
    const growth = current.growth, hasData = current.logicalTurns > 0;
    return h('section', { className: 'tree-page tree-metrics', 'aria-label': '指标' },
      h('header', { className: 'tree-page-heading' }, h('div', null, h('h2', null, '三个特征'), h('p', null, '一起做事的现状与变化')), h('small', null, hasData ? '最近 ' + current.logicalTurns + ' 轮对话' : '暂无对话记录')),
      h('div', { className: 'tree-metric-grid' }, metricCards.map(metric => {
        const now = hasData ? metric.count(current) : null, points = comparable ? data.windows.map(w => metric.count(w.observations)) : [];
        const max = Math.max(1, ...points), coordinates = points.map((n, i) => (10 + i * 240) + ',' + (68 - n / max * 50)).join(' ');
        return h('article', { className: 'tree-panel tree-metric-card', key: metric.title }, h('h3', null, metric.title),
          h('div', { className: 'tree-metric-value' }, now ?? '—', h('small', null, metric.label)),
          h('p', { className: 'tree-muted' }, previous ? '前一观察阶段 ' + metric.count(previous) + ' 次（' + previous.logicalTurns + ' 轮）' : '暂无可比较的历史记录'),
          points.length > 1 ? h('svg', { className: 'tree-chart', viewBox: '0 0 260 80', role: 'img', 'aria-label': '前后两个观察阶段：' + points.join('、') + '次' }, h('path', { d: 'M10 72H250', className: 'tree-chart-base' }), h('polyline', { points: coordinates }), points.map((n, i) => h('circle', { key: i, cx: 10 + i * 240, cy: 68 - n / max * 50, r: 3 }))) : h('div', { className: 'tree-chart-empty' }, hasData ? '积累更多记录后显示趋势' : '暂无数据'));
      })),
      h('section', { className: 'tree-panel tree-outcomes' }, h('h3', null, '自主的拓展'), h('div', { className: 'tree-outcome-grid' }, [
        ['用户确认的变化', growth.confirmedUserChanges], ['新建目标', growth.byType.created],
        ['作出取舍', growth.userStatusChoices.paused + growth.userStatusChoices.abandoned], ['确认完成', growth.userStatusChoices.completed],
      ].map(([label, count]) => h('div', { key: label }, h('span', null, label), h('strong', null, hasData ? count : '—'))))));
  });
}
function Reports({ source, refresh }) {
  const [cursor, setCursor] = useState(null), [selected, setSelected] = useState(null), [includeEvidence, setEvidence] = useState(false), [preview, setPreview] = useState(null), [download, setDownload] = useState(null);
  const value = useRead(source, 'reports.list', { ...(cursor ? { cursor } : {}), limit: 50 }, refresh);
  useEffect(() => { let live = true; setPreview(null); setDownload(null); if (selected) source.read('reports.details', { reportId: selected.reportId, includeEvidence }).then(value => { if (live) setPreview(value); }).catch(error => { if (live) setPreview({ error: error.message }); }); return () => { live = false; }; }, [source, selected, includeEvidence]);
  useEffect(() => () => { if (download) URL.revokeObjectURL(download.url); }, [download]);
  const open = report => { setSelected(selected?.reportId === report.reportId ? null : report); setEvidence(false); };
  return h('section', { className: 'tree-page tree-reports' },
    h('header', { className: 'tree-page-heading' }, h('div', null, h('h2', null, '给开发者的报告'), h('p', null, '需要从系统本身改进的问题'))),
    h(ReadState, { value }, data => h(React.Fragment, null,
      data.reports.length ? h('div', { className: 'tree-panel tree-report-list' }, data.reports.map(report => h('article', { className: 'tree-report', key: report.reportId },
        button(h(React.Fragment, null, h('span', null, report.category ?? '问题报告'), h('span', { 'aria-hidden': true }, selected?.reportId === report.reportId ? '⌄' : '›')), () => open(report), { className: 'tree-report-toggle', 'aria-expanded': selected?.reportId === report.reportId, 'aria-label': report.category ?? '问题报告' }),
        selected?.reportId === report.reportId && h('div', { className: 'tree-report-detail' },
          preview?.error ? h('p', { role: 'alert' }, preview.error) : !preview ? h('p', { role: 'status' }, '正在读取…') :
            h('div', { className: 'tree-method-description' }, h('dl', null, [
              ['当前状态', ({ unhandled: '待开发者处理', accepted: '已处理', rejected: '未采用', exported: '已导出' })[preview.status] ?? '等待核对'],
              ['发生了什么', preview.problem], ['影响环节', preview.step], ['影响范围', preview.whyUniversal], ['改进建议', preview.suggestedFix],
              ['相关材料', preview.includesEvidence ? preview.evidenceRefs.length + ' 条记录将随报告导出' : '未附原始证据'],
            ].map(([label, text]) => h('div', { key: label }, h('dt', null, label), h('dd', null, text))))),
          h('label', { className: 'tree-report-evidence' }, h('input', { type: 'checkbox', checked: includeEvidence, onChange: e => setEvidence(e.target.checked) }), '附上原始证据'),
          h('div', { className: 'tree-item-actions' }, h(Command, { source, endpoint: 'reports.export', disabled: !preview || Boolean(preview.error), payload: () => ({ reportIds: [selected.reportId], includeEvidence, expectedRevisions: { [selected.reportId]: preview.revision } }), onDone: receipt => { const artifact = receipt.result; setDownload({ url: URL.createObjectURL(new Blob([artifact.content], { type: artifact.mimeType })), filename: artifact.filename }); } }, '生成本地下载'),
            download && h('a', { href: download.url, download: download.filename }, '下载报告')))))) : h('p', { className: 'tree-empty' }, '暂无报告。'),
      data.nextCursor && button('下一页', () => { setSelected(null); setCursor(data.nextCursor); }), cursor && button('回到第一页', () => { setSelected(null); setCursor(null); }))));
}
export function TreeView({ source }) {
  const state = useSource(source), [tab, setTab] = useState('tree'), [revision, setRevision] = useState(0), [drawer, setDrawer] = useState(false);
  const selected = state.nodes.some(n => n.id === state.selection) ? state.selection : state.current.paths?.[0]?.at(-1)?.id ?? state.nodes.find(n => !n.parentId)?.id;
  const detail = useRead(source, 'node.details', selected ? { nodeId: selected } : null, revision + state.epoch);
  const reload = () => { setRevision(v => v + 1); void source.refresh(); }, navigate = id => { source.select(id); setDrawer(false); };
  return h('div', { className: 'arcfold-tree tree-view' },
    h('header', { className: 'tree-toolbar' }, h('nav', { 'aria-label': 'Arcfold 内容' },
      button('选目标', () => setDrawer(!drawer), { className: 'tree-mobile-toggle', 'aria-expanded': drawer }),
      ...[['tree', '目标树'], ['metrics', '指标'], ['reports', '给开发者的报告']].map(([id, label]) => button(label, () => { setTab(id); setDrawer(false); }, { key: id, 'aria-pressed': tab === id }))),
      button('刷新', reload, { className: 'tree-refresh' })),
    state.error && h('p', { role: 'alert' }, state.error), h(AttributionRange, { source, state }),
    tab === 'reports' ? h(Reports, { source, refresh: revision }) : tab === 'metrics' ? h(Metrics, { source, refresh: revision }) :
      h('div', { className: 'tree-columns' + (drawer ? ' tree-drawer-open' : ''), onKeyDown: e => { if (e.key === 'Escape') setDrawer(false); } },
        drawer && button('关闭目标列表', () => setDrawer(false), { className: 'tree-scrim', tabIndex: -1 }),
        h(TreeNavigation, { nodes: state.nodes, selected, navigate }),
        h('div', { className: 'tree-detail-scroll' }, selected ? h(ReadState, { value: detail }, data => h(NodeDetail, { key: data.node.id, source, detail: data, onDone: reload, navigate })) : h('p', { className: 'tree-empty' }, state.loading ? '正在读取目标树…' : '还没有目标。'))));
}
function TreeNavigation({ nodes, selected, navigate }) {
  const [query, setQuery] = useState(''), [collapsed, setCollapsed] = useState(new Set());
  const byId = new Map(nodes.map(n => [n.id, n])), queryText = query.trim().toLocaleLowerCase();
  const ancestors = id => { const result = [], seen = new Set([id]); let node = byId.get(id); while (node?.parentId && !seen.has(node.parentId)) { seen.add(node.parentId); result.push(node.parentId); node = byId.get(node.parentId); } return result; };
  // Opening a node from a breadcrumb or child link also reveals its tree row.
  useEffect(() => { setCollapsed(old => new Set([...old].filter(id => !ancestors(selected).includes(id)))); }, [selected]);
  const matches = new Set(nodes.filter(n => n.name.toLocaleLowerCase().includes(queryText)).flatMap(n => [n.id, ...ancestors(n.id)]));
  const visible = orderedNodes(nodes).filter(n => queryText ? matches.has(n.id) : !ancestors(n.id).some(id => collapsed.has(id)));
  const toggle = id => setCollapsed(old => { const next = new Set(old); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const keyboard = (event, node, index) => {
    let target;
    if (event.key === 'ArrowDown') target = visible[Math.min(index + 1, visible.length - 1)];
    if (event.key === 'ArrowUp') target = visible[Math.max(index - 1, 0)];
    if (event.key === 'Home') target = visible[0]; if (event.key === 'End') target = visible.at(-1);
    if (event.key === 'ArrowLeft') { if (!collapsed.has(node.id) && nodes.some(n => n.parentId === node.id) && !queryText) toggle(node.id); else target = byId.get(node.parentId); }
    if (event.key === 'ArrowRight') { if (collapsed.has(node.id) && !queryText) toggle(node.id); else target = nodes.find(n => n.parentId === node.id); }
    if (/^(Arrow|Home|End)/.test(event.key)) event.preventDefault();
    if (target) { const buttons = event.currentTarget.closest('[role=tree]').querySelectorAll('[role=treeitem]'); [...buttons].find(b => b.dataset.nodeId === target.id)?.focus(); }
  };
  return h('aside', { className: 'tree-pane', 'aria-label': '目标树' },
    h('label', { className: 'tree-search' }, h('span', null, '搜索目标'), h('input', { type: 'search', value: query, placeholder: '搜索目标…', onChange: e => setQuery(e.target.value) })),
    h('div', { className: 'tree-list', role: 'tree', 'aria-label': '所有目标' }, visible.map((node, index) => {
      const branch = nodes.some(n => n.parentId === node.id), expanded = queryText ? true : !collapsed.has(node.id), depth = ancestors(node.id).length;
      return h('div', { key: node.id, className: 'tree-row' + (selected === node.id ? ' selected' : ''), style: { paddingInlineStart: Math.min(depth, 5) * 14 } },
        branch ? button(expanded ? '⌄' : '›', () => toggle(node.id), { className: 'tree-disclosure', title: (expanded ? '收起' : '展开') + node.name, 'aria-label': (expanded ? '收起' : '展开') + node.name, 'aria-expanded': expanded, disabled: Boolean(queryText) }) : h('span', { className: 'tree-disclosure-placeholder' }),
        button(h(React.Fragment, null, h(StatusDot, { status: node.status }), h('span', { className: 'tree-node-name' }, node.name), node.statusOrigin === 'cascade' && h('small', null, '随上级')), () => navigate(node.id), { role: 'treeitem', 'aria-level': depth + 1, 'aria-selected': selected === node.id, ...(branch ? { 'aria-expanded': expanded } : {}), className: 'tree-node', 'data-node-id': node.id, title: node.name + ' · ' + nodeStatus(node), onKeyDown: event => keyboard(event, node, index) }));
    }), !visible.length && h('p', { className: 'tree-empty' }, '没有找到匹配的目标。')),
    h('div', { className: 'tree-legend' }, Object.entries(statuses).map(([status, label]) => h('span', { key: status }, h(StatusDot, { status }), label))));
}
function orderedNodes(nodes) {
  const result = [], seen = new Set(), visit = node => { if (seen.has(node.id)) return; seen.add(node.id); result.push(node); nodes.filter(n => n.parentId === node.id).forEach(visit); };
  nodes.filter(n => !n.parentId || !nodes.some(parent => parent.id === n.parentId)).forEach(visit); nodes.forEach(visit); return result;
}
function CorrectTurn({ source, detail, state, onDone }) {
  const [targets, setTargets] = useState(detail.turn.nodeIds), [create, setCreate] = useState(false), [name, setName] = useState(''), [parent, setParent] = useState(state.nodes.find(n => !n.parentId)?.id ?? '');
  return h('details', null, h('summary', null, '纠正本轮归属'), state.nodes.map(n => h('label', { key: n.id, className: 'tree-check' }, h('input', { type: 'checkbox', checked: targets.includes(n.id), onChange: e => setTargets(e.target.checked ? [...targets, n.id] : targets.filter(id => id !== n.id)) }), n.name)),
    h('label', null, h('input', { type: 'checkbox', checked: create, onChange: e => setCreate(e.target.checked) }), '新建事项或下级事项'), create && h(React.Fragment, null, field('新事项名称', name, setName, { maxLength: 80 }), select('上级事项', parent, setParent, state.nodes.map(n => [n.id, n.name]))),
    h(Command, { source, endpoint: 'turn.correct', disabled: !targets.length && !create || create && !name.trim(), payload: () => ({ turnId: detail.turn.id, nodeIds: targets, expectedAssignmentRevision: detail.turn.assignmentRevision, ...(create ? { create: { name, parentId: parent, expectedTreeRevision: state.treeRevision } } : {}) }), onDone }, '移动本轮经历'));
}
function Restore({ source, turnId }) {
  const [open, setOpen] = useState(false), [preview, setPreview] = useState(null), [paths, setPaths] = useState([]), [selected, setSelected] = useState(null);
  const list = useRead(source, 'snapshots.list', open ? { logicalTurnId: turnId } : null);
  if (!open) return button('恢复到这一轮之前', () => setOpen(true));
  const showPreview = value => { setPreview(value); setPaths(value.changes.map(c => c.path)); };
  const renderContent = (label, content) => h('section', { key: label },
    h('strong', null, label),
    h('pre', null, !content ? '不存在' : content.binary ? '二进制文件；' + content.size + ' 字节，校验值 ' + content.sha256 : content.text),
    content?.truncated && h('small', null, '仅展示前 64 KiB；恢复操作针对完整文件。'));
  const diffs = preview?.diffs.map(diff => h('article', { key: diff.path },
    h('label', null, h('input', { type: 'checkbox', checked: paths.includes(diff.path), onChange: e => setPaths(e.target.checked ? [...paths, diff.path] : paths.filter(p => p !== diff.path)) }), diff.path),
    h('div', { className: 'tree-diff' }, renderContent('当前内容', diff.current), renderContent('恢复为', diff.restoreTo))));
  return h('section', { className: 'tree-restore' },
    h('h4', null, '恢复前核对'), h('p', null, '恢复会覆盖所选文件。先检查变化，再确认；不会自动恢复。'),
    h(ReadState, { value: list }, data => h(React.Fragment, null,
      !data.snapshots.length && h('p', null, '这一轮没有可用快照。'),
      data.snapshots.map(snapshot => h('article', { key: snapshot.id },
        h('p', null, snapshot.coverage.state === 'full' ? '覆盖可保存的工作区内容' : '部分内容未覆盖'),
        h('pre', null, JSON.stringify(snapshot.coverage.exclusions, null, 2)),
        h(Command, { source, endpoint: 'snapshots.preview', payload: { snapshotId: snapshot.id, paths: null }, onDone: value => { setSelected(snapshot.id); showPreview(value); } }, '查看变化'))))),
    preview && h(React.Fragment, null, diffs,
      h(Command, { source, endpoint: 'snapshots.preview', disabled: !paths.length, payload: () => ({ snapshotId: selected, paths }), onDone: showPreview }, '更新所选文件的预览'),
      h(Command, { source, endpoint: 'snapshots.restore', disabled: !preview.changes.length || JSON.stringify([...paths].sort()) !== JSON.stringify(preview.changes.map(c => c.path).sort()), payload: { previewId: preview.id, expectedHashes: preview.expectedCurrentHashes }, onDone: () => setPreview(null) }, '确认恢复这些文件')),
    button('关闭', () => setOpen(false)));
}
function SignalCorrection({ source, signal, onDone }) {
  const [category, setCategory] = useState(signal.category);
  return h('span', null, select('纠正类别', category, setCategory, Object.entries(categories)), h(Command, { source, endpoint: 'signal.correct', disabled: category === signal.category, payload: () => ({ signalId: signal.id, category, expectedRevision: signal.revision }), onDone }, '保存类别'));
}
function BackgroundStatus({ jobs }) {
  const states = jobs.filter(j => j.current !== false && !['main', 'attribution'].includes(j.role)).map(j => j.status);
  const describeRejected = item => {
    const name = ({ categories: '反馈分类', understandings: '理解', revisions: '理解更正', methods: '方法',
      operations: '检验建议', verifications: '方法检验', probes: '待核事项', missed: '待核发现', formatFixes: '格式建议',
      clusters: '共同问题判断', supplements: '补充做法', parameters: '设置建议', observations: '对话观察', proposals: '新建议' })[item.item.split(/[.\[]/)[0]] ?? '后台内容';
    const reason = ({ OUTPUT_REFERENCE: '引用不在本次材料中', OUTPUT_CURRENT_SOURCE: '引用不是本轮用户原话',
      OUTPUT_PROTECTED: '内容受到用户保护', USER_SOURCE_REQUIRED: '缺少用户原话依据', OUTPUT_VERSION: '引用的内容版本已变化',
      INVALID_OUTPUT: '内容格式不完整', CORRECTION_LIMIT: '本轮只保存一条纠正' })[item.code] ?? '来源、范围或内容格式未通过检查';
    return `${name}：${reason}`;
  };
  return h(React.Fragment, null,
    states.some(s => ['prepared', 'submitted', 'result_received', 'validated'].includes(s)) ? h('p', { role: 'status' }, '后台正在补学或检验本轮内容。') :
      states.some(s => ['queued', 'pending'].includes(s)) && h('p', { role: 'status' }, '本轮内容等待后台处理。'),
    states.includes('unknown') && h('p', { role: 'status' }, '本轮后台处理结果尚不确定，系统未重复发送。'),
    states.some(s => ['failed', 'invalid_output'].includes(s)) && h('p', { role: 'status' }, '本轮部分后台学习或检验未完成，失败记录已保留。'),
    jobs.some(j => j.current !== false && j.rejectedItems?.length) && h(React.Fragment, null,
      h('p', { role: 'status' }, '本轮部分后台内容未通过检查，其他合格内容已保留。'),
      h('details', null, h('summary', null, '查看未采用的内容'), jobs.filter(j => j.current !== false && j.rejectedItems?.length).flatMap(j =>
        j.rejectedItems.map((item, index) => h('p', { key: j.id + ':' + index }, describeRejected(item)))))));
}
export function TreeTurnTail() { return null; }
