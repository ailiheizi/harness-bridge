// Documentation build only. No bridge runtime imports or credentials.
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';

const toolRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(toolRoot, '../..');
const packagePath = join(toolRoot, 'node_modules/@mermaid-js/mermaid-cli/package.json');
const metadata = JSON.parse(await readFile(packagePath, 'utf8'));
const cli = resolve(dirname(packagePath), metadata.bin.mmdc);
const temporary = await mkdtemp(join(tmpdir(), 'harness-bridge-diagrams-'));
try {
  const browserConfig = join(temporary, 'browser.json');
  await writeFile(browserConfig, JSON.stringify({
    ...(process.env.PUPPETEER_EXECUTABLE_PATH ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH } : {}),
  }));
  for (const name of ['architecture', 'isolation', 'task-lifecycle', 'capacity-reuse']) {
    const source = join(repoRoot, 'assets', `${name}.mmd`);
    const output = join(repoRoot, 'assets', `${name}.svg`);
    const child = spawnSync(process.execPath, [cli,
      '--input', source, '--output', output,
      '--configFile', join(toolRoot, 'mermaid.json'),
      '--puppeteerConfigFile', browserConfig,
      '--backgroundColor', 'white', '--size', '1600', '--no-font-embed',
      '--iconPacks', '@iconify-json/lucide', '@iconify-json/simple-icons',
    ], { cwd: toolRoot, stdio: 'inherit', timeout: 90_000 });
    if (child.error) throw child.error;
    if (child.status !== 0) throw new Error(`Mermaid render failed: ${name}`);
    // Preserve whitespace between Mermaid's word-level SVG tspans across
    // browser and librsvg renderers. This changes export semantics, not layout.
    const svg = await readFile(output, 'utf8');
    await writeFile(output, svg.replace('<svg ', '<svg xml:space="preserve" '));
    // Pure SVG labels let PNG export use the same generated diagram, without
    // a separate manually maintained drawing or a browser screenshot.
    await sharp(output, { density: 144 }).flatten({ background: '#ffffff' }).png().toFile(join(repoRoot, 'assets', `${name}.png`));
    console.log(`Rendered assets/${name}.{svg,png} from Mermaid`);
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
