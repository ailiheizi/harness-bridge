import { createRequire } from 'node:module';
import type { Context, Session } from 'koishi';
const { h } = createRequire(import.meta.url)('@koishijs/core') as typeof import('koishi');
import type { TelegramActor, TelegramBinding } from './telegram.js';

/** Current native Telegram message identity only; no target/user arguments. */
export function installSessionCommands(ctx: Context, binding: TelegramBinding, options: { privateBinding?: TelegramBinding } = {}): void {
  function current(session?: Session) {
    if (!session || session.platform !== 'telegram' || session.type !== 'interaction/command') return;
    const event = session.event as Session['event'] & { _data?: { update_id?: number; message?: {
      from?: { id?: number; is_bot?: boolean }; chat?: { id?: number; type?: string }; sender_chat?: unknown;
      is_topic_message?: boolean; message_id?: number; text?: string;
    } } };
    const raw = event._data?.message;
    if (!raw || raw.sender_chat || raw.is_topic_message || raw.from?.is_bot || event.user?.isBot
      || !Number.isSafeInteger(raw.from?.id) || raw.from!.id! <= 0 || event.user?.id !== String(raw.from!.id)
      || !Number.isSafeInteger(raw.chat?.id) || !Number.isSafeInteger(raw.message_id) || !Number.isSafeInteger(event._data?.update_id)) return;
    const personal = raw.chat!.type === 'private';
    if (personal ? raw.chat!.id !== raw.from!.id || !options.privateBinding || session.isDirect === false
      : !['group', 'supergroup'].includes(raw.chat!.type!) || raw.chat!.id! >= 0 || session.guildId !== String(raw.chat!.id) || session.channelId !== session.guildId) return;
    if (session.channelId !== String(raw.chat!.id)) return;
    const target = /^\/\w+@([a-z0-9_]+)/i.exec(raw.text ?? '')?.[1];
    if (target && target.toLowerCase() !== session.bot.user?.name?.toLowerCase()) return;
    return { actor: { groupId: String(raw.chat!.id), userId: String(raw.from!.id), role: 'member' } as TelegramActor,
      active: personal ? options.privateBinding! : binding };
  }
  function command(name: string, description: string, run: (active: TelegramBinding, actor: TelegramActor, input?: string) => Promise<string>) {
    ctx.command(name, description).action(async ({ session }, input) => {
      const scope = current(session); if (!scope) return;
      try {
        const text = await run(scope.active, scope.actor, input);
        for (let offset = 0; offset < text.length; offset += 3500) await session!.send(h.text(text.slice(offset, offset + 3500)));
      }
      catch { return '无法读取或修改本人当前会话；请检查权限、任务 ID 或平台模型配置。'; }
    });
  }
  command('tasks', '本人当前会话任务状态和历史', async (active, actor) => {
    const tasks = await active.ownTasks?.(actor);
    return tasks?.length ? tasks.slice(0, 20).map(task => `${task.id} · ${task.featureId} · ${task.pending ? 'running' : task.status}`).join('\n') + '\n/task <ID> 查看结果；/cancel 取消本人当前会话任务。' : '本人当前会话暂无任务。';
  });
  command('task <id:string>', '本人当前会话指定任务结果', async (active, actor, id) => {
    if (!id || !active.ownTask) return '用法：/task <任务 ID>';
    const task = await active.ownTask(actor, id);
    return `${task.id} · ${task.pending ? 'running' : task.status}\n${task.pending ? '尚未完成。' : (task.output || task.error || '无结果。')}`;
  });
  const reset = async (active: TelegramBinding, actor: TelegramActor) => {
    if (!active.resetConversation) return '会话重置尚未接入。';
    await active.resetConversation(actor); return '已清空本人当前对话上下文；任务历史仍可查询。';
  };
  command('newchat', '重置本人当前对话上下文', reset);
  command('reset', '重置本人当前对话上下文', reset);
  command('models', '查看平台预配置模型', async (active, actor) => {
    const value = await active.listModels?.(actor);
    return value?.profiles.length ? value.profiles.map(model => `${model.id === value.selectedId ? '✓ ' : ''}${model.id} · ${model.label}`).join('\n') + '\n/model <ID> 选择当前会话模型。' : '平台未提供可选择的模型配置；继续使用已部署的固定模型。';
  });
  command('model <id:string>', '选择当前会话的平台模型 ID', async (active, actor, id) => {
    if (!id || !active.selectModel) return '用法：/model <平台预配置 ID>';
    const selected = await active.selectModel(actor, id); return `当前会话模型：${selected.selectedId}`;
  });
}
