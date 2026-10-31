import { mkdirSync, writeFileSync, rmSync } from 'node:fs';

// Trusted workload plugin for the pinned DSH session/event contract. This does
// not give the model a file tool. Headless flush/final remains owned by DSH.
export const name = 'groupweave-result-export';
export function apply(ctx) {
  const states = new WeakMap();
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') {
      states.set(session, { text: undefined });
      rmSync('/workspace/exports/result.md', { force: true });
      return;
    }
    const state = states.get(session);
    if (!state) return;
    if (event.type === 'assistant/message') {
      const text = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('');
      if (text !== '') state.text = text;
    }
    if (event.type !== 'turn/end') return;
    states.delete(session);
    if (event.data.reason?.kind !== 'completed' || typeof state.text !== 'string'
      || !state.text.trim() || Buffer.byteLength(state.text, 'utf8') > 64_000) return;
    mkdirSync('/workspace/exports', { recursive: true, mode: 0o700 });
    // Synchronous observer finishes before DSH publishes its final/exit. Any
    // observer failure leaves a missing export; host download must then fail.
    writeFileSync('/workspace/exports/result.md', state.text, { flag: 'wx', mode: 0o600 });
  });
}
