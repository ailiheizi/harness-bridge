import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const project = process.cwd();
const native = ['compose.yaml', 'compose.koishi.yaml'];

function compose(files: string[], env: Record<string, string>) {
  const args = ['compose', ...files.flatMap(file => ['-f', file]), 'config', '--format', 'json'];
  return spawnSync('docker', args, { cwd: project, encoding: 'utf8', env: { ...process.env, PUBLIC_ORIGIN: 'https://example.invalid', ...env } });
}

const hasCompose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;

test('Compose profiles overlay mounts the manifest read-only and defaults to no profiles', { skip: !hasCompose && 'Docker Compose CLI is unavailable (daemon not required)' }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'groupweave-profiles-'));
  try {
    const noOverlay = compose(native, { SANDBOX_AI_MODEL_PROFILES: '', SANDBOX_AI_MODEL_PROFILES_DIR: '' });
    assert.equal(noOverlay.status, 0, noOverlay.stderr);
    const defaultService = JSON.parse(noOverlay.stdout).services.groupweave;
    assert.equal(defaultService.environment.SANDBOX_AI_MODEL_PROFILES, '');
    assert.ok(!defaultService.volumes.some((volume: { target: string }) => volume.target === '/run/groupweave/model-profiles'));

    const overlay = compose([...native, 'compose.koishi.profiles.yaml'], { SANDBOX_AI_MODEL_PROFILES_DIR: temp });
    assert.equal(overlay.status, 0, overlay.stderr);
    const service = JSON.parse(overlay.stdout).services.groupweave;
    assert.equal(service.environment.SANDBOX_AI_MODEL_PROFILES, '/run/groupweave/model-profiles/profiles.json');
    const mount = service.volumes.find((volume: { target: string }) => volume.target === '/run/groupweave/model-profiles');
    assert.ok(mount);
    assert.equal(mount.source, temp);
    assert.equal(mount.read_only, true);
    assert.equal(mount.bind?.create_host_path, false);

    const missing = compose([...native, 'compose.koishi.profiles.yaml'], { SANDBOX_AI_MODEL_PROFILES_DIR: '' });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /SANDBOX_AI_MODEL_PROFILES_DIR/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
