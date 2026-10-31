import type { TelegramActor, TelegramBinding } from './telegram.js';
import { Store, telegramActorId, telegramGroupId, telegramPrivateId } from './store.js';
import { createGroupActions, deny } from './actions.js';

/** A specific GroupWeave adapter; all business execution remains the same DSH path. */
export function createTelegramBinding(store: Store, actions: ReturnType<typeof createGroupActions>, options: { scope?: 'private' } = {}): TelegramBinding {
  const personal = options.scope === 'private';
  const audience = personal ? 'private' : 'group';
  const ids = (actor: TelegramActor) => {
    if (personal && actor.groupId !== actor.userId) return deny(403, 'PRIVATE_SCOPE_DENIED', '只能访问本人私聊。');
    return { actorId: telegramActorId(actor.userId), groupId: personal ? telegramPrivateId(actor.userId) : telegramGroupId(actor.groupId) };
  };
  const current = async (actor: TelegramActor, manager = false) => {
    const { actorId, groupId } = ids(actor);
    if (personal) store.ensureTelegramPrivate(actor.userId);
    return actions.getGroup(actorId, groupId, manager);
  };
  const proposalFor = async (actor: TelegramActor, id: string) => {
    const group = await current(actor, true);
    const proposal = store.proposal(id);
    return proposal?.groupId === group.id && proposal.creatorId === telegramActorId(actor.userId) ? proposal : null;
  };
  return {
    async getGroup(actor) {
      try { const group = await current(actor); return { version: group.version, config: { ...group.config, features: group.config.features.filter(id => { const capability = store.plugin(id); return capability?.enabled && capability.available; }) } }; }
      catch (error) { if (error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 404) return null; throw error; }
    },
    async registerGroup(actor, title) {
      if (personal) return deny(400, 'PRIVATE_SCOPE_OPERATION', '私聊不注册群。');
      if (actor.role !== 'admin') return deny(403, 'MANAGER_REQUIRED', '需要当前本群管理权。');
      const { groupId, actorId } = store.registerTelegramGroup({ chatId: actor.groupId, title, userId: actor.userId });
      store.syncTelegramMember(actor.groupId, actor.userId, actor.role);
      const group = await actions.getGroup(actorId, groupId, true);
      store.audit({ actorId, groupId, action: 'group.register', outcome: 'registered' });
      return { version: group.version, config: group.config };
    },
    async previewRules(actor, text) {
      const group = await current(actor, true);
      return actions.previewRules(telegramActorId(actor.userId), group.id, { text, baseVersion: group.version });
    },
    getProposal: proposalFor,
    async activateRules(actor, id) {
      const proposal = await proposalFor(actor, id) ?? deny(404, 'NOT_FOUND', '找不到可由本人启用的本群提案。');
      return actions.activateRules(telegramActorId(actor.userId), proposal.id);
    },
    async cancelRules(actor, id) { const proposal = await proposalFor(actor, id) ?? deny(404, 'NOT_FOUND', '找不到本人本群提案。'); return actions.cancelRules(telegramActorId(actor.userId), proposal.id); },
    async rollbackRules(actor, id) { const proposal = await proposalFor(actor, id) ?? deny(404, 'NOT_FOUND', '找不到本人本群提案。'); return actions.rollbackRules(telegramActorId(actor.userId), proposal.id); },
    async ownTasks(actor) { await current(actor); const { actorId, groupId } = ids(actor); return actions.ownTasks(actorId, groupId); },
    async ownTask(actor, id) { await current(actor); const { actorId, groupId } = ids(actor); return actions.ownTask(actorId, groupId, id); },
    async cancelTask(actor, id) { await current(actor); const { actorId, groupId } = ids(actor); await actions.ownTask(actorId, groupId, id); return actions.cancelTask(actorId, id); },
    async resetConversation(actor) { await current(actor); const { actorId, groupId } = ids(actor); return actions.resetConversation(actorId, groupId); },
    async listModels(actor) { await current(actor); const { actorId, groupId } = ids(actor); return actions.listModels(actorId, groupId); },
    async selectModel(actor, id) { await current(actor); const { actorId, groupId } = ids(actor); return actions.selectModel(actorId, groupId, id); },
    async takeTaskArtifact(actor, id) { await current(actor); const { actorId, groupId } = ids(actor); await actions.ownTask(actorId, groupId, id); return actions.takeTaskArtifact(actorId, id); },
    async executeLinks(request) {
      if (personal) return deny(400, 'PRIVATE_SCOPE_OPERATION', '本私人入口只接入问答与摘要。');
      const { actorId, groupId } = ids(request.actor);
      return actions.runTask(actorId, groupId, { input: request.input, featureId: 'link-cleaner', audience: 'group', idempotencyKey: request.idempotencyKey });
    },
    async executeFeature(request) {
      const { actorId, groupId } = ids(request.actor);
      if (personal && !['assistant', 'digest'].includes(request.featureId)) return deny(403, 'PRIVATE_SCOPE_OPERATION', '本私人入口只接入问答与摘要。');
      await current(request.actor);
      // Neither the sender nor joined display names can supply authority or a target group.
      if (request.featureId === 'welcome' && (!request.eventUserIds?.length || request.eventUserIds.length > 50
        || request.eventUserIds.some(id => !/^[1-9]\d*$/.test(id)))) return deny(400, 'INVALID_EVENT', '欢迎事件的成员信息无效。');
      return actions.runTask(actorId, groupId, {
        input: request.input, featureId: request.featureId, audience, idempotencyKey: request.idempotencyKey,
        ...(request.externalProcessingAcknowledged === true ? { acknowledgeExternalProcessing: true } : {}),
      });
    },
    async cancelOwnTasks(actor) {
      const { actorId, groupId } = ids(actor);
      const tasks = await actions.ownActiveTasks(actorId, groupId);
      let count = 0;
      for (const task of tasks) if ((await actions.cancelTask(actorId, task.id)).requested) count++;
      return count;
    },
    async migrateGroup(oldGroupId, newGroupId) {
      if (personal) return deny(400, 'PRIVATE_SCOPE_OPERATION', '私聊不迁移群。');
      store.migrateTelegramGroup(oldGroupId, newGroupId);
    },
    async claimDelivery(actor, taskId) {
      const { actorId, groupId } = ids(actor);
      const group = await current(actor);
      const row = store.task(taskId); const capability = row?.task && store.plugin(row.task.featureId);
      if (!row?.task || !group.config.features.includes(row.task.featureId) || !capability?.enabled || !capability.available) return false;
      if (!store.taskAuthorized(row.task)) return false;
      if (row.task.featureId === 'link-brief' || (row.task.featureId === 'assistant' && row.task.toolCalls === 1)) {
        const code = store.plugin('link-cleaner');
        if (!group.config.features.includes('link-cleaner') || !code?.enabled || !code.available) return false;
      }
      return store.claimTelegramDelivery(taskId, groupId, actorId);
    },
    deliveryStillAuthorized(actor, taskId) {
      const { actorId, groupId } = ids(actor), row = store.task(taskId);
      return !!row?.task && !row.pending && !row.expired && row.groupId === groupId && row.creatorId === actorId
        && row.audience === audience && store.taskAuthorized(row.task);
    },
    async recordDelivery(actor, taskId, status) {
      const { actorId, groupId } = ids(actor);
      store.recordTelegramDelivery(taskId, groupId, actorId, status);
    },
  };
}
