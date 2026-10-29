import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import { AgentRegistry } from '@deepseek-ai/dsh-agent';
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop';
import { CommandRuntime } from '@deepseek-ai/dsh-commands';
import { LlmRuntime } from '@deepseek-ai/dsh-llm';
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand';
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools';
import { NativeInputError, isInputCode } from './links.js';
import { createKoishiCodeHost, type KoishiCodeHost } from './koishi.js';
export { NativeInputError } from './links.js';
const INPUT_ERROR_PREFIX = 'groupweave-input:';

export interface NativeRequest {
  actorId: string;
  groupId: string;
  input: string;
  options: { deduplicate: boolean; sort: boolean; maxItems: number; language?: 'zh' | 'en'; welcomeText?: string; groupTitle?: string; antiadPromptThreshold?: number; antiadActionThreshold?: number; antiadStopwords?: string[] };
  audience: 'private' | 'group';
  /** Set by the trusted server after checking current membership and feature use. */
  authorized: boolean;
}

export type NativeExecutor = ((request: NativeRequest, signal?: AbortSignal) => Promise<{
  output: string;
  modelCalls: number;
}>) & { dispose(): Promise<void> };

const TOOL_NAME = 'groupweave_link_cleaner';
const COMMAND_NAME = 'groupweave-links';

function snapshot(request: NativeRequest): Readonly<NativeRequest> {
  return Object.freeze({
    actorId: request.actorId,
    groupId: request.groupId,
    input: request.input,
    audience: request.audience,
    authorized: request.authorized,
    options: Object.freeze({
      deduplicate: request.options.deduplicate,
      sort: request.options.sort,
      maxItems: request.options.maxItems,
      language: request.options.language ?? 'zh',
    }),
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Composes existing DSH services, not a custom executor or agent loop.
 * There are no model providers, user profiles, filesystem tools or shell tools.
 * An idle native Agent supplies command/session scope; it is never prompted.
 * Native out-of-turn `ask` approval is unavailable here; this is allow/deny only.
 */
async function initializeNative(code: Pick<KoishiCodeHost, 'executeLinks'>) {
  const ctx = new Context();
  const bindings = new Map<string, {
    request: Readonly<NativeRequest>;
    /** The command may abort before this real tool invocation has drained. */
    toolExecution?: Promise<unknown>;
  }>();
  let modelCalls = 0;
  try {
    await ctx.plugin(SessionStore);
    await ctx.plugin(SessionProjectionRegistry);
    await ctx.plugin(AgentRegistry);
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false });
    await ctx.plugin(ToolRuntime, { mode: 'native', maxParallelSubCalls: 1 });
    await ctx.plugin(CommandRuntime);
    await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 });

    // Observe and fail closed if future changes accidentally introduce a model step.
    ctx.on('llm/stream', () => {
      modelCalls += 1;
      throw new Error('固定代码入口禁止调用模型。');
    });

    ctx.tools.guard((execution) => {
      if (execution.name !== TOOL_NAME) return '该入口只能运行固定链接整理能力。';
      const agent = execution.agent;
      const binding = agent === undefined ? undefined : bindings.get(String(agent.id))?.request;
      if (!binding || String(agent!.session.id) !== String(agent!.id)) return '缺少有效的原生请求绑定。';
      if (binding.authorized !== true) return '当前成员无权使用此功能。';
      if (!binding.actorId?.trim() || !binding.groupId?.trim()) return '缺少有效的群或成员身份。';
      const args = execution.arguments;
      if (!record(args) || args.actorId !== binding.actorId || args.groupId !== binding.groupId) {
        return '群或成员范围与原生请求绑定不一致。';
      }
      if (args.audience !== binding.audience || args.input !== binding.input) {
        return '结果受众或输入与原生请求绑定不一致。';
      }
      if (!record(args.options)
        || args.options.deduplicate !== binding.options.deduplicate
        || args.options.sort !== binding.options.sort
        || args.options.maxItems !== binding.options.maxItems
        || args.options.language !== binding.options.language) return '任务参数与原生请求绑定不一致。';
      return undefined;
    });

    ctx.tools.register(defineTool({
      name: TOOL_NAME,
      description: 'Extract and organize only the http(s) URLs in this request, without network or file access.',
      parameters: {
        actorId: { type: 'string', required: true },
        groupId: { type: 'string', required: true },
        audience: { type: 'string', enum: ['private', 'group'], required: true },
        input: { type: 'string', required: true },
        options: {
          type: 'object', additionalProperties: false, required: true,
          properties: {
            deduplicate: { type: 'boolean', required: true },
            sort: { type: 'boolean', required: true },
            maxItems: { type: 'integer', required: true },
            language: { type: 'string', enum: ['zh', 'en'], required: true },
          },
        },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args, execution) {
        execution.signal.throwIfAborted();
        const result = await code.executeLinks({ ...args, authorized: true }, execution.signal);
        return result.output;
      },
    }));

    ctx.commands.register({
      name: COMMAND_NAME,
      description: 'Run the installed link cleaner through the native DSH tool policy pipeline.',
      // The result is already visible to the authorised caller. Avoid duplicating input in the log.
      recordInput: false,
      async handler({ agent, rawInput, commandId, signal }) {
        const args: unknown = JSON.parse(rawInput);
        const toolExecution = ctx.tools.execute({
          name: TOOL_NAME,
          callId: ToolCallId(String(commandId)),
          arguments: args,
          agent,
          signal,
        });
        const binding = bindings.get(String(agent.id));
        if (binding) binding.toolExecution = toolExecution;
        const result = await toolExecution;
        if (result.isError) {
          const info = result.error.info;
          if (info?.name === 'NativeInputError' && isInputCode(info.code)) {
            return { kind: 'error', text: `${INPUT_ERROR_PREFIX}${info.code}` };
          }
          return { kind: 'error', text: result.error.message };
        }
        if (typeof result.value !== 'string') return { kind: 'error', text: '原生工具未返回有效文本。' };
        return { kind: 'success', text: result.value };
      },
    });

    return { ctx, bindings, modelCalls: () => modelCalls };
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
}

/** Trusted server calls this with identity and authorisation from its own session. */
export function createNativeExecutor(sharedCode?: KoishiCodeHost): NativeExecutor {
  const code = sharedCode ?? createKoishiCodeHost();
  let native: ReturnType<typeof initializeNative> | undefined;
  let closed = false;
  const shutdown = new AbortController();
  const active = new Set<Promise<{ output: string; modelCalls: number }>>();
  const perform = async (request: NativeRequest, callerSignal?: AbortSignal) => {
    if (closed) throw new Error('原生执行入口已关闭。');
    const signal = callerSignal ? AbortSignal.any([callerSignal, shutdown.signal]) : shutdown.signal;
    signal.throwIfAborted();
    const binding = snapshot(request);
    const runtime = await (native ??= initializeNative(code));
    if (closed) throw new Error('原生执行入口已关闭。');
    signal.throwIfAborted();
    const handle = await runtime.ctx.agents.create({
      sessionId: SessionId(`groupweave-${randomUUID()}`),
      // No provider/model and no persistence/profile/HOME integration is mounted.
      agentOptions: {},
      signal,
    });
    const agent = handle.agent;
    const owned = { request: binding, toolExecution: undefined as Promise<unknown> | undefined };
    runtime.bindings.set(String(agent.id), owned);
    try {
      const { authorized: _authorized, ...args } = binding;
      const result = await runtime.ctx.commands.execute(
        agent, `/${COMMAND_NAME} ${JSON.stringify(args)}`, [], signal,
      );
      if (!result) throw new Error('原生固定命令未被发现。');
      signal.throwIfAborted();
      if (runtime.modelCalls() !== 0) throw new Error('固定代码入口发生了不允许的模型调用。');
      if (result.result.kind === 'error') {
        const text = result.result.text;
        const code = text.startsWith(INPUT_ERROR_PREFIX) ? text.slice(INPUT_ERROR_PREFIX.length) : undefined;
        if (isInputCode(code)) throw new NativeInputError(code);
        throw new Error(text);
      }
      return { output: result.result.text ?? '', modelCalls: runtime.modelCalls() };
    } finally {
      // Native commands.withAbort can settle before a handler that ignores the
      // signal. Keep the scope and host's active slot until the real tool drains.
      try { await owned.toolExecution?.catch(() => undefined); }
      finally {
        runtime.bindings.delete(String(agent.id));
        await handle.dispose();
      }
    }
  };
  const execute = (request: NativeRequest, signal?: AbortSignal) => {
    const pending = perform(request, signal);
    active.add(pending);
    void pending.finally(() => active.delete(pending)).catch(() => undefined);
    return pending;
  };
  return Object.assign(execute, {
    async dispose() {
      closed = true;
      shutdown.abort(new Error('原生执行入口已关闭。'));
      // Request cancellation does not prove a tool has stopped. Do not destroy
      // its native scope while real work is still pending.
      await Promise.allSettled([...active]);
      if (native) await (await native).ctx.fiber.dispose();
      if (!sharedCode) await code.dispose();
    },
  });
}
