# Repository checkout setup

Use Node.js 26.13.0 (the container recipes pin that version and image digest)
and a complete repository checkout. The example consumes Harness Bridge through
`file:../..`; copying only `examples/groupweave` is insufficient.

```sh
# From the repository root
npm ci
cd examples/groupweave
npm ci
npm run build
cp .env.koishi.example .env.local
chmod 600 .env.local
```

Review `.env.local` before enabling external features. Its defaults keep
Telegram, AI, rendering, media and site parsing off. The native entry has no
demo login; a successful local health request does not authenticate the browser
management UI. See [Native Koishi](NATIVE-KOISHI.md).

Choose one ordinary YAML as the initial configuration. Both choices use the
same copy-and-select procedure, with no conversion or merging:

```sh
# Choose ONE source, keeping the shared presets unchanged:
cp koishi.yml koishi.personal.yml
# Or: cp examples/native/koishi-minimal.yml koishi.personal.yml
KOISHI_CONFIG=koishi.personal.yml npm run start:koishi
```

Local Koishi loads `.env.local` beside the selected YAML. Keep that YAML in the
example root. Variables needed before Loader initialization (including
`KOISHI_CONFIG`, Node proxy settings and the deployment module's
`GROUPWEAVE_MODEL_CONFIG`) must be exported in the invoking shell. With the
safe defaults, check `http://127.0.0.1:4318/api/health`; stop with Ctrl-C.

On first startup, the selected YAML seeds `DATA_DIR/plugins/koishi.yml`. Later
restarts use that managed YAML, preserving reviewed online plugin changes;
selecting another preset does not overwrite it. On an existing deployment,
review and edit the managed YAML or use authenticated platform plugin
maintenance. Do not delete the data directory to switch presets.

## Compose

Run these commands from the repository root. The AI overlay uses Compose's
native `!reset` tag; validate with the same Compose binary used to deploy.
Docker Desktop may run the
preview/native AI-disabled paths; the provided host-network AI overlay targets
an existing compatible **Linux** OpenShell host.

For a local legacy preview with a separate data volume:

```sh
docker compose -p groupweave-preview -f examples/groupweave/compose.yaml up --build
```

For the native receiver, set `PUBLIC_ORIGIN` in the private `.env.local` to the
exact HTTPS origin served by your reverse proxy. Set `KOISHI_CONFIG_PATH` to
`./koishi.personal.yml` to select the copied default or minimal YAML above.
Host paths in Compose are relative to `examples/groupweave`; the mounted YAML
stays at `/app/koishi.yml`. Missing bind files fail instead of becoming empty
directories. Native startup keeps Telegram off until explicitly enabled.

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

The Dockerfile builds from the repository root, installs both lockfiles, and
retains the bridge at `/repo` and the app at `/repo/examples/groupweave` (`/app`
is a compatibility symlink). Keep the Compose project name stable across
upgrades so the same named data volume is reused. Do not run a preview and a
native receiver against the same data volume or use one Telegram token in two
receivers.

Add `compose.koishi.render.yaml` after those two files to enable the reviewed
Chromium sandbox profile and its resource limits. Rendering also needs a host
kernel that supports the browser's user namespaces. Installing Chromium alone
does not establish launch readiness; the native entry checks it at startup.

For AI, first prepare the external gateway/driver, native mTLS bundle,
immutable DSH image and private provider JSON as described in
[Native Koishi](NATIVE-KOISHI.md#docker-ai-prerequisites). Add
`compose.koishi.sub2api.yaml` last. It does not provision OpenShell or issue
certificates. A model API key alone is insufficient.

To expose additional approved model IDs, optionally append
`compose.koishi.profiles.yaml` and set its protected host directory as described
in [model profiles](M1-M4-USAGE.md#会话任务与模型). This reuses the existing loader;
the default configuration still exposes only its configured default binding.

## Upgrade, preserve and roll back

Before upgrading, record the exact image IDs, reviewed YAML, Compose project
name, private environment/provider paths, mTLS bundle and current schema.
Drain owned active tasks and confirm native cleanup before stopping this
receiver. Use its authenticated platform backup for a bounded online SQLite
backup, or stop only the owned Compose service and archive the **entire** named
`groupweave-data` volume using your existing backup tooling. A stopped-volume
backup must include both SQLite databases and any WAL/SHM files, plus
`plugins/` (managed YAML, manifest, lockfile, installed packages and npm cache).
Protect backups as credentials and personal data. Verify backup integrity
before using it for recovery. Never run `down -v` or prune the data volume as an
upgrade step.

Build/pull the candidate before stopping the receiver. Recreate it with the
same volume and reviewed settings, then check native health, expected Telegram
connection (when enabled), plugin maintenance, and the current schema. The
current GroupWeave database is **schema 4**; configuration, task history,
model choices and bounded conversations survive restart. Unfinished tasks are
marked interrupted/blocked and are not replayed automatically.

A code rollback normally changes only the image/configuration and preserves
current data, including `plugins/`. First check that the older binary accepts
the current schema and plugin dependencies. A schema-3-only binary cannot
consume schema 4: choose a compatible image or plan an explicit reviewed data
restore. Do **not** automatically copy a pre-upgrade database over live data
after a failed health check; it can discard tasks and configuration written
since deployment. A full data restore is a separate, coordinated recovery
operation with its own loss window. Retain the failed candidate's private
logs and immutable container/image IDs before replacing it.
