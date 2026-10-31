import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { buildApp } from './app';
import type { ExecutorRequest } from './actions.js';
import { createNativeExecutor } from './native';
import { createAiExecutor } from './ai';
import { createTelegramAdapter } from './telegram';
import { StoreError } from './store';
import { createTelegramBinding } from './telegram-binding';
import { createKoishiCodeHost } from './koishi';
import { runLinkCodeTool } from './mixed';
import { createAntiadExecutor, AntiadError, type AntiadExecutor } from './antiad';
import { createStoreAuthorizedSandboxExecutor, loadSandboxBindingModule, sandboxTaskTimeoutMs } from './sandbox-wiring.js';
import type { TrustedSandboxAiRequest } from './sandbox-ai.js';
import { keywordReview } from './keyword-review.js';

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 4318);
const preview = process.env.APP_MODE !== 'telegram';
if (process.env.APP_MODE && !['preview', 'telegram'].includes(process.env.APP_MODE)) throw new Error('APP_MODE 必须为 preview 或 telegram。');
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是有效端口。');
if (preview && !['127.0.0.1', 'localhost', '::1'].includes(host) && process.env.ALLOW_LOCAL_PREVIEW !== '1') throw new Error('演示身份只能本机使用；容器需显式允许并仅发布到 loopback。');
const token = !preview ? process.env.TELEGRAM_BOT_TOKEN : undefined;
const adminIds = (process.env.TELEGRAM_ADMIN_IDS ?? '').split(',').map(value => value.trim()).filter(value => /^[1-9]\d*$/.test(value));
if (!preview && (!token || !adminIds.length)) throw new Error('telegram 模式需要显式配置 Bot Token 和独立平台管理员 ID。');
if (!preview && !['127.0.0.1', 'localhost', '::1'].includes(host) && !process.env.PUBLIC_ORIGIN) throw new Error('非本机真实面板需要 HTTPS PUBLIC_ORIGIN；不自动公开服务。');
const staticDir = resolve('dist/client');
if (!existsSync(staticDir)) throw new Error('缺少前端构建，请先 npm run build。');
const dataDir = resolve(process.env.DATA_DIR || 'data');
if (process.env.ENABLE_AI && !['0', '1'].includes(process.env.ENABLE_AI)) throw new Error('ENABLE_AI 必须为 0 或 1。');
const sandboxModulePath = process.env.SANDBOX_AI_BINDING_MODULE;
const sandboxModule = sandboxModulePath === undefined ? undefined : await loadSandboxBindingModule(sandboxModulePath);
const aiConfigured = process.env.ENABLE_AI === '1' && Boolean(process.env.DEEPSEEK_API_KEY?.trim());
const ai = aiConfigured ? createAiExecutor({ enabled: true, apiKey: process.env.DEEPSEEK_API_KEY, dataDir }) : undefined;
const code = createKoishiCodeHost();
const executor = createNativeExecutor(code);
if (process.env.ENABLE_ANTIAD && !['0', '1'].includes(process.env.ENABLE_ANTIAD)) throw new Error('ENABLE_ANTIAD 必须为 0 或 1。');
let antiad: AntiadExecutor | undefined;
if (process.env.ENABLE_ANTIAD === '1') {
  try { antiad = await createAntiadExecutor({ pythonPath: process.env.ANTIAD_PYTHON_PATH || '/opt/antiad-venv/bin/python', modelPath: process.env.ANTIAD_MODEL_PATH || '' }); }
  catch (error) { console.warn(`ANTIAD_BLOCKED:${error instanceof AntiadError ? error.code : 'CONFIG_INVALID'}`); }
}
let telegram: ReturnType<typeof createTelegramAdapter> | undefined;
let app: Awaited<ReturnType<typeof buildApp>>;
const refreshRole = async (actorId: string, groupId: string) => {
  if (!groupId.startsWith('tg:') || !actorId.startsWith('tg-user:')) return;
  const chatId = groupId.slice(3); const userId = actorId.slice(8);
  const role = await telegram?.verifyMember(chatId, userId);
  try { app.groupweave.store.syncTelegramMember(chatId, userId, role); }
  catch (error) { if (!(error instanceof StoreError) || error.code !== 'GROUP_UNREGISTERED') throw error; }
};
const sandbox = sandboxModule ? createStoreAuthorizedSandboxExecutor(sandboxModule, {
  store: () => app.groupweave.store,
  refreshRole,
}) : undefined;
const mixed = aiConfigured ? createAiExecutor({ enabled: true, apiKey: process.env.DEEPSEEK_API_KEY, dataDir, workflow: 'link-brief' }, {
  codeTool: {
    async execute(request, signal) {
      return runLinkCodeTool(app.groupweave.store, app.groupweave.actions, code, request, signal);
    },
  },
}) : undefined;
const assistant = aiConfigured ? createAiExecutor({ enabled: true, apiKey: process.env.DEEPSEEK_API_KEY, dataDir, workflow: 'assistant' }, {
  codeTool: { execute: (request, signal) => runLinkCodeTool(app.groupweave.store, app.groupweave.actions, code, request, signal, 'assistant') },
}) : undefined;
app = await buildApp({
  dataDir, executor, preview, staticDir,
  ...(sandboxModule ? { sandboxAiTimeoutMs: sandboxTaskTimeoutMs(sandboxModule) } : {}),
  echoExecutor: (request, signal) => code.executeEcho(request, signal),
  welcomeExecutor: (request, signal) => code.executeWelcome(request, signal),
  antiadBackend: antiad ? 'classifier' : 'keywords',
  antiadExecutor: antiad ? (request, signal) => antiad!({
    actorId: request.actorId, groupId: request.groupId, input: request.input, audience: request.audience, authorized: request.authorized,
    rules: { promptThreshold: request.options.antiadPromptThreshold ?? 0.55, actionThreshold: request.options.antiadActionThreshold ?? 0.9,
      stopwords: request.options.antiadStopwords ?? [] },
  }, signal) : process.env.ENABLE_ANTIAD === '1' ? undefined : keywordReview,
  aiExecutor: sandbox ? (request: ExecutorRequest, signal) => {
    if (request.authorized !== true || request.featureId !== 'digest') return Promise.reject(new Error('SANDBOX_TASK_SCOPE_INVALID'));
    return sandbox.execute({
      taskId: request.taskId, tenantId: request.tenantId, featureId: 'digest', actorId: request.actorId,
      groupId: request.groupId, input: request.input, options: { language: request.options.language ?? 'zh' },
      audience: request.audience, authorized: true, authorization: request.authorization,
    } satisfies TrustedSandboxAiRequest, signal);
  }
    : ai ? (request, signal) => ai.execute({ actorId: request.actorId, groupId: request.groupId, input: request.input, options: { language: request.options.language ?? 'zh' } }, signal) : undefined,
  mixedExecutor: mixed ? (request, signal) => mixed.execute({
    actorId: request.actorId, groupId: request.groupId, input: request.input,
    options: { language: request.options.language ?? 'zh' },
    codeOptions: { deduplicate: request.options.deduplicate, sort: request.options.sort, maxItems: request.options.maxItems },
  }, signal) : undefined,
  assistantExecutor: assistant ? (request, signal) => {
    return assistant.execute({ actorId: request.actorId, groupId: request.groupId, input: request.input,
      options: { language: request.options.language ?? 'zh' },
      allowLinkTool: request.options.allowLinkTool === true,
      codeOptions: { deduplicate: request.options.deduplicate, sort: request.options.sort, maxItems: request.options.maxItems },
    }, signal);
  } : undefined,
  botToken: token, platformAdminIds: adminIds, publicOrigin: !preview ? process.env.PUBLIC_ORIGIN : undefined,
  maxActiveTasks: Number(process.env.MAX_ACTIVE_TASKS || 2),
  telegramConnected: () => telegram?.connected ?? false,
  beforeClose: async () => {
    // Close update admission immediately, then dispose execution backends so
    // active task signals settle before the runner waits for its handlers.
    const telegramDrain = telegram?.stop();
    try {
      await executor.dispose(); await sandbox?.dispose(); await ai?.dispose(); await mixed?.dispose();
      await assistant?.dispose(); await antiad?.dispose(); await code.dispose();
    } finally { await telegramDrain; }
  },
  refreshRole,
});
app.groupweave.store.setPluginAvailability('digest', Boolean(sandbox || aiConfigured));
telegram = createTelegramAdapter({ token, adminIds, binding: !preview ? createTelegramBinding(app.groupweave.store, app.groupweave.actions) : undefined,
  installCommands: true,
  onError: code => console.warn(code),
});
if (!preview && !await telegram.init()) { await app.close(); await executor.dispose(); throw new Error('Telegram API 身份核验失败，真实模式未启动。'); }
await app.listen({ host, port });
if (!preview) void telegram.launch();
console.log(`GroupWeave ${preview ? '本地合成预览' : 'Telegram 模式'}：${host}:${port} · AI ${sandbox ? 'OpenShell 摘要路由显式启用；供应商预算与凭据未验收' : aiConfigured ? '宿主路由已配置，供应商响应未验收' : '默认关闭'}`);
async function shutdown() { await app.close(); process.exit(0); }
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
