# Minimal native Koishi preset

This ordinary Koishi YAML keeps the native host's required HTTP, SQLite, Help,
and Echo plugins. Telegram remains optional through the existing
`ENABLE_TELEGRAM` condition. RSS and schedule are omitted for deployments that
do not need feeds or reminders.

Copy it to the project root, then select that copy with the existing config
entrypoint:

```sh
cp examples/native/koishi-minimal.yml koishi-minimal.yml
KOISHI_CONFIG=koishi-minimal.yml npm run start:koishi
```

The host reads the selected YAML through Koishi's normal loader. Changes apply
after restart. The selected YAML must retain HTTP, SQLite, Help, and Echo;
startup checks those required host capabilities. `DATA_DIR` controls the
SQLite location, and the existing `ENABLE_TELEGRAM=0` default keeps the bot
disconnected. To connect a real bot, set `ENABLE_TELEGRAM=1` and provide
`TELEGRAM_BOT_TOKEN` and `TELEGRAM_ADMIN_IDS` through the private environment
file. This preset contains no credentials.

This is a full-host alternative to `koishi.yml`; it does not merge with the
root config or install packages. Copying it does not change the shared source
file.

## Maintaining installed plugins

Edit the selected YAML's `plugins:` map to enable or disable a package that is
already in the reviewed image, then restart `start:koishi`. To add a plugin,
review it and its configuration first, install an exact version into the
project with `npm install --save-exact <package>@<version>`, review both npm
manifest and lockfile changes, add its documented YAML entry, and rebuild the
image. Removing the YAML entry disables the plugin; removing the package also
requires updating dependencies and rebuilding. Keep the required `http`,
`database-sqlite`, `help`, and `echo` entries. This workflow has no Console or
hot reload, and installed plugins run as trusted same-process code.
