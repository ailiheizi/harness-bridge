# 显式 AI 摘要的原生绑定

本页限定默认 summary/digest 的空工具、单模型路径。后续引入 link-brief
复用同一 DSH composition，增加一个明确 Koishi 工具及第二次模型生成，见
[KOISHI-CODE-AI](KOISHI-CODE-AI.md)；不将本页预算套用到所有混合任务。

状态：适配器与审核 Skill 已实现；本轮 15 个 AI 离线测试、3 个真实 HTTP →
Store → actions → 原生 DSH 集成测试、16 个固定代码入口测试均通过。
真实 DeepSeek 响应、收费、摘要质量及真实 TG 投递均未在这些测试中运行。
HTTP/TG 整体验收另见应用验收记录，不能从 SDK 测试推导生产开放结论。

## 何时执行

`digest` 是独立的语义功能。链接整理继续走
[native.ts](../src/server/native.ts)，不会初始化 AI composition 或加载此 Skill。
代码失败、结果未知或权限不足不会自动改走 AI。

应用入口必须明确设置 `ENABLE_AI=1` 并提供应用专用 `DEEPSEEK_API_KEY`；缺少
其中任何一项，摘要不可用。平台能力可用、群配置启用、当前使用者有权使用、
明确选择摘要、确认把这一次文本发送给 DeepSeek，都属于宿主的可信检查。
仅设置凭据或创建适配器对象不会发起请求，也不会扫描用户配置。

HTTP/TG 共用 actions 要求每次摘要提交的 `acknowledgeExternalProcessing`
为 `true`，在发送输入前检查。群配置启用不能代替这次确认。该字段是已
登录用户的请求意图，不是任意扩权凭据。

只总结本次提交的文本。没有群历史读取、链接抓取、自动摘要、后台任务、
模型选择面板或自动 provider fallback。群主启用功能不代表每个成员自动
获得任意数据范围；宿主仍负责当前成员、群、功能及结果受众的授权。

## 外部应用接口

实际实现是 [ai.ts](../src/server/ai.ts)，不是 Workflow-to-Skill 的新产品概念。

```ts
interface AiRequest {
  actorId: string;
  groupId: string;
  input: string;
  options: { language: 'zh' | 'en' };
}

createAiExecutor({ enabled?, apiKey?, dataDir, model? })
  -> { execute(request, signal?): Promise<AiResult>, dispose(): Promise<void> }

interface AiResult {
  output: string;
  modelCalls: number;
  usage: TokenUsage | null;
}
```

身份来自宿主已经核验的会话或 Telegram 更新，不能由模型或请求 body 授权。
适配器拒绝空身份、空文本、超过 8000 个 UTF-8 字节的文本及非法语言，和
共享 HTTP/TG actions 的字节上限一致。`dataDir` 必须是宿主提供的绝对路径。

模型固定为 `deepseek-flash`，provider 固定为 `deepseek-official`。保留的内部
`model?` 配置只接受该固定值；没有让群或用户选择 provider/model 的接口。
无凭据、未启用、固定模型配置错误、Skill 缺失/变化或入口关闭抛出固定文本
的 `AiBlockedError`；输入、取消、未完成及执行失败抛出 `AiExecutionError`。
两种错误都携带本任务已取得的 `modelCalls` 和 `usage`。内部 SDK/供应商错误
不直接作为用户文本返回。

`modelCalls` 计数的是本任务实际进入原生 `llm/stream` 的 dispatch attempt。
它不是已收费 HTTP 请求数或金额。取消发生在供应商接收前后都可能记为一次
已开始的尝试。`usage:null` 表示尚未取得供应商用量，不能转换为零；已收到的
原生 usage chunk 即使随后失败、取消或没有完整 assistant message 也保留。

## 复用的 Harness 能力

固定绑定 DSH `0.2.0-rc.1` 与 Cordis `4.0.4`，使用现成的 AgentRegistry、
AgentLoop、SessionStore、SessionProjection、LlmRuntime、SystemPrompt 和
ToolRuntime；没有自建 Agent loop、执行器注册标准、队列或 provider router。

摘要新增的直接 import 包均为 `0.2.0-rc.1`：

- `dsh-skill`：原生 SkillRegistry；
- `dsh-skill-filesystem`：原生审核目录发现与读取；
- `dsh-tool-skill`：原生 `/group-summary` 用户手势；
- `dsh-llm-deepseek`：官方 DeepSeekAdapter、配置解析、SSE 转换和取消；
- `dsh-anonymous-user-id`：原生匿名 ID 的显式应用目录绑定。

上游根 [LICENSE](https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE)
为 MIT。上述包的实际版本/API 另在本机安装代码核对；上游 master 链接是源码
入口，不能代替锁文件中的版本身份。

调用链为：

```text
宿主当前身份、群范围、功能及外发确认
 -> 一个全新原生 Agent/Session
 -> 原生 SkillRegistry 预检审核 Skill
 -> 普通 user message 的 /group-summary
 -> 原生 pre-step 加载 Skill 到同一 Session
 -> 原生 llm/stream 检查 Skill 快照、无工具、固定路由和预算
 -> 官方 DeepSeekAdapter
 -> 原生 session/assistant-stream 与 turn/end
 -> 宿主重新检查授权并决定展示/投递
 -> 原生 handle.dispose 完成实际 drain
```

原生 Skill 手势只来自 user source。SDK 的
[tool-skill 源码](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/tool-skill/src/index.ts)
将 Skill 指令记录为 `skill-invocation`；应用没有粘贴自制 loader 或另造消息协议。
缺失 Skill 的上游手势本来会被跳过，所以适配器先预检，再在 dispatch 前核对
唯一 `group-summary` 指令与预检快照完全一致。缺失、变化或其他 Skill 注入
会在发送给模型前阻断。

## 目录、权限与预算

审核资产是 [audited/group-summary/SKILL.md](../audited/group-summary/SKILL.md)。
唯一发现根是应用 `audited`，`includeDefaultRoots:false`、`watch:false`，并明确
提供应用内 dshHome/agentsHome。部署必须把此目录随应用复制，并保持平台
审核代码与 Skill 对群用户和模型只读；本段不是 OS 文件沙箱的实现。

使用官方 DeepSeekAdapter 的现成依赖入口，而不是包含 ambient HOME 默认值
的 API-key plugin。匿名 ID 的 native env 显式指定 `dataDir/dsh-ai`；闲置的
Files API upload index 同样显式绑定该目录。没有改写全局 `DSH_HOME`，没有
加载本机 HOME、profile、credentials service、普通文件工具或 shell 工具。
摘要仅接受文本，不挂附件服务，因此没有图片上传或 Files API 调用。

工具层仅安装 Skill 的原生加载机制，再以原生 scope restriction 移除模型的
`skill` 工具可见性，guard 拒绝任何模型工具调用。显式 Skill pre-step 加载
仍可工作。模型获得的工具集合为空；官方 provider 的必要网络传输属于宿主
能力，不是赋给模型一个任意网络工具。

原生 [Agent API](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent/src/runtime-types.ts)
提供每请求 `maxTokens`，未提供 `maxSteps` 配置项。本绑定通过现成的 scoped
`agent/pre-step` 钩子拒绝 `turn>1` 或 `step>1`，并在 `llm/stream` 拒绝第二次
dispatch。只发送一次 followup；不安装 retry、compaction 或 subagent 插件。
官方 transport 和 AgentOptions 均设置输出上限 1024，thinking 关闭，retry
次数为零，stream idle timeout 为 10 秒。idle timeout 不是全任务墙钟期限；
服务级期限、并发与撤销由宿主 actions 的既有任务生命周期处理。

取消 signal 在 Agent 创建后转换成原生 `agent.cancel`；创建时传的 signal
本来只覆盖创建期。原生 handle disposer 等待实际 driver/iterator 结束。
关闭入口也会取消并 drain；不把超时响应或取消请求当成工作已经停止。供应商
是否已经收费或停止内部生成不能由本地 abort 证明。

这些约束适用于当前受信任的同进程应用代码。它们不是恶意 Node 插件沙箱，
也不证明任意共享数据库/token、跨租户资源或同 UID 文件访问已经隔离。

## 完成证据和本轮验证

成功同时要求：审核 Skill 已通过原生入口进入本任务、恰好一次 dispatch、
存在非空且非 interrupted 的 assistant text、无 agent/error，以及原生
`turn/end.reason.kind === 'completed'`。`whenIdle()` 只说明 driver 空闲。
`max-tokens`、`blocked`、`aborted`、`error` 和不完整结果都不算摘要完成。
completed 只证明生成完整结束，不证明摘要事实正确或经过独立语义评审。

当前命令 `tsx --test tests/ai.test.ts tests/ai-integration.test.ts tests/native.test.ts`：
34/34 PASS；其中 [ai.test.ts](../tests/ai.test.ts) 15/15、
[ai-integration.test.ts](../tests/ai-integration.test.ts) 3/3、native 16/16。
`npm run typecheck`（`tsc --noEmit`）PASS。
AI 测试实际驱动原生 Agent/Skill/Session；生成内容由明确标注的 offline
LlmAdapter 或拦截官方 fetch 后返回的合成 SSE 提供，不是供应商响应。
覆盖缺启用/凭据、审核 Skill 缺失与变化、无工具、单步与 token 截断、失败
无重试、已报告/未知 usage、取消真实 drain、并发输入/计数分离，以及官方
transport 固定 URL、1024 上限、fetch abort 和应用匿名 ID 路径。

集成测试通过真实 HTTP 会话和 CSRF 入口完成平台启用、群提案预览和版本
CAS 启用，再通过共享 actions 调用原生 AI 绑定。缺本次外发确认、8001 个
UTF-8 字节的输入在模型前拒绝；正常任务保存一份调用与 usage 证据，SQLite
关闭重开仍可读。私有任务只由创建者读取；群受众分享结果时隐藏原始输入
字段。模型摘要本身可能保留输入中的事实，隐藏字段不等于自动脱敏；选择
群受众意味着向有权成员展示该摘要。

另一个集成负例在供应商离线流仍运行时通过 HTTP 移除群摘要功能，核对原生
signal 已取消、等待者仍等真实流 drain、最终输出为空且任务 blocked、
已报告用量和一次尝试保留。重新启用后用同一重复保护键提交也只读取原
blocked 记录，不重跑。本测试不证明第三方内部生成或计费已停止。

SkillCreator 的 `quick_validate.py` 未通过执行：系统及 bundled Python 均
缺 PyYAML，未额外安装依赖；该通用校验器的 allowed keys 也不含这里采用的
DSH 原生 invocation frontmatter。实际 DSH 文件 provider 已在上述测试解析
并验证这两个原生策略字段。这不是跨 Harness 的结构验收或语义质量验收。

NOT RUN：带真实凭据的 DeepSeek 调用/费用、摘要质量评估、真实 TG 摘要交互、
公网部署和生产权限/资源隔离。凭据未提供时不会通过假响应把这些项目标 PASS。
