import type { PluginMaintenance } from './plugin-maintenance.js';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { parse, validate } from '@tma.js/init-data-node';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { resolve, join } from 'node:path';
import type { Group, Me } from '../shared.js';
import { PERSONAS, Store } from './store.js';
import { ApiError, deny, objectBody, requiredString, presentTask, createGroupActions, type Executor } from './actions.js';
import { createRuleProposals } from './rule-proposals.js';
export type { Executor, ExecutorRequest } from './actions.js';

export interface AppOptions {
  pluginMaintenance?: PluginMaintenance;
  modelProfiles?: { id: string; label: string }[];
  defaultModelProfileId?: string;
  /** Native application host; distinct from availability of the legacy Echo task. */
  nativeKoishi?: boolean;
  dataDir?: string;
  executor?: Executor;
  aiExecutor?: Executor;
  echoExecutor?: Executor;
  mixedExecutor?: Executor;
  welcomeExecutor?: Executor;
  antiadExecutor?: Executor;
  assistantExecutor?: Executor;
  sandboxAiTimeoutMs?: number;
  preview?: boolean;
  staticDir?: string;
  telegramConnected?: boolean | (() => boolean);
  botToken?: string;
  platformAdminIds?: readonly string[];
  publicOrigin?: string;
  rateLimitMax?: number;
  beforeClose?: () => Promise<void>;
  /** Trusted deployment setting; never accepted from a task or group configuration. */
  maxActiveTasks?: number;
  refreshRole?: (actorId: string, groupId: string) => Promise<void>;
}

const COOKIE_NAME = 'groupweave_session';
const SESSION_MS = 8 * 60 * 60 * 1000;
type Session = { personaId: string; csrfToken: string; expiresAt: number; abort: AbortController };

function cookieToken(request: FastifyRequest): string | undefined {
  // Reject ambiguous duplicate session names; parsing/decoding belongs to Fastify.
  const duplicates = (request.headers.cookie ?? '').split(';').filter(value => value.trim().startsWith(`${COOKIE_NAME}=`));
  return duplicates.length === 1 ? request.cookies[COOKIE_NAME] : undefined;
}

function constantEqual(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string') return false;
  const a = Buffer.from(actual); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function validateHost(request: FastifyRequest): string {
  // Never use forwarded headers or browser-supplied roles as an authentication source.
  const host = request.headers.host;
  if (!host || !/^(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(host)) return deny(403, 'LOCAL_PREVIEW_ONLY', '此版本仅允许 localhost 本地预览。');
  const port = host.includes(':') ? Number(host.split(':')[1]) : undefined;
  if (port !== undefined && (port < 1 || port > 65535)) return deny(403, 'LOCAL_PREVIEW_ONLY', '无效的本地端口。');
  return host;
}

declare module 'fastify' {
  interface FastifyInstance { groupweave: { store: Store; actions: ReturnType<typeof createGroupActions> } }
}

export async function buildApp(options: AppOptions = {}) {
  const app = Fastify({ logger: false, bodyLimit: 32_768, trustProxy: false });
  const preview = options.preview ?? false;
  const sessions = new Map<string, Session>();
  const connected = () => typeof options.telegramConnected === 'function' ? options.telegramConnected() : options.telegramConnected ?? false;
  const publicOrigin = options.publicOrigin ? new URL(options.publicOrigin) : undefined;
  if (publicOrigin && (preview || publicOrigin.protocol !== 'https:' || publicOrigin.origin !== options.publicOrigin)) {
    throw new Error('公网入口需要关闭演示并提供不含路径的 HTTPS PUBLIC_ORIGIN。');
  }
  if (options.maxActiveTasks !== undefined && (!Number.isSafeInteger(options.maxActiveTasks) || options.maxActiveTasks < 1 || options.maxActiveTasks > 8)) throw new Error('maxActiveTasks 必须为 1 至 8。');
  const store = new Store(options.dataDir);
  store.setPluginAvailability('digest', Boolean(options.aiExecutor));
  store.setPluginAvailability('echo', Boolean(options.echoExecutor));
  store.setPluginAvailability('link-brief', Boolean(options.mixedExecutor));
  store.setPluginAvailability('welcome', Boolean(options.welcomeExecutor));
  store.setPluginAvailability('antiad', Boolean(options.antiadExecutor));
  store.setPluginAvailability('assistant', Boolean(options.assistantExecutor));
  const secureCookie = Boolean(publicOrigin);
  await app.register(fastifyCookie);
  await app.register(rateLimit, { max: options.rateLimitMax ?? 120, timeWindow: 60_000, cache: 1024,
    skipOnError: false, keyGenerator: request => request.ip,
    errorResponseBuilder: () => ({ statusCode: 429, code: 'RATE_LIMITED', message: '请求过于频繁，请稍后明确提交。' }),
  });
  const platformIds = new Set((options.platformAdminIds ?? []).filter(id => /^[1-9]\d*$/.test(id)).map(id => `tg-user:${id}`));
  const platformAllowed = (id: string) => preview ? Boolean(store.persona(id)?.platformAdmin) : platformIds.has(id);

  const actions = createGroupActions(store, options);
  const interpretRules = createRuleProposals(store, actions);
  app.decorate('groupweave', { store, actions });
  const invalidate = (token: string) => { sessions.get(token)?.abort.abort(new Error('会话已失效。')); sessions.delete(token); };
  const readSession = (request: FastifyRequest): Session | undefined => {
    const token = cookieToken(request);
    if (!token) return undefined;
    const session = sessions.get(token);
    if (!session || session.expiresAt <= Date.now()) { invalidate(token); return undefined; }
    return session;
  };
  const auth = (request: FastifyRequest): Session => readSession(request) ?? deny(401, 'AUTH_REQUIRED', '缺少有效身份。本地预览请先打开 /api/me；真实模式请从已配置的 Telegram Mini App 登录。');
  const groupFor = (request: FastifyRequest, id: string, manager = false): Promise<Group> => actions.getGroup(auth(request).personaId, id, manager);
  const me = (session: Session): Me & { csrfToken: string } => ({
    persona: { ...store.persona(session.personaId)!, platformAdmin: platformAllowed(session.personaId) }, personas: preview ? [...PERSONAS] : [], preview,
    telegramConnected: connected(), harness: options.nativeKoishi ? 'Koishi 原生插件宿主' : options.echoExecutor ? 'Koishi 代码插件 · DSH Agent/Skill' : options.executor ? 'DSH 原生命令与工具（无模型固定路径）' : '固定代码执行入口未接入', csrfToken: session.csrfToken,
  });
  const createSession = (reply: FastifyReply, personaId: string): Session => {
    for (const [key, session] of sessions) if (session.expiresAt <= Date.now()) invalidate(key);
    if (sessions.size >= 128) invalidate(sessions.keys().next().value!);
    const token = randomBytes(32).toString('base64url');
    const session = { personaId, csrfToken: randomBytes(32).toString('base64url'), expiresAt: Date.now() + SESSION_MS, abort: new AbortController() };
    sessions.set(token, session);
    reply.setCookie(COOKIE_NAME, token, { httpOnly: true, sameSite: 'strict', secure: secureCookie, path: '/', maxAge: SESSION_MS / 1000 });
    return session;
  };
  app.addHook('onRequest', async (request, reply) => {
    const host = publicOrigin ? request.headers.host : validateHost(request);
    if (publicOrigin && host !== publicOrigin.host) return deny(403, 'HOST_REJECTED', '请求目标不符合部署入口。');
    const expectedOrigin = publicOrigin?.origin ?? `http://${host}`;
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== expectedOrigin) return deny(403, 'ORIGIN_REJECTED', '请求来源必须与本地服务一致。');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    reply.header('content-security-policy', "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self' https://web.telegram.org https://*.telegram.org; base-uri 'none'; form-action 'self'");
    if (request.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      if (origin !== expectedOrigin) return deny(403, 'ORIGIN_REQUIRED', '修改请求必须带有同源 Origin。');
      if (request.url.split('?')[0] === '/api/auth/telegram') return;
      const session = auth(request);
      if (!constantEqual(request.headers['x-csrf-token'], session.csrfToken)) return deny(403, 'CSRF_REJECTED', '会话校验失败，请刷新后重试。');
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'IDEMPOTENCY_CAPACITY') return reply.code(429).send({ code: 'IDEMPOTENCY_CAPACITY', message: '重复保护记录已达到部署上限，未执行；需要平台维护容量。' });
    if (error && typeof error === 'object' && 'code' in error && error.code === 'RATE_LIMITED') return reply.code(429).send({ code: 'RATE_LIMITED', message: '请求过于频繁，请稍后明确提交。' });
    if (error && typeof error === 'object' && 'code' in error && ['BACKUP_CAPACITY', 'BACKUP_RUNNING'].includes(String(error.code))) return reply.code(409).send({ code: error.code, message: '备份容量已满或已有备份进行中，需要平台维护后再提交。' });
    if (error && typeof error === 'object' && 'errcode' in error && error.errcode === 13) return reply.code(507).send({ code: 'STORAGE_CAPACITY', message: '数据容量已满，未继续写入；需要平台维护。' });
    if (error instanceof ApiError) return reply.code(error.statusCode).send({ code: error.code, message: error.message });
    const candidateStatus = error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
    const status = typeof candidateStatus === 'number' && candidateStatus >= 400 && candidateStatus < 500 ? candidateStatus : 500;
    return reply.code(status).send({ code: status === 413 ? 'INPUT_TOO_LARGE' : status < 500 ? 'INVALID_REQUEST' : 'INTERNAL_ERROR', message: status < 500 ? '请求格式或大小不符合限制。' : '服务无法完成此请求；没有自动切换 Agent 或重试业务。' });
  });

  app.get('/api/health', async () => ({ ok: true, preview, telegramConnected: connected(), executorConnected: Boolean(options.executor), koishiConfigured: Boolean(options.nativeKoishi || options.echoExecutor), mixedConfigured: Boolean(options.mixedExecutor), welcomeConfigured: Boolean(options.welcomeExecutor), antiadConfigured: Boolean(options.antiadExecutor), agentConnected: false, agentConfigured: Boolean(options.aiExecutor), loginAvailable: !preview && Boolean(options.botToken) }));
  app.get('/api/me', async (request, reply) => {
    let session = readSession(request);
    if (!session) {
      if (!preview) return deny(401, 'AUTH_REQUIRED', '需要有效 Telegram 登录会话，演示登录已关闭。');
      session = createSession(reply, 'admin-a');
    }
    return me(session);
  });
  app.post('/api/auth/telegram', async (request, reply) => {
    if (preview || !options.botToken) return deny(404, 'LOGIN_UNAVAILABLE', '真实登录未配置；演示身份不能进入此入口。');
    const body = objectBody(request.body, ['initData']);
    const raw = requiredString(body.initData, 'Telegram initData', 16_000);
    let identity: ReturnType<typeof parse>;
    try {
      const fields = new URLSearchParams(raw);
      if ([...fields.keys()].some(key => fields.getAll(key).length !== 1)) throw new Error('Duplicate fields');
      validate(raw, options.botToken, { expiresIn: 300 });
      identity = parse(raw);
      if (!identity.user || !Number.isSafeInteger(identity.user.id) || identity.user.id <= 0 || identity.auth_date.getTime() > Date.now() + 30_000) throw new Error('Invalid identity');
    } catch { return deny(401, 'TELEGRAM_AUTH_REJECTED', 'Telegram 签名、时间或用户身份校验失败。'); }
    const user = identity.user!;
    const actorId = store.upsertTelegramActor(user.id, [user.first_name, user.last_name].filter(Boolean).join(' '));
    const old = cookieToken(request); if (old) invalidate(old);
    store.audit({ actorId, action: 'auth.login', outcome: 'verified' });
    return me(createSession(reply, actorId));
  });
  app.post('/api/logout', async (request, reply) => {
    objectBody(request.body ?? {}, []);
    const token = cookieToken(request); if (token) invalidate(token);
    reply.clearCookie(COOKIE_NAME, { path: '/', httpOnly: true, sameSite: 'strict', secure: secureCookie });
    return { loggedOut: true };
  });
  app.post('/api/demo/session', async (request, reply) => {
    if (!preview) return deny(404, 'NOT_FOUND', '演示身份切换已关闭。');
    const body = objectBody(request.body, ['personaId']);
    const id = requiredString(body.personaId, '演示身份', 40);
    if (!PERSONAS.some(persona => persona.id === id)) return deny(400, 'INVALID_PERSONA', '只能选择服务端已有的演示身份。');
    const token = cookieToken(request);
    if (token) invalidate(token);
    return me(createSession(reply, id));
  });
  app.get('/api/groups', async request => {
    const actorId = auth(request).personaId;
    const groups: Group[] = [];
    for (const candidate of store.groups(actorId)) {
      try { groups.push(await actions.getGroup(actorId, candidate.id)); } catch { /* stale observation never grants access */ }
    }
    return { groups };
  });
  app.get<{ Params: { id: string } }>('/api/groups/:id', async request => ({ group: await groupFor(request, request.params.id), plugins: store.plugins() }));

  app.get<{ Params: { id: string } }>('/api/groups/:id/proposals', async request => {
    const group = await groupFor(request, request.params.id, true);
    return { proposals: store.ownProposals(group.id, auth(request).personaId) };
  });
  app.post<{ Params: { id: string } }>('/api/groups/:id/proposals', async request => actions.previewRules(auth(request).personaId, request.params.id, request.body));
  app.post<{ Params: { id: string } }>('/api/groups/:id/proposals/interpret', async request => {
    const session = auth(request);
    return interpretRules(session.personaId, request.params.id, request.body, session.abort.signal);
  });
  app.get<{ Params: { id: string } }>('/api/proposals/:id', async request => {
    const proposal = store.proposal(request.params.id) ?? deny(404, 'NOT_FOUND', '找不到可访问的提案。');
    await groupFor(request, proposal.groupId, true);
    return proposal;
  });
  app.post<{ Params: { id: string } }>('/api/proposals/:id/activate', async request => actions.activateRules(auth(request).personaId, request.params.id, request.body));
  app.post<{ Params: { id: string } }>('/api/proposals/:id/cancel', async request => {
    objectBody(request.body ?? {}, []);
    return actions.cancelRules(auth(request).personaId, request.params.id);
  });
  app.post<{ Params: { id: string } }>('/api/proposals/:id/rollback', async request => {
    objectBody(request.body ?? {}, []);
    return actions.rollbackRules(auth(request).personaId, request.params.id);
  });

  app.get<{ Params: { id: string } }>('/api/groups/:id/models', async request => actions.listModels(auth(request).personaId, request.params.id));
  app.post<{ Params: { id: string } }>('/api/groups/:id/model', async request => {
    const body = objectBody(request.body, ['id']);
    return actions.selectModel(auth(request).personaId, request.params.id, requiredString(body.id, '模型 ID', 40));
  });
  app.post<{ Params: { id: string } }>('/api/groups/:id/conversation/reset', async request => {
    objectBody(request.body ?? {}, []);
    await actions.resetConversation(auth(request).personaId, request.params.id);
    return { reset: true };
  });
  app.get<{ Params: { id: string } }>('/api/groups/:id/own-tasks', async request => ({ tasks: await actions.ownTasks(auth(request).personaId, request.params.id) }));

  app.get('/api/platform/native-plugins', async request => {
    const session = auth(request);
    if (!platformAllowed(session.personaId)) return deny(403, 'PLATFORM_REQUIRED', '需要平台维护权限。');
    if (!options.pluginMaintenance) return deny(503, 'MAINTENANCE_UNAVAILABLE', '当前宿主未开启原生插件维护。');
    return options.pluginMaintenance.status();
  });
  app.post('/api/platform/native-plugins', async request => {
    const session = auth(request);
    if (!platformAllowed(session.personaId)) return deny(403, 'PLATFORM_REQUIRED', '需要平台维护权限。');
    if (!options.pluginMaintenance) return deny(503, 'MAINTENANCE_UNAVAILABLE', '当前宿主未开启原生插件维护。');
    const body = objectBody(request.body, ['operation', 'name', 'version', 'key', 'config', 'enabled']);
    const result = body.operation === 'install'
      ? await options.pluginMaintenance.install(requiredString(body.name, 'name', 200), requiredString(body.version, 'version', 80))
      : body.operation === 'configure' && typeof body.enabled === 'boolean'
        ? await options.pluginMaintenance.configure(requiredString(body.key, 'key', 200), objectBody(body.config, Object.keys(body.config && typeof body.config === 'object' ? body.config : {})), body.enabled)
        : deny(400, 'INVALID_REQUEST', '请选择安装或配置操作。');
    store.audit({ actorId: session.personaId, action: 'plugin.maintenance', targetId: String(body.name ?? body.key), outcome: 'completed' });
    return result;
  });
  app.get('/api/platform/plugins', async request => {
    const session = auth(request);
    if (!platformAllowed(session.personaId)) return deny(403, 'PLATFORM_REQUIRED', '只有平台管理员可以管理全局功能。');
    return { plugins: store.plugins() };
  });
  app.post<{ Params: { id: string } }>('/api/platform/plugins/:id', async request => {
    const session = auth(request);
    if (!platformAllowed(session.personaId)) return deny(403, 'PLATFORM_REQUIRED', '只有平台管理员可以启停全局功能。');
    const body = objectBody(request.body, ['enabled']);
    if (typeof body.enabled !== 'boolean') return deny(400, 'INVALID_INPUT', 'enabled 必须为布尔值。');
    const existing = store.plugin(request.params.id) ?? deny(404, 'NOT_FOUND', '找不到此功能。');
    if (body.enabled && !existing.available) return deny(409, 'CAPABILITY_UNAVAILABLE', '此能力尚未通过部署配置；先接入实际执行能力再开放。');
    const plugin = store.setPluginEnabled(request.params.id, body.enabled)!;
    if (!body.enabled) actions.stopFeature(plugin.id);
    store.audit({ actorId: session.personaId, action: 'plugin.toggle', targetId: plugin.id, outcome: body.enabled ? 'enabled' : 'disabled' });
    return plugin;
  });

  app.post<{ Params: { id: string } }>('/api/groups/:id/tasks', async request => {
    const session = auth(request);
    return actions.runTask(session.personaId, request.params.id, request.body, () => readSession(request) === session, session.abort.signal);
  });
  app.post<{ Params: { id: string } }>('/api/tasks/:id/cancel', async request => { objectBody(request.body ?? {}, []); return actions.cancelTask(auth(request).personaId, request.params.id); });
  app.get<{ Params: { id: string } }>('/api/tasks/:id/artifact', async (request, reply) => {
    const actorId = auth(request).personaId;
    const record = store.task(request.params.id) ?? deny(404, 'NOT_FOUND', '找不到本人文件。');
    await groupFor(request, record.groupId);
    if (record.creatorId !== actorId) return deny(404, 'NOT_FOUND', '找不到本人文件。');
    const artifact = actions.takeTaskArtifact(actorId, request.params.id) ?? deny(410, 'ARTIFACT_UNAVAILABLE', '临时文件已领取、过期或权限已变化；原文字结果仍可查询。');
    return reply.type(artifact.mediaType).header('content-disposition', 'attachment; filename="result.md"').send(Buffer.from(artifact.data));
  });
  app.get<{ Params: { id: string } }>('/api/tasks/:id', async request => {
    const session = auth(request);
    const record = store.task(request.params.id) ?? deny(404, 'NOT_FOUND', '找不到可访问的任务。');
    await groupFor(request, record.groupId);
    if (record.audience === 'private' && record.creatorId !== session.personaId) return deny(404, 'NOT_FOUND', '找不到可访问的任务。');
    if (record.expired) return deny(410, 'TASK_EXPIRED', '任务内容已清理，不能自动重放。');
    if (record.pending) return deny(409, 'TASK_PENDING', '任务已提交，结果尚未确定。');
    return presentTask(record.task!, session.personaId);
  });
  app.get<{ Params: { id: string } }>('/api/groups/:id/active-tasks', async request => ({ tasks: await actions.ownActiveTasks(auth(request).personaId, request.params.id) }));
  app.get<{ Params: { id: string } }>('/api/groups/:id/tasks', async request => {
    const group = await groupFor(request, request.params.id);
    const actorId = auth(request).personaId;
    return { tasks: store.tasks(group.id, actorId).map(task => presentTask(task, actorId)) };
  });


  app.get<{ Params: { id: string } }>('/api/groups/:id/audit', async request => {
    const group = await groupFor(request, request.params.id, true);
    return { records: store.auditRecords({ actorId: auth(request).personaId, groupId: group.id }) };
  });
  app.get('/api/platform/audit', async request => {
    const actorId = auth(request).personaId;
    if (!platformAllowed(actorId)) return deny(403, 'PLATFORM_REQUIRED', '需要平台维护权限。');
    return { records: store.auditRecords({ actorId, platformAdmin: true }) };
  });
  app.post('/api/platform/maintenance/prune', async request => {
    objectBody(request.body ?? {}, []);
    const actorId = auth(request).personaId;
    if (!platformAllowed(actorId)) return deny(403, 'PLATFORM_REQUIRED', '需要平台维护权限。');
    const result = store.prune();
    store.audit({ actorId, action: 'maintenance.prune', outcome: 'completed' });
    return result;
  });
  app.post('/api/platform/maintenance/backup', async request => {
    objectBody(request.body ?? {}, []);
    const actorId = auth(request).personaId;
    if (!platformAllowed(actorId)) return deny(403, 'PLATFORM_REQUIRED', '需要平台维护权限。');
    if (!options.dataDir) return deny(422, 'BACKUP_UNAVAILABLE', '内存预览没有持久数据库可备份。');
    const name = `groupweave-${randomUUID()}.sqlite`;
    const result = await store.backupTo(join(options.dataDir, 'backups', name));
    store.audit({ actorId, action: 'maintenance.backup', targetId: name, outcome: 'completed' });
    // No raw DB or tenant content is returned through a global administration API.
    return { name, schemaVersion: result.schemaVersion, integrity: result.integrity, sha256: result.sha256 };
  });

  if (options.staticDir) {
    await app.register(fastifyStatic, { root: resolve(options.staticDir), prefix: '/' });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ code: 'NOT_FOUND', message: '找不到此页面或接口。' });
    });
  }
  // Stop task admission and drain executors before Fastify waits for live
  // HTTP connections to finish. Keeping this in onClose can deadlock shutdown
  // behind an in-flight task whose abort signal is only sent by actions.close.
  app.addHook('preClose', async () => {
    actions.close();
    await options.beforeClose?.();
  });
  app.addHook('onClose', async () => {
    for (const token of sessions.keys()) invalidate(token);
    sessions.clear(); await store.waitForMaintenance(); store.close();
  });
  return app;
}
