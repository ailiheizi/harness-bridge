# DSH 原生无模型绑定

本文件说明 GroupWeave 首轮真实固定代码路径。实现位于 [native.ts](../src/server/native.ts)，验证位于 [native.test.ts](../tests/native.test.ts)。这是外部 TG 应用的 DSH 适配，不是 actweave / Workflow-to-Skill 新增执行器产品。

后续引入切片已让此固定工具调用 [Koishi 原生链接插件](KOISHI-CODE-AI.md)，
算法迁至 links.ts，保留 DSH 的无模型 guard。官方 Echo 可直接原生执行，
AI 组合则通过明确 DSH 工具调用同一代码能力。下列 DSH 证据只覆盖此固定入口，
不要求所有普通插件都经过它。旧 16 项记录的当前重验状态见 ACCEPTANCE。

## 当前已接通的路径

```text
本地预览身份与群功能检查（app.ts）
→ 可信服务端生成 actor / group / 参数 / 受众快照
→ 新建 DSH 原生 idle Agent + Session
→ DSH CommandRuntime.execute
→ 固定命令 handler
→ DSH ToolRuntime.execute + 原生 guard
→ Koishi 原生链接 command → 已安装纯文本整理函数
→ 原生 command 结果
→ 服务端重查当前身份与功能授权、保存并展示结果
→ 释放原生 Agent 与 Session
```

此处调用安装的 DSH 原生库 API，没有启动 `dsh` 子进程，也没有用 shell 包装命令。没有自写 Agent loop、工具注册服务或权限协议。`AgentLoop` 是 DSH 提供原生 Agent factory 所需的既有插件；创建的 Agent 保持 idle，从未提交普通消息或调用 `prompt` / `send`。

DSH 命令本身不自动代表业务工具已获授权。因此 handler 必须调用真实 `ctx.tools.execute`，让固定工具经过原生 guard，而不是从 Bot route 直接执行业务函数。

## 依赖与源码证据

绑定使用锁定版本：`@deepseek-ai/cordis@4.0.4`；以下 DSH 包均为 `0.2.0-rc.1`：`dsh-agent`、`dsh-agent-loop`、`dsh-commands`、`dsh-llm`、`dsh-session`、`dsh-session-projection`、`dsh-system-prompt`、`dsh-tools`。准确依赖以 [package.json](../package.json) 和 [package-lock.json](../package-lock.json) 为准。

下列路径均相对应用根目录，行号来自本轮已安装版本，不是其他版本的接口承诺：

| 已读原生源码 | 证据与本轮用法 |
| --- | --- |
| `node_modules/@deepseek-ai/dsh-commands/lib/types/index.d.ts:19` | CommandInvocation 提供真实 Agent、原始输入、附件和 signal；类型声明的 `execute` 位于第 142 行。 |
| `node_modules/@deepseek-ai/dsh-commands/lib/index.js:327` | `execute` 解析现有 slash command；第 334 / 341 行追加 `command/run` / `command/done`；第 388 行调用 handler。 |
| `node_modules/@deepseek-ai/dsh-tools/lib/types/index.d.ts:645` | `guard` 是 pre-execute waterfall 后的单调拒绝检查；全局 guard 或 Agent scope guard 都不能覆盖另一个拒绝。`execute` 声明位于第 765 行。 |
| `node_modules/@deepseek-ai/dsh-tools/lib/index.js:3116` | 真实 ToolRuntime 执行入口；第 3224 行附近经过 pre-execute 与 guard；第 3616 行将工具错误转成原生结果。 |
| `node_modules/@deepseek-ai/dsh-agent/lib/types/index.d.ts:135` | 原生 AgentHandle 的 `dispose()` 停止 loop、注销 Agent、移除 Session 并释放 scope；应用使用该 disposer，不伪造 Agent。 |
| `node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js:1524` | 既有 AgentLoop 的服务依赖；第 1714 行由原生 factory 创建 ReactLoopAgent。 |

以上只证明这组锁定依赖的真实 API 与本地调用。CLI launcher 的 `dsh --help` 没有通用 `tool run` 子命令；`dsh-headless` 是模型消息路径，不能充当本轮无模型固定入口。

## 适配器接口和可信边界

`createNativeExecutor()` 返回可调用函数及 `dispose(): Promise<void>`。请求为：

```ts
{
  actorId: string;
  groupId: string;
  input: string;
  options: { deduplicate: boolean; sort: boolean; maxItems: number };
  audience: 'private' | 'group';
  authorized: boolean;
}
```

成功结果为 `{ output: string, modelCalls: number }`。真实身份、成员资格、群功能与平台开关由可信服务端核对；客户端不能提交 `authorized`、身份或角色字段来授予权限。原生 guard 再核对工具调用的 actor、group、input、audience 和 options 是否完整匹配服务端绑定快照，并拒绝 `authorized: false`、空身份和未绑定 Agent。

每个请求新建唯一原生 Agent / Session，只绑定该请求。无论 `private` 或 `group`，固定工具只处理本次输入，不能选择其他群的数据或读取其他会话。受众只影响后端结果访问规则，不为工具增加能力。本群分享仅公开结果，任务详情和列表中的原始输入字段只向发起者提供。

执行等待结束后，后端重新检查原会话、当前群成员与功能授权、平台启停。撤销期间的迟到结果清空 output 并标记 blocked；不自动重跑。配置中的去重、排序和条数采用提交时快照；当前首轮没有额外数据范围、外部连接或凭据。

## 固定能力范围与错误

本 DSH 无模型入口的真实能力是 `link-cleaner`：从 input 提取有效 HTTP(S) URL，按明确参数去重、排序并限制展示条数。使用标准 `URL` 解析会规范化部分 URL（例如主机名大小写）；“去重”是规范化后 URL 字符串相同，不声称识别网页语义等价。

该业务函数不 fetch URL，不调用 shell，不访问外部文件、环境变量、凭据或用户历史。调用 runtime 没有安装 profile loader、持久 Session 插件、文件工具、shell 工具或模型 provider。

原生输入限制为最多 50,000 字符、`maxItems` 为 1–1000 的整数；HTTP 入口另有更紧的 16,000 字节 / 200 行输入限制，群配置条数为 1–100。它们是不同入口的明确限制。

`NativeInputError` 只包含下列固定代码。ToolRuntime 会序列化错误，command handler 仅对白名单做固定标记，adapter 再恢复该类型；后端按代码返回自己维护的安全说明，不透传任意原生错误文本。

| code | 含义 |
| --- | --- |
| `NO_LINKS` | 本次输入没有有效 HTTP(S) URL。 |
| `INPUT_LIMIT` | 超过原生输入长度限制。 |
| `MAX_ITEMS` | 条数参数不是允许范围内的整数。 |

未知错误、缺失能力、权限拒绝或结果未知都不自动切换模型 / Agent。HTTP 等待超时不等于底层操作取消；用户取消由宿主传入AbortSignal；仍必须如实显示结果未知并禁止自动重放。

## 为什么 modelCalls 为 0

固定函数通过命令和工具执行，不发用户消息、不创建模型 turn、不加载 provider。runtime 监听原生 `llm/stream` 事件，若发生则记数并拒绝；测试另外代理真实 `LlmRuntime.stream` 方法计数，正常与输入失败请求均没有调用该方法。

返回的 `modelCalls` 来自 runtime 观察值，不由前端填写，也不靠输出内容猜测。当前验证证明本轮固定路径没有模型调用，不代表将来的所有插件或 Agent 功能都零成本。

## 本轮实际验证

2026-10-07，Node.js `v26.5.0`，运行：

```sh
./node_modules/.bin/tsx --test tests/native.test.ts
```

结果：**PASS，16/16，exit 0**。测试使用安装的真实 DSH services，计数代理调用原始实现，不用 fake Agent 或模拟业务结果。

| 验证项 | 当前证据 |
| --- | --- |
| commands → tools | 两个真实原生执行入口均被调用，出现 command/run 与 command/done。 |
| 不调用模型 | 无 turn/start、user/message、assistant/message；LlmRuntime.stream 调用数为 0。 |
| 请求授权 | authorized false 被实际 ToolRuntime guard 拒绝。 |
| 范围篡改 | 在命令传输中替换 group / actor / audience，实际 guard 均拒绝。 |
| 两个并发请求 | 群、成员、受众和本次文本分别绑定，结果无对方输入。 |
| 注入式文本与错误 | 输入中的自然语言不改变权限或操作；三个输入错误代码保留；之后正常请求仍 modelCalls 0。 |
| 生命周期 | 12 次成功 / 拒绝请求，每次结束后原生 agents.list() 与 sessions.list() 均为 0；dispose 后拒绝新请求。 |
| 取消与关闭 | 第二参数 AbortSignal 透传原生命令/工具；预取消不创建 scope；取消及 dispose 后等真实工具结束再释放 scope。 |
| 线性输入处理 | 50000 字符上限内长括号保留 URL 语义，无重复 split 扫描。 |
| 真实 HTTP 联调 | Fastify buildApp → 本适配器 → 原生命令 / 工具成功；无效输入返回固定安全说明，两种请求 modelCalls / stream 调用均 0。 |

这些是功能和边界测试，不是吞吐、RSS、沙箱强度、生产权限或 Telegram 实测。整体应用测试和构建结果由项目最终验收记录统一报告。

原生适配接受可信宿主的第二参数 `signal?: AbortSignal`，不会将信号写进业务 JSON 或让浏览器设置。原生命令可能在工具未结束时先报告 abort，因此适配器等待本请求真实工具 Promise 结束，才删除绑定、释放 Agent / Session 并向宿主结束调用。关闭同样请求取消并排空；不合作工具可能继续占槽，不能把 abort 当成硬停止。

应用服务级 fail-fast 上限由 API 准入实施，精确范围见 [CORE.md](CORE.md)。原生 per-call/turn 的 parallel 设置不约束不同请求总数。宿主配置撤销、注销、用户取消与关闭传入取消；即使执行器忽略信号，最终交付守卫仍清空迟到结果。

## 未实现与不能据此声称的能力

- **原生 ask / 交互审批未接入。** 本地 `dsh-user-approval@0.2.0-rc.1` 源码第 128–130 行要求 open turn；本轮命令是 out-of-turn。当前仅原生 allow / deny，不能伪造 turn 来称审批已打通。
- **真实 Telegram 收发尚未运行。** 身份/注册/成员刷新绑定已实现并离线验证，见TELEGRAM.md；演示身份不能作为live证据。
- **AI路径不扩大本文件的零模型结论。** 默认关闭的原生摘要绑定见AI-BINDING.md；真实供应商调用仍NOT RUN。
- **不具备恶意插件沙箱。** 固定函数与服务端同进程，原生 guard 约束通过 ToolRuntime 的调用，不能阻止恶意已安装 Node 插件绕开 API 读取进程内数据或执行任意代码。当前仅运行平台维护的可信固定能力。
- **原生 stores 清空不等于资源容量验收。** 未测目标服务器峰值 RSS、跨进程沙箱、外部共享 token、负载容量或安全销毁；原生 per-call 并行设置也不等于全服务并发上限。
- **外部 API / 文件权限未验证。** 当前没有此类资源；未来功能必须在真实 CLI / OS / 外部服务边界接通并验证，不能从本次纯输入处理推广出隔离承诺。

后续应保留普通外部应用适配和 DSH 原生接口边界。若目标原生能力缺失，记录缺口或使用现有授权入口，不能在 actweave 中补一套执行平台。

## 本轮语言与协作取消

原生 snapshot 和工具schema含language（zh/en），guard要求与可信群快照完全一致，输出标题/截断说明按语言生成。固定扫描每4096字符让出事件循环并查AbortSignal；URL解析/排序是有界同步段，不能被timer硬抢占。HTTP与离线Telegram整合都验证英文进入真实函数，不只保存在配置。
