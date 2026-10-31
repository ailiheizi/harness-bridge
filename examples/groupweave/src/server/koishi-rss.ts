import type { Context, Session } from 'koishi';

/** Local pinned-plugin hook, using Koishi's existing event lifecycle. */
export const RSS_NOTIFICATION_EVENT = 'groupweave/rss-before-broadcast';
declare module 'koishi' {
  interface Events {
    'groupweave/rss-before-broadcast'(channels: readonly string[], content: string): Promise<string[]>;
  }
}

export interface RssIntegrationOptions {
  /** Current group administrator check, independent of the RSS switch. */
  authorize: (session: Session) => Promise<boolean>;
  enabled?: (session: Session) => Promise<boolean>;
  /** Check current policy for background delivery, which has no initiating user. */
  /** Observe only an already-authorized native RSS notification; no extra fetch. */
  onItem?: (platform: string, channelId: string, content: string) => Promise<void>;
  allowBroadcast?: (platform: string, channelId: string) => Promise<boolean>;
}

/** Guard the RSS command provided by the upstream Koishi plugin in native config. */
export function installRssIntegration(ctx: Context, options: RssIntegrationOptions): void {
  const integrated = new WeakSet<object>();
  // The pinned RSS patch calls this after preparing a notification and before
  // transport. Return only currently allowed targets; do not intercept unrelated
  // bot replies or depend on Cordis context prototype/shadow behavior.
  ctx.on(RSS_NOTIFICATION_EVENT, async (channels, content) => {
    const allowed: string[] = [];
    for (const target of channels) {
      const separator = target.indexOf(':');
      if (separator < 1) continue;
      const platform = target.slice(0, separator), channel = target.slice(separator + 1);
      try {
        if (options.allowBroadcast && !await options.allowBroadcast(platform, channel)) continue;
        try { await options.onItem?.(platform, channel, content); }
        catch { ctx.logger('rss-digest').warn('RSS_DIGEST_CAPTURE_FAILED'); }
        allowed.push(target);
      } catch { /* Policy unavailable: withhold this target. */ }
    }
    return allowed;
  });
  // Telegram group-admin status is checked by authorize against Telegram's
  // current group membership. Koishi's unrelated global authority level must
  // not prevent a legitimate group admin from reaching the guarded action.
  const integrate = (command: any) => {
    if (command.name !== 'rss') return;
    command.config.authority = 0;
    if (integrated.has(command)) return;
    integrated.add(command);
    // Telegram interaction/command invokes Session.execute directly, outside
    // the ordinary message middleware that flushes observed session models.
    // The upstream RSS command mutates channel.rss, so persist that diff here
    // after its action has completed and preserve its normal result.
    command.action(async (argv: any) => {
      const result = await argv.next();
      await argv.session?.channel?.$update();
      return result;
    }, true);
  };
  ctx.on('command-added', integrate);
  const existing = ctx.$commander.get('rss');
  if (existing) integrate(existing);
  ctx.before('command/execute', async argv => {
    if (argv.command?.name !== 'rss') return;
    const session = argv.session;
    // The caller rejects Telegram topics before reaching this integration. Keep
    // the check here too so a channel-only invocation cannot share subscriptions.
    if (!session?.guildId || !session.channelId || session.channelId !== session.guildId) {
      await session?.send('RSS 订阅仅支持 Telegram 群组主对话。');
      throw new Error('RSS 订阅仅支持 Telegram 群组主对话。');
    }
    if (!(await options.authorize(session))) {
      await session.send('仅当前群组管理员可以管理 RSS 订阅。');
      throw new Error('仅当前群组管理员可以管理 RSS 订阅。');
    }
    const commandOptions = argv.options as { list?: boolean; remove?: boolean } | undefined;
    if (!commandOptions?.list && !commandOptions?.remove && options.enabled && !await options.enabled(session)) {
      await session.send('本群 RSS 已关闭，仍可查看或取消已有订阅。');
      throw new Error('本群 RSS 已关闭。');
    }
  });
}
