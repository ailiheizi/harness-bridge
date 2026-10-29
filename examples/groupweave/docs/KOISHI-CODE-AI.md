# Koishi 代码插件与 AI 组合：实际绑定

更新：2026-10-11。2026-10-07 首个切片已扩展为有限机器人模块；
[MODULES](MODULES.md) 列出当前可用范围和后续门槛。用户明确：先直接引入 Koishi 作为代码部分的插件化宿主，
由既有 Harness 中的 Agent + Skill 组合已允许能力，一个任务可交替使用 AI
和代码。普通代码功能仍可单独调用。本页记录实际代码切片，验证状态另见
[ACCEPTANCE](ACCEPTANCE.md)。完整 Telegram/Console 迁移仍未完成。

## 实际职责与入口

```text
群成员的明确输入 → 现有 HTTP/TG 身份、群配置与任务检查
  文本代码任务 → Koishi 原生插件/指令 → 代码结果
  反广告判定 → 固定 Python 适配器 → 批准的只读模型推断 → 判定建议
  混合任务 → DSH Agent + 审核 Skill
           → 原生 organize_links 工具 → 当次群权/功能重查
           → 同一个 Koishi 链接插件 → 普通原生工具结果
           → Agent 生成说明 → 原生完成与调用证据
  最终结果 → 现有任务归属、取消、当前权限与受众检查
```

Koishi 的 App、plugin、command、Bot/Session 与过滤器负责代码插件执行。
DSH 的 AgentLoop、ToolRuntime、SkillRegistry 和普通消息负责 AI 组合。
GroupWeave 负责当前身份、群与字段、任务配置快照、平台准入和结果受众。
actweave 保持标准与两份 authoring Skills，不拥有这些运行设施。

没有新增模型循环、DAG、工作流图、编译器、通用插件调用格式或注册器。
普通插件不要求每次先调用 AI；现成插件也不自动变成 Agent 可调用工具，
仅按真实命令/服务增加明确的现有 Harness 绑定。

## 当前能力与聊天入口

| 功能 | 实际路径与入口 | 成功与成本界限 |
| --- | --- | --- |
| link-cleaner | `/links`/纯链接 @/面板；既有 DSH 无模型命令/工具 → Koishi 自有链接插件 | 0 次 LLM；保留旧原生 guard 和参数快照，不打开链接 |
| echo | `/echo`/面板；直接官方 npm Echo 插件，源码未修改 | 0 次 LLM；仅当前输入，不接受跨目标命令选项 |
| digest | `/digest`/面板；审核摘要 Skill → DSH 原生 Agent | 1 次模型尝试、0 工具；每次第三方确认 |
| link-brief | `/brief`/面板；DSH Skill → 工具请求 → Koishi 链接插件 → 模型说明 | 恰好 2 次模型、1 次成功代码工具；本群链接依赖持续有效 |
| assistant | `/ask`/目标描述 @/面板；审核群助手 Skill → 原生 Agent | 直接回答为 1 模型/0 工具；获准链接工具为 2 模型/1 工具；无任意工具或历史 |
| welcome | 当前 `new_chat_members` → 自有 Koishi 明文模板插件 | 0 次 LLM；一遍替换 `{name}`/`{group}`；本群模板/身份/结果范围 |
| antiad | `/scan`/面板 → 用户既有纯预测模块的固定 Python 适配器 | 0 次 LLM，但本地 ML 分类器须真实运行；无处罚/训练，缺模型阻止执行 |

代码/AI 命令可直接给当前文本，或明确回复一条本群文本后发送命令；回复主体
只提供输入。mention 模式须带实际机器人用户名。普通代码不需要 AI 同意，
AI 则每次原生确认。群内结果公开给发起群且锚定选中消息；面板的 group
结果只在本群面板共享，不自动推送 Telegram，private 只给本人。

三种 AI 默认关闭。需 ENABLE_AI=1、应用专用 Key、平台开放、本群启用及每次
第三方处理确认。brief 还要求本群 link-cleaner；助手只有宿主实际判定代码可用
才暴露链接工具。AI 把本次原文及适用时的整理结果发送给 DeepSeek，不读取
群历史、不抓取网页。每次 dispatch 最多 1024 输出 tokens，输入最多
8000 UTF-8 字节，原生重试为零；最多两次请求不等于固定账单或正确答案。

唯一 grammY 更新消费者、规则按钮和签名登录保留，没有启动第二个 Telegram
接收端。`telegram/product.ts` 用原生 Composer 分离有限命令/事件；私聊
`/start`/`/help` 只安全引导，不列群或授群权，私聊业务/管理尚未实现。

## 明确的代码和 Harness 绑定

- [koishi.ts](../src/server/koishi.ts)：三个具体命令能力 executeLinks/executeEcho/executeWelcome，
  原生结构化 argv，不将输入拼接成命令；不启动 HTTP/Server/Loader。
- [links.ts](../src/server/links.ts)：迁出的既有纯文本算法与固定输入错误，
  无网络/文件；[原生链接插件](../src/server/koishi-plugins/links.ts) 在
  Koishi command.action 下调用它。
- [欢迎插件](../src/server/koishi-plugins/welcome.ts)：本群普通文本模板和事件
  显示名只一遍替换，h.text 输出；不解析组件、命令或表达式。
- [native.ts](../src/server/native.ts)：原有 DSH 固定命令/工具改调用同一 Koishi
  链接能力，继续 guard 和真实 drain；这不是所有插件的统一强制入口。
- [ai.ts](../src/server/ai.ts)：复用原有 composition，workflow 明确选 summary、
  link-brief 或 assistant；brief 仅有无参数 organize_links，assistant 仅在
  宿主允许时暴露同一工具，否则工具为空。
- [mixed.ts](../src/server/mixed.ts)：该工具的明确绑定。调用时重查真实群成员、
  平台和本群两个功能，再按本任务已冻结参数调用 Koishi。
- [群助手 Skill](../audited/group-assistant/SKILL.md)：处理本次目标，能用的
  工具来自宿主实际绑定，不执行原文中扩张身份/权限/工具的声明。
- [link-brief Skill](../audited/link-brief/SKILL.md)：指导 Agent 使用代码结果，
  不把原文中的指令、假结果或权限声明当作授权。

2026-10-07 首次接入在当时 Node 26 下观测到发布包可选 ESM Loader 互操作问题。使用 createRequire
加载 @koishijs/core 与官方 Echo 的 CommonJS API，二者共用真实核心实例。
Koishi 关联对象产生 Context proxy；临时请求按原生 session.id 绑定，finally
清理，Bot 按稳定 sn 释放。scope 不建用户库、不复制模型历史。

## 权限、撤权与证据

工具接受空参数对象，模型不能传群、身份、目标、受众、命令、路径或参数。
模型最多两步、工具最多一次；缺工具、未知/非法调用、失败、重复调用、取消
或未完成均停止，不让模型修复扩大范围，也不自动回退另一个工具/模型。

群参数取任务提交时快照。工具调用前重新检查当前资格和功能；群/平台停用
链接插件会取消 brief 和助手；用过链接工具的助手最终提交与 Telegram 投递
还须保持链接依赖有效。最后交付再核验群权、会话与依赖状态，迟到
结果不能伪称成功。纯文本代码结果暂留任务内部，最终 private/group 仍由
普通业务接口决定，不由模型或 Koishi echo 自行发送。

modelCalls 为真实原生 dispatch 尝试，toolCalls 为成功完成时真实代码工具
调用。用量按每次 dispatch 的最后已报告快照累计；漏报保持未知或部分报告，
不把已报告之和称为完整账单。原生 completed 证明流程结束，不证明说明准确。

Koishi 过滤器与这些绑定不为任意 Node 插件提供恶意代码沙箱。第一版仅加载
平台维护的 Echo、链接和欢迎可信文本插件。数据库、后台订阅、跨群目标与宽能力另行验收。

## Telegram 当次确认、取消和反广告入口

AI 原生确认签名绑定功能、本人、当前群、源消息、原 update、精确输入和触发
方式，5 分钟有效。确认消息回复实际选定文本，回调重读并验签；换人、跨群、
修改输入、伪造、缺失回复、过期和重放不能调用模型。只保留最多 512 条已消费
签名/过期时间，不保存输入副本；满额拒绝消费，不驱逐有效重放保护；重建
adapter 换密钥使旧按钮失效。应用持久幂等及投递键仍独立防业务重跑。

处理反馈提供 `/cancel`/本人本群按钮，进入同一实际任务 controller；取消不
等于供应商停止计费、底层已经停机或副作用已补偿。发送前还会重新核验身份、
平台/本群开关和已使用代码依赖，不因原签名曾有效就放行迟到结果。

antiad 是具体外部预测适配器，不经 LLM、不允许 AI 自动删封。模型、Python
依赖或真实 probe 缺失保持不可用/blocked，不以规则-only 输出冒充分类器成功。
各群阈值和词表仅为本次快照，新建评分状态；不导入旧生产数据库、管理员、
样本池、自动训练和处置循环，完整验证/举报/申诉/处罚仍待实现。

默认同一个 Node 应用容器，无每群进程/Agent。反广告仅在
[compose.antiad.yaml](../compose.antiad.yaml) 显式启用时为同一服务安装锁定
Python 依赖并挂载受信只读模型；固定解释器和模型不能由群用户/AI 选择或上传。
joblib/pickle 可执行代码，须由部署管理员审核；旧模型训练样本的共享范围也
须确认。单个短生命周期推断进程有界运行并等待真实 close，容量/质量另验。
[来源与适配边界](../integrations/antiad/README.md)明确私有源码复用，不声称
原机器人整体已迁移或拥有开放再分发许可。

## 依赖与剩余边界

锁定 koishi 4.18.11 与 @koishijs/plugin-echo 2.2.5；实际发布包与锁文件为准。
本切片未采用官方 Console/Config/Market，未引入其 UI 或许可范围。

历史首次审计发现 file-type 16.5.4 的 ASF 解析拒绝服务问题，经 Koishi
HTTP/Satori 依赖传播为 10 条 moderate 记录。其 fromBuffer 接口不能盲目覆盖
为不兼容的 21.x。本次加入 [版本锁定的 patch-package 补丁](../patches/file-type+16.5.4.patch)
回移该循环边界修复，postinstall 缺补丁或应用失败会停止安装；上游版本标签
仍为 16.5.4，不能因此声称 npm audit 无告警。安装、回归与当次审计状态以
[ACCEPTANCE](ACCEPTANCE.md)为准。当前未接附件/文件识别能力；上游升级后
应移除已不适用补丁并重新验证原生调用。来源：
[GHSA-5v7r-6r5c-r473](https://github.com/advisories/GHSA-5v7r-6r5c-r473)。

真实 DeepSeek 质量/费用、真实 Telegram、完整原生 adapter/Console/在线插件
管理、任意业务插件、长期资源负载均不由此切片证明。后续计划见
[KOISHI-MIGRATION](KOISHI-MIGRATION.md)。
