# Native Koishi

[`koishi.yml`](../koishi.yml) is a normal Koishi YAML config. It loads the
official Telegram adapter (long polling), HTTP service, SQLite database, Help,
and Echo plugins. `ENABLE_TELEGRAM=0` skips the Telegram adapter even if a token
is present. Set it to `1` only when intentionally connecting a real bot; startup
then requires `TELEGRAM_BOT_TOKEN` and at least one numeric
`TELEGRAM_ADMIN_IDS` value.

## Run locally

Install the pinned dependencies once, make a private environment file, and
start the native entry:

```sh
npm ci
cp .env.koishi.example .env.local
npm run build
npm run start:koishi
```

The template defaults to `ENABLE_TELEGRAM=0`, `HOST=127.0.0.1`, and port 4318.
With Telegram disabled, nothing polls Telegram. The native app runs with
preview mode off and has no synthetic/demo login. The browser management UI
requires a real Telegram Mini App launch with valid Telegram `initData`; local
localhost alone does not create an authenticated UI session.

To connect a real bot, set `ENABLE_TELEGRAM=1`, the bot token, and platform
admin user IDs in `.env.local`. The bot must be a Telegram group administrator
for `/register` and member-role verification. Test with a test bot and group.
Keep `.env.local` private.

### Optional Node.js environment proxy

The native host can use Node.js 26's built-in HTTP(S) proxy support when a
deployment requires an outbound proxy. It is off by default. Node reads
`NODE_USE_ENV_PROXY`, `HTTP_PROXY`, `HTTPS_PROXY`, and optionally `NO_PROXY`
when the process starts. For local `npm run start:koishi`, export them in the
invoking shell; setting them only in Koishi's later-loaded `.env.local` is too
late. With Compose, pass the private file through `--env-file .env.local`; the
override forwards the values and defaults to disabled/empty. Do not commit
proxy URLs or credentials.

The Koishi `@cordisjs/plugin-proxy-agent` integration is not used here: its
bundled undici 6 dispatcher is incompatible with Node 26's built-in fetch and
can fail with `InvalidArgumentError: invalid onError method`. Node's native
environment proxy avoids injecting that dispatcher. The 2026-10-26 live check
confirmed Telegram `getMe`, polling, and remote file transfers through the
configured native proxy. This does not route every HTTP client: the manual
`/parse` Axios requests explicitly disable proxying, and media downloads use
pinned HTTPS connections.

## Native commands and scope

In Telegram, `/help` and `/echo <text>` come from the official Koishi Help and
Echo plugins and also work in private chats. The custom business commands below
only process real group messages:

- `/register` lets a current group admin register that group after the bot is
  made an admin.
- `/settings` shows that registered group's current settings to its admin.
- `/plugins` lists that group's available features.
- `/status` shows the native bot connection state and whether the Docker AI route is configured.
- `/rules <rules>` previews a change; the proposal creator confirms it with
  `/applyrules <proposal-id>`.
- `/links <text>` runs the currently connected fixed link-cleanup capability.
- `/cancel` requests cancellation of the caller's active task in that group.

Private `/start` gives onboarding guidance and file commands. Private chats do not list groups,
read group data, or grant group access. `/fileinfo`, `/readfile`, and `/savefile`
process the caller's current input in private chats and registered groups.
The upstream `/help` command lists registered Koishi command names, and `/echo`
remains available in private chats; a private call to a GroupWeave group command
does not act on a group.

## Data and configuration

`DATA_DIR` defaults to `./data`. It contains two separate SQLite files:
`groupweave.sqlite` for GroupWeave groups, proposals, tasks, and audit records;
`koishi.db` for Koishi's own database. They have separate owners and are not
automatically isolated from each other. Restarting loads existing data; it does
not seed or import it.

The loaded YAML is read-only at runtime. Edit `koishi.yml` as ordinary YAML and
restart `start:koishi` to apply changes. This entry does not provide a Koishi
Console or hot-import plugin manager. The legacy `npm start` and `npm run dev`
commands still launch the older app: they default to preview mode, while
`APP_MODE=telegram` enables its legacy GrammY receiver. Do not run that receiver
alongside the native entry with the same Telegram token.

For a shared configuration, keep a separate copy in this project directory and
select it using the existing file entrypoint:

```sh
cp koishi.yml koishi.personal.yml
# Edit koishi.personal.yml locally, keeping credentials as env references.
KOISHI_CONFIG=koishi.personal.yml npm run start:koishi
```

The selected file is ordinary Koishi YAML, without merging or inheritance.
Its enabled npm packages must already be installed in this project's lockfile;
using a shared file does not install packages or supply credentials. Keep it in
the project directory so native package resolution and `.env.local` stay in
the same scope. AstrBot JSON profiles use another format and are not imported.

A ready-to-copy [minimal preset](../examples/native/README.md) keeps HTTP,
SQLite, Help, Echo and optional Telegram while omitting RSS and schedule.
Copy `examples/native/koishi-minimal.yml` to the project root, then select it
with `KOISHI_CONFIG=koishi-minimal.yml`. Both presets retain the same business
entrypoints; AI and media are controlled by their existing environment switches.

### Native plugin maintenance

The supported maintenance path is **reviewed package plus ordinary YAML plus
restart**. The repository already includes Koishi's official Loader and pins
plugin package versions in `package.json` / `package-lock.json`. To add another
trusted plugin, first check its compatibility, configuration schema, storage,
network access, and message-delivery scope. Add its exact package version with
`npm install --save-exact <package>@<version>`, review the package and lockfile
changes, then add its documented key and options under `plugins:` in a selected
Koishi YAML file. Build and deploy the updated image; the plugin becomes active
when the native entry restarts. To disable a plugin, remove its YAML entry and
restart. To remove its package too, remove it from dependencies and regenerate
the lockfile through npm, then rebuild. Keep required host plugins (`http`,
`database-sqlite`, `help`, and `echo`) in every selected configuration.

For an already-installed plugin, changing only its YAML entry does not require
installing packages. For example, the minimal preset omits RSS and schedule;
the full `koishi.yml` enables both. The `examples/native/README.md` recipe
shows how to copy and select the minimal preset. `KOISHI_CONFIG` selects one
complete YAML file; configurations do not merge. Credentials stay in the
private environment file, not YAML.

This is file-based maintenance, not a web Console or live hot-reload. It only
covers plugins deliberately included in the reviewed image; there is no
marketplace, arbitrary runtime npm install, or untrusted-plugin sandbox.
Plugins execute in the application process and must be treated as trusted code.
If AIL-28 requires browser-based plugin installation or online administration,
that remains an explicit unimplemented requirement; this file workflow does
not claim to satisfy it.

## Docker Compose

The native override uses the existing image and data volume. Set
`PUBLIC_ORIGIN` in `.env.local` to the exact public HTTPS origin without a path,
then run:

```sh
docker compose --env-file .env.local -f compose.yaml -f compose.koishi.yaml up -d --build
```

The base Compose file binds the container port to loopback; put a TLS reverse
proxy in front for remote access. The override inherits `HOST=0.0.0.0` inside
the container and requires `PUBLIC_ORIGIN` for the management API. The browser
UI still requires a Telegram Mini App launch and valid `initData`.

### deployment host HTTPS status (2026-10-27)

The existing deployment host serves `groupweave.example.invalid` through its
configured HTTPS reverse proxy. ACME DNS
validation issued and installed the certificate in reverse proxy's existing
certificate store; the local autocert configuration and route to
`127.0.0.1:<application-port>` were added, and HTTPS was validated without restarting the
reverse proxy container. The renewal hook writes the reverse proxy config and reloads
reverse proxy; it does not call a certificate-renewal API.

The Bot now uses `PUBLIC_ORIGIN=https://groupweave.example.invalid`. Its private-chat
menu opens the management Mini App. AyuGram authenticated the real Telegram
user and displayed registered acceptance group A with its existing v3 rules.
Public page/health return 200; `/api/me` without a session returns 401.
The application container was recreated for these changes; the shared reverse proxy
process was hot-reloaded. This verifies entry and login, not every management
workflow or the full M1/M2 milestones.

The preset also loads native RSS and schedule plugins; group administrators
can use the [utilities guide](NATIVE-UTILITIES.md) for subscriptions and
reminders. The native welcome event uses the existing platform/group switches.

The third batch adds group `/ask`, `/digest`, explicit mention/reply handling,
confirmation and long replies; `ENABLE_AI=1` requires an existing protected
`SANDBOX_AI_BINDING_MODULE`. The native host uses Docker/DSH exclusively for
these AI commands. Platform and group switches must also be enabled.
The fourth batch adds owner-scoped private AI with confirmation and cancellation.
Private scopes use `tg-dm:<user>` and never appear as groups. Single-turn AI still
needs the platform switch; it does not create or read conversation history.
The fifth batch adds `/translate <language> <text>` under assistant permission,
and group `/brief <text>`: existing link-cleanup code followed by one Docker
model request. `/brief` requires both link-cleaner and link-brief enabled; it
explains supplied text and URLs without fetching web pages.

Files work without AI. `ENABLE_MEDIA=1` loads the pinned upstream video-to-GIF
plugin and FFmpeg service in the native host. It uses `FFMPEG_PATH` / `FFPROBE_PATH`
or `ffmpeg` / `ffprobe` from PATH; the Compose override builds system FFmpeg into the same application
image. No runtime binary download is performed. The `/v2g` command supports
upload, quoted video, or direct video URL. Fixed `/convert mp4|mp3|m4a|small`,
`/clip`, `/mediainfo`, and `/cancelmedia` operate on current or quoted attachments.
The new cancellation command does not cancel upstream `/v2g`. Sandbox file
export remains unfinished. See [AI and files](NATIVE-AI-FILES.md) for usage,
known media limits, and the distinction between local evidence and real delivery.

The sixth batch adds fixed `/image jpg|png|webp [size] [quality]` and a caller-scoped
`/imgpdf start` → upload images → `/imgpdf done` flow, using Sharp and pdf-lib.
Optional `/mdimg` uses the upstream Markdown service and Puppeteer. It requires
`ENABLE_RENDER=1` and a working browser (`RENDER_BROWSER_PATH` may specify it).
Startup refuses to claim readiness if the browser/service failed. Chromium's
sandbox stays enabled. Local Docker Markdown startup and rendering passed on
2026-10-26 after the opt-in seccomp/user-namespace profile and 256 PID limit
were applied. Rendering remains disabled in the default Compose; see the
[Markdown deployment instructions](NATIVE-IMAGES.md). The deployment host native Bot
subsequently returned real Telegram images including code, KaTeX, and Mermaid.
Its render overlay uses 768 MiB and 256 PID after the combined workload exceeded
512 MiB. Real private ask/digest/translation and authorized group ask also passed;
see the eleventh native acceptance batch and `compose.koishi.sub2api.yaml`.

`/parse` is optional and manual-only. The direct mode uses the image's pinned
`yt-dlp` 2026.10.26 at `/opt/site-parser/bin/yt-dlp` when
`ENABLE_SITE_PARSER=1`; optional read-only Bilibili and Douyin cookie-file
bindings are separate. A remote parser API is an explicit alternative and is
selected only when both `SITE_PARSER_API_URL` and `SITE_PARSER_API_KEY` are
configured. No implicit public API or automatic group listener is enabled.
Real Bilibili/Douyin end-to-end results are still being tested; see
[site parser](NATIVE-SITE-PARSER.md).
