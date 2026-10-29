import { Composer, type Context } from 'grammy';
import type { AiFeature } from './confirmation.js';

type Handler = (ctx: Context) => Promise<unknown>;
/** Product entrypoints use grammY's own middleware composition. */
export function createTelegramProductComposer(handlers: {
  help: Handler;
  links: Handler;
  echo: Handler;
  scan: Handler;
  requestAi(ctx: Context, featureId: AiFeature): Promise<unknown>;
  confirmAi: Handler;
  cancel: Handler;
  cancelButton: Handler;
  mention: Handler;
  welcome: Handler;
}) {
  const composer = new Composer();
  composer.command(['start', 'help', 'status', 'plugins'], handlers.help);
  composer.command('links', handlers.links);
  composer.command('echo', handlers.echo);
  composer.command('scan', handlers.scan);
  composer.command('ask', ctx => handlers.requestAi(ctx, 'assistant'));
  composer.command('digest', ctx => handlers.requestAi(ctx, 'digest'));
  composer.command('brief', ctx => handlers.requestAi(ctx, 'link-brief'));
  composer.command('cancel', handlers.cancel);
  composer.callbackQuery(/^gw:a:/, handlers.confirmAi);
  composer.callbackQuery(/^gw:c:/, handlers.cancelButton);
  composer.on('message:new_chat_members', handlers.welcome);
  composer.on('message:text', (ctx, next) => ctx.entities('bot_command').some(entity => entity.offset === 0) ? next() : handlers.mention(ctx));
  return composer;
}
