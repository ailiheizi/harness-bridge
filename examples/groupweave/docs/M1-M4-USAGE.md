# M1–M4 使用与配置

本文说明当前 M1–M4 已交付的入口和部署配置。线上及真实 Telegram 的具体范围
见 [2026-10-31 交付记录](DELIVERY-20261031.md)，完整命令速查见
[功能目录](FEATURE-CATALOG.md)。代表验证不扩大为全部生态插件或所有配置组合。

## 平台插件维护

平台管理员登录现有管理面板后，可安装精确版本的可信 npm 插件、配置并启停。
安装写入应用数据目录下的 `plugins/`，安装时忽略 npm 生命周期脚本，再由
Koishi Loader 载入配置。更新可能需要重启；按界面提示安排重启后再使用更新。
插件目录可写意味着受信任插件代码可持久化数据，不是恶意插件隔离边界。
群管理员不能安装插件，群功能开关也不限制恶意插件进程。

## 群功能与规则

`group.nativeFeatures` 可按群设置 `media`、`image`、`render`、`parser`、`rss`、
`schedule` 的 allowlist。未设置时保留旧的全开放默认。入口准入时会实时检查当前
群配置。该配置控制产品功能授权，不提供进程级安全隔离。

`/rules` 展示免费、固定语法的规则；`/airules --confirm <文本>` 或面板中的 AI
勾选会创建一次已有 assistant 任务，不读取或写入会话历史。AI 仅能返回严格匹配
既有字段的候选值；包含不支持内容的提案会警告并阻止启用。用 `/applyrules` 确认
后才生效；`/cancelrules` 取消提案，`/rollbackrules` 创建旧版本的预览，仍须确认。

## 会话、任务与模型

个人会话按当前群/私聊、本人和受众区分，最多保留 12 条消息、24 KB。切换受众开始新上下文，保留模型选择；私人面板历史不会注入群公开问答。可用 `/tasks` 查看本人任务，`/task`
查看任务，`/cancel` 取消，`/newchat` 新建会话，`/reset` 清空上下文；`/models`
列出可信模型，`/model` 选择模型。SQLite schema 4 保存任务与会话；进程重启后，
未完成任务会标为中断，不会自动重放。

部署者可令 `SANDBOX_AI_MODEL_PROFILES` 指向一个受保护 JSON 文件（例如
`/run/groupweave/model-profiles.json`），内容为数组，元素形如
`{"id":"fast","label":"Fast","modulePath":"/protected/path/binding.mjs"}`。
它会附加到受信任绑定模块提供的 `default` 配置。绑定模块和凭据文件应留在受保护
部署位置，不能提交凭据；模型密钥只存在原有受保护 binding 中，不放入该 JSON、
面板输入或仓库。模型选择绑定到可信 manifest 的固定配置，不会自动 fallback，
也没有动态 provider router。

## AI 结果文件

成功的 DSH 回合可生成固定 `result.md`。结果只允许一个不超过 64,000 bytes 的
常规文件，且内容须与最终文本一致。本人可在任务详情中五分钟内领取一次，或由
Telegram 作为文件发送。数据库记录文件元数据，不保存文件内容。任务仍在每次新建
的 Docker 沙箱中运行；Bridge 下载固定路径的产物后执行清理，不提供任意路径下载。

## 部署边界

当前目标服务已部署固定文件导出与上述应用功能。其他部署仍须准备其自己的
OpenShell 控制面、受信绑定、原生 mTLS 配置及私有凭据；仅复制源码不会提供这些
外部条件。修改 DSH 导出逻辑后须重建并更新 immutable image ID。部署步骤与
数据保留见 [部署指南](REPOSITORY-SETUP.md)，M6 范围和结果独立记录。
