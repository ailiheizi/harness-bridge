# OpenShell-backed AI adapter status

This document records the opt-in GroupWeave consumer binding to the
`@actweave/harness-bridge` package. The legacy entry retains its previous host
AI route. The native `start:koishi` entry uses only the Docker binding for AI;
an explicitly selected sandbox route uses
the separate bridge for OpenShell lifecycle and native DSH launch. GroupWeave
continues to own identity, task persistence, current permissions, and result
audience.

## Status clarification, 2026-10-26

The real model connection has already worked. On 2026-10-21, three controlled
OpenShell/DSH runs completed through Sub2API with `deepseek-v4.1-flash`; see
private historical provider report (omitted from public copy).
Those runs did not deliver a Telegram business result or verify the Bot's
request-budget/accounting contract. Their temporary gateway/control resources
were deliberately cleaned up afterward. An absent gateway today does not
invalidate those successful runs or establish a new provider outage.

That deployment gap is now closed for the tested native Bot. On 2026-10-26,
the deployment host Koishi receiver completed real AyuGram private `/ask`, `/digest`,
and `/translate` requests through Docker/OpenShell/DSH and Sub2API. Each task
record contains one measured model dispatch and supplier token usage; results
arrived in the original chat. The prior local receiver is stopped as a rollback
copy, and its persisted data was migrated to the remote receiver.
The authorized test group also completed a real `/ask@bot` confirmation and
received its answer after fixing ordinary reply-thread detection. Private and
group results use their existing separate authorization paths.

The app-specific [Sub2API binding](../integrations/sub2api-openshell/README.md)
owns a fixed loopback admission route, task-scoped native provider credentials,
and cleanup. The real API key remains in a private deployment file on the
trusted application side. The public Bridge is reused as version
`0.1.6-preview.1`; it does not own this provider-specific route. This establishes
the observed single-turn functions, not provider uptime, billing verification,
multi-turn memory, or arbitrary Agent tool access.

## Intended route

The adapter selects `audited/group-summary/SKILL.md` for `digest` and
`audited/single-turn-assistant/SKILL.md` for `assistant`. Each feature has a fixed
path and pinned hash in `sandbox-ai.ts`; runtime verifies the source bytes.
It passes this task's explicit input to a fresh bridge execution. The assistant
answers a single question using general knowledge or transforms supplied text;
both routes require one model request and zero observed tool calls.
The model receives no caller-selected tools,
shell, file access, or arbitrary Skill path. AI remains opt-in through the
existing `AiExecutor.execute(request, signal)` contract and must not initialize
for fixed code features.

The opt-in adapter in `src/server/sandbox-ai.ts` requires a trusted binding for
the exact task, tenant/group, actor, feature, and audience. Request prose is
only data and cannot set any of those fields. It rechecks the app's admission,
native-operation, and result hooks; GroupWeave's existing action/store path
remains responsible for final task persistence and delivery authorization.
Wrong task, tenant, actor, or audience, revoked access, cancellation, late output,
or unverified cleanup cannot become a successful result.

## Current integration gaps

`createGroupActions` passes the reserved task ID, tenant/group, actor, feature,
audience, authorization flag, and permission-version snapshot through a frozen
internal `ExecutorRequest`. The opt-in startup mapping preserves these values.
The store-backed adapter checks the matching pending task reservation,
membership, enabled feature, and current permission versions at admission,
before each business native operation, and before releasing the result. The
existing action path still performs its final persisted-task authorization.

The sandbox digest and assistant's outer app deadline is derived from the trusted module's
`totalTimeoutMs` (120 seconds when omitted), plus the bridge's fixed 60-second
native cleanup window and a five-second handoff margin. The accepted work limit
is bounded to 1–300 seconds. Other AI routes keep their existing app timeout;
fixed-code execution remains at 10 seconds.

Sandbox execution is selected only when the trusted deployment sets
`SANDBOX_AI_BINDING_MODULE` to an absolute, protected `.mjs` module. The module
provides explicit OpenShell/DSH paths and provider names plus a trusted
accounting contract. Its workload image must use an immutable OCI SHA-256
digest; the OpenShell workspace is a logical name. OpenShell CLI HOME and XDG
roots must already exist, be real owner-only `0700` directories owned by the
application user, and stay outside that user's home. When unset, sandbox mode
stays off. When selected, setup, authorization, credential, budget, execution,
or cleanup failures do not fall back to the host DSH executor. The native entry
also requires `ENABLE_AI=1`; its assistant uses this sandbox route and mixed
execution is not connected. The legacy entry retains its older host assistant
and mixed routes; using the legacy entry is not equivalent to the native one.

OpenShell/DSH controlled fixture evidence uses synthetic provider credentials.
The bridge's native DSH event stream reports `modelRequestCount: null`; it does
not prove a model request count. Because the current GroupWeave digest result
contract requires exactly one call, the adapter requires a task-and-sandbox
bound max-one budget admission immediately before native DSH execution, then a
separate usage receipt bound to the same task, sandbox, and DSH session. The
local tests inject synthetic admissions and meter receipts only to exercise
those gates; they are not production evidence. No real provider gateway with a
verified hard request cap and corresponding receipt is currently bound, so
production sandbox AI remains blocked until that external route is verified.

The earlier synthetic fixtures alone did not establish the real credential
route. The 2026-10-21 controlled real-provider runs subsequently demonstrated
provider connectivity through OpenShell/DSH. Reuse that route when wiring the
Bot; its production deployment binding and budget/receipt adapter still need
to be supplied. Keep credentials on the trusted side rather than in task argv,
workload environment, or task files.

The current GroupWeave DSH host adapter uses the official provider API directly
inside the application process. This sandbox consumer is a distinct opt-in
route; it must not silently fall back to that host adapter when bridge setup,
authorization, credentials, native execution, or cleanup fails.

## Native acceptance, 2026-10-13

The fixed private `@actweave/harness-bridge@0.1.3` passed 26/26 package tests.
GroupWeave passed 233 tests, skipped 11, and failed 0 (244 total); its build
passed. The native GroupWeave consumer run exercised the actual Store/actions
path with synthetic task, group, and actor identities: the existing Koishi
fixed-code route completed with zero model requests, and the sandbox digest
route completed with one independently counted synthetic model request and a
private audience. The separate native caller also loaded the reviewed Skill,
accepted two synthetic fixture requests, rejected a third with HTTP 429, and
completed native cleanup. These are real OpenShell/DSH lifecycle runs; model
content, model endpoint, business identities, and accounting fixture were
synthetic. The application itself was run as a host process; at the time of
that host-process run, native CLI integration inside the application container
and Telegram delivery had not been tested. The later container and Telegram
runs are recorded below and in their linked reports; neither is a real-provider
billing test.

The first GroupWeave native consumer attempt correctly failed closed: the DSH
base profile made an additional `session-title-llm` request, so the fixture
observed one accepted request and one rejected request (429), and the app did
not release a successful result. The dedicated summary profile disabled that
background title behavior; the rerun observed one accepted request, zero
rejections, and HTTP 200, after which all seven consumer checks and fixture
cleanup passed. Do not infer request counts from DSH turns or tool-call counts.
The bridge continues to report `modelRequestCount: null`; this acceptance used
an independent fixture counter bound to the task, native sandbox, and DSH
session. Any trusted summary profile must suppress extra background model
behavior and enforce a hard pre-request budget through an independently
verifiable accounting route. The synthetic fixture demonstrates that contract,
not a production provider quota or meter.

The run verified the approved Skill path and source hash and the native
execution/result and budget bindings. It does not establish that a model
understood or followed the Skill. The existing DSH base harness has tools;
this summary run rejected any tool calls, but did not prove that the toolset
was absent before execution.

The external native acceptance log includes source, package, caller, cleanup,
and protected-service evidence:
OpenShell PoC progress（私人历史证据未随公开案例发布）.

## Real application-container acceptance, 2026-10-13

The actual GroupWeave application image, `[private digest omitted]`,
passed the native application-container acceptance: **77/77 checks passed**.
The workload's model context and responses were synthetic. The checks include
configuration, permissions, and preconditions, not 77 separate attacks. The
application ran read-only as UID 1000 without a
Docker socket, with 512 MiB memory, one CPU, and a 128-process limit. The
first OpenShell upload attempt failed closed because the image lacked the
system SSH client; cleanup completed. The Dockerfile now makes the client and
CA certificates opt-in through `ENABLE_OPENSHELL_CLIENT=1`; the rerun passed
the upload gate. The complete flow took about 22.7 seconds. This is container
and synthetic-context evidence, not production provider evidence. See the application-container
acceptance report（私人历史证据未随公开案例发布）.

The same image and real server entrypoint also passed a **9/9 scoped live
Telegram acceptance** using a dedicated test bot and a private empty group
containing only the tester and bot. Telegram `getMe`, HTTP health, polling,
private `/start`, group `/register` and `/help`, real `/rules` preview and
button activation, and `/echo` all passed; each of the six command/callback
steps had one incoming and one successful outgoing receipt. The run used no
model request and shut down automatically after 342,456 ms. Its token, tester
identity, and group identity are intentionally not recorded. See the
Telegram acceptance report（私人历史证据未随公开案例发布）.

These runs do not close production budget, broker, or meter gates. No verified
production route supplies both a hard pre-request cap and an independently
verifiable receipt bound to the task, sandbox, and DSH session. Trusted
provider credential delivery and real-provider usage remain blocked. The
Telegram run also does not establish Mini App login or multi-user, cross-group
authorization behavior.

## Evidence boundary

Local adapter tests use synthetic tenant/task identities, a controlled bridge
stub, and (where explicitly provided) a synthetic accounting receipt. They can
verify request binding, provider scope, denial, late result suppression, and
cleanup-status handling. They do not prove OpenShell identity, Docker isolation,
credential secrecy, model behavior, Telegram delivery, production accounting,
or production authorization. The 2026-10-13 native runs provide
identity-matched OpenShell and Docker lifecycle evidence for synthetic data
and fixture-backed model accounting only; they do not close those production
gaps. The application-container and Telegram reports above state their
separate live scopes and limitations.

## Reproducing the controlled consumer

The opt-in [native consumer fixture](../tests/fixtures/sandbox-native-consumer.ts)
is the source of the executed proof. It is excluded from `tests/*.test.ts` and
requires an absolute path to a trusted synthetic context module exporting
`prepareSummaryContext`, such as the PoC configuration reference linked from
[the native guide](../../../docs/NATIVE-ACCEPTANCE.md).
It does not connect to Telegram or a production provider. Run it only against
the prepared, receipt-verified PoC; that context creates and removes only its
own native profiles/providers and uses a bounded synthetic model endpoint.

```sh
npm exec -- tsx tests/fixtures/sandbox-native-consumer.ts /absolute/private/native-config.mjs
```

Keep the final Docker-role/volume cleanup and protected-service checks separate
from the fixture's native namespace result. The 2026-10-13 application-image
run separately verifies native CLI connectivity in that image; neither run
proves production authorization or accounting.

## Deployment readiness check, 2026-10-26

The native Koishi bot deployment remains AI-disabled and has no configured
`SANDBOX_AI_BINDING_MODULE`. Its example environment keeps `ENABLE_AI=0` and
the binding path empty; the current Compose file forwards a supplied path but
does not mount a deployment binding or its OpenShell/DSH configuration. No
native bot-to-model run was performed in this check.

The deployment host host has OpenShell CLI 0.1.3 and the existing Docker driver
artifacts, but `openshell status` reported no configured gateway. The gateway
list was empty, no OpenShell gateway/driver container was running, and the
usual local gateway ports 8080 and 8081 were closed. The Sub2API service was
healthy. Its historical real-provider canary report (omitted from public copy)
completed three controlled DeepSeek turns through OpenShell/DSH, but that
acceptance did not bind the current GroupWeave bot to the provider and did not
verify request counts, billing, a hard request limit, or usage receipts.

The required GroupWeave `modelAccounting` binding is still absent. A valid
deployment must enforce a one-request limit before provider dispatch and
return a trusted receipt bound to the task, tenant, actor, native sandbox, and
DSH session. The existing synthetic receipts and request parameters such as
`max_tokens` do not satisfy this requirement. Until a real provider route
supplies both the hard pre-request limit and independently verifiable receipt,
the native AI path must remain disabled; setup, accounting, or cleanup failure
must not fall back to the host AI route.
