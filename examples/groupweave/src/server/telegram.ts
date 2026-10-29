import { Bot, InlineKeyboard, type Context, type Transformer } from 'grammy';
import { run as runTelegramUpdates, type RunnerHandle } from '@grammyjs/runner';
import { limit } from '@grammyjs/ratelimiter';
import type { Message, Update } from 'grammy/types';
import type { GroupConfig, Proposal, Role, Task } from '../shared.js';
import { createTelegramConfirmations, type AiFeature } from './telegram/confirmation.js';
import { createTelegramProductComposer } from './telegram/product.js';

/** IDs are raw decimal Telegram IDs, never body-selected tenant aliases. */
export interface TelegramActor { groupId: string; userId: string; role: Role }
export interface TelegramGroup { version: number; config: GroupConfig }
export interface TelegramLinksRequest {
  actor: TelegramActor;
  input: string;
  audience: 'group' | 'private';
  idempotencyKey: string;
  updateId: number;
  messageId: number;
}
export interface TelegramFeatureRequest extends TelegramLinksRequest {
  featureId: 'echo' | 'digest' | 'link-brief' | 'welcome' | 'antiad' | 'assistant';
  externalProcessingAcknowledged?: boolean;
  /** IDs taken from this current Telegram service event, never command arguments. */
  eventUserIds?: readonly string[];
}
export type TelegramDelivery = 'sent' | 'unknown' | 'withheld';

/** Shared application actions own persistence, CAS, authorization and DSH execution. */
export interface TelegramBinding {
  getGroup(actor: TelegramActor): Promise<TelegramGroup | null>;
  registerGroup(actor: TelegramActor, title: string): Promise<TelegramGroup>;
  previewRules(actor: TelegramActor, text: string): Promise<Proposal>;
  getProposal(actor: TelegramActor, proposalId: string): Promise<Proposal | null>;
  activateRules(actor: TelegramActor, proposalId: string): Promise<Proposal>;
  executeLinks(request: TelegramLinksRequest): Promise<Task>;
  executeFeature?(request: TelegramFeatureRequest): Promise<Task>;
  cancelOwnTasks?(actor: TelegramActor): Promise<number>;
  /** No await between this final synchronous authorization check and sendMessage. */
  deliveryStillAuthorized?(actor: TelegramActor, taskId: string): boolean;
  migrateGroup(oldGroupId: string, newGroupId: string): Promise<void>;
  /** Atomic persistent claim; already claimed/sent/unknown/withheld returns false. */
  claimDelivery(actor: TelegramActor, taskId: string): Promise<boolean>;
  recordDelivery(actor: TelegramActor, taskId: string, status: TelegramDelivery): Promise<void>;
}

export interface TelegramAdapterOptions {
  token?: string;
  adminIds?: readonly (string | number)[];
  binding?: TelegramBinding;
  /** Trusted construction option, not an HTTP/client switch. Tests intercept every API call. */
  apiTransformer?: Transformer;
  rateLimit?: false;
  /** Native menu registration is explicit and never required for initialization. */
  installCommands?: boolean;
  /** Construction-only clock for deterministic offline callback expiry tests. */
  now?: () => number;
  /** Fixed codes only: raw API errors can expose a bot token. */
  onError?: (code: string) => void;
}
export type TelegramMode = 'offline' | 'blocked' | 'ready' | 'polling' | 'stopped' | 'error';
export interface TelegramAdapterStatus { mode: TelegramMode; connected: boolean; polling: boolean; reason: string }
type Language = GroupConfig['language'];
export type TelegramSource = { groupId: string; userId: string; message: Message; title: string };

const words = {
  zh: {
    help: '成员使用：\n/plugins 查看本群可用功能和用法\n/status 查看接入状态',
    managerHelp: '本群管理员：\n/settings 查看本群配置与修改方式\n/rules <群规则> 预览后确认启用',
    available: '本群可用功能',
    emptyFeatures: '本群暂无可用功能，请联系本群管理员。平台维护插件，群管理员选择本群功能。',
    publicResult: '群内输入与结果对本群可见；需要仅自己查看时使用面板。',
    linkFeature: '链接整理 · 固定代码 · 0 次模型调用',
    summaryPanelFeature: '智能摘要：通过面板提交文本并确认第三方处理；当前 Telegram 执行入口未配置，不读取群历史。',
    summaryFeature: '智能摘要 · /digest <文本> 或回复文本后 /digest · 确认第三方处理后运行，不读取群历史。',
    scanFeature: '反广告判定 · /scan <文本> · 只分析本次文本，不删除、禁言或封禁 · 0 次模型调用',
    assistantFeature: 'AI 助手 · /ask <文本> 或回复文本后 /ask · 需本人确认第三方处理，不读取群历史。',
    echoFeature: '文字回显 · /echo <文本> · Koishi 官方插件 · 0 次模型调用',
    briefFeature: '链接说明 · /brief <文本> 或回复文本后 /brief · AI → 链接插件 → AI，需本人确认第三方处理。',
    welcomeFeature: '入群欢迎 · 新成员加入时由本群模板生成 · 0 次模型调用',
    privateHelp: 'GroupWeave 机器人\n把机器人加入群并设为管理员，本群管理员使用 /register 接入，再用 /rules 配置。\n在群内使用 /plugins 查看实际可用功能，/help 查看帮助。私聊不会读取或列出你的群，也不自动获得任何群权限。\n当前私聊提供引导；业务和管理请回到目标群。',
    featureDisabled: '本群未启用此功能，或实际执行入口尚未配置。使用 /plugins 查看本群可用功能。',
    inputUsage: '请在命令后附上文本，或回复一条文本消息后发送此命令。',
    aiConfirm: '仅处理你本次明确提供的文本，不读取群历史。输入和群内结果对本群可见；所选文本将发送到已配置的第三方模型服务。请由发起者在5分钟内确认。',
    aiAccept: '确认第三方处理并运行',
    processing: '正在处理本次文本；可使用 /cancel 或下方按钮取消本人在本群的任务。',
    cancel: '取消本人本群任务',
    cancelled: '已请求取消本人在本群的进行中任务：',
    noActive: '本人在本群没有可取消的进行中任务。',
    unknownTrigger: '无法确定机器人用户名，当前 @ 触发不可用；请由本群管理员改为命令触发。',
    settings: '本群配置',
    rulesExample: '修改示例：/rules 只使用命令，中文，开启链接整理，去重并排序，最多10条',
    settingsGuide: '支持响应方式、语言、链接整理/摘要开关、去重、排序和最多条数。先预览，再由本人确认；未知要求会阻止启用。仅修改本群，不能安装插件或更改平台能力。',
    platformHelp: '需要新能力请联系平台管理员。面板须从已配置的 Telegram Mini App 入口打开；普通网址不能建立 Telegram 登录。',
    denied: '需要真实群内、可核验的个人成员身份。Bot 必须是本群管理员；平台身份不授予群权限。',
    admin: '此操作需要当前本群管理员身份。',
    register: '本群已注册。可以用 /rules 预览规则，确认后再启用。',
    unregistered: '本群尚未注册，请由本群管理员使用 /register。',
    rulesUsage: '用法：/rules <群规则>。先预览，再由创建者确认启用。',
    linksUsage: '用法：/links <链接或含链接的文本>。',
    mention: '本群只响应明确提及：使用 /links@机器人用户名，或 @机器人用户名 加链接文本。',
    disabled: '本群未启用链接整理功能。',
    preview: '群规则预览',
    warnings: '存在未确认要求，不能启用：',
    confirm: '确认启用',
    activated: '群规则已启用。',
    invalidButton: '此按钮不可用，或不属于你在本群创建的提案。',
    failed: '操作失败或结果未知。没有自动重试业务或切换模型。',
    unavailable: '任务未成功完成，未投递业务结果。',
    truncated: '\n\n结果较长，回复已截断；完整文件回传尚未接入。',
    limited: '请求过于频繁，请稍后重新发起。',
    identity: 'Telegram API 身份已核验；连接状态不代表真实群验收已完成。',
  },
  en: {
    help: 'Member commands:\n/plugins Show this group’s available features and usage\n/status Show connection status',
    managerHelp: 'Group administrator commands:\n/settings Show this group’s settings and how to change them\n/rules <rules> Preview and confirm changes',
    available: 'Available features in this group',
    emptyFeatures: 'This group has no available features. Contact its administrator. The platform maintains plugins; group administrators choose their group’s features.',
    publicResult: 'Inputs and results posted in this group are visible to the group. Use the panel for results visible only to you.',
    linkFeature: 'Link cleanup · Fixed code · 0 model calls',
    summaryPanelFeature: 'Summary: submit text in the panel and confirm third-party processing. No Telegram summary command is configured for this binding; group history is not read.',
    summaryFeature: 'Summary · /digest <text>, or reply to text with /digest · Requires confirmation for third-party processing; no group history is read.',
    scanFeature: 'Ad analysis · /scan <text> · This text only, without deletion, mute or ban · 0 model calls',
    assistantFeature: 'AI assistant · /ask <text>, or reply with /ask · Personal third-party consent; no group history is read.',
    echoFeature: 'Echo · /echo <text> · Official Koishi plugin · 0 model calls',
    briefFeature: 'Link brief · /brief <text>, or reply with /brief · AI → link plugin → AI, with personal third-party consent.',
    welcomeFeature: 'Member welcome · Current group template on member arrival · 0 model calls',
    privateHelp: 'GroupWeave bot\nAdd this bot as a group administrator. A current group admin can use /register, then /rules to configure it.\nUse /plugins and /help in the target group. Private chat does not read or list groups or grant group access.\nPrivate chat currently provides guidance; run business and administration in the target group.',
    featureDisabled: 'This feature is disabled in this group or its execution entrypoint is not configured. Use /plugins for available features.',
    inputUsage: 'Add text after the command, or reply to a text message with this command.',
    aiConfirm: 'Only your explicitly supplied text will be processed. No group history is read. Inputs and group results are visible here; selected text will be sent to the configured third-party model service. The requester must confirm within 5 minutes.',
    aiAccept: 'Confirm third-party processing and run',
    processing: 'Processing the selected text. Use /cancel or the button below to cancel your active tasks in this group.',
    cancel: 'Cancel my group tasks',
    cancelled: 'Cancellation requested for your active tasks in this group: ',
    noActive: 'You have no cancellable active tasks in this group.',
    unknownTrigger: 'The bot username is unavailable, so mention triggering cannot work. Ask this group’s administrator to choose command triggering.',
    settings: 'Settings for this group',
    rulesExample: 'Example: /rules command; English; 开启链接整理; 去重并排序; 最多10条',
    settingsGuide: 'Supported changes: response mode, language, link cleanup/summary switches, deduplication, sorting and maximum links. Preview first; only the creator may confirm. Unknown clauses block activation. Changes apply only to this group and cannot install plugins or change platform capabilities.',
    platformHelp: 'Contact the platform administrator for new capabilities. Open the panel through its configured Telegram Mini App entry; a plain URL cannot establish Telegram login.',
    denied: 'A verifiable individual member in a real group is required. The bot must be a group admin. Platform privileges do not grant group access.',
    admin: 'This action requires current administrator rights in this group.',
    register: 'This group is registered. Use /rules to preview changes, then confirm activation.',
    unregistered: 'This group is not registered. A group admin must use /register.',
    rulesUsage: 'Usage: /rules <group rules>. Preview first; only the creator may confirm.',
    linksUsage: 'Usage: /links <links or text containing links>.',
    mention: 'This group requires an explicit mention: use /links@bot_username or @bot_username followed by link text.',
    disabled: 'Link cleanup is not enabled in this group.',
    preview: 'Group rules preview',
    warnings: 'Unresolved requirements prevent activation:',
    confirm: 'Confirm activation',
    activated: 'Group rules activated.',
    invalidButton: 'This button is unavailable or does not belong to your proposal in this group.',
    failed: 'The operation failed or its result is unknown. No automatic business retry or model fallback occurred.',
    unavailable: 'The task did not complete successfully; no business result was delivered.',
    truncated: '\n\nThe reply is truncated. Full file delivery is not connected yet.',
    limited: 'Too many requests. Please submit a new request later.',
    identity: 'Telegram API identity verified. Connection does not prove end-to-end group acceptance.',
  },
} satisfies Record<Language, Record<string, string>>;

function isAdministrator(member: { status: string }) { return member.status === 'creator' || member.status === 'administrator'; }
function groupNumber(id: string): number | undefined {
  const value = Number(id);
  return Number.isSafeInteger(value) && value < 0 && String(value) === id ? value : undefined;
}
function userNumber(id: string): number | undefined {
  const value = Number(id);
  return Number.isSafeInteger(value) && value > 0 && String(value) === id ? value : undefined;
}
function belongs(value: { groupId: string; creatorId: string }, actor: TelegramActor) {
  return value.groupId === `tg:${actor.groupId}` && value.creatorId === `tg-user:${actor.userId}`;
}
function boundedReply(value: string, language: Language) {
  if (value.length <= 3900) return value;
  let text = value.slice(0, 3900);
  const last = text.charCodeAt(text.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
  return text + words[language].truncated;
}
function describeConfig(config: GroupConfig, language: Language, operational = false) {
  const en = language === 'en';
  const featureNames: Record<string, string> = en
    ? { 'link-cleaner': 'Link cleanup', digest: 'Summary', echo: 'Echo', 'link-brief': 'Link brief', welcome: 'Welcome', reminder: 'Reminder' }
    : { 'link-cleaner': '链接整理', digest: '摘要', echo: '文字回显', 'link-brief': '链接说明', welcome: '欢迎', reminder: '提醒' };
  return [
    `${en ? 'Response' : '响应方式'}：${config.responseMode === 'mention' ? (en ? 'Explicit mention' : '明确 @') : (en ? 'Commands' : '命令')}`,
    `${en ? 'Language' : '默认语言'}：${config.language === 'en' ? 'English' : '中文'}`,
    `${en ? (operational ? 'Available features' : 'Features') : (operational ? '当前可用功能' : '启用功能')}：${config.features.map(id => featureNames[id] ?? id).join('、') || (en ? 'None' : '无')}`,
    `${en ? 'Deduplicate / sort' : '去重 / 排序'}：${config.deduplicate ? (en ? 'Yes' : '是') : (en ? 'No' : '否')} / ${config.sort ? (en ? 'Yes' : '是') : (en ? 'No' : '否')}`,
    `${en ? 'Maximum links' : '单次链接上限'}：${config.maxItems}`,
  ].join('\n');
}

function linkUsage(config: GroupConfig, language: Language, username?: string) {
  if (config.responseMode === 'command') return '/links https://example.com';
  if (!username) return words[language].unknownTrigger;
  return `/links@${username} https://example.com\n${language === 'en' ? 'Or' : '或'} @${username} https://example.com`;
}

/** Only the shared binding's current operational features are advertised. */
function describeFeatures(group: TelegramGroup, language: Language, username?: string, productConnected = false) {
  const features: string[] = [];
  if (group.config.features.includes('link-cleaner')) features.push(`${words[language].linkFeature}\n${linkUsage(group.config, language, username)}`);
  if (group.config.features.includes('digest')) features.push(productConnected ? words[language].summaryFeature : words[language].summaryPanelFeature);
  if (productConnected && group.config.features.includes('echo')) features.push(words[language].echoFeature);
  if (productConnected && group.config.features.includes('link-brief') && group.config.features.includes('link-cleaner')) features.push(words[language].briefFeature);
  if (productConnected && group.config.features.includes('antiad')) features.push(words[language].scanFeature);
  if (productConnected && group.config.features.includes('assistant')) features.push(words[language].assistantFeature);
  if (productConnected && group.config.features.includes('welcome')) features.push(words[language].welcomeFeature);
  return features.length ? `${words[language].available}\n\n${features.join('\n\n')}\n\n${words[language].publicResult}` : words[language].emptyFeatures;
}

/** Construction never requests Telegram or starts polling. Explicit init is required. */
export function createTelegramAdapter(options: TelegramAdapterOptions = {}) {
  const token = options.token?.trim();
  const adminIds = new Set((options.adminIds ?? []).map(Number).filter(id => Number.isSafeInteger(id) && id > 0));
  const binding = options.binding;
  const confirmations = createTelegramConfirmations(options.now);
  let bot: Bot | undefined;
  let runner: RunnerHandle | undefined;
  let connected = false;
  let mode: TelegramMode = !token ? 'offline' : 'blocked';
  let reason = !token ? 'TELEGRAM_TOKEN_MISSING' : !adminIds.size ? 'ADMIN_IDS_MISSING' : !binding ? 'LIVE_TENANT_BINDING_MISSING' : 'NOT_INITIALIZED';
  let initialization: Promise<boolean> | undefined;
  let initializationAbort: AbortController | undefined;
  let pollingAbort: AbortController | undefined;
  let launchOperation: Promise<void> | undefined;
  let stopOperation: Promise<void> | undefined;
  const activeUpdates = new Set<Promise<boolean>>();
  let closing = false;
  let generation = 0;
  const report = (code: string) => { options.onError?.(code); };

  async function botIsAdministrator(groupId: string) {
    const id = groupNumber(groupId);
    if (!connected || !bot || id === undefined) return false;
    const currentGeneration = generation;
    const chat = await bot.api.getChat(id);
    if (chat.id !== id || (chat.type !== 'group' && chat.type !== 'supergroup')) return false;
    const member = await bot.api.getChatMember(id, bot.botInfo.id);
    return connected && generation === currentGeneration && member.user.id === bot.botInfo.id && isAdministrator(member);
  }

  /** Fail closed and bypass stored role caches; callers must remove stale observations. */
  async function verifyMember(groupId: string, userId: string): Promise<Role | undefined> {
    const group = groupNumber(groupId); const user = userNumber(userId);
    if (group === undefined || user === undefined || !connected || !bot) return undefined;
    const currentGeneration = generation;
    try {
      if (!await botIsAdministrator(groupId)) return undefined;
      const member = await bot.api.getChatMember(group, user);
      if (!connected || generation !== currentGeneration || member.user.id !== user || member.user.is_bot) return undefined;
      if (isAdministrator(member)) return 'admin';
      if (member.status === 'member' || (member.status === 'restricted' && member.is_member)) return 'member';
    } catch { report('TELEGRAM_MEMBER_VERIFICATION_FAILED'); }
    return undefined;
  }

  function source(ctx: Context): TelegramSource | undefined {
    const callback = ctx.callbackQuery;
    const message = callback?.message ?? ctx.message;
    const from = callback?.from ?? ctx.message?.from;
    if (!message || !from || from.is_bot || !message.date || !Number.isSafeInteger(message.message_id) || message.message_id < 1) return undefined;
    if (message.chat.type !== 'group' && message.chat.type !== 'supergroup') return undefined;
    if ('sender_chat' in message && message.sender_chat) return undefined;
    if ('forward_origin' in message && message.forward_origin) return undefined;
    if (callback && (!('from' in message) || message.from?.id !== bot?.botInfo.id)) return undefined;
    const groupId = String(message.chat.id); const userId = String(from.id);
    if (groupNumber(groupId) === undefined || userNumber(userId) === undefined) return undefined;
    return { groupId, userId, message: message as Message, title: message.chat.title };
  }

  async function actorFor(src: TelegramSource, admin = false): Promise<TelegramActor | undefined> {
    const role = await verifyMember(src.groupId, src.userId);
    return role && (!admin || role === 'admin') ? { groupId: src.groupId, userId: src.userId, role } : undefined;
  }

  async function adminFor(src: TelegramSource): Promise<TelegramActor | undefined> {
    const actor = await actorFor(src);
    if (!actor || actor.role === 'admin') return actor;
    const group = await binding!.getGroup(actor); const language = group?.config.language ?? 'zh';
    await reply(src, words[language].admin, language);
    return undefined;
  }

  async function send(src: TelegramSource, text: string, language: Language, admin = false, keyboard?: InlineKeyboard, replyTo?: number) {
    if (!bot || !await actorFor(src, admin)) return undefined;
    try {
      return await bot.api.sendMessage(Number(src.groupId), boundedReply(text, language), {
        message_thread_id: src.message.message_thread_id,
        link_preview_options: { is_disabled: true }, ...(keyboard ? { reply_markup: keyboard } : {}),
        ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: false } } : {}),
      });
    } catch { report('TELEGRAM_REPLY_OUTCOME_UNKNOWN'); return undefined; }
  }
  async function reply(src: TelegramSource, text: string, language: Language, admin = false, keyboard?: InlineKeyboard) {
    return Boolean(await send(src, text, language, admin, keyboard));
  }

  async function answer(ctx: Context, text: string) {
    if (!ctx.callbackQuery) return;
    try { await ctx.answerCallbackQuery({ text: text.slice(0, 190) }); }
    catch { report('TELEGRAM_CALLBACK_ANSWER_FAILED'); }
  }

  async function settle(actor: TelegramActor, taskId: string, status: TelegramDelivery) {
    try { await binding!.recordDelivery(actor, taskId, status); }
    catch { report('TELEGRAM_DELIVERY_RECORD_FAILED'); }
  }

  type BusinessFeature = 'link-cleaner' | TelegramFeatureRequest['featureId'];
  type Trigger = 'command' | 'mention' | 'event';
  function enabled(group: TelegramGroup, featureId: BusinessFeature) {
    return group.config.features.includes(featureId)
      && (featureId !== 'link-brief' || group.config.features.includes('link-cleaner'))
      && (featureId === 'link-cleaner' || Boolean(binding?.executeFeature));
  }
  function taskEnabled(group: TelegramGroup, task: Task) {
    return enabled(group, task.featureId as BusinessFeature)
      && (task.featureId !== 'assistant' || task.toolCalls !== 1 || group.config.features.includes('link-cleaner'));
  }
  function targetCommand(ctx: Context, featureId: BusinessFeature) {
    const name = featureId === 'link-cleaner' ? 'links' : featureId === 'link-brief' ? 'brief' : featureId === 'assistant' ? 'ask' : featureId === 'antiad' ? 'scan' : featureId;
    const command = ctx.entities('bot_command').find(entity => entity.offset === 0)?.text;
    return Boolean(bot?.botInfo.username && command?.toLowerCase() === `/${name}@${bot.botInfo.username.toLowerCase()}`);
  }
  function triggerAllowed(group: TelegramGroup, trigger: Trigger, targeted: boolean) {
    return trigger === 'event' || (trigger === 'mention' ? group.config.responseMode === 'mention'
      : group.config.responseMode !== 'mention' || targeted);
  }
  async function runFeature(ctx: Context, input: string, featureId: BusinessFeature, trigger: Trigger,
    approved?: { updateId: number; messageId: number; targeted: boolean; eventUserIds?: readonly string[] }) {
    const src = source(ctx); if (!src || !binding) return;
    let actor = await actorFor(src); if (!actor) return;
    const group = await binding.getGroup(actor); const language = group?.config.language ?? 'zh';
    if (!group) { await reply(src, words[language].unregistered, language); return; }
    const targeted = approved?.targeted ?? targetCommand(ctx, featureId);
    if (!triggerAllowed(group, trigger, targeted)) {
      if (trigger === 'command') await reply(src, words[language].mention, language);
      return;
    }
    if (!enabled(group, featureId)) { if (trigger !== 'event') await reply(src, featureId === 'link-cleaner' ? words[language].disabled : words[language].featureDisabled, language); return; }
    if (!input.trim()) { await reply(src, featureId === 'link-cleaner' ? words[language].linksUsage : words[language].inputUsage, language); return; }
    const updateId = approved?.updateId ?? ctx.update.update_id;
    const messageId = approved?.messageId ?? src.message.message_id;
    if (!Number.isSafeInteger(updateId) || updateId < 0 || !Number.isSafeInteger(messageId) || messageId < 1) return;
    const request: TelegramLinksRequest = { actor, input: input.trim(), audience: 'group',
      idempotencyKey: `telegram:${updateId}:${messageId}`, updateId, messageId };
    const ai = featureId === 'digest' || featureId === 'link-brief' || featureId === 'assistant';
    if (ai && !approved) return;
    const execution = featureId === 'link-cleaner' ? binding.executeLinks(request)
      : binding.executeFeature!({ ...request, featureId, ...(ai ? { externalProcessingAcknowledged: true } : {}),
        ...(approved?.eventUserIds ? { eventUserIds: approved.eventUserIds } : {}) });
    // Attach rejection immediately while the progress response performs API calls.
    const executing = execution.then(task => ({ task }), error => ({ error }));
    if (ai) {
      const keyboard = binding.cancelOwnTasks ? new InlineKeyboard().text(words[language].cancel,
        confirmations.cancelButton(src.groupId, src.userId, src.message.message_id)) : undefined;
      await send(src, words[language].processing, language, false, keyboard, src.message.message_id);
    }
    const result = await executing;
    if ('error' in result) throw result.error;
    const task = result.task;
    const modelEvidence = ai ? task.status !== 'succeeded' || (featureId === 'assistant'
      ? (task.modelCalls === 1 && task.toolCalls === 0) || (task.modelCalls === 2 && task.toolCalls === 1)
      : featureId === 'digest' ? task.modelCalls === 1 : task.modelCalls === 2 && task.toolCalls === 1) : task.modelCalls === 0;
    if (!task.id || !belongs(task, actor) || task.input !== input.trim() || task.audience !== 'group' || task.featureId !== featureId || !modelEvidence) {
      report('TELEGRAM_RESULT_SCOPE_REJECTED'); return;
    }
    actor = await actorFor(src);
    if (!actor) { await settle({ groupId: src.groupId, userId: src.userId, role: 'member' }, task.id, 'withheld'); return; }
    const current = await binding.getGroup(actor);
    if (!current || !taskEnabled(current, task) || !triggerAllowed(current, trigger, targeted)) { await settle(actor, task.id, 'withheld'); return; }
    if (!await binding.claimDelivery(actor, task.id)) return;
    // Claim precedes the network attempt. No send retry after an unknown outcome.
    if (!await actorFor(src)) { await settle(actor, task.id, 'withheld'); return; }
    const deliveryGroup = await binding.getGroup(actor);
    if (!deliveryGroup || !taskEnabled(deliveryGroup, task) || !triggerAllowed(deliveryGroup, trigger, targeted)) { await settle(actor, task.id, 'withheld'); return; }
    if (binding.deliveryStillAuthorized && !binding.deliveryStillAuthorized(actor, task.id)) { await settle(actor, task.id, 'withheld'); return; }
    const text = task.status === 'succeeded' && task.output.trim() ? task.output : words[language].unavailable;
    try {
      await bot!.api.sendMessage(Number(src.groupId), boundedReply(text, language), {
        message_thread_id: src.message.message_thread_id, link_preview_options: { is_disabled: true },
        reply_parameters: { message_id: messageId, allow_sending_without_reply: false },
      });
      await settle(actor, task.id, 'sent');
    } catch { await settle(actor, task.id, 'unknown'); report('TELEGRAM_DELIVERY_OUTCOME_UNKNOWN'); }
  }

  function commandInput(ctx: Context) {
    const message = ctx.message;
    if (!message || typeof message.text !== 'string') return undefined;
    const entities = message.entities ?? [];
    const command = entities.find(entity => entity.type === 'bot_command' && entity.offset === 0);
    if (!command) return undefined;
    const text = message.text.slice(command.length).trim();
    if (text) return { input: text, message, mode: 'command' as const };
    const replied = message.reply_to_message;
    if (replied && typeof replied.text === 'string' && replied.text.trim() && replied.chat.id === message.chat.id) return { input: replied.text.trim(), message: replied, mode: 'reply' as const };
    return undefined;
  }
  function mentionInput(message: Message) {
    if (typeof message.text !== 'string' || !bot?.botInfo.username) return undefined;
    const text = message.text;
    const mentions = (message.entities ?? []).filter(entity => entity.type === 'mention'
      ? text.slice(entity.offset, entity.offset + entity.length).toLowerCase() === `@${bot!.botInfo.username!.toLowerCase()}`
      : entity.type === 'text_mention' && entity.user.id === bot!.botInfo.id);
    if (!mentions.length) return undefined;
    let input = text;
    for (const entity of [...mentions].sort((a, b) => b.offset - a.offset)) input = input.slice(0, entity.offset) + input.slice(entity.offset + entity.length);
    return input.trim();
  }
  async function requestAi(ctx: Context, featureId: AiFeature, mention?: string) {
    const src = source(ctx); if (!src || !binding) return;
    const actor = await actorFor(src); if (!actor) return;
    const group = await binding.getGroup(actor); const language = group?.config.language ?? 'zh';
    if (!group) { await reply(src, words[language].unregistered, language); return; }
    const targeted = mention !== undefined || targetCommand(ctx, featureId);
    if (!triggerAllowed(group, mention !== undefined ? 'mention' : 'command', targeted)) {
      if (mention === undefined) await reply(src, words[language].mention, language); return;
    }
    if (!enabled(group, featureId)) { await reply(src, words[language].featureDisabled, language); return; }
    const selected = mention !== undefined ? { input: mention, message: src.message, mode: 'mention' as const } : commandInput(ctx);
    if (!selected?.input.trim() || Buffer.byteLength(selected.input, 'utf8') > 8_000) { await reply(src, words[language].inputUsage, language); return; }
    const data = confirmations.issue({ featureId, groupId: src.groupId, userId: src.userId, messageId: selected.message.message_id,
      updateId: ctx.update.update_id, input: selected.input, mode: selected.mode, targeted });
    await send(src, words[language].aiConfirm, language, false, new InlineKeyboard().text(words[language].aiAccept, data), selected.message.message_id);
  }
  async function confirmAi(ctx: Context) {
    const src = source(ctx); const data = ctx.callbackQuery?.data;
    const decoded = data ? confirmations.inspect(data) : undefined;
    if (!src || !binding || !data || !decoded || decoded.userId !== src.userId) { await answer(ctx, words.zh.invalidButton); return; }
    const actor = await actorFor(src); if (!actor) { await answer(ctx, words.zh.invalidButton); return; }
    const group = await binding.getGroup(actor); const language = group?.config.language ?? 'zh';
    const original = 'reply_to_message' in src.message ? src.message.reply_to_message : undefined;
    if (!group || !enabled(group, decoded.featureId) || !original || original.message_id !== decoded.messageId
      || original.chat.id !== Number(src.groupId) || typeof original.text !== 'string') { await answer(ctx, words[language].invalidButton); return; }
    let input: string | undefined;
    if (decoded.mode === 'reply') input = original.text.trim();
    else if (decoded.mode === 'mention') input = mentionInput(original);
    else {
      const name = decoded.featureId === 'digest' ? 'digest' : decoded.featureId === 'assistant' ? 'ask' : 'brief';
      const command = (original.entities ?? []).find(entity => entity.type === 'bot_command' && entity.offset === 0);
      const expected = `/${name}${decoded.targeted ? `@${bot!.botInfo.username}` : ''}`.toLowerCase();
      if (original.from?.id === Number(src.userId) && command && original.text.slice(0, command.length).toLowerCase() === expected) input = original.text.slice(command.length).trim();
    }
    if (!input || Buffer.byteLength(input, 'utf8') > 8_000 || !triggerAllowed(group, decoded.mode === 'mention' ? 'mention' : 'command', decoded.targeted)
      || !confirmations.consume(data, { ...decoded, groupId: src.groupId, input })) { await answer(ctx, words[language].invalidButton); return; }
    await answer(ctx, words[language].processing);
    await runFeature(ctx, input, decoded.featureId, decoded.mode === 'mention' ? 'mention' : 'command', decoded);
  }
  async function cancel(ctx: Context, button = false) {
    const src = source(ctx); if (!src || !binding?.cancelOwnTasks) { if (button) await answer(ctx, words.zh.invalidButton); return; }
    const actor = await actorFor(src); if (!actor) { if (button) await answer(ctx, words.zh.invalidButton); return; }
    const group = await binding.getGroup(actor); const language = group?.config.language ?? 'zh';
    if (!group) { if (button) await answer(ctx, words[language].invalidButton); else await reply(src, words[language].unregistered, language); return; }
    if (button) {
      const original = 'reply_to_message' in src.message ? src.message.reply_to_message : undefined;
      if (!original || !ctx.callbackQuery?.data || !confirmations.consumeCancel(ctx.callbackQuery.data, src.groupId, src.userId, original.message_id)) { await answer(ctx, words[language].invalidButton); return; }
    }
    const count = await binding.cancelOwnTasks(actor);
    const text = count ? `${words[language].cancelled}${count}` : words[language].noActive;
    if (button) await answer(ctx, text); else await reply(src, text, language);
  }
  async function productHelp(ctx: Context) {
    const message = ctx.message;
    if (message?.chat.type === 'private' && message.from && !message.from.is_bot && !message.sender_chat && !message.forward_origin
      && message.chat.id === message.from.id && connected && bot) {
      try { await bot.api.sendMessage(message.chat.id, words.zh.privateHelp, { link_preview_options: { is_disabled: true } }); }
      catch { report('TELEGRAM_REPLY_OUTCOME_UNKNOWN'); } return;
    }
    const src = source(ctx); if (!src || !binding) return;
    const actor = await actorFor(src); if (!actor) return;
    const group = await binding.getGroup(actor); const language = group?.config.language ?? 'zh';
    const command = ctx.entities('bot_command')[0]?.text.split('@')[0];
    if (command === '/status') { await reply(src, words[language].identity, language); return; }
    if (!group) { await reply(src, words[language].unregistered, language); return; }
    const featureHelp = describeFeatures(group, language, bot?.botInfo.username, Boolean(binding.executeFeature));
    const text = command === '/plugins' ? featureHelp : [words[language].help, featureHelp,
      ...(binding.cancelOwnTasks ? ['/cancel · ' + words[language].cancel] : []), ...(actor.role === 'admin' ? [words[language].managerHelp] : [])].join('\n\n');
    await reply(src, text, language);
  }
  async function welcome(ctx: Context) {
    const src = source(ctx); const message = ctx.message;
    if (!src || !message || !message.new_chat_members || !binding?.executeFeature) return;
    const members = message.new_chat_members.filter(user => !user.is_bot && userNumber(String(user.id)) !== undefined);
    if (!members.length) return;
    // Event payload is input only. The sender still needs current member rights.
    await runFeature(ctx, members.map(user => user.first_name).join('、'), 'welcome', 'event', {
      updateId: ctx.update.update_id, messageId: message.message_id, targeted: false, eventUserIds: members.map(user => String(user.id)),
    });
  }

  function createBot() {
    const instance = new Bot(token!);
    if (options.apiTransformer) instance.api.config.use(options.apiTransformer);
    instance.use(async (ctx, next) => {
      try { await next(); }
      catch {
        report('TELEGRAM_UPDATE_ACTION_FAILED');
        const src = source(ctx); let language: Language = 'zh';
        if (src && binding) {
          try { const actor = await actorFor(src); if (actor) language = (await binding.getGroup(actor))?.config.language ?? 'zh'; }
          catch { /* Unknown authority/configuration cannot grant access through error recovery. */ }
        }
        if (ctx.callbackQuery) await answer(ctx, words[language].failed);
        else if (src) await reply(src, words[language].failed, language);
      }
    });
    instance.on(['message:migrate_to_chat_id', 'message:migrate_from_chat_id'], async ctx => {
      if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') return;
      const oldId = String(ctx.message.migrate_from_chat_id ?? ctx.chat.id);
      const newId = String(ctx.message.migrate_to_chat_id ?? ctx.chat.id);
      if (!binding || oldId === newId || groupNumber(oldId) === undefined || !await botIsAdministrator(newId)) return;
      await binding.migrateGroup(oldId, newId);
    });
    if (options.rateLimit !== false) {
      const onLimitExceeded = async (ctx: Context) => { if (ctx.callbackQuery) await answer(ctx, words.zh.limited); };
      instance.use(limit({ timeFrame: 2000, limit: 3, onLimitExceeded,
        keyGenerator: ctx => ctx.from && ctx.chat ? String(ctx.from.id) : undefined }));
      instance.use(limit({ timeFrame: 2000, limit: 10, onLimitExceeded,
        keyGenerator: ctx => ctx.chat && ['group', 'supergroup'].includes(ctx.chat.type) ? String(ctx.chat.id) : undefined }));
    }
    instance.use(createTelegramProductComposer({
      help: productHelp,
      links: ctx => runFeature(ctx, commandInput(ctx)?.input ?? '', 'link-cleaner', 'command'),
      echo: ctx => runFeature(ctx, commandInput(ctx)?.input ?? '', 'echo', 'command'),
      scan: ctx => runFeature(ctx, commandInput(ctx)?.input ?? '', 'antiad', 'command'),
      requestAi, confirmAi, cancel: ctx => cancel(ctx), cancelButton: ctx => cancel(ctx, true), welcome,
      mention: async ctx => {
        if (ctx.entities('bot_command').some(entity => entity.offset === 0)) return;
        const src = source(ctx); if (!src) return;
        const input = mentionInput(src.message); if (input === undefined) return;
        if (/^https?:\/\/\S+(?:\s+https?:\/\/\S+)*$/i.test(input)) await runFeature(ctx, input, 'link-cleaner', 'mention');
        else {
          const actor = await actorFor(src); if (!actor) return;
          const group = await binding!.getGroup(actor); if (!group || group.config.responseMode !== 'mention') return;
          if (input && enabled(group, 'assistant')) await requestAi(ctx, 'assistant', input);
          else if (/https?:\/\//i.test(input)) await runFeature(ctx, input, 'link-cleaner', 'mention');
          else if (input && enabled(group, 'digest')) await requestAi(ctx, 'digest', input);
          else await reply(src, describeFeatures(group, group.config.language, instance.botInfo.username, Boolean(binding?.executeFeature)), group.config.language);
        }
      },
    }));
    instance.command('settings', async ctx => {
      const src = source(ctx); if (!src || !binding) return;
      const actor = await adminFor(src); if (!actor) return;
      const group = await binding.getGroup(actor); const language = group?.config.language ?? 'zh';
      if (!group) { await reply(src, words[language].unregistered, language, true); return; }
      await reply(src, `${words[language].settings} · ${src.title} · v${group.version}\n${describeConfig(group.config, language, true)}\n\n${words[language].rulesExample}\n\n${words[language].settingsGuide}\n\n${words[language].platformHelp}`, language, true);
    });
    instance.command('register', async ctx => {
      const src = source(ctx); if (!src || !binding) return;
      const actor = await adminFor(src); if (!actor) return;
      const group = await binding.registerGroup(actor, src.title);
      await reply(src, words[group.config.language].register, group.config.language, true);
    });
    instance.command('rules', async ctx => {
      const src = source(ctx); if (!src || !binding) return;
      const actor = await adminFor(src); if (!actor) return;
      const group = await binding.getGroup(actor); const language = group?.config.language ?? 'zh';
      if (!group) { await reply(src, words[language].unregistered, language, true); return; }
      if (!ctx.match.trim()) { await reply(src, words[language].rulesUsage, language, true); return; }
      const proposal = await binding.previewRules(actor, ctx.match.trim());
      if (!belongs(proposal, actor)) { report('TELEGRAM_PROPOSAL_SCOPE_REJECTED'); return; }
      const warning = proposal.warnings.length ? `\n${words[language].warnings}\n${proposal.warnings.join('\n')}` : '';
      const text = `${words[language].preview} · ${src.title} · v${proposal.baseVersion}\n${describeConfig(proposal.candidate, language)}${warning}`;
      const keyboard = !proposal.warnings.length && proposal.status === 'pending'
        ? new InlineKeyboard().text(words[language].confirm, `gw:activate:${proposal.id}`) : undefined;
      await reply(src, text, language, true, keyboard);
    });
    instance.callbackQuery(/^gw:activate:([a-zA-Z0-9-]{1,48})$/, async ctx => {
      const src = source(ctx); if (!src || !binding) { await answer(ctx, words.zh.invalidButton); return; }
      const actor = await actorFor(src, true); if (!actor) { await answer(ctx, words.zh.invalidButton); return; }
      const group = await binding.getGroup(actor); const language = group?.config.language ?? 'zh';
      const proposal = await binding.getProposal(actor, ctx.match[1]);
      if (!group || !proposal || proposal.status !== 'pending' || !belongs(proposal, actor) || proposal.warnings.length) { await answer(ctx, words[language].invalidButton); return; }
      const activated = await binding.activateRules(actor, proposal.id);
      if (!belongs(activated, actor) || activated.status !== 'active' || !await actorFor(src, true)) { await answer(ctx, words[language].invalidButton); return; }
      const activatedLanguage = activated.candidate.language;
      await answer(ctx, words[activatedLanguage].activated);
      await reply(src, words[activatedLanguage].activated, activatedLanguage, true);
    });
    instance.on('callback_query:data', ctx => answer(ctx, words.zh.invalidButton));
    instance.catch(() => { report('TELEGRAM_UPDATE_HANDLER_FAILED'); });
    return instance;
  }

  async function init(): Promise<boolean> {
    if (closing) return false;
    if (connected) return true;
    if (!token || !adminIds.size || !binding) return false;
    if (initialization) return initialization;
    const currentGeneration = generation;
    const controller = new AbortController();
    initializationAbort = controller;
    // grammY's Node declarations use its AbortController shim type. Node's
    // native signal implements the cancellation interface used by the API.
    const signal = controller.signal as unknown as NonNullable<Parameters<Bot['init']>[0]>;
    const operation = (async () => {
      try {
        bot ??= createBot();
        if (bot.isInited()) bot.botInfo = await bot.api.getMe(signal);
        else await bot.init(signal);
        if (closing || generation !== currentGeneration) return false;
        connected = true; mode = 'ready'; reason = 'API_IDENTITY_VERIFIED_NOT_END_TO_END_ACCEPTANCE';
        if (options.installCommands) {
          const commands = [
            { command: 'start', description: '使用引导 / Get started' }, { command: 'help', description: '帮助 / Help' },
            { command: 'plugins', description: '本群可用功能 / Group features' }, { command: 'status', description: '连接状态 / Connection' },
            { command: 'links', description: '整理当前文本链接 / Clean links' },
            ...(binding.executeFeature ? [{ command: 'echo', description: '文字回显 / Echo' },
              { command: 'scan', description: '只判定广告不处罚 / Ad analysis' }, { command: 'ask', description: '确认后AI助手 / AI assistant' },
              { command: 'digest', description: '确认后摘要本次文本 / Summary' }, { command: 'brief', description: '确认后生成链接说明 / Link brief' }] : []),
            ...(binding.cancelOwnTasks ? [{ command: 'cancel', description: '取消本人本群任务 / Cancel my tasks' }] : []),
            { command: 'settings', description: '本群管理 / Group settings' }, { command: 'rules', description: '预览本群规则 / Preview rules' },
            { command: 'register', description: '管理员接入本群 / Register group' },
          ];
          try { await bot.api.setMyCommands(commands, {}, signal); }
          catch { report('TELEGRAM_COMMAND_MENU_FAILED'); }
          if (closing || generation !== currentGeneration || !connected) return false;
        }
        return true;
      } catch {
        if (generation !== currentGeneration) return false;
        connected = false; mode = 'error'; reason = 'TELEGRAM_INITIALIZATION_FAILED'; report(reason); return false;
      }
    })();
    initialization = operation.finally(() => {
      initialization = undefined;
      if (initializationAbort === controller) initializationAbort = undefined;
    });
    return initialization;
  }
  async function launch(): Promise<void> {
    if (closing) return;
    if (launchOperation) return launchOperation;
    const operation = (async () => {
      if (runner?.isRunning() || !await init() || closing || !connected || !bot || runner?.isRunning()) return;
      const currentGeneration = generation;
      const currentBot = bot;
      const controller = new AbortController();
      pollingAbort = controller;
      let currentRunner: RunnerHandle | undefined;
      try {
        // grammY's runner does not remove an existing webhook for us. Keep the
        // same safe long-polling transition as Bot.start without dropping updates.
        await currentBot.api.deleteWebhook({ drop_pending_updates: false }, controller.signal as never);
        if (closing || generation !== currentGeneration || !connected || controller.signal.aborted) return;
        currentRunner = runTelegramUpdates({
          init: () => currentBot.init(),
          handleUpdate: async update => { await processUpdate(update); },
          errorHandler: error => currentBot.errorHandler(error as Parameters<Bot['errorHandler']>[0]),
          api: currentBot.api,
        }, {
          runner: { fetch: { allowed_updates: ['message', 'callback_query'] }, silent: true },
          sink: { concurrency: 4 },
        });
        runner = currentRunner;
        mode = 'polling'; reason = 'POLLING_STARTED_NOT_END_TO_END_ACCEPTANCE';
        await currentRunner.task();
        if (generation !== currentGeneration) return;
        connected = false; mode = 'stopped'; reason = 'POLLING_STOPPED';
      } catch {
        if (generation !== currentGeneration) return;
        connected = false; mode = 'error'; reason = 'TELEGRAM_POLLING_FAILED'; report(reason);
      } finally {
        if (runner === currentRunner) runner = undefined;
        if (pollingAbort === controller) pollingAbort = undefined;
      }
    })();
    launchOperation = operation.finally(() => { launchOperation = undefined; }); return launchOperation;
  }
  async function stop() {
    if (stopOperation) return stopOperation;
    closing = true;
    generation += 1;
    connected = false;
    initializationAbort?.abort();
    pollingAbort?.abort();
    if (token && binding && adminIds.size) { mode = 'stopped'; reason = 'POLLING_STOPPED'; }
    const initializing = initialization; const launching = launchOperation;
    const currentRunner = runner;
    const operation = (async () => {
      try {
        if (currentRunner?.isRunning()) await currentRunner.stop();
      } catch { report('TELEGRAM_RUNNER_STOP_FAILED'); }
      // RunnerHandle.stop() drains every concurrent sink handler; also include
      // non-polling authenticated updates and startup work in the shutdown fence.
      await Promise.allSettled([...(initializing ? [initializing] : []), ...(launching ? [launching] : []), ...activeUpdates]);
    })();
    stopOperation = operation.finally(() => { closing = false; stopOperation = undefined; });
    return stopOperation;
  }
  /** Transport-only: pass authenticated Telegram updates or explicit offline fixtures. */
  async function processUpdate(update: Update) {
    if (closing || !connected || !bot) return false;
    const operation = (async () => {
      try { await bot.handleUpdate(update); return true; }
      catch { report('TELEGRAM_UPDATE_HANDLER_FAILED'); return false; }
    })();
    activeUpdates.add(operation);
    try { return await operation; }
    finally { activeUpdates.delete(operation); }
  }
  async function handleUpdate(update: Update) { return processUpdate(update); }
  return {
    get connected() { return connected; },
    get status(): TelegramAdapterStatus { return { mode, connected, polling: runner?.isRunning() ?? false, reason }; },
    init, launch, stop, handleUpdate, verifyMember,
  };
}
