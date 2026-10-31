import React, { useState } from 'react';
import { Blocks, CheckCircle2, ChevronRight, LockKeyhole, SlidersHorizontal, Terminal } from 'lucide-react';
import type { Group, GroupConfig, Plugin } from '../shared';

// Capability details only; execution stays behind the existing task API.
const notes: Record<string, { implementation: string; access: string; cost: string; entry: string }> = {
  'link-cleaner': { implementation: 'Koishi 代码插件 · 经既有 DSH 无模型入口调用', access: '本次提交的文本；不读取群历史，不打开链接', cost: '零模型调用；最多 100 条链接', entry: '群内 /links 或 @机器人；面板显式执行' },
  echo: { implementation: 'Koishi 官方 Echo 插件 · 原生命令', access: '仅本次提交的文本；群内回到当前群，面板可选私人结果', cost: '零模型调用', entry: '群内 /echo，或回复消息后 /echo；面板也可使用' },
  digest: { implementation: 'DSH 原生 Skill · DeepSeek Adapter', access: '仅本次确认提交的文本会发送给 DeepSeek；不读取群历史', cost: '每次最多一次模型请求；输入最多 8 KB', entry: '群内 /digest 后本人确认；面板每次确认第三方处理' },
  'link-brief': { implementation: 'DSH Agent/Skill → Koishi 链接代码 → AI 说明', access: '本次确认的文本及代码结果发送给 DeepSeek；不读取群历史，不打开链接', cost: '最多两次模型请求；一次真实链接代码调用；默认关闭', entry: '群内 /brief 后本人确认；依赖本群链接整理' },
  assistant: { implementation: 'DSH 原生 Agent/Skill · 按目标选择代码', access: '本次确认的目标；最多调用本群链接整理一次，模型不能选择其他群或用户', cost: '最多两次模型请求；最多一次代码调用', entry: '群内 /ask 后本人确认；面板也可使用' },
  welcome: { implementation: 'Koishi 原生文本插件', access: '当前群加入事件的成员显示名及本群模板；不读取历史', cost: '零模型调用；纯文本模板', entry: '平台和本群启用后，新成员加入时自动欢迎' },
  antiad: { implementation: '既有 antiad 纯预测核心 · 固定 Python 入口', access: '仅本次提交的文本及本群规则；只读平台批准的基准模型', cost: '零大模型调用；一次有界本地推断', entry: '群内 /scan，或回复文本后 /scan；当前只提供检测建议' },
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
  const [selection, setSelection] = useState('link-cleaner');
  const [draft, setDraft] = useState<{ deduplicate: boolean; sort: boolean; maxItems: number } | undefined>();
  const [welcomeDraft, setWelcomeDraft] = useState<string | undefined>();
  const [antiadDraft, setAntiadDraft] = useState<{ prompt: number; action: number; keywords: string } | undefined>();
  const selected = plugins.find(plugin => plugin.id === selection) || plugins[0];
  if (!selected) return <div className="panel"><p>暂无插件信息。</p></div>;
  const detail = notes[selected.id];
  const enabled = group ? group.config.features.includes(selected.id) : selected.enabled;
  const links = plugins.find(plugin => plugin.id === 'link-cleaner');
  const missingDependency = !!group && selected.id === 'link-brief' && (!group.config.features.includes('link-cleaner') || !links?.available || !links.enabled);
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
      {plugins.map(plugin => <button key={plugin.id} className={`plugin-row ${selected.id === plugin.id ? 'selected' : ''}`} aria-pressed={selected.id === plugin.id} onClick={() => { setSelection(plugin.id); setDraft(undefined); setWelcomeDraft(undefined); setAntiadDraft(undefined); }}>
        <span className={`feature-icon ${plugin.color}`}><Blocks size={19}/></span><span><strong>{plugin.name}</strong><small>{pluginStatus(plugin, group, plugins)}</small></span><ChevronRight size={14}/>
      </button>)}
      <p className="plugin-list-note">{group ? '每个群独立保存启用状态与规则。平台关闭后，本群也无法调用。' : '插件由平台维护并随应用版本发布。待接入能力不能开放。'}</p>
    </section>
    <section className="panel plugin-detail" aria-label={`${selected.name}详情`}>
      <div className="plugin-detail-heading"><div><div className="eyebrow">{group ? 'GROUP PLUGIN CONFIGURATION' : 'PLATFORM PLUGIN MANAGEMENT'}</div><h2>{selected.name}</h2><p>{selected.description}</p></div><span className={`task-status ${selected.available && selected.enabled && enabled && !missingDependency ? 'succeeded' : 'blocked'}`}>{pluginStatus(selected, group, plugins)}</span></div>
      <div className="plugin-facts"><div><span><Terminal size={14}/>实现方式</span><strong>{detail?.implementation || '未标注'}</strong></div><div><span><LockKeyhole size={14}/>数据访问</span><strong>{detail?.access || selected.scope}</strong></div><div><span>使用入口</span><strong>{detail?.entry || '尚未验收'}</strong></div><div><span>资源范围</span><strong>{detail?.cost || '尚未验收'}</strong></div></div>
      {group ? <>
        <div className="plugin-setting-heading"><h3>本群配置</h3><span className="version">规则 v{group.version}</span></div>
        {selected.id === 'link-cleaner' && linkOptions && <div className="plugin-settings"><label className="field">单次链接上限<input aria-label="插件单次链接上限" type="number" min="1" max="100" value={linkOptions.maxItems} disabled={busy} onChange={event => setDraft({ ...linkOptions, maxItems: Number(event.target.value) })}/></label><label className="check-field"><input type="checkbox" checked={linkOptions.deduplicate} disabled={busy} onChange={event => setDraft({ ...linkOptions, deduplicate: event.target.checked })}/><span>去除重复链接</span></label><label className="check-field"><input type="checkbox" checked={linkOptions.sort} disabled={busy} onChange={event => setDraft({ ...linkOptions, sort: event.target.checked })}/><span>按链接排序</span></label>{dirty && <p className="inline-note">调整尚未生效；预览并确认后只更新本群。</p>}<button className="button secondary" disabled={busy || !dirty} onClick={() => onPreview?.({ ...group.config, deduplicate: linkOptions.deduplicate, sort: linkOptions.sort, maxItems: linkOptions.maxItems })}><SlidersHorizontal size={15}/>预览参数调整</button></div>}
        {selected.id === 'welcome' && <div className="plugin-settings"><label className="field">欢迎文本<textarea aria-label="欢迎文本" maxLength={500} value={welcomeText} disabled={busy} placeholder="欢迎 {name} 加入 {group}！" onChange={event => setWelcomeDraft(event.target.value)}/></label><p className="inline-note">{'{name}'} 为本次加入的显示名，{'{group}'} 为本群名称。留空使用默认语言模板；文本不会作为代码或 AI 指令执行。</p><button className="button secondary" disabled={busy || welcomeDraft === undefined || welcomeText === (group.config.welcomeText ?? '')} onClick={() => onPreview?.({ ...group.config, welcomeText })}><SlidersHorizontal size={15}/>预览欢迎文本调整</button></div>}
        {selected.id === 'antiad' && <div className="plugin-settings"><label className="field">提示阈值<input aria-label="广告提示阈值" type="number" min="0.01" max="1" step="0.01" value={antiadOptions.prompt} disabled={busy} onChange={event => setAntiadDraft({ ...antiadOptions, prompt: Number(event.target.value) })}/></label><label className="field">高风险阈值<input aria-label="广告高风险阈值" type="number" min="0.01" max="1" step="0.01" value={antiadOptions.action} disabled={busy} onChange={event => setAntiadDraft({ ...antiadOptions, action: Number(event.target.value) })}/></label><label className="field">本群广告关键词<textarea aria-label="本群广告关键词" value={antiadOptions.keywords} disabled={busy} placeholder="每行一项，最多 50 项" onChange={event => setAntiadDraft({ ...antiadOptions, keywords: event.target.value })}/></label><p className="inline-note">分数用于人工复核建议，当前不会自动删消息或封禁。群关键词不写入共享模型，不导入旧群训练样本。</p>{!validAntiad && <p className="inline-note">阈值需满足 0 &lt; 提示 ≤ 高风险 ≤ 1；关键词最多 50 个，每项不超过 80 字且不得重复。</p>}<button className="button secondary" disabled={busy || !antiadDraft || !validAntiad} onClick={() => onPreview?.({ ...group.config, antiadPromptThreshold: antiadOptions.prompt, antiadActionThreshold: antiadOptions.action, antiadStopwords: keywords })}><SlidersHorizontal size={15}/>预览检测规则调整</button></div>}
        {!['link-cleaner', 'welcome', 'antiad'].includes(selected.id) && <p className="inline-note">{selected.id === 'digest' ? '模型与专用凭据由平台维护，成员每次自行确认提交文本。' : selected.id === 'echo' ? '回显没有额外的群级参数，仅处理本次文本。' : selected.id === 'link-brief' ? '复用本群链接整理参数。每次执行确认提交文本及代码结果。' : selected.id === 'assistant' ? '只回答本次目标；本群链接整理可用时才向模型开放对应代码工具。凭据和模型由平台维护，不能通过提示词扩权。' : '能力接入并验收后才能配置。'}</p>}
        {missingDependency && <p className="inline-note">需先由平台开放、本群启用链接整理，才能使用链接整理与说明。</p>}
        <div className="plugin-detail-actions"><button className="button primary" disabled={busy || !selected.available || !selected.enabled || (!enabled && missingDependency)} onClick={() => onToggle(selected)}>{enabled ? '停用本群插件' : '启用本群插件'}</button><button className="text-button" onClick={onRules}>调整响应方式与群规则 <ChevronRight size={14}/></button></div><p className="inline-note">启停同样先生成预览；群内输出为本群公开结果，面板可选择仅自己可见。</p>
      </> : <>
        <div className="plugin-setting-heading"><h3>平台可用性</h3><span className="badge code">应用版本 0.1.0</span></div><p className="inline-note">开放后，群管理员还需为本群启用。关闭会阻止各群的新调用；群配置保留。平台角色不授予群内容的读取权。</p><div className="plugin-detail-actions"><button className="button primary" disabled={busy || !selected.available} onClick={() => onToggle(selected)}><CheckCircle2 size={15}/>{selected.enabled ? '关闭平台可用性' : '开放给各群'}</button></div>{!selected.available && <p className="inline-note">{selected.kind === 'agent' ? '需在部署端接入专用模型凭据并启用 AI，再由平台开放；不会生成演示结果。' : selected.id === 'antiad' ? '需部署 Python 推断依赖并通过受信只读模型探测；缺模型时保持不可用。' : '当前是规划项，尚无可运行的插件。'}</p>}
      </>}
    </section>
  </div>;
}

/** Uses the platform's existing authenticated, CSRF-protected request function. */
export function NativePluginMaintenance({ request }: { request: (path: string, body?: unknown) => Promise<any> }) {
  const [state, setState] = useState<any>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('@koishijs/plugin-echo');
  const [version, setVersion] = useState('2.2.5');
  const [key, setKey] = useState('echo:managed');
  const [config, setConfig] = useState('{}');
  const run = async (body?: unknown) => {
    setBusy(true); setError('');
    try { setState(await request('/api/platform/native-plugins', body)); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '插件维护失败。'); }
    finally { setBusy(false); }
  };
  return <section className="panel"><h2>原生插件维护</h2>
    <p>仅平台管理员。npm 插件属于可信服务器代码；安装不会自动开放群权限。安装脚本禁用，需脚本的插件由部署维护。</p>
    <button disabled={busy} onClick={() => void run()}>读取真实依赖与状态</button>
    {error && <p role="alert">{error}</p>}
    {state?.restartRequired && <p role="alert">已加载依赖发生更新，需要平台重启后使用新版本。</p>}
    <label>可信 npm 插件<input value={name} onChange={event => setName(event.target.value)}/></label>
    <label>精确版本<input value={version} onChange={event => setVersion(event.target.value)}/></label>
    <button disabled={busy} onClick={() => void run({ operation: 'install', name, version })}>安装 / 升级</button>
    <label>Loader 插件键<input value={key} onChange={event => setKey(event.target.value)}/></label>
    <label>平台配置 JSON<textarea value={config} onChange={event => setConfig(event.target.value)}/></label>
    {[true, false].map(enabled => <button key={String(enabled)} disabled={busy} onClick={() => {
      try { const parsed = JSON.parse(config); void run({ operation: 'configure', key, config: parsed, enabled }); }
      catch { setError('配置必须是 JSON 对象。'); }
    }}>{enabled ? '保存并启用' : '保存并停用'}</button>)}
    {state && <><h3>依赖</h3><pre>{JSON.stringify(state.dependencies, null, 2)}</pre><h3>Loader 状态</h3>
      {state.plugins?.map((plugin: any) => <button key={plugin.key} onClick={() => { setKey(plugin.key.replace(/^~/, '')); setConfig(JSON.stringify(plugin.config, null, 2)); }}>{plugin.key} · {plugin.enabled ? '启用' : '停用'} · {String(plugin.status)}</button>)}</>}
  </section>;
}
