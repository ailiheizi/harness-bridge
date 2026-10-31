import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Context, Session } from 'koishi';
import { installMediaCommands } from '../src/server/koishi-media.js';

test('M6 file paths: traversal and absolute Telegram attachment names never select a host file', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'groupweave-m6-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secretFile = path.join(root, 'synthetic-host-secret.txt');
  const secret = 'M6_SYNTHETIC_HOST_CANARY_ONLY';
  await writeFile(secretFile, secret, { mode: 0o600 });
  const traversal = path.relative(process.cwd(), secretFile);
  assert.ok(traversal.startsWith('../'));
  assert.equal(path.resolve(process.cwd(), traversal), secretFile);
  for (const fileName of [traversal, secretFile]) {
    const commands = new Map<string, (argv: { session: Session }) => Promise<unknown>>();
    const ctx = { command(name: string) { return { action(handler: (argv: { session: Session }) => Promise<unknown>) {
      commands.set(name.split(' ')[0], handler);
    } }; } };
    const acquired: unknown[] = [];
    const sent: any[] = [];
    const attachmentText = 'Only these authorized Telegram attachment bytes may be returned.';
    const session = {
      platform: 'telegram', type: 'interaction/command', guildId: '-10042', channelId: '-10042',
      event: { user: { id: '7', isBot: false }, _data: { message: {
        message_id: 17, chat: { id: -10042, type: 'supergroup' }, from: { id: 7, is_bot: false },
        document: { file_id: 'synthetic-authorized-file', file_name: fileName, file_size: attachmentText.length },
      } } },
      bot: {
        internal: { getFile: async (payload: unknown) => { acquired.push(payload); return { file_path: 'documents/authorized-file.txt', file_size: attachmentText.length }; } },
        $getFile: async (downloadPath: string) => {
          acquired.push(downloadPath);
          assert.equal(downloadPath, 'documents/authorized-file.txt');
          return { data: Buffer.from(attachmentText, 'utf8') };
        },
      },
      send: async (elements: unknown) => { sent.push(elements); return ['synthetic-receipt']; },
    } as unknown as Session;
    installMediaCommands(ctx as unknown as Context, { authorize: async () => true });
    await commands.get('fileinfo')!({ session });
    assert.deepEqual(acquired, [], 'attachment name inspection must not acquire a host file');
    assert.equal(sent[0][1].type, 'text');
    assert.ok(!sent[0][1].attrs.content.includes('/'), 'the displayed filename has path separators removed');
    sent.length = 0;
    await commands.get('readfile')!({ session });
    assert.deepEqual(acquired, [{ file_id: 'synthetic-authorized-file' }, 'documents/authorized-file.txt']);
    assert.equal(sent.length, 1);
    assert.equal(sent[0][1].attrs.content, attachmentText);
    assert.ok(!JSON.stringify(sent).includes(secret), 'no host canary is released');
    assert.equal(await readFile(secretFile, 'utf8'), secret, 'the real synthetic host file remains unchanged');
  }
});
