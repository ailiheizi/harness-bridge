import { createRequire } from 'node:module';
import type { Context, Session } from 'koishi';
import type { NativeRequest } from '../native.js';
import { cleanLinks } from '../links.js';

export const name = 'groupweave-links';
const { h } = createRequire(import.meta.url)('@koishijs/core') as typeof import('koishi');

/** The host supplies only the trusted request already bound to this Session. */
export function apply(ctx: Context, invocation: (session: Session) => {
  request: Readonly<NativeRequest>; signal: AbortSignal; error?: unknown;
}) {
  ctx.command('groupweave-links').action(async ({ session }) => {
    const binding = invocation(session!);
    try { return h.text(await cleanLinks(binding.request.input, binding.request.options, binding.signal)); }
    catch (error) {
      // Keep business/cancellation errors at the host boundary. Koishi's generic
      // logger must not receive a command error containing private request data.
      binding.error = error;
      return '';
    }
  });
}
