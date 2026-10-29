# ADR 014: Run Telegram updates with bounded concurrency and drain on shutdown

**Status:** Accepted, 2026-10-15
**Scope:** GroupWeave Telegram consumer lifecycle

## Context

A single grammY long-poll handler can await an AI/native task for a long time.
If updates are consumed serially, the same user's later `/cancel` callback waits
behind that task and cannot cancel it. A shutdown that waits for polling before
aborting active application work can have the same deadlock shape.

## Decision

Use the pinned official `@grammyjs/runner` package (`2.0.3`) with concurrency
four. Keep the existing grammY bot, update handlers, and `Store`/actions as the
business authorization path. Runner concurrency only permits independent
updates to be dispatched; it does not authorize an actor, group, feature, task,
audience, or delivery.

Keep the existing compare-and-swap rules activation and AI-consent checks.
Cancellation remains bound to the current Telegram actor and group. Fastify's
`preClose` hook stops admission and disposes active execution backends before
awaiting this consumer's runner drain; the `onClose` hook closes the Store only
after that pre-close work completes. Do not detach handlers or add a local
update queue.

Telegram delivery remains at-least-once across the application/network
boundary. The application claims delivery before sending; a failed or unknown
send is not blindly retried. The runner does not turn this into exactly-once
delivery or durable update processing.

## Consequences

- A cancel callback can reach the existing handler while a different update is
  awaiting native work.
- Store/action authorization, feature rechecks, task ownership, CAS, and
  audience checks remain authoritative.
- Shutdown uses `preClose` for admission stop, execution disposal, and runner
  drain; `onClose` then invalidates sessions and closes the Store.
- There is no new persistent queue, replay store, or product runtime.

## Verification boundary

The local regression test holds a real grammY polling update in a controlled
long-running handler, verifies that serial consumption starves a later cancel,
then verifies the official runner path processes it and drains on shutdown.
Local GroupWeave verification was 252 tests: 241 passed, 11 skipped, 0 failed;
the skips are the existing anti-ad environment-dependent tests. This ADR does
not claim live Telegram cancellation or AI acceptance. A private acceptance fixture exercised bounded real-Bot-API phases with a
synthetic model endpoint; the fixture itself and its raw receipts are omitted
from this public copy. Each phase remains distinct evidence and must be reported
independently before making a live claim.

## 2026-10-16 actual Telegram follow-up

The same application image `753a191…4439` passed the real Telegram/native DSH
synthetic success phase (40 checks) and, in a separate fresh app container, the
cancel-button phase (43 checks). The latter observed the model request while
native work was still running, then accepted one current user's cancellation,
observed native/client abort, persisted a blocked task with empty output and
withheld late summary delivery. Both used one authorized tester and a synthetic
endpoint, not a paid provider. See [dated acceptance](ACCEPTANCE-20261016.md).

Earlier cancel attempts inherited a 30-second per-command fixture deadline;
the native command had ended by the time the button was clicked. The corrected
acceptance fixture uses a 120-second command limit inside a 180-second total
and asserts active work before inviting the click. This changed the acceptance
budget only. It did not weaken callback signatures, tenant/user checks,
confirmation expiry, replay protection or the production shutdown sequence.
