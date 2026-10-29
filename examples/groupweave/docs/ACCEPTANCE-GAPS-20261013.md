# Sandbox consumer acceptance gaps — 2026-10-13

This record adds consumer-level authorization checks around the existing
OpenShell-backed digest adapter. The tests use an in-process bridge and
synthetic identities, outputs, and accounting receipts; they do not start
OpenShell, Docker, Telegram, or a provider.

## Local checks run

The focused sandbox slice, including the new acceptance file, passed:

```sh
npm exec -- tsx --test tests/sandbox-acceptance.test.ts tests/sandbox-ai.test.ts tests/sandbox-wiring.test.ts tests/sandbox-actions.test.ts
```

Result: **21 passed, 0 failed, 0 skipped**. `npm run typecheck` also passed.

The four added tests establish these local behaviors:

- A valid task reservation resolves, while moving its task to another group,
  substituting another group admin or an existing group member as actor, or
  changing its audience is denied. A separate valid reservation in the second
  group is the positive control.
- Revoking the digest feature after native execution prevents result release
  and leaves the persisted task blocked with an empty output. A successful
  synthetic execution is the positive control.
- Caller cancellation followed by a late executor result leaves the task
  blocked with no persisted output.
- The actions path accepts exactly 64,000 UTF-8 output bytes and rejects
  64,001 bytes without persisting the oversized output.

These checks exercise the Store/actions authorization boundary with controlled
dependencies. They are not Docker isolation, native cleanup, production
identity, real-provider, accounting, or Telegram-delivery evidence.

## External gates still blocked or unverified

`docs/SANDBOX-AI.md` records that no production provider route currently
supplies both a hard pre-request one-call limit and an independently verifiable
usage receipt bound to the task, sandbox, and DSH session. The local accounting
reader in these tests is synthetic, so **production provider budget/accounting
remains BLOCKED**.

The same status document says there is no verified external credential route
showing that the provider key stays on the trusted side and is used by the DSH
workload. **Production credential delivery remains BLOCKED**; this acceptance
did not inspect credential files or contact a provider.

At the time this initial gap record was written, native application-container
CLI use and live Telegram delivery were **NOT RUN/UNVERIFIED**. A later
2026-10-13 run closed those two narrow gates; the dated update below and linked
reports supersede only those old statuses. The initial local test record above
remains historical and unchanged. The initial local audit did not perform
SSH, Docker, credential, or service-restart operations.

The next external evidence needed is a verified provider-side hard cap and
task/sandbox/session-bound meter receipt, plus a trusted credential-delivery
path. Local acceptance cannot substitute for either integration.

## Dated external-gate update, 2026-10-13

**Application-container native integration: PASS, scoped.** The actual
GroupWeave image
`[private digest omitted]`
passed 77/77 checks using a synthetic model context, running read-only as UID 1000
without a Docker socket at 512 MiB, one CPU, and 128 PIDs. After the image's
missing-SSH-client attempt failed closed and cleaned up, the optional
`ENABLE_OPENSHELL_CLIENT=1` image configuration passed the upload gate. The
complete flow took about 22.7 seconds; the checks include configuration,
permissions, and preconditions, not 77 separate attacks.
See the application-container report（私人历史证据未随公开案例发布）.

**Live Telegram transport and one test-group path: PASS, scoped.** Against the
same image and normal server entrypoint, actual Telegram `getMe`, HTTP health,
polling, private `/start`, group `/register`/`/help`, actual rules preview and
tester confirmation, and `/echo` passed 9/9. Each of the six incoming command
or callback steps had one real incoming update and one successful outgoing
receipt. It was a dedicated bot in one empty group containing only the tester
and bot, used no model request, and exited cleanly after 342,456 ms. It does
not establish Mini App login, other users' access, or cross-group isolation.
See the Telegram report（私人历史证据未随公开案例发布）.

**Still blocked or unverified:** production hard budget admission and
independent task/sandbox/session-bound metering remain BLOCKED; a trusted
provider credential broker and real-provider usage remain BLOCKED. Mini App
login and multi-user/cross-group live Telegram authorization remain NOT RUN.
The container and Telegram passes above do not change those gates.
