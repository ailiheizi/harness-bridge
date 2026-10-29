import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { SandboxModelAccountingReader } from './sandbox-ai.js';

const ROUTE = '/v1/chat/completions';
const MAX_BODY_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_SSE_EVENT_BYTES = 64 * 1024;
const MAX_OUTPUT_TOKENS = 1024;
const MAX_TTL_MS = 10 * 60_000;
const SOURCE = 'sub2api-egress';

export interface Sub2ApiTaskScope { taskId: string; tenantId: string; actorId: string }
interface Usage { inputTokens: number; outputTokens: number; totalTokens?: number }
interface Attempt {
  dispatches: number;
  statusCode?: number;
  usage: Usage | null;
  complete: boolean;
  sessionId?: string;
}
interface LeaseState {
  scope: Sub2ApiTaskScope;
  token: string;
  expiresAt: number;
  controller: AbortController;
  externalSignal?: AbortSignal;
  onAbort?: () => void;
  revoked: boolean;
  sandboxId?: string;
  admissionId?: string;
  consumed: boolean;
  upstreamSessionId: string;
  attempt?: Attempt;
}
export interface Sub2ApiAdmissionOptions {
  fastify: FastifyInstance;
  upstreamUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  /** Tests may use a loopback HTTP upstream; production must use HTTPS. */
  allowInsecureForTests?: boolean;
  /** Optional fixed upstream session header for providers that require it. */
  upstreamSessionHeader?: 'x-opencode-session';
}
export interface Sub2ApiLease {
  token: string;
  revoke(): void;
  modelAccounting: SandboxModelAccountingReader;
}

function endpoint(value: string, allowInsecure: boolean): string {
  const url = new URL(value);
  const validProtocol = url.protocol === 'https:' || (allowInsecure && url.protocol === 'http:');
  const pathname = url.pathname.replace(/\/+$/u, '');
  const segments = pathname.split('/').filter(Boolean);
  if (!validProtocol || url.username || url.password || url.search || url.hash
    || segments.some(segment => !/^[A-Za-z0-9_-]+$/u.test(segment))
    || !(segments.at(-1) === 'v1' || (segments.at(-3) === 'v1'
      && segments.at(-2) === 'chat' && segments.at(-1) === 'completions'))) {
    throw new Error('SUB2API_UPSTREAM_INVALID');
  }
  const normalizedPath = `/${segments.join('/')}`;
  return `${url.origin}${normalizedPath.endsWith('/v1') ? `${normalizedPath}/chat/completions` : normalizedPath}`;
}

function parseUsage(value: unknown): Usage | null {
  if (!value || typeof value !== 'object') return null;
  const u = value as Record<string, unknown>;
  const inputTokens = u.prompt_tokens;
  const outputTokens = u.completion_tokens;
  const totalTokens = u.total_tokens;
  if (!Number.isSafeInteger(inputTokens) || (inputTokens as number) < 0
    || !Number.isSafeInteger(outputTokens) || (outputTokens as number) < 0) return null;
  const result: Usage = { inputTokens: inputTokens as number, outputTokens: outputTokens as number };
  if (Number.isSafeInteger(totalTokens) && (totalTokens as number) >= 0) result.totalTokens = totalTokens as number;
  return result;
}

function readBody(request: FastifyRequest, model: string): Record<string, unknown> | undefined {
  const body = request.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const value = body as Record<string, unknown>;
  const allowed = new Set(['model', 'messages', 'stream', 'stream_options', 'max_tokens', 'max_completion_tokens',
    'temperature', 'top_p', 'stop', 'tool_choice', 'tools', 'parallel_tool_calls', 'reasoning_effort', 'user',
    'frequency_penalty', 'presence_penalty', 'seed', 'response_format', 'n', 'logprobs', 'top_logprobs', 'store']);
  if (Object.keys(value).some(key => !allowed.has(key)) || value.model !== model
    || !Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > 100
    || value.messages.some(message => !message || typeof message !== 'object' || Array.isArray(message)
      || !['system', 'developer', 'user', 'assistant'].includes(String((message as Record<string, unknown>).role))
      || Object.hasOwn(message, 'tool_calls') || Object.hasOwn(message, 'function_call')
      || !validTextContent((message as Record<string, unknown>).content))
    || (value.stream !== undefined && typeof value.stream !== 'boolean')
    || (value.store !== undefined && typeof value.store !== 'boolean')
    || (value.n !== undefined && value.n !== 1)) return undefined;
  const tokens = value.max_tokens ?? value.max_completion_tokens ?? MAX_OUTPUT_TOKENS;
  if (!Number.isSafeInteger(tokens) || (tokens as number) < 1 || (tokens as number) > MAX_OUTPUT_TOKENS) return undefined;
  if (value.stream_options !== undefined && (!value.stream_options || typeof value.stream_options !== 'object'
    || Array.isArray(value.stream_options) || Object.keys(value.stream_options as object).some(key => key !== 'include_usage')
    || typeof (value.stream_options as Record<string, unknown>).include_usage !== 'boolean')) return undefined;
  const { tools: _tools, tool_choice: _toolChoice, parallel_tool_calls: _parallel, ...safe } = value;
  return { ...safe, store: false, model: undefined, max_tokens: tokens, max_completion_tokens: undefined };
}

function validTextContent(content: unknown): boolean {
  if (typeof content === 'string') return true;
  return Array.isArray(content) && content.length > 0 && content.every(part => !!part && typeof part === 'object'
    && !Array.isArray(part) && ['text', 'input_text'].includes(String((part as Record<string, unknown>).type))
    && typeof (part as Record<string, unknown>).text === 'string');
}

interface SseCapture { value: string; usage: Usage | null }
function captureSseUsage(chunk: string, carry: SseCapture, final = false): Usage | null {
  carry.value += chunk;
  if (Buffer.byteLength(carry.value, 'utf8') > MAX_SSE_EVENT_BYTES) { carry.value = ''; return carry.usage; }
  const pieces = carry.value.replace(/\r\n/gu, '\n').split('\n\n');
  const events = final ? pieces : pieces.slice(0, -1);
  carry.value = final ? '' : pieces.at(-1) ?? '';
  for (const event of events) {
    const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /u, '')).join('\n');
    if (!data || data === '[DONE]') continue;
    try { carry.usage = parseUsage((JSON.parse(data) as { usage?: unknown }).usage) ?? carry.usage; }
    catch { /* Non-JSON event payloads are forwarded unchanged. */ }
  }
  return carry.usage;
}

function waitForDrain(response: import('node:http').ServerResponse, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { response.off('drain', drained); response.off('close', closed); signal.removeEventListener('abort', aborted); };
    const drained = () => { cleanup(); resolve(); };
    const closed = () => { cleanup(); reject(new Error('downstream_closed')); };
    const aborted = () => { cleanup(); reject(new Error('request_aborted')); };
    response.once('drain', drained);
    response.once('close', closed);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    else if (response.destroyed) closed();
  });
}

export function createSub2ApiAdmission(options: Sub2ApiAdmissionOptions) {
  const target = endpoint(options.upstreamUrl, options.allowInsecureForTests === true);
  if (options.upstreamSessionHeader !== undefined && options.upstreamSessionHeader !== 'x-opencode-session') {
    throw new Error('SUB2API_CONFIG_INVALID');
  }
  if (!options.apiKey.trim() || !options.model.trim() || options.model.length > 128) throw new Error('SUB2API_CONFIG_INVALID');
  const ttlMs = options.ttlMs ?? 5 * 60_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_TTL_MS) throw new Error('SUB2API_TTL_INVALID');
  const now = options.now ?? Date.now;
  const fetcher = options.fetchImpl ?? fetch;
  const leases = new Map<string, LeaseState>();
  const bearer = (request: FastifyRequest) => {
    const header = request.headers.authorization;
    return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
  };
  const accountingFor = (state: LeaseState): SandboxModelAccountingReader => ({
    async authorizeBudget(context) {
      if (state.revoked || state.expiresAt <= now() || context.taskId !== state.scope.taskId
        || context.tenantId !== state.scope.tenantId || context.actorId !== state.scope.actorId
        || context.maxModelRequests !== 1 || !context.sandboxId) return undefined;
      if (state.sandboxId && state.sandboxId !== context.sandboxId) return undefined;
      state.sandboxId = context.sandboxId;
      state.admissionId ??= randomUUID();
      return { ...state.scope, sandboxId: state.sandboxId, maxModelRequests: 1 as const,
        admissionId: state.admissionId, source: SOURCE, verified: true as const };
    },
    async read(context) {
      const attempt = state.attempt;
      if (!attempt?.complete || attempt.dispatches !== 1 || !attempt.statusCode || attempt.statusCode < 200 || attempt.statusCode >= 300
        || state.revoked || state.expiresAt <= now() || context.taskId !== state.scope.taskId
        || context.tenantId !== state.scope.tenantId || context.actorId !== state.scope.actorId
        || context.sandboxId !== state.sandboxId || context.admissionId !== state.admissionId
        || !context.dshSessionId) return undefined;
      if (attempt.sessionId && attempt.sessionId !== context.dshSessionId) return undefined;
      attempt.sessionId = context.dshSessionId;
      return { ...state.scope, sandboxId: context.sandboxId, dshSessionId: context.dshSessionId,
        modelCalls: 1, usage: attempt.usage, source: SOURCE, verified: true as const,
        requestCount: attempt.dispatches, statusCode: attempt.statusCode };
    },
  });

  options.fastify.post(ROUTE, { bodyLimit: MAX_BODY_BYTES }, async (request, reply) => {
    const state = leases.get(bearer(request));
    if (!state || state.revoked) return reply.code(401).send({ error: 'unauthorized' });
    if (state.expiresAt <= now()) { state.revoked = true; state.controller.abort(); return reply.code(410).send({ error: 'expired' }); }
    if (!state.sandboxId || !state.admissionId) return reply.code(403).send({ error: 'not_armed' });
    if (state.consumed) return reply.code(429).send({ error: 'request_limit_reached' });
    const payload = readBody(request, options.model);
    if (!payload) return reply.code(400).send({ error: 'invalid_request' });
    // This synchronous reservation occurs before the first await and before upstream dispatch.
    state.consumed = true;
    const attempt: Attempt = { dispatches: 0, usage: null, complete: false };
    state.attempt = attempt;
    const downstreamController = new AbortController();
    const abortOnDisconnect = () => downstreamController.abort();
    request.raw.once('aborted', abortOnDisconnect);
    const abortOnResponseClose = () => { if (!reply.raw.writableEnded) downstreamController.abort(); };
    reply.raw.once('close', abortOnResponseClose);
    const signal = AbortSignal.any([state.controller.signal, downstreamController.signal,
      ...(state.externalSignal ? [state.externalSignal] : [])]);
    try {
      attempt.dispatches++;
      const upstream = await fetcher(target, { method: 'POST', redirect: 'error', signal,
        headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json', 'user-agent': 'GroupWeave/0.1', accept: payload.stream === true ? 'text/event-stream' : 'application/json',
          ...(options.upstreamSessionHeader ? { [options.upstreamSessionHeader]: state.upstreamSessionId } : {}) },
        body: JSON.stringify({ ...payload, model: options.model }) });
      attempt.statusCode = upstream.status;
      if (!upstream.ok) console.warn('Model upstream request failed', JSON.stringify({ status: upstream.status }));
      const contentType = upstream.headers.get('content-type') ?? 'application/json';
      reply.code(upstream.status).header('content-type', contentType);
      const isSse = contentType.toLowerCase().includes('text/event-stream');
      const reader = upstream.body?.getReader();
      if (!reader) { attempt.complete = upstream.ok; return reply.send(''); }
      const decoder = new TextDecoder();
      const carry: SseCapture = { value: '', usage: null };
      let json = '';
      let responseBytes = 0;
      reply.hijack();
      reply.raw.statusCode = upstream.status;
      reply.raw.setHeader('content-type', contentType);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        signal.throwIfAborted();
        responseBytes += value.byteLength;
        if (responseBytes > MAX_RESPONSE_BYTES) throw new Error('response_limit_exceeded');
        const text = decoder.decode(value, { stream: true });
        if (isSse) attempt.usage = captureSseUsage(text, carry);
        else json += text;
        if (!isSse && Buffer.byteLength(json, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('response_limit_exceeded');
        if (!reply.raw.write(value)) await waitForDrain(reply.raw, signal);
      }
      const tail = decoder.decode();
      if (tail) {
        if (isSse) attempt.usage = captureSseUsage(tail, carry);
        else json += tail;
        if (!reply.raw.write(tail)) await waitForDrain(reply.raw, signal);
      }
      if (isSse) attempt.usage = captureSseUsage('', carry, true);
      if (!isSse) {
        try { attempt.usage = parseUsage((JSON.parse(json) as { usage?: unknown }).usage); } catch { attempt.usage = null; }
      }
      attempt.complete = upstream.ok;
      reply.raw.end();
      return reply;
    } catch (error) {
      const code = (error as { cause?: { code?: unknown }; code?: unknown })?.cause?.code ?? (error as { code?: unknown })?.code;
      if (!signal.aborted) console.warn('Model transport failed', JSON.stringify({ status: attempt.statusCode ?? null,
        code: typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'unknown' }));
      attempt.complete = false;
      downstreamController.abort();
      if (reply.raw.headersSent) { reply.raw.destroy(); return reply; }
      return reply.code(state.controller.signal.aborted ? 499 : 502).send({ error: 'upstream_unavailable' });
    } finally {
      request.raw.off('aborted', abortOnDisconnect);
      reply.raw.off('close', abortOnResponseClose);
    }
  });

  return {
    issue(scope: Sub2ApiTaskScope & { signal?: AbortSignal }): Sub2ApiLease {
      if (!scope.taskId.trim() || !scope.tenantId.trim() || !scope.actorId.trim()) throw new Error('SUB2API_SCOPE_INVALID');
      const token = randomBytes(32).toString('base64url');
      const state: LeaseState = { scope: { taskId: scope.taskId, tenantId: scope.tenantId, actorId: scope.actorId }, token,
        expiresAt: now() + ttlMs, controller: new AbortController(), externalSignal: scope.signal, revoked: false, consumed: false,
        upstreamSessionId: randomUUID() };
      if (scope.signal) {
        state.onAbort = () => { state.revoked = true; state.controller.abort(); };
        if (scope.signal.aborted) state.onAbort();
        else scope.signal.addEventListener('abort', state.onAbort, { once: true });
      }
      leases.set(token, state);
      return { token, modelAccounting: accountingFor(state), revoke() {
        state.revoked = true;
        state.controller.abort();
        if (state.onAbort) scope.signal?.removeEventListener('abort', state.onAbort);
        leases.delete(token);
      } };
    },
    close() {
      for (const state of leases.values()) {
        state.revoked = true;
        state.controller.abort();
        if (state.onAbort) state.externalSignal?.removeEventListener('abort', state.onAbort);
      }
      leases.clear();
    },
  };
}
