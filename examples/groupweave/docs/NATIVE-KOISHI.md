# Native Koishi

The native entry uses Koishi's ordinary Loader, official Telegram polling
adapter, HTTP service and SQLite plugin. It keeps identity, group permissions,
confirmation, persistence and delivery in GroupWeave. Do not run the legacy
GrammY receiver or another instance with the same Telegram token alongside it.

## Run locally

Use a complete repository checkout and Node.js 26.13.0. From the repository
root, install the bridge before the example's local `file:../..` dependency:

```sh
npm ci
cd examples/groupweave
npm ci
npm run build
cp .env.koishi.example .env.local
chmod 600 .env.local
# Choose ONE source for the same ordinary YAML destination:
cp koishi.yml koishi.personal.yml
# Or: cp examples/native/koishi-minimal.yml koishi.personal.yml
KOISHI_CONFIG=koishi.personal.yml npm run start:koishi
```

The default preset includes RSS and schedule. The minimal preset keeps HTTP,
SQLite, Help, Echo and optional Telegram. Both retain the same business
commands. The configuration is ordinary YAML, with no import/conversion step or
merging. Keep a local copied YAML in the example root so package lookup and
`.env.local` stay in the same scope. Credentials belong in the private
environment/provider file, not YAML.

The template defaults to Telegram/AI/media/render/site-parser off, loopback
host and port 4318. With `PUBLIC_ORIGIN` empty, the local health URL is
`http://127.0.0.1:4318/api/health`. There is no demo login in the native entry.
The browser management UI requires a real Telegram Mini App launch and valid
`initData`; localhost does not create an authenticated session.

Set `ENABLE_TELEGRAM=1`, `TELEGRAM_BOT_TOKEN` and numeric platform administrator
`TELEGRAM_ADMIN_IDS` only for an intentionally connected bot. Group
registration and member-role verification need the bot to be a group admin.
Use a separate test bot/group when testing that boundary.

### Optional Node.js environment proxy

Node.js 26 supports `NODE_USE_ENV_PROXY`, `HTTP_PROXY`, `HTTPS_PROXY` and
`NO_PROXY`. Export them before starting the local process; Loader's later
`.env.local` read is too late for Node startup settings. Compose forwards them
from its private `--env-file` and defaults to disabled/empty. Keep proxy URLs
and credentials private. The old Cordis proxy-agent integration is not used;
its undici dispatcher conflicts with Node 26's built-in fetch. This setting
does not route every HTTP client: site-parser Axios requests disable proxying,
and media uses its pinned HTTPS download boundary.

## Native commands and scope

`/help` and `/echo` are upstream Koishi commands. `/register`, `/settings`,
`/plugins`, `/rules`, `/applyrules`, subscriptions and reminders operate on a
registered group under current permissions. Rule changes are reviewed
proposals; cancellation and rollback previews do not silently activate a
change. See [rules](M1-M4-USAGE.md) and [utilities](NATIVE-UTILITIES.md).

Authorized AI supports `/ask`, `/digest`, `/translate`, `/brief` and explicit
mention/reply handling. `/tasks`, `/task <id>` and `/cancel` are caller-scoped
in the current group or private chat. `/models` lists only administrator
bindings; `/model <id>` selects an allowed binding, never a user endpoint/key.
`/newchat` and `/reset` clear the caller's current bounded conversation while
retaining task history. Context is bound to the current actor, chat and
audience; an audience switch starts empty context. Translation, digest and
rule interpretation do not inherit ordinary assistant history. Every task
still creates a fresh Docker sandbox; conversations do not reuse its HOME.

File commands operate on the caller's input and available current/quoted
attachments; they do not browse host files or old chat history. Successful
Sandbox AI can return the fixed bounded `result.md` file downloaded from its
sandbox before cleanup. Its bytes are transient; SQLite stores only artifact
metadata. Current recipient authorization and Telegram delivery receipts are
separate from Harness completion. See [AI and files](NATIVE-AI-FILES.md).

Media, image/PDF conversion, Markdown rendering and manual site parsing remain
explicit optional host features. See [images](NATIVE-IMAGES.md) and
[site parser](NATIVE-SITE-PARSER.md). Installed upstream functionality is
reused; a representative accepted path does not establish every platform,
codec, plugin or provider combination.

## Persistent configuration and plugin maintenance

`DATA_DIR` holds `groupweave.sqlite` (schema 4: group/business state, tasks,
model choices and bounded conversations), `koishi.db` (native Koishi data),
and `plugins/` (managed Loader YAML, npm manifest/lockfile, installed packages
and npm cache). They share one trusted application boundary; same-process
plugins can access it. Preserve the whole directory/Compose volume.

On first startup the selected seed YAML is copied once to
`DATA_DIR/plugins/koishi.yml`. Subsequent starts use the managed file and do
not overwrite online changes from the seed. Selecting the minimal preset on
an existing data volume therefore does not reset its plugins. Review the
managed configuration explicitly if changing an existing deployment.

Platform administrators can use the authenticated management page/API to
install an exact npm plugin version and enable/disable its ordinary Loader
configuration. Requests use the existing platform session and CSRF checks;
this is Koishi's native Installer service, without a separate Console login
or server. Installs use the writable `plugins/` directory, `ignore-scripts`
and omitted peer installation. There is one maintenance mutation at a time.
New dependencies can require a restart, particularly when replacing an
already-loaded built-in package. Check the restart-required signal and
installation/load failure before claiming the plugin is active.

Review package compatibility, configuration, network use and delivery scope
before installation. Lifecycle-script-dependent packages need an explicit
image-maintenance path. Plugins execute as trusted application code; there is
no untrusted-plugin sandbox or new package runtime. Keep required `http`,
`database-sqlite`, `help` and `echo` entries. Installed plugin availability is
separate from platform/group business-feature authorization.

Offline image maintenance remains supported: update an exact dependency and
lockfile, review the ordinary YAML, then build/deploy the image. Avoid changing
the seed YAML while assuming it will overwrite an existing managed file.
Restart retains configuration and history. Interrupted pending/running tasks
are marked blocked with unknown prior execution, without automatic replay.

## Docker Compose

Follow [checkout setup](REPOSITORY-SETUP.md#compose) from the repository root.
Set the private environment file's `PUBLIC_ORIGIN` to the exact HTTPS origin
served by your existing proxy. Set `KOISHI_CONFIG_PATH=./koishi.personal.yml`
to use either copied preset; Compose mounts it read-only at `/app/koishi.yml`
and preserves managed changes in the data volume. Missing bind sources fail.

```sh
docker compose -p groupweave --env-file examples/groupweave/.env.local \
  -f examples/groupweave/compose.yaml \
  -f examples/groupweave/compose.koishi.yaml config --quiet
docker compose -p groupweave --env-file examples/groupweave/.env.local \
  -f examples/groupweave/compose.yaml \
  -f examples/groupweave/compose.koishi.yaml up -d --build
# Replace this Host with the exact host[:port] from PUBLIC_ORIGIN:
curl --fail -H 'Host: bot.example.com' http://127.0.0.1:4318/api/health
```

Base Compose exposes only loopback. Native mode is not the legacy preview even
though both use the same application image. For a separate preview use a
separate project/volume. An exact public Host header is required when
`PUBLIC_ORIGIN` is set; a local health probe with a different Host is rejected.
The public page still does not grant a management session.

Add `compose.koishi.render.yaml` for sandboxed Chromium, 768 MiB and 256 PIDs.
It preserves `no-new-privileges` and the reviewed user-namespace seccomp
profile; no `--no-sandbox` escape is provided. Browser cache/config live in
writable tmpfs. A host lacking the required namespace support must leave
rendering disabled or report that deployment gap.

### Docker AI prerequisites

`compose.koishi.sub2api.yaml` is a **Linux host-network** overlay for an
already installed OpenShell **0.1.3** gateway and Docker driver. It does not
start those services, issue certificates, create credentials or install a
second sandbox backend. It installs the host OpenSSH client and mounts only
the reviewed Linux native CLI, private provider JSON and client mTLS bundle.
Do not mount the Docker socket or a user's HOME into the Bot/workload.

Before enabling it:

1. Build/import the [DSH workload image](../deploy/dsh/README.md) into the
   Docker image store actually used by the existing driver, on its matching
   architecture. Record its immutable image ID and Node/DSH versions. The
   current recipe pins Node 26.13.0 and DSH 0.2.0-rc.2 and includes the required
   fixed result exporter. An older image without that exporter fails closed.
2. Configure the native gateway's TLS/mTLS user authentication, matching
   Docker-driver CA/HTTPS settings and supervisor JWT support. Keep it on
   loopback. Validate protected RPC denial without a certificate as well as
   success with the trusted client; public health alone is insufficient.
   Follow the [binding's native mTLS instructions](../integrations/sub2api-openshell/README.md#native-gateway-authentication-openshell-013).
3. Prepare protected provider JSON using the binding's exact fields. It
   contains the fixed model, real upstream credential, immutable workload
   image, loopback meter port and HTTPS gateway URL. Set `gatewayTls` paths
   to `/run/groupweave/openshell/ca.crt`, `tls.crt`, `tls.key` respectively.
   The CLI files must be regular non-symlink files, owned by root or the Bot
   UID, mode 0600 or stricter **and readable by the Bot UID**. For the default
   image that UID is 1000. Mount only the CA certificate plus client
   certificate/key; never include the CA signing key, server key or gateway
   JWT signing key. Keep the source bundle outside task-cleanup roots.
4. Set `OPENSHELL_CLI_PATH`, `GROUPWEAVE_MODEL_CONFIG_PATH` and
   `OPENSHELL_CLIENT_BUNDLE_PATH` to their reviewed host sources in the private
   Compose env file. `PUBLIC_ORIGIN` still describes the management UI. Keep
   the provider JSON and parent directories protected; make the file readable
   by UID 1000 without making it public. Local Node instead exports its own
   absolute `GROUPWEAVE_MODEL_CONFIG` path. The shipped `deployment.mjs`
   wrapper is the trusted module, not a value generated from user input.
5. Ensure the existing driver's `host.openshell.internal:<meterPort>` route
   reaches the Bot's loopback admission listener in that Linux network context.
   The sandbox can reach only the fixed admission route; the real upstream
   key stays in the trusted host. Do not publicly expose the meter port or
   weaken authentication to make a probe pass. A free UI port alone does not
   establish this route.

Append `-f examples/groupweave/compose.koishi.sub2api.yaml` after the base and
native files (and after render when used), then inspect `config --quiet`
before `up -d --build`. This overlay resets container port publishing and
binds the UI to host loopback. Proxy it through the existing HTTPS service.
Use the trusted native CLI identity to list owned sandboxes and task
providers/profiles before maintenance; drain active work and verify cleanup.
Never delete another workspace's resources or restart other host services as
part of this recipe. A missing gateway, credentials, driver image or callback
route is a deployment gap, not an invitation to fall back to host execution.

## Upgrade and recovery

See the [preservation and rollback procedure](REPOSITORY-SETUP.md#upgrade-preserve-and-roll-back).
Keep schema 4, both databases and `plugins/` across upgrades; record immutable
container/image IDs and inspect logs by the captured ID. Health, submission,
model completion and Telegram delivery are distinct evidence. A failed health
probe does not authorize replacing current data with a stale database.
