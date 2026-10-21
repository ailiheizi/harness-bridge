import { App } from '@koishijs/core';
import { MockBot } from '@koishijs/plugin-mock';
import { installKoishiBridge } from './src/index.mjs';

const app = new App({});
const bot = new MockBot(app, { selfId: 'demo-bot' });
const bridge = {
  async execute(request) {
    return {
      taskId: request.taskId, status: 'completed', output: 'Synthetic summary completed.',
      sandbox: { id: 'synthetic-id', name: 'synthetic-sandbox', workspace: 'synthetic-workspace' },
      cleanup: { status: 'verified' }, evidence: { execution: 'verified', cleanup: 'verified', modelRequestCount: null, nativeExitCode: 0, dshSessionId: 'synthetic-session' },
    };
  },
};
const controller = installKoishiBridge(app, {
  bridge,
  authorize: async () => true,
});
await app.start();
const replies = await bot.client('synthetic-user', 'synthetic-group').receive('isolated-summary summarize synthetic input');
console.log(JSON.stringify({ dispatch: 'koishi-mock', replies, bridge: 'synthetic', externalServices: false }));
await controller.close();
