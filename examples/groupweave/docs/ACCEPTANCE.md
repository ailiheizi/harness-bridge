# 当前实施与验收

日期：2026-10-11（Asia/Shanghai）。**机器人模块增量的 227/227 自动测试、
类型/前端构建、默认单容器及本地三角色页面核验 PASS；真实 Telegram、真实
DeepSeek、HTTPS Mini App、可选 Python 镜像及生产稳定性 NOT RUN。**
这是当前可继续演进的实现，不是完整成熟服务或任意第三方插件隔离的验收结论。
后续补充的机制级复用决策019仅为文档设计：尚未安装时间库或接通定时/持续
组合，运行源码指纹不变，没有增加自动发送或无人值守AI授权。

当前模块、架构和成熟度顺序见 [MODULES](MODULES.md)，决策见
[DECISIONS](DECISIONS.md)，剩余工作见 [TODO](TODO.md)。下方封存的 2026-10-07
记录只证明历史版本；其旧命令、功能缺口、镜像、指纹和审计状态不能代替本节。

## 当前代码和运行身份

| 项目 | 实际身份与结果 |
| --- | --- |
| 应用 / 分支 | `the original local checkout`，`codex/first-preview`；工作区未提交，不能以 HEAD 代替源码身份 |
| 复用 | Koishi 4.18.11 与官方 Echo 2.2.5 原包；grammY；真实安装的 DSH Agent/Skill/ToolRuntime；用户私有 antiad 纯预测源码 |
| 指纹范围 | src、audited、integrations、patches 全部普通文件与 package.json/package-lock.json；37 文件，按路径 NUL 内容 NUL 排序计算 |
| 本机及运行容器 SHA256 | `[private digest omitted]`，两处一致；脚本（私人验收产物未随公开案例发布）、容器结果（私人验收产物未随公开案例发布） |
| 实际运行镜像 | `[private digest omitted]`，由 docker inspect 记录；身份（私人验收产物未随公开案例发布） |
| 容器 / 前端 | groupweave-groupweave-1；Node v26.10.0 / UID1000；index-Br1lIiur.js / index-BwtXSU73.css |
| 全套测试 | **227/227 PASS、exit0**，没有跳过、取消或待办；原始日志（私人验收产物未随公开案例发布） |
| 类型 / 前端 | `npm run build` **PASS、exit0**；日志（私人验收产物未随公开案例发布） |
| 默认镜像 / 启动 | `docker compose build` 及 `up -d --no-build` **PASS、exit0**；构建日志（私人验收产物未随公开案例发布） |
| 容器配置 | 只读根目录、512MiB、1 CPU、128 PID、cap_drop ALL、no-new-privileges、User=node；4318 仅绑定 127.0.0.1；仍只有一个应用服务 |
| 运行健康 | ok/preview/executorConnected/koishiConfigured/welcomeConfigured=true；Telegram、模型连接/配置、mixed、antiad、真实登录未启用；采样（私人验收产物未随公开案例发布） |
| 空闲资源单次样本 | 117.8MiB/512MiB，CPU0.40%，43 PIDs；不是峰值、长期压测或生产群数保证 |
| 文档一致性 | 两仓库 `git diff --check` PASS；应用及 actweave 参考目录的378个本地链接无缺失，Markdown 围栏与尾随空白检查 PASS |

复现自动验证：在应用目录运行
`ANTIAD_TEST_PYTHON=/path/to/antiad-venv/bin/python npm test`。
反广告验证使用实际 Python 与临时合成训练/模型，没有使用生产模型或旧数据库。
缺少满足依赖的解释器时不能将跳过的反广告测试报告为本节的全套通过。

## 本轮实际行为与证据

新增 76 项验证：欢迎模块 14、助手 15、实际 Python 反广告 12、Telegram
产品/模块 16、共用入口模块整合 5、投递撤权回归 9、file-type 回归 5。
既有 151 项仍通过。Koishi、DSH Skill/工具与 Python 的本地执行是真实安装库；
Telegram 使用官方 API Transformer 的离线 Bot API fixture，模型响应使用
离线 Adapter/SSE fixture，不能据此宣称真实远端收发、模型质量或费用已验收。

- 聊天入口新增 `/echo`、`/scan`、`/digest`、`/brief`、`/ask` 和本人 `/cancel`；
  `/start` 私聊引导、`/help`、`/plugins`、`/register`、`/settings`、`/rules`
  与现有 `/links` 保留。只有一个 grammY 更新消费者，Koishi 不另开轮询。
- 原生 AI 确认绑定群、本人、功能、源消息、update、输入和触发方式，5 分钟
  有效；重读回复文本后验签。换人、跨群、篡改、重复、过期、重启旧按钮和
  512 项消耗签名容量上限均拒绝；不缓存输入副本。
- 欢迎使用 Koishi 原生插件与 `h.text`；两群模板独立，成员显示名不能成为
  `<at>`/`<image>` 消息组件。官方 Echo 原包未改，代码路径零模型调用。
- 群助手使用既有 DSH Agent + 审核 Skill；无工具为 1 模型/0 工具，用获准
  链接工具为 2 模型/1 工具。群、操作者、目标和工具许可由可信入口冻结；
  模型不能追加工具或指定另一个群。只处理本次明确文本，不读群历史。
- antiad 只复用用户本地三个纯模块，通过固定无 Shell 的 Python 预测入口
  运行。只读管理员批准模型、单活跃子进程、输入/输出/时限/取消均有边界。
  本群阈值和关键词独立；没有旧管理员、案件、数据库、反馈训练或处罚路径。
  `/scan` 只输出检测建议；[来源、许可证边界及接口](../integrations/antiad/README.md)。
- 执行与交付分别核验资格。平台/本群功能及助手实际代码依赖用持久撤权版本
  记录，停用后再启用也不能发送旧结果；最终网络成员查询后同步再次检查，
  然后调用 Bot API。普通参数调整不误伤仍有效的任务。远端已经接收的消息
  无法通过本地撤权撤回，不承诺跨系统原子交付或 exactly-once。
- 面板/任务记录对其他成员隐藏原始 input 字段，private 只给创建者；group
  结果可能包含输入。Telegram 群命令、引用和结果本就公开，字段鉴权不提供
  语义脱敏。平台维护身份不自动授予群内容读取权。

## 当前页面核验

全部操作在上述最终运行镜像、合成群与演示身份执行，没有向真实 Telegram
发送消息或调用模型。

- **PASS**：平台目录 8 项能力；欢迎实现可开放，AI 与反广告缺配置时保持待配置，
  开放按钮禁用，提醒保持待接入。平台无群选择器，不能用维护身份读取群任务。
  反广告平台状态（私人验收产物未随公开案例发布）、
  助手平台状态（私人验收产物未随公开案例发布）。
- **PASS**：设计群管理员预览并保存纯文本欢迎模板，规则 v4→v5；再预览本群
  功能组合并启用欢迎，v5→v6。配置截图：本群欢迎（私人验收产物未随公开案例发布）。
- **PASS**：普通成员只见使用功能/使用记录，设计群显示 3 项开放能力；欢迎是
  加入事件能力，面板只列可手动执行的链接与 Echo。实际私人 Echo 返回包含
  `-c other-group <at id="999"/>` 的完整合成文本，模型调用0，规则v6；
  成员实测（私人验收产物未随公开案例发布）。81ms 只是该次样本耗时。
- **PASS**：同一成员切至周末阅读，只有原有链接能力，旧输入/结果清空；
  另一群成员（私人验收产物未随公开案例发布）。
- **PASS**：阅读群管理员仍规则v1、欢迎未启用且模板留空，没有继承设计群
  模板；另一群配置（私人验收产物未随公开案例发布）。

真实加入事件和长 AI 任务的移动界面仍 NOT RUN；上面的页面证据不能代替
Telegram fixture 以外的远端验收。

## 依赖补丁与审计

Koishi 兼容依赖 file-type 16.5.4 的 ASF 有限载荷问题已回移
[上游修复](https://github.com/sindresorhus/file-type/commit/319abf871b50ba2fa221b4a7050059f1ae096f4f)。
5 项回归覆盖畸形/正常 ASF、PNG、CJS/ESM 与实际 Koishi HTTP 装载；干净安装和
最终镜像内 `Number.isFinite(payload)` 保护存在。默认构建先应用补丁再裁剪依赖；
运行镜像没有 patch-package、braces、micromatch 或 find-yarn-workspace-root，
保留实际启动所需 tsx。[补丁与来源](../patches/README.md)。

**审计仍 FAIL，不声明零漏洞：**`npm audit --omit=dev --json` exit1，10 moderate、
0 high；生产树报告（私人验收产物未随公开案例发布）。包元数据仍是
16.5.4，因此补丁不会让 npm 自动清除传播记录。完整开发树另有构建工具传播的
4 high（共14项）；完整报告（私人验收产物未随公开案例发布）。相关工具
已从运行镜像移除；这不等于开发依赖审计通过。继续跟踪兼容上游版本。

## 未执行与剩余功能

| 项目 | 当前状态 |
| --- | --- |
| 真实 TG 注册/命令/欢迎/降权/迁群/断网/回调/取消 | **NOT RUN**；当前不加载真实 Token，离线 fixture 不能替代 |
| 真实 DeepSeek 请求/取消/usage/质量/费用 | **NOT RUN**；默认关闭，没有使用真实 Key |
| HTTPS Mini App / 移动端登录与交互 | **NOT RUN**；代码和签名测试已做，未配置公网入口 |
| 可选反广告 Python 镜像与批准基准模型 | **NOT RUN**；实际本地 Python 合成模型测试、Linux 锁定依赖 wheels 解析及 compose override 校验通过；默认 Node 镜像未装 Python。本机 Docker VM 仅余239MiB，未继续构建可选镜像；这不是 deployment host 容量结论 |
| 完整反广告自动检测/验证/举报/申诉/删封 | **未实现**；本轮只实现隔离的预测能力，未改动 deployment host 现有 bot |
| 提醒、群历史/知识库/附件/私密连接 | **未实现**；需要实际外部能力及逐资源验证 |
| AI 理解任意规则、指定成员/角色/话题范围、能力申请 | **未实现**；当前规则有限解析、整群启用、联系平台申请能力 |
| 任意生态插件在线安装/Console/官方 TG adapter | **未完成**；当前原生 Koishi 核心与官方 Echo 不能推导所有插件可安全多租户运行 |
| 无模型原生 ask 审批 | **未接通**；上游 open-turn 缺口，不伪造模型 turn |
| 恶意同进程插件隔离、服务器管理员无法读明文 | **不提供**；可信代码与运维是明确边界，不靠 AI 审代码保证完全隔离 |
| deployment host 部署/批准模型峰值/长期稳定/线上恢复 | **NOT RUN**；2026-10-07 主机快照仅历史容量参考 |
| 旧备份之后的 TG 更新自动重放恢复 | **不提供**；未知副作用保持 withheld/unknown，停机隔离后人工核对 |

## 2026-10-07 历史记录（封存，不是本次证据）

以下原文保留历史实施与追溯信息。其“当前”均指当日旧构建；151/112 测试、
旧指纹/截图、无摘要命令/欢迎等旧缺口以及审计结果，不描述 2026-10-11 的实现。

日期：2026-10-07（Asia/Shanghai）。**Koishi 代码插件与 AI 混合首个切片已实现，
151/151 离线测试、本地构建、容器和下列页面操作 PASS；真实 Telegram、DeepSeek、
HTTPS Mini App、生产部署与负载 NOT RUN。依赖审计未通过，生产前须处理。**
不能解释为任意插件或全部未来数据完全隔离。

### 当前 Koishi 与 AI 混合切片

具体职责、绑定和剩余范围见 [KOISHI-CODE-AI](KOISHI-CODE-AI.md)。普通代码由
Koishi 执行；混合任务使用真实 DSH Agent/Skill/ToolRuntime 调用同一插件，
不增加自建 workflow runtime。

| 项目 | 当前实际身份与结果 |
| --- | --- |
| 分支 / 提交 | codex/first-preview；工作区未提交，不能以 HEAD 代替源码身份 |
| 实际依赖 | koishi / @koishijs/core 4.18.11，官方 Echo 2.2.5；Echo 源码未改 |
| 源码指纹 | src、audited、package.json/package-lock.json，共 21 文件；路径 NUL 内容 NUL，SHA256：[private digest omitted] |
| 容器源码 | 同一 21 文件 SHA256，与本机一致；指纹脚本（私人验收产物未随公开案例发布） |
| 实际运行镜像 | [private digest omitted] |
| 容器 / 前端 | groupweave-groupweave-1，Node v26.10.0 / UID1000；index-CqJwHwL5.js / index-BwtXSU73.css |
| 全套自动验证 | npm test：151/151 PASS、exit0，没有跳过/取消/待办；原始日志（私人验收产物未随公开案例发布） |
| 构建 | npm run build：类型与 Vite PASS、exit0；原始日志（私人验收产物未随公开案例发布） |
| 容器 | docker compose build 与 up -d --no-build：PASS、exit0；构建日志（私人验收产物未随公开案例发布） |
| 运行依赖审计 | npm audit --omit=dev --json：FAIL、exit1，10 moderate 传播记录；报告（私人验收产物未随公开案例发布） |
| 文档检查 | 两仓库 git diff --check PASS；应用与 reference 本地链接共 306 个，无缺失 |

新增 39 项覆盖：真实 Koishi 核心与原包 Echo 13 项；混合 Agent/Skill/工具边界
18 项；HTTP/SQLite/DSH/Koishi 集成 6 项；最终身份查询期间撤权/取消 2 项。
AI 模型响应使用离线 adapter；代码工具、Skill 加载和 Koishi 执行是真实安装库。
既有 112 项继续通过，固定路径取消测试改为观察到实际 URL 解析开始再取消。

- 成功的 link-brief 需要两次真实原生 dispatch 尝试、一次完成的代码工具与
  原生完成结果；不调用工具的伪完成、重复/非法/跨群参数和代码失败被拒绝。
- 工具调用前重查群资格与平台/本群依赖，使用任务配置快照；中途停用、
  停用后再启用、身份查询期间取消都不能交付旧结果。
- 普通 Echo 与链接代码仍零模型调用，模型不能指定群、身份、目标或参数。
- inspect：readonly root、512MiB、1 CPU、128 PID、cap_drop ALL、
  no-new-privileges、User=node，仍只有一个应用容器，端口仅 127.0.0.1:4318。
- health：ok/preview/executorConnected/koishiConfigured=true；mixedConfigured、
  agentConfigured/Connected、telegramConnected、loginAvailable=false。
- CUA：设计群管理员预览 Echo 的功能差异后确认，仅本群 v3→v4；成员实际
  私有回显包含 `-c other-group` 的合成文本，完整按文本返回，模型调用 0 次。
  成员执行截图（私人验收产物未随公开案例发布）。
- CUA：同一成员切到周末阅读，只显示该群原有链接功能，没有 Echo，旧输入与
  结果清空；另一群截图（私人验收产物未随公开案例发布）。
- CUA：平台入口无群选择器；混合功能显示实际 DSH→Koishi→AI 依赖与预算，
  未配置模型时开放按钮禁用；平台截图（私人验收产物未随公开案例发布）。
- docker stats 单次样本：118.8MiB/512MiB、CPU6.28%、PIDs43。没有峰值/长期
  压测，不作为生产容量保证。

依赖审计问题来自 file-type 16.5.4 的 ASF 解析拒绝服务，经 Koishi HTTP/Satori
传播；[上游 advisory](https://github.com/advisories/GHSA-5v7r-6r5c-r473)。
当前仅文本，没有启用附件解析或 HTTP/Server 插件；仍须在生产开放前处理，
不能盲目以不兼容主版本覆盖依赖。之前零漏洞结果属于引入前版本。

完整 Koishi Telegram adapter/Console/市场、任意插件准入与资源边界、真实
模型和 Telegram、生产压力与长期稳定性仍未完成。当前无对应新 TG 命令，
Echo/digest/link-brief 仅面板；唯一 grammY 消费者和现有 /links 保留。

### 此前角色版本的历史证据

下面保留引入 Koishi 前的 112 项、17 文件指纹和页面实证，方便追溯。
这些镜像、截图、统计与零漏洞审计结果不是当前构建的验证。

#### 历史实施身份

| 项目 | 当前身份 |
| --- | --- |
| 外部应用 | the original local checkout |
| 版本 / 分支 | 0.1.0 / codex/first-preview；工作区尚未提交，不能用HEAD代替源码身份 |
| 本机 Node / npm | v26.5.0 / 11.17.0 |
| 源码指纹范围 | 按路径排序的src、audited全部文件与package.json/package-lock.json，共17个文件；路径NUL内容NUL依次SHA256 |
| 当前源码SHA256 | [private digest omitted] |
| 容器 | groupweave-groupweave-1 / Node v26.10.0 / UID1000 |
| 实际运行镜像 | [private digest omitted] |
| 容器内源码SHA256 | [private digest omitted]，与本机17文件完全一致 |
| 前端构建 | index-BYAtYmcG.js / index-BwtXSU73.css |

### 自动验证

| 范围 | 命令与实际结果 |
| --- | --- |
| 全套 | npm test，**112/112 PASS，exit0**；原始验收日志未随公开副本发布 |
| 类型与前端 | npm run build（tsc --noEmit + vite build），**PASS，exit0** |
| 运行依赖 | npm audit --omit=dev，**0 vulnerabilities，exit0**；安装时全树审计亦0，不等于代码无漏洞 |
| 仓库与文档 | 两仓库git diff --check **PASS**；文档本地链接无缺失 |

112项包含：16 API、6签名登录/权限、7管理/取消/AI业务门槛、3容量、3客户端
作用域、2固定API整合、16原生代码、18原生AI及HTTP整合、12存储/维护、29 TG
adapter/生命周期/真实Store→DSH整合（新增角色帮助、功能发现及管理员设置4项）。没有跳过、取消或待办测试。

DSH测试调用真实已安装库。Telegram使用官方API Transformer返回合成Bot API
fixture，网络计数0；AI使用offline LlmAdapter或拦截官方Adapter fetch后返回合成
SSE。它们证明代码的接口组合和边界，不证明真实远端响应或业务质量。

#### 核心行为的证据

- 平台默认无群关系，群管理员/成员分离；签名只授个人会话，部署白名单不授群权。
- preview/live命名空间独立，演示登录不能选择持久真实用户；当前群权每次核验，
  成员表是观察，API失败/撤权停止访问。
- 提案绑定群/创建者/版本，未知规则不能启用；严格字段、Zod配置校验与CAS冲突拒绝。
- 本群任务/共享结果可见，private只creator；共享原始input字段隐藏，平台维护
  不读群内容。摘要输出本身仍可能包含原输入信息，不提供自动语义脱敏。
- code调用真实commands→tools、固定guard及新Session/idle Agent，模型调用0；
  英文进入真实函数。AI加载真实审核Skill，工具空集、一次dispatch、原生完成/usage。
- AI默认关闭、专用Key、全局开放+群配置+每次第三方处理确认；UTF8上限、截断/
  失败/取消非成功，无fallback。用量/调用证据缺失显示null，不冒充0。
- 总活跃2/每群1、满额429；等待到期传signal但真实settle前不释放容量。
  创建者取消/注销/撤销/关闭会阻止迟到结果，忽略signal返回成功也不能交付。
- 群迁移只来自可信service字段；旧scope不能覆写新终态。业务幂等、原子投递claim，
  重复update/重建adapter不重执不重发；unknown/withheld不重开，固定失败反馈仅一次。
- 存储正文/提案/审计上限、永存重复保护tombstone与满额拒绝、单owner独占锁、
  旧库迁移；原生SQLite备份校验/配额/drain与停机事务恢复/CLI均在临时库实际验证。

边界详见 [CORE](CORE.md)、[NATIVE-BINDING](NATIVE-BINDING.md)、
[AI-BINDING](AI-BINDING.md)、[TELEGRAM](TELEGRAM.md)、[STORAGE](STORAGE.md)。

### 容器与页面

下列容器检查与三类页面截图对应上表最终构建；规则提案的修改操作在本轮
首个角色构建136ceb73中完成，最终构建确认其持久版本和参数，业务代码未变。

- Docker compose build（固定Node镜像digest镜像源）与up -d --no-build：PASS、exit0。
  Docker Hub此前连接受阻，本轮使用docker.m.daocloud.io的同一固定digest。
- inspect：User=node/实际UID1000、ReadonlyRootfs=true、Memory=536870912、NanoCpus=
  1000000000、PidsLimit=128、CapDrop=ALL、no-new-privileges=true；仅127.0.0.1:4318。
- health：ok/preview/executorConnected=true，telegramConnected/agentConnected/
  agentConfigured/loginAvailable=false；当前未启用真实Token或AI。
- CUA群管理员插件列表/详情：设计群单次条数20→18，预览显示差异后确认，
  版本v2→v3；阅读群仍v1/10条，改动没有写入其他群。
- CUA成员首页：仅使用功能/使用记录导航；可选能力仅本群实际可用的链接整理，
  不显示平台或规则管理入口。实际私有任务两个相同URL→1条，modelCalls=0、规则v3。
  最终构建此样本134ms；耗时不是性能预算。
- CUA成员切群：设计群提示明确@；周末阅读提示/links命令，旧输入与结果清空。
- CUA同源双标签：原标签填写合成私人URL，另一标签切换阅读群管理员后，
  原标签同步切换身份、清空旧输入，使用页只显示阅读群用法；临时标签已关闭。
- CUA平台身份：导航仅插件管理/运行维护，无群选择器；详情显示真实边界与
  可用性开关，待接入能力不能开放。维护页可查看既有maintenance.backup/completed
  全局审计，无群内容；本轮未再创建备份。之前备份UI记录是旧版本证据。
- 此前容器内源码与本机17文件指纹一致；页面使用历史表中的JS/CSS构建。
- docker stats单次样本：115.3MiB/512MiB、CPU10.78%、PIDs44。此为一个时点，
  没有压测/峰值/长期采样，不作为稳定容量保证。

当前三角色图片证据：

- 群管理员的本群插件配置（私人验收产物未随公开案例发布）
- 成员入口与真实私有执行结果（私人验收产物未随公开案例发布）
- 平台插件管理（私人验收产物未随公开案例发布）

- 成员切换到另一群（私人验收产物未随公开案例发布）
- 跨标签身份变化清空旧输入（私人验收产物未随公开案例发布）

五张role图片均已在上表最终构建重新记录。旧platform-management-full.jpg、
cross-tab-isolation.jpg、ai-default-off.jpg仍仅代表之前版本，不是本轮角色改版图片。

真实移动/TG Mini App、长AI任务的面板取消交互未实际操作；取消的原生/HTTP允许与
拒绝路径已自动验证，不能把这些测试写成上述UI场景PASS。

### Historical deployment capacity note

An earlier read-only host sample was retained privately for planning a controlled
trial. Host aliases, service names, machine metrics, and the original report are
not included in this public copy. Such a sample does not establish this
application's peak capacity, long-term stability, model cost, or supported
group count.

### 未执行与明确缺口

| 项目 | 状态与原因 |
| --- | --- |
| 真实TG注册/收发/降权/迁群/网络失误 | **NOT RUN**；未加载真实Token，仅离线BotAPI实证 |
| Telegram内HTTPS Mini App/移动UI | **NOT RUN**；签名库与API已离线测，未配置公网入口 |
| 真实DeepSeek响应/费用/摘要质量 | **NOT RUN**；默认关闭、未使用真实Key；completed不证明事实正确 |
| 插件在线安装/更新/卸载、插件指定成员或话题、能力申请 | **未实现**；固定随版本能力目录，当前整群启用 |
| TG摘要命令、AI理解任意规则 | **未实现**；摘要只有显式面板文本，规则仍有限解析 |
| 欢迎/提醒、群历史/知识库/附件/私密连接 | **未实现**；新资源与调度需接已有能力并逐项验收 |
| 无模型原生ask审批 | **未接通**；上游要求open turn，不伪造turn |
| 恶意第三方插件或运维端到端保密 | **不提供**；共享进程可信代码、服务器/明文DB属于信任边界 |
| 实际服务器负载/峰值/长期故障/线上恢复 | **NOT RUN**；主机快照不是应用容量实测 |
| 旧备份后TG更新边界自动恢复 | **不提供**；point-in-time缺口须停机隔离和人工核对 |
| 跨系统原子撤权/交付exactly-once | **不提供**；远端已接收不能撤回，unknown不自动重试 |

[TODO](TODO.md)保存剩余实际工作。不能用本轮PASS扩大上述范围。
