import type { Context, Session } from 'koishi';

export interface RssIntegrationOptions {
  authorize: (session: Session) => Promise<boolean>;
}

/** Guard the RSS command provided by the upstream Koishi plugin in native config. */
export function installRssIntegration(ctx: Context, options: RssIntegrationOptions): void {
  const integrated = new WeakSet<object>();
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
  });
}
