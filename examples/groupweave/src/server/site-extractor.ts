import { spawn } from 'node:child_process';
import { chmod, constants, mkdtemp, open, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const SITE_MEDIA_LIMIT = 10 * 1024 * 1024;
const COOKIE_FILE_LIMIT = 2 * 1024 * 1024;
const OUTPUT_LIMIT = 256 * 1024;
const MAX_RUNTIME_MS = 60_000;
const MAX_WORKSPACE_BYTES = 2 * SITE_MEDIA_LIMIT + COOKIE_FILE_LIMIT;

export type SiteName = 'bilibili' | 'douyin';
export type SiteExtraction = { title?: string; author?: string; thumbnail?: string; media: Buffer; mime: 'video/mp4' | 'video/webm' };
export type SiteExtractionOptions = {
  url: string;
  site: SiteName;
  ytDlpPath?: string;
  cookiesFile?: string;
  tempDir?: string;
  signal: AbortSignal;
};

export function buildYtDlpArgs(url: string, outputTemplate: string, cookieFile?: string, metadataOnly = false): string[] {
  const args = [
    '--ignore-config', '--no-config-locations', '--no-plugin-dirs', '--no-cache-dir',
    '--no-warnings', '--quiet', '--no-progress', '--no-playlist',
    '--retries', '0', '--fragment-retries', '0', '--extractor-retries', '0',
    '--file-access-retries', '0', '--socket-timeout', '15', '--max-filesize', '10M',
  ];
  if (cookieFile) args.push('--match-filters', "availability = 'public'");
  args.push(...(metadataOnly ? ['--skip-download', '--dump-single-json'] : [
    '--print-json', '--no-part', '-f', 'bv*[height<=480][filesize_approx<=8M]+ba[filesize_approx<=2M]/b[height<=480][filesize_approx<=10M]',
    '--merge-output-format', 'mp4',
  ]));
  args.push('-o', outputTemplate);
  if (cookieFile) args.push('--cookies', cookieFile);
  args.push('--', url);
  return args;
}

function noCredentialsEnv(workDir: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: workDir,
    TMPDIR: workDir,
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
  };
}

function publicVideoUrl(value: string, site: SiteName): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443') return false;
    const host = url.hostname.toLowerCase();
    if (site === 'bilibili') return host === 'bilibili.com' || host.endsWith('.bilibili.com') || host === 'b23.tv';
    return host === 'douyin.com' || host.endsWith('.douyin.com');
  } catch { return false; }
}

async function privateCookieCopy(source: string, workDir: string): Promise<string> {
  if (!path.isAbsolute(source)) throw new Error('cookie unavailable');
  let sourceHandle;
  try {
    sourceHandle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await sourceHandle.stat();
    const ownerUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (!before.isFile() || ownerUid === undefined || before.uid !== ownerUid || before.size < 1 || before.size > COOKIE_FILE_LIMIT
      || (before.mode & 0o077) !== 0 || (before.mode & 0o400) === 0 || (before.mode & 0o111) !== 0) throw new Error('cookie unavailable');
    const input = await sourceHandle.readFile();
    const after = await sourceHandle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error('cookie changed while reading');
    }
    const firstLine = input.subarray(0, Math.min(input.length, 512)).toString('utf8').split(/\r?\n/, 1)[0];
    if (!/^#(?: HTTP Cookie File| Netscape HTTP Cookie File)$/.test(firstLine)) throw new Error('cookie format');
    const target = path.join(workDir, 'cookies.txt');
    const targetHandle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { await targetHandle.writeFile(input); }
    finally { await targetHandle.close(); }
    await chmod(target, 0o600);
    return target;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('cookie')) throw error;
    throw new Error('cookie unavailable');
  } finally {
    await sourceHandle?.close().catch(() => undefined);
  }
}

function safeMediaMime(buffer: Buffer): 'video/mp4' | 'video/webm' | undefined {
  if (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4';
  if (buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return 'video/webm';
}

async function runYtDlp(binary: string, args: string[], workDir: string, signal: AbortSignal, monitorSize: boolean): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const child = spawn(binary, args, {
    cwd: workDir,
    env: noCredentialsEnv(workDir),
    shell: false,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stopTree = () => {
    if (process.platform !== 'win32' && child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); return; } catch { /* Fall back to the direct child. */ }
    }
    child.kill('SIGKILL');
  };
  let stdout = '';
  let stderr = '';
  let outputTooLarge = false;
  const append = (current: string, chunk: Buffer) => {
    const next = current + chunk.toString('utf8');
    if (Buffer.byteLength(next) > OUTPUT_LIMIT) {
      outputTooLarge = true;
      stopTree();
      return current;
    }
    return next;
  };
  child.stdout?.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
  let tooLarge = false;
  const sizeMonitor = monitorSize ? setInterval(() => {
    void readdir(workDir, { withFileTypes: true }).then(entries => Promise.all(entries.filter(entry => entry.isFile() && entry.name !== 'cookies.txt').map(async entry => {
      const info = await stat(path.join(workDir, entry.name)).catch(() => undefined);
      return info?.size ?? 0;
    }))).then(sizes => {
      if (sizes.reduce((sum, size) => sum + size, 0) > MAX_WORKSPACE_BYTES) {
        tooLarge = true;
        stopTree();
      }
    }).catch(() => undefined);
  }, 100) : undefined;
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; stopTree(); }, MAX_RUNTIME_MS);
  const abort = () => stopTree();
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) abort();
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    if (signal.aborted) throw new Error('cancelled');
    if (timedOut) throw new Error('site extraction timed out');
    if (tooLarge) throw new Error('media size limit');
    if (outputTooLarge) throw new Error('extractor output limit');
    return { stdout, stderr, code };
  } finally {
    clearTimeout(timeout);
    if (sizeMonitor) clearInterval(sizeMonitor);
    signal.removeEventListener('abort', abort);
  }
}

function parseInfoJson(stdout: string): Record<string, unknown> {
  const line = stdout.split(/\r?\n/).filter(value => value.trim()).at(-1);
  if (!line) throw new Error('only publicly available videos are supported or no supported media was found');
  try { return JSON.parse(line) as Record<string, unknown>; }
  catch { throw new Error('invalid extractor metadata'); }
}

function checkExtractorResult(result: { code: number | null; stderr: string }) {
  if (result.code === 0) return;
  const lower = result.stderr.toLowerCase();
  if (/cookie|login|authentication|fresh cookies|sign in/.test(lower)) throw new Error('site requires fresh cookies or authorization');
  if (/availability|match filter|filtered/.test(lower)) throw new Error('only publicly available videos are supported');
  if (/ffmpeg/.test(lower)) throw new Error('ffmpeg required to combine video and audio');
  if (/max-filesize|file size/.test(lower)) throw new Error('media size limit');
  throw new Error('site extraction failed');
}

export async function extractPublicSiteVideo(options: SiteExtractionOptions): Promise<SiteExtraction> {
  const { url, site, signal } = options;
  if (!publicVideoUrl(url, site)) throw new Error('unsupported site URL');
  const workDir = await mkdtemp(path.join(options.tempDir ?? tmpdir(), 'groupweave-parse-'));
  await chmod(workDir, 0o700);
  try {
    const cookie = options.cookiesFile ? await privateCookieCopy(options.cookiesFile, workDir) : undefined;
    const binary = options.ytDlpPath?.trim() || 'yt-dlp';
    const outputTemplate = path.join(workDir, 'media.%(ext)s');
    if (cookie) {
      const preflight = await runYtDlp(binary, buildYtDlpArgs(url, outputTemplate, cookie, true), workDir, signal, false);
      checkExtractorResult(preflight);
      const preflightInfo = parseInfoJson(preflight.stdout);
      if (preflightInfo.availability !== 'public') throw new Error('only publicly available videos are supported');
    }
    const result = await runYtDlp(binary, buildYtDlpArgs(url, outputTemplate, cookie), workDir, signal, true);
    checkExtractorResult(result);
    const info = parseInfoJson(result.stdout);
    if (info.availability !== undefined && info.availability !== 'public' || cookie && info.availability !== 'public') {
      throw new Error('only publicly available videos are supported');
    }
    const files = (await readdir(workDir, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name !== 'cookies.txt');
    if (files.length !== 1 || files[0].name.endsWith('.json')) throw new Error('missing media file');
    const mediaPath = path.join(workDir, files[0].name);
    const mediaStat = await stat(mediaPath);
    if (mediaStat.size < 1 || mediaStat.size > SITE_MEDIA_LIMIT) throw new Error('media size limit');
    const media = await readFile(mediaPath);
    const mime = safeMediaMime(media);
    if (!mime) throw new Error('unsupported media format');
    return {
      title: typeof info.title === 'string' ? info.title.slice(0, 300) : undefined,
      author: typeof info.uploader === 'string' ? info.uploader.slice(0, 160)
        : typeof info.channel === 'string' ? info.channel.slice(0, 160) : undefined,
      thumbnail: typeof info.thumbnail === 'string' ? info.thumbnail : undefined,
      media,
      mime,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
