import React, { useEffect, useRef, useState } from 'react';
import type { Group, GroupConfig, Proposal, Task } from '../shared';

const nativeLabels = { media: '文件与音视频', image: '图片与 PDF', render: 'Markdown 渲染', parser: '公开链接解析', rss: 'RSS 订阅', schedule: '定时提醒' };
const nativeIds = Object.keys(nativeLabels) as (keyof typeof nativeLabels)[];

export function NativeGroupSettings({ group, busy, onPreview }: { group: Group; busy: boolean; onPreview(config: GroupConfig): void }) {
  const selected = group.config.nativeFeatures ?? nativeIds;
  return <section className="panel"><div className="section-heading"><h2>本群原生工具开关</h2><span className="version">v{group.version}</span></div>
    <p>控制已经接入的工具能否在本群使用；平台安装、浏览器、媒体服务与凭据仍由平台维护。开关不改变插件全局参数。</p>
    <div className="plugin-settings">{nativeIds.map(id => <label className="check-field" key={id}>
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
  return <section className="panel"><div className="section-heading"><h2>本人对话与任务</h2><button className="text-button" disabled={busy} onClick={() => void act(refresh)}>刷新状态</button></div>
    <p>只保留本人在当前群、相同受众下显式提交的助手问答，最多 12 条消息、24 KB；切换受众会开始新上下文。每次执行仍使用全新沙箱。摘要、翻译、规则解释不会作为聊天历史。</p>
    <div className="plugin-settings"><label className="field">当前对话模型<select value={models.selectedId ?? ''} disabled={busy || !models.profiles.length} onChange={event => {
      const id = event.target.value; void act(async () => { await request(`/groups/${groupId}/model`, { id }); });
    }}>{models.profiles.length ? models.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.label}</option>) : <option value="">平台尚未配置可选模型</option>}</select></label>
      <button className="button secondary" disabled={busy} onClick={() => void act(async () => { await request(`/groups/${groupId}/conversation/reset`, {}); if (mounted.current) setMessage('当前对话上下文已清空，任务历史保留。'); })}>新建对话 / 重置上下文</button></div>
    <p className="inline-note">Telegram：/tasks、/task &lt;ID&gt;、/cancel、/newchat、/models、/model &lt;ID&gt;。</p>
    {message && <p role="status">{message}</p>}
    {!tasks.length ? <p>本人当前群暂无任务。</p> : <div className="table-wrap"><table><thead><tr><th>任务</th><th>状态</th><th>操作</th></tr></thead><tbody>{tasks.slice(0, 20).map(task => <tr key={task.id}>
      <td><strong>{task.featureId}</strong><small>{task.id}</small></td><td>{task.pending ? '执行中' : task.status === 'succeeded' ? '完成' : task.error ?? task.status}</td><td>
        <button disabled={busy} onClick={() => setDetail(task)}>查看结果</button>{task.pending && <button disabled={busy} onClick={() => void act(async () => { await request(`/tasks/${task.id}/cancel`, {}); })}>取消</button>}
      </td></tr>)}</tbody></table></div>}
    {detail && <div className="result-box"><strong>{detail.id}</strong><pre>{detail.pending ? '任务仍在执行，请刷新状态。' : detail.output || detail.error || '无结果。'}</pre>
      {detail.artifact && <a href={`/api/tasks/${encodeURIComponent(detail.id)}/artifact`} download="result.md">领取临时 Markdown 文件（5 分钟内一次）</a>}</div>}
  </section>;
}

export function RuleHistory({ groupId, request, onPreview }: { groupId: string; request: Request; onPreview(proposal: Proposal): void }) {
  const [id, setId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return <section className="panel"><h2>恢复之前的规则</h2><p>输入本人在本群已启用的提案 ID，生成恢复之前配置的预览；确认后才会生效。提案 ID 可从群内规则预览消息取得。</p>
    <label className="field">已启用的本群提案 ID<input value={id} onChange={event => setId(event.target.value)} disabled={busy}/></label>
    <button className="button secondary" disabled={busy || !/^[a-zA-Z0-9-]{1,48}$/.test(id)} onClick={async () => {
      setBusy(true); setError('');
      try { const previous = await request<Proposal>(`/proposals/${encodeURIComponent(id)}`); if (previous.groupId !== groupId) throw new Error('请使用当前群的提案 ID。'); const proposal = await request<Proposal>(`/proposals/${encodeURIComponent(id)}/rollback`, {}); onPreview(proposal); }
      catch (failure) { setError((failure as Error).message); }
      finally { setBusy(false); }
    }}>预览回滚</button>{error && <p role="alert">{error}</p>}
  </section>;
}
