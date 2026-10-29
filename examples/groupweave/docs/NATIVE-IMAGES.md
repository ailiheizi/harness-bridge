# 原生图片、PDF 与 Markdown

适用于 `npm run start:koishi`。这些固定操作不使用模型。图片/PDF 默认注册，
Markdown 浏览器渲染需平台显式开启；成员不用安装插件或编辑配置。

## 交付状态说明（2026-10-26）

图片转换和多图 PDF 已完成真实 AyuGram 收发；Markdown 已接入现成的
`koishi-plugin-markdown-to-image-service@2.7.0` 与
`koishi-plugin-puppeteer@3.9.0`。本机 Chrome 及下述受限 Docker Chromium 均已
生成 PNG。受限容器中的正式 `startKoishiHost()` 启动、`/api/health` 和实际
`markdownToImage.convertToImage()` 均通过。deployment host 原生 Bot 已经由 AyuGram
实际发送 `/mdimg` 并收到图片，最终综合图包含中文、列表、JavaScript 代码高亮、
KaTeX 公式和 Mermaid 流程图。Docker 的 opt-in 部署配置见 `compose.koishi.render.yaml`。

真实收件补齐了两项接缝：优先读取 Telegram 原始文本，避免 Koishi 的 `<br/>`
等消息标签进入图片；恢复 Telegram `pre/code` 实体为 Markdown，保留 Mermaid
语言。完整 Bot 渲染综合图时曾触及 512 MiB 并杀死 Chromium 子进程，最终渲染
overlay 使用 **768 MiB / 256 PID / 1 CPU**。同图复验成功，之后 cgroup
memory/pids max 与 OOM 计数均为 0。未启用渲染的默认容器仍为 512 MiB / 128 PID。
真实客户端证据：`[私人验收产物已从公开副本省略]`。

2026-10-26 后续 probe 在现有 `groupweave-ayu-acceptance:20261026` 镜像中使用
固定 Moby 默认 seccomp profile 和 user-namespace syscall 规则。根因是原生容器
128 PID 上限：挂起时 `pids.current=84`、`pids.events max=261`，说明 Chromium
线程/子进程创建曾反复触顶；512 MiB 内存未触顶（约 216 MiB，`memory.events`
没有 high/max/OOM 事件）。opt-in overlay 将上限提高到 256 后，正式 Koishi
host 启动，健康检查返回 200，真实 `convertToImage()` 输出 800×800、11,183-byte
PNG，并正常退出。输出样张：`m2-container-markdown-render.png`（私人验收产物未随公开案例发布）。

最终 profile 保留 `cap-drop ALL`，不添加 capability；沿用 Moby profile 的其他
默认规则，额外允许 `clone`、`setns`、`unshare`，并允许 `chroot` syscall。Linux
仍按当前 user namespace 的 capability 检查 `chroot`；实际 Chromium 在该配置下
通过。该本机 probe 是非 root、只读根、no-new-privileges、512 MiB、256 PID、1 CPU，
无网络；它不替代上述完整 Bot 的 768 MiB 实测配额。不使用 SYS_ADMIN、`--no-sandbox`、privileged、unconfined 或宿主
浏览器。固定 profile 来源、Compose overlay 和边界见 ADR-029。

## 图片转换

回复同会话图片或 JPG/PNG/WebP 文档后发送：

```text
/image jpg
/image png 1024
/image webp 1280 80
```

中文别名为 `图片转换`。参数是格式、边长上限和质量。默认边长上限 1280、
质量 80；可选边长 32–4096、质量 40–95。保持比例、不放大，自动应用图片方向；
透明图片转 JPG 时铺白底。PNG 质量使用 Sharp 的调色板量化，不是目标文件大小。
结果作为可下载文件发送，保留输出格式。

支持当前附件或同会话引用，单图最多 5 MiB、解码最多 2000 万像素，输出最多
10 MiB。SVG、动画图片和其他格式不在首版范围。媒体下载使用 Telegram 远程
文件 API，本地 Bot API 文件模式暂不支持。

## 多图 PDF

```text
/imgpdf start
（在当前会话发送图片或相册，等待客户端显示上传完成）
/imgpdf done
```

`图片转PDF` 是同一个命令的中文别名。也可以引用一张图片后 `/imgpdf start`，
将该图片作为第一批输入，再继续上传。也可把 `/imgpdf start` 放在首张图片说明中。`/imgpdf cancel` 取消收集或正在处理的 PDF。

只收集发起者在当前会话、启动后的图片，不读取历史，也不收其他人的图片。
120 秒收图窗口，最多 10 张，按消息 ID 排序；重复文件/消息不会重复加入。
支持逐张消息和 Telegram 相册。必须等待客户端上传完成再发送 done：文字可能
比仍在上传的图片先到达 Telegram；机器人只能处理已经收到的图片。若提示尚未
收集到图片，待上传完成后可在收图窗口内重新 done。
未完成的收集在超时或应用停止时消失。每张仍限 5 MiB，总输入限 20 MiB、
总解码像素限 2000 万，PDF 输出最多 25 MiB。一张图一页，最长页边至多 842 pt，
使用实际 JPEG 图片嵌入 PDF；这不是 OCR 或可编辑文字提取。

每人当前会话一个图片/PDF 操作，全应用同时两个；忙时提示，不排队。图片收集
仅暂存文件 ID，完成时逐个核验权限、下载和处理，结果只回发起会话。下载可中止；
Sharp/PDF 的本地计算阶段会等待当前库调用结束后再释放名额，不承诺硬实时中断。
处理期限为 60 秒，超时或取消后的产物不发送。下载仍有缓冲，不宣称流式内存硬上限。

## Markdown、公式与图表

平台配置：

```text
ENABLE_RENDER=1
RENDER_BROWSER_PATH=/absolute/path/to/chromium
```

本机可用已经安装的 Chrome/Chromium；不指定路径时由上游插件查找浏览器。
没有自动下载浏览器。命令 `/mdimg <Markdown>`，也可引用当前会话的文字后
发送 `/mdimg`；别名 `markdownToImage`、`Markdown转图`。支持代码高亮、KaTeX
数学公式和 Mermaid 代码块。全部通过上游 Markdown 渲染服务完成，模型不参与。

最多 8 KiB、120 行，宽度 800 至 1000 px，渲染高度上限 8000 px、输出 10 MiB；
同时只处理一项，页面期限 30 秒。原始 HTML 按文字处理；远程图片和网页资源
请求被阻止，公式字体/图表脚本来自安装包。不会为渲染用户文本访问外部网站。

普通 `compose.koishi.yaml` 仍将渲染保持关闭。需要在专用部署显式选择该功能时，
追加 `compose.koishi.render.yaml`：

```sh
docker compose --env-file .env.local -f compose.yaml -f compose.koishi.yaml \
  -f compose.koishi.render.yaml config --quiet
docker compose --env-file .env.local -f compose.yaml -f compose.koishi.yaml \
  -f compose.koishi.render.yaml up -d --build
```

overlay 安装 Chromium、启用 `ENABLE_RENDER`、使用固定 seccomp profile，并把
PID 上限从 128 提到 256。平台仍须在实际目标 Docker/内核上完成 Koishi runtime
与 Telegram 收图验收后再宣称真实 Bot 功能可用。原 ADR-027 记录了未配置 user namespace seccomp 时的
`No usable sandbox` / `unshare EPERM`；后续部署决策见 ADR-029。

## 实现与交付边界

图片编码复用 [Sharp](https://sharp.pixelplumbing.com/api-resize/)，PDF 嵌入复用
[pdf-lib](https://pdf-lib.js.org/docs/api/classes/pdfdocument)。Markdown 使用
[markdown-to-image-service](https://github.com/araea/koishi-plugin-markdown-to-image-service)
导出的 Koishi 服务和 [Puppeteer 插件](https://github.com/koishijs/koishi-plugin-puppeteer)，
不复制 Markdown 渲染器。[依赖补丁](../patches/README.md)记录少量兼容修改。

真实编码文件、PDF 页数、浏览器样张及官方 Telegram 上传编码与真实网络收件
分别记录。2026-10-26 AyuGram 已收到实际 JPG 和逐张收图生成的 PDF，详见第八批
原生验收；Docker Markdown 已按 ADR-029 在本机 Colima 容器验收，真实 Bot 收发
仍待目标部署验证。

## 收尾功能核对（2026-10-28）

以下是已知范围内仍需在目标 Bot/AyuGram 组合确认的短清单；不重做第八批已通过的
GIF、MP3、clip、JPG、PDF 和 Markdown 收发，也不扩展本地 Bot API 文件模式。

- 媒体预设：用小型 MP4 验证 `/convert m4a`、`/convert small`；用 M4A 验证
  `/mediainfo` 和无视频输入的拒绝提示。再以本人正在进行的媒体任务执行
  `/cancelmedia`，确认停止提示与临时目录清理。引用附件后执行这些命令，确认引用
  消息 ID 和原会话回传正确。代码和定向回归现已区分 Telegram 普通群回复携带的
  `message_thread_id` 与真实论坛话题的 `is_topic_message`；目标 Bot 的视频回复
  仍待复验。
- 图片：用小型 JPG 分别执行 `/image png` 与 `/image webp`，确认输出格式、下载和
  文件名；对同会话引用的 JPG 重复一次转换，确认引用输入仍可用。相同判定已修复
  普通群回复的误拒绝，目标 Bot 的 WebP 回复仍待复验。
- 文件：现有 TXT/Markdown 读取、TXT 上传和 PDF 下载已有记录；若目标客户端复验，
  只需确认这些常规附件仍能打开，不扩展压缩包或其他格式。
- RSS：真实受控 Feed 已验证群隔离、添加/列出/取消、重启恢复及新条目投递；公网
  Feed 新条目投递尚无收据。当前上游 `koishi-plugin-rss@3.0.1` 推送标题/作者和
  条目标题，不输出条目 URL 或正文；若产品要求自然公共更新包含链接/摘要，需先
  在原生上游消息格式接缝补充可用字段，再验收一条含 URL/description 的 Feed。

本地合成输入位于忽略目录 `[私人验收产物已从公开副本省略]`：`synthetic-av.mp4`
（2 秒 H.264/AAC，15,656 bytes）、`synthetic-audio.m4a`（2 秒 AAC，17,620 bytes）
和 `synthetic-source.jpg`（96×64 JPEG）。它们仅供上述 UI 操作，不构成 Bot 收件
或转换通过证据。Telegram 交互和 `/cancelmedia` 仍待操作者在客户端执行。
