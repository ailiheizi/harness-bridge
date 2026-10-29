// GroupWeave deployment binding. Only trusted configuration may load this module.
import Fastify from 'fastify';
import { execa } from 'execa';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createSub2ApiAdmission } from '../../src/server/sub2api-admission.js';

const MODEL_HOST = 'host.openshell.internal';
const fail = code => new Error(`GROUPWEAVE_SUB2API_${code}`);
const disabled = ['tool-web', 'tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-fs', 'tool-fs-search',
  'tool-workflow', 'tool-subagent', 'tool-subagent-fork', 'tool-subagent-control', 'tool-subagent-list-agents',
  'tool-plugin-manager', 'tool-result-pruner', 'tool-todo', 'tool-goal', 'tool-ralph',
  'session-title-llm', 'session-telemetry-otel', 'llm-retry'];

export function validateDeployment(config) {
  if (!config || !path.isAbsolute(config.cliPath ?? '') || !path.isAbsolute(config.stateDir ?? '')
    || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(config.workspace ?? '')
    || !/^sha256:[a-f0-9]{64}$/.test(config.image ?? '')
    || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(config.model ?? '')
    || typeof config.apiKey !== 'string' || !config.apiKey.trim()
    || !Number.isSafeInteger(config.meterPort) || config.meterPort < 1024 || config.meterPort > 65535) throw fail('CONFIG_INVALID');
  const gateway = new URL(config.gatewayEndpoint);
  if (gateway.protocol !== 'http:' || gateway.hostname !== '127.0.0.1' || gateway.username || gateway.password
    || gateway.pathname !== '/' || gateway.search || gateway.hash) throw fail('GATEWAY_MUST_BE_LOOPBACK');
  const upstream = new URL(config.upstreamUrl);
  const upstreamPath = upstream.pathname.replace(/\/+$/u, '');
  const upstreamSegments = upstreamPath.split('/').filter(Boolean);
  if (upstream.protocol !== 'https:' || upstream.username || upstream.password || upstream.search || upstream.hash
    || upstreamSegments.some(segment => !/^[A-Za-z0-9_-]+$/.test(segment))
    || !(upstreamSegments.at(-1) === 'v1' || (upstreamSegments.at(-3) === 'v1'
      && upstreamSegments.at(-2) === 'chat' && upstreamSegments.at(-1) === 'completions'))) throw fail('UPSTREAM_INVALID');
  if (config.upstreamSessionHeader !== undefined && config.upstreamSessionHeader !== 'x-opencode-session') {
    throw fail('CONFIG_INVALID');
  }
}

export function taskFiles(config, name, dir) {
  const endpoint = { host: MODEL_HOST, port: config.meterPort, protocol: 'rest', enforcement: 'enforce',
    rules: [{ allow: { method: 'POST', path: '/v1/chat/completions' } }] };
  return {
    profile: { id: name, display_name: `GroupWeave task ${name}`, description: 'Single-task bounded text model',
      category: 'inference', inference_capable: true,
      credentials: [{ name: 'api_key', env_vars: ['GROUPWEAVE_MODEL_TOKEN'], required: true,
        auth_style: 'bearer', header_name: 'authorization' }],
      discovery: { credentials: ['api_key'] }, endpoints: [endpoint], binaries: ['/usr/local/bin/node'] },
    policy: { version: 1,
      filesystem_policy: { include_workdir: true, read_only: ['/usr', '/lib', '/lib64', '/bin', '/sbin', '/etc', '/proc', '/dev/urandom', '/opt/actweave'], read_write: ['/tmp', '/dev/null', '/workspace'] },
      landlock: { compatibility: 'hard_requirement' }, process: { run_as_user: '1000', run_as_group: '1000' },
      network_policies: { groupweave_model: { name: 'Task-bound local model admission', endpoints: [endpoint], binaries: [{ path: '/usr/local/bin/node' }] } } },
    patch: [
      { id: 'llm-pi-ai', config: { providers: { 'groupweave-model': { apiKeyEnv: 'GROUPWEAVE_MODEL_TOKEN', api: 'openai-completions',
        baseURL: `http://${MODEL_HOST}:${config.meterPort}/v1`, displayName: 'GroupWeave bounded Sub2API',
        models: [{ id: config.model, name: config.model, maxTokens: 1024, reasoningEfforts: false }] } } } },
      { id: 'agent-default-model', config: { provider: 'groupweave-model', model: config.model } },
      { id: 'skill-filesystem', config: { includeDefaultRoots: false, customSkillDirs: ['/workspace/skills'] } },
      // Keep native user-invoked Skill loading. The text-model egress strips model tools.
      ...disabled.map(id => ({ id, disabled: true })),
    ],
    home: path.join(dir, 'home'), xdgConfigHome: path.join(dir, 'xdg'),
  };
}

export async function createOpenShellSub2ApiBinding(config) {
  validateDeployment(config);
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const state = await lstat(config.stateDir);
  if (!state.isDirectory() || state.isSymbolicLink() || (state.mode & 0o777) !== 0o700 || state.uid !== process.getuid()) throw fail('STATE_DIR_UNTRUSTED');
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });
  const meter = createSub2ApiAdmission({ fastify: app, upstreamUrl: config.upstreamUrl, apiKey: config.apiKey, model: config.model,
    upstreamSessionHeader: config.upstreamSessionHeader, ttlMs: 360_000 });
  try { await app.listen({ host: '127.0.0.1', port: config.meterPort }); }
  catch { meter.close(); await app.close(); throw fail('METER_LISTEN_FAILED'); }
  let disposed = false;
  const active = new Set();
  return {
    limits: { totalTimeoutMs: 240_000, commandTimeoutMs: 90_000, maxOutputBytes: 256 * 1024 },
    async createTaskBinding(request, signal) {
      if (disposed) throw fail('CLOSED');
      signal.throwIfAborted();
      const lease = meter.issue({ taskId: request.taskId, tenantId: request.tenantId, actorId: request.actorId, signal });
      const name = `gw-${randomUUID().replaceAll('-', '').slice(0, 20)}`;
      let dir, home, xdgConfigHome, providerId;
      let profileAttempted = false, providerAttempted = false, closed = false;
      const cli = async (args, key, cleanup = false) => {
        const result = await execa(config.cliPath, ['--workspace', config.workspace, ...args], {
          env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: xdgConfigHome,
            OPENSHELL_GATEWAY_ENDPOINT: config.gatewayEndpoint, ...(key ? { GROUPWEAVE_MODEL_TOKEN: key } : {}) },
          extendEnv: false, reject: false, timeout: 15_000, maxBuffer: 256 * 1024,
          ...(!cleanup ? { cancelSignal: signal } : {}),
        });
        if (result.exitCode !== 0 || result.timedOut || result.isCanceled) throw fail('NATIVE_CONFIG_FAILED');
        return result.stdout;
      };
      const providers = async cleanup => {
        const all = [], seen = new Set();
        let token = '';
        for (let i = 0; i < 20; i++) {
          const data = JSON.parse(await cli(['provider', 'list', '--page-size', '100', ...(token ? ['--page-token', token] : []), '--output', 'json'], undefined, cleanup));
          if (!Array.isArray(data.providers) || typeof data.next_page_token !== 'string') throw fail('PROVIDER_LIST_INVALID');
          all.push(...data.providers);
          if (!data.next_page_token) return all;
          if (seen.has(data.next_page_token)) throw fail('PROVIDER_PAGINATION_INVALID');
          seen.add(data.next_page_token); token = data.next_page_token;
        }
        throw fail('PROVIDER_PAGE_LIMIT');
      };
      const profiles = async cleanup => {
        const rows = JSON.parse(await cli(['provider', 'profile', 'list', '--output', 'json'], undefined, cleanup));
        if (!Array.isArray(rows)) throw fail('PROFILE_LIST_INVALID');
        return rows;
      };
      const close = async () => {
        if (closed) return;
        lease.revoke();
        if (providerAttempted) {
          const rows = (await providers(true)).filter(row => row.name === name && row.workspace === config.workspace);
          if (rows.length) {
            if (!providerId || rows.length !== 1 || rows[0].id !== providerId || rows[0].type !== name) throw fail('PROVIDER_CLEANUP_UNVERIFIED');
            await cli(['provider', 'delete', name], undefined, true);
            if ((await providers(true)).some(row => row.name === name)) throw fail('PROVIDER_CLEANUP_UNVERIFIED');
          }
        }
        if (profileAttempted) {
          const rows = (await profiles(true)).filter(row => row.id === name);
          if (rows.length) {
            if (rows.length !== 1 || rows[0].display_name !== `GroupWeave task ${name}`) throw fail('PROFILE_CLEANUP_UNVERIFIED');
            await cli(['provider', 'profile', 'delete', name], undefined, true);
            if ((await profiles(true)).some(row => row.id === name)) throw fail('PROFILE_CLEANUP_UNVERIFIED');
          }
        }
        if (dir) await rm(dir, { recursive: true, force: false });
        closed = true; active.delete(close);
      };
      active.add(close);
      try {
        dir = await mkdtemp(path.join(config.stateDir, 'task-'));
        const files = taskFiles(config, name, dir);
        ({ home, xdgConfigHome } = files);
        await mkdir(home, { mode: 0o700 }); await mkdir(xdgConfigHome, { mode: 0o700 });
        for (const kind of ['profile', 'policy', 'patch']) await writeFile(path.join(dir, `${kind}.json`), JSON.stringify(files[kind]), { mode: 0o600, flag: 'wx' });
        if ((await profiles(false)).some(row => row.id === name) || (await providers(false)).some(row => row.name === name)) throw fail('NAME_COLLISION');
        profileAttempted = true;
        await cli(['provider', 'profile', 'import', '--file', path.join(dir, 'profile.json')]);
        if ((await profiles(false)).filter(row => row.id === name && row.display_name === files.profile.display_name).length !== 1) throw fail('PROFILE_IMPORT_UNVERIFIED');
        providerAttempted = true;
        await cli(['provider', 'create', '--name', name, '--type', name, '--credential', 'GROUPWEAVE_MODEL_TOKEN'], lease.token);
        const rows = (await providers(false)).filter(row => row.name === name && row.type === name && row.workspace === config.workspace);
        if (rows.length !== 1 || !rows[0].credential_keys.includes('GROUPWEAVE_MODEL_TOKEN')) throw fail('PROVIDER_CREATE_UNVERIFIED');
        providerId = rows[0].id;
        signal.throwIfAborted();
        return { binding: {
          native: { cliPath: config.cliPath, workspace: config.workspace, image: config.image,
            policyPath: path.join(dir, 'policy.json'), home, xdgConfigHome, gatewayEndpoint: config.gatewayEndpoint, providers: [name] },
          dsh: { patchPath: path.join(dir, 'patch.json'), skillRoot: '/workspace/skills' },
          modelAccounting: lease.modelAccounting,
        }, close };
      } catch (error) { await close(); throw error; }
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      meter.close();
      const results = await Promise.allSettled([...active].map(close => close()));
      await app.close();
      if (results.some(result => result.status === 'rejected')) throw fail('CLEANUP_UNVERIFIED');
    },
  };
}

export async function loadDeployment(file) {
  if (!path.isAbsolute(file ?? '')) throw fail('CONFIG_PATH_INVALID');
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0
    || ![0, process.getuid()].includes(metadata.uid)) throw fail('CONFIG_PERMISSIONS');
  return createOpenShellSub2ApiBinding(JSON.parse(await readFile(file, 'utf8')));
}
