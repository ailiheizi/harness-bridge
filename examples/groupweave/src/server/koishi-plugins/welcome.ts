import { createRequire } from 'node:module';
import type { Context, Session } from 'koishi';
import type { NativeRequest } from '../native.js';

export const name = 'groupweave-welcome';
const { h } = createRequire(import.meta.url)('@koishijs/core') as typeof import('koishi');

export function welcomeText(request: Readonly<NativeRequest>): string {
  const english = request.options.language === 'en';
  const template = request.options.welcomeText;
  const groupTitle = request.options.groupTitle;
  if (template !== undefined && (typeof template !== 'string' || template.length > 500
    || Buffer.byteLength(template) > 2000)) throw new Error('欢迎文本模板超出限制。');
  if (groupTitle !== undefined && (typeof groupTitle !== 'string' || groupTitle.length > 500)) {
    throw new Error('群标题超出限制。');
  }
  const values = {
    name: request.input.trim(),
    group: groupTitle?.trim() || (english ? 'the group' : '本群'),
  };
  // One pass substitutes only two documented names. Inserted text cannot expand
  // another placeholder, command, JavaScript expression, or message component.
  const output = (template?.trim() || (english ? 'Welcome {name} to {group}!' : '欢迎 {name} 加入 {group}！'))
    .replace(/\{(name|group)\}/g, (_, key: 'name' | 'group') => values[key]);
  // Keep one ordinary Telegram text result within its message-size limit.
  if (output.length > 4000) throw new Error('欢迎文本结果超出限制。');
  return output;
}

export function apply(ctx: Context, invocation: (session: Session) => {
  request: Readonly<NativeRequest>; signal: AbortSignal; error?: unknown;
}) {
  ctx.command('groupweave-welcome').action(({ session }) => {
    const binding = invocation(session!);
    try {
      binding.signal.throwIfAborted();
      return h.text(welcomeText(binding.request));
    } catch (error) {
      binding.error = error;
      return '';
    }
  });
}
