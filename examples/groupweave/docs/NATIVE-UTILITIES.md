# Native RSS, reminders, and welcome messages

This guide covers the optional utilities in the native Koishi entry. They use
the upstream Koishi RSS and schedule plugins for their storage and lifecycle.
The existing GroupWeave welcome feature uses the current Telegram join event
and the group's plain-text template. These utilities do not add AI processing.

## RSS subscriptions

The native YAML loads `koishi-plugin-rss` 3.0.1. A current administrator of a
registered Telegram group can manage that group's subscriptions in the main
group conversation:

```text
/rss <feed-url>          Subscribe this group to a feed
/rss -l                  List this group's subscribed feed URLs
/rss -r <feed-url>       Remove a feed from this group
```

The group chooses and adds each feed explicitly; startup does not create a
default subscription. The upstream feed emitter skips its first load, so
existing feed entries are not broadcast as a backlog when a feed is first
subscribed or restored after restart. New feed items are sent by the upstream
plugin to subscribed channels. Its message contains the feed title, optional
author, item title, and item URL when it is a validated HTTP(S) URL. Feed
strings are sent as plain text; article bodies are not fetched. This does not
provide full-text ingestion or AI summarization.

RSS commands require a registered group, a current group administrator, and
the main group conversation. Private chats and Telegram topics are rejected.
The per-group feed list is stored by the upstream plugin in Koishi's database.

A public-source example is Node.js release updates:
`/rss https://github.com/nodejs/node/releases.atom`. This is an optional URL
example, not an automatic subscription. In the 2026-10-26 AyuGram test, adding
this public source and listing it succeeded, but no new public-source item was
observed during the test; this does not verify ongoing public feed delivery.

### Real Telegram acceptance (2026-10-26)

The official Koishi host ran in local Docker with a dedicated test bot and the
existing A/B test groups. A first real add returned success and the feed
poller delivered version 1, while `/rss -l` incorrectly reported an empty
list. The defect was fixed in the RSS integration: Telegram's
`interaction/command` executes directly and skips the ordinary message
middleware's final observed-channel flush. The RSS action had updated
`channel.rss` in memory, while the feed poller had already subscribed. The
integration now awaits `session.channel.$update()` after the upstream action.
The regression test no longer performs its former manual flush; it failed
before the fix and passed afterward.

After the fix, A and B each added and listed a different loopback temporary
feed, and each received its own version 1 update. B could not cancel A's feed.
After container recreation, both lists recovered and each group received its
own version 2 update, with no cross-group items. This is real upstream polling
and Telegram delivery against a local controlled feed; it does not establish
public feed update delivery or production stability.

## Reminders

The native entry loads `koishi-plugin-schedule` 5.0.1 and adds the
GroupWeave `/remind` command as its group-admin interface. The upstream plugin
owns persisted schedules and timers; reminder delivery sends the saved content
as plain text in the originating group.

```text
/remind 2026-11-03 09:30 Bring the signed form
/remind 09:30 Stand-up begins
/remind daily 09:30 Check the dashboard
/remind every 10m Check the build
/remind links every 1h https://example.com/release
/remind list
/remind remove 12
/remind pause 12
/remind resume 12
/remind edit 12 2026-11-03 09:30 Bring the signed form
/remind edit 12 daily 09:30 Check the dashboard
/remind edit 12 every 2h Check the build
```

The first two forms create one-time reminders at a future date and time or at
a future time today. `daily` repeats at that local time each
day. `every` accepts Koishi intervals such as `10m`, `2h`, or `1d`. The preset
sets the upstream minimum repeat interval to 60 seconds. Reminder dates and
times use the process timezone; the supplied environment and Compose examples
set `TZ=Asia/Shanghai`.

Only a current administrator of a registered group can create, list, remove,
pause, resume, or edit reminders, and commands work only in the main group conversation. The
list is scoped to the current bot and group. Any current administrator of that
group can remove or edit a reminder; its numeric ID is shown in the schedule
plugin's creation response and list. An edit creates a replacement through
the upstream schedule command, then deletes the old row through that same
command; the replacement has a new ID. Invalid or rejected replacements leave
the old row intact. To keep the brief create/delete handoff away from delivery,
editing is refused when either schedule's next trigger is within 60 seconds.
If native deletion fails after creation, the adapter attempts to remove the
replacement and reports its ID if it cannot confirm rollback. Private chats
and topics are rejected. Reminder text is limited to 3,000 characters and is
delivered as text, not interpreted as a command.

Pausing removes the active row through the native scheduler and stores its
schedule details in a small adapter-owned table in the same Koishi database.
This record survives restart; resuming recreates the native schedule with a
new ID, then removes the paused record. A one-time reminder that is past or within 60 seconds cannot
be resumed; create a new reminder at a future time. A resumed recurring
reminder continues at its next future interval without a catch-up send. The
native scheduler still owns active timers and delivery.

`/remind links <time rule> <text>` schedules only the existing group
`link-cleaner` capability. For example, `/remind links daily 09:30
https://example.com/release`. At delivery, the adapter rechecks current group
admin access and that the group still has link-cleaner enabled, then runs the
normal binding and single-delivery authorization path. It cannot schedule
arbitrary commands, shell, or AI work. If access or the feature has been
removed, that occurrence is withheld. Removal or pausing can race an occurrence
that already passed the upstream scheduler's final existence check; the pause
response states that the in-flight occurrence may still arrive.

Removing a reminder prevents later scheduled occurrences after the upstream
delete takes effect. A delivery that already passed the scheduler's final
existence check may still be sent; the remove response states this boundary.
Commands addressed with `/remind@username` must name the current Telegram bot.

### Real Telegram acceptance (2026-10-26)

In a representative local Docker/Telegram test, a one-time reminder arrived; its list
was empty afterward. Future reminders ID 2 in A and ID 3 in B remained in only
their respective lists after container recreation. B could not remove A's ID
2. A representative interval reminder delivered as scheduled, was removed, and was absent after a second container
recreation. These observations cover the listed real TG flows, not long-term
availability. The test schedules were removed and both group lists were empty.

## Welcome messages

Welcome has two separate switches. A platform administrator first enables the
existing welcome capability in the GroupWeave management UI. A group
administrator then previews and confirms a group rule, for example:

```text
/rules 开启欢迎
/applyrules <提案ID>
```

The group's welcome text is edited through the existing management UI's
welcome text field. It supports `{name}` for the display names in the current
join event and `{group}` for the current group title. An empty field uses the
default template for the group's language. Substitutions are plain text; they
are not commands, markup, or AI instructions. Bot accounts in a join event
are ignored. The integration does not read prior messages or invent bot names.

If the platform capability is disabled, a group rule cannot enable it by
itself. Group settings do not install or modify platform plugins.

## Configuration and persistence

The native entry reads environment references from the selected Koishi YAML;
keep the Telegram token in `.env.local`, not in YAML or documentation. Set
`ENABLE_TELEGRAM=1`, `TELEGRAM_BOT_TOKEN`, and numeric
`TELEGRAM_ADMIN_IDS` values to connect the Telegram adapter. The checked-in
example defaults Telegram off. Keep `DATA_DIR` on the persistent data volume.

The deployment keeps two SQLite files in that same persistent directory:
`koishi.db` stores upstream RSS subscriptions and reminder schedules;
`groupweave.sqlite` stores GroupWeave groups, feature settings, welcome
templates, tasks, and delivery records. The files have separate owners and
schemas. Preserve both across container replacement. RSS subscriptions and
reminders rely on Koishi's database and loaded plugins.

The installed plugin set comes from `koishi.yml`. If RSS or schedule is removed
from that YAML, its upstream command is unavailable after restart. The native
entry has no Koishi Console or new plugin-management screen; edit the YAML and
restart to change the loaded plugins. Credentials remain environment-backed.

The versioned RSS dependency patch is applied by the existing postinstall
step. It fixes first-load update suppression and cleanup of deduplication
timeouts; details are in [the dependency patch notes](../patches/README.md).

## Upstream behavior

- [Koishi schedule package](https://github.com/koishijs/common/tree/master/packages/schedule)
- [Koishi RSS plugin](https://github.com/koishijs/koishi-plugin-rss)

The real Telegram client evidence above used a local Docker host and a dedicated test
groups. It is not production or long-term stability evidence. Public-source
addition/listing succeeded, but a new public item was not observed. All subscriptions and reminders created in this run were removed through TG,
and both groups returned empty lists. After a controlled feed update to version
3, no new HTTP polling occurred during a 101.46-second observation (the configured
interval was 60 seconds). The temporary feed process was then stopped. The test
receiver and persistent data volume remain available for reuse.
