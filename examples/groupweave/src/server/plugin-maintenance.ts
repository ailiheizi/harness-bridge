import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { Context } from 'koishi';
import type NodeLoader from '@koishijs/loader';
const require = createRequire(import.meta.url);
const { default: Loader } = require('@koishijs/loader') as typeof import('@koishijs/loader');
const { Installer } = require('@koishijs/plugin-market') as typeof import('@koishijs/plugin-market');
export interface PluginMaintenance {
  status(): Promise<unknown>;
  install(name: string, version: string): Promise<unknown>;
  configure(key: string, config: Record<string, unknown>, enabled: boolean): Promise<unknown>;
}
export async function createPluginMaintenance(app: Context, loader: NodeLoader & { restartRequired: boolean }): Promise<PluginMaintenance> {
  // Installer service only: no Console server, login, or market websocket API.
  class DataInstaller extends Installer {
    override get cwd() { return dirname(loader.filename); }
    override async getDeps() {
      const deps = await super.getDeps();
      const local = createRequire(this.cwd + '/package.json');
      for (const [name, dep] of Object.entries(deps)) {
        try { dep.resolved = JSON.parse(await readFile(local.resolve(name + '/package.json'), 'utf8')).version; }
        catch { delete dep.resolved; }
      }
      return deps;
    }
    override exec(args: string[]) {
      return super.exec(['--prefix', this.cwd, '--ignore-scripts', '--omit=peer', ...args]);
    }
  }
  const installer = new DataInstaller(app, { endpoint: 'https://registry.npmjs.org', timeout: 10000 });
  await installer.start();
  if (installer.cwd !== dirname(loader.filename)) throw new Error('Installer data directory mismatch');
  let busy = false;
  const exclusive = async <T>(fn: () => Promise<T>) => {
    if (busy) throw Object.assign(new Error('插件维护操作正在进行，请稍后重试。'), { statusCode: 409 });
    busy = true;
    try { return await fn(); } finally { busy = false; }
  };
  const status = async () => ({ busy, restartRequired: loader.restartRequired,
    dependencies: await installer.getDeps(),
    plugins: Object.entries(loader.config.plugins ?? {}).map(([key, config]) => {
      const fork = loader.entry.scope[Loader.kRecord]?.[key.replace(/^~/, '')];
      return { key, enabled: !key.startsWith('~'), status: fork ? ['pending', 'loading', 'active', 'failed', 'disposed'][fork.status] : 'not-loaded', config };
    }),
  });
  return {
    status,
    install: (name, version) => exclusive(async () => {
      if (!/^(@[a-z0-9-]+\/)?koishi-plugin-[a-z0-9-]+$|^@koishijs\/plugin-[a-z0-9-]+$/.test(name) || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(version)) {
        throw Object.assign(new Error('仅允许可信 npm 插件名与精确版本。'), { statusCode: 400 });
      }
      const packages = await installer.getPackage(name);
      if (!packages?.[version]) throw Object.assign(new Error('npm 未提供此兼容版本。'), { statusCode: 400 });
      let previous = (await installer.getDeps())[name]?.resolved;
      if (!previous) {
        // Built-in image packages are outside the managed manifest, but may
        // already be loaded and cached by this runtime.
        try { previous = (require(name + '/package.json') as { version: string }).version; }
        catch { /* A genuinely new plugin has no prior runtime version. */ }
      }
      const code = await installer.install({ [name]: version }, true);
      if (code !== 0) throw new Error('npm 安装失败；依赖清单可能已写入，请检查后重试。');
      if (previous && previous !== version) loader.restartRequired = true;
      return status();
    }),
    configure: (key, config, enabled) => exclusive(async () => {
      if (!/^(@[a-z0-9-]+\/)?[a-z0-9-]+(?::[a-z0-9-]+)?$/.test(key) || ['group', 'market', 'console'].includes(key.split(':')[0]) || JSON.stringify(config).length > 32768) throw Object.assign(new Error('插件键或配置无效。'), { statusCode: 400 });
      const plugins = loader.config.plugins ??= {};
      loader.unload(loader.entry, key);
      delete plugins[key]; delete plugins['~' + key];
      plugins[(enabled ? '' : '~') + key] = config;
      await loader.writeConfig();
      if (enabled) {
        const fork = await loader.reload(loader.entry, key, config);
        if (!fork) throw new Error('配置已保存，但原生 Loader 未能加载插件。');
        await new Promise(resolve => setTimeout(resolve, 0));
        if (fork.status === 3) throw new Error('配置已保存，但插件启动失败。');
      }
      return status();
    }),
  };
}
