import { createRequire } from 'node:module';
import path from 'node:path';
import type { Context } from 'koishi';

// Keep the loader on the same CommonJS Koishi core used by the existing native
// plugins and app integrations.
const require = createRequire(import.meta.url);
const { default: NodeLoader } = require('@koishijs/loader') as typeof import('@koishijs/loader');
const { Logger } = require('@koishijs/core') as typeof import('@koishijs/core');

class RuntimeLoader extends NodeLoader {
  private shuttingDown = false;

  beginShutdown() {
    this.shuttingDown = true;
  }

  override writeConfig(silent?: boolean): Promise<void> {
    // This runtime treats the YAML as read-only. Loader shutdown also emits
    // writes while unloading plugins, so both paths must remain non-mutating.
    return !this.writable || this.shuttingDown ? Promise.resolve() : super.writeConfig(silent);
  }

  // NodeLoader normally asks its parent process to restart after disposal.
  // This wrapper owns lifecycle directly, so shutdown ends at app.stop().
  override fullReload() {}

}

Object.defineProperty(RuntimeLoader.prototype, 'logUpdate', {
  value: (type: string, _parent: unknown, key: string) => new Logger('loader').info('%s plugin %c', type, key),
});

export interface KoishiRuntimeOptions {
  configPath: string;
  beforeCreate?: () => void | Promise<void>;
  setup?: (app: Context) => void | Promise<void>;
}

export interface KoishiRuntime {
  app: Context;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Load and run an ordinary Koishi YAML configuration through its native loader. */
export async function createKoishiRuntime(options: KoishiRuntimeOptions): Promise<KoishiRuntime> {
  const configPath = path.resolve(options.configPath);
  const loader = new RuntimeLoader();
  let app: Context | undefined;
  try {
    await loader.init(configPath);
    loader.writable = false;
    await loader.readConfig(true);
  } catch {
    throw new Error('Unable to initialize Koishi runtime from config: ' + configPath);
  }
  // Runs after native loader environment/config processing but before plugins
  // initialize, allowing callers to validate credentials and prepare paths.
  await options.beforeCreate?.();
  try {
    const runtimeApp = app = await loader.createApp();
    await options.setup?.(runtimeApp);
    let startTask: Promise<void> | undefined;
    let stopTask: Promise<void> | undefined;
    return {
      app: runtimeApp,
      start() {
        if (stopTask) return Promise.reject(new Error('Koishi runtime has already stopped.'));
        return startTask ??= runtimeApp.start();
      },
      stop() {
        return stopTask ??= (async () => {
          if (startTask) await startTask.catch(() => undefined);
          loader.beginShutdown();
          await runtimeApp.stop();
        })();
      },
    };
  } catch {
    if (app) {
      loader.beginShutdown();
      await app.stop().catch(() => undefined);
    }
    throw new Error('Unable to initialize Koishi runtime from config: ' + configPath);
  }
}
