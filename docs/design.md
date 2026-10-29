# Design

Harness Bridge is a small JavaScript binding used by a trusted host application
to submit a bounded task to an existing Harness in a fresh isolated
environment. This repository's primary end-to-end example is
[GroupWeave](../examples/groupweave/README.md), a Telegram Bot application that
uses Koishi for approved code features and an existing DSH Agent for explicit
AI tasks. The bridge API remains callable on its own; the full bot case gives
the binding its actual application context.

```text
Telegram / management Mini App
              ↓
GroupWeave host: identity, group scope, confirmation, storage, delivery
        ┌─────┴─────────────────────────────┐
        ↓                                   ↓
Koishi / approved code               Harness Bridge
        │                                   ↓
        │                            OpenShell + Docker
        │                                   ↓
        │                              DSH Agent + Skill
        └──────────── scoped results ──────→ Host delivery
```

The application remains the product and authority. OpenShell owns sandbox
lifecycle and isolation; DSH owns its Agent behavior; this package binds the
host task to those existing contracts. Portable integration ideas do not make
this concrete binding a universal Harness protocol.

## Host and library responsibilities

GroupWeave resolves authenticated task, tenant, actor, feature, audience and
authorization versions from application state. It owns current permissions,
task persistence, admission/capacity policy, accounting evidence, business data
access and Telegram delivery. Prompt text cannot supply or override those
facts.

The library exposes `createHarnessBridge(options).execute(request, signal?)`.
Required callbacks admit the task, authorize business-scoped native calls and
authorize result release. These are host policy seams: they do not grant tools
to DSH or replace checks at the business API performing an operation.
GroupWeave's adapter binds its group/private scope and task to this API in
[`sandbox-ai.ts`](../examples/groupweave/src/server/sandbox-ai.ts).

## What the binding does

For each execution the bridge snapshots standard request fields, checks
admission, creates one named OpenShell sandbox through its fixed CLI call,
checks native identity, optionally uploads one ordinary `SKILL.md`, uploads a
host-prepared DSH patch, and submits a fixed DSH headless command with prompt
text on stdin. It parses the native event stream and performs bounded stop,
delete and absence checks. It returns bounded text plus execution and cleanup
evidence. It currently has no sandbox file download or artifact-return API.

Limits default to a 120-second total deadline, 20-second native command limit,
and 256 KiB native output bound. Cleanup has a separate bounded 60-second
window. These are bridge process limits, not a global resource or cost budget.
The create invocation requests 500m CPU and 512 MiB memory; target policy and
the native driver remain part of the actual isolation boundary.

## Outcomes and evidence

`completed` means the expected DSH completion event, final text, session ID,
and zero native exit status were observed, and the bridge verified its cleanup
condition. It does not mean the host accepted the result or Telegram delivered
it. `failed` reports execution or authorization failure; `blocked` includes
uncertain cleanup or denied result release. A failed or blocked result may
still contain a native sandbox identity for the host's own operations record.

The library reports `modelRequestCount: null`: the DSH event stream does not
provide trusted per-task model usage. `toolCallCount` counts parsed DSH tool
call events only. Neither proves model usage or billing. GroupWeave may use an
external trusted usage receipt bound to its task and sandbox. Its latest
acceptance record reports specific real AI deliveries; those receipts do not
generalize to other requests or prove a cost/accounting model beyond the named
evidence.

## Current scope and limits

This binding targets OpenShell CLI v0.1.3 behavior and
`@deepseek-ai/dsh@0.2.0-rc.2`. Other versions or Harnesses need their own
contract and validation. OpenShell + Docker is the only isolation path.

The API does not provide durable tasks, cross-process scheduling, provider
routing, hard model budgets, accounting, business tools or platform delivery.
The [GroupWeave example](../examples/groupweave/README.md) supplies a real host
case with those application responsibilities. Known gaps include online
Console plugin installation and AI sandbox artifact return; see the example's
[TODO](../examples/groupweave/docs/TODO.md) and
[acceptance record](../examples/groupweave/docs/ACCEPTANCE-20261022-NATIVE.md).
The smaller [Koishi example](../examples/koishi/README.md) remains a focused
consumer of the library. See [architecture](architecture.md),
[quickstart](QUICKSTART.md), [validation](validation.md), and
[security notes](../SECURITY.md).
