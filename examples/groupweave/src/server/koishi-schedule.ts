import { createRequire } from 'node:module';
import type { Context, Session } from 'koishi';
import type {} from 'koishi-plugin-schedule';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const { Time, h } = require('@koishijs/core') as typeof import('koishi');
const DAY = '1d';
const MAX_TEXT = 3000;
const EDIT_SAFETY_WINDOW_MS = 60_000;
const DELIVERY_COMMAND = 'groupweave-reminder-deliver';
export const RSS_DIGEST_DELIVERY = 'groupweave-rss-digest-deliver';
export interface RssDigestSchedules {
  create(session: Session, planId: string, time: string): Promise<number>;
  remove(botSid: string, channelId: string, scheduleId: number, planId: string): Promise<void>;
}

export interface ScheduleIntegrationOptions {
  /** Must verify the current registered group and current Telegram admin role. */
  authorize(session: Session): Promise<boolean>;
  authorizeLinks?(session: Session): Promise<boolean>;
  invokeLinks?(session: Session, input: string, idempotencyKey: string): Promise<void>;
}

type ScheduleRow = {
  id: number;
  assignee: string;
  time: Date;
  interval: number;
  command: string;
  lastCall?: Date;
  event: { channel?: { id?: string }; _data?: { message?: { text?: string } } };
};

type CreateRequest = { mode: 'create'; date: string; interval?: string; text: string; link?: boolean };
type ReminderRequest = { mode: 'list' } | { mode: 'remove'; id: number } | { mode: 'pause'; id: number } | { mode: 'resume'; id: number }
  | { mode: 'edit'; id: number; replacement: CreateRequest } | CreateRequest;
type PreparedSchedule = { time: Date; interval: number; dateArgument: string; command: string; options: Record<string, unknown> };

function isGroupSession(session: Session): boolean {
  return session.platform === 'telegram'
    && (session.event.channel?.type === 0 || session.event.channel?.type === 2)
    && !!session.channelId;
}

function isCurrentBotReminderCommand(session: Session, text: unknown): boolean {
  if (typeof text !== 'string') return false;
  const match = /^\/?remind(?:@([A-Za-z0-9_]+))?\s/iu.exec(text.trim());
  if (!match) return false;
  if (!match[1]) return true;
  const username = (session as Session & { bot?: { user?: { name?: string } } }).bot?.user?.name;
  return Boolean(username && match[1].toLocaleLowerCase('en-US') === username.toLocaleLowerCase('en-US'));
}

function scheduledDelivery(text: string): string | undefined {
  if (!text.trim() || text.length > MAX_TEXT) return;
  return `${DELIVERY_COMMAND} x${Buffer.from(text, 'utf8').toString('base64url')}`;
}

function scheduledLinkDelivery(text: string): string | undefined {
  if (!text.trim() || text.length > MAX_TEXT) return;
  return `${DELIVERY_COMMAND} l${randomUUID().replaceAll('-', '')}_${Buffer.from(text, 'utf8').toString('base64url')}`;
}

function parseScheduleSpec(value: string): CreateRequest | undefined {
  const every = /^every\s+(\S+)\s+([\s\S]+)$/.exec(value);
  if (every) return { mode: 'create', date: 'now', interval: every[1], text: every[2] };
  const daily = /^daily\s+(\d{1,2}:\d{2})\s+([\s\S]+)$/.exec(value);
  if (daily) return { mode: 'create', date: daily[1], interval: DAY, text: daily[2] };
  const once = /^(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?|\d{1,2}:\d{2})\s+([\s\S]+)$/.exec(value);
  if (once) return { mode: 'create', date: once[1], text: once[2] };
}

function parseRequest(input: string): ReminderRequest | undefined {
  const value = input.trim();
  if (value === 'list') return { mode: 'list' };
  const action = /^(remove|pause|resume)\s+(\d+)$/.exec(value);
    if (action && Number.isSafeInteger(Number(action[2])) && Number(action[2]) > 0) {
      const id = Number(action[2]);
      if (action[1] === 'remove') return { mode: 'remove', id };
      if (action[1] === 'pause') return { mode: 'pause', id };
      return { mode: 'resume', id };
    }
  const edit = /^edit\s+(\d+)\s+([\s\S]+)$/.exec(value);
  if (edit && Number.isSafeInteger(Number(edit[1])) && Number(edit[1]) > 0) {
    const replacement = parseScheduleSpec(edit[2]);
    if (replacement) return { mode: 'edit', id: Number(edit[1]), replacement };
  }
  const links = /^links\s+([\s\S]+)$/.exec(value);
  if (links) {
    const request = parseScheduleSpec(links[1]);
    if (request) return { ...request, link: true };
  }
  return parseScheduleSpec(value);
}

function prepareSchedule(request: CreateRequest, now = Date.now()): { schedule?: PreparedSchedule; error?: string } {
  const command = request.link ? scheduledLinkDelivery(request.text) : scheduledDelivery(request.text);
  if (!command) return { error: `提醒文字必须为 1 到 ${MAX_TEXT} 个字符。` };
  const interval = request.interval ? Time.parseTime(request.interval) : 0;
  if (request.interval && !interval) return { error: '间隔格式无效，请使用例如 10m、2h 或 1d。' };
  if (request.date !== 'now' && /^\d{1,2}:\d{2}$/.test(request.date)) {
    const [hour, minute] = request.date.split(':').map(Number);
    if (hour > 23 || minute > 59) return { error: '时间格式无效，请使用 00:00 到 23:59。' };
  }
  const time = request.date === 'now' ? new Date(now) : Time.parseDate(request.date);
  if (Number.isNaN(+time)) return { error: '时间格式无效，请使用 HH:mm 或 YYYY-MM-DD HH:mm。' };
  if (!interval && +time <= now) return { error: '一次性提醒时间必须在未来。' };
  if (interval === Time.parseTime(DAY) && +time <= now) time.setDate(time.getDate() + 1);
  const dateArgument = `${time.getFullYear()}-${Time.toDigits(time.getMonth() + 1)}-${Time.toDigits(time.getDate())} ${Time.toDigits(time.getHours())}:${Time.toDigits(time.getMinutes())}:${Time.toDigits(time.getSeconds())}`;
  const options: Record<string, unknown> = { rest: command };
  if (request.interval) options.interval = request.interval;
  return { schedule: { time, interval, dateArgument, command, options } };
}

function nextFireTime(time: Date, interval: number, now: number, lastCall?: Date): number {
  const timestamp = +time;
  if (!interval) return timestamp;
  const next = timestamp > now ? timestamp : now + (interval - (now - timestamp) % interval);
  // The upstream plugin catches up immediately when it detects a missed
  // interval. Treat that as due now so an edit cannot race that delivery.
  if (lastCall && next - interval > +lastCall) return now;
  return next;
}

function resultText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(item => {
    if (item && typeof item === 'object' && 'attrs' in item) {
      const content = (item as { attrs?: { content?: unknown } }).attrs?.content;
      if (typeof content === 'string') return content;
    }
    return String(item);
  }).join('\n');
  return value == null ? '' : String(value);
}

/** Add the thin group-admin command surface around koishi-plugin-schedule. */
export function installScheduleIntegration(ctx: Context, options: ScheduleIntegrationOptions): RssDigestSchedules {
  let ready: RssDigestSchedules | undefined;
  let installed = false;
  const tryInstall = () => {
    if (installed) return;
    const commands = (ctx.$commander as unknown as { _commandList?: any[] })._commandList ?? [];
    if (!commands.some(command => command.name === 'schedule')) return;
    installed = true;
    ctx.inject(['database'], (injected: Context) => { ready = installReadyIntegration(injected, options); });
  };
  // Loader setup runs before YAML plugins; attach to the native command
  // registration event instead of probing or starting a second plugin copy.
  ctx.on('command-added', tryInstall);
  tryInstall();
  return {
    create: (session, id, time) => { if (!ready) throw new Error('原生 schedule 尚未就绪。'); return ready.create(session, id, time); },
    remove: (sid, channel, schedule, id) => { if (!ready) throw new Error('原生 schedule 尚未就绪。'); return ready.remove(sid, channel, schedule, id); },
  };
}

function installReadyIntegration(ctx: Context, options: ScheduleIntegrationOptions): RssDigestSchedules {
  const { authorize } = options;
  (ctx.model as any).extend('groupweave_paused_schedule', {
    scheduleId: 'unsigned', assignee: 'string', channelId: 'string', time: 'timestamp',
    interval: 'unsigned', command: 'text', event: 'json', lastCall: 'timestamp', pausedAt: 'timestamp',
  }, { primary: 'scheduleId' });
  const commands = (ctx.$commander as unknown as { _commandList?: any[] })._commandList ?? [];
  const scheduleCommand = commands.find(command => command.name === 'schedule');
  if (!scheduleCommand) throw new Error('原生 schedule 命令未就绪。');
  let mutationBusy = false;

  // Add permission checks for the native command names. These checks grant
  // access only to the internal schedule call with current group-admin proof.
  const nativeCalls = new Set<number>();
  const nativeAllowed = async (session: Partial<Session>) => {
    const current = session as Session;
    return nativeCalls.has(current.id) && isGroupSession(current) && await authorize(current);
  };
  ctx.permissions.provide('command:schedule', async (_data, session) => nativeAllowed(session));
  ctx.permissions.provide('command:schedule:option:interval', async (_data, session) => nativeAllowed(session));

  ctx.before('command/execute', async (argv: any) => {
    const session = argv.session as Session | undefined;
    const name = argv.command?.name;
    if (!session || !name) return;
    if (name === 'schedule') {
      if (!nativeCalls.has(session.id) || !isGroupSession(session) || !await authorize(session)) {
        throw new Error('此操作需要当前已注册群的群管理员身份。');
      }
    } else if (name === DELIVERY_COMMAND) {
      const raw = (session.event as any)._data?.message?.text;
      // Scheduled commands reuse the original event as their execution
      // context. Recheck group/admin status on every native delivery.
      if (!isCurrentBotReminderCommand(session, raw)
        || !isGroupSession(session) || !await authorize(session)) {
        throw new Error('当前群或管理员权限已失效，提醒未发送。');
      }
    }
  });

  const delivery = ctx.command(`${DELIVERY_COMMAND} <payload:string>`, { authority: 0, slash: false, checkUnknown: true });
  (delivery.config as any).hidden = true;
  delivery
    .action(async ({ session }, payload = '') => {
      const raw = (session?.event as any)?._data?.message?.text;
      if (!session || !isCurrentBotReminderCommand(session, raw)
        || !isGroupSession(session) || !await authorize(session)) return '';
      if (/^x[A-Za-z0-9_-]+$/.test(payload)) {
        const encoded = payload.slice(1);
        const text = Buffer.from(encoded, 'base64url').toString('utf8');
        if (!text.trim() || text.length > MAX_TEXT || Buffer.from(text, 'utf8').toString('base64url') !== encoded) return '';
        await session.send(h.text(text));
        return '';
      }
      const link = /^l([a-f0-9]{32})_([A-Za-z0-9_-]+)$/.exec(payload);
      if (!link || !options.authorizeLinks || !options.invokeLinks || !await options.authorizeLinks(session)) return '';
      const encoded = link[2];
      const input = Buffer.from(encoded, 'base64url').toString('utf8');
      if (!input.trim() || input.length > MAX_TEXT || Buffer.from(input, 'utf8').toString('base64url') !== encoded) return '';
      const occurrence = Math.floor(Date.now() / 60_000);
      await options.invokeLinks(session, input, `remind-links:${link[1]}:${occurrence}`);
      return '';
    });

  const runNative = async (session: Session, options: Record<string, unknown>, args: string[] = []) => {
    nativeCalls.add(session.id);
    try {
      return await session.execute({ name: 'schedule', args, options, source: 'schedule' }, true);
    } finally {
      nativeCalls.delete(session.id);
    }
  };

  ctx.command('remind <input:text>', { authority: 0, checkUnknown: true })
    .action(async ({ session }, input = '') => {
      if (!session || !isGroupSession(session)) return '提醒只能在 Telegram 群组中使用。';
      const raw = (session.event as any)._data?.message?.text;
      if (!isCurrentBotReminderCommand(session, raw)) return '命令目标机器人不匹配或原始命令无效。';
      if (!await authorize(session)) return '此操作需要当前已注册群的群管理员身份。';
      const request = parseRequest(input);
      if (!request) return '用法：/remind <时间> <文字>、/remind daily <HH:mm> <文字>、/remind every <间隔> <文字>、/remind links <时间规则> <链接>、list、remove|pause|resume <编号>、edit <编号> <新时间规则> <文字>。';
      const database = ctx.database as any;
      if (request.mode === 'list') {
        const rows = await database.get('schedule', { assignee: [session.sid] }) as ScheduleRow[];
        const current = rows.filter(row => String(row.event?.channel?.id) === session.channelId);
        const paused = await database.get('groupweave_paused_schedule', { assignee: [session.sid], channelId: session.channelId }) as Array<ScheduleRow & { scheduleId: number }>;
        if (!current.length && !paused.length) return '本群没有提醒。';
        return h.text([...current.map(row => {
          const encoded = new RegExp(`^${DELIVERY_COMMAND} x([A-Za-z0-9_-]+)$`).exec(row.command);
          const link = new RegExp(`^${DELIVERY_COMMAND} l[a-f0-9]{32}_([A-Za-z0-9_-]+)$`).exec(row.command);
          let text = link ? '定时链接整理' : '无法读取提醒文字';
          if (encoded) {
            const decoded = Buffer.from(encoded[1], 'base64url').toString('utf8');
            if (Buffer.from(decoded, 'utf8').toString('base64url') === encoded[1]) text = decoded;
          }
          const when = row.time.toLocaleString();
          return `${row.id}. ${when}${row.interval ? `（每隔 ${Time.format(row.interval)}）` : ''}：${text}`;
        }), ...paused.map(row => {
          const encoded = new RegExp(`^${DELIVERY_COMMAND} x([A-Za-z0-9_-]+)$`).exec(row.command);
          const link = new RegExp(`^${DELIVERY_COMMAND} l[a-f0-9]{32}_([A-Za-z0-9_-]+)$`).exec(row.command);
          let text = link ? '定时链接整理' : '无法读取提醒文字';
          if (encoded) {
            const decoded = Buffer.from(encoded[1], 'base64url').toString('utf8');
            if (Buffer.from(decoded, 'utf8').toString('base64url') === encoded[1]) text = decoded;
          }
          return `${row.scheduleId}. 已暂停（原定 ${row.time.toLocaleString()}）：${text}；用 /remind resume ${row.scheduleId} 恢复`;
        })].join('\n'));
      }
      if (mutationBusy) return '提醒正在修改，请稍后重试。';
      mutationBusy = true;
      try {
        if (request.mode === 'remove') {
          const rows = await database.get('schedule', [request.id]) as ScheduleRow[];
          const row = rows[0];
          if (!row) {
            const paused = await database.get('groupweave_paused_schedule', [request.id]) as any[];
            if (paused[0]?.assignee === session.sid && paused[0]?.channelId === session.channelId) {
              await database.remove('groupweave_paused_schedule', [request.id]);
              return `已删除已暂停的提醒 ${request.id}。`;
            }
          }
          if (!row || row.assignee !== session.sid || String(row.event?.channel?.id) !== session.channelId) {
            return '找不到本群的这个提醒。';
          }
          const output = resultText(await runNative(session, { delete: request.id }));
          return `${output}\n已移除后续提醒；若本次提醒已进入发送流程，仍可能收到。`;
        }
        if (request.mode === 'pause') {
          const rows = await database.get('schedule', [request.id]) as ScheduleRow[];
          const row = rows[0];
          if (!row || row.assignee !== session.sid || String(row.event?.channel?.id) !== session.channelId
            || !row.command.startsWith(`${DELIVERY_COMMAND} `)) return '找不到本群可暂停的提醒。';
          await database.create('groupweave_paused_schedule', { scheduleId: row.id, assignee: row.assignee,
            channelId: session.channelId, time: row.time, interval: row.interval, command: row.command,
            event: row.event, lastCall: row.lastCall, pausedAt: new Date() });
          try { await runNative(session, { delete: row.id }); } catch { /* verify native deletion below */ }
          const active = await database.get('schedule', [row.id]) as ScheduleRow[];
          if (active.length) {
            await database.remove('groupweave_paused_schedule', [row.id]);
            return '原提醒仍在运行，暂停未完成。';
          }
          return `提醒 ${row.id} 已暂停；后续触发已停止，若本次提醒已进入发送流程，仍可能收到。`;
        }
        if (request.mode === 'resume') {
          const paused = await database.get('groupweave_paused_schedule', [request.id]) as any[];
          const old = paused[0] as (ScheduleRow & { scheduleId: number; channelId: string }) | undefined;
          if (!old || old.assignee !== session.sid || old.channelId !== session.channelId) return '找不到本群已暂停的提醒。';
          if (!old.interval && +old.time <= Date.now() + EDIT_SAFETY_WINDOW_MS) {
            return '这条一次性提醒的时间已过或在 1 分钟内；请使用新的未来时间重新创建。';
          }
          const linkMatch = new RegExp(`^${DELIVERY_COMMAND} l[a-f0-9]{32}_([A-Za-z0-9_-]+)$`).exec(old.command);
          const normalMatch = new RegExp(`^${DELIVERY_COMMAND} x([A-Za-z0-9_-]+)$`).exec(old.command);
          const encoded = linkMatch?.[1] ?? normalMatch?.[1];
          if (!encoded) return '暂停记录格式无效，未恢复。';
          const text = Buffer.from(encoded, 'base64url').toString('utf8');
          if (!text.trim() || text.length > MAX_TEXT || Buffer.from(text, 'utf8').toString('base64url') !== encoded) return '暂停记录格式无效，未恢复。';
          let resumeTime = +old.time;
          if (old.interval) {
            resumeTime = nextFireTime(old.time, old.interval, Date.now(), old.lastCall);
            if (resumeTime <= Date.now() + EDIT_SAFETY_WINDOW_MS) resumeTime += old.interval;
          }
          const resumeDate = new Date(resumeTime);
          const date = `${resumeDate.getFullYear()}-${Time.toDigits(resumeDate.getMonth() + 1)}-${Time.toDigits(resumeDate.getDate())} ${Time.toDigits(resumeDate.getHours())}:${Time.toDigits(resumeDate.getMinutes())}:${Time.toDigits(resumeDate.getSeconds())}`;
          const resumeRequest: CreateRequest = { mode: 'create', date, ...(old.interval ? { interval: Time.format(old.interval) } : {}), text, link: !!linkMatch };
          if (resumeRequest.link && (!options.authorizeLinks || !options.invokeLinks || !await options.authorizeLinks(session))) return '本群当前未启用链接整理，无法恢复。';
          const prepared = prepareSchedule(resumeRequest);
          if (!prepared.schedule) return prepared.error ?? '无法恢复。';
          const before = await database.get('schedule', { assignee: [session.sid] }) as ScheduleRow[];
          try { await runNative(session, prepared.schedule.options, [prepared.schedule.dateArgument]); } catch { /* verify below */ }
          const after = await database.get('schedule', { assignee: [session.sid] }) as ScheduleRow[];
          const prior = new Set(before.map(row => row.id));
          const created = after.filter(row => !prior.has(row.id) && row.assignee === session.sid
            && String(row.event?.channel?.id) === session.channelId && row.command === prepared.schedule!.command);
          if (created.length !== 1) return '恢复失败，暂停记录仍保留；请稍后重试。';
          const active = created[0];
          try { await database.remove('groupweave_paused_schedule', [old.scheduleId]); }
          catch {
            try { await runNative(session, { delete: active.id }); } catch { /* report both IDs */ }
            const remains = await database.get('schedule', [active.id]) as ScheduleRow[];
            return remains.length ? `恢复记录未能清理；新编号 ${active.id} 仍存在，请用 /remind list 检查。` : '恢复记录未能清理；原暂停记录仍保留。';
          }
          return `提醒已恢复。旧编号：${old.scheduleId}；新编号：${active.id}。`;
        }
        let createRequest = request.mode === 'edit' ? request.replacement : request;
        let oldRow: ScheduleRow | undefined;
        let candidate: PreparedSchedule;
        if (request.mode === 'edit') {
          const rows = await database.get('schedule', [request.id]) as ScheduleRow[];
          oldRow = rows[0];
          if (!oldRow || oldRow.assignee !== session.sid || String(oldRow.event?.channel?.id) !== session.channelId) {
            return '找不到本群的这个提醒。';
          }
          if (oldRow!.command.includes(' l')) createRequest = { ...createRequest, link: true };
        }
        if (createRequest.link && (!options.authorizeLinks || !options.invokeLinks || !await options.authorizeLinks(session))) {
          return '本群当前未启用链接整理，无法安排该定时功能。';
        }
        const prepared = prepareSchedule(createRequest);
        if (!prepared.schedule) return prepared.error ?? '时间格式无效。';
        candidate = prepared.schedule;
        if (request.mode === 'edit') {
          const now = Date.now();
          if (nextFireTime(oldRow!.time, oldRow!.interval, now, oldRow!.lastCall) <= now + EDIT_SAFETY_WINDOW_MS) {
            return '原提醒将在 1 分钟内触发，暂不支持此时编辑；请稍后重新安排。';
          }
          if (nextFireTime(candidate.time, candidate.interval, now) <= now + EDIT_SAFETY_WINDOW_MS) {
            return '新提醒首次触发时间必须晚于 1 分钟后，请调整时间或间隔再试。';
          }
        }

        const rowsBefore = await database.get('schedule', { assignee: [session.sid] }) as ScheduleRow[];
        let nativeOutput: unknown;
        let createFailed = false;
        try {
          nativeOutput = await runNative(session, candidate.options, [candidate.dateArgument]);
        } catch {
          createFailed = true;
        }

        const rowsAfter = await database.get('schedule', { assignee: [session.sid] }) as ScheduleRow[];
        const priorIds = new Set(rowsBefore.map(row => row.id));
        const createdRows = rowsAfter.filter(row => !priorIds.has(row.id)
          && row.assignee === session.sid
          && String(row.event?.channel?.id) === session.channelId
          && row.command === candidate.command
          && row.interval === candidate.interval);
        if (request.mode !== 'edit') {
          if (createdRows.length !== 1) {
            const output = resultText(nativeOutput);
            if (createFailed) return '提醒创建失败。';
            if (/日程已创建，编号为\s*\d+/u.test(output)) return '未能确认提醒已保存，请使用 /remind list 检查。';
            return output || '提醒创建失败。';
          }
          const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || '本地时区';
          return h.text(`${resultText(nativeOutput)}\n时间：${candidate.time.toLocaleString()}（${timezone}）\n内容：${createRequest.text}`);
        }
        if (createdRows.length !== 1) {
          return createFailed ? '新提醒创建失败，原提醒未更改。'
            : resultText(nativeOutput) || '未能确认新提醒已创建，原提醒未更改。';
        }
        const newRow = createdRows[0];
        const rollbackNew = async () => {
          try { await runNative(session, { delete: newRow.id }); } catch { /* Report below if the row remains. */ }
          const remaining = await database.get('schedule', [newRow.id]) as ScheduleRow[];
          return remaining.length === 0;
        };
        const failAndRollback = async (message: string) => {
          if (await rollbackNew()) return message;
          return `${message} 新提醒编号 ${newRow.id} 仍存在，请用 /remind list 检查后处理。`;
        };

        const now = Date.now();
        if (nextFireTime(oldRow!.time, oldRow!.interval, now, oldRow!.lastCall) <= now + EDIT_SAFETY_WINDOW_MS
          || nextFireTime(newRow.time, newRow.interval, now) <= now + EDIT_SAFETY_WINDOW_MS) {
          return await failAndRollback('修改已停止，原提醒保留。提醒在 1 分钟内触发时不执行编辑。');
        }
        const currentOldRows = await database.get('schedule', [oldRow!.id]) as ScheduleRow[];
        if (!currentOldRows.length) return await failAndRollback('原提醒已不存在，新提醒已尝试撤销。');

        let deleteFailed = false;
        try { await runNative(session, { delete: oldRow!.id }); } catch { deleteFailed = true; }
        const remainingOldRows = await database.get('schedule', [oldRow!.id]) as ScheduleRow[];
        if (remainingOldRows.length) {
          return await failAndRollback(deleteFailed
            ? '删除原提醒失败，原提醒仍保留。'
            : '未能确认原提醒已删除，原提醒仍保留。');
        }
        return h.text(`提醒已修改。原编号：${oldRow!.id}；新编号：${newRow.id}。\n时间：${newRow.time.toLocaleString()}\n内容：${createRequest.text}`);
      } finally {
        mutationBusy = false;
      }
    });
  // Specific adapter for the preinstalled RSS digest. The upstream plugin still
  // owns timers, schedule rows and restart reconstruction; no new scheduler.
  return {
    async create(session, planId, time) {
      if (!/^[a-f0-9-]{36}$/.test(planId) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) || !await authorize(session)) throw new Error('摘要日程未授权或时间无效。');
      const prepared = prepareSchedule({ mode: 'create', date: time, interval: DAY, text: 'RSS digest' }).schedule!;
      const command = `${RSS_DIGEST_DELIVERY} ${planId}`;
      const before = await ctx.database.get('schedule', { assignee: [session.sid] }) as ScheduleRow[];
      await runNative(session, { ...prepared.options, rest: command }, [prepared.dateArgument]);
      const prior = new Set(before.map(row => row.id));
      const created = (await ctx.database.get('schedule', { assignee: [session.sid] }) as ScheduleRow[]).filter(row => !prior.has(row.id) && row.command === command && String(row.event?.channel?.id) === session.channelId);
      if (created.length !== 1) throw new Error('未能确认摘要日程保存。');
      return created[0].id;
    },
    async remove(botSid, channelId, scheduleId, planId) {
      const row = (await ctx.database.get('schedule', [scheduleId]) as ScheduleRow[])[0];
      if (row?.assignee === botSid && String(row.event?.channel?.id) === channelId && row.command === `${RSS_DIGEST_DELIVERY} ${planId}`) await ctx.database.remove('schedule', [scheduleId]);
    },
  };

}
