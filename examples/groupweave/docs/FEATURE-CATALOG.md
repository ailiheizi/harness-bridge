# GroupWeave 功能速查

[当前里程碑与缺口](MILESTONE-STATUS.md) · [Web 工作区与工具目录](WEB-WORKSPACE.md)

面向当前原生 Telegram Bot。依赖版本取自 `package.json`；功能证据只列已记录的
代表性真实路径，不代表所有输入组合通过。平台管理员先开放能力，群管理员配置
群范围，命令执行时按当前权限复核。AI 命令还需配置受保护的 sandbox binding，
并经本人确认第三方处理。

## 不调用模型

| 功能与命令示例 | 结果 | 依赖、条件与关键默认 | Telegram 证据与限制 |
| --- | --- | --- | --- |
| `/help`、`/echo hello`、`/register`、`/plugins`、`/settings` | 帮助、回显、注册群、查看群能力/设置 | Koishi 4.18.11、Loader 4.6.11、Telegram adapter 4.5.11；Bot 连接；注册/设置需当前群管理员 | 真实 Mini App 登录与群展示；不是每项管理流程均有真实收件证据 |
| `/rules 开启欢迎` 后 `/applyrules <id>` | 预览并应用已有字段的群规则 | 平台能力先启用；当前管理员确认；不支持字段拒绝 | 配置提案/确认已在本批真实群验证，见交付记录；welcome 用当前加入事件，不读历史 |
| `/links https://b.example https://a.example https://b.example` | 按本群设置清理、去重和排序链接 | 内置 link-cleaner 代码插件；平台/群均开放；默认去重和排序 | 代码清理与 `/brief` 组合已有真实 TG 结果；不抓取链接网页 |
| `/image webp 1280 80`；回复图片后 `/image png` | 转换并发送文件 | `sharp` 0.35.5；边长默认上限 1280、质量 80；输入每张≤5 MiB、解码≤20MP、输出≤10 MiB | 真实收过 PNG/WebP；不覆盖全部输入格式/尺寸 |
| `/imgpdf start` → 上传图片 → `/imgpdf done`；`/imgpdf cancel` | 将当前会话图片做成 PDF | `pdf-lib` 1.17.1；120 秒收集、最多10张、总输入20 MiB、20MP；需等上传完成 | 两张图片 PDF 实际下载并核页；只收发起者开始收集后的附件 |
| `/mdimg **hello**` | Markdown/公式/图表图片 | `koishi-plugin-markdown-to-image-service` 2.7.0、Puppeteer 3.9.0；默认关闭，需 `ENABLE_RENDER=1` 及可用 sandboxed Chromium；8KiB/120行/8000px/10MiB | 真实 TG 收过含代码、KaTeX、Mermaid 的图；目标 Docker 配置需启用 render overlay |
| `/convert m4a`、`/convert small`、`/clip`、`/mediainfo`、`/v2g` | 音视频转换、裁剪、媒体信息、GIF | `ENABLE_MEDIA=1`；FFmpeg/ffprobe（镜像含 FFmpeg）；`koishi-plugin-video-to-gif` 1.2.2 | M4A、small MP4、MP3、clip、上传视频转 GIF 有代表性实收；URL/引用等组合未全验。`/cancelmedia` 不取消 `/v2g`；上传 GIF 可用 `/cancelv2g` |
| `/rss https://…/feed.xml`、`/rss -l`、`/rss -r https://…/feed.xml` | 为当前群订阅、列出、退订 feed | `koishi-plugin-rss` 3.0.1；仅注册群管理员主群聊；无默认订阅；首轮不补发历史 | 受控 feed 的群隔离、更新投递、重启恢复已实收；不等同公网 feed 持续可用 |
| `/remind daily 09:30 检查面板`、`/remind list`、`/remind pause <id>`、`resume`、`edit`、`remove` | 管理群提醒 | `koishi-plugin-schedule` 5.0.1；群管理员主群聊；时区取进程配置（样例 Asia/Shanghai）；重复最短60秒 | 创建/编辑/暂停恢复/重启保留有真实 TG 代表路径；停止可能赶不上已进入发送流程的提醒 |
| `/fileinfo`、`/readfile`、`/savefile` | 查看、读取或保存本人附件 | 私聊或注册群；使用当前输入/引用，重验权限；不进入群历史抓取 | 有既有原生验收；格式/大小以命令响应为准 |

## 调用模型或现有 AI Harness

当前线上仅有 `default` 模型 profile。需要启用平台和适用群功能，并有有效的
受保护 binding；每次处理前会请求本人确认。所有任务经 OpenShell/Docker 中的
现有 DSH 执行，每任务新环境。模型选择只绑定可信 manifest，不自动 fallback。

| 命令示例 | 结果与输入范围 | 条件/限制 | Telegram 证据 |
| --- | --- | --- | --- |
| `/ask 用例解释递归`、回复一条文字后 `/ask` | 对用户明确选择的文本问答 | 本人当前群/私聊上下文；不读群全历史；上下文最多12条/24KB，改变受众即清空 | DM 重启后追问成功，证明当前上下文持久化；群单轮 ask 亦有实收记录 |
| `/digest <文字>` 或回复消息后 `/digest` | 摘要指定文本 | 只处理命令正文或明确引用；不扫描会话历史 | 引用摘要已真实收到；多轮延续按当前会话能力记录 |
| `/translate 英语 Hello` | 翻译给定文字 | assistant 功能与本人确认；每次独立任务 | 既有真实翻译收件记录 |
| `/brief 比较 https://a.example https://b.example` | 先用现有代码清理链接，再让模型解释输入及代码结果 | 群内；link-cleaner 和 link-brief 均启用；模型不抓取网页 | 测试群真实确认、执行和投递已记录 |
| `/airules --confirm <规则描述>` | AI 生成已有配置字段的候选，随后 `/applyrules <id>`；`/cancelrules` 取消，`/rollbackrules` 生成回滚候选 | 只对候选做严格既有字段校验；unsupported 阻止启用；apply/rollback 都要本人确认 | 真实群 v4→v5 提案与 v6 回滚已验证，`/settings` 核对恢复；应用确认没有额外模型调用 |

会话/任务辅助命令：`/tasks` 列本人任务，`/task <id>` 查看，`/cancel` 取消本人
当前任务，`/newchat` 新建上下文，`/reset` 清空，`/models` 列可用模型，`/model default`
选择可信配置。重启将未完成任务记为中断，不自动重放。线上目前只有默认模型；
profile 扩展接缝的本地检查不是多模型线上证据。

Web 群规则页可直接显示并选择本人本群的生效提案历史，刷新后仍可生成回滚预览；
版本比较和再次确认沿原路径，不要求从聊天复制 ID。平台部署者还可用可选
`compose.koishi.profiles.yaml` 为现有模型 manifest/module 提供受保护的只读目录挂载，
具体权限、独立端口/状态目录与步骤见 [使用指南](M1-M4-USAGE.md)。

## 可选能力与明确限制

平台面板的“原生插件维护”复用 `@koishijs/plugin-market` 2.11.12 的 Installer
与 Loader 4.6.11：安装精确版本、查看依赖、保存配置和启停。群管理员只配置
本群获准字段，不能安装代码；插件在共享应用进程中运行。需要重新启动的
升级明确提示。该接缝经过真实 npm/Loader 代表路径验证；不等于任意 npm 插件
都已兼容或隔离。

- `/parse <url>`：`ENABLE_SITE_PARSER=1` 使用固定 `yt-dlp` 2026.10.26；只对匿名公开内容 best-effort。没有 cookies、登录态或自动群监听，公开站点拒绝/删除内容会失败；线上样例未能证明收到媒体。
- `/scan <text>` anti-ad：公开快照不含原私有分类器实现，因此默认不可用；适配器本身不是可用的扫描能力。
- `/status` 显示 Bot 与 AI route 状态；不代替任务结果或真实模型调用证据。

## 依赖版本与证据

主要固定版本：Koishi 4.18.11、Loader 4.6.11、Telegram adapter 4.5.11、RSS 3.0.1、
Schedule 5.0.1、Markdown service 2.7.0、Puppeteer 3.9.0、Sharp 0.35.5、pdf-lib
1.17.1、video-to-gif 1.2.2、video-parser-all 1.7.7。完整依赖以
[`package.json`](../package.json) 为准。

原生功能入口和固定参数见 [NATIVE-KOISHI](NATIVE-KOISHI.md)、
[NATIVE-UTILITIES](NATIVE-UTILITIES.md)、[NATIVE-IMAGES](NATIVE-IMAGES.md)、
[NATIVE-AI-FILES](NATIVE-AI-FILES.md)。真实历史见
[ACCEPTANCE-20261022-NATIVE](ACCEPTANCE-20261022-NATIVE.md)（尤其第十四批）及
[DELIVERY-20261031](DELIVERY-20261031.md)。这些是日期化范围证据，不保证所有
生态插件、媒体格式或模型组合已实测。
