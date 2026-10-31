import type { Context } from 'koishi';
import { createRequire } from 'node:module';
import { createGroupActions, deny, objectBody, positiveInteger, requiredString } from './actions.js';
import { interpretGroupRules } from './group-config.js';
import { telegramCommandSource } from './koishi-business.js';
import { describeRuleProposal } from './koishi-group-admin.js';
import { Store, telegramActorId, telegramGroupId } from './store.js';

const require = createRequire(import.meta.url);
const { h } = require('@koishijs/core') as typeof import('koishi');
type Actions = ReturnType<typeof createGroupActions>;

/** Uses the ordinary authorized task entrypoint; a model can only propose existing fields. */
export function createRuleProposals(store: Store, actions: Actions) {
  return async (actorId: string, groupId: string, value: unknown, signal?: AbortSignal) => {
    const group = await actions.getGroup(actorId, groupId, true);
    const body = objectBody(value, ['text', 'baseVersion', 'acknowledgeExternalProcessing']);
    const version = positiveInteger(body.baseVersion, '配置版本', Number.MAX_SAFE_INTEGER);
    if (version !== group.version) return deny(409, 'VERSION_CONFLICT', '本群配置已经变化，请刷新后重新预览。');
    const text = requiredString(body.text, '规则要求', 2000);
    if (body.acknowledgeExternalProcessing !== true) return deny(400, 'EXTERNAL_PROCESSING_REVIEW_REQUIRED', '规则解释会把本群当前配置和要求发送给第三方模型，需要本人确认。');
    let taskId: string | undefined;
    const interpreted = await interpretGroupRules(text, group.config, {
      knownFeatures: store.plugins().map(plugin => plugin.id),
      async interpret(prompt) {
        const task = await actions.runTask(actorId, groupId, { featureId: 'assistant', input: prompt,
          audience: 'private', acknowledgeExternalProcessing: true }, () => !signal?.aborted, signal, { conversation: false });
        taskId = task.id;
        if (task.status !== 'succeeded') throw new Error('RULE_INTERPRETATION_FAILED');
        // The explanation is already in the private task record; no unused file needs retention.
        actions.takeTaskArtifact(actorId, task.id);
        return task.output;
      },
    });
    // previewRules rechecks current manager, version, actual plugin availability and fields.
    const proposal = await actions.previewRules(actorId, groupId, { config: interpreted.patch, text: '', baseVersion: version },
      { warnings: interpreted.warnings, text });
    return { ...proposal, interpretation: { taskId, scope: interpreted.scope, cost: interpreted.cost } };
  };
}

export function installNaturalRuleCommands(ctx: Context, store: Store, actions: Actions) {
  const preview = createRuleProposals(store, actions);
  ctx.command('airules <text:text>', '用 AI 解释本群配置要求，预览后再确认')
    .option('confirm', '--confirm 第三方处理本群配置和要求')
    .action(async ({ session, options }, text = '') => {
      if (!session) return;
      const source = telegramCommandSource(session);
      if (!source) return;
      try {
        const actorId = telegramActorId(source.actor.userId), groupId = telegramGroupId(source.actor.groupId);
        const group = await actions.getGroup(actorId, groupId, true);
        if (!text.trim() || !options?.confirm) {
          await session.send(h.text('此操作会把本群当前配置和要求发送给第三方 AI，计费以实际任务为准。\n同意后使用 /airules --confirm <要求>。返回提案仍需 /applyrules <ID> 确认；/rules 为免费固定短语入口。'));
          return;
        }
        await session.send(h.text('正在解释本群规则，仅生成预览。可用 /tasks 查看本人任务，/cancel 取消；完成后仍需 /applyrules 确认。'));
        const proposal = await preview(actorId, groupId, { text, baseVersion: group.version, acknowledgeExternalProcessing: true });
        await session.send(h.text(describeRuleProposal(proposal)));
      } catch {
        await session.send(h.text('规则解释或预览未完成。请确认本群管理员身份、已启用群助手及模型配置；没有修改群配置或自动重试。'));
      }
    });
}
