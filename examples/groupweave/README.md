# 群织 · GroupWeave

GroupWeave is a working multi-tenant Telegram bot reference application. Platform
administrators expose reviewed capabilities; each group's administrators
configure, preview, and enable them; members use the capabilities available in
their group. Koishi hosts native code plugins, while model-backed tasks use the
existing Docker/OpenShell/DSH Harness Bridge. The bot does not create a Docker
container or a resident Agent per group.

## Current case

The foundational M1–M4 slices are implemented and deployed; this does not mean the full product roadmap is complete. See [milestone status and remaining features](docs/MILESTONE-STATUS.md) and the [updated Web workspace](docs/WEB-WORKSPACE.md). Representative real Telegram evidence
through 2026-10-31 includes:

- Single-turn group `/brief`: the bot's link-cleanup code prepared the input,
  then an existing real provider explained the supplied text and code result.
  Quoting a prior bot result and confirming `/digest` also returned a summary.
- Telegram Mini App: a real signed login opened the registered group's
  configuration. This verifies login and display, not every management action.
- Group utilities: reminders can be created, edited, paused, resumed, and
  persisted across restart; RSS subscriptions are group-scoped and delivered
  new feed items.
- Media: representative Telegram transfers succeeded for PNG/WebP images,
  PDFs, M4A, and small MP4. `/mediainfo` reads quoted media metadata. These
  results do not establish every codec, input, or cancellation combination.

The 2026-10-31 delivery also records a downloaded and checked 23-byte Markdown
result, a same-DM follow-up after restart using prior context, and a real
confirmed rules proposal and rollback. See [feature catalog](docs/FEATURE-CATALOG.md)
for commands, dependencies, defaults, and evidence scope.

| Capability | Entry point | Conditions and limits |
| --- | --- | --- |
| Help, Echo, group registration and rules | `/help`, `/echo`, `/register`, `/rules`, `/applyrules` | Telegram connected; registration and rule changes require current group-admin authority. |
| One-turn AI Q&A and summary | `/ask <text>`, `/digest <text>` | AI binding and platform/group feature must be enabled. The requester confirms third-party processing; `/cancel` cancels their active task. Reply to a message and omit the command body to select that text. No group history is read. |
| Link cleanup plus model explanation | `/brief <text>` or reply to text with `/brief` | Group-only. Both link cleanup and link-brief must be enabled at platform and group scope. Cleanup runs first; the model receives the text and actual code result and does not browse the web. |
| Translation | `/translate <language> <text>` | Uses the enabled group assistant and one-turn confirmation. |
| Reminders | `/remind ...`, `/remind list`, `pause`, `resume`, `edit`, `remove` | Current group administrator in the main group chat. Uses the process timezone; active schedules are owned by Koishi Schedule. |
| RSS | `/rss <feed-url>`, `/rss -l`, `/rss -r <feed-url>` | Current group administrator in the main group chat. Subscriptions are explicit and group-scoped; only new feed items are sent. |
| Image/PDF | `/image`, `/imgpdf start` … `/imgpdf done` | Native image conversion and PDF collection use bounded Telegram attachments. Per-file, pixel, size, and collection limits apply; see the image guide. |
| Audio/video | `/convert m4a`, `/convert small`, `/mediainfo`, `/clip`, `/v2g` | `ENABLE_MEDIA=1` and FFmpeg/ffprobe where required. Support depends on input type; see the media guide for cancellation boundaries. |
| Markdown rendering | `/mdimg <Markdown>` | `ENABLE_RENDER=1` and a working sandboxed browser are required. |
| Public video parsing | `/parse <url>` | Optional, manual, anonymous public content only. Best-effort; no cookies, login, proxy bypass, or guarantee that a site remains supported. |
| Local keyword review | `/keywords <text>` or Web | Built into the native host. Platform and group must enable it; per-group editable rules, five visible defaults, zero model calls. No trained classifier or moderation actions. [Guide](docs/KEYWORD-REVIEW.md). |
| AI ad review | `/scan <text>` | Uses the existing assistant/DSH route with explicit confirmation and actual model usage. No chat history or tools, advice only. [Guide](docs/AI-AD-REVIEW.md). |
| Daily RSS digest preset | `/rssdigest 每天09:00`, then confirmation | Bounded source/model/group plan reuses native RSS and schedule. See [current validation status](docs/RSS-DIGEST.md); it is not arbitrary workflow orchestration. |

## Current limits

Online plugin maintenance, bounded artifact return, group rules and personal
conversation/task features are part of the deployed M1–M4 case. The live model
set currently contains only `default`; additional profile selection was checked
locally, not verified with multiple live models. `/ask` uses the requester's
current bounded context, not the group's full message history; changing
audience clears that context. Site parsing is anonymous best-effort. The
anti-ad adapter's original private classifier is not included, so scanning is
unavailable by default. M5 deployment documentation/recipes and M6's six bounded
negative cases are complete; see the [closeout record](docs/CLOSEOUT-20261031.md)
for executed layers and limits. The [follow-up](docs/DEPLOYMENT-FOLLOWUP-20261031.md)
completes Web rule-history rollback, optional Compose model profiles and a clean
default Docker build/start. Optional full system-dependency rebuilds remain a
separate coverage limit. This is not exhaustive plugin or security certification.

This repository packages the working Bot case and its Harness binding. Broader
framework extraction is deferred; the portable method and execution boundary
remain documented by the [Harness Bridge](../../docs/architecture.md) and the
[repository setup guide](docs/REPOSITORY-SETUP.md).

## Start locally or with Docker

The example depends on the Harness Bridge package at `file:../..`; keep the
repository checkout layout intact. Follow [Repository setup](docs/REPOSITORY-SETUP.md)
for dependency installation, local native startup, private environment setup,
and the Docker Compose entrypoints. In particular, Docker builds from the
repository root:

```sh
# From the Harness Bridge repository root
docker compose -f examples/groupweave/compose.yaml up --build
```

The preview binds to loopback and uses synthetic identities. It cannot manage
real Telegram groups. To run the native Telegram entry, use the private
environment file and both Compose files described in the setup guide. A real
bot requires its own token, platform admin IDs, current group-admin rights,
and an exact HTTPS Mini App origin. Never commit deployment credentials.

## History and design

The dated acceptance documents retain scoped evidence and known limitations;
they are historical records, not deployment configuration or a live status
page. Private receipts and deployment identifiers are omitted. Synthetic
fixtures and acceptance-only settings are not production defaults.

- [Native acceptance history](docs/ACCEPTANCE-20261022-NATIVE.md)
- [AI and file commands](docs/NATIVE-AI-FILES.md)
- [RSS, reminders, and welcome](docs/NATIVE-UTILITIES.md)
- [Images and media](docs/NATIVE-IMAGES.md)
- [Native Telegram setup](docs/NATIVE-KOISHI.md)
- [Feature boundary and maturity](docs/MODULES.md)
- [Core architecture](docs/CORE.md)
- [Dependency and source references](docs/REFERENCES.md)
- [Publication and evidence boundary](docs/PUBLICATION.md)

GroupWeave is an external application case. It does not add a Workflow-to-Skill
runtime, universal tool protocol, or product-owned workflow engine.
