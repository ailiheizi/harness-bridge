import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createRequire } from 'node:module';
import https from 'node:https';
import type { Context, Session } from 'koishi';
import axios, { type AxiosInstance } from 'axios';
import { extractPublicSiteVideo, type SiteExtraction, type SiteName } from './site-extractor.js';

const require = createRequire(import.meta.url);
const { h } = require('@koishijs/core') as typeof import('koishi');
const { processSingleUrl } = require('koishi-plugin-video-parser-all/lib/service/parser.js') as {
  processSingleUrl(http: AxiosInstance, config: Record<string, unknown>, url: string, type: string, platformConf?: Record<string, unknown>): Promise<{
    success: true; data: { text: string; parsed: { title?: string; author?: string; type?: string; video?: string; cover?: string; images?: string[]; live_photo?: Array<{ image?: string }> } };
  } | { success: false; msg: string; url: string }>;
};
const { linkTypeParser } = require('koishi-plugin-video-parser-all/lib/link-rules.js') as {
  linkTypeParser(content: string, customRules: unknown[]): Array<{ type: string; url: string }>;
};

const MAX_ACTIVE = 2;
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_IMAGES = 6;
const MAX_URL_LENGTH = 2048;
const MAX_OPERATION_MS = 60_000;

type SiteParserOptions = {
  authorize(session: Session): boolean | Promise<boolean>;
  apiUrl?: string;
  apiKey?: string;
  ytDlpPath?: string;
  bilibiliCookiesFile?: string;
  douyinCookiesFile?: string;
  tempDir?: string;
  /** Injection seam for deterministic adapter tests; production uses yt-dlp. */
  directExtract?: (input: { url: string; site: SiteName; cookiesFile?: string; signal: AbortSignal }) => Promise<SiteExtraction>;
};

function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split('.').map(Number);
    const [a, b] = octets;
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || (b === 0 && octets[2] === 0) || (b === 0 && octets[2] === 2) || (b === 88 && octets[2] === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && octets[2] === 100)))
      || (a === 203 && b === 0 && octets[2] === 113));
  }
  if (family !== 6) return false;
  const normalized = address.toLowerCase().split('%')[0];
  if (normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd')
    || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')
    || normalized.startsWith('ff') || normalized.startsWith('2001:db8:')) return false;
  // Only globally routable unicast (2000::/3) is accepted.
  return /^2[0-9a-f]{3}:/.test(normalized);
}

function pinnedHttpsAgent(hostname: string): https.Agent {
  const targetHost = hostname.replace(/^\[|\]$/g, '');
  let addresses: Array<{ address: string; family: number }> | undefined;
  return new https.Agent({
    keepAlive: false,
    lookup(host, options, callback) {
      const done = callback as (error: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family?: number) => void;
      const requestHost = host.replace(/^\[|\]$/g, '');
      if (requestHost.toLowerCase() !== targetHost.toLowerCase()) return done(Object.assign(new Error('Host changed'), { code: 'EACCES' }), '', 0);
      const resolve = async () => {
        if (!addresses) {
          const records = await lookup(targetHost, { all: true, verbatim: true });
          if (!records.length || records.some(record => !publicAddress(record.address))) throw Object.assign(new Error('Unsafe address'), { code: 'EACCES' });
          addresses = records;
        }
        return addresses;
      };
      void resolve().then(records => {
        const all = typeof options === 'object' && options !== null && 'all' in options && options.all;
        if (all) done(null, records);
        else done(null, records[0].address, records[0].family);
      }, error => done(error as NodeJS.ErrnoException, '', 0));
    },
  });
}

function checkedHttpsUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.port && url.port !== '443') return;
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || isIP(hostname) && !publicAddress(hostname)) return;
    return url;
  } catch { return; }
}

function checkedApiUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return;
    return url;
  } catch { return; }
}

function selectedUrl(session: Session, input: string | undefined): { url: string; type: string } | undefined {
  let content = input?.trim() || '';
  if (!content) {
    const raw = (session.event as any)._data?.message;
    if (!raw?.reply_to_message || String(raw.reply_to_message.chat?.id) !== String(raw.chat?.id)) return;
    content = typeof raw.reply_to_message.text === 'string' ? raw.reply_to_message.text
      : typeof raw.reply_to_message.caption === 'string' ? raw.reply_to_message.caption : '';
  }
  const matches = linkTypeParser(content, []).filter(item => item.type === 'bilibili' || item.type === 'douyin');
  const unique = [...new Map(matches.map(item => [`${item.type}\n${item.url}`, item])).values()];
  if (unique.length !== 1) return;
  const parsed = checkedHttpsUrl(unique[0].url);
  if (!parsed) return;
  return { url: parsed.href, type: unique[0].type };
}

async function fetchMedia(url: string, expected: 'image' | 'video', signal: AbortSignal): Promise<{ bytes: Buffer; mime: string }> {
  const parsed = checkedHttpsUrl(url);
  if (!parsed) throw new Error('unsafe media URL');
  const agent = pinnedHttpsAgent(parsed.hostname);
  try {
    const response = await axios.get<ArrayBuffer>(parsed.href, {
      responseType: 'arraybuffer', timeout: 15_000, signal, maxRedirects: 0,
      maxContentLength: MAX_MEDIA_BYTES, maxBodyLength: MAX_MEDIA_BYTES,
      httpsAgent: agent, proxy: false, validateStatus: status => status >= 200 && status < 300,
    });
    const bytes = Buffer.from(response.data);
    if (!bytes.length || bytes.length > MAX_MEDIA_BYTES) throw new Error('media size limit');
    const mime = expected === 'image' ? sniffImage(bytes) : sniffVideo(bytes);
    if (!mime) throw new Error('unsupported media type');
    return { bytes, mime };
  } finally { agent.destroy(); }
}

function sniffImage(bytes: Buffer): string | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.toString('ascii', 0, 6).match(/^GIF8[79]a$/)) return 'image/gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
}

function sniffVideo(bytes: Buffer): string | undefined {
  if (bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4';
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'video/webm';
}

function mediaItems(parsed: { video?: string; cover?: string; images?: string[]; live_photo?: Array<{ image?: string }>; type?: string }, directVideo?: SiteExtraction) {
  const items: Array<{ url?: unknown; kind: 'image' | 'video'; bytes?: Buffer; mime?: string }> = [];
  if (parsed.type === 'image') {
    for (const url of (parsed.images ?? []).slice(0, MAX_IMAGES)) items.push({ url, kind: 'image' });
  } else if (parsed.type === 'live_photo') {
    for (const item of (parsed.live_photo ?? []).slice(0, MAX_IMAGES)) if (item.image) items.push({ url: item.image, kind: 'image' });
  } else {
    if (parsed.cover) items.push({ url: parsed.cover, kind: 'image' });
    if (directVideo) items.push({ kind: 'video', bytes: directVideo.media, mime: directVideo.mime });
    else if (parsed.video) items.push({ url: parsed.video, kind: 'video' });
  }
  return items;
}

async function sendText(session: Session, text: string): Promise<boolean> {
  const receipt = await session.send(h.text(text.slice(0, 3500)));
  return Boolean(receipt?.length);
}

async function authorized(options: SiteParserOptions, session: Session): Promise<boolean> {
  try { return await options.authorize(session); } catch { return false; }
}

function callerKey(session: Session): string | undefined {
  const userId = session.event.user?.id ?? session.userId;
  const chatId = session.channelId ?? session.guildId;
  if (session.platform !== 'telegram' || !session.selfId || !userId || !chatId) return;
  return `${session.selfId}:${chatId}:${userId}`;
}

/** Install a manually invoked, group-admitted Bilibili/Douyin parser command. */
export function installSiteParserCommands(ctx: Context, options: SiteParserOptions): void {
  const activeCallers = new Set<string>();
  const controllers = new Set<AbortController>();
  let activeParses = 0;
  ctx.on('dispose', () => { for (const controller of controllers) controller.abort(new Error('site parser disposed')); });
  const cmd = ctx.command('parse [url:text]', '解析 B 站或抖音链接');
  cmd.alias('链接解析');
  cmd.action(async ({ session }, input?: string) => {
    if (!session) return;
    const reply = async (text: string) => {
      if (!await authorized(options, session)) return false;
      try { return await sendText(session, text); } catch { return false; }
    };
    if (!await authorized(options, session)) return;
    const hasApiUrl = Boolean(options.apiUrl?.trim());
    const hasApiKey = Boolean(options.apiKey?.trim());
    if (hasApiUrl !== hasApiKey) { await reply('视频解析 API 配置不完整，请联系平台管理员。'); return; }
    const api = hasApiUrl ? checkedApiUrl(options.apiUrl!.trim()) : undefined;
    if (hasApiUrl && !api) { await reply('视频解析 API 配置无效，请联系平台管理员。'); return; }
    const target = selectedUrl(session, input);
    if (!target) { await reply('请提供一个受支持的 B 站或抖音链接；也可回复同一聊天中的链接后使用 /parse。'); return; }
    const key = callerKey(session);
    if (!key || activeCallers.has(key) || activeParses >= MAX_ACTIVE) { await reply('视频解析繁忙，请稍后重试。'); return; }
    activeCallers.add(key);
    activeParses++;
    const controller = new AbortController();
    controllers.add(controller);
    const deadline = setTimeout(() => controller.abort(new Error('site parser operation deadline')), MAX_OPERATION_MS);
    try {
      let parsed: { title?: string; author?: string; type?: string; video?: string; cover?: string; images?: string[]; live_photo?: Array<{ image?: string }> };
      let directVideo: SiteExtraction | undefined;
      if (api) {
        const apiHttp = axios.create({ timeout: 15_000, signal: controller.signal, maxContentLength: 2 * 1024 * 1024, maxBodyLength: 2 * 1024 * 1024, maxRedirects: 0, proxy: false });
        const result = await processSingleUrl(apiHttp, {
          maxDescLength: 200, unifiedMessageFormat: '${标题}\n${作者}', authMode: 'header', timeout: 15_000,
          retryTimes: 0, retryInterval: 0, cacheTTL: 0, apiKey: options.apiKey!.trim(), primaryApiUrl: api.href,
        }, target.url, target.type, { apiUrls: [], dedicatedFirst: false, apiKey: options.apiKey!.trim(), authHeaderType: 'X-API-Key' });
        if (controller.signal.aborted) { await reply('视频解析超过时间限制，结果不完整。'); return; }
        if (!result.success) { await reply('视频解析失败，请稍后重试。'); return; }
        parsed = result.data.parsed;
      } else {
        const site = target.type as SiteName;
        const cookiesFile = site === 'bilibili' ? options.bilibiliCookiesFile : options.douyinCookiesFile;
        try {
          directVideo = options.directExtract
            ? await options.directExtract({ url: target.url, site, cookiesFile, signal: controller.signal })
            : await extractPublicSiteVideo({ url: target.url, site, cookiesFile, ytDlpPath: options.ytDlpPath, tempDir: options.tempDir, signal: controller.signal });
        } catch (error) {
          if (controller.signal.aborted || error instanceof Error && error.message.includes('timed out')) await reply('视频解析超过时间限制，结果不完整。');
          else if (error instanceof Error && error.message.includes('site requires fresh cookies')) await reply('站点需要新鲜 Cookie；请平台管理员更新对应的只读 Cookie 文件。');
          else if (error instanceof Error && /cookie/i.test(error.message)) await reply('解析 Cookie 文件不可用；请确认其为仅当前服务用户可读的绝对路径并已只读挂载。');
          else if (error instanceof Error && error.message.includes('publicly available')) await reply('仅支持公开可访问的视频，不支持会员、私密或登录限定内容。');
          else if (error instanceof Error && error.message.includes('ffmpeg')) await reply('本地解析需要 FFmpeg 合并视频和音频，请联系平台管理员检查运行时。');
          else if (error instanceof Error && error.message.includes('media size limit')) await reply('视频超过 10 MiB 限制，暂不支持此链接。');
          else if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') await reply('本地 yt-dlp 解析工具未安装，请联系平台管理员。');
          else await reply('站点暂时无法直接解析；请确认链接公开可访问，或稍后重试。');
          return;
        }
        parsed = { title: directVideo.title, author: directVideo.author, type: 'video', cover: directVideo.thumbnail };
      }
      const heading = [parsed.title?.trim(), parsed.author?.trim()].filter(Boolean).join('\n').slice(0, 800) || '解析完成';
      if (!await authorized(options, session)) return;
      if (!await reply(heading)) return;
      let totalBytes = 0;
      let sentMedia = 0;
      let mediaFailed = false;
      const items = mediaItems(parsed, directVideo);
      for (const item of items) {
        if (sentMedia >= MAX_IMAGES + 2 || !await authorized(options, session)) break;
        if (controller.signal.aborted) { mediaFailed = true; break; }
        const mediaUrl = item.bytes ? undefined : checkedHttpsUrl(item.url);
        if (!item.bytes && !mediaUrl) { mediaFailed = true; continue; }
        try {
          const media = item.bytes ? { bytes: item.bytes, mime: item.mime! } : await fetchMedia(mediaUrl!.href, item.kind, controller.signal);
          if (totalBytes + media.bytes.length > MAX_TOTAL_BYTES) { mediaFailed = true; break; }
          if (!await authorized(options, session)) break;
          const element = item.kind === 'image' ? h.image(media.bytes, media.mime) : h.video(media.bytes, media.mime);
          let receipts;
          try { receipts = await session.send(element); }
          catch { await reply('解析信息已发送，但媒体投递结果未知；已停止继续发送。'); return; }
          if (!receipts?.length) { await reply('解析信息已发送，但媒体投递结果未知；已停止继续发送。'); return; }
          totalBytes += media.bytes.length;
          sentMedia++;
        } catch { mediaFailed = true; /* A failed media fetch is reported as a partial result below. */ }
      }
      if (controller.signal.aborted) await reply('解析信息已发送；媒体处理超过时间限制，本次结果不完整。');
      else if (mediaFailed && await authorized(options, session)) await reply('已发送解析信息；部分媒体获取或投递失败，本次结果不完整。');
      else if (!sentMedia && items.length && await authorized(options, session)) await reply('已发送解析信息；媒体获取或投递失败，本次结果不完整。');
      else if (!items.length) await reply('已发送解析信息；上游未返回可投递媒体。');
    } catch {
      await reply('视频解析失败或结果不完整，请稍后重试。');
    } finally {
      clearTimeout(deadline);
      controller.abort();
      controllers.delete(controller);
      activeParses--;
      activeCallers.delete(key);
    }
  });
}
