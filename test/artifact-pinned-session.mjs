// Optional exact upstream seam check. Install only the pinned Session package
// in a temporary directory, then set HARNESS_BRIDGE_DSH_TEST_MODULES to its
// node_modules directory. No provider, server, model request or Docker call.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFile, mkdtemp, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const moduleRoot = process.env.HARNESS_BRIDGE_DSH_TEST_MODULES;
if (!moduleRoot || !path.isAbsolute(moduleRoot)) throw Error('Set HARNESS_BRIDGE_DSH_TEST_MODULES to the pinned install node_modules directory');
const require = createRequire(path.join(moduleRoot, '..', 'package.json'));
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
const { default: SessionStore } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session')).href);
const version = JSON.parse(await readFile(path.join(moduleRoot, '@deepseek-ai/dsh-session/package.json'), 'utf8')).version;
assert.equal(version, '0.2.0-rc.2');
const remote = await mkdtemp(path.join(os.tmpdir(), 'dsh-pinned-export-'));
// Relocate only the workload's fixed directory for this host-side test.
const code = (await readFile(new URL('../examples/groupweave/deploy/dsh/result-export.mjs', import.meta.url), 'utf8')).replaceAll('/workspace/exports', remote);
const plugin = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const ctx = new Context();
await ctx.plugin(SessionStore);
await ctx.plugin(plugin);
try {
  const session = ctx.sessions.create('pinned-session');
  for (const [turn, text, kind, exists] of [[1, '# Native committed text', 'completed', true], [2, 'failed turn', 'interrupted', false], [3, 'x'.repeat(64001), 'completed', false]]) {
    session.append('turn/start', { turn });
    session.append('step/start', { turn, step: 1 });
    session.append('assistant/message', { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] }, stream: [] }, { surfaceOp: 'append' });
    session.append('step/end', { turn, step: 1 });
    session.append('turn/end', { turn, reason: { kind } });
    await ctx.sessions.flush(session);
    if (exists) assert.equal(await readFile(path.join(remote, 'result.md'), 'utf8'), text);
    else await assert.rejects(access(path.join(remote, 'result.md')));
  }
  console.log('PASS pinned DSH Session events → real observer → file; interrupted/oversized turns export nothing');
} finally {
  await ctx.fiber.dispose();
  await rm(remote, { recursive: true, force: true });
}
