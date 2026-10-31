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

Web 的“群规则”页显示预览提案 ID 和本人本群的已启用规则历史。启用后或刷新页面
都可从历史直接选择“预览回滚”，核对差异后再次确认。历史复用原 proposals 表及
现有保留上限（默认每群50条），不会显示其他创建者的草稿；失去当前管理员身份
即不能读取或操作，不需要从群消息手工复制 ID。

## 会话、任务与模型

个人会话按当前群/私聊、本人和受众区分，最多保留 12 条消息、24 KB。切换受众开始新上下文，保留模型选择；私人面板历史不会注入群公开问答。可用 `/tasks` 查看本人任务，`/task`
查看任务，`/cancel` 取消，`/newchat` 新建会话，`/reset` 清空上下文；`/models`
列出可信模型，`/model` 选择模型。SQLite schema 4 保存任务与会话；进程重启后，
未完成任务会标为中断，不会自动重放。

默认 Compose 不挂载额外配置，`SANDBOX_AI_MODEL_PROFILES` 为空，线上只提供
`default`。本机直接运行 Node 时，可令此变量指向一个受保护 manifest 的**绝对文件
路径**。Compose 部署则使用可选 `compose.koishi.profiles.yaml` overlay：将
`SANDBOX_AI_MODEL_PROFILES_DIR` 设为宿主机受保护目录，overlay 只读挂载该目录，并在
容器内固定读取 `/run/groupweave/model-profiles/profiles.json`。

manifest 是 JSON 数组，最多 15 个附加项（default 由现有 binding 提供，不能覆盖）：

```json
[
  {"id":"fast","label":"Fast","modulePath":"/run/groupweave/model-profiles/fast-binding.mjs"}
]
```

每项仅允许 `id`、`label`、`modulePath`；modulePath 必须是容器内绝对路径。不得放
密钥。binding module 从文件路径加载，应由既有受信 binding factory 创建任务绑定。
例如复制并包装现有 Sub2API/OpenShell binding 时，使用绝对 import：

```js
import { createOpenShellSub2ApiBinding } from '/app/integrations/sub2api-openshell/binding.mjs';
import { readFile } from 'node:fs/promises';

const config = JSON.parse(await readFile('/run/groupweave/model-profiles/fast-provider.json', 'utf8'));
export default await createOpenShellSub2ApiBinding(config);
```

该模块的现有 factory 就是 `createOpenShellSub2ApiBinding`。每个附加 binding 都必须
使用独立 `meterPort` 和独立 `stateDir`：factory 初始化时立即监听端口，不能与 default
或其他 profile 共用端口/状态目录。provider 配置使用单独只读 JSON，避免把机密放入
manifest。`stateDir` 须使用容器内可写位置（例如 `/data/model-state/fast`），不能放在
只读 profiles 目录；factory 会按运行 UID 创建并核验 0700 目录。
不要在 `/run` 下使用 bare package import：Node 的模块解析不会从应用 `/app`
目录按预期解析。模块、provider 文件和 manifest 所在目录应由运行容器 UID（默认
1000）拥有；目录用 0700、manifest/module/provider 文件用 0600，并通过 read-only
mount 提供。root 拥有的 0600 文件对 UID 1000 不可读，会导致加载失败。所有
`modulePath` 和 provider 文件路径均为容器内绝对路径。模型密钥只留在受保护
provider JSON，不进 manifest、面板或仓库。

完整启动命令（在 `examples/groupweave` 目录执行，profiles 可选）：

```sh
docker compose --env-file .env.local \
  -f compose.yaml -f compose.koishi.yaml -f compose.koishi.sub2api.yaml \
  -f compose.koishi.profiles.yaml up -d --build
```

不需要附加 profile 时，省略最后一个 `-f compose.koishi.profiles.yaml`。overlay 缺少
`SANDBOX_AI_MODEL_PROFILES_DIR` 会在 Compose 配置解析时失败。profile 只是选择固定的
可信 binding ID；不添加模型路由、自动 fallback 或新 runtime。源代码/Compose 接线和
本地配置解析通过，不表示已部署或调用第二个线上模型；线上目前仍只有 `default`。

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
