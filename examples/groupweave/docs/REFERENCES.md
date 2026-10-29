# 实际依赖、复用边界与一手来源

核查日期：2026-10-07。本文件记录本轮实际安装与实际调用的库，不声称这些版本是最新版本。
版本交叉核对了 [package.json](../package.json)、[package-lock.json](../package-lock.json)
与 `node_modules/<包名>/package.json`；直接依赖的锁定版本和本地安装一致。
许可事实查看了发布包声明、随包许可证文件与下表上游原文。版本 tag 链接对应已核实版本；
标为 main / master 的链接是可移动参考，不替代锁定包证据。全部来源是作者、维护者或 Telegram 自身的一手资料。

## HTTP、Telegram 与管理界面

| 实际包与安装版本 | 当前使用位置与作用 | 许可原文 |
| --- | --- | --- |
| `fastify@5.12.5` | [app.ts](../src/server/app.ts)：管理 API、请求限制、错误处理与关闭钩子 | [MIT，v5.12.5](https://raw.githubusercontent.com/fastify/fastify/v5.12.5/LICENSE) |
| `@fastify/cookie@11.1.2` | Cookie 解析和写入；不透明会话与 CSRF 策略由应用实现 | [MIT，v11.1.2](https://raw.githubusercontent.com/fastify/fastify-cookie/v11.1.2/LICENSE) |
| `@fastify/rate-limit@11.2.0` | HTTP 入口限频，当前使用内存存储、IP key 与有界 cache | [MIT，v11.2.0](https://raw.githubusercontent.com/fastify/fastify-rate-limit/v11.2.0/LICENSE) |
| `@fastify/static@10.1.5` | 提供 Vite 构建产物 | [MIT，v10.1.5](https://raw.githubusercontent.com/fastify/fastify-static/v10.1.5/LICENSE) |
| `grammy@1.46.0` | [telegram.ts](../src/server/telegram.ts)：Bot API、middleware、command、InlineKeyboard、callback、原生顺序 polling | [MIT，v1.46.0](https://raw.githubusercontent.com/grammyjs/grammY/v1.46.0/LICENSE) |
| `@grammyjs/ratelimiter@1.2.1` | Telegram 用户 / 群每 2 秒 3 次 / 10 次限频；超限拒绝，不排队 | [MIT，上游 main](https://github.com/grammyjs/ratelimiter/blob/main/LICENSE) |
| `@tma.js/init-data-node@2.0.8` | `validate` 校验原始 initData，`parse` 读取已验证身份；有效期 300 秒 | [MIT，作者仓库 master](https://github.com/Telegram-Mini-Apps/tma.js/blob/master/LICENSE) |
| `@tma.js/bridge@2.3.3` | [main.tsx](../src/client/main.tsx)：`retrieveRawInitData` 读取启动数据后提交后端校验 | [MIT，作者仓库 master](https://github.com/Telegram-Mini-Apps/tma.js/blob/master/LICENSE) |
| `zod@4.6.5` | [actions.ts](../src/server/actions.ts)：群配置类型、范围、枚举与未知字段校验 | [MIT，v4.6.5](https://raw.githubusercontent.com/colinhacks/zod/v4.6.5/LICENSE) |
| `react@19.3.0`、`react-dom@19.3.0` | 管理界面与结果展示；权限由后端核验 | [MIT，v19.3.0](https://raw.githubusercontent.com/facebook/react/v19.3.0/LICENSE) |
| `lucide-react@1.52.0` | 管理界面图标 | [ISC 与所含 Feather 图标的 MIT notice，上游 main](https://raw.githubusercontent.com/lucide-icons/lucide/main/LICENSE) |

`@tma.js/*` 是作者维护的 Telegram Mini Apps SDK，**不是 Telegram 官方维护的 SDK**。
其[服务器校验文档](https://docs.telegram-mini-apps.com/packages/tma-js-init-data-node)
与[bridge 文档](https://docs.telegram-mini-apps.com/packages/tma-js-bridge)是该库的一手来源；
Telegram 协议与授权规则另以 `core.telegram.org` 为准。前端 bridge 取得数据本身不证明身份或群管理权。

`@grammyjs/ratelimiter@1.2.1` 发布包声明 MIT，但本轮安装目录没有单独 LICENSE 文件，原文从维护者仓库核查。
Lucide 实际 LICENSE 同时包含 Feather 来源说明；Vite 发布包 LICENSE.md 也包含捆绑组件通知，不能仅保留一个许可标签。
此表是直接依赖库存，不代表完成了传递依赖的完整 SBOM 或再分发审核。

HTTP 限频接口见 [Fastify rate-limit v11.2.0 README](https://github.com/fastify/fastify-rate-limit/blob/v11.2.0/README.md)，
Telegram 内存 limiter 与可选 Redis 支持见 [grammY ratelimiter 文档](https://grammy.dev/plugins/ratelimiter)。
当前未配置 Redis，也未安装 grammY runner / auto-retry。
Telegram limiter 默认 key 存储没有本轮已验证的全局 key 数量上限；单实例限频不等于完整抗滥用或多副本协调。

## Koishi：实际原生代码插件

锁定并实际安装 `koishi@4.18.11`、其 `@koishijs/core@4.18.11` 与官方
`@koishijs/plugin-echo@2.2.5`，发布包均声明 MIT；上游许可见
[Koishi LICENSE](https://github.com/koishijs/koishi/blob/master/LICENSE)。
当前用 CommonJS 核心 API 加载 App、plugin、command、Bot/Session；官方 Echo
直接从 npm 包加载且未修改源码，自有链接算法注册为原生 command.action。
这是当前实际宿主，不再只是界面借鉴。具体范围见
[KOISHI-CODE-AI](KOISHI-CODE-AI.md)。

参考[原生 Session](https://koishi.chat/zh-CN/api/core/session)与
[过滤器](https://koishi.chat/zh-CN/guide/plugin/filter)，采用结构化执行与请求
scope；过滤器不提供恶意插件沙箱。当前不加载官方 Console/Loader/Market 或
第二个 Telegram 更新消费者。完整 adapter 与在线插件管理另行验收。

传递依赖 `file-type@16.5.4` 有已知解析拒绝服务问题，当前审计有 10 条
moderate 传播记录；见 [GHSA-5v7r-6r5c-r473](https://github.com/advisories/GHSA-5v7r-6r5c-r473)。
当前文本入口没有附件解析，生产前仍须处理依赖问题，不沿用引入前零漏洞结果。

## DSH：复用执行与 Skill

[DeepSeek Harness 作者仓库](https://github.com/deepseek-ai/deepseek-harness)是选定的外部 Harness 实现。
下表 `@deepseek-ai/dsh-*` 包均实际安装 **0.2.0-rc.1**；`@deepseek-ai/cordis` 为 **4.0.4**。
各 DSH 发布包附有 MIT LICENSE；Cordis 随包许可证保留 Shigma 版权信息。
原文见 [DSH LICENSE](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/LICENSE)
与 [vendor/cordis LICENSE](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/vendor/cordis/LICENSE)。

| 实际包，省略 `@deepseek-ai/` 前缀 | 当前用途与边界 |
| --- | --- |
| `cordis` | 组合既有 DSH services 与 scope |
| `dsh-agent`、`dsh-agent-loop` | 固定路径使用原生 idle Agent factory；AI 路径才提交消息并运行原生 Agent loop |
| `dsh-commands`、`dsh-tools` | 固定路径走原生 command → tool 与 guard；Bot 不直接调用链接整理业务函数 |
| `dsh-session`、`dsh-session-projection` | 每次执行使用原生 Session、事件和结果，由 handle 释放所属 scope |
| `dsh-llm`、`dsh-system-prompt` | 原生模型接口、消息与执行证据；固定路径不加载 provider、不提交模型 turn |
| `dsh-llm-deepseek` | [ai.ts](../src/server/ai.ts) 用官方 `DeepSeekAdapter`、配置 resolver、模型信息及文件索引组件；没有另写模型 HTTP client |
| `dsh-skill`、`dsh-skill-filesystem`、`dsh-tool-skill` | AI 路径用原生 SkillRegistry 和 filesystem loader 加载[审核 Skill](../audited/group-summary/SKILL.md)，默认 roots 与 watch 关闭 |
| `dsh-anonymous-user-id` | 官方 adapter 的匿名标识依赖，只绑定应用指定 `DSH_HOME`，不继承用户机器默认目录 |

源码来源目录由发布包 `repository.directory` 给出：`packages/llm/llm-deepseek`、
`packages/skill/skill`、`packages/skill/skill-filesystem`、`packages/skill/tool-skill`、
`packages/identity/anonymous-user-id`。本轮 API 证据来自对应安装包的 `lib/index.js` 与 `lib/types/index.d.ts`，
不是对上游 master 未来接口的承诺。固定路径细节见 [NATIVE-BINDING.md](NATIVE-BINDING.md)。

匿名 adapter 标识不是 Telegram 登录身份、群成员资格或租户权限来源，不能替代可信 update / 已验证 initData 与当次 `getChatMember`。
AI composition 有代码和离线模拟证据；实际 DeepSeek 调用、token 用量和费用由 [ACCEPTANCE.md](ACCEPTANCE.md) 独立验收。
固定代码不自动切换到 AI composition。

## 构建、类型与本机存储

| 工具 | 当前锁定 / 安装 | 许可原文 |
| --- | --- | --- |
| `vite` | `8.3.3` | [MIT，v8.3.3](https://raw.githubusercontent.com/vitejs/vite/v8.3.3/LICENSE)；发布包 LICENSE.md 另含捆绑组件通知 |
| `@vitejs/plugin-react` | `6.1.2` | [MIT，上游 main](https://raw.githubusercontent.com/vitejs/vite-plugin-react/main/LICENSE) |
| `tsx` | `4.23.15` | [MIT，作者仓库 master](https://raw.githubusercontent.com/privatenumber/tsx/master/LICENSE) |
| `typescript` | `7.0.2` | [Apache-2.0，上游 main](https://raw.githubusercontent.com/microsoft/TypeScript/main/LICENSE.txt) |
| `@types/node` | 声明 `^24.0.0`，实际 `24.19.1` | [DefinitelyTyped MIT](https://raw.githubusercontent.com/DefinitelyTyped/DefinitelyTyped/master/LICENSE)与安装包 LICENSE |
| `@types/react`、`@types/react-dom` | 声明 `^19.0.0`，实际均 `19.3.0` | [DefinitelyTyped MIT](https://raw.githubusercontent.com/DefinitelyTyped/DefinitelyTyped/master/LICENSE)与各安装包 LICENSE |

项目 engines 为 Node `>=24`；本轮本机 `v26.5.0`，Dockerfile 使用 Node 26 slim。
SQLite 使用 [Node 内置 node:sqlite](https://nodejs.org/api/sqlite.html)，没有另装 ORM、数据库服务或 Redis。
这些是应用部署选择，不是 portable Skill 的格式要求。

## Telegram 协议与采用的接口

| 一手来源 | 当前采用方式与边界 |
| --- | --- |
| [grammY middleware](https://grammy.dev/guide/middleware)、[commands](https://grammy.dev/guide/commands) | 按库的 handler 顺序处理，正确 await；文字内容不能增加处理器或执行权限 |
| [grammY keyboard](https://grammy.dev/plugins/keyboard)、[Telegram CallbackQuery](https://core.telegram.org/bots/api#callbackquery) | 已实现 InlineKeyboard 预览与 callback 确认；再次核对 proposal、群、创建者与当前管理权；不可访问关联 message 被拒绝 |
| [grammY Transformer](https://grammy.dev/advanced/transformers) | 离线测试拦截全部 Bot API；合成 getMe 不证明 live 连接 |
| [grammY Bot 生命周期源码 v1.46.0](https://github.com/grammyjs/grammY/blob/v1.46.0/src/bot.ts) | 显式 init / polling；stop 后还等待 start 的 middleware 完成，不新增消费队列 |
| [Telegram getChatMember](https://core.telegram.org/bots/api#getchatmember) | 其他用户查询仅在 Bot 为群管理员时保证可用；每次核验群类型、Bot 管理权和个人当前状态 |
| [Telegram Message](https://core.telegram.org/bots/api#message)、[ChatMemberRestricted](https://core.telegram.org/bots/api#chatmemberrestricted) | 群 ID 来自 update；匿名 sender_chat、私人 / 转发来源不授予个人群权限；restricted 需 is_member 为真 |
| [Telegram Mini App 验证](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app) | 已实现原始 initData 获取与服务器签名 / 时间校验代码；签名仅确认登录身份，群权限另查；演示身份不进入 live 命名空间 |
| [Telegram 群迁移字段](https://core.telegram.org/bots/api#message) | 已处理可信迁移字段，持久 scope 随新 chat_id 迁移，旧执行不重放，目标冲突停止 |
| [webhook secret_token](https://core.telegram.org/bots/api#setwebhook) | 仅协议参考；当前采用 polling，没有配置 webhook 或双传输 |

群规则、callback、真实租户 binding、持久重复保护与回传适配已有代码及官方 Transformer 离线整合测试。
代码存在、离线通过、真实 getMe、真实群闭环与公网 Mini App 登录是不同证据层级。
真实 Bot / 群 / Mini App 验收与 live 模型调用仍 **NOT RUN**，不由引用文档改变状态。
当次角色核验无法原子撤回已经开始的网络投递；发送结果未知不触发业务重执或重复发送。
运行证据与剩余事项见 [ACCEPTANCE.md](ACCEPTANCE.md)、[TELEGRAM.md](TELEGRAM.md)、[TODO.md](TODO.md)；此处不维护总测试数。

## 成品参考与没有叠加的系统

| 一手参考 | 借鉴内容 | 当前决策 |
| --- | --- | --- |
| [kmua 固定快照插件装载](https://github.com/krau/kmua-bot/blob/2f0b6dc4789a97036d91c78c85410049f2711fa4/kmua/bot/client.py#L30-L67) | TG 管理体验、插件配置与 Agent / 普通插件的区分 | 只参考体验和机制，未复制 Python 源码或 fork 运行层 |
| [Koishi 过滤器](https://koishi.chat/zh-CN/guide/plugin/filter)、[市场](https://koishi.chat/zh-CN/manual/usage/market) | 原生代码插件、上下文范围配置和功能组合 | 核心与 Echo 已引入；市场和全局 Console 未引入，逻辑过滤不等于安全沙箱 |
| [NoneBot 快速上手](https://nonebot.dev/docs/quick-start) | plugin、adapter、driver 的职责划分 | 既有 TypeScript / grammY 已承担 TG 接入，不增加 Python 多平台宿主与重复命令生命周期 |
| [grammY ratelimiter](https://grammy.dev/plugins/ratelimiter)、[Fastify rate-limit](https://github.com/fastify/fastify-rate-limit/blob/v11.2.0/README.md) | 现成限频与可选共享存储 | 当前单实例使用内存；未来多副本需另验共享限频与更新消费，不预装 Redis |

kmua 核查基于快照 `2f0b6dc4789a97036d91c78c85410049f2711fa4`，不保证其最新状态。
该快照 [LICENSE 原文](https://github.com/krau/kmua-bot/blob/2f0b6dc4789a97036d91c78c85410049f2711fa4/LICENSE)
为 GNU Affero General Public License v3。本轮独立使用已选库实现，避免引入尚未评审的 kmua 源码复用路径。
若以后复制代码，应先记录具体范围并核查该范围的许可要求；此处不推断整个派生应用的许可。
关闭 kmua 内置 Agent 也不能证明裁剪了全部普通插件与依赖。

GroupWeave 是外部实际应用；actweave 保留 Skill 标准、作者 Skill 和参考决策。
业务由现成 Koishi 插件、DSH 固定命令 / 工具或显式 AI + Skill 执行，
没有把参考成品的运行层或另一套通用 Harness 复制到 actweave。

## Koishi 的管理与成员入口设计

本轮核对官方[插件配置](https://koishi.chat/zh-CN/manual/usage/market)、
[过滤器](https://koishi.chat/zh-CN/guide/plugin/filter)、
[权限](https://koishi.chat/zh-CN/manual/usage/customize)及
[多份配置](https://koishi.chat/zh-CN/manual/recipe/multiple)。采用列表/详情、
启停保留配置、成员指令帮助的呈现方式；后续已实际引入 Koishi 核心与 Echo，
尚未采用其 Schema、全局 Console 权限和插件市场。事实与本项目设计映射见
[ROLE-EXPERIENCE](ROLE-EXPERIENCE.md)。
