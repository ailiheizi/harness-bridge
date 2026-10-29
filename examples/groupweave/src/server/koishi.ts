import { createRequire } from 'node:module';
import type { Argv, Context } from 'koishi';
import type { NativeRequest } from './native.js';
import { NativeInputError } from './links.js';
import * as links from './koishi-plugins/links.js';
import * as welcome from './koishi-plugins/welcome.js';

// The published native plugins use CommonJS. Use that same core instance and
// avoid importing Koishi's optional ESM Loader (no server or loader is started).
const require = createRequire(import.meta.url);
const { App, Bot } = require('@koishijs/core') as typeof import('koishi');
const echo = require('@koishijs/plugin-echo') as typeof import('@koishijs/plugin-echo');

type CodeResult = { output: string; modelCalls: number };
type Capability = 'links' | 'echo' | 'welcome';
type Binding = {
  request: Readonly<NativeRequest>;
  capability: Capability;
  signal: AbortSignal;
  error?: unknown;
};

/** An in-process Bot supplies native Koishi Sessions, with no TG consumer or IO. */
class CodeBot extends Bot<Context> {
  private readonly ownedBots: Context['bots'];
  constructor(ctx: Context) {
    super(ctx, {}, 'groupweave');
    this.selfId = 'groupweave-code';
    this.ownedBots = ctx.bots;
  }
  override async start() {}
  override async stop() {}
  override async dispose() {
    // Plugin association may expose another proxy for this Bot as well.
    const index = this.ownedBots.findIndex(bot => bot.sn === this.sn);
    if (index >= 0) this.ownedBots.splice(index, 1);
  }
  override async sendMessage(): Promise<string[]> { throw new Error('代码能力不得直接发送消息。'); }
  override async sendPrivateMessage(): Promise<string[]> { throw new Error('代码能力不得直接发送消息。'); }
}

function snapshot(request: NativeRequest, capability: Capability): Readonly<NativeRequest> {
  return Object.freeze({
    actorId: request.actorId, groupId: request.groupId, input: request.input,
    audience: request.audience, authorized: request.authorized,
    options: Object.freeze({
      deduplicate: request.options.deduplicate, sort: request.options.sort,
      maxItems: request.options.maxItems, language: request.options.language ?? 'zh',
      ...(capability === 'welcome' ? {
        welcomeText: request.options.welcomeText, groupTitle: request.options.groupTitle,
      } : {}),
    }),
  });
}

export interface KoishiCodeHost {
  executeLinks(request: NativeRequest, signal?: AbortSignal): Promise<CodeResult>;
  executeEcho(request: NativeRequest, signal?: AbortSignal): Promise<CodeResult>;
  executeWelcome(request: NativeRequest, signal?: AbortSignal): Promise<CodeResult>;
  dispose(): Promise<void>;
}

/** Explicit capabilities hosted by native Koishi plugins and commands. */
export function createKoishiCodeHost(): KoishiCodeHost {
  let closed = false;
  const shutdown = new AbortController();
  const active = new Set<Promise<CodeResult>>();
  let runtime: ReturnType<typeof initialize> | undefined;
  let closing: Promise<void> | undefined;

  async function initialize() {
    const app = new App();
    // Koishi associates Sessions with plugin contexts through proxies, so a
    // WeakMap keyed by the proxy is unsuitable. These host-generated ids live
    // only for the real command invocation and are deleted in finally.
    const bindings = new Map<number, Binding>();
    const scoped = app.intersect(session => {
      const binding = bindings.get(session.id);
      return !!binding && !closed && !binding.signal.aborted
        && binding.request.authorized === true
        && session.platform === 'groupweave'
        && session.guildId === binding.request.groupId
        && session.channelId === binding.request.groupId
        && session.userId === binding.request.actorId;
    });
    scoped.plugin(echo, {});
    scoped.plugin(links, session => bindings.get(session.id)!);
    scoped.plugin(welcome, session => bindings.get(session.id)!);
    app.before('command/execute', (argv: Argv) => {
      const binding = bindings.get(argv.session!.id);
      if (!binding) throw new Error('缺少有效的群与成员原生请求绑定。');
      binding.signal.throwIfAborted();
      if (!scoped.filter(argv.session!)) throw new Error('缺少有效的群与成员原生请求绑定。');
      const expected = binding.capability === 'links' ? 'groupweave-links'
        : binding.capability === 'welcome' ? 'groupweave-welcome' : 'echo';
      if (argv.command?.name !== expected || Object.keys(argv.options ?? {}).length !== 0
        || (binding.capability === 'echo'
          ? argv.args?.length !== 1 || argv.args[0] !== binding.request.input
          : (argv.args?.length ?? 0) !== 0)) throw new Error('原生命令与可信请求绑定不一致。');
    });
    app.plugin(CodeBot);
    try {
      await app.start();
      const bot = app.bots.find(bot => bot.adapterName === 'groupweave');
      if (!bot) throw new Error('Koishi 原生代码会话未初始化。');
      return { app, bot, scoped, bindings };
    } catch (error) {
      await app.stop();
      throw error;
    }
  }

  async function perform(capability: Capability, request: NativeRequest, callerSignal?: AbortSignal): Promise<CodeResult> {
    if (closed) throw new Error('Koishi 代码入口已关闭。');
    const signal = callerSignal ? AbortSignal.any([callerSignal, shutdown.signal]) : shutdown.signal;
    signal.throwIfAborted();
    const trusted = snapshot(request, capability);
    if (trusted.authorized !== true) throw new Error('当前成员无权使用此功能。');
    if (!trusted.actorId?.trim() || !trusted.groupId?.trim()) throw new Error('缺少有效的群或成员身份。');
    if (trusted.audience !== 'private' && trusted.audience !== 'group') throw new Error('无效的结果受众。');
    if (typeof trusted.input !== 'string' || !trusted.input.trim()) throw new Error('任务输入必须为非空文本。');
    if (trusted.input.length > 50_000) throw new NativeInputError('INPUT_LIMIT');
    const host = await (runtime ??= initialize());
    signal.throwIfAborted();
    if (closed) throw new Error('Koishi 代码入口已关闭。');
    const session = host.bot.session({
      guild: { id: trusted.groupId }, channel: { id: trusted.groupId, type: 0 },
      user: { id: trusted.actorId }, message: { elements: [] },
    });
    const binding: Binding = { request: trusted, capability, signal };
    host.bindings.set(session.id, binding);
    try {
      // The input is a single already-bound argument, never a command line.
      // `true` obtains the ordinary native result without session.send().
      const command = capability === 'links' ? 'groupweave-links'
        : capability === 'welcome' ? 'groupweave-welcome' : 'echo';
      const result = await session.execute({
        name: command, args: capability === 'echo' ? [trusted.input] : [], options: {}, source: command,
      }, true);
      signal.throwIfAborted();
      if (binding.error !== undefined) throw binding.error;
      if (!host.scoped.filter(session) || result.length === 0) throw new Error('原生命令没有返回有效结果。');
      // These capabilities return text. An unexpected image/component or
      // other fragment must not gain a new IO path through result rendering.
      if (result.some(element => element.type !== 'text' || typeof element.attrs.content !== 'string')) {
        throw new Error('原生命令返回了未开放的消息类型。');
      }
      const output = result.map(element => element.attrs.content as string).join('');
      if (!output || Buffer.byteLength(output) > 200_000) throw new Error('原生命令结果超出文本输出限制。');
      return { output, modelCalls: 0 };
    } finally {
      host.bindings.delete(session.id);
    }
  }

  function execute(capability: Capability, request: NativeRequest, signal?: AbortSignal) {
    const pending = perform(capability, request, signal);
    active.add(pending);
    void pending.finally(() => active.delete(pending)).catch(() => undefined);
    return pending;
  }

  return {
    executeLinks: (request, signal) => execute('links', request, signal),
    executeEcho: (request, signal) => execute('echo', request, signal),
    executeWelcome: (request, signal) => execute('welcome', request, signal),
    dispose() {
      return closing ??= (async () => {
        closed = true;
        shutdown.abort(new Error('Koishi 代码入口已关闭。'));
        await Promise.allSettled([...active]);
        if (runtime) {
          const host = await runtime;
          host.bindings.clear();
          await host.app.stop();
        }
      })();
    },
  };
}
