import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import axios from 'axios';
import { installSiteParserCommands } from '../src/server/koishi-site-parser.js';
import { buildYtDlpArgs, extractPublicSiteVideo } from '../src/server/site-extractor.js';

function harness(options: Parameters<typeof installSiteParserCommands>[1] = { authorize: () => false }) {
  const commands = new Map<string, any>();
  const ctx: any = { on() {}, command(name: string) { const command = { name, aliases: [] as string[], handler: undefined as any, action(fn: any) { this.handler = fn; return this; }, alias(value: string) { this.aliases.push(value); return this; } }; commands.set(name.split(' ')[0], command); return command; } };
  installSiteParserCommands(ctx, options);
  const sent: any[] = [];
  const session: any = {
    platform: 'telegram', type: 'interaction/command', channelId: '-10042', guildId: '-10042', messageId: '23', selfId: 'bot',
    event: { user: { id: '7' }, _data: { message: { message_id: 23, chat: { id: -10042, type: 'supergroup' }, from: { id: 7 } } } },
    send: async (content: unknown) => { sent.push(content); return [{ id: String(sent.length) }]; },
  };
  return { commands, session, sent };
}

test('registers the manual command and its Chinese alias', () => {
  const { commands } = harness();
  assert.ok(commands.has('parse'));
  assert.equal(commands.get('parse').name, 'parse [url:text]');
  assert.ok(commands.get('parse').aliases.includes('链接解析'));
});

test('builds yt-dlp arguments with no config, plugins, playlists, or unbounded retries', () => {
  const args = buildYtDlpArgs('https://www.douyin.com/video/1234567890123', '/tmp/private/media.%(ext)s', '/tmp/private/cookies.txt');
  for (const option of ['--ignore-config', '--no-config-locations', '--no-plugin-dirs', '--no-playlist', '--retries', '0', '--max-filesize', '10M', '--socket-timeout', '15', '--cookies', '/tmp/private/cookies.txt']) {
    assert.ok(args.includes(option), `expected argument ${option}`);
  }
  assert.ok(args.includes('bv*[height<=480][filesize_approx<=8M]+ba[filesize_approx<=2M]/b[height<=480][filesize_approx<=10M]'));
  assert.ok(args.includes('--merge-output-format'));
  assert.ok(args.includes("availability = 'public'"));
  assert.equal(args.at(-1), 'https://www.douyin.com/video/1234567890123');
  assert.equal(buildYtDlpArgs('https://www.bilibili.com/video/BV13x41117TL', '/tmp/media.%(ext)s').includes('--match-filters'), false);
});

test('runs yt-dlp with a private cookie copy, caps output, requires public availability, and removes its temp files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'groupweave-site-test-'));
  const work = path.join(root, 'work');
  const cookies = path.join(root, 'source-cookies.txt');
  const executable = path.join(root, 'yt-dlp-stub');
  await (await import('node:fs/promises')).mkdir(work);
  await writeFile(cookies, '# Netscape HTTP Cookie File\n.douyin.com\tTRUE\t/\tTRUE\t0\ttoken\tfixture-secret\n', { mode: 0o600 });
  await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const cookiePath = args[args.indexOf('--cookies') + 1];
const template = args[args.indexOf('-o') + 1];
if (!args.includes("availability = 'public'") || !args.includes('--no-plugin-dirs')) process.exit(7);
const stat = fs.statSync(cookiePath);
if ((stat.mode & 0o777) !== 0o600 || fs.readFileSync(cookiePath, 'utf8').includes('fixture-secret') === false) process.exit(8);
fs.writeFileSync(template.replace('%(ext)s', 'mp4'), Buffer.from([0,0,0,12,0x66,0x74,0x79,0x70,0x69,0x73,0x6f,0x6d]));
process.stdout.write(JSON.stringify({ availability: 'public', title: 'stub title', uploader: 'stub author' }) + '\\n');
`);
  await chmod(executable, 0o700);
  const controller = new AbortController();
  try {
    const result = await extractPublicSiteVideo({ url: 'https://www.douyin.com/video/1234567890123', site: 'douyin', ytDlpPath: executable, cookiesFile: cookies, tempDir: work, signal: controller.signal });
    assert.equal(result.title, 'stub title');
    assert.equal(result.author, 'stub author');
    assert.equal(result.mime, 'video/mp4');
    assert.equal(result.media.length, 12);
    assert.deepEqual(await readdir(work), []);
    assert.match(await readFile(cookies, 'utf8'), /fixture-secret/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects cookie files that are shared-readable or symbolic links before starting yt-dlp', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'groupweave-cookie-check-'));
  const work = path.join(root, 'work');
  const cookies = path.join(root, 'cookies.txt');
  const alias = path.join(root, 'cookies-link.txt');
  await (await import('node:fs/promises')).mkdir(work);
  await writeFile(cookies, '# Netscape HTTP Cookie File\nfixture\n');
  await chmod(cookies, 0o644);
  await (await import('node:fs/promises')).symlink(cookies, alias);
  const signal = new AbortController().signal;
  const input = { url: 'https://www.douyin.com/video/1234567890123', site: 'douyin' as const, ytDlpPath: '/definitely/not-run', tempDir: work, signal };
  try {
    await assert.rejects(extractPublicSiteVideo({ ...input, cookiesFile: cookies }), /cookie/i);
    await chmod(cookies, 0o600);
    await assert.rejects(extractPublicSiteVideo({ ...input, cookiesFile: alias }), /cookie/i);
    assert.deepEqual(await readdir(work), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('uses direct extraction when no third-party API is configured', async () => {
  const calls: any[] = [];
  const { commands, session, sent } = harness({ authorize: () => true, directExtract: async input => {
    calls.push(input);
    return { title: 'direct title', author: 'direct author', media: Buffer.from([0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70]), mime: 'video/mp4' };
  } });
  await commands.get('parse').handler({ session }, 'https://www.bilibili.com/video/BV1xx411c7mD');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://www.bilibili.com/video/BV1xx411c7mD');
  assert.equal(calls[0].site, 'bilibili');
  assert.match(String(sent[0]), /direct title/);
  assert.match(JSON.stringify(sent[1]), /video\/mp4/);
});

test('partial API configuration fails closed rather than silently switching providers', async () => {
  const { commands, session, sent } = harness({ authorize: () => true, apiUrl: 'https://parser.example.test/parse' });
  await commands.get('parse').handler({ session }, 'https://www.bilibili.com/video/BV1xx411c7mD');
  assert.match(JSON.stringify(sent), /配置不完整/);
});

test('rejects non-Bilibili and non-Douyin URLs without calling the API', async () => {
  const { commands, session, sent } = harness({ authorize: () => true, apiUrl: 'https://api.example.org/parse', apiKey: 'fixture-key' });
  await commands.get('parse').handler({ session }, 'https://example.com/not-a-supported-video');
  assert.match(String(sent[0]), /B站|抖音|支持/);
});

test('calls only the configured API with its key in X-API-Key and uses the upstream parser', async () => {
  const originalCreate = axios.create;
  const requests: any[] = [];
  (axios as any).create = () => ({ get: async (url: string, config: any) => {
    requests.push({ url, config });
    return { status: 200, data: { code: 200, data: { type: 'video', title: 'fixture title', author: 'fixture author', url: 'http://127.0.0.1/private.mp4' } } };
  } });
  try {
    const { commands, session, sent } = harness({ authorize: () => true, apiUrl: 'https://parser.example.test/parse', apiKey: 'fixture-secret' });
    await commands.get('parse').handler({ session }, 'https://www.bilibili.com/video/BV1xx411c7mD');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://parser.example.test/parse');
    assert.equal(requests[0].config.params.url, 'https://www.bilibili.com/video/BV1xx411c7mD');
    assert.equal(requests[0].config.headers['X-API-Key'], 'fixture-secret');
    assert.equal(requests[0].config.params.key, undefined);
    assert.match(String(sent[0]), /fixture title/);
    assert.match(String(sent[1]), /媒体获取或投递失败/);
  } finally { (axios as any).create = originalCreate; }
});

test('sends returned image and video bytes as ordinary Koishi media elements', async () => {
  const originalCreate = axios.create;
  const originalGet = (axios as any).get;
  const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  const video = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  (axios as any).create = () => ({ get: async () => ({ status: 200, data: { code: 200, data: {
    type: 'video', title: 'fixture title', author: 'fixture author', cover: 'https://media.example.test/cover.png', video: 'https://media.example.test/video.mp4',
  } } }) });
  (axios as any).get = async (url: string) => ({ data: url.endsWith('.png') ? image : video });
  try {
    const { commands, session, sent } = harness({ authorize: () => true, apiUrl: 'https://parser.example.test/parse', apiKey: 'fixture-secret' });
    await commands.get('parse').handler({ session }, 'https://www.bilibili.com/video/BV1xx411c7mD');
    assert.equal(sent.length, 3);
    assert.match(JSON.stringify(sent[1]), /image/);
    assert.match(JSON.stringify(sent[2]), /video/);
    assert.match(JSON.stringify(sent[1]), /image\/png/);
    assert.match(JSON.stringify(sent[2]), /video\/mp4/);
    assert.ok(JSON.stringify(sent[1]).includes(image.toString('base64')));
    assert.ok(JSON.stringify(sent[2]).includes(video.toString('base64')));
  } finally { (axios as any).create = originalCreate; (axios as any).get = originalGet; }
});

test('rejects a duplicate in-flight parse by the same Telegram caller without starting another API request', async () => {
  const originalCreate = axios.create;
  let release!: (value: any) => void;
  let requests = 0;
  (axios as any).create = () => ({ get: async () => { requests++; return new Promise(resolve => { release = resolve; }); } });
  try {
    const { commands, session, sent } = harness({ authorize: () => true, apiUrl: 'https://parser.example.test/parse', apiKey: 'fixture-secret' });
    const first = commands.get('parse').handler({ session }, 'https://www.bilibili.com/video/BV1xx411c7mD');
    await new Promise(resolve => setImmediate(resolve));
    await commands.get('parse').handler({ session }, 'https://www.bilibili.com/video/BV1xx411c7mD');
    assert.match(JSON.stringify(sent), /繁忙/);
    assert.equal(requests, 1);
    release({ status: 200, data: { code: 200, data: { type: 'video', title: 'fixture', url: 'http://127.0.0.1/x.mp4' } } });
    await first;
  } finally { (axios as any).create = originalCreate; }
});

test('stops after an unknown media send receipt instead of attempting another upload', async () => {
  const originalCreate = axios.create;
  const originalGet = (axios as any).get;
  let mediaSends = 0;
  const media = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  (axios as any).create = () => ({ get: async () => ({ status: 200, data: { code: 200, data: {
    type: 'image', title: 'fixture title', images: ['https://media.example.test/1.png', 'https://media.example.test/2.png'],
  } } }) });
  (axios as any).get = async () => ({ data: media });
  try {
    const { commands, session, sent } = harness({ authorize: () => true, apiUrl: 'https://parser.example.test/parse', apiKey: 'fixture-secret' });
    session.send = async (content: any) => {
      sent.push(content);
      if (JSON.stringify(content).includes('image/png')) { mediaSends++; throw new Error('receipt unknown'); }
      return [{ id: String(sent.length) }];
    };
    await commands.get('parse').handler({ session }, 'https://www.douyin.com/video/1234567890123');
    assert.equal(mediaSends, 1);
    assert.match(JSON.stringify(sent), /结果未知/);
  } finally { (axios as any).create = originalCreate; (axios as any).get = originalGet; }
});

test('uses the verified same-chat Telegram reply text when parse has no URL argument', async () => {
  const originalCreate = axios.create;
  let requestedUrl = '';
  (axios as any).create = () => ({ get: async (_url: string, config: any) => {
    requestedUrl = config.params.url;
    return { status: 200, data: { code: 200, data: { type: 'video', title: 'quoted fixture', url: 'http://127.0.0.1/private.mp4' } } };
  } });
  try {
    const { commands, session } = harness({ authorize: () => true, apiUrl: 'https://parser.example.test/parse', apiKey: 'fixture-secret' });
    session.event._data.message.reply_to_message = { chat: { id: -10042, type: 'supergroup' }, text: 'https://v.douyin.com/abc/' };
    await commands.get('parse').handler({ session });
    assert.equal(requestedUrl, 'https://v.douyin.com/abc/');
  } finally { (axios as any).create = originalCreate; }
});

test('rejects bracketed loopback and IPv4-mapped IPv6 media URLs before download', async () => {
  const originalCreate = axios.create;
  const originalGet = (axios as any).get;
  let mediaRequests = 0;
  (axios as any).create = () => ({ get: async () => ({ status: 200, data: { code: 200, data: {
    type: 'video', title: 'fixture', cover: 'https://[::1]/cover.png', video: 'https://[::ffff:127.0.0.1]/video.mp4',
  } } }) });
  (axios as any).get = async () => { mediaRequests++; throw new Error('must not request private IP'); };
  try {
    const { commands, session, sent } = harness({ authorize: () => true, apiUrl: 'https://parser.example.test/parse', apiKey: 'fixture-secret' });
    await commands.get('parse').handler({ session }, 'https://www.bilibili.com/video/BV1xx411c7mD');
    assert.equal(mediaRequests, 0);
    assert.match(JSON.stringify(sent), /不完整/);
  } finally { (axios as any).create = originalCreate; (axios as any).get = originalGet; }
});
