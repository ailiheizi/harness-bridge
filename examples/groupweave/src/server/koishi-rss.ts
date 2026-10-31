import type { Context, Session } from 'koishi';

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
  // Telegram group-admin status is checked by authorize against Telegram's
  // current group membership. Koishi's unrelated global authority level must
  // not prevent a legitimate group admin from reaching the guarded action.
  const integrate = (command: any) => {
    if (command.name !== 'rss') return;
    command.config.authority = 0;
    if (integrated.has(command)) return;
    integrated.add(command);
    // Upstream closes over its plugin context and broadcasts from its existing
    // feed emitter. Adapt only that plugin scope, not global bot sends (which
    // would also suppress unrelated command replies and scheduled messages).
    const declaration: Context = Object.getOwnPropertyDescriptor(command, 'ctx')?.value ?? command.ctx;
    const scope = declaration.scope;
    const rssContext: Context = scope.ctx;
    if (options.allowBroadcast) {
      // RSS declares its command on ctx.guild(), but its emitter closes over
      // apply(ctx). A derived apply context can shadow the scope owner's
      // broadcast, so intercept those own descriptors in the same plugin scope.
      const contexts = new Set<Context>([rssContext]);
      for (let current: Context | null = declaration; current && current.scope === scope; current = Object.getPrototypeOf(current)) {
        if (Object.hasOwn(current, 'broadcast')) contexts.add(current);
      }
      const originals = [...contexts].map(context => ({ context, descriptor: Object.getOwnPropertyDescriptor(context, 'broadcast'), broadcast: context.broadcast.bind(context) }));
      for (const { context, descriptor, broadcast } of originals) {
        const wrapped = async (channels: string[], content: any, forced?: boolean) => {
          const allowed: string[] = [];
          for (const target of channels) {
            const separator = target.indexOf(':');
            if (separator < 1) continue;
            try {
              if (await options.allowBroadcast!(target.slice(0, separator), target.slice(separator + 1))) {
                // Collection failures must not suppress the existing RSS delivery.
                try { await options.onItem?.(target.slice(0, separator), target.slice(separator + 1), String(content)); }
                catch { rssContext.logger('rss-digest').warn('RSS_DIGEST_CAPTURE_FAILED'); }
                allowed.push(target);
              }
            } catch { /* Policy unavailable: do not deliver this item. */ }
          }
          return allowed.length ? broadcast(allowed, content, forced) : [];
        };
        Object.defineProperty(context, 'broadcast', { configurable: true, value: wrapped });
        rssContext.on('dispose', () => {
          if (Object.getOwnPropertyDescriptor(context, 'broadcast')?.value !== wrapped) return;
          if (descriptor) Object.defineProperty(context, 'broadcast', descriptor);
          else delete (context as any).broadcast;
        });
      }
    }
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
