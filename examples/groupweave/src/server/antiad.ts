import { spawn } from 'node:child_process';
import { dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const WORKER_PATH = fileURLToPath(new URL('../../integrations/antiad/worker.py', import.meta.url));
const OUTPUT_LIMIT = 8_192;
const STDERR_LIMIT = 4_096;
const INPUT_LIMIT = 16_384;
const knownErrors = ['INVALID_INPUT', 'INPUT_LIMIT', 'OUTPUT_LIMIT', 'MODEL_UNAVAILABLE', 'DEPENDENCY_UNAVAILABLE', 'CLASSIFIER_FAILURE', 'PROCESS_FAILURE', 'TIMEOUT', 'BUSY', 'CLOSED', 'UNAUTHORIZED'] as const;
export type AntiadErrorCode = typeof knownErrors[number];

export class AntiadError extends Error {
  constructor(readonly code: AntiadErrorCode) {
    const messages: Record<AntiadErrorCode, string> = {
      INVALID_INPUT: '反广告判定参数无效。', INPUT_LIMIT: '反广告输入超过上限。', OUTPUT_LIMIT: '反广告判定返回超过上限。',
      MODEL_UNAVAILABLE: '受信反广告基准模型不可用；该能力已阻止执行。',
      DEPENDENCY_UNAVAILABLE: '反广告 Python 依赖不可用；该能力已阻止执行。',
      CLASSIFIER_FAILURE: '反广告分类器未能给出有效结果。', PROCESS_FAILURE: '反广告判定进程未能完成。',
      TIMEOUT: '反广告判定超时。', BUSY: '反广告判定正在处理其他消息，请稍后重试。',
      CLOSED: '反广告判定入口已关闭。', UNAUTHORIZED: '当前成员无权使用本群反广告判定。',
    };
    super(messages[code]);
    this.name = 'AntiadError';
  }
}

export interface AntiadRules {
  promptThreshold: number;
  actionThreshold: number;
  stopwords: readonly string[];
}

export interface AntiadRequest {
  actorId: string;
  groupId: string;
  input: string;
  audience: 'private' | 'group';
  /** This is asserted only by the trusted host after current scope checks. */
  authorized: boolean;
  /** Immutable per-task snapshot, not options supplied by a model tool call. */
  rules: AntiadRules;
  /** Trusted message metadata; absent fields do not invent account evidence. */
  message?: { userId: number; fullName: string; username: string; isForward: boolean };
}

const unit = z.number().finite().min(0).max(1);
const ruleSchema = z.object({
  promptThreshold: unit.gt(0), actionThreshold: unit.gt(0),
  stopwords: z.array(z.string().trim().min(1).max(80)).max(50),
}).strict().refine(rules => rules.actionThreshold >= rules.promptThreshold);
const messageSchema = z.object({
  userId: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  fullName: z.string().refine(text => Buffer.byteLength(text) <= 256),
  username: z.string().refine(text => Buffer.byteLength(text) <= 128),
  isForward: z.boolean(),
}).strict();
const verdictSchema = z.object({
  version: z.literal(1), classifierReady: z.literal(true), total: unit, contentScore: unit,
  recommendation: z.enum(['allow', 'review', 'high-confidence-review']),
  contributions: z.array(z.object({
    name: z.enum(['classifier', 'stopwords', 'contact_patterns', 'duplicate', 'meta', 'nickname', 'id_age', 'prohibited_script']),
    score: unit, weight: z.number().finite().min(0).max(3),
  }).strict()).max(8),
}).strict();
export type AntiadVerdict = z.infer<typeof verdictSchema>;

export interface AntiadOptions {
  /** Absolute administrator-managed interpreter; never a message/group field. */
  pythonPath: string;
  /** Absolute read-only administrator-reviewed joblib file; pickle is executable. */
  modelPath: string;
  timeoutMs?: number;
}

export type AntiadExecutor = ((request: AntiadRequest, signal?: AbortSignal) => Promise<{
  output: string; modelCalls: 0;
}>) & {
  classify(request: AntiadRequest, signal?: AbortSignal): Promise<AntiadVerdict>;
  dispose(): Promise<void>;
};

function payload(request: AntiadRequest): string {
  if (request.authorized !== true || !request.actorId?.trim() || !request.groupId?.trim()) throw new AntiadError('UNAUTHORIZED');
  if (request.audience !== 'private' && request.audience !== 'group') throw new AntiadError('INVALID_INPUT');
  if (typeof request.input !== 'string' || !request.input.trim()) throw new AntiadError('INVALID_INPUT');
  if (Buffer.byteLength(request.input) > 8_192) throw new AntiadError('INPUT_LIMIT');
  const rules = ruleSchema.safeParse(request.rules);
  const message = messageSchema.safeParse(request.message ?? { userId: 0, fullName: '', username: '', isForward: false });
  if (!rules.success || !message.success) throw new AntiadError('INVALID_INPUT');
  const input = JSON.stringify({ text: request.input, rules: rules.data, message: message.data });
  if (Buffer.byteLength(input) > INPUT_LIMIT) throw new AntiadError('INPUT_LIMIT');
  return input;
}

function render(verdict: AntiadVerdict): string {
  const labels = { allow: '未达到复核阈值', review: '建议人工复核', 'high-confidence-review': '高置信度疑似广告，建议人工复核' };
  return `反广告判定：${labels[verdict.recommendation]}\n综合分数：${verdict.total.toFixed(3)}\n内容证据分数：${verdict.contentScore.toFixed(3)}\n基准分类器：已实际运行\n本次仅给出判定；未删除消息、禁言、封禁或训练模型。`;
}

/**
 * One fixed private antiad inference CLI, not a general shell/tool executor.
 * One child at a time; busy requests fail promptly rather than creating a queue.
 * Each invocation gets a fresh group rule snapshot and never receives a DB,
 * Telegram token, bot config, training command or arbitrary executable/argv.
 */
export async function createAntiadExecutor(options: AntiadOptions): Promise<AntiadExecutor> {
  if (!isAbsolute(options.pythonPath) || !isAbsolute(options.modelPath)) throw new AntiadError('INVALID_INPUT');
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) throw new AntiadError('INVALID_INPUT');
  const trusted = Object.freeze({ pythonPath: options.pythonPath, modelPath: options.modelPath, timeoutMs });
  const shutdown = new AbortController();
  const active = new Set<Promise<unknown>>();
  let closed = false;
  let closing: Promise<void> | undefined;

  function invoke(probe: boolean, input: string | undefined, callerSignal?: AbortSignal): Promise<unknown> {
    if (closed) return Promise.reject(new AntiadError('CLOSED'));
    const signal = callerSignal ? AbortSignal.any([callerSignal, shutdown.signal]) : shutdown.signal;
    if (signal.aborted) return Promise.reject(signal.reason);
    if (active.size !== 0) return Promise.reject(new AntiadError('BUSY'));
    const execution = new Promise<unknown>((resolve, reject) => {
      // Environment is intentionally narrow; no API keys, PYTHONPATH, HOME, bot
      // config or provider environment is forwarded to the private adapter.
      const child = spawn(trusted.pythonPath, ['-E', '-s', '-B', WORKER_PATH, '--model', trusted.modelPath, ...(probe ? ['--probe'] : [])], {
        shell: false, cwd: dirname(WORKER_PATH),
        env: { PATH: dirname(trusted.pythonPath), OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1', MKL_NUM_THREADS: '1', NUMEXPR_NUM_THREADS: '1' },
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      });
      let failure: unknown;
      let stdout = Buffer.alloc(0);
      let stderrBytes = 0;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let drained = false;
      const stop = (reason: unknown) => {
        failure ??= reason;
        if (drained) return;
        child.kill('SIGTERM');
        killTimer ??= setTimeout(() => { child.kill('SIGKILL'); }, 250);
        killTimer.unref();
      };
      const abort = () => stop(signal.reason);
      const timeout = setTimeout(() => stop(new AntiadError('TIMEOUT')), trusted.timeoutMs);
      timeout.unref();
      signal.addEventListener('abort', abort, { once: true });
      child.once('error', () => { failure ??= new AntiadError('PROCESS_FAILURE'); });
      child.stdin.once('error', () => { failure ??= new AntiadError('PROCESS_FAILURE'); });
      child.stdout.on('data', (chunk: Buffer) => {
        if (stdout.length + chunk.length > OUTPUT_LIMIT) stop(new AntiadError('OUTPUT_LIMIT'));
        else stdout = Buffer.concat([stdout, chunk]);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        // Drain without retaining or exposing potentially private diagnostics.
        stderrBytes += chunk.length;
        if (stderrBytes > STDERR_LIMIT) stop(new AntiadError('OUTPUT_LIMIT'));
      });
      child.once('close', (code) => {
        drained = true;
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        signal.removeEventListener('abort', abort);
        if (failure) { reject(failure); return; }
        let value: unknown;
        try { value = JSON.parse(stdout.toString('utf8')); }
        catch { reject(new AntiadError('PROCESS_FAILURE')); return; }
        const error = z.object({ version: z.literal(1), error: z.enum(knownErrors) }).strict().safeParse(value);
        if (code !== 0) { reject(new AntiadError(error.success ? error.data.error : 'PROCESS_FAILURE')); return; }
        resolve(value);
      });
      if (signal.aborted) abort();
      child.stdin.end(input ?? '');
    });
    active.add(execution);
    void execution.then(() => active.delete(execution), () => active.delete(execution));
    return execution;
  }

  // Actual readiness includes model deserialization and inference. The caller
  // must keep the feature blocked if this throws; no rule-only fallback exists.
  const ready = z.object({ version: z.literal(1), classifierReady: z.literal(true) }).strict().safeParse(await invoke(true, undefined));
  if (!ready.success) throw new AntiadError('MODEL_UNAVAILABLE');

  async function classify(request: AntiadRequest, signal?: AbortSignal): Promise<AntiadVerdict> {
    signal?.throwIfAborted();
    const rules = ruleSchema.safeParse(request.rules);
    const input = payload(request);
    const raw = await invoke(false, input, signal);
    const result = verdictSchema.safeParse(raw);
    if (!result.success || !rules.success) throw new AntiadError('CLASSIFIER_FAILURE');
    // Independently verify the only decision mapping exposed by the adapter.
    const verdict = result.data;
    const expected = verdict.total >= rules.data.actionThreshold && verdict.contentScore >= rules.data.promptThreshold
      ? 'high-confidence-review' : verdict.total >= rules.data.promptThreshold ? 'review' : 'allow';
    if (verdict.recommendation !== expected) throw new AntiadError('CLASSIFIER_FAILURE');
    return verdict;
  }
  const execute = (async (request: AntiadRequest, signal?: AbortSignal) => ({ output: render(await classify(request, signal)), modelCalls: 0 as const })) as AntiadExecutor;
  execute.classify = classify;
  execute.dispose = () => closing ??= (async () => {
    closed = true;
    shutdown.abort(new AntiadError('CLOSED'));
    await Promise.allSettled([...active]);
  })();
  return execute;
}
