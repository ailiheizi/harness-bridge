import React, { useState } from 'react';
import { Search, FileText, Image, Clapperboard, Rss, Clock3, Link2, Copy, Check, ChevronDown, Terminal } from 'lucide-react';
import type { Group } from '../shared';

// Documentation for existing native commands; this directory never invokes tools.
const tools = [
  { id: 'files', gate: 'media', name: '文件读写', icon: FileText, category: '文件与媒体', description: '查看附件信息、读取 TXT / Markdown，或把文字保存成文件。', commands: ['/fileinfo', '/readfile', '/savefile hello'], steps: '在群里发送命令后按提示上传，或回复本人要处理的附件。', condition: '需平台启用文件与媒体服务。', admin: false },
  { id: 'video', gate: 'media', name: '视频与音频', icon: Clapperboard, category: '文件与媒体', description: '视频转 GIF、压缩 MP4、抽取音频、裁剪和查看媒体信息。', commands: ['/v2g', '/convert m4a', '/convert small', '/mediainfo', '/cancelmedia', '/cancelv2g'], steps: '先发送转换命令，再按提示上传媒体。GIF 与其他转换使用各自取消命令。', condition: '需 ENABLE_MEDIA 与 FFmpeg；大小及参数以命令提示为准。', admin: false },
  { id: 'image', gate: 'image', name: '图片与 PDF', icon: Image, category: '文件与媒体', description: '转换 JPG / PNG / WebP；多张图片整理成 PDF。', commands: ['/image webp 1280 80', '/imgpdf start', '/imgpdf done', '/imgpdf cancel'], steps: '转换时回复图片；PDF 先开始收集，等待图片上传完成后发送 done。', condition: '需平台启用图片服务；PDF 最多 10 张，收集窗口 120 秒。', admin: false },
  { id: 'render', gate: 'render', name: 'Markdown 转图', icon: FileText, category: '内容处理', description: '把 Markdown、代码块、公式和 Mermaid 图表转为图片。', commands: ['/mdimg **hello**'], steps: '将需要渲染的文本放在命令后，机器人处理后发送图片。', condition: '需 ENABLE_RENDER 与可用 Chromium；默认部署关闭。', admin: false },
  { id: 'parse', gate: 'parser', name: '公开链接解析', icon: Link2, category: '内容处理', description: '尝试解析公开链接，返回站点允许匿名获取的信息或媒体。', commands: ['/parse https://…'], steps: '把公开网址放在命令后。受限站点会返回原因，不保证所有网站可下载。', condition: '需平台启用 parser / yt-dlp；不登录、不使用 Cookie。', admin: false },
  { id: 'rss', gate: 'rss', name: 'RSS 订阅', icon: Rss, category: '订阅与提醒', description: '为当前群订阅资讯；新条目推送到订阅所在群。', commands: ['/rss https://…/feed.xml', '/rss -l', '/rss -r https://…/feed.xml'], steps: '在已注册的群主群聊添加、列出或取消订阅；首次不大量补发旧内容。', condition: '需平台加载 RSS 及数据库插件。', admin: true },
  { id: 'digest-plan', gate: 'rss', name: '每日订阅摘要', icon: Rss, category: '订阅与提醒', description: '把确认后的本群 RSS 新标题与链接汇总成每日摘要；没有新条目不调用模型。', commands: ['/rssdigest 每天09:00', '/rssdigest status', '/rssdigest run', '/rssdigest stop'], steps: '先添加RSS订阅，再预览来源、期限、调用上限和本群公开输出；按返回的 confirm 命令由本人确认。默认7天最多7次，每天最多一次。', condition: '需要群管理员；平台/本群启用摘要、RSS与定时。第三方模型按实际调用计费；来源或权限变化需重新确认。', admin: true },
  { id: 'ad-review', gate: 'assistant', name: 'AI 广告复核', icon: Search, category: '内容处理', description: '只复核本次明确提交文本的广告或诈骗风险，给人工判断建议。', commands: ['/scan 要复核的文本'], steps: '在群或私聊中提供明确文本，点击本人确认后运行。不读取对话上下文，不自动删帖、禁言或封禁。', condition: '需要平台/本群开放群助手及有效模型；按实际模型调用计费。当前不接受只引用消息后省略正文。', admin: false },
  { id: 'schedule', gate: 'schedule', name: '定时提醒', icon: Clock3, category: '订阅与提醒', description: '一次性或重复提醒，支持列表、编辑、暂停、恢复和删除。', commands: ['/remind daily 09:30 检查面板', '/remind list', '/remind pause <id>', '/remind resume <id>', '/remind remove <id>'], steps: '在当前群发送命令；时区由部署设置决定，重复间隔最短 60 秒。', condition: '需平台加载 schedule 插件；关闭群开关后不再发起新投递。', admin: true },
];
const categories = ['全部', '文件与媒体', '内容处理', '订阅与提醒'];

export function ToolDirectory({ group, preview }: { group: Group; preview: boolean }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('全部');
  const [copied, setCopied] = useState('');
  const [error, setError] = useState('');
  const visible = tools.filter(tool => (category === '全部' || tool.category === category) && `${tool.name} ${tool.description} ${tool.commands.join(' ')}`.toLowerCase().includes(query.trim().toLowerCase()));
  async function copy(command: string) {
    setError('');
    try { await navigator.clipboard.writeText(command); setCopied(command); }
    catch { setError('浏览器未允许复制，请手动选择命令文本。'); }
  }
  return <>
    <div className="info-strip"><Terminal size={18}/><span>{preview ? '当前为本地预览，下方提供真实命令用法；Telegram 工具不会在本页执行。' : '在当前 Telegram 群使用下方命令。此目录展示已接入的能力；运行依赖仍由平台维护。'}「群已允许」仅表示本群开关，不代表服务已部署。</span></div>
    <div className="directory-toolbar"><label className="search-field"><Search size={17}/><input aria-label="搜索工具与命令" placeholder="搜索功能、命令，例如 PDF、RSS…" value={query} onChange={event => setQuery(event.target.value)}/></label><span className="muted">{visible.length} 项工具</span></div>
    <div className="filter-tabs" aria-label="工具分类">{categories.map(item => <button key={item} aria-pressed={category === item} className={category === item ? 'selected' : ''} onClick={() => setCategory(item)}>{item}</button>)}</div>
    {error && <p role="alert">{error}</p>}
    {!visible.length ? <div className="panel empty compact"><Search size={28}/><h3>没有匹配的工具</h3><p>试试功能名称或命令，也可以清除筛选。</p><button className="button secondary" onClick={() => { setQuery(''); setCategory('全部'); }}>显示全部工具</button></div> : <div className="tool-grid">{visible.map(tool => {
      const Icon = tool.icon;
      const nativeAllowed = (id: string) => !group.config.nativeFeatures || group.config.nativeFeatures.includes(id);
      const allowed = tool.id === 'ad-review' ? group.config.features.includes('assistant') : tool.id === 'digest-plan' ? group.config.features.includes('digest') && nativeAllowed('rss') && nativeAllowed('schedule') : nativeAllowed(tool.gate);
      const usesModel = tool.id === 'ad-review' || tool.id === 'digest-plan';
      return <article className="panel tool-card" key={tool.id}>
        <div className="tool-heading"><span className="feature-icon blue"><Icon size={21}/></span><div><h2>{tool.name}</h2><small>{tool.category}</small></div><span className={`tool-status ${allowed ? '' : 'off'}`}>{allowed ? '群已允许' : '本群已关闭'}</span></div>
        <p>{tool.description}</p><div className="tool-tags"><span>{tool.admin ? '群管理员操作' : '成员可用命令'}</span><span>Telegram</span><span>{usesModel ? '需要模型 · 按实际计费' : '无需模型'}</span></div>
        {!allowed && <p className="inline-note">当前群关闭了此类工具，请由群管理员在「功能配置」调整。</p>}
        {tool.admin && group.role !== 'admin' && <p className="inline-note">你可以查看用法；添加或调整需要本群管理员。</p>}
        <div className="command-list">{tool.commands.slice(0, 2).map(command => <div key={command}><code>{command}</code><button className="icon-button" aria-label={`复制 ${command}`} onClick={() => void copy(command)}>{copied === command ? <Check size={16}/> : <Copy size={16}/>}</button></div>)}</div>
        <details><summary>步骤与更多命令 <ChevronDown size={14}/></summary><p>{tool.steps}</p>{tool.commands.slice(2).map(command => <div className="extra-command" key={command}><code>{command}</code><button className="text-button" onClick={() => void copy(command)}>{copied === command ? '已复制' : '复制'}</button></div>)}<p className="inline-note">{tool.condition}</p></details>
      </article>;
    })}</div>}
    <p className="footer-note">链接整理与 AI 问答也可从「在线使用」发起；此目录不授予额外权限。</p>
  </>;
}
