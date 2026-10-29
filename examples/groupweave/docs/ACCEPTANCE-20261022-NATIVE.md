# 2026-10-22 原生宿主第一批功能记录

范围：AIL-15 / AIL-28 / AIL-98 的第一批实现。全部 Issue 保持进行中。

## 实际实现

- 独立原生启动入口 `npm run start:koishi`，直接通过 Koishi Loader 读 YAML。
- 固定依赖：Koishi 4.18.11、Loader 4.6.11、官方 Telegram adapter 4.5.11、
  Help 2.4.6、Echo 2.2.5、HTTP 0.6.3、SQLite 4.7.0。
- 现有 Store/actions 与 Fastify 管理 API 同进程复用；群注册、配置查看、
  功能查看、规则预览/确认、链接整理和取消接到原生命令。
- Telegram 默认关闭；启用需要明确开关、Token、独立平台管理员 ID。
- `groupweave.sqlite` 与 `koishi.db` 两个数据文件；不新增数据库引擎。
- YAML 运行时只读；默认配置与环境模板、容器 override、使用说明已加入。

## 本轮实际验证

| 验证 | 实际结果 | 能证明的范围 |
| --- | --- | --- |
| `node --import tsx --test tests/koishi-runtime.test.ts tests/koishi-business.test.ts` | 6 passed / 0 failed | 真实原生 Loader/Echo/Help/SQLite、重启保存、模拟 Telegram API 的群注册与规则确认、链接发送回执/未知状态 |
| `npm run build` | exit 0 | TypeScript 检查与 Vite 生产构建 |
| 本地实际宿主启动 → HTTP `/api/health` → 停止 → 重启 | PASS | 原生服务和现有 Fastify/Store 共存；已有用户数据保留；两个 DB 文件存在；YAML 内容不变；未连 TG/模型网络 |
| `PUBLIC_ORIGIN=https://bot.example.invalid ENABLE_TELEGRAM=0 docker compose -f compose.yaml -f compose.koishi.yaml config --quiet` | exit 0 | Compose 合并配置有效 |
| `git diff --check` | exit 0 | 现有跟踪文件 diff 无空白错误；不代表新文件或完整功能验收 |

发现并修正：Loader 启停配置写回导致下一次插件被禁用；Koishi `Session.send`
在发送失败时可能返回空数组，空回执必须记录为未知，不能记录成功或自动重发。

## 尚未验收

- 本机 Colima Docker daemon 未运行，本轮没有构建或运行镜像；未触碰远程服务。
- 本轮没有该原生入口的真实 Telegram 端到端证据，业务测试使用模拟 API。
- 真实模型、Bridge 路由、Mini App、多群原生参数、欢迎事件、媒体、RSS、定时
  等不在本批完成声明内。旧入口的历史验收不能自动归给原生入口。
- 最终安全检查与反向案例按约定在全部功能完成后执行，本批没有提前扩展专项。

## 第二批：RSS、提醒与欢迎

对应 AIL-21、AIL-95、AIL-28。本地功能已实现；Issue 仍保持进行中，未将模拟
Telegram 传输算作真实 Telegram 验收。

| 功能 | 实际实现与验证 |
| --- | --- |
| 提醒 | 上游 Schedule 5.0.1；一次性、每天、间隔、列表、删除；当前机器人/群范围；本群管理员入口；到点重新核验；重启后的原生记录仍触发 |
| RSS | 上游 RSS 3.0.1；添加、列表、取消；实际本地 HTTP Feed 校验与轮询；新条目进入模拟 Bot 消息传输；首次旧内容和重启既有条目不重复推送；无效 Feed 返回失败提示 |
| 欢迎 | 原生入群事件 → 当前角色与群功能 → 既有模板/任务/投递；默认与自定义模板；以 event.user 的 Telegram ID 核验 |
| 菜单/状态 | `/plugins` 给出实际加载能力的用法；`/status` 显示连接状态并明确原生入口 AI 未启用 |

最终聚焦验证命令：

```sh
node --import tsx --test tests/koishi-runtime.test.ts tests/koishi-business.test.ts tests/koishi-schedule.test.ts tests/koishi-rss.test.ts tests/koishi-welcome-native.test.ts
```

结果：**12 passed / 0 failed**，进程自然退出。日志在本地忽略目录
`[私人验收产物已从公开副本省略]`。提醒的纯文本确认曾被当成消息格式渲染，
已通过原有正常链路中的文字断言复现并修复，确认、列表和发送均保持文字语义。

另运行完整 `startKoishiHost()` 入口，使用临时数据库与模拟 Telegram API，
通过真正的 Store/actions 完成：注册 → 规则预览/确认 → 原生欢迎 → 一次性提醒
到点发送 → 功能菜单。结果 `NATIVE_APP_BUSINESS_SMOKE PASS`。未访问 Telegram
或模型网络，测试数据与临时 HTTP 服务已清理。

`npm run build`、`git diff --check`、Compose 合并配置检查均通过。
`npm run postinstall` 成功应用现有 file-type 和新增 RSS 依赖补丁。RSS 补丁同时
修复跳过首轮内容后永不发出更新，以及销毁时遗留去重定时器导致进程不退出；
没有新增轮询器。独立功能复核未发现确定的交付阻断问题，不代表安全审计完成。

当前边界：提醒首批只发送文字，暂不定时调用任意代码/AI；RSS 只推上游提供的
标题/作者，不含正文或条目链接；群话题和私聊不提供订阅/提醒管理。完整的群级
原生参数配置、模型问答、媒体等继续按功能票推进。真实 TG 和容器实跑仍未验证，
没有改动远程服务。

## 第三批：原生 AI 与文本文件（2026-10-23）

对应 AIL-24、AIL-29；两票保持进行中，未把局部子功能标成全票完成。

| 用户功能 | 实现和本地证据 |
| --- | --- |
| 群问答/摘要 | 原生 `/ask`、`/digest` → 本人签名确认 → 现有 Store/actions → 配置的 Docker Bridge 执行器 → 原会话投递 |
| 引用与 @ | 同群文字/说明引用；群明确提及模式下 `@bot`；普通聊天不响应 AI 配置提示 |
| 长回复/失败 | Unicode 分段、逐段当前授权与回执、一次投递声明；执行失败提示、按钮重放不重复执行 |
| 文件 | `.txt`/`.md` 64 KiB 严格 UTF-8 读取；附件类型/大小信息；文字生成真实 TXT 上传内容 |
| 配置 | AI 默认关闭，显式启用缺绑定会报错；状态区分已配置与连接已验证；原生助手和摘要共用已有工作/清理期限 |

执行：

```sh
node --import tsx --test tests/koishi-ai.test.ts tests/koishi-media.test.ts tests/koishi-native-host.test.ts tests/koishi-business.test.ts tests/sandbox-ai.test.ts tests/sandbox-actions.test.ts
npm run build
```

**33 passed / 0 failed / 0 skipped**，自然退出；构建通过。
日志：本地忽略目录 `[私人验收产物已从公开副本省略]`。
`git diff --check` 与 Compose 合并配置检查通过。

完整 `startKoishiHost` 检查实际加载默认插件与新增命令，HTTP health 正确显示 AI
关闭。调用 `/savefile` 使用真实 Koishi Session 和官方 TelegramMessageEncoder，
验证 `sendDocument` 的 multipart 包含正确 chat ID、回复 ID、TXT MIME、扩展名
及原始 UTF-8 字节；只有 Telegram 网络端替换为本地接收函数。

桥接测试使用受控 Bridge/计量替身，核验助手 Skill 路由、群语言默认值和既有
一次调用/清理证据约束。助手超时曾未应用沙箱清理期限，新增用例先复现失败后
修正。功能复核另发现关闭 AI 时普通消息被配置提示打断，已改为仅显式触发，
对应检查通过。独立范围内复核无已知交付阻断。

本批没有真实 Telegram、真实模型调用或容器运行，没有改动远程服务；不宣称
Docker 部署、凭据代理或真实计量已再次验收。尚缺独立私聊 AI、媒体实际转换、
沙箱文件产物回传与完整群级配置。最终安全专项仍按全部功能完成后的顺序安排。

## 第四批：私人作用域和上游视频转 GIF（2026-10-23）

对应 AIL-24、AIL-94，仍保持进行中。新增功能和证据：

| 功能 | 本轮证据 |
| --- | --- |
| 私聊问答/摘要 | 普通文字和原生命令进入本人确认，使用 `tg-dm:<用户ID>`，两名用户任务独立且群列表不增加私聊 |
| 私聊取消 | 只有本人能取消自己的正在执行任务，取消信号到执行器，结果不再投递；菜单接同一个私人绑定 |
| 存储升级 | schema 3 私人表、正文保留、重开与备份恢复；v2 库/备份迁移保留原群与任务，来源备份未改写 |
| 视频转换 | 上游 video-to-gif 1.2.2、FFmpeg 1.1.0 服务与本机真实 FFmpeg 将小 MP4 转为 GIF |
| 正式宿主回传 | 完整宿主加载 `/v2g`，真实 HTTP data-URI helper 和官方 Telegram 编码器生成 sendAnimation multipart；验证 GIF MIME、文件名、目标用户和 GIF 字节 |
| 直接失败 | 未授权不进入转换；等待视频忽略其他用户；无效视频只提示固定错误并清理临时产物 |

聚焦检查命令：

```sh
node --import tsx --test tests/koishi-ai.test.ts tests/koishi-video.test.ts tests/koishi-native-host.test.ts tests/koishi-business.test.ts tests/store-private.test.ts tests/store-storage.test.ts tests/store-maintenance.test.ts tests/management.test.ts tests/sandbox-actions.test.ts
npm run build
npm run postinstall
PUBLIC_ORIGIN=https://groupweave.example ENABLE_MEDIA=1 docker compose -f compose.yaml -f compose.koishi.yaml config --quiet
```

首次聚焦运行 40 项中 39 项通过，唯一失败为旧管理测试仍断言固定名称 DeepSeek，
而实际规则提示已是“已配置的第三方模型服务”。对齐现有提示后，重跑受修改的
AI/管理两个文件，13/13 通过；40 个独立用例最终均有通过记录，无跳过。
构建、安装补丁、Compose 合并配置和 `git diff --check` 通过。没有为这批运行
全部历史测试或新增专项测试平台。

日志在本地忽略目录：`[私人验收产物已从公开副本省略]`（首轮）、
`native-private-video-recheck.log`、`native-private-video-build.log`、
`native-private-video-patches.log`。独立私人作用域复核未发现具体功能阻断。

边界：AI 执行器和 Telegram 网络仍为测试替身；GIF 转换程序、Koishi 插件、
data URI 解析、官方上传编码是真实实现。尚未向真实 Telegram 发送本批视频，
尚未完成原生入口真实模型验收，也未构建/运行新增媒体 Docker 镜像。
没有改远程服务。转换取消、转换硬超时、HTTP 下载内存硬上限、MP4/音频/截取
压缩尚未完成；平台开关开放媒体，逐群媒体参数界面尚未提供。细节见 ADR-024
和 [使用说明](NATIVE-AI-FILES.md)。

## 第五批：预装翻译、代码→AI 组合与媒体预设（2026-10-26）

对应 AIL-17、AIL-94、AIL-98。以上历史批次的未完成项以本节新增证据为准，
三票仍保持进行中；没有将本地接线等同于真实 Telegram/模型交付。

| 功能 | 实际证据 |
| --- | --- |
| 翻译 | `/translate` 本人确认、目标语言与原文绑定；单词和引号内多词语言、原文换行；独立普通 Skill 路由与 SHA-256 校验 |
| 链接说明 | 群 `/brief` 先真实调用链接整理代码，再将输出传给模型；原生确认回调支持同群引用；模型请求计量为一次、宿主代码计一次；撤销代码授权阻止继续 |
| 旧入口兼容 | 原 `link-brief` Skill 保持不变，新增 `docker-link-brief`；旧 mixed 集成检查通过 |
| 可复制配置 | 实际 Loader 加载轻量 YAML，Help/Echo 有结果、RSS/Schedule 按配置省略；重启保留两份 SQLite 用户/群数据，原配置与复制文件不被改写 |
| 媒体输出 | 本机真实 FFmpeg/ffprobe：MP4、MP3、M4A、small 与 clip；输出字节/格式、时长、偶数尺寸核对；无音轨/无效媒体明确失败 |
| 正式宿主编码 | 命令实际注册，官方 Telegram 编码器生成含正确 MIME、目标用户和真实 MP3/MP4 字节的 multipart；Telegram 网络由替身接收 |
| 取消与输出核对 | 当前本人任务取消、停止进程与临时目录清理；下载使用 adapter 原有 HTTP 客户端传递取消/期限；拒绝时长明显截断的有效文件 |

```sh
node --import tsx --test tests/koishi-ai.test.ts tests/koishi-business.test.ts tests/sandbox-ai.test.ts tests/sandbox-wiring.test.ts tests/sandbox-actions.test.ts tests/koishi-mixed-integration.test.ts tests/koishi-transcode.test.ts tests/koishi-native-host.test.ts tests/koishi-presets.test.ts
npm run build
PUBLIC_ORIGIN=https://groupweave.example ENABLE_MEDIA=1 docker compose -f compose.yaml -f compose.koishi.yaml config --quiet
git diff --check
```

**54 passed / 0 failed / 0 skipped**，自然退出。TypeScript/Vite 构建、Compose
合并配置及 diff 格式检查通过。日志为忽略的本地文件
`[私人验收产物已从公开副本省略]`、`[私人验收产物已从公开副本省略]`。
skill-creator Python 校验器因缺少 PyYAML 未能启动；两份 Skill frontmatter
另用仓库已安装 YAML 解析器检查，文件哈希与固定绑定一致。

范围：模型/Bridge 计量与 Telegram 网络仍是受控替身，未新增真实外部验收。
本机 Docker daemon 未启动，本轮只核验 Compose 配置，未构建/运行容器。
没有修改远程服务。新媒体取消不覆盖上游 `/v2g`；新媒体不支持本地 Bot API
文件模式，下载仍有缓冲且无流式内存硬上限。图片/PDF、视频网站解析、沙箱
文件回传和完整逐群媒体配置仍未交付，最终安全专项顺序保持在功能交付之后。

## 第六批：图片、PDF、Markdown 与手动解析接缝（2026-10-26）

本节新增证据更新上述历史批次的图片/PDF 未交付状态；对应 AIL-96/97，
两票仍在进行中，没有把本地接缝验证当作真实站点或 Telegram 收件。

| 功能 | 实际证据 |
| --- | --- |
| 图片处理 | Sharp 0.35.5 实际 JPG/PNG/WebP 编解码、尺寸与质量、图片方向、文件输出；当前/同会话引用，非法格式/大小/归属拒绝 |
| 多图 PDF | pdf-lib 1.17.1 生成可重新打开的两页 PDF，消息顺序、本人同会话收图、引用首图、取消和关闭清理；修正收图与 done 并发时漏图 |
| Markdown | 实际上游服务 + 本机 Chrome 输出 PNG；人工查看中文、代码、KaTeX 分数、Mermaid 方框/箭头；未开启时真实 Koishi 命令/别名返回待配置 |
| 正式宿主上传 | 原生宿主启用浏览器后经官方 Telegram 编码器产生真实 PNG、图片文件和 PDF multipart，核验 MIME、目标用户及输出字节 |
| 站点解析接缝 | 上游 processSingleUrl 消费受控 API 回包，转成含实际小图片/视频字节的 Koishi 消息；无配置不联网、只用指定 API、同会话引用、重复进行中请求、未知投递停止及直接失败提示 |
| 生命周期 | 浏览器/canvas 退出顺序导致 Target.closeTarget 错误已复现并窄补丁修复；仍然存活的 page 关闭错误继续传播，不静默吞掉 |

```sh
node --import tsx --test tests/koishi-images.test.ts tests/koishi-render.test.ts tests/koishi-site-parser.test.ts tests/koishi-native-host.test.ts tests/koishi-business.test.ts tests/koishi-presets.test.ts
npm run build
npm run postinstall
PUBLIC_ORIGIN=https://groupweave.example ENABLE_MEDIA=1 ENABLE_RENDER=1 docker compose -f compose.yaml -f compose.koishi.yaml config --quiet
git diff --check
```

最终 **29 passed / 0 failed / 0 skipped**，自然退出，无 browser/canvas 清理错误。
TypeScript/Vite 构建、六份依赖补丁应用、Compose 配置及 diff 格式检查通过。
最终日志：`[私人验收产物已从公开副本省略]`、`[私人验收产物已从公开副本省略]`、
`[私人验收产物已从公开副本省略]`。渲染样张：`[私人验收产物已从公开副本省略]`。

一个实现分支还额外运行了历史全套，记录为 317 passed、11 skipped、0 failed；
该记录早于最后的局部修复，不作为最终整套状态声明。本批最终依据是上面的
29 项相关检查，没有为此新增审计/测试平台。

边界：Telegram 网络仍由测试替身接收；解析 API 与媒体传输也使用受控回包，
尚无真实 B站/抖音媒体收据。真实 Telegram 与部署验收仍待完成。本机真实
Chrome 成功不等于受限 Docker 可以启动 Chromium；默认浏览器关闭，未修改
远程服务或放宽容器权限。图片本地编码阶段不能硬中断；解析有 60 秒期限但
尚无立即取消/停机中断接口。最终安全专项仍按原计划放在功能交付之后。

## 第七批：本机真实容器验收（2026-10-26）

使用现有 Colima 的 Docker 29.5.2（Linux arm64），没有操作远程服务器或启动
旧 Telegram 接收端。单独构建 `groupweave-m2-acceptance:20261026`：
Node 26-slim，FFmpeg/ffprobe 7.1.5，Chromium 156.0.8078.47 和中文字体。
镜像 ID：`[private digest omitted]`。

约束与现有 Compose 一致：`USER node`、只读根、`/tmp` 64 MiB noexec/nosuid、
cap-drop ALL、no-new-privileges、128 PID、512 MiB、1 CPU、init。功能检查还
关闭容器网络，只读挂载已有 tests，输出写临时 tmpfs；模型/Telegram 网络不参与。

| 验收项 | 结果与边界 |
| --- | --- |
| 生产镜像 | PASS；安装真实系统依赖、npm 生产依赖和六份补丁，TypeScript/Vite 构建通过 |
| 原生宿主与图片/PDF | 10 passed / 0 failed / 0 skipped；真实 GIF、MP3、MP4、图片与 PDF 字节，经官方 Telegram 编码器生成上传内容；HTTP 收件仍为替身 |
| 媒体预设 | 单项组合检查 PASS：实际 MP4/MP3/M4A、small、clip、ffprobe 信息；H.264 4:4:4 输入确为 97×65，视频输出尺寸为偶数 |
| 启动与重启 | PASS；真实 HTTP health 两次通过；宿主退出后经 Store API 读回相同合成群配置与 admin membership |
| 资源观察 | 一次空闲采样 178.3 MiB / 512 MiB、43 PID；仅是采样，不作为并发峰值或容量承诺 |
| Markdown 容器 | FAIL；6 项中 4 项非浏览器检查通过、2 项实际浏览器检查失败；不将它们跳过或计作成功 |
| 渲染故障定位 | Crashpad 写入路径用 XDG 临时目录修正后，仍 `No usable sandbox`；容器内 userns 探测 EPERM，相关 guest 内核开关开启，Docker OOMKilled=false |
| 失败部署 | ENABLE_RENDER=1 在当前受限环境实际启动失败并退出，未提供假健康服务；默认保持 0 |

构建初期 registry/token EOF 和 apt HTTP 502 都留下日志。Docker daemon 使用
当前 VM 的临时代理 drop-in，构建代理参数未固化进镜像。直连完整 Debian 索引
超时，代理可完整取得；最终通过合并系统包、同一 RUN 内最多三次 install 补包
完成，没有禁用签名校验。后续网络仍可能失败，不承诺该环境永久稳定。

验收修正而非业务绕过：Linux FFmpeg 7 不支持原测试素材的 FFV1-in-MP4，改为
标准 H.264 MP4，并断言输入奇数尺寸。健康探测设置与 PUBLIC_ORIGIN 一致的 Host，
Docker 自动分配的主机端口在实际重启后从 32771 变为 32772，因此脚本重新读取。
独立数据卷由脚本创建、读回后清理；旧容器、卷及远程服务未动，镜像保留供复用。

素材修正后，仅补跑受影响的本机 `koishi-transcode.test.ts`：8 passed / 0 failed /
0 skipped；TypeScript、Compose 合并配置与 diff 格式检查通过。Luna 复核合并
安装的可选开关及失败退出、素材尺寸断言，没有新增全量测试或审计平台。

证据（本地 ignored artifacts，不含凭据）：

- `[私人验收产物已从公开副本省略]`：镜像构建与版本。
- `[私人验收产物已从公开副本省略]`、`m2-container-functions-state.txt`：10 项及约束。
- `[私人验收产物已从公开副本省略]`：实际媒体预设。
- `[私人验收产物已从公开副本省略]`、`m2-container-host.log`：健康、重启与业务数据。
- `[私人验收产物已从公开副本省略]`、`m2-container-render-home.log`、`m2-container-render-xdg.log`：渲染失败及路径诊断。
- `[私人验收产物已从公开副本省略]`、`m2-container-render-state.txt`、`m2-container-render-startup.log`：userns、非 OOM 和失败退出。

结论仅覆盖本机镜像中的固定功能与存储。首轮 AIL-96 Docker 渲染仍有缺口；该缺口
由下方第十批本地容器复验关闭，真实 Telegram `/mdimg` 收件仍待目标部署验收。
AI/站点解析的真实服务、本地 Bot API 文件模式、上游 v2g 即时取消/硬超时及逐群
媒体参数仍按各票保留，不由此关闭。


## 第八批：AyuGram 真实文件与媒体收发（2026-10-26）

使用专用测试 Bot 的私人会话和本次生成的
纯色图片、测试视频、短文本；复用受保护测试配置。接收端运行在本机 Docker，
独立数据卷、127.0.0.1:<application-port>、非 root、只读根、cap-drop ALL、no-new-privileges、
512 MiB/128 PID/1 CPU。不改远程服务器或其他服务；AI/Markdown/站点解析未启用。

| 实际操作 | 实际结果及证据边界 |
| --- | --- |
| `/start` | AyuGram 收到当前功能菜单，明确 AI/渲染/解析配置状态 |
| `/savefile` → 下载 | 55 字节 UTF-8 TXT，实际读取与中文输入一致 |
| TXT 附件说明 `/readfile` | Bot 实际返回文件原文 |
| PNG 附件说明 `/image jpg 400 80` | 下载 JPEG 981 字节；Sharp 检查 400×300，输入 800×600 |
| 视频说明 `/convert mp3` | 实际收到并下载 65347 字节 MP3；ffprobe 为 MP3 audio，4.017052 秒 |
| 视频说明 `/clip 1 2` | AyuGram 实际收到 2 秒、320×240、35349 字节 MP4；本项依据 TG 客户端回执/元数据，未另存输出做 ffprobe |
| `/v2g` → 窗口内上传测试视频 | 实际上游插件返回“处理中”和 4 秒动画；客户端显示 GIF/`0file.gif.mp4`，Telegram 的动画表示，未宣称下载字节仍是 GIF |
| `/imgpdf start` → 两图相册上传完成 → `/imgpdf done` | 最终下载 PDF 7506 字节；pdf-lib 重新打开为 2 页，页尺寸依次 800×600、600×800 |
| 收图/交互期限 | 超过 120 秒收图窗口明确提示无待处理收集；超过 20 秒 v2g 窗口返回超时，不记为成功 |

下载证据保留在本机忽略目录 `[私人验收产物已从公开副本省略]`，不提交会话凭据或用户数据。
PDF 最终文件为 `images-final.pdf`，核验元数据见 `pdf.json`。实际聊天时间：TXT
JPG、MP3、裁剪片段、GIF 和 PDF 均有代表性客户端收发记录；具体时刻未公开。

### 实际发现并修复

1. Node 26 与旧 proxy-agent dispatcher 不兼容：移除测试 YAML 的 proxy-agent，
   使用进程启动前的 Node 原生代理变量；Compose/环境模板已提供默认关闭的入口。
2. 官方 Telegram adapter 将相对文件路径传入要求绝对 URL 的文件拦截器，导致
   附件失败和未捕获异常退出：固定版本补丁解析到原文件端点，并保护 update handler。
3. 媒体 caption 命令未识别、附件元素占据命令位置参数、去命令前缀后丢失 quote：
   在同一上游补丁修正；真实 TXT、image、convert、clip 路径均已使用 caption。
4. 收图只接受 message，而真实 dispatch 为 message-created：接受真实事件类型。
5. 上游原地排序 photo 列表使 PDF 选中缩略图：改为对副本排序。最初两页仅
   90×67/67×90；最终真实下载已恢复正确尺寸，不能用先前低清产物冒充最终通过。
6. 附件解码异步和相册聚合可能被 done 超车：复用上游已有 `telegram/message`
   原始事件提前同步登记附件 ID；不增加队列或改变 polling 并发。聚焦回归使用真实
   TelegramBot/handler/Loader，暂停两个同相册附件的解码，确认 done 仍生成两页。

另一个真实使用边界：AyuGram 仍在上传图片时，文字 done 可以先到达 Telegram。
临时诊断只记录 hasBot/valid/active/matched 等布尔值与计数，确认顺序是 start、
空 done、photo、photo；等待上传完成后再次 done 即获得最终两页。已更新用法，
不是用延时猜测所有照片均已送达。诊断代码仅用于本机派生镜像，正式源码不含诊断。

### 验证与剩余范围

最终针对适配器、上游图片事件和图片处理的 14 项检查通过，无跳过；TypeScript
检查通过。固定补丁在干净上游 4.5.11 包应用成功，postinstall/Compose 配置检查
通过。最终新回归实例化真实 TelegramBot，网络仅在该回归中使用受控替身；上表
AyuGram 收件单独记录，不由回归结果代替。

本轮运行镜像基于第七批完整生产镜像，再加入已验证的 adapter 补丁和图片适配
源文件的小层；没有重跑全部系统包下载。正式 Dockerfile 仍通过 postinstall
应用同一版本补丁。测试服务的重启曾遇到 Telegram TLS ECONNRESET，有限重试后
健康显示 telegramConnected=true；这不等于完成长期在线稳定性验收。

M1/M2 不因此整体完成：Markdown Docker 沙箱仍不可用；解析服务/真实模型、
所有群管理/多租户流程、其余媒体预设和引用/UI组合未在本轮逐项重验。v2g 硬取消、
逐群媒体参数、沙箱文件产物回传等原缺口保留。最终安全检查仍按约定后置。

## 第九批：真实 AyuGram 群管理、提醒与 RSS（2026-10-26）

使用本机 Docker 中的官方 Koishi 原生宿主、专用测试 Bot 和既有 A/B 验收群，
通过 AyuGram 实际发送和接收命令。未使用真实模型。M1/M2 与相关 Linear 项目仍
保持进行中；本批没有完成其他既有缺口。

| 实际操作 | 实际结果及边界 |
| --- | --- |
| A `/register`；`/rules 去重并排序，最多10条` → `/applyrules` | 注册配置 v1；预览提案（ID 前缀 `eaed`）后确认，A 配置到 v2。 |
| A `/links` 输入链接顺序 b、a、b；B 注册并查询配置后输入 b、a、b | A 返回 a、b；B 返回 b、a。B 注册为 v1，排序关闭、最多 20 条；没有继承 A 的规则。 |
| A 一次性提醒 | 设置后真实收到；随后 `/remind list` 显示本群没有提醒。 |
| A/B 跨群提醒与容器重建 | 创建 A ID 2、B ID 3 的未来提醒；B 删除 ID 2 返回“找不到本群的这个提醒”。容器重建后 A、B 列表仍分别只有 ID 2、ID 3。 |
| B 间隔提醒 | 代表性间隔提醒按计划送达并删除；容器重建后，列表符合预期。 |
| RSS 缺陷与修复后复验 | 初次真实添加显示成功，后续列表却为空；同一订阅仍经上游 poller 推送版本 1。根因是 Telegram `interaction/command` 直接执行命令，未经过普通消息中间件的 session 模型收尾 flush：上游命令改了观察到的 `channel.rss`，但没有持久化。`src/server/koishi-rss.ts` 在上游 RSS 动作完成后等待 `channel.$update()`，保留上游返回值；`tests/koishi-rss.test.ts` 移除原先手动 flush 后可复现此失败，修复后通过，并覆盖列表、删除和重启恢复。 |
| RSS 修复后的 A/B 实测 | 使用本机容器 loopback 临时受控 Feed：A、B 分别添加各自 Feed，列表正确隔离，各自真实收到版本 1；B 取消 A 的 Feed 返回“未订阅此链接”。第二次容器重建后列表恢复，A/B 分别真实收到版本 2，没有跨群条目。该证据覆盖真实上游轮询与 Telegram 投递，不代表公网 Feed 的新条目已验收。 |
| 公网 RSS 示例 | A 添加 `https://github.com/nodejs/node/releases.atom` 并列出成功；验收期间没有观察到公网源的新条目推送。 |
| `/status` | 实际回复 AI 未配置、`v2g` 已加载、Markdown 未开启、站点解析待配置 API。 |

针对性回归 `node --import tsx --test tests/koishi-rss.test.ts`：1 passed / 0 failed；
`npm run typecheck` 通过。未运行全套测试。运行期间曾观察到 `getUpdates`、
`sendMessage` 与成员查询连接中断；A 的 `/settings` 曾回复需要管理员，重试后显示
v2。此证据不代表长期在线稳定性。

本轮创建的 A/B 测试订阅（含公开示例）和提醒均通过 AyuGram 取消/删除；两群的
RSS 与提醒列表实际回复为空。取消后将受控 Feed 更新到版本 3，观察 101.46 秒
（超过 60 秒轮询间隔），HTTP 请求总数保持 8，无新增轮询；随后停止本轮临时 Feed
进程。证据摘要在 `[私人验收产物已从公开副本省略]`。测试接收端、
数据卷和已验收群配置保留供继续使用，不宣称删除所有测试数据。

本批真实操作只更新以上明确覆盖的群管理、链接整理、RSS 与提醒证据。AI 路由/模型、
真实 Telegram Markdown 收发、站点解析和其他原有缺口仍按相关记录保留；M1/M2 继续进行中。

## 第十批：Docker Chromium user-namespace 渲染复验（2026-10-26）

在 Colima/Docker 29.5.2、Linux arm64 的现有生产镜像
`groupweave-ayu-acceptance:20261026` 中复现并修复首轮渲染部署缺口。未操作
`gw-ayu-3ba99ef88dde`、其他现有容器/卷、远程服务或凭据。probe 容器使用
`--network none`，没有 Telegram 收件或模型请求。

根因证据：默认 `pids_limit=128` 下 Koishi host 启动/第二个 Chromium 页面创建挂起。
cgroup v2 读取到 `pids.current=84`、`pids.max=128`、`pids.events max=261`，表明
线程/子进程尝试触及 PID 上限；`memory.current=226,721,792` / 512 MiB，
`memory.events` 的 high/max/oom/oom_kill 均为 0。提高为 256 PID、内存仍保持
512 MiB 后无需其他代码或 capability 调整。

最终 probe 限制：non-root `node`、只读根、`/tmp` 64 MiB noexec/nosuid 和 `/data`
临时可写、cap-drop ALL、no-new-privileges、512 MiB、256 PID、1 CPU、无网络。
使用固定 Moby 默认 seccomp profile；user namespace 规则允许 `clone`、`setns`、
`unshare`，并移除 `chroot` syscall 的 `CAP_SYS_CHROOT` seccomp 条件，仍由 Linux
内核按 namespace capability 检查。没有 SYS_CHROOT、SYS_ADMIN、`--no-sandbox`、
privileged、unconfined 或宿主浏览器。

| 实际操作 | 结果 |
| --- | --- |
| 正式 `startKoishiHost()`，`ENABLE_RENDER=1` | PASS；完整 Koishi 启动日志，Telegram 关闭，无数据库/渲染服务就绪错误 |
| `GET http://127.0.0.1:4318/api/health` | HTTP 200 |
| 正式 `runtime.app.markdownToImage.convertToImage()` | PASS；PNG 签名正确，11,183 bytes，800×800；含中文、Markdown 强调和代码块；人工查看样张正常 |
| 进程关闭 | PASS；正常卸载 Koishi 插件、退出码 0 |
| Compose overlay 合并 | PASS；仅该 opt-in overlay 启用渲染 seccomp profile 并将 PID 上限调为 256，默认配置不变 |

样张：`[私人验收产物已从公开副本省略]`。固定 seccomp 来源 revision、规则
调整与部署命令见 ADR-029 和 `docs/NATIVE-IMAGES.md`。此证据关闭本机 Docker 浏览器
渲染部署缺口；真实 Bot `/mdimg` Telegram 收件和远程目标主机仍待下一步验收。

## 第十一批：远程原生 AI 与真实 Markdown 收件（2026-10-26）

测试 Bot 已迁至 deployment host 的 `the Bot container`；旧本机接收器停止，保留
容器、数据卷及迁移前备份。沿用固定 OpenShell Docker gateway/driver 和原生 DSH
镜像，新增 GroupWeave 专用固定 Sub2API 出站绑定。真实密钥只在受保护应用配置中，
每个任务获得独立短期 provider/profile、CLI HOME/XDG 和一次请求准入。

| 真实操作 | 实际结果 |
| --- | --- |
| 独立原生摘要探针 | Docker/DSH 完成；代表性单次请求成功，原生资源清理 verified；精确计量未公开 |
| AyuGram 私聊 `/ask` | 确认后收到一条成功回复；精确消息和请求计量未公开 |
| AyuGram 私聊 `/digest` | 确认后收到摘要；精确内容和计量未公开 |
| AyuGram 私聊 `/translate` | 确认后收到翻译；精确内容和计量未公开 |
| 私聊 `/mdimg` | 实际收到 800×800 图片；发现并修复 Koishi 消息 markup 被当作原始 Markdown 的问题 |
| A 群综合 `/mdimg` | 实际收到包含中文列表、JavaScript 高亮、KaTeX 公式、Mermaid 流程图的图片；人工查看通过 |
| A 群配置迁移 | `/settings` 保留原 v2、链接去重/排序/10条；预览并确认 AI 开关后规则生效 |
| 测试群 `/ask@ExampleBot` | 修复普通回复线程识别后，确认和单轮回复成功；精确内容与时刻未公开 |

AI 用量来自真实出站计量和供应商 usage，不代表金额账单。三个私聊任务的持久结果
均为 succeeded，证据为 `[私人验收产物已从公开副本省略]`。普通 Skill
通过 DSH 原生入口加载；模型工具定义在固定出站接缝剥离，未给予模型任意工具权限。

首次综合图在 512 MiB 配额下失败，cgroup `oom=1/oom_kill=1`，应用返回失败提示。
只将 opt-in 渲染部署调为 768 MiB、256 PID 后，同图复验成功，随后 memory/pids
max 和 OOM 计数均为 0。保留非 root、只读根、cap-drop ALL、no-new-privileges
及 Chromium sandbox。原始 Telegram 文本/换行和 `pre/code` UTF-16 实体恢复均
补在平台接缝，渲染继续使用现成上游服务。截图：
`[私人验收产物已从公开副本省略]`。

新增接缝定向检查 27 passed，两个 Telegram Markdown 回归 2 passed，群 callback
相关检查 11 passed；TypeScript
通过。没有重跑整个功能矩阵或启动独立审计/压力平台。部署前后按当时记录核对了其他服务状态；私有服务清单和标识未随公开副本发布。任务完成后再次查询未发现残留 sandbox/provider。

范围仍有限：站点解析 API/密钥未配置，多轮记忆、任意插件自动编排和完整 Console
在线维护不因此变为已交付；M1/M2 不整体关闭。群内单轮问答确认链路已真实通过，
截图为 `[私人验收产物已从公开副本省略]`；引用消息与长回复等组合未在本轮逐项
做真人演示，不将自动检查或代码存在等同于每个组合均已验收。

真实群 callback 的额外修复：普通超级群的回复也可能有 `message_thread_id`，
原实现误当作 forum topic 并提前返回。无内容/身份/凭据的临时布尔诊断确认了
群和用户绑定均匹配、仅线程字段存在；正式代码改按 `is_topic_message` 判断，
保留原有 chat/guild/channel/用户/签名校验，仍不支持论坛话题。相关含义核对了
[Telegram Message 定义](https://core.telegram.org/bots/api#message)。诊断代码已从
最终部署移除。此修复未扩大到新群或新的模型工具权限。

最终只读复核确认应用 health 成功，任务完成后无 sandbox/provider/profile 残留。详细镜像、容量、服务状态、回滚数据和私有证据未随公开副本发布。

## 第十二批：HTTPS 管理入口与直接站点解析（2026-10-27）

| 功能 | 实际结果 | 范围 |
| --- | --- | --- |
| HTTPS 管理站点 | `https://groupweave.example.invalid` 页面和 health 返回 200，匿名 `/api/me` 返回 401 | 已配置 HTTPS 入口、证书与反向代理路由 |
| Telegram Mini App | 默认「管理面板」菜单已设置；用户确认首次服务条款后，AyuGram 显示真实 A 群 v3 和现有功能 | 真实签名登录；非合成 initData，非演示身份；未执行群配置修改 |
| 本地直接解析 | 固定 yt-dlp 2026.10.26，无 Cookie、无第三方解析 API；B 站官方测试样例 `BV1GJ411x7h7` 生成 6,122,387 字节 MP4 | 本机网络、约 6.6 秒提取；复用 FFmpeg 合并 DASH，默认不高于 480p/10 MiB |
| deployment host 直接解析 | 工具和命令已部署；同一 B 站样例返回可能已删除/地区受限，AyuGram 私聊实际 `/parse` 返回失败提示 | 未收到媒体，不计远程站点功能已通过；不是缺解析 API |
| 抖音 | 本机固定版本对官方测试链接要求新鲜 Cookie，没有元数据/下载 | 尚未配置 Cookie；Cookie 模式还要求上游明确公开状态，不承诺提供 Cookie 即可成功 |

最终应用镜像 `[private digest omitted]`，
Bot 容器，host network、loopback application port、
原 Docker/DSH AI 接线保留，768 MiB/256 PID、cap-drop ALL、只读 rootfs。无 Cookie
或新增供应商凭据导入。最终只读资源快照约 437 MiB、187 PID，OOM/max 计数 0。
其他服务的私有标识和状态未随公开副本发布；本任务未操作共享基础设施。

必要验证：解析接缝 13/13；管理鉴权与 Koishi 入口 9/9；typecheck、前端构建及
`git diff --check` 通过。修正真实 yt-dlp 与模拟器差异：移除下载成功后也会退出 101
的 max-downloads 参数；支持 B 站 DASH 合并及匿名提取缺少 availability 字段。
没有用这些结果宣称完整安全检查或 M1/M2 全部完成。

证据：`[私人验收产物已从公开副本省略]`、
私人部署收据未随公开副本发布。

### 2026-10-27：匿名公开样例探测

在 一个 deployment host 对两个公开测试链接 `BV1nx411u79K`、`BV1wP4y1P72h`
各进行一次无 Cookie、无代理、无重试的有界直连提取；均在约 6 秒内返回
`Unable to extract initial state`。这不是 Cookie 必需提示。此前本机无 Cookie
提取成功仍仅代表本机样例；远端解析与 Telegram 媒体交付仍未通过。本批不再探测，
该未通过项不阻塞 M1/M2。脱敏结果见
`[私人验收产物已从公开副本省略]`。

## 第十三批：提醒编辑交付与 M1 接缝修复（2026-10-27）

本批接续功能交付，沿用 deployment host 原生 Koishi 接收器及现有 Docker/OpenShell AI
绑定。只更新本项目 Bot；当前镜像 `groupweave-native:20261027-m1m2`，镜像 ID
`[private digest omitted]`。

### M2：真实群提醒编辑与投递通过

真实测试群使用匿名化 bot mention 执行提醒编辑：

编辑操作返回更新后的提醒编号，并在指定时间送达新内容。列表仅保留新提醒；过短间隔被拒绝，且未留下测试提醒。原始消息文本、提醒编号和时刻未公开。

编辑继续复用 `koishi-plugin-schedule` 的创建/删除，不直接修改定时回调持有的
数据库行。支持原有一次性、每天、间隔语法；本批真实客户端演示的是一次性编辑。
每天/间隔编辑经实际上游插件的本地定向检查通过，未冒称这两种均已真实群收件。
相关 7 项检查覆盖实际持久行、带 @bot 的投递、上游拒绝与编辑；类型检查和构建
通过。编辑离旧/新触发时间须超过 60 秒，删除不能撤回已进入发送流程的消息。
完整暂停/恢复及定时调用其他能力仍未完成，AIL-21 保持进行中。

### M1：已部署修复，新增客户端组合尚未收件

明确引用机器人文字的 AI 确认回调现在接受该来源；原有同群、本人、签名、有效期、
单次消费和权限核验保留。12 项 AI 接缝检查通过并部署。既有真实私聊/群聊问答、
摘要和翻译证据仍有效；本批未将它们重新记为缺少模型配置。

平台管理员通过真实 Mini App 开放「链接整理与说明」，A 群管理员通过 `/rules`
预览并 `/applyrules` 启用，原有 link-cleaner、assistant、digest 保留。群内 `/brief`
收到正确的代码整理与第三方模型处理确认提示；电脑操作工具点击按钮持续返回
`windowNotFoundAtPosition`（一次全屏尝试返回 `noWindowsAvailable`）。重连后文字
输入仍可用，坐标点击未恢复。本批未获得 `/brief` 或引用机器人摘要的真实模型
收件，AIL-17/24 保持进行中；不把本地检查或确认提示当作执行成功。

部署后按当时基线核对本项目服务。运行指标和其他服务状态属于私有运维证据，未随公开副本发布。

证据：`[私人验收产物已从公开副本省略]`、
私有部署和运行收据未随公开副本发布。

## 第十四批：M1/M2 收尾（2026-10-28—29）

本批沿用现有原生 Koishi Bot、DSH/OpenShell/Bridge 和功能存储，最终部署
`groupweave-native:20261029-delivered`（健康且 TG connected）。解析按用户明确范围收缩为匿名公开内容尽力服务：
不使用 Cookie、登录、代理或绕过站点限制。已知 deployment host 公共样例失败如实返回，
作为已接受限制，不阻塞本批其他功能；不把它写成远端站点解析成功。

### M1：代码到 AI 组合与轻量配置

| 项目 | 真实结果 | 边界 |
| --- | --- | --- |
| 群 `/brief` | 已在测试群完成确认和执行。固定链接整理代码去重、排序输入；模型仅基于输入和代码结果说明，未访问网页。 | 经现有 DSH/OpenShell 路径执行；任务状态与投递结果通过私有 Store 核实。原始计量和收据未公开。 |
| 引用摘要 | 引用 Bot 先前结果后发送 `/digest` 并完成确认，随后收到摘要。 | 任务状态与投递结果通过私有 Store 核实。此结果不代表多轮历史已实现；原 DSH 配置未修改。 |
| Mini App 登录 | 复用 2026-10-27 AyuGram 的真实签名登录与 A 群显示证据。 | 本批没有更改认证或声明完成所有管理交互。 |
| 轻量配置切换 | 通过文件级 Koishi YAML/Loader 切换同格式最小配置，真实 TG 下 Help/Echo 可用；恢复原配置后群配置与暂停计划哈希相同。 | 这验证文件级配置应用和数据保留，不是 Console 在线安装/管理插件。 |

### M2：提醒、RSS、媒体与文件

| 项目 | 真实结果 | 边界 |
| --- | --- | --- |
| 提醒暂停/恢复和定时组合 | AyuGram 实际暂停并跨容器重启保留，再恢复提醒；固定定时链接能力实际返回按群设置排序的结果。 | 沿用 Koishi schedule 和既有链接代码/投递路径；不提供任意计划脚本或通用工作流。 |
| RSS 新条目与取消 | 新条目实际送达 Telegram，消息包含 permalink；取消订阅后停止后续投递。 | 用受控 Feed 验证真实更新与收件；不据此称公网 Atom 自然更新已验收。 |
| 图片与 PDF | 本批实收 PNG 和 WebP 图片输出；此前真实 JPG 输出、两张图片生成可打开的两页 PDF 继续有效。 | Markdown/KaTeX/Mermaid 真实图片仍以第十/十一批收据为准；下载完成后才能执行 PDF `done`。 |
| 视频与音频预设 | 本批实际收到 M4A、small MP4，且通过引用消息取得 `/mediainfo` 输出；此前 MP3、clip 和 `/v2g` GIF 收据仍有效。 | 当前不把这些收据扩大为 `/v2g` URL/引用/取消组合全部已通过。 |
| `/v2g` 上传视频取消 | 最终镜像包含 preflight race fix；聚焦视频回归 8/8 通过。AyuGram A 群 04:20 `/v2g` 返回“请在20秒内发送视频”，随后 `/cancelv2g` 返回“已取消视频转GIF”。 | 用户上传视频的取消路径已通过代表性实测。URL/引用视频路径及更宽组合未验收，不声明这些路径通过。私有收据未公开。 |

部署级运行状态和其他服务清单属于私有运维记录，未随公开案例发布。功能验收结果不构成当前在线状态或生产容量承诺。

### 当前明确保留

- 引用摘要已实际收到；多轮历史仍未验收。
- `/v2g` 用户上传视频的真实取消已通过；直接 URL/引用视频等输入路径仍未验收，`/cancelmedia` 仍只覆盖新媒体预设。
- Console 在线插件安装、完整依赖状态界面、AI 沙箱产物回传、多轮会话记忆和宽泛插件权限未交付。
- 匿名站点解析失败按 best-effort 范围接受；本批不声称 deployment host B 站或抖音远程样例成功返回媒体。

证据：`[私人验收产物已从公开副本省略]`、
`[私人验收产物已从公开副本省略]`、
`[私人验收产物已从公开副本省略]`、
`[私人验收产物已从公开副本省略]`、
`[私人验收产物已从公开副本省略]`、
`[私人验收产物已从公开副本省略]`、
`[私人验收产物已从公开副本省略]`；提醒、RSS、图片和媒体的
此前收据见本文件第八、九、十三批及 `docs/NATIVE-AI-FILES.md`、
`docs/NATIVE-IMAGES.md`、`docs/NATIVE-UTILITIES.md`。`/v2g` 用户上传视频取消有实际客户端证据；
URL/引用视频路径及更广组合仍未验证。
