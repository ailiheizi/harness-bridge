import React, { useEffect, useRef, useState } from 'react';
import { Blocks, CheckCircle2, ChevronRight, LockKeyhole, SlidersHorizontal, Terminal, Search, Download, RefreshCw, Package, Settings2 } from 'lucide-react';
import type { Group, GroupConfig, Plugin } from '../shared';

// Capability details only; execution stays behind the existing task API.
const notes: Record<string, { implementation: string; access: string; cost: string; entry: string }> = {
  'link-cleaner': { implementation: 'Koishi 代码插件 · 经既有 DSH 无模型入口调用', access: '本次提交的文本；不读取群历史，不打开链接', cost: '零模型调用；最多 100 条链接', entry: '群内 /links 或 @机器人；面板显式执行' },
  echo: { implementation: 'Koishi 官方 Echo 插件 · 原生命令', access: '仅本次提交的文本；群内回到当前群，面板可选私人结果', cost: '零模型调用', entry: '群内 /echo，或回复消息后 /echo；面板也可使用' },
  digest: { implementation: 'DSH 原生 Skill · DeepSeek Adapter', access: '仅本次确认提交的文本会发送给 DeepSeek；不读取群历史', cost: '每次最多一次模型请求；输入最多 8 KB', entry: '群内 /digest 后本人确认；面板每次确认第三方处理' },
  'link-brief': { implementation: 'DSH Agent/Skill → Koishi 链接代码 → AI 说明', access: '本次确认的文本及代码结果发送给 DeepSeek；不读取群历史，不打开链接', cost: '最多两次模型请求；一次真实链接代码调用；默认关闭', entry: '群内 /brief 后本人确认；依赖本群链接整理' },
  assistant: { implementation: 'DSH 原生 Agent/Skill · 按目标选择代码', access: '本次确认的目标；最多调用本群链接整理一次，模型不能选择其他群或用户', cost: '最多两次模型请求；最多一次代码调用', entry: '群内 /ask 后本人确认；面板也可使用' },
  welcome: { implementation: 'Koishi 原生文本插件', access: '当前群加入事件的成员显示名及本群模板；不读取历史', cost: '零模型调用；纯文本模板', entry: '平台和本群启用后，新成员加入时自动欢迎' },
  antiad: { implementation: '既有 antiad 纯预测核心 · 固定 Python 入口', access: '仅本次提交的文本及本群规则；只读平台批准的基准模型', cost: '零大模型调用；一次有界本地推断', entry: '旧本地适配器暂不可用；原生 /scan 另走群助手 AI 复核并按实际调用计费' },
  reminder: { implementation: '尚未接入', access: '访问范围尚未验收', cost: '尚未验收', entry: '暂时无法使用' },
};

export function pluginStatus(plugin: Plugin, group?: Group, plugins?: Plugin[]) {
  if (!plugin.available) return plugin.id === 'antiad' || plugin.kind === 'agent' ? '待配置' : '待接入';
  if (!plugin.enabled) return '平台已关闭';
  if (group && !group.config.features.includes(plugin.id)) return '本群未启用';
  if (group && plugin.id === 'link-brief' && !group.config.features.includes('link-cleaner')) return '本群依赖未启用';
  if (group && plugin.id === 'link-brief' && plugins && !plugins.some(item => item.id === 'link-cleaner' && item.available && item.enabled)) return '依赖不可用';
  return group ? '本群已启用' : '平台已开放';
}

export function PluginConsole({ plugins, group, busy, onToggle, onPreview, onRules }: {
  plugins: Plugin[]; group?: Group; busy: boolean;
  onToggle: (plugin: Plugin) => void;
  onPreview?: (config: GroupConfig) => void;
  onRules?: () => void;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [selection, setSelection] = useState('link-cleaner');
  const [draft, setDraft] = useState<{ deduplicate: boolean; sort: boolean; maxItems: number } | undefined>();
  const [welcomeDraft, setWelcomeDraft] = useState<string | undefined>();
  const [antiadDraft, setAntiadDraft] = useState<{ prompt: number; action: number; keywords: string } | undefined>();
  const visible = plugins.filter(plugin => `${plugin.name} ${plugin.id}`.toLowerCase().includes(query.trim().toLowerCase()) && (filter === 'all' || (filter === 'available' ? plugin.available : !plugin.available)));
  const selected = visible.find(plugin => plugin.id === selection) || visible[0];
  if (!plugins.length) return <div className="panel"><p>暂无插件信息。</p></div>;
  const detail = selected && notes[selected.id];
  const enabled = group ? group.config.features.includes(selected?.id ?? '') : selected?.enabled;
  const links = plugins.find(plugin => plugin.id === 'link-cleaner');
  const missingDependency = !!group && selected?.id === 'link-brief' && (!group.config.features.includes('link-cleaner') || !links?.available || !links.enabled);
  const linkOptions = draft || group?.config;
  const dirty = !!draft && !!group && (draft.deduplicate !== group.config.deduplicate || draft.sort !== group.config.sort || draft.maxItems !== group.config.maxItems);
  const welcomeText = welcomeDraft ?? group?.config.welcomeText ?? '';
  const antiadOptions = antiadDraft ?? { prompt: group?.config.antiadPromptThreshold ?? 0.55,
    action: group?.config.antiadActionThreshold ?? 0.9, keywords: (group?.config.antiadStopwords ?? []).join('\n') };
  const keywords = antiadOptions.keywords.split('\n').map(item => item.trim()).filter(Boolean);
  const validAntiad = Number.isFinite(antiadOptions.prompt) && Number.isFinite(antiadOptions.action)
    && antiadOptions.prompt > 0 && antiadOptions.prompt <= antiadOptions.action && antiadOptions.action <= 1
    && keywords.length <= 50 && new Set(keywords).size === keywords.length && keywords.every(item => item.length <= 80);
  return <div className="plugin-console">
    <section className="panel plugin-list" aria-label={group ? '本群插件列表' : '平台插件列表'}>
      <div className="section-heading"><h2>{group ? '本群插件' : '插件目录'}</h2><span className="muted">{plugins.length} 项</span></div>
      <label className="search-field"><Search size={16}/><input aria-label="搜索插件" placeholder="搜索插件…" value={query} onChange={e => setQuery(e.target.value)}/></label><label className="field plugin-filter">显示范围<select aria-label="筛选插件" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">全部能力</option><option value="available">已接入</option><option value="unavailable">待配置 / 接入</option></select></label>
      {visible.map(plugin => <button key={plugin.id} className={`plugin-row ${selected?.id === plugin.id ? 'selected' : ''}`} aria-pressed={selected?.id === plugin.id} onClick={() => { setSelection(plugin.id); setDraft(undefined); setWelcomeDraft(undefined); setAntiadDraft(undefined); }}>
        <span className={`feature-icon ${plugin.color}`}><Blocks size={19}/></span><span><strong>{plugin.name}</strong><small>{pluginStatus(plugin, group, plugins)}</small></span><ChevronRight size={14}/>
      </button>)}
      <p className="plugin-list-note">{group ? '每个群独立保存启用状态与规则。平台关闭后，本群也无法调用。' : '插件由平台维护并随应用版本发布。待接入能力不能开放。'}</p>
    </section>
    {!selected ? <section className="panel empty compact"><Search size={28}/><h3>没有匹配的插件</h3><p>调整关键词或显示范围。</p><button className="button secondary" onClick={() => { setQuery(''); setFilter('all'); }}>清除筛选</button></section> : <section className="panel plugin-detail" aria-label={`${selected.name}详情`}>
      <div className="plugin-detail-heading"><div><div className="eyebrow">{group ? 'GROUP PLUGIN CONFIGURATION' : 'PLATFORM PLUGIN MANAGEMENT'}</div><h2>{selected.name}</h2><p>{selected.description}</p></div><span className={`task-status ${selected.available && selected.enabled && enabled && !missingDependency ? 'succeeded' : 'blocked'}`}>{pluginStatus(selected, group, plugins)}</span></div>
      <div className="plugin-facts"><div><span><Terminal size={14}/>实现方式</span><strong>{detail?.implementation || '未标注'}</strong></div><div><span><LockKeyhole size={14}/>数据访问</span><strong>{detail?.access || selected.scope}</strong></div><div><span>使用入口</span><strong>{detail?.entry || '尚未验收'}</strong></div><div><span>资源范围</span><strong>{detail?.cost || '尚未验收'}</strong></div></div>
      {group ? <>
        <div className="plugin-setting-heading"><h3>本群配置</h3><span className="version">规则 v{group.version}</span></div>
        {selected?.id === 'link-cleaner' && linkOptions && <div className="plugin-settings"><label className="field">单次链接上限<input aria-label="插件单次链接上限" type="number" min="1" max="100" value={linkOptions.maxItems} disabled={busy} onChange={event => setDraft({ ...linkOptions, maxItems: Number(event.target.value) })}/></label><label className="check-field"><input type="checkbox" checked={linkOptions.deduplicate} disabled={busy} onChange={event => setDraft({ ...linkOptions, deduplicate: event.target.checked })}/><span>去除重复链接</span></label><label className="check-field"><input type="checkbox" checked={linkOptions.sort} disabled={busy} onChange={event => setDraft({ ...linkOptions, sort: event.target.checked })}/><span>按链接排序</span></label>{dirty && <p className="inline-note">调整尚未生效；预览并确认后只更新本群。</p>}<button className="button secondary" disabled={busy || !dirty} onClick={() => onPreview?.({ ...group.config, deduplicate: linkOptions.deduplicate, sort: linkOptions.sort, maxItems: linkOptions.maxItems })}><SlidersHorizontal size={15}/>预览参数调整</button></div>}
        {selected?.id === 'welcome' && <div className="plugin-settings"><label className="field">欢迎文本<textarea aria-label="欢迎文本" maxLength={500} value={welcomeText} disabled={busy} placeholder="欢迎 {name} 加入 {group}！" onChange={event => setWelcomeDraft(event.target.value)}/></label><p className="inline-note">{'{name}'} 为本次加入的显示名，{'{group}'} 为本群名称。留空使用默认语言模板；文本不会作为代码或 AI 指令执行。</p><button className="button secondary" disabled={busy || welcomeDraft === undefined || welcomeText === (group.config.welcomeText ?? '')} onClick={() => onPreview?.({ ...group.config, welcomeText })}><SlidersHorizontal size={15}/>预览欢迎文本调整</button></div>}
        {selected?.id === 'antiad' && <div className="plugin-settings"><label className="field">提示阈值<input aria-label="广告提示阈值" type="number" min="0.01" max="1" step="0.01" value={antiadOptions.prompt} disabled={busy} onChange={event => setAntiadDraft({ ...antiadOptions, prompt: Number(event.target.value) })}/></label><label className="field">高风险阈值<input aria-label="广告高风险阈值" type="number" min="0.01" max="1" step="0.01" value={antiadOptions.action} disabled={busy} onChange={event => setAntiadDraft({ ...antiadOptions, action: Number(event.target.value) })}/></label><label className="field">本群广告关键词<textarea aria-label="本群广告关键词" value={antiadOptions.keywords} disabled={busy} placeholder="每行一项，最多 50 项" onChange={event => setAntiadDraft({ ...antiadOptions, keywords: event.target.value })}/></label><p className="inline-note">分数用于人工复核建议，当前不会自动删消息或封禁。群关键词不写入共享模型，不导入旧群训练样本。</p>{!validAntiad && <p className="inline-note">阈值需满足 0 &lt; 提示 ≤ 高风险 ≤ 1；关键词最多 50 个，每项不超过 80 字且不得重复。</p>}<button className="button secondary" disabled={busy || !antiadDraft || !validAntiad} onClick={() => onPreview?.({ ...group.config, antiadPromptThreshold: antiadOptions.prompt, antiadActionThreshold: antiadOptions.action, antiadStopwords: keywords })}><SlidersHorizontal size={15}/>预览检测规则调整</button></div>}
        {!['link-cleaner', 'welcome', 'antiad'].includes(selected.id) && <p className="inline-note">{selected?.id === 'digest' ? '模型与专用凭据由平台维护，成员每次自行确认提交文本。' : selected?.id === 'echo' ? '回显没有额外的群级参数，仅处理本次文本。' : selected?.id === 'link-brief' ? '复用本群链接整理参数。每次执行确认提交文本及代码结果。' : selected?.id === 'assistant' ? '只回答本次目标；本群链接整理可用时才向模型开放对应代码工具。凭据和模型由平台维护，不能通过提示词扩权。' : '能力接入并验收后才能配置。'}</p>}
        {missingDependency && <p className="inline-note">需先由平台开放、本群启用链接整理，才能使用链接整理与说明。</p>}
        <div className="plugin-detail-actions"><button className="button primary" disabled={busy || !selected.available || !selected.enabled || (!enabled && missingDependency)} onClick={() => onToggle(selected)}>{enabled ? '停用本群插件' : '启用本群插件'}</button><button className="text-button" onClick={onRules}>调整响应方式与群规则 <ChevronRight size={14}/></button></div><p className="inline-note">启停同样先生成预览；群内输出为本群公开结果，面板可选择仅自己可见。</p>
      </> : <>
        <div className="plugin-setting-heading"><h3>平台可用性</h3><span className="badge code">应用版本 0.1.0</span></div><p className="inline-note">开放后，群管理员还需为本群启用。关闭会阻止各群的新调用；群配置保留。平台角色不授予群内容的读取权。</p><div className="plugin-detail-actions"><button className="button primary" disabled={busy || !selected.available} onClick={() => onToggle(selected)}><CheckCircle2 size={15}/>{selected.enabled ? '关闭平台可用性' : '开放给各群'}</button></div>{!selected.available && <p className="inline-note">{selected.kind === 'agent' ? '需在部署端接入专用模型凭据并启用 AI，再由平台开放；不会生成演示结果。' : selected?.id === 'antiad' ? '需部署 Python 推断依赖并通过受信只读模型探测；缺模型时保持不可用。' : '当前是规划项，尚无可运行的插件。'}</p>}
      </>}
    </section>}
  </div>;
}

/** Uses only the existing platform-authenticated maintenance endpoint. */
export function NativePluginMaintenance({ request, preview = false }: { request: (path: string, body?: unknown) => Promise<any>; preview?: boolean }) {
  const [state, setState] = useState<any>();
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'installed' | 'install' | 'configure'>('installed');
  const [query, setQuery] = useState('');
  const [name, setName] = useState('@koishijs/plugin-echo');
  const [version, setVersion] = useState('2.2.5');
  const [key, setKey] = useState('echo:managed');
  const [config, setConfig] = useState('{}');
  const mounted = useRef(false);
  const run = async (body?: unknown) => {
    setBusy(true); setError(''); setMessage('');
    try { const value = await request('/platform/native-plugins', body); if (mounted.current) { setState(value); if (body) setMessage('插件维护已保存，以下为当前加载状态。'); } }
    catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : '插件维护失败。'); }
    finally { if (mounted.current) setBusy(false); }
  };
  useEffect(() => { mounted.current = true; if (!preview) void run(); return () => { mounted.current = false; }; }, [request, preview]);
  const dependencyRows = Object.entries(state?.dependencies ?? {}).filter(([name]) => name.toLowerCase().includes(query.trim().toLowerCase()));
  const plugins = (state?.plugins ?? []).filter((plugin: any) => plugin.key.toLowerCase().includes(query.trim().toLowerCase()));
  const configure = (enabled: boolean) => {
    try {
      const parsed = JSON.parse(config);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      void run({ operation: 'configure', key, config: parsed, enabled });
    } catch { setError('配置必须是 JSON 对象，例如 {}。'); }
  };
  return <section className="panel native-maintenance">
    <div className="section-heading"><div><h2>Koishi 原生插件</h2><p>安装可信插件，查看依赖和加载状态。</p></div><button className="button secondary" disabled={busy || preview} onClick={() => void run()}><RefreshCw size={15} className={busy ? 'spin' : ''}/>刷新状态</button></div>
    <div className="filter-tabs" aria-label="原生插件操作">{([{ id: 'installed', label: '已安装', icon: Package }, { id: 'install', label: '安装 / 升级', icon: Download }, { id: 'configure', label: '配置插件', icon: Settings2 }] as const).map(item => <button key={item.id} aria-pressed={tab === item.id} className={tab === item.id ? 'selected' : ''} onClick={() => setTab(item.id)}><item.icon size={15}/>{item.label}</button>)}</div>
    {error && <div className="toast error" role="alert">{error}</div>}{message && <p role="status" className="inline-note">{message}</p>}
    {state?.restartRequired && <div className="warning-box" role="status">已加载依赖发生更新，需要平台重启后使用新版本。</div>}
    {tab === 'installed' && <><label className="search-field"><Search size={16}/><input aria-label="搜索原生依赖与插件" placeholder="搜索包名或 Loader 插件键…" value={query} onChange={event => setQuery(event.target.value)}/></label>
      {!state ? <div className="empty compact"><Package size={28}/><p>{preview ? '本地预览不提供插件安装。使用 Koishi 原生宿主部署后，此处显示真实依赖与加载状态。' : busy ? '正在读取真实依赖与加载状态…' : '状态暂不可用。请检查原生宿主接入后刷新。'}</p></div> : <>
        <h3 className="subsection-title">Loader 插件 <span>{plugins.length}</span></h3>
        {!plugins.length ? <p className="inline-note">没有匹配的 Loader 插件。</p> : <div className="native-plugin-list">{plugins.map((plugin: any) => <div key={plugin.key}><span className="feature-icon"><Package size={18}/></span><div><strong>{plugin.key}</strong><small>{plugin.enabled ? '配置已启用' : '配置已停用'} · {({ active: '运行中', pending: '等待加载', loading: '加载中', failed: '加载失败', disposed: '已释放', 'not-loaded': '未加载' } as Record<string,string>)[plugin.status] || plugin.status}</small></div><button className="button secondary" disabled={busy} onClick={() => { setKey(plugin.key.replace(/^~/, '')); setConfig(JSON.stringify(plugin.config, null, 2)); setTab('configure'); }}>配置</button></div>)}</div>}
        <h3 className="subsection-title">托管依赖 <span>{dependencyRows.length}</span></h3>
        {!dependencyRows.length ? <p className="inline-note">没有匹配的托管依赖。镜像内置包不一定出现在此清单中。</p> : <div className="table-wrap"><table><thead><tr><th>npm 包</th><th>已解析版本</th></tr></thead><tbody>{dependencyRows.map(([name, value]) => <tr key={name}><td><code>{name}</code></td><td>{(value as any)?.resolved || '尚未解析'}</td></tr>)}</tbody></table></div>}
      </>}
    </>}
    {tab === 'install' && <form className="maintenance-form" onSubmit={event => { event.preventDefault(); void run({ operation: 'install', name, version }); }}><h3>从 npm 安装可信插件</h3><p>填写插件包名与精确版本。安装脚本禁用；安装后不会自动开放各群权限。</p><label className="field">npm 插件包名<input required aria-label="npm 插件包名" value={name} onChange={event => setName(event.target.value)}/></label><label className="field">精确版本<input required aria-label="插件精确版本" value={version} onChange={event => setVersion(event.target.value)} placeholder="例如 2.2.5"/></label><button className="button primary" disabled={busy || !state} type="submit"><Download size={16}/>{busy ? '正在处理…' : '安装 / 升级插件'}</button></form>}
    {tab === 'configure' && <div className="maintenance-form"><h3>配置与启停</h3><p>平台配置对宿主生效；仅填写可信插件支持的参数。群配置仍由各群单独管理。</p><label className="field">Loader 插件键<input aria-label="Loader 插件键" value={key} onChange={event => setKey(event.target.value)}/></label><label className="field">平台配置 JSON<textarea className="code-editor" aria-label="平台配置 JSON" spellCheck={false} value={config} onChange={event => setConfig(event.target.value)}/></label><div className="action-row"><button className="button primary" disabled={busy || !state} onClick={() => configure(true)}>保存并启用</button><button className="button secondary" disabled={busy || !state} onClick={() => configure(false)}>保存并停用</button></div></div>}
  </section>;
}
