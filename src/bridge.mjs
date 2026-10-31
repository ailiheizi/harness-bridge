import { execa } from 'execa';
import { randomUUID, createHash } from 'node:crypto';
import { stat, mkdtemp, open, lstat, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const defaults = { totalTimeoutMs: 120_000, commandTimeoutMs: 20_000, maxOutputBytes: 256 * 1024 };
const fail = (stage, code) => Object.assign(new Error(code), { stage, code });

function validText(value, name, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw fail('input', `invalid_${name}`);
  return value;
}

function labelsOf(value) {
  const labels = value?.labels;
  if (Array.isArray(labels)) return Object.fromEntries(labels.map((x) => {
    if (typeof x === 'string') { const i = x.indexOf('='); return i < 0 ? [x, ''] : [x.slice(0, i), x.slice(i + 1)]; }
    return [String(x?.key ?? ''), String(x?.value ?? '')];
  }));
  return labels && typeof labels === 'object' ? labels : {};
}

function parseJson(text, stage) {
  try { return JSON.parse(text); } catch { throw fail(stage, 'invalid_native_json'); }
}

function dshEvents(text, exitCode) {
  let sessionId;
  let output;
  let completed = false;
  let toolCallCount = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { throw fail('dsh', 'invalid_event_stream'); }
    if (event.type === 'session' && typeof event.sessionId === 'string') sessionId = event.sessionId;
    if (event.type === 'tool_call') toolCallCount++;
    if (event.type === 'status' && event.phase === 'turn_end' && event.reason?.kind === 'completed') completed = true;
    if (event.type === 'final' && typeof event.text === 'string') output = event.text;
    if (event.type === 'error') throw fail('dsh', 'native_harness_error');
  }
  if (exitCode !== 0 || !completed || typeof output !== 'string' || !sessionId) throw fail('dsh', 'turn_not_verified');
  return { sessionId, output, toolCallCount };
}

export function createHarnessBridge(options) {
  if (!options || typeof options !== 'object') throw new TypeError('options required');
  const cfg = options;
  if (cfg.dsh?.downloadResult !== undefined && typeof cfg.dsh.downloadResult !== 'boolean') throw new TypeError('invalid downloadResult');
  const limits = { ...defaults, ...cfg.limits };
  for (const [k, v] of Object.entries(limits)) if (!Number.isSafeInteger(v) || v <= 0) throw new TypeError(`invalid ${k}`);
  if (!cfg.native?.cliPath || !path.isAbsolute(cfg.native.cliPath) || typeof cfg.native.workspace !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(cfg.native.workspace) || !path.isAbsolute(cfg.native.home) || !path.isAbsolute(cfg.native.xdgConfigHome) || !path.isAbsolute(cfg.native.policyPath) || !path.isAbsolute(cfg.dsh?.patchPath)) throw new TypeError('native paths must be absolute and workspace must be a logical OpenShell workspace name');
  for (const fn of ['authorizeAdmission', 'authorizeNativeCall', 'authorizeResult']) if (typeof cfg[fn] !== 'function') throw new TypeError(`${fn} callback required`);

  return { execute: (request, signal) => execute(cfg, limits, request, signal) };
}

async function execute(cfg, limits, request, signal) {
  const taskId = validText(request?.taskId, 'task_id', 128);
  const tenantId = validText(request?.tenantId, 'tenant_id', 256);
  const actorId = validText(request?.actorId, 'actor_id', 256);
  const prompt = validText(request?.prompt, 'prompt', 64 * 1024);
  const skillPath = request?.skillPath;
  if (skillPath !== undefined && !path.isAbsolute(skillPath)) throw fail('input', 'invalid_skill_path');
  // The caller owns its input object and may mutate it while async authorization is pending.
  // Carry a frozen invocation snapshot across every authorization and execution boundary.
  request = Object.freeze({
    taskId, tenantId, actorId, prompt,
    ...(skillPath === undefined ? {} : { skillPath }),
    ...(request?.binding === undefined ? {} : { binding: request.binding }),
  });
  const started = Date.now();
  const deadline = started + limits.totalTimeoutMs;
  const owner = randomUUID();
  const safeTask = createHash('sha256').update(taskId).digest('hex').slice(0, 20);
  const name = `aw-${owner.replaceAll('-', '').slice(0, 16)}`;
  const labels = { 'actweave.owner': owner, 'actweave.task': safeTask, 'actweave.scope': 'harness-bridge' };
  const providerNames = [...(cfg.native.providers ?? [])];
  if (providerNames.some((p) => typeof p !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(p))) throw fail('input', 'invalid_provider_name');
  const evidence = { execution: 'not-run', cleanup: 'not-created', modelRequestCount: null };
  let identity;
  let expectedNativeId;
  let created = false;
  let creationAttempted = false;
  let cleanupMode = false;
  let cleanupDeadline = 0;
  let result;
  let failure;
  let downloadDir;
  const env = {
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    HOME: cfg.native.home,
    XDG_CONFIG_HOME: cfg.native.xdgConfigHome,
    XDG_CACHE_HOME: path.join(cfg.native.home, '.cache'),
    XDG_DATA_HOME: path.join(cfg.native.home, '.local/share'),
    XDG_STATE_HOME: path.join(cfg.native.home, '.local/state'),
    ...(cfg.native.gatewayEndpoint ? { OPENSHELL_GATEWAY_ENDPOINT: cfg.native.gatewayEndpoint } : {}),
  };
  const remaining = () => Math.max(1, Math.min(limits.commandTimeoutMs, (cleanupMode ? cleanupDeadline : deadline) - Date.now()));
  const boundedAuthorization = async (callback, stage) => {
    if (signal?.aborted) throw fail(stage, 'aborted');
    const ms = deadline - Date.now();
    if (ms <= 0) throw fail(stage, 'deadline_exceeded');
    let timer;
    let onAbort;
    try {
      return await Promise.race([
        Promise.resolve().then(callback),
        new Promise((_, reject) => { timer = setTimeout(() => reject(fail(stage, 'deadline_exceeded')), ms); }),
        ...(signal ? [new Promise((_, reject) => { onAbort = () => reject(fail(stage, 'aborted')); signal.addEventListener('abort', onAbort, { once: true }); })] : []),
      ]);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  };
  const native = async (operation, args, input, onSpawn) => {
    if (!cleanupMode && signal?.aborted) throw fail(operation, 'aborted');
    if (Date.now() >= (cleanupMode ? cleanupDeadline : deadline)) throw fail(operation, cleanupMode ? 'cleanup_deadline_exceeded' : 'deadline_exceeded');
    const controllerCleanup = cleanupMode && ['get', 'list', 'stop', 'delete'].includes(operation);
    if (!controllerCleanup) await boundedAuthorization(() => cfg.authorizeNativeCall({ operation, taskId, tenantId, actorId, sandbox: identity }), operation);
    if (created && identity && ['upload', 'exec', 'download', 'stop', 'delete'].includes(operation)) {
      const current = await inspect();
      if (current.id !== identity.id) throw fail('identity', 'native_identity_changed');
    }
    if (!cleanupMode && signal?.aborted) throw fail(operation, 'aborted');
    if (Date.now() >= (cleanupMode ? cleanupDeadline : deadline)) throw fail(operation, cleanupMode ? 'cleanup_deadline_exceeded' : 'deadline_exceeded');
    try {
      const child = execa(cfg.native.cliPath, ['--workspace', cfg.native.workspace, ...args], { input, env, extendEnv: false, reject: false, timeout: remaining(), ...(cleanupMode || !signal ? {} : { cancelSignal: signal }), maxBuffer: limits.maxOutputBytes, stdout: 'pipe', stderr: 'pipe' });
      onSpawn?.();
      const x = await child;
      if (x.timedOut) throw fail(operation, 'native_command_timeout');
      if (x.isCanceled) throw fail(operation, 'aborted');
      return x;
    } catch (e) {
      if (e?.stage && e?.code) throw e;
      if (e?.name === 'AbortError') throw fail(operation, 'aborted');
      throw fail(operation, 'native_command_failed');
    }
  };
  const inspect = async () => {
    const x = await native('get', ['sandbox', 'get', name, '--output', 'json']);
    if (x.exitCode !== 0) throw fail('get', 'native_get_failed');
    const raw = parseJson(x.stdout, 'get');
    const id = raw.id ?? raw.sandbox?.id;
    const actualName = raw.name ?? raw.sandbox?.name;
    const workspace = raw.workspace ?? raw.sandbox?.workspace;
    const actualLabels = labelsOf(raw);
    if (typeof id !== 'string' || !id || (expectedNativeId && id !== expectedNativeId) || actualName !== name || workspace !== cfg.native.workspace || Object.entries(labels).some(([k, v]) => actualLabels[k] !== v)) throw fail('identity', 'native_identity_mismatch');
    return { id, name, workspace, phase: raw.phase ?? raw.sandbox?.phase };
  };
  const listPage = async (pageToken = '', selector) => {
    const args = ['sandbox', 'list', '--page-size', '100', ...(pageToken ? ['--page-token', pageToken] : []), '--output', 'json', ...(selector ? ['--selector', selector] : [])];
    const x = await native('list', args);
    if (x.exitCode !== 0) throw fail('list', 'native_list_failed');
    const data = parseJson(x.stdout, 'list');
    if (!Array.isArray(data.sandboxes) || typeof data.next_page_token !== 'string') throw fail('list', 'native_list_schema_invalid');
    for (const item of data.sandboxes) {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id || typeof item.name !== 'string' || !item.name || typeof item.workspace !== 'string' || item.workspace !== cfg.native.workspace || !item.labels || typeof item.labels !== 'object' || Array.isArray(item.labels)) throw fail('list', 'native_list_schema_invalid');
    }
    return data;
  };
  const listMatching = async (selector) => {
    const found = [];
    const tokens = new Set();
    let token = '';
    for (let page = 0; page < 100; page++) {
      const data = await listPage(token, selector);
      found.push(...data.sandboxes);
      if (!data.next_page_token) return found;
      if (tokens.has(data.next_page_token)) throw fail('list', 'native_list_pagination_invalid');
      tokens.add(data.next_page_token);
      token = data.next_page_token;
    }
    throw fail('list', 'native_list_pagination_limit');
  };
  const verifyNameAbsent = async () => {
    for (;;) {
      if (Date.now() >= cleanupDeadline) throw fail('delete', 'native_delete_unverified');
      const items = await listMatching();
      const named = items.filter((item) => item.name === name);
      for (const item of named) {
        const actualLabels = labelsOf(item);
        if (item.id !== expectedNativeId || item.workspace !== cfg.native.workspace || Object.entries(labels).some(([key, value]) => actualLabels[key] !== value)) {
          throw fail('identity', 'native_identity_mismatch');
        }
      }
      if (named.length === 0) return;
      if (Date.now() >= cleanupDeadline) throw fail('delete', 'native_delete_unverified');
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, cleanupDeadline - Date.now())));
    }
  };
  try {
    await boundedAuthorization(() => cfg.authorizeAdmission({ request, providerNames }), 'admission');
    if (signal?.aborted) throw fail('admission', 'aborted');
    const createArgs = ['sandbox', 'create', '--name', name, '--from', cfg.native.image, '--policy', cfg.native.policyPath, '--cpu', '500m', '--memory', '512Mi', '--no-auto-providers', '--detach', '--output', 'json', ...Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]), ...providerNames.flatMap((p) => ['--provider', p]), '--', '/bin/sleep', '300'];
    const cr = await native('create', createArgs, undefined, () => { creationAttempted = true; });
    if (cr.exitCode !== 0) throw fail('create', 'native_create_failed');
    created = true;
    const initial = parseJson(cr.stdout, 'create');
    expectedNativeId = initial.id ?? initial.sandbox?.id;
    if (typeof expectedNativeId !== 'string' || !expectedNativeId) throw fail('identity', 'create_identity_missing');
    identity = await inspect();
    const skill = request.skillPath;
    if (skill) {
      const s = await stat(skill);
      if (!s.isFile()) throw fail('upload', 'skill_not_file');
      const skillName = path.basename(path.dirname(skill));
      if (path.basename(skill) !== 'SKILL.md' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(skillName)) throw fail('upload', 'invalid_skill_layout');
      const chk = await inspect();
      if (chk.id !== identity.id) throw fail('identity', 'native_identity_changed');
      const up = await native('upload', ['sandbox', 'upload', name, skill, path.posix.join(cfg.dsh.skillRoot ?? '/workspace/skills', skillName, 'SKILL.md'), '--no-git-ignore']);
      if (up.exitCode !== 0) throw fail('upload', 'native_upload_failed');
    }
    const patchStat = await stat(cfg.dsh.patchPath);
    if (!patchStat.isFile()) throw fail('patch', 'patch_not_file');
    let chk = await inspect();
    if (chk.id !== identity.id) throw fail('identity', 'native_identity_changed');
    const patchUpload = await native('upload', ['sandbox', 'upload', name, cfg.dsh.patchPath, '/workspace/dsh-patch.yml', '--no-git-ignore']);
    if (patchUpload.exitCode !== 0) throw fail('patch', 'native_upload_failed');
    chk = await inspect();
    if (chk.id !== identity.id) throw fail('identity', 'native_identity_changed');
    const dsh = await native('exec', ['sandbox', 'exec', name, '--no-login-shell', '--no-tty', '--timeout', String(Math.max(1, Math.ceil(remaining() / 1000))), '--', '/usr/bin/env', 'NARB_DISABLE_NATIVE_CACHE=1', '/usr/local/bin/dsh', '--profile', 'headless', '--patch', '/workspace/dsh-patch.yml', '--json', '-'], request.prompt);
    evidence.nativeExitCode = dsh.exitCode;
    const parsed = dshEvents(dsh.stdout.slice(0, limits.maxOutputBytes), dsh.exitCode);
    if (Buffer.byteLength(parsed.output, 'utf8') > limits.maxOutputBytes) throw fail('dsh', 'output_limit_exceeded');
    evidence.execution = 'verified';
    evidence.dshSessionId = parsed.sessionId;
    evidence.toolCallCount = parsed.toolCallCount;
    let artifact;
    if (cfg.dsh.downloadResult) {
      // A host opt-in to one workload-owned export, never an Agent-supplied path.
      downloadDir = await mkdtemp(path.join(os.tmpdir(), 'harness-result-'));
      const local = path.join(downloadDir, 'result.md');
      const downloaded = await native('download', ['sandbox', 'download', name, '/workspace/exports/result.md', local]);
      if (downloaded.exitCode !== 0) throw fail('download', 'native_download_failed');
      const meta = await lstat(local);
      if (!meta.isFile() || meta.isSymbolicLink() || meta.size < 1 || meta.size > 64_000) throw fail('download', 'invalid_result_file');
      const file = await open(local, constants.O_RDONLY | constants.O_NOFOLLOW);
      let data;
      try {
        const actual = await file.stat();
        if (!actual.isFile() || actual.size !== meta.size || actual.ino !== meta.ino || actual.dev !== meta.dev) throw fail('download', 'result_file_changed');
        const bounded = Buffer.alloc(64_001);
        let size = 0;
        while (size < bounded.length) {
          const read = await file.read(bounded, size, bounded.length - size, null);
          if (!read.bytesRead) break;
          size += read.bytesRead;
        }
        if (size !== meta.size || size > 64_000) throw fail('download', 'invalid_result_file');
        data = bounded.subarray(0, size);
      } finally { await file.close(); }
      // The trusted turn observer exports exactly the committed final text.
      // Reject cross-turn, substituted and malformed exports rather than release them.
      if (!data.equals(Buffer.from(parsed.output, 'utf8'))) throw fail('download', 'result_content_mismatch');
      artifact = { name: 'result.md', mediaType: 'text/markdown', data };
    }
    result = { taskId, status: 'completed', output: parsed.output, sandbox: identity, ...(artifact ? { artifact } : {}) };
  } catch (e) {
    failure = { stage: e?.stage ?? 'bridge', code: e?.code ?? 'bridge_failed' };
  } finally {
    if (creationAttempted && !created) {
      cleanupMode = true;
      cleanupDeadline = Date.now() + 60_000;
      try {
        const ownerMatches = await listMatching(`actweave.owner=${owner}`);
        const owned = ownerMatches.filter((item) => labelsOf(item)['actweave.owner'] === owner);
        if (owned.length === 1) {
          const item = owned[0];
          const candidate = { id: item.id, name: item.name, workspace: item.workspace };
          if (typeof candidate.id === 'string' && candidate.name === name && candidate.workspace === cfg.native.workspace && Object.entries(labels).every(([k, v]) => labelsOf(item)[k] === v)) {
            expectedNativeId = candidate.id;
            identity = candidate;
            created = true;
          }
        }
        if (!created) evidence.cleanup = 'unverified';
      } catch (e) {
        evidence.cleanup = 'unverified';
        failure ??= { stage: e?.stage ?? 'cleanup_discovery', code: e?.code ?? 'owned_sandbox_discovery_failed' };
      }
    }
    if (created) {
      try {
        cleanupMode = true;
        cleanupDeadline ||= Date.now() + 60_000;
        let current = await inspect();
        identity ??= current;
        if (identity && current.id !== identity.id) throw fail('identity', 'native_identity_changed');
        if (!['stopped', 'deleted'].includes(String(current.phase ?? '').toLowerCase())) {
          const stopped = await native('stop', ['sandbox', 'stop', name]);
          if (stopped.exitCode !== 0) throw fail('stop', 'native_stop_failed');
        }
        let stoppedState;
        do {
          current = await inspect();
          if (identity && current.id !== identity.id) throw fail('identity', 'native_identity_changed');
          if (String(current.phase ?? '').toLowerCase() === 'stopped') { stoppedState = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 500));
        } while (Date.now() < cleanupDeadline);
        if (!stoppedState) throw fail('stop', 'native_stop_unverified');
        const beforeDelete = await inspect();
        if (identity && beforeDelete.id !== identity.id) throw fail('identity', 'native_identity_changed');
        const del = await native('delete', ['sandbox', 'delete', name]);
        if (del.exitCode !== 0) throw fail('delete', 'native_delete_failed');
        await verifyNameAbsent();
        evidence.cleanup = 'verified';
      } catch (e) {
        evidence.cleanup = 'unverified';
        failure ??= { stage: e?.stage ?? 'cleanup', code: e?.code ?? 'cleanup_failed' };
      }
    }
  }
  if (downloadDir) {
    try { await rm(downloadDir, { recursive: true, force: true }); }
    catch { failure ??= { stage: 'download', code: 'local_cleanup_failed' }; result = undefined; }
  }
  if (!result && !failure) failure = { stage: 'bridge', code: 'no_result' };
  if (result && evidence.cleanup !== 'verified') {
    failure ??= { stage: 'cleanup', code: 'cleanup_unverified' };
    result = undefined;
  }
  const response = result
    ? { ...result, cleanup: { status: 'verified' }, evidence: { ...evidence, cleanup: 'verified', nativeExitCode: 0 } }
    : { taskId, status: evidence.cleanup === 'unverified' ? 'blocked' : 'failed', failure, ...(identity ? { sandbox: identity } : {}), cleanup: { status: evidence.cleanup }, evidence };
  try {
    await boundedAuthorization(() => cfg.authorizeResult({ request, result: response }), 'result_authorization');
  } catch {
    return { taskId, status: 'blocked', failure: { stage: 'result_authorization', code: 'delivery_denied' }, ...(identity ? { sandbox: identity } : {}), cleanup: { status: evidence.cleanup }, evidence };
  }
  return response;
}
