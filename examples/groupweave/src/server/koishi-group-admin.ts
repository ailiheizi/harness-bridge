import type { Context, Session } from 'koishi';
import type { Group, Proposal } from '../shared.js';
import type { TelegramActor } from './telegram.js';
import { telegramCommandSource } from './koishi-business.js';
import { NATIVE_FEATURES } from './group-config.js';

export interface GroupAdminBinding {
  cancelRules(actor: TelegramActor, id: string): Promise<Proposal>;
  rollbackRules(actor: TelegramActor, id: string): Promise<Proposal>;
}
export function describeGroupSettings(group: Pick<Group, 'version' | 'config'>): string {
  return `本群配置 v${group.version}（仅影响本群）\n${JSON.stringify(group.config, null, 2)}\n可调字段：responseMode(mention/command)、language(zh/en)、features(平台已有功能ID)、nativeFeatures(${NATIVE_FEATURES.join('/')})、deduplicate/sort(布尔)、maxItems(1–100)、welcomeText(500字符)、antiadPromptThreshold/antiadActionThreshold(0–1且大于0)、antiadStopwords(最多50词)。\n原生开关：${(group.config.nativeFeatures ?? NATIVE_FEATURES).join('、') || '全部关闭'}；未设置列表沿用旧默认全开。开关只控制本群准入，不表示平台已安装或开启。\n平台插件安装、凭据、模型端点和费用由平台管理，群配置不授予这些权限。手动面板改配置不调用模型；自然语言解释需要已授权AI请求，费用以真实任务记录为准，预览和确认应用本身无模型费用。\n/rules <要求> 预览；/applyrules <ID> 本人确认；/cancelrules <ID> 取消本人待确认提案；/rollbackrules <已生效ID> 创建恢复前值的预览，仍需本人确认。`;
}
export function describeRuleProposal(proposal: Proposal): string {
  return `本群规则预览 ${proposal.id} · 基于 v${proposal.baseVersion}\n作用范围：仅本群；应用配置无模型调用费用，AI解释费用以任务真实记录为准。\n${proposal.changes.join('\n') || '没有配置变化'}${proposal.warnings.length ? `\n不支持或未解决：\n${proposal.warnings.join('\n')}` : `\n确认：/applyrules ${proposal.id}`}\n取消：/cancelrules ${proposal.id}`;
}
/** Uses the same authenticated Telegram source and application proposal authorization. */
export function installGroupAdminCommands(ctx: Context, binding: GroupAdminBinding, send: (session: Session, text: string) => Promise<void>): void {
  for (const [name, description, action] of [
    ['cancelrules', '取消本人待确认群规则提案', binding.cancelRules.bind(binding)],
    ['rollbackrules', '预览恢复已生效群规则之前的配置', binding.rollbackRules.bind(binding)],
  ] as const) {
    ctx.command(`${name} <id:string>`, description).action(async ({ session }, id = '') => {
      if (!session) return;
      const src = telegramCommandSource(session); if (!src) return;
      if (!/^[a-zA-Z0-9-]{1,48}$/.test(id)) return send(session, `用法：/${name} <提案ID>`);
      try {
        const proposal = await action(src.actor, id);
        await send(session, name === 'cancelrules' ? '本人待确认的群规则提案已取消。' : describeRuleProposal(proposal));
      } catch { await send(session, '操作未完成：请确认当前本群管理员身份、提案归属与状态；未自动重试。'); }
    });
  }
}
