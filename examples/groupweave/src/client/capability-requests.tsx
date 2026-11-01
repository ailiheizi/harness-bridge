import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, ClipboardList, RefreshCw, Send } from 'lucide-react';
import type { CapabilityRequest } from '../shared';
import './capability-requests.css';

type Request = <T>(path: string, body?: unknown, signal?: AbortSignal) => Promise<T>;
type Status = CapabilityRequest['status'];
const labels: Record<Status, string> = { submitted: '待处理', reviewing: '处理中', delivered: '已提供', declined: '暂不提供', cancelled: '已撤回' };
const active = (item: CapabilityRequest) => item.status === 'submitted' || item.status === 'reviewing';
const date = (value: string) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

/** Keyed by authenticated actor and group in the parent. This is a business inbox, not plugin installation. */
export function CapabilityRequests({ groupId, groupName, request, disabled = false }: {
  groupId?: string; groupName?: string; request: Request; disabled?: boolean;
}) {
  const platform = !groupId;
  const endpoint = groupId ? `/groups/${encodeURIComponent(groupId)}/capability-requests` : '/platform/capability-requests';
  const [items, setItems] = useState<CapabilityRequest[]>([]);
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [selected, setSelected] = useState<CapabilityRequest>();
  const [reply, setReply] = useState('');
  const [decision, setDecision] = useState<'reviewing' | 'delivered' | 'declined'>('reviewing');
  const [cancelId, setCancelId] = useState('');
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  const locked = useRef(false);
  const mutation = useRef<AbortController | undefined>(undefined);
  const blocked = disabled || busy || loading;

  useEffect(() => () => { generation.current++; mutation.current?.abort(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    const current = ++generation.current;
    setLoading(true); setError(''); setItems([]); setNextOffset(null); setSelected(undefined); setCancelId('');
    const query = new URLSearchParams({ offset: String(offset), ...(status ? { status } : {}) });
    void request<{ requests: CapabilityRequest[]; nextOffset: number | null }>(`${endpoint}?${query}`, undefined, controller.signal)
      .then(data => {
        if (controller.signal.aborted || generation.current !== current) return;
        setItems(data.requests); setNextOffset(data.nextOffset);
        if (!data.requests.length && offset > 0) setOffset(Math.max(0, offset - 50));
      })
      .catch(failure => { if (!controller.signal.aborted && generation.current === current) setError((failure as Error).message); })
      .finally(() => { if (!controller.signal.aborted && generation.current === current) setLoading(false); });
    return () => controller.abort();
  }, [endpoint, offset, status, reload, request]);

  async function mutate(path: string, body: unknown, message: string, after?: () => void) {
    if (locked.current || blocked) return;
    locked.current = true;
    const current = generation.current;
    const controller = new AbortController(); mutation.current = controller;
    setBusy(true); setError(''); setNotice('');
    try {
      await request(path, body, controller.signal);
      if (controller.signal.aborted || current !== generation.current) return;
      after?.(); setNotice(message); setReload(value => value + 1);
    } catch (failure) {
      if (controller.signal.aborted || current !== generation.current) return;
      const problem = failure as Error & { status?: number };
      setError(problem.message);
      if (problem.status === 401 || problem.status === 403 || problem.status === 404) { setItems([]); setSelected(undefined); }
    } finally {
      locked.current = false;
      if (!controller.signal.aborted && current === generation.current) setBusy(false);
    }
  }

  return <div className={`requests-workspace ${platform ? 'platform-requests' : ''}`}>
    <div className="page-title"><div><div className="eyebrow">{platform ? 'GROUP REQUESTS' : 'MAKE ROOM FOR YOUR IDEAS'}</div><h1>{platform ? '群需求' : '能力申请'}</h1><p>{platform ? '查看各群主动提交的需求，说明进度和使用入口。' : `把「${groupName}」想做的事告诉平台，在这里跟进处理结果。`}</p></div></div>
    <div className="requests-layout">
      {!platform && <form className="panel request-form" onSubmit={event => {
        event.preventDefault();
        void mutate(endpoint, { title, details }, '申请已保存，平台管理员可在「群需求」查看。', () => { setTitle(''); setDetails(''); setStatus(''); setOffset(0); });
      }}>
        <div className="panel-heading"><span className="mini-icon"><Send size={19}/></span><div><h2>申请一个功能</h2><p>先描述用途，平台会选择合适的插件或现有能力。</p></div></div>
        <label className="field">想要什么功能<input required maxLength={120} value={title} disabled={blocked} onChange={event => setTitle(event.target.value)} placeholder="例如：群活动报名与人数统计"/></label>
        <label className="field">希望怎么使用<textarea required maxLength={2000} rows={6} value={details} disabled={blocked} onChange={event => setDetails(event.target.value)} placeholder="谁来使用、在什么情况下使用、希望得到什么结果？也可以附上公开插件名称。"/></label>
        <p className="inline-note">用途和平台回复对本群管理员、平台管理员可见。请勿填写密码、Token 或私人聊天记录。</p>
        <button className="button primary full" disabled={blocked || !title.trim() || !details.trim()}><Send size={15}/>提交能力申请</button>
        <p className="inline-note">不会自动安装或启用插件。每群最多 20 项待处理申请，保留最近 50 项结案记录。</p>
      </form>}
      <section className="panel requests-inbox">
        <div className="section-heading"><h2>{platform ? '待办与处理记录' : '本群申请记录'}</h2><button className="text-button" disabled={blocked} onClick={() => { setNotice(''); setReload(value => value + 1); }}><RefreshCw size={14}/>刷新进度</button></div>
        <div className="directory-toolbar"><label className="request-filter">申请状态<select aria-label="筛选申请状态" value={status} disabled={blocked} onChange={event => { setStatus(event.target.value); setOffset(0); setNotice(''); }}><option value="">全部状态</option>{Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><span className="muted">{loading ? '正在读取…' : items.length ? `第 ${offset + 1}–${offset + items.length} 项` : '暂无记录'}</span></div>
        {notice && <p className="request-notice" role="status"><CheckCircle2 size={16}/>{notice}</p>}
        {error && <p className="request-error" role="alert">{error} 请刷新进度后再操作。</p>}
        {!loading && !error && !items.length && <div className="empty compact"><ClipboardList size={30}/><h3>{status ? '这个状态下没有申请' : '还没有能力申请'}</h3><p>{platform ? '群管理员提交后，会出现在这里。' : '已有功能可先在工具目录查找；新需求可以在左侧提交。'}</p></div>}
        <div className="request-list">{items.map(item => <article className="request-card" key={item.id}>
          <div className="request-card-heading"><div>{platform && <small>{item.groupName}</small>}<h3>{item.title}</h3></div><span className={`request-status ${item.status}`}>{labels[item.status]}</span></div>
          <p className="request-text">{item.details}</p>
          {item.reply && <div className="request-reply"><strong>平台回复</strong><p className="request-text">{item.reply}</p></div>}
          <div className="request-card-footer"><span title={item.id}>更新于 {date(item.updatedAt)} · v{item.version}</span>{active(item) && (platform ? <button className="text-button" disabled={blocked} onClick={() => { setSelected(item); setReply(item.reply); setDecision('reviewing'); }}>处理申请 <ArrowRight size={14}/></button> : <button className="text-button" disabled={blocked} onClick={() => setCancelId(item.id)}>撤回申请</button>)}</div>
          {item.status === 'delivered' && <p className="inline-note">请按平台回复的入口使用；需要启用的功能仍由本群管理员配置。</p>}
          {!platform && cancelId === item.id && <div className="request-confirm"><p>撤回「{item.title}」？需要时可重新提交。</p><button className="button secondary" disabled={blocked} onClick={() => setCancelId('')}>保留申请</button><button className="button secondary" disabled={blocked} onClick={() => void mutate(`${endpoint}/${encodeURIComponent(item.id)}/cancel`, { baseVersion: item.version }, '申请已撤回。')}>确认撤回</button></div>}
          {platform && selected?.id === item.id && <form className="request-decision" onSubmit={event => { event.preventDefault(); void mutate(`${endpoint}/${encodeURIComponent(item.id)}`, { baseVersion: selected.version, status: decision, reply }, '处理结果已保存，本群管理员刷新后可见。'); }}>
            <label className="field">处理状态<select value={decision} disabled={blocked} onChange={event => setDecision(event.target.value as typeof decision)}><option value="reviewing">处理中</option><option value="delivered">已提供</option><option value="declined">暂不提供</option></select></label>
            <label className="field">回复与使用入口<textarea required maxLength={2000} rows={4} value={reply} disabled={blocked} onChange={event => setReply(event.target.value)} placeholder={decision === 'delivered' ? '说明已提供的功能、使用命令和需要的本群配置。' : '说明当前进度，或暂不提供的原因和替代方法。'}/></label>
            <p className="inline-note">这里只保存处理说明。插件安装、平台开放与群配置继续使用各自入口。</p>
            <div className="request-actions"><button className="button secondary" type="button" disabled={blocked} onClick={() => setSelected(undefined)}>收起</button><button className="button primary" disabled={blocked || !reply.trim()}>保存处理结果</button></div>
          </form>}
        </article>)}</div>
        {(offset > 0 || nextOffset !== null) && <div className="request-pagination"><button className="button secondary" disabled={blocked || offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}><ArrowLeft size={14}/>上一页</button><button className="button secondary" disabled={blocked || nextOffset === null} onClick={() => { if (nextOffset !== null) setOffset(nextOffset); }}>下一页<ArrowRight size={14}/></button></div>}
      </section>
    </div>
  </div>;
}
