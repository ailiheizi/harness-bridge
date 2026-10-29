# Telegram AI cancellation acceptance — 2026-10-16

This page records the current local and real-transport evidence for the
Telegram update runner and the synthetic-AI digest flow. Real Telegram input
and Bot API replies were used; the model endpoint and accounting were
synthetic. The historical command and storage runs remain separately scoped in
[the 2026-10-15 matrix](ACCEPTANCE-20261015.md).

## Current evidence

- **Local suite:** 244 passed, 11 skipped, 0 failed. The skips are the
  environment-dependent anti-ad tests. This includes the Telegram runner
  concurrency/cancellation regression and shutdown-drain coverage.
- **Runner and shutdown:** GroupWeave uses the pinned official
  `@grammyjs/runner` 2.0.3 with concurrency 4. The runner dispatches updates;
  Store/actions continue to enforce actor, group, task, feature, and audience
  authorization. Fastify `preClose` stops Telegram admission, disposes active
  execution backends, then awaits runner drain; `onClose` closes the Store.
  A delivery claim precedes the network call; an unknown network outcome
  is retained without automatic retry. See [ADR 014](ADR-014-TELEGRAM-RUNNER.md).
- **Real Telegram + synthetic native-AI success:** 40/40 checks passed on app
  image `[private digest omitted]`.
  A single authorized tester in one dedicated group registered the group,
  enabled the digest rule through its real confirmation button, submitted the
  digest, and confirmed the consent prompt. The app made one native
  OpenShell/DSH execution; its bounded synthetic endpoint accepted one model
  request, one synthetic meter receipt was recorded, one succeeded task was
  persisted, and the group received the result. Exit 0, no OOM. See the
  sanitized success receipt（私人历史证据未随公开案例发布）.
- **Real Telegram cancellation during held synthetic response:** 43/43 checks
  passed on the same app image. After the real consent callback, the fixture
  held the accepted synthetic model response while confirming the native exec
  was still active. The tester clicked the actual cancel button; the handler
  acknowledged cancellation of one active task, the client request and native
  exec aborted, the persisted task was `blocked` with empty output, and no late
  summary was delivered. One native request/admission was observed; the
  cancellation phase correctly has no success-path meter receipt. Exit 0, no
  OOM. See the sanitized cancellation receipt（私人历史证据未随公开案例发布）.

Both phases used one real tester and one dedicated group. They validate the
Telegram consent/cancel path against a synthetic model endpoint without paid
provider use. The fixture's 120-second command budget is test configuration;
the app's production timeout and authorization policy were not relaxed. Earlier
cancellation attempts remain useful failure evidence but are superseded by the
passing receipt for the corrected fixture.

## Boundaries still open

- A real model provider, production credential broker, hard budget, and
  trusted production usage meter remain unconfigured and unverified. AI stays
  disabled by default.
- This does not verify `/brief` or `/ask` with a real provider, model quality,
  paid usage, or production billing.
- Multi-user and multi-group real Telegram isolation, role changes during a
  live request, and Mini App HTTPS/`initData` remain unverified.
- The 37-check two-group persistence run belongs to the earlier
  `[private digest omitted]`
  image. It is historical evidence and is not upgraded by these single-group
  AI runs. Synthetic storage/backup acceptance and the earlier Telegram
  command slice are also recorded separately in the
  [2026-10-15 matrix](ACCEPTANCE-20261015.md).
