import React, { useEffect, useRef, useState } from 'react';
import type { Group, GroupConfig, Proposal, Task } from '../shared';

const nativeLabels = { media: '文件与音视频', image: '图片与 PDF', render: 'Markdown 渲染', parser: '公开链接解析', rss: 'RSS 订阅', schedule: '定时提醒' };
const nativeIds = Object.keys(nativeLabels) as (keyof typeof nativeLabels)[];

export function NativeGroupSettings({ group, busy, onPreview }: { group: Group; busy: boolean; onPreview(config: GroupConfig): void }) {
  const selected = group.config.nativeFeatures ?? nativeIds;
  return <section className="panel"><div className="section-heading"><h2>本群原生工具开关</h2><span className="version">v{group.version}</span></div>
    <p>控制已经接入的工具能否在本群使用；平台安装、浏览器、媒体服务与凭据仍由平台维护。开关不改变插件全局参数。</p>
    <div className="native-gates">{nativeIds.map(id => <label className="check-field" key={id}>
      <input type="checkbox" checked={selected.includes(id)} disabled={busy} onChange={() => onPreview({ ...group.config,
        nativeFeatures: selected.includes(id) ? selected.filter(value => value !== id) : [...selected, id] })}/>
      <span>{nativeLabels[id]}</span></label>)}</div><p className="inline-note">每次调整都会先生成本群预览，确认后生效。未配置列表的旧群沿用原来的开放行为。</p>
  </section>;
}

type Request = <T>(path: string, body?: unknown) => Promise<T>;
type OwnTask = Task & { pending?: boolean };
type Models = { profiles: { id: string; label: string }[]; selectedId?: string };
export function SessionTools({ groupId, request }: { groupId: string; request: Request }) {
  const [models, setModels] = useState<Models>({ profiles: [] });
  const [tasks, setTasks] = useState<OwnTask[]>([]);
  const [detail, setDetail] = useState<OwnTask>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const mounted = useRef(false);
  async function refresh() {
    const [modelState, history] = await Promise.all([request<Models>(`/groups/${groupId}/models`), request<{ tasks: OwnTask[] }>(`/groups/${groupId}/own-tasks`)]);
    if (mounted.current) { setModels(modelState); setTasks(history.tasks); }
  }
  useEffect(() => {
    mounted.current = true;
    void refresh().catch(() => { if (mounted.current) setMessage('无法读取本人当前对话。'); });
    return () => { mounted.current = false; };
  }, [groupId, request]);
  async function act(operation: () => Promise<void>) {
    setBusy(true); setMessage('');
    try { await operation(); if (mounted.current) await refresh(); }
    catch (error) { if (mounted.current) setMessage((error as Error).message); }
    finally { if (mounted.current) setBusy(false); }
  }
  return <section className="panel"><div className="section-heading"><h2>本人对话设置</h2><button className="text-button" disabled={busy} onClick={() => void act(refresh)}>刷新状态</button></div>
    <p>只保留本人在当前群、相同受众下显式提交的助手问答，最多 12 条消息、24 KB；切换受众会开始新上下文。每次执行仍使用全新沙箱。摘要、翻译、规则解释不会作为聊天历史。</p>
    <div className="plugin-settings"><label className="field">当前对话模型<select value={models.selectedId ?? ''} disabled={busy || !models.profiles.length} onChange={event => {
      const id = event.target.value; void act(async () => { await request(`/groups/${groupId}/model`, { id }); });
    }}>{models.profiles.length ? models.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.label}</option>) : <option value="">平台尚未配置可选模型</option>}</select></label>
      <button className="button secondary" disabled={busy} onClick={() => void act(async () => { await request(`/groups/${groupId}/conversation/reset`, {}); if (mounted.current) setMessage('当前对话上下文已清空，任务历史保留。'); })}>新建对话 / 重置上下文</button></div>
    <p className="inline-note">Telegram：/tasks、/task &lt;ID&gt;、/cancel、/newchat、/models、/model &lt;ID&gt;。</p>
    {message && <p role="status">{message}</p>}
    <details className="own-task-disclosure"><summary>运行任务与临时文件（{tasks.filter(task => task.pending).length} 项执行中）</summary>{!tasks.length ? <p>本人当前群暂无任务。</p> : <div className="table-wrap"><table><thead><tr><th>任务</th><th>状态</th><th>操作</th></tr></thead><tbody>{tasks.slice(0, 20).map(task => <tr key={task.id}>
      <td><strong>{task.featureId}</strong><small>{task.id}</small></td><td>{task.pending ? '执行中' : task.status === 'succeeded' ? '完成' : task.error ?? task.status}</td><td>
        <button disabled={busy} onClick={() => setDetail(task)}>查看结果</button>{task.pending && <button disabled={busy} onClick={() => void act(async () => { await request(`/tasks/${task.id}/cancel`, {}); })}>取消</button>}
      </td></tr>)}</tbody></table></div>}
    {detail && <div className="result-box"><strong>{detail.id}</strong><pre>{detail.pending ? '任务仍在执行，请刷新状态。' : detail.output || detail.error || '无结果。'}</pre>
      {detail.artifact && <a href={`/api/tasks/${encodeURIComponent(detail.id)}/artifact`} download="result.md">领取临时 Markdown 文件（5 分钟内一次）</a>}</div>}</details>
  </section>;
}

export function RuleHistory({ groupId, request, onPreview, disabled = false }: { groupId: string; request: Request; onPreview(proposal: Proposal): void; disabled?: boolean }) {
  const [history, setHistory] = useState<Proposal[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  async function refresh() {
    const value = await request<{ proposals: Proposal[] }>(`/groups/${groupId}/proposals`);
    if (mounted.current) setHistory(value.proposals.filter(proposal => proposal.status === 'active'));
  }
  useEffect(() => {
    mounted.current = true;
    void refresh().catch(failure => { if (mounted.current) setError((failure as Error).message); });
    return () => { mounted.current = false; };
  }, [groupId, request]);
  async function act(operation: () => Promise<void>) {
    setBusy(true); setError('');
    try { await operation(); }
    catch (failure) { if (mounted.current) setError((failure as Error).message); }
    finally { if (mounted.current) setBusy(false); }
  }
  return <section className="panel"><div className="section-heading"><h2>本人本群的规则历史</h2><button className="text-button" disabled={busy || disabled} onClick={() => void act(refresh)}>刷新规则历史</button></div>
    <p>选择一次已启用的调整，预览恢复该次调整前的配置。刷新页面后仍可找回；回滚也需要再次确认，并使用当前版本检查。</p>
    {!history.length ? <p>本人在本群还没有保留的已启用提案。</p> : <div className="table-wrap"><table><thead><tr><th>生效版本 / 时间</th><th>调整内容</th><th>操作</th></tr></thead><tbody>{history.map(previous => <tr key={previous.id}>
      <td><strong>规则 v{previous.baseVersion + 1}</strong><small>{new Date(previous.createdAt).toLocaleString('zh-CN')}</small><small>提案 ID：{previous.id}</small></td>
      <td>{previous.changes.length ? previous.changes.join('；') : '配置保持原值'}</td>
      <td><button className="button secondary" disabled={busy || disabled} onClick={() => void act(async () => {
        const proposal = await request<Proposal>(`/proposals/${encodeURIComponent(previous.id)}/rollback`, {});
        if (proposal.groupId !== groupId) throw new Error('提案不属于当前群。');
        if (mounted.current) onPreview(proposal);
      })}>预览回滚规则 v{previous.baseVersion + 1}</button></td>
    </tr>)}</tbody></table></div>}{error && <p role="alert">{error}</p>}
    <p className="inline-note">只列出当前群、本人创建且仍保留的生效提案，不显示其他管理员或其他群的规则草稿。</p>
  </section>;
}
