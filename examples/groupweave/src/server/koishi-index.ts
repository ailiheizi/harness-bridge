import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Bot } from 'koishi';
import { buildApp } from './app.js';
import { ApiError, type Executor } from './actions.js';
import { cleanLinks } from './links.js';
import { createKoishiRuntime, type KoishiRuntime } from './koishi-runtime.js';
import { createTelegramBinding } from './telegram-binding.js';
import { createTelegramRoleVerifier, installGroupCommands, telegramCommandSource } from './koishi-business.js';
import { installRssIntegration } from './koishi-rss.js';
import { installScheduleIntegration } from './koishi-schedule.js';
import { installWelcomeIntegration } from './koishi-welcome.js';
import { welcomeText } from './koishi-plugins/welcome.js';
import { telegramActorId, telegramGroupId } from './store.js';
import { installAiCommands } from './koishi-ai.js';
import { installMediaCommands } from './koishi-media.js';
import { installVideoIntegration } from './koishi-video.js';
import { installTranscodeCommands } from './koishi-transcode.js';
import { installImageCommands } from './koishi-images.js';
import { installMarkdownIntegration } from './koishi-render.js';
import { installSiteParserCommands } from './koishi-site-parser.js';
import { createStoreAuthorizedSandboxExecutor, loadSandboxBindingModule, sandboxTaskTimeoutMs, type SandboxBindingSource } from './sandbox-wiring.js';
import { loadSandboxProfiles, type ModelProfile } from './sandbox-profiles.js';
import { nativeFeatureAllowed, type NativeFeature } from './group-config.js';
import { installSessionCommands } from './koishi-session.js';
import { installNaturalRuleCommands } from './rule-proposals.js';

class StartupConfigurationError extends Error {}
const require = createRequire(import.meta.url);
const { h } = require('@koishijs/core') as typeof import('koishi');
const { FFmpeg } = require('koishi-plugin-ffmpeg') as typeof import('koishi-plugin-ffmpeg');

/** Native Koishi entry. It never starts the legacy grammY receiver. */
export async function startKoishiHost(configPath = resolve(process.env.KOISHI_CONFIG || 'koishi.yml')) {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let runtime: KoishiRuntime | undefined;
  let enabled = false;
  let mediaEnabled = false;
  let renderEnabled = false;
  let renderBrowserPath: string | undefined;
  let parserApiUrl: string | undefined;
  let parserApiKey: string | undefined;
  let parserEnabled = false;
  let parserYtDlpPath: string | undefined;
  let ffmpegPath = 'ffmpeg';
  let ffprobePath = 'ffprobe';
  let host = '127.0.0.1';
  let port = 4318;
  let dataDir = '';
  let adminIds: string[] = [];
  let sandboxModule: SandboxBindingSource | undefined;
  let modelProfiles: ModelProfile[] = [];
  let sandbox: ReturnType<typeof createStoreAuthorizedSandboxExecutor> | undefined;
  const telegramBot = (): Bot | undefined => runtime?.app.bots.find(bot => bot.platform === 'telegram');
  const refreshRole = createTelegramRoleVerifier(telegramBot, () => {
    if (!app) throw new Error('APPLICATION_NOT_READY');
    return app.groupweave.store;
  });

  try {
    runtime = await createKoishiRuntime({
      configPath,
      maintenanceDir: () => resolve(dataDir, 'plugins'),
      // Native Loader reads .env/.env.local before this hook. Validate before
      // constructing any bot or opening a database from that configuration.
      async beforeCreate() {
        const value = process.env.ENABLE_TELEGRAM || '0';
        if (!['0', '1'].includes(value)) throw new StartupConfigurationError('ENABLE_TELEGRAM 必须为 0 或 1。');
        enabled = value === '1';
        process.env.TZ ||= 'Asia/Shanghai';
        host = process.env.HOST || '127.0.0.1';
        port = Number(process.env.PORT || 4318);
        if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new StartupConfigurationError('PORT 必须是有效端口。');
        adminIds = (process.env.TELEGRAM_ADMIN_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
        if (adminIds.some(id => !/^[1-9]\d*$/.test(id))) throw new StartupConfigurationError('TELEGRAM_ADMIN_IDS 必须为逗号分隔的用户 ID。');
        if (enabled && (!process.env.TELEGRAM_BOT_TOKEN?.trim() || !adminIds.length)) {
          throw new StartupConfigurationError('ENABLE_TELEGRAM=1 需要 TELEGRAM_BOT_TOKEN 和 TELEGRAM_ADMIN_IDS。');
        }
        if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !process.env.PUBLIC_ORIGIN) {
          throw new StartupConfigurationError('非本机管理 API 需要 HTTPS PUBLIC_ORIGIN。');
        }
        dataDir = resolve(dirname(resolve(configPath)), process.env.DATA_DIR || 'data');
        await mkdir(dataDir, { recursive: true });
        const media = process.env.ENABLE_MEDIA || '0';
        if (!['0', '1'].includes(media)) throw new StartupConfigurationError('ENABLE_MEDIA 必须为 0 或 1。');
        mediaEnabled = media === '1';
        const render = process.env.ENABLE_RENDER || '0';
        if (!['0', '1'].includes(render)) throw new StartupConfigurationError('ENABLE_RENDER 必须为 0 或 1。');
        renderEnabled = render === '1';
        renderBrowserPath = process.env.RENDER_BROWSER_PATH?.trim() || undefined;
        parserApiUrl = process.env.SITE_PARSER_API_URL?.trim() || undefined;
        parserApiKey = process.env.SITE_PARSER_API_KEY?.trim() || undefined;
        if (Boolean(parserApiUrl) !== Boolean(parserApiKey)) throw new StartupConfigurationError('远程解析 API 需同时配置地址和密钥；直接解析只需启用 ENABLE_SITE_PARSER。');
        const siteParser = process.env.ENABLE_SITE_PARSER || '0';
        if (!['0', '1'].includes(siteParser)) throw new StartupConfigurationError('ENABLE_SITE_PARSER 必须为 0 或 1。');
        parserEnabled = siteParser === '1' || Boolean(parserApiUrl && parserApiKey);
        if (siteParser === '1' && !parserApiUrl && !parserApiKey) {
          parserYtDlpPath = process.env.SITE_PARSER_YTDLP_PATH?.trim() || 'yt-dlp';
          try { await promisify(execFile)(parserYtDlpPath, ['--ignore-config', '--version'], { timeout: 5_000, maxBuffer: 16 * 1024 }); }
          catch { throw new StartupConfigurationError('ENABLE_SITE_PARSER=1 需要已安装的 yt-dlp；请设置 SITE_PARSER_YTDLP_PATH。'); }
          try { await promisify(execFile)(process.env.FFMPEG_PATH?.trim() || 'ffmpeg', ['-version'], { timeout: 5_000, maxBuffer: 64 * 1024 }); }
          catch { throw new StartupConfigurationError('ENABLE_SITE_PARSER=1 需要 FFmpeg 合并站点音视频。'); }
          await mkdir(resolve(dataDir, 'site-parser-tmp'), { recursive: true, mode: 0o700 });
        }
        ffmpegPath = process.env.FFMPEG_PATH?.trim() || 'ffmpeg';
        ffprobePath = process.env.FFPROBE_PATH?.trim() || 'ffprobe';
        if (mediaEnabled) {
          try {
            await promisify(execFile)(ffmpegPath, ['-version'], { timeout: 5_000, maxBuffer: 64 * 1024 });
            await promisify(execFile)(ffprobePath, ['-version'], { timeout: 5_000, maxBuffer: 64 * 1024 });
          } catch { throw new StartupConfigurationError('ENABLE_MEDIA=1 需要 FFmpeg 和 ffprobe；请安装或设置 FFMPEG_PATH、FFPROBE_PATH。'); }
        }
        const ai = process.env.ENABLE_AI || '0';
        if (!['0', '1'].includes(ai)) throw new StartupConfigurationError('ENABLE_AI 必须为 0 或 1。');
        if (ai === '1') {
          const modulePath = process.env.SANDBOX_AI_BINDING_MODULE?.trim();
          if (!modulePath) throw new StartupConfigurationError('ENABLE_AI=1 需要 SANDBOX_AI_BINDING_MODULE 指向已配置的 Docker/DSH 部署绑定。');
          const configured = await loadSandboxProfiles(await loadSandboxBindingModule(modulePath), process.env.SANDBOX_AI_MODEL_PROFILES?.trim() || undefined);
          sandboxModule = configured.binding;
          modelProfiles = configured.profiles;
        }
      },
      async setup(ctx, pluginMaintenance) {
        sandbox = sandboxModule ? createStoreAuthorizedSandboxExecutor(sandboxModule, {
          store: () => app!.groupweave.store, refreshRole,
        }) : undefined;
        const sandboxExecutor: Executor | undefined = sandbox ? (request, signal) => {
          if (!request.authorized || !['digest', 'assistant', 'link-brief'].includes(request.featureId)) {
            throw new ApiError(403, 'CAPABILITY_DENIED', '当前 AI 任务未授权。');
          }
          return sandbox!.execute({ ...request, authorized: true, featureId: request.featureId as 'digest' | 'assistant' | 'link-brief',
            options: { ...request.options, language: request.options.language ?? 'zh' } }, signal);
        } : undefined;
        app = await buildApp({
          dataDir, preview: false, nativeKoishi: true,
          pluginMaintenance, modelProfiles, defaultModelProfileId: modelProfiles.length ? 'default' : undefined,
          aiExecutor: sandboxExecutor,
          assistantExecutor: sandboxExecutor,
          mixedExecutor: sandboxExecutor,
          ...(sandboxModule ? { sandboxAiTimeoutMs: sandboxTaskTimeoutMs(sandboxModule) } : {}),
          ...(existsSync(resolve('dist/client/index.html')) ? { staticDir: resolve('dist/client') } : {}),
          executor: async (request, signal) => {
            if (!request.authorized || request.featureId !== 'link-cleaner') throw new ApiError(403, 'CAPABILITY_DENIED', '当前任务未授权。');
            return { output: await cleanLinks(request.input, request.options, signal ?? new AbortController().signal), modelCalls: 0 };
          },
          welcomeExecutor: async (request, signal) => {
            signal?.throwIfAborted();
            if (!request.authorized || request.featureId !== 'welcome') throw new ApiError(403, 'CAPABILITY_DENIED', '当前欢迎事件未授权。');
            return { output: welcomeText(request), modelCalls: 0 };
          },
          refreshRole,
          botToken: enabled ? process.env.TELEGRAM_BOT_TOKEN : undefined,
          platformAdminIds: adminIds,
          publicOrigin: process.env.PUBLIC_ORIGIN || undefined,
          maxActiveTasks: Number(process.env.MAX_ACTIVE_TASKS || 2),
          telegramConnected: () => enabled && telegramBot()?.status === 1,
          beforeClose: async () => {
            try { await sandbox?.dispose(); } finally { await runtime?.stop(); }
          },
        });
        const binding = createTelegramBinding(app.groupweave.store, app.groupweave.actions);
        const privateBinding = createTelegramBinding(app.groupweave.store, app.groupweave.actions, { scope: 'private' });
        const authorizeNativeAdmin = async (session: Parameters<typeof telegramCommandSource>[0]) => {
          const source = telegramCommandSource(session);
          if (!source || session.channelId !== source.actor.groupId) return false;
          try {
            await app!.groupweave.actions.getGroup(telegramActorId(source.actor.userId), telegramGroupId(source.actor.groupId), true);
            return true;
          } catch { return false; }
        };
        const authorizeMedia = async (session: Parameters<typeof telegramCommandSource>[0]) => {
          const raw = (session.event as typeof session.event & {
            _data?: { message?: { chat?: { id?: number; type?: string }; from?: { id?: number; is_bot?: boolean }; sender_chat?: unknown } };
          })._data?.message;
          if (session.platform !== 'telegram' || !['interaction/command', 'message'].includes(session.type) || !raw || raw.sender_chat) return false;
          if (raw.chat?.type === 'private') {
            return Number.isSafeInteger(raw.from?.id) && raw.from!.id! > 0 && !raw.from?.is_bot && !session.event.user?.isBot
              && raw.chat.id === raw.from?.id && String(raw.from.id) === session.event.user?.id
              && session.channelId === String(raw.chat.id);
          }
          const source = telegramCommandSource(session, true);
          if (!source || session.channelId !== source.actor.groupId) return false;
          try { await app!.groupweave.actions.getGroup(telegramActorId(source.actor.userId), telegramGroupId(source.actor.groupId)); return true; }
          catch { return false; }
        };
        const authorizeNativeFeature = (feature: NativeFeature, authorize: typeof authorizeMedia) => async (session: Parameters<typeof telegramCommandSource>[0]) => {
          if (!await authorize(session)) return false;
          const raw = (session.event as typeof session.event & { _data?: { message?: { chat?: { type?: string } } } })._data?.message;
          if (raw?.chat?.type === 'private') return true;
          const source = telegramCommandSource(session, true);
          if (!source) return false;
          try {
            const group = await binding.getGroup(source.actor);
            return !!group && nativeFeatureAllowed(group.config, feature);
          } catch { return false; }
        };
        const authorizeSchedule = authorizeNativeFeature('schedule', authorizeNativeAdmin);
        installGroupCommands(ctx, binding, { aiConfigured: Boolean(sandbox), privateBinding,
          renderConfigured: renderEnabled, parserConfigured: parserEnabled,
          groupAdmin: {
            cancelRules: (actor, id) => binding.cancelRules!(actor, id),
            rollbackRules: (actor, id) => binding.rollbackRules!(actor, id),
          } });
        installAiCommands(ctx, binding, { configured: Boolean(sandbox), privateBinding });
        installSessionCommands(ctx, binding, { privateBinding });
        installNaturalRuleCommands(ctx, app.groupweave.store, app.groupweave.actions);
        installMediaCommands(ctx, { authorize: authorizeNativeFeature('media', authorizeMedia) });
        installImageCommands(ctx, { authorize: authorizeNativeFeature('image', authorizeMedia) });
        installMarkdownIntegration(ctx, { enabled: renderEnabled, executablePath: renderBrowserPath, authorize: authorizeNativeFeature('render', authorizeMedia) });
        if (parserEnabled) installSiteParserCommands(ctx, {
          apiUrl: parserApiUrl, apiKey: parserApiKey, authorize: authorizeNativeFeature('parser', authorizeMedia),
          ytDlpPath: parserYtDlpPath,
          bilibiliCookiesFile: process.env.BILIBILI_COOKIES_FILE?.trim() || undefined,
          douyinCookiesFile: process.env.DOUYIN_COOKIES_FILE?.trim() || undefined,
          tempDir: resolve(dataDir, 'site-parser-tmp'),
        });
        if (mediaEnabled) {
          // Reuse the upstream service with the deployment's existing binary;
          // no runtime downloader or additional execution engine is needed.
          ctx.plugin(FFmpeg, ffmpegPath);
          installVideoIntegration(ctx, { authorize: authorizeNativeFeature('media', authorizeMedia) });
          installTranscodeCommands(ctx, { authorize: authorizeNativeFeature('media', authorizeMedia), ffmpegPath, ffprobePath });
        }
        installWelcomeIntegration(ctx, binding);
        installRssIntegration(ctx, {
          authorize: authorizeNativeAdmin,
          enabled: authorizeNativeFeature('rss', authorizeNativeAdmin),
          allowBroadcast: async (platform, channelId) => platform === 'telegram' && /^-[1-9]\d*$/.test(channelId)
            && app!.groupweave.store.nativeGroupEnabled(telegramGroupId(channelId), 'rss'),
        });
        installScheduleIntegration(ctx, {
          authorize: authorizeSchedule,
          authorizeLinks: async session => {
            const source = telegramCommandSource(session);
            if (!source || !await authorizeSchedule(session)) return false;
            try { return (await binding.getGroup(source.actor))?.config.features.includes('link-cleaner') === true; }
            catch { return false; }
          },
          invokeLinks: async (session, input, idempotencyKey) => {
            const source = telegramCommandSource(session);
            if (!source || !await authorizeSchedule(session)) return;
            const actor = { ...source.actor, role: 'admin' as const };
            const task = await binding.executeLinks({ actor, input, audience: 'group', updateId: source.updateId,
              messageId: source.messageId, idempotencyKey });
            if (!await binding.claimDelivery(actor, task.id)) return;
            if (!await authorizeSchedule(session)
              || (binding.deliveryStillAuthorized && !binding.deliveryStillAuthorized(actor, task.id))) {
              await binding.recordDelivery(actor, task.id, 'withheld'); return;
            }
            try {
              const receipts = await session.send(h.text(task.status === 'succeeded' ? task.output : '链接整理未成功完成，未投递结果。'));
              await binding.recordDelivery(actor, task.id, receipts?.length ? 'sent' : 'unknown');
            } catch { await binding.recordDelivery(actor, task.id, 'unknown'); }
          },
        });
      },
    });
    await runtime.start();
    if (!runtime.app.$commander.get('help') || !runtime.app.$commander.get('echo') || !runtime.app.database) {
      throw new StartupConfigurationError('原生配置必须加载 Help、Echo 和数据库插件。');
    }
    if (mediaEnabled && !runtime.app.$commander.get('v2g')) throw new StartupConfigurationError('视频插件未成功加载。');
    if (renderEnabled && (!runtime.app.puppeteer?.browser?.connected || !runtime.app.markdownToImage)) {
      throw new StartupConfigurationError('Markdown 浏览器或渲染服务未就绪；请检查 RENDER_BROWSER_PATH 和部署沙箱支持。');
    }
    const bots = runtime.app.bots.filter(bot => bot.platform === 'telegram');
    if (bots.length !== (enabled ? 1 : 0)) throw new StartupConfigurationError('原生入口需要与 ENABLE_TELEGRAM 一致的唯一 Telegram adapter。');
    await app!.listen({ host, port });
    console.log(`GroupWeave Koishi 原生宿主：${host}:${port} · Telegram ${enabled ? '已配置，在线状态见 /api/health' : '关闭'} · AI ${sandbox ? 'Docker 摘要/问答入口已配置，外部连接待实际请求验证' : '未配置'}`);
    return { app: app!, runtime, stop: () => app!.close() };
  } catch (error) {
    await app?.close().catch(() => undefined);
    await sandbox?.dispose().catch(() => undefined);
    await runtime?.stop().catch(() => undefined);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const host = await startKoishiHost();
    const shutdown = () => { void host.stop().then(() => { process.exitCode = 0; }).catch(() => { process.exitCode = 1; }); };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    // Native provider/transport exceptions can contain credentials. Only entry
    // validation messages and fixed application errors are suitable for CLI use.
    console.error(error instanceof StartupConfigurationError ? error.message : error instanceof ApiError ? error.code : 'KOISHI_START_FAILED：请检查原生配置、数据目录和必需环境变量。');
    process.exitCode = 1;
  }
}
