# 直接使用 Koishi 插件生态，与 Photon 的取舍

日期：2026-10-07。用户进一步明确：直接引入 Koishi 系统作为代码能力的插件
宿主，AI/Agent + Skill 按目标编排组合已允许的插件能力；同一任务可以部分
AI、部分代码。产品保留平台管理员、群管理员、群成员三类使用方式。
**这是当前选定方向；首个代码层与混合调用已引入，完整宿主迁移仍未完成。**
当前切片为 Koishi 核心+官方 Echo、自有链接插件和 DSH 混合 Skill，见
[实际代码绑定](KOISHI-CODE-AI.md)与[ACCEPTANCE](ACCEPTANCE.md)。
旧版本的 112 项通过记录不构成新宿主或任何第三方插件的验证。

## 当前方向及其原因

直接把 Koishi 作为外部 GroupWeave 的机器人与插件宿主，尽量保留官方核心，
用其现成插件扩展机制实现我们的多租户产品。优先采用 npm 依赖与自有插件，
不要先长期 fork Koishi 核心，也不要自己再造兼容它的市场、加载器和配置语言。

Koishi 已有插件安装/依赖管理、配置表单、启停、指令、适配器、服务注入及
生命周期。仅仿照它画界面无法获得这些生态收益。来源：
[插件管理](https://koishi.chat/zh-CN/manual/usage/market)、
[配置 Schema](https://koishi.chat/zh-CN/guide/plugin/schema)、
[服务](https://koishi.chat/zh-CN/guide/plugin/service)。

“能安装原生插件”“能让不同群配置不同参数”“能安全开放给租户”是三个不同
验收问题。我们直接复用通过核验的插件，仅对缺少群范围的部分做适配，不承诺
任意插件安装之后就自动拥有完整隔离。

## 修正旧的执行选择

现有版本把自有固定任务和 AI 都绑定到 DSH，能证明这两项能力的原生守卫与
生命周期。它适合当前示范，但若把所有 Koishi 插件都重新包装成 DSH 工具，
就会变成逐个重写，无法达到“直接吃生态”。当前明确采用：

| 能力 | 推荐执行所有者 | 权限与证据范围 |
| --- | --- | --- |
| 普通 Koishi 插件 | 原生 Koishi 指令/中间件/插件 | 当前群资格、平台准入、群启用范围、插件自己的数据与发送目标检查 |
| 按目标组合插件的 Agent + Skill | 既有 DSH 的 Agent/Skill，通过自有 Koishi 接入调用获准能力 | Harness 原生权限，实际调用前再核验当前群/操作者/字段/目标/受众 |
| 自有链接整理 | 暂保留已有 DSH 代码绑定，或独立迁成普通插件 | 仅此路径原有证据有效，不能推给所有生态插件 |
| 文件、私密连接、宽工具、不可信代码 | 经核验的既有外部宿主或平台专用插件 | 逐项验证；同进程插件与 filter 不提供恶意代码沙箱 |

这是对“全部业务都要经过 CLI/DSH”的修订。AI 依然使用既有 Harness；
普通代码插件无需模型。AI 可以组合代码能力完成任务，代码也可在需要判断或
生成的环节调用 AI；不将 AI 限定成一个与其他插件无关的摘要功能。
群主不能通过配置扩大工具、凭据、文件或目标群权限。
actweave 本体仍只维护标准和两份 authoring Skills，Koishi 属于外部应用。

### 同一能力，两种正常调用方式

现有插件通过 Koishi 原生命令、服务或中间件执行。需要 Agent 调用时，只为
已选择的插件使用其**实际存在的命令或服务 API**，在 DSH 中声明少量明确的
原生 tool 绑定；底层仍执行同一代码能力，不重新实现插件业务。
插件天然可安装不代表天然具备 Agent-callable API，也不承诺让 AI 自动调用
所有生态插件。只有消息监听、没有可调用入口的插件，先保留原生使用方式；
必要时给该插件做小扩展或记录缺口，不造通用兼容协议和第二份工具注册器。

例如“整理本群链接并给出本周要点”：代码能力读取本群允许的数据并整理
链接；Agent 按 Skill 判断哪些内容需要总结；获准的模型环节生成要点；
代码能力校验并输出结果。输入、目标、授权、停止条件与成功证据写进普通
可审阅 Skill；Harness 负责 Agent 和工具调用，Koishi 插件负责真实代码执行。
这是目标驱动的混合执行示例，不是固定 DAG 或新增工作流引擎。

对步骤确定、重复频繁的任务，可直接使用已有代码能力或小型自有 Koishi
插件完成固定组合，不要求每次插件运行都经过模型。AI 主要用于需要判断、
适应反馈或生成内容的环节；无需随机性和适应性的环节优先代码。

两条调用路径必须接受同一实际能力边界：原生入口在执行前核验会话授权；
DSH 绑定在每次调用前由服务端核验当前租户、实时角色、允许字段、数据范围、
发送目标与受众。不能相信模型提供的 tenantId、角色或目标群，也不能用调用
开始时的权限快照替代后续核验。AI 的计划、用户描述与 Skill 不能给插件增权。
这只约束已接入并核验的能力，不声称能自动包住任意第三方 Node 代码。

## 三类产品入口映射

| 使用者 | 原生 Koishi 能力 | 我们必须提供的部分 |
| --- | --- | --- |
| 平台管理员 | 市场、版本/依赖、全局插件配置、启停、日志与状态 | 插件准入、实际访问范围、哪些字段可以委托给群管理员 |
| 群管理员 | 被批准插件的原生参数类型与可用能力 | 当前群身份、允许字段、群启用/配置提案、版本比较、生效结果 |
| 成员 | 原生指令、帮助、消息交互 | 当前群可用能力发现、个人/群结果边界、入口的真实权限 |

三类入口是操作作用域，不是三个部署或全局递增权限等级。同一人可在甲群
管理、乙群为成员，另有平台维护资格也不推出群权。不为每群建立常驻容器。

平台管理可优先用官方 Console；群/成员界面先保留现有独立面板。官方 Console
可以扩展，但不能把全局配置页面仅隐藏按钮后开放给群主。见
[Console 扩展](https://koishi.chat/zh-CN/guide/console/)、
[默认权限](https://koishi.chat/zh-CN/manual/usage/customize)。

群参数尽量利用插件原生 Schema 校验；只开放平台明确允许的字段。
Schema 描述类型与表单，不自动表示可委托权限。凭据、路径、目标群、执行代码
等不能仅因为 Schema 包含该字段就交给群主。自然语言可提出原生配置候选与
普通 Skill 的功能组合，预览并确认后在允许范围生效，不生成新 DSL 或直接
控制全局 loader。配置确认不代替执行时鉴权。

## 核验到的 Koishi 来源与许可

以下为研究阶段 npm registry 与作者源码只读事实；后续切片已锁定安装核心
4.18.11 与 Echo 2.2.5，其余组件不能由表格推导已安装。源码
HEAD 和 npm 发布包不保证完全一致；采用时还需核对锁文件与 tarball。

| 组件 | 当前核验版本/源码 | 许可 |
| --- | --- | --- |
| Koishi 核心、Loader | 4.18.11 / 4.6.11；[源码5525cfd](https://github.com/koishijs/koishi/tree/5525cfd06e0e48be0d65fa31a0ce46d0dc65ffde) | [MIT](https://github.com/koishijs/koishi/blob/5525cfd06e0e48be0d65fa31a0ce46d0dc65ffde/LICENSE) |
| 官方 Telegram adapter | 4.5.11；[Satori c466fb0](https://github.com/satorijs/satori/tree/c466fb01c5629a0d73f1c01205127b737b6fadd6/adapters/telegram) | [MIT](https://github.com/satorijs/satori/blob/c466fb01c5629a0d73f1c01205127b737b6fadd6/LICENSE) |
| Console / Config / Auth / Market | 5.30.11 / 2.8.6 / 4.1.7 / 2.11.11；[WebUI ec7b484](https://github.com/koishijs/webui/tree/ec7b4849564347316d9000965606a452b584d8ec) | [AGPL-3.0](https://github.com/koishijs/webui/blob/ec7b4849564347316d9000965606a452b584d8ec/LICENSE) |
| Help / Echo | 2.4.6 / 2.2.5；上列 Koishi 作者仓库 | MIT |

不能把 Koishi 核心的 MIT 推及全部 Console 或生态包。具体采用哪些组件、是否
修改和怎样发布，应逐包核对其许可要求；本轮没有作整个衍生应用的法律判断。

Config 的 [writer.ts](https://github.com/koishijs/webui/blob/ec7b4849564347316d9000965606a452b584d8ec/plugins/config/src/shared/writer.ts#L49)
以全局 authority 4 保护 manager 操作，写入的是整个 loader 配置；
[Auth 拦截](https://github.com/koishijs/webui/blob/ec7b4849564347316d9000965606a452b584d8ec/plugins/auth/src/index.ts#L223)
主要核验登录、过期和全局权限阈值。两者不能自动表达“只管理甲群”。

Console 扩展使用 Vue 与 @koishijs/client，不能原样塞入现有 React 页面；平台
原生 Console 和群/成员普通面板可以先分开入口，仍共用可信业务与单服务部署。

## 生态兼容的具体边界

1. **支持 Telegram 与消息元素。** 插件写有 Koishi 依赖并不代表适配所有平台。
   使用 QQ 专用 API、特定消息元素或平台字段的插件需要检查其实际条件。
2. **每群不同参数。** 大多数插件通常只有一份配置；支持 reusable/fork 的
   插件可采用原生多份配置，computed 参数则按真实会话计算。其余插件只能
   共用平台参数，或需要插件自身增加群参数支持。不可假设任意插件按群重复
   实例化。来源：[插件配置说明](https://koishi.chat/zh-CN/manual/usage/market)。
3. **过滤器。** 使用平台+群/频道过滤限定触发范围，仍须检查后台定时器、
   缓存键、查询与发送目标。[filter](https://koishi.chat/zh-CN/guide/plugin/filter)
   是会话范围机制。它不会自动给 SQL、Node 文件/网络或所有 Bot 方法加授权。
4. **生命周期。** Context 管理的资源可随插件销毁释放；插件自己创建的
   网络服务或其他资源需要自行清理，不能自动套用我们已有取消/drain 保证。
   来源：[生命周期](https://koishi.chat/zh-CN/guide/plugin/lifecycle)。

实际选择顺序：同参数且不同启用范围采用一个实例；支持 reusable 的采用
原生分组 Fork；支持 computed 的仅对该参数用 session.resolve；三者都不
具备的显示“平台统一参数”或做小补丁。禁止擅自给未知插件标 reusable。

官方 [Help 源码](https://github.com/koishijs/koishi/blob/5525cfd06e0e48be0d65fa31a0ce46d0dc65ffde/plugins/common/help/src/index.ts)
使用 command.match 与 permissions.test 筛选可见指令，是直接原生复用的起点。
作者 [Repeater](https://github.com/koishijs/koishi-plugin-repeater/blob/main/src/index.ts)
状态按会话 cid 分开，但检查到的 onRepeat 配置全实例统一，未声明 reusable/
computed，不能单靠 filter 实现每群不同阈值；该 main 为可移动来源，采用前
核对发布包（源码 package 1.0.0、npm latest 1.0.1 在本轮有差异）。

例如官方 [Echo](https://koishi.chat/zh-CN/plugins/common/echo) 默认回显权限 2，
指定用户/频道/群发送的选项需要权限 3。它本身有权限检查；但若为了让群主
管理而授予全局权限 3，便可能扩大到其他上下文。不能从“在甲群触发”推出
“只能发到甲群”。这是本项目基于其行为作出的隔离判断。

### 平台准入分类

| 类型 | 直接复用的条件 | 给群管理员的范围 |
| --- | --- | --- |
| 无状态、当前输入、当前会话输出 | 核查无跨目标选项与隐式全局状态，实际两群验证 | 群启用和允许参数 |
| 订阅、群数据、缓存、后台通知 | 核查平台/群键、读写查询、后台目标、卸载与恢复 | 已验证的本群记录与参数 |
| 全局管理、跨群广播、私密凭据、Shell/文件、宽网络 | 平台维护；需要时采用已有隔离宿主 | 不直接开放全局配置或任意执行 |

AI 代码审查可以帮助归类和找缺口，不能仅凭“评分通过”把插件自动开放到
多租户环境。规模由实际代码、依赖、活动实例、后台任务决定，体积不代表权限。
Koishi 的沙箱调试插件也不能未经核查解释为恶意 Node 代码安全沙箱。

## Photon 实际提供什么

Photon 的 Spectrum 是多渠道消息 SDK。它统一 Provider、消息、Space、用户、
内容与平台能力；业务、工具、记忆和安全仍由应用的 Agent 服务负责。官方公开
SDK 为 MIT，不等于托管线路、Dashboard 和云网关都公开并可原样自托管。
来源：[介绍](https://photon.codes/docs/spectrum-ts/introduction)、
[作者仓库](https://github.com/photon-hq/spectrum-ts)。

其扩展生态主要是渠道 Provider、内容和集成，未找到类似 Koishi 的现成群业务
插件市场或可直接安装 Koishi 插件的兼容层。对于当前“复用业务插件”的优先级，
Koishi 更合适；未来需要 iMessage 可再评估 Photon 的那个渠道。

源码只读快照：`photon-hq/spectrum-ts`，HEAD
`c4912790afab32b2cc1c5c7daeedf8392a4843fd`，提交时间 2026-09-23；
该快照 `@spectrum-ts/telegram` 包版本 12.10.1。未安装、运行或发送消息。

### Telegram 的当前实现限制

- Bot API 发送、Fusor Webhook 收入，存在真实 Telegram Provider。
- 收入映射明确忽略 callback_query、成员变化、编辑和投票等更新；不能直接
  替代现有 /rules 确认按钮、成员核验与迁群处理。文档表格和此快照对编辑的
  描述有差异，按实际源码核查迁移，不把表格当运行证明。
- 统一层投票、改群名/头像、加减成员/离群等 TG 动作暂不支持，需要时用平台
  原始能力并额外鉴权。
- Space 是会话寻址对象，用户解析不提供当前群管理员/成员授权。

证据：[TG 配置](https://photon.codes/docs/spectrum-ts/providers/telegram/setup)、
[收入映射](https://github.com/photon-hq/spectrum-ts/blob/c4912790afab32b2cc1c5c7daeedf8392a4843fd/packages/telegram/src/inbound/messages.ts#L116)、
[发送限制](https://github.com/photon-hq/spectrum-ts/blob/c4912790afab32b2cc1c5c7daeedf8392a4843fd/packages/telegram/src/outbound/send.ts#L183)、
[Space](https://github.com/photon-hq/spectrum-ts/blob/c4912790afab32b2cc1c5c7daeedf8392a4843fd/packages/telegram/src/space.ts)。

### 可以学习，但需要调整的机制

| Photon 机制 | 本项目采用时的边界 |
| --- | --- |
| Provider 负责渠道，Agent 服务负责产品行为 | 保持 Koishi、治理与 Harness 的职责清楚；不同时运行两套 Telegram 接收 |
| 合并连续输入、取消过期生成、typing 清理 | 仅在真实会话需求出现时采用；群内不同操作者不能互相误取消 |
| 稳定发送标识、结果与投递分开 | 必须检查当前 Provider 实际支持；Telegram 发送未知仍不能承诺任意重试不重复 |
| 用户记忆与聊天线程分别寻址 | 本项目加租户、操作者和受众；不自动跨群共享私人工作记忆 |
| 项目管理 API/CLI/OAuth scopes | 项目 secret 不能给群主；资源 scopes 不证明已有群级/行级权限 |

Photon 的[恢复建议](https://photon.codes/docs/best-practices/recovery-and-state)
把 senderAddress 用作记忆资源、chatId 用作历史线程，同人群聊与私聊共用工作
记忆；不能直接复制到我们要求群隔离的范围。[架构建议](https://photon.codes/docs/best-practices/architecture)
使用任务队列和阶段作业，本轮不引入这些设施或复制成 WTS 工作流引擎。

开发者原始 custom Bot API 允许方法和参数，发送时参数可覆盖 chat_id；不能
直接暴露给 AI 或群管理员并声称 Space 已固定授权。来源：
[原始调用](https://github.com/photon-hq/spectrum-ts/blob/c4912790afab32b2cc1c5c7daeedf8392a4843fd/packages/telegram/src/outbound/message.ts)、
[目标参数合并](https://github.com/photon-hq/spectrum-ts/blob/c4912790afab32b2cc1c5c7daeedf8392a4843fd/packages/telegram/src/outbound/send.ts#L32)。
这体现 SDK 的责任范围，不等于向 Photon 发起或验证了安全攻击。

官方[API](https://photon.codes/docs/api-reference/introduction)中的项目 secret
是全项目管理权限；[OAuth scopes](https://photon.codes/docs/api-reference/oauth)
没有在本轮公开证据中证明能限定到某个 Telegram 群或数据行/字段。

### 成本与部署

官网[定价](https://photon.codes/pricing)当前列 Free 最多 10 用户、Pro iMessage
25 美元/月最多 100 用户、Business 250 美元/线路/月，群聊完整 API 在 Business
说明中；Telegram 标为 Included，不能由此推断所有网关或自托管服务成本。
本地 iMessage 需要 Mac 的 Messages 登录与 Full Disk Access，不适用于现有
Linux deployment host 单容器。见[集成部署方式](https://photon.codes/docs/integrations/chat-sdk)。
延迟、用户规模与合规表述是供应商声明，本轮无实测或独立审计确认。

## 迁移起点与完成门槛

先做原生生态的小试验，成功后再逐步替换接入。详见
[KOISHI-MIGRATION](KOISHI-MIGRATION.md)。此页的选定方向不表示已经完成迁移，
当前实际引入与容器证据以 [KOISHI-CODE-AI](KOISHI-CODE-AI.md) 和 ACCEPTANCE
为准；不由首个切片推导完整 adapter/Console 或任意插件隔离已完成。
