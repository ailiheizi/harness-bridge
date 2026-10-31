import { describeGroupSettings, describeRuleProposal, installGroupAdminCommands, type GroupAdminBinding } from './koishi-group-admin.js';
import { createRequire } from 'node:module';
import type { Context, Session } from 'koishi';
import type { Role } from '../shared.js';
import type { Store } from './store.js';
import type { TelegramActor, TelegramBinding } from './telegram.js';

interface TelegramApiBot {
  selfId: string;
  internal: {
    getChat(payload: { chat_id: string }): Promise<{ id: number | string; type?: string }>;
    getChatMember(payload: { chat_id: string; user_id: number }): Promise<{
      user?: { id?: number; is_bot?: boolean }; status?: string; is_member?: boolean;
    }>;
  };
}
type NativeSession = Session & { bot: TelegramApiBot };
const require = createRequire(import.meta.url);
const { h } = require('@koishijs/core') as typeof import('koishi');
type RawMessage = {
  message_id?: number; date?: number; from?: { id?: number; is_bot?: boolean; first_name?: string; last_name?: string };
  chat?: { id?: number; type?: string; title?: string }; sender_chat?: unknown;
};
type RawUpdate = { update_id?: number; message?: RawMessage };
const decimal = (value: unknown, negative: boolean) => {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  const n = Number(value);
  return Number.isSafeInteger(n) && (negative ? n < 0 : n > 0) && String(n) === String(value);
};

/** Verify an actual Telegram member through the official Satori Telegram adapter API. */
export async function verifyTelegramMember(bot: TelegramApiBot, chatId: string, userId: string): Promise<Role | undefined> {
  if (!decimal(chatId, true) || !decimal(userId, false)) return undefined;
  try {
    const chat = await bot.internal.getChat({ chat_id: chatId });
    if (String(chat.id) !== chatId || (chat.type !== 'group' && chat.type !== 'supergroup')) return undefined;
    const self = await bot.internal.getChatMember({ chat_id: chatId, user_id: Number(bot.selfId) });
    if (!self.user || String(self.user.id) !== bot.selfId || (self.status !== 'creator' && self.status !== 'administrator')) return undefined;
    const member = await bot.internal.getChatMember({ chat_id: chatId, user_id: Number(userId) });
    if (!member.user || String(member.user.id) !== userId || member.user.is_bot) return undefined;
    if (member.status === 'creator' || member.status === 'administrator') return 'admin';
    if (member.status === 'member' || (member.status === 'restricted' && member.is_member)) return 'member';
  } catch { /* Telegram API failures deny access without logging response bodies. */ }
  return undefined;
}

/** Refresh the persisted role before every existing action authorization check. */
export function createTelegramRoleVerifier(getBot: () => TelegramApiBot | undefined, getStore: () => Store) {
  return async (actorId: string, groupId: string): Promise<void> => {
    if (!actorId.startsWith('tg-user:') || !groupId.startsWith('tg:')) return;
    const chatId = groupId.slice(3), userId = actorId.slice('tg-user:'.length);
    const bot = getBot();
    const role = bot ? await verifyTelegramMember(bot, chatId, userId) : undefined;
    try { getStore().syncTelegramMember(chatId, userId, role); }
    catch (error) {
      // An unregistered group has no membership row to revoke yet.
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'GROUP_UNREGISTERED')) throw error;
    }
  };
}

export function telegramCommandSource(session: Session, allowMessage = false): { actor: TelegramActor; raw: RawMessage; updateId: number; messageId: number } | undefined {
  if (session.platform !== 'telegram' || (session.type !== 'interaction/command' && !(allowMessage && session.type === 'message'))) return undefined;
  const event = session.event as Session['event'] & { _data?: RawUpdate };
  const raw = event._data?.message;
  const user = event.user;
  if (!raw || raw.sender_chat || !decimal(raw.chat?.id, true) || !decimal(raw.from?.id, false)
    || !decimal(user?.id, false) || String(raw.from?.id) !== user?.id || raw.from?.is_bot || user?.isBot
    || (raw.chat?.type !== 'group' && raw.chat?.type !== 'supergroup')
    || !Number.isSafeInteger(raw.message_id) || !raw.message_id || !Number.isSafeInteger(event._data?.update_id)) return undefined;
  return { actor: { groupId: String(raw.chat.id), userId: String(raw.from.id), role: 'member' }, raw,
    updateId: event._data!.update_id!, messageId: raw.message_id! };
}

const featureNames: Record<string, string> = {
  'link-cleaner': '链接整理', digest: '智能摘要', echo: '文字回显', 'link-brief': '链接说明',
  welcome: '新成员欢迎', antiad: '反广告检测', assistant: '群助手',
};
const fallback = '操作失败或结果未知，请稍后查看群配置；没有自动重试。';

async function send(session: Session, text: string) {
  try { await session.send(h.text(text.slice(0, 3800))); } catch { /* Avoid exposing adapter errors or credentials. */ }
}

/** Install GroupWeave commands as ordinary Koishi commands on real Telegram sessions. */
export function installGroupCommands(ctx: Context, binding: TelegramBinding, options: { aiConfigured?: boolean; privateBinding?: TelegramBinding; renderConfigured?: boolean; parserConfigured?: boolean; groupAdmin?: GroupAdminBinding } = {}): void {
  if (options.groupAdmin) installGroupAdminCommands(ctx, options.groupAdmin, send);
  const privateAiHint = () => options.aiConfigured && options.privateBinding
    ? '私聊 AI：平台启用后可直接发文字、/ask <问题>、/digest <文本>、/translate <目标语言> <文本>，也可回复本会话文本后使用命令；本人确认第三方处理才执行。/cancel 取消本人私聊任务。'
    : '私聊 AI 尚未配置，需要平台管理员接入 Docker/DSH 并启用问答或摘要。';
  const videoHint = (session: Session) => session.app.$commander.get('v2g')
    ? '视频：/v2g 后上传视频，或回复视频后 /v2g；也支持 /v2g <视频链接>。\n媒体：回复附件后 /mediainfo，/convert mp4|mp3|m4a|small，/clip <起点秒> <时长秒>。/cancelmedia 取消本人当前会话的新媒体预设任务（不含 v2g）。输入最多 10 MiB、60 秒。' : '';
  const imageHint = (session: Session) => session.app.$commander.get('image')
    ? `图片：回复图片后 /image jpg|png|webp [宽度] [质量]。PDF：/imgpdf start，上传图片，再 /imgpdf done；/imgpdf cancel 取消收图。\nMarkdown：${options.renderConfigured ? '/mdimg <文本> 转图片（支持代码、公式和 Mermaid）' : '渲染未开启，需平台准备浏览器并启用 ENABLE_RENDER'}。\n站点解析：${options.parserConfigured ? '/parse <B站或抖音链接>；解析工具已配置，各站可用性以实际结果为准' : '未开启，平台可启用本地解析工具，Cookie 按站点需要配置'}。` : '';
  const descriptions: Record<string, string> = {
    start: '开始使用 GroupWeave', plugins: '查看本群已启用功能和实际命令', status: '查看机器人连接状态',
    register: '由本群管理员接入本群', settings: '查看本群配置和修改方法',
    'rules <text:text>': '预览本群规则变更', 'applyrules <id:string>': '确认本人创建的规则提案',
    'links <text:text>': '整理本次提供的链接', cancel: '取消本人在当前会话的进行中 AI/链接任务',
  };
  const register = (name: string, handler: (session: Session, input?: string) => Promise<void>) => {
    ctx.command(name, descriptions[name]).action(async ({ session }, input?: string) => {
      if (!session) return;
      try { await handler(session, input ?? ''); }
      catch { await send(session, fallback); }
    });
  };
  register('start', async session => {
    if (session.platform !== 'telegram') return;
    await send(session, session.event.channel?.type === 1
      ? `GroupWeave 机器人：私聊可用 /fileinfo、/readfile、/savefile 处理本次文件与文字。\n${privateAiHint()}\n${videoHint(session)}\n${imageHint(session)}\n群功能：将机器人加入目标群并设为管理员，由本群管理员使用 /register。私聊有独立作用域，不读取或列出群。`
      : '请在目标群使用 /help 查看群内命令。');
  });
  register('status', async session => {
    if (session.platform !== 'telegram') return;
    const bot = (session as NativeSession).bot;
    await send(session, `GroupWeave 状态：机器人${bot.status === 1 ? '在线' : '未连接'}；本群配置${session.event.channel?.type === 1 ? '不适用（私聊）' : '请使用 /settings 查看'}。AI ${options.aiConfigured ? 'Docker 摘要/问答入口已配置；模型连接需实际请求验证，使用前需平台启用，群内还需本群启用' : '未配置'}。视频转 GIF：${session.app.$commander.get('v2g') ? '已加载' : '未开启'}。Markdown：${options.renderConfigured ? '已配置浏览器，结果以实际请求为准' : '未开启'}。站点解析：${options.parserConfigured ? '解析工具已配置，站点和媒体以实际结果为准' : '未开启直接解析'}。`);
  });
  register('plugins', async session => {
    if (session.platform === 'telegram' && session.event.channel?.type === 1) return send(session, `私聊：/fileinfo 查看附件、/readfile 读取 TXT/Markdown、/savefile <文字> 生成文本文件。\n${privateAiHint()}\n${videoHint(session)}\n${imageHint(session)}`);
    const src = telegramCommandSource(session); if (!src) return;
    const group = await binding.getGroup(src.actor);
    if (!group) return send(session, '本群尚未注册，请由本群管理员使用 /register。');
    const commands = session.app.$commander;
    const names = group.config.features.map(id => ({
      'link-cleaner': commands.get('links') ? '/links <链接或文本> 整理链接' : undefined,
      echo: commands.get('echo') ? '/echo <文本> 文字回显' : undefined,
      assistant: commands.get('ask') ? '/ask <问题> 单轮问答；/translate <目标语言> <文本> 翻译' : undefined,
      'link-brief': commands.get('brief') ? '/brief <文本> 先整理链接再说明' : undefined,
      digest: commands.get('digest') ? '/digest <文本> 摘要' : undefined,
      welcome: undefined,
      rss: commands.get('rss') ? '/rss <订阅链接> 添加；/rss -l 列表；/rss -r <订阅链接> 取消' : undefined,
      schedule: commands.get('remind') ? '/remind <时间> <文字>；daily HH:mm 或 every <间隔>；list/remove <编号>' : undefined,
    }[id] ?? featureNames[id] ?? id));
    const rows = [`本群可用功能：${names.length ? names.join('、') : '暂无'}`, '原生平台命令：/help、/plugins、/status、/settings。'];
    rows.push('管理员：/settings 查看配置；/rules <群规则> 预览并确认；/register 接入本群。');
    rows.push('文件：/fileinfo 查看附件；回复 TXT/Markdown 后 /readfile；/savefile <文字> 生成文件。');
    if (videoHint(session)) rows.push(videoHint(session));
    if (imageHint(session)) rows.push(imageHint(session));
    rows.push(options.aiConfigured ? 'AI：本群启用后可 /ask、/digest、/translate；/brief 需启用链接整理与说明及链接整理。本人确认第三方处理才执行；/cancel 取消本人任务。' : 'AI 尚未配置：需要平台管理员接入 Docker/DSH 执行入口。');
    rows.push('欢迎功能需平台在管理面板启用插件，再由本群管理员使用 /rules 开启欢迎；群配置不能自行安装平台插件。');
    if (commands.get('rss')) rows.push('RSS：/rss <订阅链接> 添加；/rss -l 查看；/rss -r <订阅链接> 取消。');
    if (commands.get('remind')) rows.push('提醒：/remind <HH:mm 或 YYYY-MM-DD HH:mm> <文字>；/remind daily <HH:mm> <文字>；/remind every <间隔> <文字>；/remind list；/remind remove <编号>。');
    await send(session, rows.join('\n'));
  });
  register('register', async session => {
    const src = telegramCommandSource(session); if (!src) return;
    const role = await verifyTelegramMember((session as NativeSession).bot, src.actor.groupId, src.actor.userId);
    if (role !== 'admin') return send(session, '需要当前本群管理员身份，且机器人必须是本群管理员。');
    src.actor.role = role;
    const group = await binding.registerGroup({ ...src.actor, role }, src.raw.chat?.title || src.actor.groupId);
    await send(session, `本群已注册（配置 v${group.version}）。可使用 /settings 查看配置，/rules <群规则> 预览后再用 /applyrules <提案ID> 确认。`);
  });
  register('settings', async session => {
    const src = telegramCommandSource(session); if (!src) return;
    const group = await binding.getGroup(src.actor);
    if (!group) return send(session, '本群尚未注册，请由本群管理员使用 /register。');
    const role = await verifyTelegramMember((session as NativeSession).bot, src.actor.groupId, src.actor.userId);
    if (role !== 'admin') return send(session, '此操作需要当前本群管理员身份。');
    await send(session, describeGroupSettings(group));
  });
  register('rules <text:text>', async (session, text = '') => {
    const src = telegramCommandSource(session); if (!src) return;
    if (!text.trim()) return send(session, '用法：/rules <群规则>。');
    const proposal = await binding.previewRules(src.actor, text.trim());
    await send(session, describeRuleProposal(proposal));
  });
  register('applyrules <id:string>', async (session, id = '') => {
    const src = telegramCommandSource(session); if (!src) return;
    if (!/^[a-zA-Z0-9-]{1,48}$/.test(id.trim())) return send(session, '用法：/applyrules <提案ID>。');
    const proposal = await binding.getProposal(src.actor, id.trim());
    if (!proposal || proposal.status !== 'pending' || proposal.warnings.length) return send(session, '找不到可由本人确认的有效本群提案，或提案仍有未解决要求。');
    const result = await binding.activateRules(src.actor, proposal.id);
    await send(session, result.status === 'active' ? '群规则已启用。' : fallback);
  });
  register('links <text:text>', async (session, input = '') => {
    const src = telegramCommandSource(session); if (!src) return;
    if (!input.trim()) return send(session, '用法：/links <链接或含链接的文本>。');
    const { actor, updateId, messageId } = src;
    const task = await binding.executeLinks({ actor, input: input.trim(), audience: 'group', updateId, messageId,
      idempotencyKey: `koishi:${updateId}:${messageId}` });
    if (!await binding.claimDelivery(actor, task.id)) return;
    if (binding.deliveryStillAuthorized && !binding.deliveryStillAuthorized(actor, task.id)) {
      await binding.recordDelivery(actor, task.id, 'withheld'); return;
    }
    try {
      // Send once through the current real Koishi session; never also return the task as command output.
      const receipts = await session.send(h.text(task.status === 'succeeded' ? task.output : '链接整理未成功完成，未投递结果。'));
      if (!receipts?.length) {
        await binding.recordDelivery(actor, task.id, 'unknown');
        return;
      }
      await binding.recordDelivery(actor, task.id, 'sent');
    } catch {
      await binding.recordDelivery(actor, task.id, 'unknown');
    }
  });
  register('cancel', async session => {
    const raw = (session.event as Session['event'] & { _data?: RawUpdate })._data?.message;
    if (session.platform === 'telegram' && session.type === 'interaction/command' && raw?.chat?.type === 'private') {
      if (!options.privateBinding || raw.sender_chat || !decimal(raw.from?.id, false) || raw.from?.is_bot || session.event.user?.isBot
        || String(raw.from?.id) !== session.event.user?.id || raw.chat.id !== raw.from.id || session.channelId !== String(raw.chat.id)) return;
      const actor: TelegramActor = { groupId: String(raw.chat.id), userId: String(raw.from.id), role: 'member' };
      await options.privateBinding.getGroup(actor);
      const count = await options.privateBinding.cancelOwnTasks?.(actor) ?? 0;
      return send(session, count ? `已请求取消本人私聊中的进行中任务：${count}` : '本人私聊中没有可取消的进行中任务。');
    }
    const src = telegramCommandSource(session); if (!src) return;
    const count = await binding.cancelOwnTasks?.(src.actor) ?? 0;
    await send(session, count ? `已请求取消本人在本群的进行中任务：${count}` : '本人在本群没有可取消的进行中任务。');
  });
}
