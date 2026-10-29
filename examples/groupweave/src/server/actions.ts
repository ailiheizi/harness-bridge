import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import type { Group, GroupConfig, Proposal, Task } from '../shared.js';
import { Store } from './store.js';

export interface ExecutorRequest {
  /** Server-created identity for the persisted task; never copied from request JSON. */
  taskId: string;
  actorId: string;
  groupId: string;
  /** The current GroupWeave tenant is the group namespace. */
  tenantId: string;
  featureId: string;
  /** Permission counters captured on the reserved task before execution. */
  authorization: { platformVersion: number; groupVersion: number; codePlatformVersion?: number; codeGroupVersion?: number };
  input: string;
  options: Pick<GroupConfig, 'deduplicate' | 'sort' | 'maxItems' | 'antiadPromptThreshold' | 'antiadActionThreshold' | 'antiadStopwords'> & { language?: GroupConfig['language']; welcomeText?: string; groupTitle?: string; allowLinkTool?: boolean };
  audience: Task['audience'];
  authorized: boolean;
}
export type Executor = (request: ExecutorRequest, signal?: AbortSignal) => Promise<{ output: string; modelCalls: number; usage?: Task['usage']; toolCalls?: number }>;
export class ApiError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); }
}
export const deny = (status: number, code: string, message: string): never => { throw new ApiError(status, code, message); };
// Sharing a result with the group never shares the submitter's original text.
export function presentTask(task: Task, actorId: string): Task {
  return task.creatorId === actorId ? task : { ...task, input: '', inputHidden: true };
}
const MAX_TASK_BYTES = 16_000;
const MAX_TASK_LINES = 200;
const TASK_TIMEOUT_MS = 10_000;

class ExecutionTimeout extends Error {}
const SAFE_INPUT_ERRORS: Record<string, string> = {
  NO_LINKS: '没有找到有效的 HTTP(S) 链接，请输入至少一个完整链接。',
  INPUT_LIMIT: '输入超出固定代码入口限制，请缩短输入。',
  MAX_ITEMS: '条数设置超出固定代码入口限制，请检查本群配置。',
};

async function boundedExecution(executor: Executor, request: ExecutorRequest, settled: () => void, controllers: Set<AbortController>, controller = new AbortController(), callerSignal?: AbortSignal, timeoutMs = TASK_TIMEOUT_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  controllers.add(controller);
  // A timed-out waiter must not free capacity while the actual executor is still alive.
  const operation = Promise.resolve().then(() => executor(request, callerSignal ? AbortSignal.any([controller.signal, callerSignal]) : controller.signal)).finally(() => {
    controllers.delete(controller);
    settled();
  });
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
        const error = new ExecutionTimeout();
        reject(error);
        controller.abort(error);
      }, timeoutMs); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

export function objectBody(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return deny(400, 'INVALID_BODY', '请求必须是 JSON 对象。');
  const body = value as Record<string, unknown>;
  const unknown = Object.keys(body).filter(key => !allowed.includes(key));
  if (unknown.length) return deny(400, 'UNKNOWN_FIELD', '请求含有未支持的字段。身份、角色与执行权限由服务端决定。');
  return body;
}

export function requiredString(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) return deny(400, 'INVALID_INPUT', `${name}必须为非空文本，最多 ${max} 个字符。`);
  return value.trim();
}

export function positiveInteger(value: unknown, name: string, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) return deny(400, 'INVALID_INPUT', `${name}必须为 1 至 ${max} 的整数。`);
  return value;
}

function configPatch(value: unknown, knownFeatures: Set<string>): Partial<GroupConfig> {
  const body = objectBody(value, ['responseMode', 'language', 'features', 'deduplicate', 'sort', 'maxItems', 'welcomeText', 'antiadPromptThreshold', 'antiadActionThreshold', 'antiadStopwords']);
  const schema = z.object({
    responseMode: z.enum(['mention', 'command']).optional(),
    language: z.enum(['zh', 'en']).optional(),
    features: z.array(z.string()).max(knownFeatures.size).refine(items => items.every(id => knownFeatures.has(id)) && new Set(items).size === items.length).optional(),
    deduplicate: z.boolean().optional(), sort: z.boolean().optional(),
    maxItems: z.number().int().min(1).max(100).optional(),
    welcomeText: z.string().max(500).refine(text => Buffer.byteLength(text) <= 2000).optional(),
    antiadPromptThreshold: z.number().gt(0).max(1).optional(),
    antiadActionThreshold: z.number().gt(0).max(1).optional(),
    antiadStopwords: z.array(z.string().trim().min(1).max(80)).max(50).refine(items => new Set(items).size === items.length).optional(),
  }).strict();
  const parsed = schema.safeParse(body);
  if (!parsed.success) return deny(400, 'INVALID_CONFIG', '群配置包含无效类型、范围、功能或重复项。');
  return parsed.data;
}

// This finite rules parser is deliberately not labelled as AI or natural-language understanding.
// Every unknown clause remains a visible warning and prevents activation.
function parseRules(text: string, initial: GroupConfig): { candidate: GroupConfig; warnings: string[] } {
  const candidate = structuredClone(initial);
  const warnings: string[] = [];
  for (const raw of text.split(/[，,；;\n。.!！]/).filter(item => item.trim())) {
    const clause = raw.toLowerCase().replace(/\s+/g, '').replace(/^(请|帮我)/, '');
    if (/^(只@回复|只在@时回复|只在被@时回复|被@时回复|仅@回复|仅@机器人时回复|只响应@|mention)$/.test(clause)) candidate.responseMode = 'mention';
    else if (/^(命令触发|只使用命令|只响应命令|仅响应命令|仅命令|只在命令时回复|command)$/.test(clause)) candidate.responseMode = 'command';
    else if (/^(中文|使用中文|用中文|中文回复|用中文回复|用中文回答|zh)$/.test(clause)) candidate.language = 'zh';
    else if (/^(英文|英语|使用英文|用英文|英文回复|用英文回复|用英文回答|english|en)$/.test(clause)) candidate.language = 'en';
    else if (/^(开启|启用|打开)链接整理$/.test(clause)) { if (!candidate.features.includes('link-cleaner')) candidate.features.push('link-cleaner'); }
    else if (/^(关闭|停用|禁用)链接整理$/.test(clause)) candidate.features = candidate.features.filter(id => id !== 'link-cleaner');
    else if (/^(开启|启用|打开)(智能摘要|摘要)$/.test(clause)) { if (!candidate.features.includes('digest')) candidate.features.push('digest'); }
    else if (/^(关闭|停用|禁用)(智能摘要|摘要)$/.test(clause)) candidate.features = candidate.features.filter(id => id !== 'digest');
    else if (/^(开启|启用|打开)(原生文本回显|文本回显)$/.test(clause)) { if (!candidate.features.includes('echo')) candidate.features.push('echo'); }
    else if (/^(关闭|停用|禁用)(原生文本回显|文本回显)$/.test(clause)) candidate.features = candidate.features.filter(id => id !== 'echo');
    else if (/^(开启|启用|打开)链接整理与说明$/.test(clause)) { if (!candidate.features.includes('link-brief')) candidate.features.push('link-brief'); }
    else if (/^(关闭|停用|禁用)链接整理与说明$/.test(clause)) candidate.features = candidate.features.filter(id => id !== 'link-brief');
    else if (/^(开启|启用|打开)(新成员欢迎|欢迎)$/.test(clause)) { if (!candidate.features.includes('welcome')) candidate.features.push('welcome'); }
    else if (/^(关闭|停用|禁用)(新成员欢迎|欢迎)$/.test(clause)) candidate.features = candidate.features.filter(id => id !== 'welcome');
    else if (/^(开启|启用|打开)反广告检测$/.test(clause)) { if (!candidate.features.includes('antiad')) candidate.features.push('antiad'); }
    else if (/^(关闭|停用|禁用)反广告检测$/.test(clause)) candidate.features = candidate.features.filter(id => id !== 'antiad');
    else if (/^(开启|启用|打开)(群助手|ai助手|智能助手)$/.test(clause)) { if (!candidate.features.includes('assistant')) candidate.features.push('assistant'); }
    else if (/^(关闭|停用|禁用)(群助手|ai助手|智能助手)$/.test(clause)) candidate.features = candidate.features.filter(id => id !== 'assistant');
    else if (/^(去重|开启去重|启用去重|打开去重)$/.test(clause)) candidate.deduplicate = true;
    else if (/^(不去重|关闭去重|停用去重|禁用去重)$/.test(clause)) candidate.deduplicate = false;
    else if (/^(排序|开启排序|启用排序|打开排序)$/.test(clause)) candidate.sort = true;
    else if (/^(不排序|关闭排序|停用排序|禁用排序)$/.test(clause)) candidate.sort = false;
    else if (/^(去重并排序|去重和排序)$/.test(clause)) { candidate.deduplicate = true; candidate.sort = true; }
    else if (/^最多(?:保留)?\d+条$/.test(clause)) {
      const count = Number(clause.match(/\d+/)![0]);
      if (!Number.isSafeInteger(count) || count < 1 || count > 100) warnings.push('最多条数必须为 1 至 100，不会自动截断配置。');
      else candidate.maxItems = count;
    } else warnings.push(`无法识别的规则：${raw.trim().slice(0, 120)}。请使用支持的规则或结构化选项。`);
  }
  return { candidate, warnings };
}

function describeChanges(before: GroupConfig, after: GroupConfig): string[] {
  const changes: string[] = [];
  if (before.responseMode !== after.responseMode) changes.push(`回复模式：${before.responseMode === 'mention' ? '只 @ 回复' : '命令触发'} → ${after.responseMode === 'mention' ? '只 @ 回复' : '命令触发'}`);
  if (before.language !== after.language) changes.push(`语言：${before.language === 'zh' ? '中文' : '英文'} → ${after.language === 'zh' ? '中文' : '英文'}`);
  if (JSON.stringify(before.features) !== JSON.stringify(after.features)) changes.push(`功能组合：${before.features.join('、') || '无'} → ${after.features.join('、') || '无'}`);
  if (before.deduplicate !== after.deduplicate) changes.push(`去重：${after.deduplicate ? '开启' : '关闭'}`);
  if (before.sort !== after.sort) changes.push(`排序：${after.sort ? '开启' : '关闭'}`);
  if (before.maxItems !== after.maxItems) changes.push(`最多条数：${before.maxItems} → ${after.maxItems}`);
  if (before.welcomeText !== after.welcomeText) changes.push(`欢迎文本：${before.welcomeText || '默认'} → ${after.welcomeText || '默认'}`);
  if (before.antiadPromptThreshold !== after.antiadPromptThreshold) changes.push(`广告提示阈值：${before.antiadPromptThreshold ?? 0.55} → ${after.antiadPromptThreshold ?? 0.55}`);
  if (before.antiadActionThreshold !== after.antiadActionThreshold) changes.push(`广告高风险阈值：${before.antiadActionThreshold ?? 0.9} → ${after.antiadActionThreshold ?? 0.9}（仅建议，不自动处罚）`);
  if (JSON.stringify(before.antiadStopwords ?? []) !== JSON.stringify(after.antiadStopwords ?? [])) changes.push(`本群广告关键词：${(before.antiadStopwords ?? []).length} → ${(after.antiadStopwords ?? []).length} 项`);
  if (!before.features.includes('assistant') && after.features.includes('assistant')) changes.push('群助手只处理每次确认的显式目标，不读取群历史；原生 Docker 入口为一次模型请求、无工具，工具能力以当前实际接入为准。');
  if (!before.features.includes('digest') && after.features.includes('digest')) changes.push('智能摘要只处理明确提交的文本；每次使用需确认将该次输入发送给已配置的第三方模型服务，不读取群历史。');
  if (!before.features.includes('link-brief') && after.features.includes('link-brief')) changes.push('链接整理与说明使用本群链接代码结果，再由 AI 解释；最多两次模型请求，每次使用需确认第三方处理。');
  return changes;
}

export interface GroupActionOptions {
  executor?: Executor;
  aiExecutor?: Executor;
  echoExecutor?: Executor;
  mixedExecutor?: Executor;
  welcomeExecutor?: Executor;
  antiadExecutor?: Executor;
  assistantExecutor?: Executor;
  /** Trusted, bounded outer wait for the opt-in sandbox digest route. */
  sandboxAiTimeoutMs?: number;
  maxActiveTasks?: number;
  /** Recheck real membership before each live read/write; failure must remove the observation. */
  refreshRole?: (actorId: string, groupId: string) => Promise<void>;
}

// Ordinary authorization shared by HTTP/TG. Koishi owns code; DSH owns Agent/Skill.
export function createGroupActions(store: Store, options: GroupActionOptions = {}) {
  const maxActiveTasks = options.maxActiveTasks ?? 2;
  if (!Number.isSafeInteger(maxActiveTasks) || maxActiveTasks < 1 || maxActiveTasks > 8) {
    throw new Error('maxActiveTasks 必须为 1 至 8 的可信部署设置。');
  }
  let activeTasks = 0;
  const activeGroups = new Set<string>();
  const activeControllers = new Set<AbortController>();
  const taskControllers = new Map<string, { actorId: string; groupId: string; featureId: string; controller: AbortController }>();
  let closed = false;
  const acquireExecution = (groupId: string): (() => void) => {
    if (activeTasks >= maxActiveTasks || activeGroups.has(groupId)) return deny(429, 'EXECUTION_BUSY', '执行容量已满或本群已有活跃任务。请稍后明确提交；没有排队或自动重试。');
    activeTasks++;
    activeGroups.add(groupId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeTasks--;
      activeGroups.delete(groupId);
    };
  };

  const featureWarnings = (config: GroupConfig): string[] => config.features.flatMap(id => {
    const plugin = store.plugin(id);
    if (!plugin || !plugin.available) return [`功能 ${id} 的真实执行能力尚未接入。`];
    if (!plugin.enabled) return [`功能 ${id} 已被平台停用。`];
    if (id === 'link-brief' && !config.features.includes('link-cleaner')) return ['链接整理与说明需要同时启用本群链接整理。'];
    return [];
  });

  async function getGroup(actorId: string, id: string, manager = false): Promise<Group> {
    if (id.startsWith('tg-dm:')) {
      if (!/^tg-user:[1-9]\d*$/.test(actorId) || id !== `tg-dm:${actorId.slice('tg-user:'.length)}`) return deny(404, 'NOT_FOUND', '找不到可访问的私人会话。');
      if (manager) return deny(400, 'PRIVATE_SCOPE_OPERATION', '私人会话不使用群规则配置。');
      return store.group(id, actorId) ?? deny(404, 'NOT_FOUND', '找不到可访问的私人会话。');
    }
    const liveActor = actorId.startsWith('tg-user:'); const liveGroup = id.startsWith('tg:');
    if (liveActor !== liveGroup) return deny(404, 'NOT_FOUND', '找不到可访问的群。');
    if (liveGroup && !options.refreshRole) return deny(503, 'TELEGRAM_AUTHORITY_UNAVAILABLE', '缺少当前 Telegram 权限核验，未访问本群。');
    await options.refreshRole?.(actorId, id);
    const group = store.group(id, actorId) ?? deny(404, 'NOT_FOUND', '找不到可访问的群。');
    if (manager && group.role !== 'admin') return deny(403, 'MANAGER_REQUIRED', '只有本群管理员可以提出和启用配置。');
    return group;
  }
  async function previewRules(actorId: string, groupId: string, value: unknown): Promise<Proposal> {
    const group = await getGroup(actorId, groupId, true);
    const body = objectBody(value, ['text', 'baseVersion', 'config']);
    const baseVersion = positiveInteger(body.baseVersion, '配置版本', Number.MAX_SAFE_INTEGER);
    if (baseVersion !== group.version) return deny(409, 'VERSION_CONFLICT', '群配置已更新，请重新读取后创建提案。');
    const text = body.text === undefined || body.text === '' ? '' : requiredString(body.text, '规则文本', 2000);
    if (!text && body.config === undefined) return deny(400, 'EMPTY_PROPOSAL', '请填写规则或配置选项。');
    const patch = body.config === undefined ? {} : configPatch(body.config, new Set(store.plugins().map(plugin => plugin.id)));
    const parsed = parseRules(text, { ...structuredClone(group.config), ...patch });
    if ((parsed.candidate.antiadPromptThreshold ?? 0.55) > (parsed.candidate.antiadActionThreshold ?? 0.9)) return deny(400, 'INVALID_CONFIG', '广告提示阈值不能高于高风险阈值。');
    const proposal: Proposal = {
      id: randomUUID(), groupId: group.id, creatorId: actorId, baseVersion,
      before: structuredClone(group.config), candidate: parsed.candidate,
      warnings: [...parsed.warnings, ...featureWarnings(parsed.candidate)], changes: describeChanges(group.config, parsed.candidate),
      text, status: 'pending', createdAt: new Date().toISOString(),
    };
    store.putProposal(proposal);
    store.audit({ actorId, groupId: group.id, action: 'rules.preview', targetId: proposal.id, outcome: 'pending' });
    return proposal;
  }

  async function activateRules(actorId: string, id: string, value: unknown = {}): Promise<Proposal> {
    objectBody(value ?? {}, []);
    const proposal = store.proposal(id) ?? deny(404, 'NOT_FOUND', '找不到可访问的提案。');
    await getGroup(actorId, proposal.groupId, true);
    if (proposal.status === 'active') return proposal;
    if (proposal.warnings.length || featureWarnings(proposal.candidate).length) return deny(422, 'PROPOSAL_BLOCKED', '提案仍有未识别规则、停用功能或缺失能力，不能启用。');
    const activated = store.activateProposal(proposal.id, actorId)!;
    if (activated.conflict) return deny(409, 'VERSION_CONFLICT', '此提案基于旧配置，请创建新提案；没有覆盖其他修改。');
    for (const removed of proposal.before.features.filter(id => !proposal.candidate.features.includes(id))) {
      for (const active of taskControllers.values()) if (active.groupId === proposal.groupId
        && (active.featureId === removed || (removed === 'link-cleaner' && ['link-brief', 'assistant'].includes(active.featureId)))) active.controller.abort(new Error('本群功能授权已撤销。'));
    }
    store.audit({ actorId, groupId: proposal.groupId, action: 'rules.activate', targetId: proposal.id, outcome: 'active' });
    return activated.proposal;
  }

  async function runTask(actorId: string, groupId: string, value: unknown, isActive = () => true, callerSignal?: AbortSignal): Promise<Task> {
    if (closed) return deny(503, 'SERVICE_CLOSING', '服务正在关闭，不接受新任务。');
    const group = await getGroup(actorId, groupId);
    // Role refresh is asynchronous. A request that crossed shutdown while it
    // waited must not reserve work after active tasks have been cancelled.
    if (closed) return deny(503, 'SERVICE_CLOSING', '服务正在关闭，不接受新任务。');
    const body = objectBody(value, ['input', 'featureId', 'audience', 'idempotencyKey', 'acknowledgeExternalProcessing']);
    const input = requiredString(body.input, '任务输入', MAX_TASK_BYTES);
    if (Buffer.byteLength(input, 'utf8') > MAX_TASK_BYTES || input.split(/\r?\n/).length > MAX_TASK_LINES) return deny(400, 'INPUT_TOO_LARGE', `任务最多 ${MAX_TASK_BYTES} 字节、${MAX_TASK_LINES} 行。`);
    const featureId = requiredString(body.featureId, '功能 ID', 40);
    const plugin = store.plugin(featureId) ?? deny(400, 'INVALID_FEATURE', '未知功能。');
    if (!group.config.features.includes(featureId)) return deny(403, 'FEATURE_NOT_CONFIGURED', '本群尚未配置此功能。');
    const isAi = featureId === 'digest' || featureId === 'link-brief' || featureId === 'assistant';
    if (featureId === 'link-brief') {
      const code = store.plugin('link-cleaner');
      if (!group.config.features.includes('link-cleaner') || !code?.enabled || !code.available) return deny(403, 'CODE_DEPENDENCY_UNAVAILABLE', '本群链接代码插件尚未启用或已被平台停用。');
    }
    if (body.audience !== 'private' && body.audience !== 'group') return deny(400, 'INVALID_AUDIENCE', '结果受众只能是 private 或 group。');
    const audience = body.audience;
    if (groupId.startsWith('tg-dm:') && (audience !== 'private' || !['assistant', 'digest'].includes(featureId))) {
      return deny(403, 'PRIVATE_SCOPE_OPERATION', '私人会话只支持本人问答与摘要结果。');
    }
    if (isAi && body.acknowledgeExternalProcessing !== true) return deny(400, 'EXTERNAL_PROCESSING_REVIEW_REQUIRED', 'AI 会将本次输入及适用时的代码结果发送给 DeepSeek，需要明确确认后使用。');
    if (!isAi && 'acknowledgeExternalProcessing' in body) return deny(400, 'UNKNOWN_FIELD', '此固定功能不接受第三方处理声明。');
    if (isAi && Buffer.byteLength(input) > 8000) return deny(400, 'INPUT_TOO_LARGE', 'AI 输入最多 8000 字节。');
    let key: string | undefined;
    if (body.idempotencyKey !== undefined) {
      if (typeof body.idempotencyKey !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(body.idempotencyKey)) return deny(400, 'INVALID_IDEMPOTENCY_KEY', '重复保护键必须为 1 至 128 个字母、数字或 . _ : -。');
      key = body.idempotencyKey;
    }
    const requestHash = createHash('sha256').update(JSON.stringify({ input, featureId, audience })).digest('hex');
    if (key) {
      const previous = store.reservation(group.id, actorId, key);
      if (previous) {
        if (previous.requestHash !== requestHash) return deny(409, 'IDEMPOTENCY_CONFLICT', '重复保护键已用于不同请求。');
        if (previous.expired) return deny(410, 'TASK_EXPIRED', '任务内容已按保留策略清理；重复保护仍有效，不能重新执行。');
        if (previous.pending) return deny(409, 'TASK_PENDING', '任务已经提交，结果尚未确定；没有重复执行。');
        return previous.task!;
      }
    }
    const selectedExecutor = featureId === 'link-cleaner' && plugin.kind === 'code' ? options.executor
      : featureId === 'echo' && plugin.kind === 'code' ? options.echoExecutor
      : featureId === 'digest' && plugin.kind === 'agent' ? options.aiExecutor
      : featureId === 'welcome' && plugin.kind === 'code' ? options.welcomeExecutor
      : featureId === 'antiad' && plugin.kind === 'code' ? options.antiadExecutor
      : featureId === 'assistant' && plugin.kind === 'agent' ? options.assistantExecutor
      : featureId === 'link-brief' && plugin.kind === 'agent' ? options.mixedExecutor : undefined;
    const executable = plugin.enabled && plugin.available && selectedExecutor;
    const release = executable ? acquireExecution(group.id) : undefined;
    const codeCapability = store.plugin('link-cleaner');
    const allowLinkTool = featureId === 'assistant' && group.config.features.includes('link-cleaner') && codeCapability?.enabled === true && codeCapability.available;
    const codeVersions = featureId === 'link-brief' || allowLinkTool ? store.permissionVersions(group.id, 'link-cleaner') : undefined;
    const task: Task = {
      id: randomUUID(), groupId: group.id, creatorId: actorId, featureId, audience, configVersion: group.version,
      createdAt: new Date().toISOString(), durationMs: 0, modelCalls: 0, input, output: '', status: 'blocked',
      authorization: { ...store.permissionVersions(group.id, featureId), ...(codeVersions ? { codePlatformVersion: codeVersions.platformVersion, codeGroupVersion: codeVersions.groupVersion } : {}) },
      error: '先前执行未获得确定结果；请人工核对，不能自动重放。',
    };
    try { store.reserveTask(task, key, requestHash); }
    catch (error) { release?.(); throw error; }
    const startedAt = performance.now();
    let executionSignal: AbortSignal | undefined;
    if (!plugin.enabled || !plugin.available) {
      task.error = '功能已停用或真实执行能力尚未接入；没有切换 Agent。';
    } else if (!selectedExecutor) {
      task.error = 'BLOCKED：缺少此功能的真实 Harness 绑定。没有生成模拟业务结果。';
    } else {
      const controller = new AbortController(); executionSignal = controller.signal;
      taskControllers.set(task.id, { actorId, groupId: group.id, featureId, controller });
      try {
        const trustedRequest: ExecutorRequest = Object.freeze({ taskId: task.id, tenantId: group.id, featureId,
          authorization: Object.freeze({ platformVersion: task.authorization!.platformVersion,
            groupVersion: task.authorization!.groupVersion,
            ...(task.authorization!.codePlatformVersion !== undefined ? { codePlatformVersion: task.authorization!.codePlatformVersion } : {}),
            ...(task.authorization!.codeGroupVersion !== undefined ? { codeGroupVersion: task.authorization!.codeGroupVersion } : {}) }),
          actorId, groupId: group.id, input,
          options: Object.freeze({ deduplicate: group.config.deduplicate, sort: group.config.sort, maxItems: group.config.maxItems, language: group.config.language,
            ...(featureId === 'welcome' ? { welcomeText: group.config.welcomeText, groupTitle: group.name } : {}),
            ...(featureId === 'assistant' ? { allowLinkTool } : {}),
            ...(featureId === 'antiad' ? { antiadPromptThreshold: group.config.antiadPromptThreshold ?? 0.55,
              antiadActionThreshold: group.config.antiadActionThreshold ?? 0.9,
              antiadStopwords: [...(group.config.antiadStopwords ?? [])] } : {}) }),
          audience, authorized: true });
        const result = await boundedExecution(selectedExecutor, trustedRequest, () => { release!(); }, activeControllers, controller, callerSignal,
          isAi && (featureId === 'digest' || featureId === 'assistant' || featureId === 'link-brief') ? options.sandboxAiTimeoutMs ?? TASK_TIMEOUT_MS : TASK_TIMEOUT_MS);
        if (isAi) {
          task.modelCalls = result && Number.isSafeInteger(result.modelCalls) && result.modelCalls >= 0 ? result.modelCalls : null;
          task.usage = result?.usage ?? null;
        }
        if (!result || typeof result.output !== 'string' || !result.output.trim() || Buffer.byteLength(result.output) > 64_000 || !Number.isSafeInteger(result.modelCalls) || result.modelCalls < 0) {
          task.status = 'failed'; task.error = '执行入口返回的证据不符合约定；结果未知，没有自动重试。';
        } else {
          task.modelCalls = result.modelCalls;
          if ((plugin.kind === 'code' && result.modelCalls !== 0) || (featureId === 'digest' && result.modelCalls !== 1)
            || (featureId === 'link-brief' && (!((result.modelCalls === 1 || result.modelCalls === 2) && result.toolCalls === 1)))
            || (featureId === 'assistant' && !((result.modelCalls === 1 && result.toolCalls === 0) || (result.modelCalls === 2 && result.toolCalls === 1)))) { task.status = 'failed'; task.error = '模型或代码调用证据不符合此功能的执行边界，结果未交付。'; }
          else { task.status = 'succeeded'; task.output = result.output; if (isAi) task.usage = result.usage ?? null; if (featureId === 'link-brief' || featureId === 'assistant') task.toolCalls = result.toolCalls; delete task.error; }
        }
      } catch (error) {
        task.status = 'failed';
        if (isAi) {
          const evidence = error as { name?: string; code?: string; modelCalls?: number; usage?: Task['usage']; toolCalls?: number };
          const nativeAiError = evidence?.name === 'AiBlockedError' || evidence?.name === 'AiExecutionError';
          task.modelCalls = nativeAiError && Number.isSafeInteger(evidence.modelCalls) && evidence.modelCalls! >= 0 ? evidence.modelCalls! : null;
          task.usage = nativeAiError ? evidence.usage ?? null : null;
          if (nativeAiError && (featureId === 'assistant' || featureId === 'link-brief') && Number.isSafeInteger(evidence.toolCalls)
            && evidence.toolCalls! >= 0 && evidence.toolCalls! <= 1) task.toolCalls = evidence.toolCalls;
          if (evidence?.name === 'AiBlockedError') task.status = 'blocked';
          task.error = evidence?.name === 'AiBlockedError' ? 'AI 缺少明确启用、凭据、代码绑定或审核 Skill，未完成本次生成。'
            : error instanceof ExecutionTimeout ? 'AI 执行超过可信时间上限，结果未知；迟到结果未交付，没有自动重试。'
            : 'AI 未获得原生完成证据或已取消，结果未交付；调用与用量按已取得证据记录，无自动重试。';
        }
        const safeCode = error && typeof error === 'object' && 'name' in error && error.name === 'NativeInputError' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
        if (!isAi) task.error = safeCode && Object.hasOwn(SAFE_INPUT_ERRORS, safeCode) ? SAFE_INPUT_ERRORS[safeCode]
          : controller.signal.aborted && !(controller.signal.reason instanceof ExecutionTimeout) ? '已请求取消；未交付结果。底层实际停止与副作用状态需按执行端证据核对，没有自动重试。'
          : error instanceof ExecutionTimeout ? '固定代码执行超过 10 秒，结果未知；超时不代表底层操作已取消。没有自动重试或切换 Agent。'
          : '固定代码执行未获得成功证据，副作用状态可能未知。没有切换模型或 Agent，也没有自动重试。';
      }
    }
    // The executor yields control. A platform stop or preview-session revocation
    // during that time must suppress a late result, even if execution already ended.
    // Keep the controller through the final current-role lookup: disable/re-enable
    // or cancellation during that await must remain revoked for this task.
    try {
      let currentGroup: Group | undefined;
      try { currentGroup = await getGroup(actorId, group.id); } catch { /* Fail closed on current authority lookup failure. */ }
      const currentPlugin = store.plugin(featureId);
      const usesCode = featureId === 'link-brief' || (featureId === 'assistant' && task.toolCalls === 1);
      const currentCode = usesCode ? store.plugin('link-cleaner') : undefined;
      if ((executionSignal?.aborted && !(executionSignal.reason instanceof ExecutionTimeout)) || callerSignal?.aborted || !isActive() || !currentGroup ||
          !currentGroup.config.features.includes(featureId) || !currentPlugin?.enabled || !currentPlugin.available
          || (usesCode && (!currentGroup.config.features.includes('link-cleaner') || !currentCode?.enabled || !currentCode.available))
          || !store.taskAuthorized(task)) {
        task.status = 'blocked'; task.output = '';
        task.error = '执行期间会话、群权限或功能授权已失效；迟到结果未交付，执行结果需人工核对，没有重跑。';
      }
      task.durationMs = Math.max(0, Math.round(performance.now() - startedAt));
      const finished = store.finishTask(task);
      if (finished === false) { task.status = 'blocked'; task.output = ''; task.error = '任务归属或终态已变化，旧执行结果未写入或交付，没有重放。'; return task; }
      store.audit({ actorId, groupId: group.id, action: 'task.finish', targetId: task.id, outcome: task.status });
      return task;
    } finally { taskControllers.delete(task.id); }
  }

  return {
    getGroup, previewRules, activateRules, runTask,
    async ownActiveTasks(actorId: string, groupId: string) {
      await getGroup(actorId, groupId);
      return [...taskControllers.entries()].filter(([, task]) => task.actorId === actorId && task.groupId === groupId).map(([id, task]) => ({ id, featureId: task.featureId }));
    },
    async cancelTask(actorId: string, id: string): Promise<{ requested: boolean }> {
      const row = store.task(id) ?? deny(404, 'NOT_FOUND', '找不到可取消的任务。');
      await getGroup(actorId, row.groupId);
      if (row.creatorId !== actorId) return deny(404, 'NOT_FOUND', '找不到可取消的任务。');
      const active = taskControllers.get(id);
      if (!active) return { requested: false };
      active.controller.abort(new Error('请求者取消了任务。'));
      store.audit({ actorId, groupId: row.groupId, action: 'task.cancel', targetId: id, outcome: 'requested' });
      return { requested: true };
    },
    stopFeature(featureId: string, groupId?: string) {
      for (const active of taskControllers.values()) if ((active.featureId === featureId || (featureId === 'link-cleaner' && ['link-brief', 'assistant'].includes(active.featureId))) && (!groupId || active.groupId === groupId)) active.controller.abort(new Error('功能授权已撤销。'));
    },
    close() {
      closed = true;
      for (const controller of activeControllers) controller.abort(new Error('服务正在关闭。'));
      for (const task of taskControllers.values()) task.controller.abort(new Error('服务正在关闭。'));
    },
  };
}
