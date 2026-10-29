# 从权限面板原型推进到真正的 Telegram 机器人

核对日期：2026-10-11（Asia/Shanghai）。本轮核对当前 GroupWeave 源码、
官方机器人文档/仓库及 deployment host 上 antiad 的服务元信息与源码。
没有实际使用第三方机器人，没有执行真实 Telegram 操作或验收线上处罚效果。
本文保留本次实施前的研究基线与复用决策；随后已补齐的命令、欢迎、助手和判定接缝见 [MODULES](MODULES.md)，当前源码与验证以 [ACCEPTANCE](ACCEPTANCE.md) 为准。

## 实施前的结论与落差

研究核对时 GroupWeave 是多租户授权与任务执行原型，已经证明部分执行接口和拒绝
路径，但还缺少日常机器人使用闭环。前一轮优先推进了权限、存储与面板，
真正群内业务过少；不应继续用 Echo 和面板功能数量代表产品完成度。

| 实施前核对的源文件 | 当时实际范围 | 用户能感受到的落差 |
| --- | --- | --- |
| [telegram.ts](../src/server/telegram.ts) | 业务命令只有 /links；注册、帮助和规则管理另有入口 | 群里可用的实用功能很少 |
| telegram.ts 的 source() | 只接受群/超级群，忽略私聊；没有 /start | 没有私聊引导、私人助手或私聊管理入口 |
| telegram.ts 的 mention 分支 | 明确 @ 的文本进入 runLinks | 自然语言目标不能选择 AI 或其他能力 |
| [Koishi 与 AI 切片](KOISHI-CODE-AI.md) | Echo、digest、link-brief 仅面板 | 后端存在不等于群内可用 |
| [koishi.ts](../src/server/koishi.ts) | 内部 CodeBot/Session 执行两个具体命令；禁止直接消息 I/O | 已引入核心，但尚未形成完整消息、事件和业务插件宿主 |
| [ai.ts](../src/server/ai.ts) | 固定摘要和固定 link-brief 组合 | 尚不是按任意目标自由组合获准插件 |
| [store.ts](../src/server/store.ts) | 欢迎/提醒是目录占位 | 目录存在不等于事件功能已实现 |
| [角色说明](ROLE-EXPERIENCE.md) | 面板 group 结果仅面板共享，不自动发 TG | 面板任务没有回到原聊天的完整体验 |

真实 Telegram、模型、Mini App 与生产验收仍以 [ACCEPTANCE](ACCEPTANCE.md)
列明范围为准；研究阶段没有重跑全套测试，后续实施的测试与运行身份由该报告单独记录，不能把旧测试记录当作当前真实群体验。

## 完整机器人的可借鉴之处

这张表比较官方资料记载的功能，不作好用程度、用户规模或隔离质量排名。

| 参考 | 本轮核实的功能/设计 | 对 GroupWeave 的具体启发 |
| --- | --- | --- |
| [Rose](https://missrose.org/docs/) | 欢迎、规则、验证、举报、禁言/封禁、过滤、反刷屏、反突袭；按钮及群/私聊管理入口 | 机器人有持续的群内事件职责，成员和管理员在聊天里完成操作 |
| [AstrBot](https://github.com/AstrBotDevs/AstrBot/) | AI 聊天、会话指令、插件指令/AI 工具；配置与会话规则控制插件和 LLM | 代码插件和 AI 能力共同出现在聊天流中，普通代码指令可在 LLM 关闭时使用 |
| [kmua](https://github.com/krau/kmua-bot/) | 明确提供 Telegram Mini App 管理面板和聊天菜单接入 | 参考其 Telegram 与辅助面板衔接；当前帮助页注明需更新，本轮未确认其完整插件清单 |
| deployment host antiad | 当前源码提供自动检测、入群/消息验证、举报、私聊申诉与管理员复核 | 首个真正有用的能力来源；从完整业务闭环复用，而非另添手工评分演示 |

关键一手资料：

- Rose [私聊连接某群](https://missrose.org/docs/basics/connections/)、
  [管理员权限](https://missrose.org/docs/moderation/admins/)、
  [欢迎与媒体](https://missrose.org/docs/greetings/)、
  [关键词过滤](https://missrose.org/docs/filters/)。
- AstrBot [指令](https://docs.astrbot.app/use/command.html)、
  [每会话规则](https://docs.astrbot.app/use/custom-rules.html)、
  [插件](https://docs.astrbot.app/use/plugin.html)：平台禁用插件不能被会话规则
  重新加载，插件还需实际注册工具且满足模型/人格许可，才可作为 AI 工具。
- kmua [面板](https://kmua.unv.app/webapp/)和
  [需更新的帮助页](https://kmua.unv.app/help/)。不以未核实的功能作结论。

## deployment host 上现有 antiad 的真实范围

SSH 只读观测到 antiad.service 为 active/running，工作目录 /opt/antiad；
README 将部署实例标为 @ExampleBot。服务在运行不证明各条功能正在
线上启用，也不证明源文件与长时间运行进程的已加载代码完全一致。
未读取生产配置、密钥、数据库、模型内容、日志或用户消息。

| 代码接缝（远端 /opt/antiad/src/antiad） | 已核实内容 | 复用边界 |
| --- | --- | --- |
| scoring.py 的 Scorer.score(ctx, tun) → Verdict | 本地模型与规则产生判定，不直接操作 Telegram/DB | 可作为内部判定核心，可信事件提供身份/群上下文 |
| model.py 的 TextClassifier / ClassifierBundle | TF-IDF、LogisticRegression、广告相似度 | 推理可复用；训练、保存及历史样本另有权限与状态影响 |
| moderation.py 的 Moderator | 限制/解除、禁言、封禁/解封、删除、通知 | 有实际副作用，必须由当前群策略和真实权限约束 |
| bot.py 的 _handle_chat_member / _handle_group_message | 自动入群与消息处理、验证、CAS、反馈、图片检查 | 是完整反广告插件的事件入口 |
| _handle_report / _handle_report_decision | 举报与管理员复核 | 报告、原消息、操作人和目标必须同时属于当前群 |
| _begin_appeal / _finish_appeal / _handle_appeal_decision | 私聊申诉与管理员决定 | 私聊个人身份不自动授群权，案件须绑定来源群 |
| _sweep_expired / _retrain_if_needed / run | 超时、学习、重试/清理、polling | 沿用现成生命周期，不再叠建本项目通用调度或 Agent loop |

当前源码还存在可选 LLM：llm.py 的 TrustReviewer.review 与
ImageAdjudicator.is_advertisement；bot.py 有弱挑战复核、灰区观察和信任
复核。初始化受 llm_enabled / llm_review_images 等配置控制。
未读生产配置，不推断线上启用了哪些模型、每条消息是否调用或真实费用。
这些是窄判定接口，不是能任意调用管理工具的 Agent。

**当前没有现成预测 CLI/API。** pyproject 只有 antiad、antiad-train、
antiad-calibrate；__main__.main 是配置/数据库检查和 polling 启动。
不能把 antiad 主命令当预测工具，也不能直接把旧机器人当通用工具调用黑盒。

## 接入前必须处理的群隔离缺口

1. **训练反馈共享。** db.py 的样本唯一键是 (target,text)，load_samples
   没有群条件；同文本重标会更新 label 和 chat_id。_retrain_if_needed
   读取全部样本并替换同一个模型，A 群纠错可以影响 B 群判定。
2. **管理员来自全局白名单。** bot.py 的 is_admin 只看
   settings.admin_user_ids；不能直接当成各群 Telegram 管理员资格。
3. **案件有全局查询。** get_ban、get_appeal、list_appeals、get_report
   等存在按全局 ID/状态查询。群主管理入口必须追加可信群范围与对象授权，
   不可直接透传聊天文本里的案件 ID。
4. **已有群键不是完整隔离证明。** messages、approved、vouches、pending、
   strikes 和举报等大多有群范围，但不能覆盖共享训练和全局读取的问题。

初期建议使用经过批准的共享只读基础模型；各群私人反馈暂不自动并入全局
训练。案件、信任、规则、通知和处置按群隔离。完整模型来源/使用许可与
反馈策略、现有 LLM 的数据发送范围、配置委托字段仍是实施前要确认的事项，
不能把建议当作已经生效的设置。

## 产品与接入顺序

产品上增加一个完整的“反广告与成员验证”插件：群管理员设置本群策略，
自动检测由代码执行，成员通过验证、举报和申诉参与。score 是内部第一条
接缝，不等于全功能接入；AI 只用于明确需要的建议与复核，不必每条消息都
跑 Skill，不因模型文本就赋予封禁权限。

建议按以下顺序推进：

1. 让成员在 Telegram 内完成 /start、功能发现、命令/@/回复调用、处理中
   反馈、结果/失败回传及可取消操作；私聊管理先验证个人及所选群权限。
2. 接入 antiad 判定核心，随后覆盖群消息/入群、验证按钮、举报、申诉和
   处置生命周期；逐项证明两个群允许/拒绝与中途撤权，而非只加评分面板。
3. 将摘要/混合能力补到真实聊天入口，再增加按目标选择获准工具的 AI 路径；
   当前固定 link-brief 保留其真实范围，不宣传任意插件自动可组合。
4. 接一个有实际用途的普通生态插件（如欢迎/规则/关键词），证明本群参数
   生效；复杂配置留在辅助面板，市场/完整 Console 不阻塞首个真实闭环。

Koishi 应逐步承担实际消息、事件和代码插件宿主；GroupWeave 保留群授权与
可调参数约束；DSH/Skill 是 AI 的既有执行入口。当前尚是 grammY 消费更新、
Koishi 内部执行代码的过渡形态。完整迁移时沿用单 Telegram 消费者、单数据库
owner，不留两套长期业务 handler。

Python 核心可在外部 GroupWeave 应用中通过明确的 Python 适配入口复用，
无需按群起容器。是否采用短进程或现有服务，要先测模型加载/常驻成本；
不凭旧内存样本承诺适配后仍满足现有容器上限。WTS/actweave 不增加执行器、
工具协议或工作流运行时。旧 antiad 服务保持现状；新插件通过验收后再安排
接管，同一 Token 只能有一个更新接收者。

## 证据渠道与未验证项

官方 GitHub/文档经网页工具核对；成功打开主来源 13 页，另有 5 条官方检索
页面作为发现线索，同批 7 页用一次 HTTP 批处理补读。实际使用 3 次 web.run
和 1 次 HTTP 批处理。SSH 共 6 次：4 次主任务服务/文档检查，2 次源码 AST
检查；总外部读取 10/14 次。没有实际使用、用户留存或性能证据。
当前本地源码与远端静态代码可证明上述接口/分支存在，不能证明线上完整效果。

未完成：新插件实现、实际调用桥接、真实 Telegram 接管、两群业务/案件/反馈
隔离、真实 LLM 配置/成本与效果、模型再分发许可、峰值和长期资源验证。
本次没有修改线上服务或调用处罚接口。
