# Design

Harness Bridge is a small JavaScript library for an existing
application that needs to submit a bounded task to an existing Harness in a
fresh isolated environment. The current binding connects the application's
trusted task context to an OpenShell Docker sandbox and the DSH headless
Harness.

The idea is composition: the application remains the product and authority;
OpenShell owns sandbox lifecycle and isolation; DSH owns its Agent loop and
native Skill/tool behavior; this package connects those existing contracts.
The portable part is the integration method, not a promise that every Harness
or host can use this exact binding without adaptation.

## The original composition idea

Receiver, storage, Harness and CLI/API capabilities are separate responsibilities,
usually already available in a host or its dependencies. A receiver accepts a
message or event; storage holds application data and configuration; a Harness
uses Skills and tools; existing code, CLI or APIs carry out real operations.
The bridge is the small connection between a trusted host task and isolated
Harness execution, not a replacement for these systems.

Use ordinary Skill guidance where adaptation and reasoning help. Repeated,
predictable operations can stay in reviewed code, called through the existing
application or tools. There is no automatic Skill-to-code compiler, workflow
engine or measured cost advantage in this preview. Any promotion into trusted
code requires ordinary review, tests and explicit authority decisions.
Generated or untrusted code stays inside the isolated workload. The host fast
path is for approved deterministic code only.

An optional decision model such as JEV may help a host choose among approved
actions. The bridge neither implements that selector nor requires one. A
selector's output cannot enlarge permissions, mint a tenant identity or skip
verification. Keeping it application-owned preserves the binding's reuse
without introducing a mandatory decision engine.

The long-term reuse target includes bots, personal assistants and other
applications with an existing authenticated entrypoint. These are potential
consumers, not current end-to-end integrations. Telegram is a reference use
case, not a core runtime dependency.

## What the host keeps

The authenticated application creates task, tenant, and actor context. It
continues to own current business permissions, task persistence, admission or
capacity policy, business data access, trusted model accounting, and the
audience and delivery of results. A prompt cannot supply or override these
facts.

The bridge exposes three required host callbacks: admission, authorization of
business-scoped native calls, and authorization before result text is released
to the host. These are callback seams into host policy. They are not a general
authorization service, do not grant tools to DSH, and do not replace checks at
the business API that performs an operation. Owned cleanup uses the native
controller path and identity checks so a revoked business permission does not
strand the bridge's own sandbox.

## What the binding does

`createHarnessBridge(options)` validates its trusted configuration and returns
`execute(request, signal?)`. Each execution snapshots the request's standard
fields, checks admission, creates one named sandbox through a fixed OpenShell
CLI invocation, verifies its native identity, optionally uploads one ordinary
`<skill-name>/SKILL.md`, uploads the host-prepared DSH patch, and submits the
prompt as stdin to the fixed DSH headless command. It then parses the native
event stream and performs bounded stop/delete and absence checks.

Limits default to a 120-second total deadline, 20-second native command limit,
and 256 KiB native output bound. Cleanup has its own bounded 60-second window.
These are bridge process limits, not a global resource or cost budget. The
current create invocation also requests 500m CPU and 512 MiB memory; deployment
policy and the native driver remain part of the actual isolation boundary.

## Evidence and outcomes

`completed` means the expected DSH completion event, final text, session ID,
and zero native exit status were observed, and the bridge verified its cleanup
condition. It does not mean the application accepted the result or delivered
it to a user. `failed` reports an execution or authorization failure;
`blocked` includes uncertain cleanup or denied result release. A failed or
blocked result may still carry a native sandbox identity and must be retained
by the host for its own operations record.

The bridge reports `modelRequestCount: null`: the DSH event stream does not
provide trusted per-task model usage. `toolCallCount` is only the number of
parsed DSH tool-call events. Neither count establishes model calls or billing.
Applications that require usage evidence must obtain a separate trusted receipt
bound to their task and the exact native sandbox before delivery.

## Intended use and current limits

Use this binding when an application already has OpenShell CLI access, a
prepared DSH headless image and patch, and trusted host-side callbacks. It is
currently pinned to OpenShell CLI v0.1.3 behavior and
`@deepseek-ai/dsh@0.2.0-rc.2`; this preview is not a universal Harness protocol
or installer.

The API does not provide durable tasks, cross-process scheduling, provider
routing, hard model budgets, accounting, business tools, or platform delivery.
The Koishi example demonstrates a host adapter with synthetic dispatch; it
does not make other Koishi plugins isolated or establish real platform
delivery. See [architecture](architecture.md), [quickstart](QUICKSTART.md),
[validation](validation.md), and [security notes](../SECURITY.md).
