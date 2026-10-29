import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

const root = process.env.FILE_TYPE_TEST_MODULE_DIR ?? fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(join(root, 'package.json'));
const fileTypePath = require.resolve('file-type');
const adapterPath = require.resolve('@cordisjs/plugin-http/adapter');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8oUAAAAASUVORK5CYII=', 'base64');
// This is the actual 55-byte reproducer published in upstream commit 319abf8.
const zeroAsf = Buffer.from('3026b2758e66cf11a6d9000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000', 'hex');

/** A detector regression must never wedge the test process/event loop. */
function detect(data: { buffers?: string[]; files?: string[]; esmAdapterPath?: string }): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const detector = require(workerData.fileTypePath);
        const values = [];
        for (const hex of workerData.buffers ?? []) values.push(await detector.fromBuffer(Buffer.from(hex, 'hex')));
        if (workerData.files) {
          const adapter = workerData.esmAdapterPath ? await import(workerData.esmAdapterPath) : require(workerData.adapterPath);
          for (const file of workerData.files) {
            const value = await adapter.loadFile(file);
            values.push({ type: value.type, mime: value.mime, filename: value.filename, data: Buffer.from(value.data).toString('hex') });
          }
        }
        parentPort.postMessage({ ok: true, values });
      })().catch(error => parentPort.postMessage({ ok: false, message: error.message }));
    `, { eval: true, workerData: { ...data, fileTypePath, adapterPath } });
    let settled = false;
    const finish = async (value: unknown, error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await worker.terminate();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => void finish(undefined, new Error('file-type detector worker exceeded 2.5 seconds')), 2_500);
    worker.once('message', message => void finish(message.ok ? message.values : undefined, message.ok ? undefined : new Error(message.message)));
    worker.once('error', error => void finish(undefined, error));
    worker.once('exit', code => { if (!settled) void finish(undefined, new Error(`detector worker exited before evidence: ${code}`)); });
  });
}

test('the installed file-type stays at compatible 16.5.4 with the checked-in mandatory patch', async () => {
  assert.equal(require('file-type/package.json').version, '16.5.4');
  assert.equal(typeof require('file-type').fromBuffer, 'function');
  const source = await readFile(require.resolve('file-type/core'), 'utf8');
  assert.match(source, /!Number\.isFinite\(payload\) \|\| payload < 0/);
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.devDependencies['patch-package'], '8.0.1');
  assert.equal(pkg.dependencies['patch-package'], undefined, 'the patch installer is build-only');
  assert.equal(pkg.dependencies.tsx, '4.23.15', 'the startup runner stays in production');
  assert.match(pkg.scripts.postinstall, /accessSync\('patches\/file-type\+16\.5\.4\.patch'\)/);
  assert.match(pkg.scripts.postinstall, /patch-package --error-on-fail/);
  assert.ok((await readFile(join(root, 'patches/file-type+16.5.4.patch'), 'utf8')).includes('payload < 0'));
});

test('real malformed ASF reproducer and every below-header object size complete without an infinite loop', async () => {
  assert.equal(zeroAsf.length, 55);
  const variants = Array.from({ length: 24 }, (_, size) => {
    const buffer = Buffer.from(zeroAsf);
    buffer.writeBigUInt64LE(BigInt(size), 46);
    return buffer.toString('hex');
  });
  const values = await detect({ buffers: variants }) as unknown[];
  assert.equal(values.length, 24);
  for (const value of values) assert.deepEqual(value, { ext: 'asf', mime: 'application/vnd.ms-asf' });
});

test('normal PNG and valid ASF audio/video identification remain compatible', async () => {
  const asf = (mediaGuid: string) => {
    const buffer = Buffer.alloc(80);
    zeroAsf.copy(buffer, 0, 0, 30);
    Buffer.from('9107dcb7b7a9cf118ee600c00c205365', 'hex').copy(buffer, 30);
    buffer.writeBigUInt64LE(40n, 46);
    Buffer.from(mediaGuid, 'hex').copy(buffer, 54);
    return buffer.toString('hex');
  };
  assert.deepEqual(await detect({ buffers: [png.toString('hex'), asf('409e69f84d5bcf11a8fd00805f5c442b'), asf('c0ef19bc4d5bcf11a8fd00805f5c442b')] }), [
    { ext: 'png', mime: 'image/png' }, { ext: 'asf', mime: 'audio/x-ms-asf' }, { ext: 'asf', mime: 'video/x-ms-asf' },
  ]);
});

for (const variant of ['commonjs', 'esm'] as const) {
  test(`the real Koishi/Cordis HTTP ${variant} loadFile API handles local PNG and malformed ASF with unchanged bytes`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'groupweave-file-type-'));
    const pngFile = join(dir, 'normal.png');
    const asfFile = join(dir, 'malformed.asf');
    try {
      await writeFile(pngFile, png);
      await writeFile(asfFile, zeroAsf);
      // Only synthetic local files. No HTTP request, credentials or attachment
      // obtained from an actual Telegram member is used in this regression.
      const result = await detect({
        files: [pathToFileURL(pngFile).href, pathToFileURL(asfFile).href],
        ...(variant === 'esm' ? { esmAdapterPath: pathToFileURL(join(root, 'node_modules/@cordisjs/plugin-http/lib/adapter/node.js')).href } : {}),
      }) as { type: string; mime: string; filename: string; data: string }[];
      assert.equal(result[0].type, 'image/png');
      assert.equal(result[0].mime, 'image/png');
      assert.equal(result[0].filename, 'normal.png');
      assert.equal(result[0].data, png.toString('hex'));
      assert.equal(result[1].mime, 'application/vnd.ms-asf');
      assert.equal(result[1].data, zeroAsf.toString('hex'));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}
