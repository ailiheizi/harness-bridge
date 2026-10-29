import type { AiRequest } from './ai.js';
import type { createGroupActions } from './actions.js';
import type { KoishiCodeHost } from './koishi.js';
import type { Store } from './store.js';

/** A binding for one installed capability, using current authority and task parameters. */
export async function runLinkCodeTool(
  store: Store, actions: Pick<ReturnType<typeof createGroupActions>, 'getGroup'>,
  code: KoishiCodeHost, request: AiRequest, signal: AbortSignal, feature: 'link-brief' | 'assistant' = 'link-brief',
): Promise<string> {
  signal.throwIfAborted();
  const group = await actions.getGroup(request.actorId, request.groupId);
  for (const id of [feature, 'link-cleaner']) {
    const plugin = store.plugin(id);
    if (!group.config.features.includes(id) || !plugin?.enabled || !plugin.available) throw new Error('本次代码能力授权已失效。');
  }
  if (!request.codeOptions) throw new Error('缺少本次已核验的代码参数。');
  // AI cannot choose actor/group/audience/commands. This result stays inside its
  // task; the ordinary actions path decides whether the final result is shared.
  return (await code.executeLinks({
    actorId: request.actorId, groupId: request.groupId, input: request.input,
    options: { ...request.codeOptions, language: request.options.language },
    audience: 'private', authorized: true,
  }, signal)).output;
}
