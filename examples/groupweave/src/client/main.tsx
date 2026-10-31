import React, { useEffect, useRef, useState } from 'react';
import { retrieveRawInitData } from '@tma.js/bridge';
import { createRoot } from 'react-dom/client';
import { LayoutDashboard, Blocks, SlidersHorizontal, History, ShieldCheck, ChevronDown, ArrowUpRight, WandSparkles, Check, X, Link2, Bot, ArrowRight, Terminal, Sparkles, Send, Copy, AlertCircle, RefreshCw, ChevronRight, UserRound, CheckCircle2, Clock3, LockKeyhole, Zap } from 'lucide-react';
import type { Me, Group, Plugin, Proposal, Task, GroupConfig } from '../shared';
import { createRequestScope, type UiAction } from './request-scope';
import { NativePluginMaintenance, PluginConsole } from './plugin-console';
import { NativeGroupSettings, RuleHistory, SessionTools } from './group-tools';
import './style.css';

type Session = Me & { csrfToken: string };
type View = 'overview' | 'features' | 'rules' | 'tasks' | 'use' | 'platform' | 'maintenance';
let csrfToken = '';
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, { credentials: 'same-origin', ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.message || data.error || '请求失败，请重试'), { status: response.status });
  return data;
}
const featureIcons: Record<string, typeof Link2> = { 'link-cleaner': Link2, echo: Terminal, digest: Bot, 'link-brief': WandSparkles, assistant: Bot, antiad: ShieldCheck, welcome: Sparkles, reminder: Clock3 };
type RunFeature = 'link-cleaner' | 'echo' | 'digest' | 'link-brief' | 'assistant' | 'antiad';
// Display copy for shipped capabilities; execution stays behind the existing API.
const featureCopy: Record<RunFeature, { name: string; description: string; inputLabel: string; button: string; cost: string; complete: string }> = {
  'link-cleaner': { name: '链接整理', description: '把一段链接交给它，按本群规则去重、排序。', inputLabel: '待整理的链接', button: '整理链接', cost: '零模型调用', complete: '整理完成' },
  echo: { name: '原生文本回显', description: '返回本次提交的原始文本，不读取群历史。群命令回到当前群，面板可选私人结果。', inputLabel: '待回显的文本', button: '回显文本', cost: '零模型调用', complete: '回显完成' },
  digest: { name: '智能摘要', description: '只总结本次明确提交的文本，不读取群历史；生成结果需要核对。', inputLabel: '待摘要的文本', button: '生成摘要', cost: '最多一次模型请求', complete: '生成完成，请核对' },
  'link-brief': { name: '链接整理与说明', description: '使用本群链接整理代码，再根据真实代码结果生成说明；不打开链接，不读取群历史。', inputLabel: '待整理并说明的链接文本', button: '整理并生成说明', cost: '最多两次模型请求 · 一次代码调用', complete: '整理与说明完成，请核对' },
  assistant: { name: '群助手', description: '使用本人当前相同受众的对话回答目标；切换受众会开始新上下文，不读取群聊天记录。生成内容请核对。', inputLabel: '本次目标与所需文本', button: '交给群助手', cost: '最多两次模型请求 · 最多一次代码调用', complete: '回答完成，请核对' },
  antiad: { name: '反广告检测', description: '使用平台批准的只读模型和本群关键词检测本次文本，提供人工复核建议。当前不自动删消息或封禁。', inputLabel: '待检测的文本', button: '检测广告风险', cost: '零大模型调用', complete: '检测完成，请人工复核' },
};
function isRunFeature(id: string): id is RunFeature { return Object.hasOwn(featureCopy, id); }
const viewNames: Record<View, string> = { overview: '本群管理', features: '本群插件', rules: '群规则', tasks: '使用记录', use: '使用功能', platform: '插件管理', maintenance: '运行维护' };
const viewIcons = { overview: LayoutDashboard, features: Blocks, rules: SlidersHorizontal, tasks: History, use: Send, platform: Blocks, maintenance: ShieldCheck };
const defaultRuleText = '只在 @ 时回复，使用中文，开启链接整理，去重并排序，最多 20 条。';
const exampleInput = 'https://grammy.dev/guide/\nhttps://github.com/krau/kmua-bot/\nhttps://grammy.dev/guide/\nhttps://fastify.dev/';
function date(value: string) { return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
function App() {
  const [me, setMe] = useState<Session>();
  const [groups, setGroups] = useState<Group[]>([]);
  const [group, setGroup] = useState<Group>();
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [maintenance, setMaintenance] = useState('');
  const [auditRecords, setAuditRecords] = useState<{id:string;createdAt:string;action:string;outcome:string;actorId:string}[]>([]);
  const [platformPlugins, setPlatformPlugins] = useState<Plugin[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [view, setView] = useState<View>('overview');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [ruleText, setRuleText] = useState(defaultRuleText);
  const [ruleAiAcknowledged, setRuleAiAcknowledged] = useState(false);
  const [proposal, setProposal] = useState<Proposal>();
  const [runFeature, setRunFeature] = useState<RunFeature>('link-cleaner');
  const [externalAcknowledged, setExternalAcknowledged] = useState(false);
  const [input, setInput] = useState(exampleInput);
  const [audience, setAudience] = useState<'group' | 'private'>('private');
  const [result, setResult] = useState<Task>();
  const [selectedTask, setSelectedTask] = useState<Task>();
  const [manual, setManual] = useState<GroupConfig>();
  const scope = useRef(createRequestScope());
  const runningAction = useRef<UiAction | undefined>(undefined);
  const cancelling = useRef(false);
  const sessionChannel = useRef<BroadcastChannel | undefined>(undefined);
  function clearScope(identity = false) {
    setGroup(undefined); setPlugins([]); setTasks([]); setManual(undefined); setProposal(undefined);
    setInput(exampleInput); setRunFeature('link-cleaner'); setExternalAcknowledged(false); setAudience('private'); setRuleText(defaultRuleText);
    setResult(undefined); setSelectedTask(undefined); setError(''); setNotice('');
    setRuleAiAcknowledged(false);
    if (identity) { setMe(undefined); setGroups([]); setPlatformPlugins([]); setAuditRecords([]); setMaintenance(''); csrfToken = ''; }
  }
  const canEdit = group?.role === 'admin';
  async function loadGroup(id: string, action: UiAction) {
    if (!action.isCurrent()) return;
    const current = action.transition(); clearScope();
    const [detail, history] = await Promise.all([api<{ group: Group; plugins: Plugin[] }>(`/groups/${id}`), api<{ tasks: Task[] }>(`/groups/${id}/tasks`)]);
    if (!current()) return;
    setView(currentView => detail.group.role === 'member' && ['overview', 'features', 'rules'].includes(currentView) ? 'use' : currentView);
    const linksEnabled = detail.group.config.features.includes('link-cleaner') && detail.plugins.some(plugin => plugin.id === 'link-cleaner' && plugin.available && plugin.enabled);
    const runnable = detail.plugins.find(plugin => isRunFeature(plugin.id) && plugin.available && plugin.enabled && detail.group.config.features.includes(plugin.id) && (plugin.id !== 'link-brief' || linksEnabled));
    setRunFeature(runnable && isRunFeature(runnable.id) ? runnable.id : 'link-cleaner');
    setGroup(detail.group); setManual(detail.group.config); setPlugins(detail.plugins); setTasks(history.tasks); setResult(undefined); setSelectedTask(undefined); setProposal(undefined);
  }
  async function loadPlatform(action: UiAction) {
    if (!action.isCurrent()) return;
    const current = action.capture();
    const data = await api<{ plugins: Plugin[] }>('/platform/plugins');
    if (current()) setPlatformPlugins(data.plugins);
  }
  async function loadSession(action: UiAction, session?: Session) {
    if (!action.isCurrent()) return;
    const current = action.transition(); clearScope(true);
    let identity = session;
    if (!identity) {
      try { identity = await api<Session>('/me'); }
      catch (failure) {
        if ((failure as {status?:number}).status !== 401) throw failure;
        const health = await api<{loginAvailable:boolean}>('/health');
        if (!current()) return;
        if (!health.loginAvailable) throw new Error('真实身份登录未配置，请先完成服务器接入。');
        let initData: string | undefined;
        try { initData = retrieveRawInitData(); } catch { /* An ordinary browser has no trusted Telegram launch. */ }
        if (!initData) throw new Error('请从 Telegram 打开已配置的管理 Mini App；普通网页不能选择真实身份。');
        identity = await api<Session>('/auth/telegram', { initData });
        sessionChannel.current?.postMessage('changed');
      }
    }
    if (!current()) return; csrfToken = identity.csrfToken; setMe(identity);
    const [data, catalog] = await Promise.all([
      api<{ groups: Group[] }>('/groups'),
      identity.persona.platformAdmin ? api<{ plugins: Plugin[] }>('/platform/plugins') : Promise.resolve({ plugins: [] }),
    ]);
    if (!current()) return;
    setGroups(data.groups); setPlatformPlugins(catalog.plugins);
    setView(identity.persona.platformAdmin && !data.groups.length ? 'platform' : data.groups[0]?.role === 'member' ? 'use' : 'overview');
    if (data.groups[0]) await loadGroup(data.groups[0].id, action);
  }
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') { void act(action => loadSession(action)); return; }
    const channel = new BroadcastChannel('groupweave-session'); sessionChannel.current = channel;
    channel.onmessage = event => {
      if (event.data !== 'changed' && event.data !== 'logout') return;
      scope.current.invalidate(); clearScope(true); setBusy(false);
      if (event.data === 'changed') void act(action => loadSession(action));
    };
    void act(action => loadSession(action));
    return () => { scope.current.invalidate(); channel.close(); sessionChannel.current = undefined; };
  }, []);
  async function act(fn: (action: UiAction) => Promise<void>) {
    const action = scope.current.begin(); if (!action) return;
    setBusy(true); setError(''); setNotice('');
    try { await fn(action); }
    catch (e) { if (action.isCurrent()) setError((e as Error).message); }
    finally { if (action.finish()) setBusy(false); }
  }
  async function preview(config?: GroupConfig, text = ruleText) {
    if (!group) return;
    await act(async action => { const current = action.capture(); const data = await api<Proposal>(`/groups/${group.id}/proposals`, { text: config ? '' : text, baseVersion: group.version, ...(config ? { config } : {}) }); if (current()) setProposal(data); });
  }
  async function activate() {
    if (!proposal || !group || proposal.groupId !== group.id) return;
    await act(async action => { const current = action.capture(); await api(`/proposals/${proposal.id}/activate`, {}); if (!current()) return; await loadGroup(group.id, action); if (action.isCurrent()) setNotice(`新规则已启用，提案 ID：${proposal.id}。可在规则历史中预览回滚。`); });
  }
  async function previewNatural() {
    if (!group || !ruleAiAcknowledged) return;
    await act(async action => {
      const current = action.capture();
      const data = await api<Proposal>(`/groups/${group.id}/proposals/interpret`, { text: ruleText, baseVersion: group.version, acknowledgeExternalProcessing: true });
      if (current()) { setProposal(data); setRuleAiAcknowledged(false); }
    });
  }
  async function cancelProposal() {
    if (!proposal) return;
    await act(async action => {
      const current = action.capture(); await api(`/proposals/${proposal.id}/cancel`, {});
      if (current()) { setProposal(undefined); setNotice('待确认提案已取消。'); }
    });
  }
  async function run() {
    if (!group) return;
    await act(async action => {
      const current = action.capture(); runningAction.current = action;
      try {
        if (executionPlugin?.kind === 'agent') setExternalAcknowledged(false);
        const task = await api<Task>(`/groups/${group.id}/tasks`, { input, featureId: runFeature, audience, idempotencyKey: crypto.randomUUID(), ...(executionPlugin?.kind === 'agent' ? { acknowledgeExternalProcessing: externalAcknowledged } : {}) });
        if (!current()) return; setResult(task);
        const history = await api<{ tasks: Task[] }>(`/groups/${group.id}/tasks`); if (current()) setTasks(history.tasks);
      } finally { if (runningAction.current === action) runningAction.current = undefined; }
    });
  }
  async function cancelRunning() {
    const action = runningAction.current;
    if (!action || !group || cancelling.current) return;
    const current = action.capture(); cancelling.current = true;
    try {
      const active = await api<{tasks:{id:string;featureId:string}[]}>(`/groups/${group.id}/active-tasks`);
      if (!current()) return;
      for (const task of active.tasks) { if (!current()) return; await api(`/tasks/${task.id}/cancel`, {}); }
      if (current()) setNotice(active.tasks.length ? '已请求取消，正在等待执行端停止；没有自动重试。' : '当前没有可取消的执行。');
    } catch (failure) { if (current()) setError((failure as Error).message); }
    finally { cancelling.current = false; }
  }
  async function refreshTasks() {
    if (!group) return;
    await act(async action => { const current = action.capture(); const data = await api<{ tasks: Task[] }>(`/groups/${group.id}/tasks`); if (current()) setTasks(data.tasks); });
  }
  const enabledCount = plugins.filter(p => p.available && p.enabled && group?.config.features.includes(p.id)).length;
  const succeeded = tasks.filter(t => t.status === 'succeeded').length;
  const linksEnabled = !!group?.config.features.includes('link-cleaner') && plugins.some(plugin => plugin.id === 'link-cleaner' && plugin.available && plugin.enabled);
  const usablePlugins = plugins.filter(plugin => plugin.available && plugin.enabled && group?.config.features.includes(plugin.id) && isRunFeature(plugin.id) && (plugin.id !== 'link-brief' || linksEnabled));
  const navigation: View[] = [...(group ? canEdit ? ['overview', 'features', 'rules', 'use', 'tasks'] as View[] : ['use', 'tasks'] as View[] : []), ...(me?.persona.platformAdmin ? ['platform', 'maintenance'] as View[] : [])];
  const home: View = group ? canEdit ? 'overview' : 'use' : me?.persona.platformAdmin ? 'platform' : 'use';
  const executionPlugin = plugins.find(plugin => plugin.id === runFeature);
  const canRun = executionPlugin?.available && executionPlugin.enabled && group?.config.features.includes(runFeature) && (runFeature !== 'link-brief' || linksEnabled);
  const isAgent = executionPlugin?.kind === 'agent';
  const executionCopy = featureCopy[runFeature];
  const ExecutionIcon = featureIcons[runFeature];
  function featureCard(plugin: Plugin, platform = false) {
    const Icon = featureIcons[plugin.id] || Blocks;
    const enabled = platform ? plugin.enabled : plugin.enabled && !!group?.config.features.includes(plugin.id);
    return <article className={`feature-card ${!plugin.available ? 'future' : ''}`} key={plugin.id}>
      <div className="feature-top"><span className={`feature-icon ${plugin.color}`}><Icon size={23}/></span><span className={`badge ${plugin.kind === 'code' ? 'code' : 'ai'}`}>{plugin.kind === 'code' ? <Terminal size={12}/> : <Sparkles size={12}/>} {plugin.kind === 'code' ? '确定性代码' : 'AI + Skill'}</span></div>
      <h3>{plugin.name}</h3><p>{plugin.description}</p>
      <div className="feature-scope"><LockKeyhole size={13}/>{plugin.scope}</div>
      <div className="feature-bottom"><span className={`status-dot ${enabled && plugin.available ? 'green' : ''}`}/><span>{!plugin.available ? '待接入' : !plugin.enabled ? '平台已停用' : enabled ? '已启用' : '未启用'}</span>
        <button className={`switch ${enabled ? 'on' : ''}`} aria-label={`${enabled ? '关闭' : '开启'}${plugin.name}`} disabled={busy || !plugin.available || (!platform && !canEdit) || (!platform && !plugin.enabled)} onClick={() => {
          if (platform) act(async action => { const current = action.capture(); await api(`/platform/plugins/${plugin.id}`, { enabled: !plugin.enabled }); if (!current()) return; await loadPlatform(action); if (group && action.isCurrent()) await loadGroup(group.id, action); if (action.isCurrent()) setNotice('平台能力状态已更新。'); });
          else if (group) preview({ ...group.config, features: enabled ? group.config.features.filter(f => f !== plugin.id) : [...group.config.features, plugin.id] }, `面板调整：${enabled ? '关闭' : '开启'}${plugin.name}`);
        }}><span/></button>
      </div>
    </article>;
  }
  function taskResult(task: Task) {
    const copy = isRunFeature(task.featureId) ? featureCopy[task.featureId] : undefined;
    const agentTask = task.featureId === 'digest' || task.featureId === 'link-brief' || task.featureId === 'assistant';
    return <div className={`result-box ${task.status === 'succeeded' ? '' : 'error-result'}`}>
      <div className="result-heading"><span>{task.status === 'succeeded' ? <CheckCircle2 size={16}/> : <AlertCircle size={16}/>} {task.status === 'succeeded' ? copy?.complete || '执行完成' : task.status === 'blocked' ? '能力暂不可用' : '执行失败'}</span><button className="icon-button" title="复制结果" disabled={busy} onClick={() => act(async action => { const current = action.capture(); try { await navigator.clipboard.writeText(task.output || task.error || ''); if (current()) setNotice('结果已复制。'); } catch { throw new Error('浏览器未允许复制，请手动选择文本。'); } })}><Copy size={15}/></button></div>
      <pre>{task.output || task.error || '未产生结果'}</pre><div className="result-meta"><span>{task.durationMs} ms</span><span>模型调用 {task.modelCalls === null ? '未知' : `${task.modelCalls} 次`}</span>{(task.toolCalls !== undefined || task.featureId === 'link-brief') && <span>代码调用 {task.toolCalls === undefined ? '未知' : `${task.toolCalls} 次`}</span>}<span>{task.audience === 'private' ? '仅自己可见' : '本群可见'}</span><span>规则 v{task.configVersion}</span>{agentTask && <span>{task.usage ? `Token ${task.usage.inputTokens} 输入 / ${task.usage.outputTokens} 输出` : 'Token 用量未知'}</span>}</div>
    </div>;
  }
  function togglePlatform(plugin: Plugin) {
    void act(async action => { const current = action.capture(); await api(`/platform/plugins/${plugin.id}`, { enabled: !plugin.enabled }); if (!current()) return; await loadPlatform(action); if (group && action.isCurrent()) await loadGroup(group.id, action); if (action.isCurrent()) setNotice('平台可用性已更新。'); });
  }
  function toggleGroup(plugin: Plugin) {
    if (!group || !canEdit) return;
    const enabled = group.config.features.includes(plugin.id);
    void preview({ ...group.config, features: enabled ? group.config.features.filter(id => id !== plugin.id) : [...group.config.features, plugin.id] }, `面板调整：${enabled ? '停用' : '启用'}${plugin.name}`);
  }
  function telegramGuide() {
    if (!group) return null;
    const linkAvailable = usablePlugins.some(plugin => plugin.id === 'link-cleaner');
    return <section className="panel telegram-guide"><div className="section-heading"><h2>在 Telegram 群里使用</h2><span className="badge code">成员入口</span></div><p>无需打开管理台，直接在「{group.name}」内与机器人交互。</p><div className="command-example"><code>/plugins</code><span>查看本群当前可用功能和用法</span></div><div className="command-example"><code>{group.config.responseMode === 'command' ? '/links https://example.com' : '@机器人用户名 https://example.com'}</code><span>{linkAvailable ? '按本群规则整理链接，结果发到当前群' : '链接整理尚未在本群开放'}</span></div><p className="inline-note">{group.config.responseMode === 'mention' ? '将「机器人用户名」换成真实 Bot 用户名；也可使用 /links@机器人用户名。' : '本群只用命令触发；普通聊天不会自动执行。'}群内任务公开到本群；需要私人结果时使用面板并选择「仅自己可见」。</p><p className="inline-note">可用时发送 /echo、/digest、/brief、/ask 或 /scan；AI 功能需要本人确认，/cancel 取消本人在本群的运行任务。私聊 /start 可查看引导。</p>{canEdit && <div className="command-example"><code>/settings</code><span>管理员查看本群配置与规则调整方法</span></div>}{me?.preview && <p className="inline-note">当前为本地预览，Telegram 尚未连接。面板可实际执行已开放的代码功能。</p>}</section>;
  }
  return <div className="app-shell">
    <aside className="sidebar"><a className="brand" href="#" onClick={e => { e.preventDefault(); setView(home); }}><span className="brand-symbol"><Blocks size={23}/></span><span>群织<small>GROUPWEAVE</small></span></a>
      <div className="workspace-label">{group ? canEdit ? '群管理员工作区' : '群成员工作区' : me?.persona.platformAdmin ? '平台工作区' : busy ? '正在加载' : '我的群空间'}</div>
      {group ? <div className="group-select"><span className="group-avatar">{group.initials}</span><div><strong>{group.name}</strong><small>{canEdit ? '仅管理当前群' : '使用本群开放功能'}</small></div><ChevronDown size={16}/><select aria-label="切换群" disabled={busy} value={group.id} onChange={e => act(action => loadGroup(e.target.value, action))}>{groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select></div> : <div className="workspace-card"><ShieldCheck size={20}/><div><strong>{me?.persona.platformAdmin ? '平台插件控制台' : '等待群授权'}</strong><small>{me?.persona.platformAdmin ? '维护全局能力与可用性' : '由群管理员先注册本群'}</small></div></div>}
      <nav aria-label="当前角色导航">{navigation.map(id => { const Icon = viewIcons[id]; return <button key={id} className={view === id ? 'active' : ''} onClick={() => { setView(id); setError(''); setNotice(''); }}><Icon size={18}/>{viewNames[id]}{id === 'features' && <span className="nav-count">{enabledCount}</span>}</button>; })}</nav>
      <div className="sidebar-note"><Zap size={18}/><strong>{group ? canEdit ? '本群自由组合' : '在群里就能使用' : me?.persona.platformAdmin ? '维护一次，各群按需使用' : '从群里开始使用'}</strong><p>{group ? canEdit ? '选择平台开放的插件，调整参数，预览后启用。' : '通过命令或 @ 使用功能，私人结果只对自己可见。' : me?.persona.platformAdmin ? '管理插件可用性、依赖边界和运行维护。' : '先由群管理员在 Telegram 使用 /register 注册本群。'}</p>{(group || me?.persona.platformAdmin) && <button onClick={() => setView(group ? canEdit ? 'features' : 'use' : 'platform')}>{group ? canEdit ? '管理本群插件' : '查看使用方法' : '查看插件目录'} <ArrowUpRight size={14}/></button>}</div>
      <div className="profile"><span className="profile-avatar"><UserRound size={18}/></span><div><strong>{me?.persona.name || '本地预览'}</strong><small>{me?.persona.label || '连接中'}</small></div><span className="live-dot"/></div>
    </aside>
    <div className="main-shell"><header className="topbar"><div className="breadcrumb">{view === 'platform' || view === 'maintenance' ? '平台管理' : canEdit ? '群管理员' : '群成员'} <ChevronRight size={14}/><span>{viewNames[view]}</span></div><div className="top-actions"><span className="preview-badge"><span/> {me?.preview !== false ? '本地预览 · TG 未连接' : me.telegramConnected ? 'Telegram 已连接' : 'Telegram 模式 · 未连接'}</span>{me?.preview !== false ? <label className="persona-picker"><UserRound size={14}/><select aria-label="切换演示身份" disabled={busy || !me} value={me?.persona.id || 'admin-a'} onChange={e => { const personaId = e.target.value; void act(async action => { const current = action.transition(); const sessionRequest = api<Session>('/demo/session', { personaId }); clearScope(true); const s = await sessionRequest; if (current()) { sessionChannel.current?.postMessage('changed'); await loadSession(action, s); } }); }}>{me?.personas.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select><ChevronDown size={13}/></label> : <button className="text-button" disabled={busy} onClick={() => act(async action => { await api('/logout', {}); if (!action.isCurrent()) return; action.transition(); clearScope(true); sessionChannel.current?.postMessage('logout'); setNotice('已退出，请从 Telegram 重新打开管理入口。'); })}>退出登录</button>}</div></header>
      <main>
        {error && <div className="toast error" role="alert"><AlertCircle size={16}/>{error}<button onClick={() => setError('')}><X size={14}/></button></div>}
        {notice && <div className="toast success" role="status"><CheckCircle2 size={16}/>{notice}<button onClick={() => setNotice('')}><X size={14}/></button></div>}
        {(view === 'platform' || view === 'maintenance') && me?.persona.platformAdmin ? <>
          <div className="page-title"><div><div className="eyebrow">PLATFORM ADMINISTRATION</div><h1>{view === 'platform' ? '平台维护插件，群里自由组合。' : '运行维护与审计'}</h1><p>{view === 'platform' ? '维护插件实现与全局可用性；每个群独立决定启用和使用规则。' : '管理存储保留范围、备份和平台操作记录。'}</p></div><span className="role-pill"><ShieldCheck size={14}/>平台管理员</span></div>
          <div className="info-strip"><ShieldCheck size={18}/><span>平台身份不自动获得群权限。可信 npm 插件可在下方安装、配置和启停；插件代码仍属于平台可信代码。</span></div>
          {view === 'platform' ? <><NativePluginMaintenance request={(path,body) => api(path.replace(/^\/api/, ''), body)}/><PluginConsole key="platform" plugins={platformPlugins} busy={busy} onToggle={togglePlatform}/></> : <section className="panel capability-note"><div><History size={22}/><h2>维护与审计</h2></div><p>清理超量内容会保留重复保护摘要。备份留在服务器专用目录；此面板不下载群资料，恢复通过停机维护完成。</p><div className="modal-actions"><button className="button secondary" disabled={busy} onClick={() => act(async action => { const current=action.capture(); const data=await api<{taskBodiesRemoved:number;proposalsRemoved:number;auditRemoved:number}>('/platform/maintenance/prune',{}); if(current()) setMaintenance(`清理完成：任务内容 ${data.taskBodiesRemoved}，提案 ${data.proposalsRemoved}，审计 ${data.auditRemoved}。`); })}>清理保留范围</button><button className="button secondary" disabled={busy} onClick={() => act(async action => { const current=action.capture(); const data=await api<{name:string;integrity:string}>('/platform/maintenance/backup',{}); if(current()) setMaintenance(`备份已保存：${data.name} · 完整性 ${data.integrity}`); })}>保存备份</button><button className="button secondary" disabled={busy} onClick={() => act(async action => { const current=action.capture(); const data=await api<{records:typeof auditRecords}>('/platform/audit'); if(current()) setAuditRecords(data.records); })}>查看平台审计</button></div>{maintenance && <p role="status">{maintenance}</p>}{auditRecords.length>0 && <div className="table-wrap"><table><thead><tr><th>操作</th><th>结果</th><th>时间</th></tr></thead><tbody>{auditRecords.map(row=><tr key={row.id}><td>{row.action}</td><td>{row.outcome}</td><td>{date(row.createdAt)}</td></tr>)}</tbody></table></div>}</section>}
        </> : !group ? <div className="empty"><Blocks size={36}/><h2>{error ? '无法加载群空间' : busy ? '正在准备群空间' : '当前身份没有群空间'}</h2><p>{error || (me?.persona.platformAdmin ? '平台能力可以独立管理；群数据与规则需要另有本群权限。本地预览使用合成身份；真实模式另行核验 Telegram 群权。' : '当前身份没有可访问的群；真实群需要先由群管理员使用 /register 注册。')}</p>{me?.persona.platformAdmin && <button className="button primary" disabled={busy} onClick={() => setView('platform')}><ShieldCheck size={15}/>管理平台能力</button>}<button className="button secondary" disabled={busy} onClick={() => act(action => loadSession(action))}><RefreshCw size={15}/>重新加载</button></div> : <>
          {view === 'overview' && canEdit && <>
            <div className="page-title"><div><div className="eyebrow">YOUR GROUP, YOUR WAY</div><h1>让「{group.name}」按你的规则运行。</h1><p>选择插件、配置行为、确认生效。你的管理只影响当前群。</p></div><span className="role-pill"><ShieldCheck size={14}/>群管理员</span></div>
            <div className="stats"><div><span>本群可用插件</span><strong>{enabledCount}<small> 项</small></strong><div className="stat-foot">平台开放 + 本群启用</div><Blocks className="stat-icon" size={24}/></div><div><span>当前规则</span><strong>v{group.version}</strong><div className="stat-foot">{group.config.responseMode === 'mention' ? '仅 @ 机器人时触发' : '仅命令触发'}</div><SlidersHorizontal className="stat-icon" size={24}/></div><div><span>可见使用记录</span><strong>{tasks.length}<small> 次</small></strong><div className="stat-foot">{succeeded} 次完成 · 私人结果仅本人可见</div><History className="stat-icon" size={24}/></div></div>
            <div className="admin-journey"><button className="panel" onClick={() => setView('features')}><Blocks size={24}/><span>01 · 选择本群插件</span><strong>挑选功能，调整参数</strong><p>链接去重、排序、处理上限独立配置。</p><ArrowRight size={17}/></button><button className="panel" onClick={() => setView('rules')}><WandSparkles size={24}/><span>02 · 定义使用规则</span><strong>自然语言描述，预览后生效</strong><p>响应方式、语言和功能组合统一确认。</p><ArrowRight size={17}/></button><button className="panel" onClick={() => setView('use')}><Send size={24}/><span>03 · 交给成员使用</span><strong>查看群内用法，实际试一次</strong><p>成员用命令或 @，也可取得私人结果。</p><ArrowRight size={17}/></button></div>
            <div className="section-heading"><h2>本群功能 <span>独立配置，按需启用</span></h2><button className="text-button" onClick={() => setView('features')}>进入插件配置 <ArrowRight size={14}/></button></div><div className="feature-grid">{plugins.filter(p => p.id !== 'reminder').map(p => featureCard(p))}</div>
            <div className="footer-note"><LockKeyhole size={14}/>群管理权限不会开放成员的私人任务；平台管理员也需另有本群授权。</div>
          </>}
          {view === 'use' && <>
            <div className="page-title"><div><div className="eyebrow">MADE FOR GROUP MEMBERS</div><h1>群里的功能，直接用。</h1><p>「{group.name}」已开放 {enabledCount} 项功能，按本群规则执行。</p></div><span className="role-pill"><UserRound size={14}/>{canEdit ? '管理员试用' : '群成员'}</span></div>
            <div className="usable-bar">{usablePlugins.length ? usablePlugins.map(plugin => <button key={plugin.id} className={runFeature === plugin.id ? 'selected' : ''} disabled={busy} onClick={() => { if (isRunFeature(plugin.id)) setRunFeature(plugin.id); setExternalAcknowledged(false); setResult(undefined); }}><CheckCircle2 size={16}/>{plugin.name}<span>{plugin.kind === 'code' ? '零模型调用' : plugin.id === 'link-brief' || plugin.id === 'assistant' ? 'AI + 代码' : 'AI 摘要'}</span></button>) : <div className="info-strip"><Blocks size={18}/><span>本群暂无可用功能，由群管理员选择平台已开放的插件后启用。</span></div>}</div>
            <div className="member-layout">{telegramGuide()}<section className="panel try-panel">
              <div className="panel-heading"><span className="mini-icon"><ExecutionIcon size={18}/></span><div><h2>{executionCopy.name}</h2><p>{executionCopy.description}</p></div><span className={`badge ${isAgent ? 'ai' : 'code'}`}>{executionCopy.cost}</span></div>
              <label className="field">使用功能<select aria-label="使用功能" disabled={busy || !usablePlugins.length} value={runFeature} onChange={e => { if (isRunFeature(e.target.value)) setRunFeature(e.target.value); setExternalAcknowledged(false); setResult(undefined); }}>{usablePlugins.length ? usablePlugins.map(plugin => <option key={plugin.id} value={plugin.id}>{plugin.name}</option>) : <option value={runFeature}>暂无可用功能</option>}</select></label>
              {isAgent && <label className="check-field"><input type="checkbox" aria-label={runFeature === 'link-brief' ? '确认发送本次文本及代码结果给已配置模型服务' : runFeature === 'assistant' ? '确认发送本次文本及本人当前同受众对话上下文给模型服务' : '确认发送本次文本给已配置模型服务'} checked={externalAcknowledged} disabled={busy || !canRun} onChange={e => setExternalAcknowledged(e.target.checked)}/><span>{runFeature === 'link-brief' ? '我确认将本次文本及链接整理的代码结果发送给已配置的第三方模型服务，最多两次模型请求' : runFeature === 'assistant' ? '我确认将本次文本和本人当前相同受众的对话上下文发送给第三方模型服务；可在使用记录中重置，或在 Telegram 使用 /newchat' : '我确认将本次文本发送给已配置的第三方模型服务，完成本次任务'}</span></label>}
              <textarea aria-label={executionCopy.inputLabel} disabled={busy || !canRun} value={input} onChange={e => { setInput(e.target.value); setExternalAcknowledged(false); }} spellCheck={false}/>
              <div className="input-footer"><label><LockKeyhole size={13}/><select aria-label="结果可见范围" disabled={busy} value={audience} onChange={e => { setAudience(e.target.value as typeof audience); setExternalAcknowledged(false); }}><option value="private">仅自己可见</option><option value="group">本群可见</option></select></label><button className="button primary" disabled={busy || !canRun || (isAgent && !externalAcknowledged)} onClick={run}>{busy ? <RefreshCw size={15} className="spin"/> : <Send size={15}/>}{executionCopy.button}</button>{busy && runningAction.current && <button className="button secondary" onClick={cancelRunning}>请求取消</button>}</div>
              {!canRun && <p className="inline-note">{runFeature === 'link-brief' && !linksEnabled ? '链接整理与说明还依赖平台开放、本群启用的链接整理，请联系本群管理员。' : '当前群没有开放此功能，请联系本群管理员。'}</p>}{result && taskResult(result)}
            </section></div>
            <div className="footer-note"><LockKeyhole size={14}/>私人结果只有发起者可见；选择「本群可见」会向同群成员开放结果。{me?.preview ? ' 当前为合成群与演示身份。' : ''}</div>
          </>}
          {view === 'features' && canEdit && <><div className="page-title"><div><div className="eyebrow">BUILD YOUR GROUP TOOLKIT</div><h1>为本群挑选与配置插件</h1><p>平台维护实现，你决定「{group.name}」如何使用。启停和参数调整均先预览。</p></div><span className="version">本群规则 v{group.version}</span></div><PluginConsole key={`${group.id}:${group.version}`} plugins={plugins} group={group} busy={busy} onToggle={toggleGroup} onPreview={config => void preview(config, '面板调整插件参数')} onRules={() => setView('rules')}/><NativeGroupSettings group={group} busy={busy} onPreview={config => void preview(config)}/></>}
          {view === 'rules' && canEdit && <><div className="page-title"><div className="eyebrow">A LITTLE LESS CONFIGURATION</div><h1>用一句话，说清群规则</h1><p>先查看会发生什么，再让新规则生效。当前规则版本 v{group.version}。</p></div><div className="rules-layout"><section className="panel editor-panel"><div className="panel-heading"><span className="mini-icon"><WandSparkles size={19}/></span><div><h2>描述你想要的规则</h2><p>免费固定短语与 AI 解释均生成同一种提案，确认后才生效。</p></div></div><textarea aria-label="描述群规则" className="rule-text" disabled={!canEdit} value={ruleText} onChange={e => setRuleText(e.target.value)}/><div className="example-chips"><button disabled={!canEdit} onClick={() => setRuleText('只在 @ 时回复，使用中文，开启链接整理，去重并排序，最多 20 条。')}>安静实用</button><button disabled={!canEdit} onClick={() => setRuleText('只使用命令，使用英文，开启链接整理，不去重，不排序，最多 10 条。')}>保留原始顺序</button></div><div className="parse-note"><AlertCircle size={14}/><span>可识别：@ / 命令、语言、链接整理、原生文本回显、智能摘要、链接整理与说明、群助手、新成员欢迎、反广告检测、去重、排序、条数。其他要求会标出，不能直接启用。</span></div><button className="button primary full" disabled={!canEdit || busy || !ruleText.trim()} onClick={() => preview()}><WandSparkles size={16}/>生成规则预览</button><label className="check-field"><input type="checkbox" checked={ruleAiAcknowledged} disabled={busy} onChange={event => setRuleAiAcknowledged(event.target.checked)}/><span>同意把本群配置和本次要求发送给第三方 AI 解释，按实际请求计费</span></label><button className="button secondary full" disabled={!canEdit || busy || !ruleText.trim() || !ruleAiAcknowledged} onClick={previewNatural}>用 AI 理解并预览</button>{!canEdit && <p className="inline-note">当前身份是群成员，没有修改规则的权限。</p>}</section>
          <section className="panel manual-panel"><div className="section-heading"><h2>精确调整</h2><span className="muted">面板辅助</span></div>{manual && <><label className="field">响应方式<select disabled={!canEdit} value={manual.responseMode} onChange={e => setManual({ ...manual, responseMode: e.target.value as GroupConfig['responseMode'] })}><option value="mention">仅 @ 机器人时</option><option value="command">仅使用命令时</option></select></label><label className="field">默认语言<select disabled={!canEdit} value={manual.language} onChange={e => setManual({ ...manual, language: e.target.value as GroupConfig['language'] })}><option value="zh">中文</option><option value="en">English</option></select></label><label className="field">单次链接上限<input aria-label="单次链接上限" disabled={!canEdit} type="number" min="1" max="100" value={manual.maxItems} onChange={e => setManual({ ...manual, maxItems: Number(e.target.value) })}/></label><label className="check-field"><input disabled={!canEdit} type="checkbox" checked={manual.deduplicate} onChange={e => setManual({ ...manual, deduplicate: e.target.checked })}/><span>去除重复链接</span></label><label className="check-field"><input disabled={!canEdit} type="checkbox" checked={manual.sort} onChange={e => setManual({ ...manual, sort: e.target.checked })}/><span>按链接排序</span></label><button className="button secondary full" disabled={!canEdit || busy} onClick={() => preview(manual, '面板调整群规则')}>预览面板调整 <ArrowRight size={15}/></button></>}</section></div><RuleHistory key={`${me?.persona.id}:${group.id}:${group.version}`} groupId={group.id} request={api} onPreview={setProposal} disabled={busy}/></>}
          {view === 'tasks' && <><div className="page-title"><div className="eyebrow">A RECORD OF REAL RESULTS</div><h1>每一次任务，都有结果</h1><p>只展示当前身份可见的本群任务，私人结果不会向其他管理员开放。</p></div><SessionTools key={`${me?.persona.id}:${group.id}`} groupId={group.id} request={api}/><section className="panel task-list"><div className="section-heading"><h2>任务记录</h2><button className="text-button" disabled={busy} onClick={refreshTasks}><RefreshCw size={14}/>刷新</button></div>{!tasks.length ? <div className="empty compact"><History size={32}/><h3>还没有可见任务</h3><p>选择本群已开放的功能，真实执行结果会记录在这里。</p><button className="button secondary" onClick={() => setView('use')}>开始使用 <ArrowRight size={14}/></button></div> : <div className="table-wrap"><table><thead><tr><th>功能 / 时间</th><th>执行状态</th><th>可见范围</th><th>模型调用</th><th>代码调用</th><th/></tr></thead><tbody>{tasks.map(task => <tr key={task.id} onClick={() => setSelectedTask(task)}><td><strong>{isRunFeature(task.featureId) ? featureCopy[task.featureId].name : task.featureId}</strong><small>{date(task.createdAt)}</small></td><td><span className={`task-status ${task.status}`}>{task.status === 'succeeded' ? <CheckCircle2 size={13}/> : <AlertCircle size={13}/>} {task.status === 'succeeded' ? '已完成' : task.status === 'blocked' ? '未执行' : '失败'}</span></td><td>{task.audience === 'private' ? '仅自己' : '本群'}</td><td>{task.modelCalls === null ? '未知' : `${task.modelCalls} 次`}</td><td>{task.toolCalls === undefined ? task.featureId === 'link-brief' ? '未知' : '—' : `${task.toolCalls} 次`}</td><td><ChevronRight size={16}/></td></tr>)}</tbody></table></div>}</section>{selectedTask && <section className="panel task-detail"><div className="section-heading"><h2>任务详情</h2><span className="version">规则 v{selectedTask.configVersion}</span></div><p className="muted">原始输入</p>{selectedTask.inputHidden ? <p className="inline-note">原始输入仅发起者可见。</p> : <pre className="input-preview">{selectedTask.input}</pre>}{taskResult(selectedTask)}</section>}</>}
        </>}
      </main>
    </div>
    {proposal && proposal.groupId === group?.id && <div className="modal-backdrop" onClick={() => setProposal(undefined)}><section className="proposal-modal" role="dialog" aria-modal="true" aria-label="规则预览" onClick={e => e.stopPropagation()}><div className="modal-top"><span className="feature-icon sage"><SlidersHorizontal size={24}/></span><button className="icon-button" aria-label="关闭预览" onClick={() => setProposal(undefined)}><X size={20}/></button></div><div className="eyebrow">REVIEW BEFORE ACTIVATION</div><h2>先看一眼，再启用</h2><p className="muted">仅影响 {group?.name} · 基于规则 v{proposal.baseVersion}</p><p className="inline-note">提案 ID：<code>{proposal.id}</code></p><div className="proposal-changes">{proposal.changes.length ? proposal.changes.map((change, index) => <div key={index}><Check size={16}/><span>{change}</span></div>) : <p>候选规则与当前规则一致。</p>}</div>{proposal.warnings.length > 0 && <div className="warning-box"><strong><AlertCircle size={16}/>这些要求还无法确认</strong>{proposal.warnings.map((warning, index) => <p key={index}>{warning}</p>)}<p>请修改描述后重新预览，当前提案不能启用。</p></div>}<div className="scope-note"><LockKeyhole size={16}/><p>不会修改其他群。已完成任务仍保留原来的规则版本和可见范围。</p></div><div className="modal-actions"><button className="button secondary" onClick={() => setProposal(undefined)}>返回调整</button><button className="button secondary" disabled={busy} onClick={cancelProposal}>取消此提案</button><button className="button primary" disabled={busy || !!proposal.warnings.length || !canEdit} onClick={activate}><Check size={16}/>确认启用</button></div></section></div>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
