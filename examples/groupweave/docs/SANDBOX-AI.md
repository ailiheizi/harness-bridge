# OpenShell-backed AI adapter

Updated 2026-10-31. The native `start:koishi` Bot runs model tasks through
Harness Bridge, OpenShell 0.1.3 Docker and DSH `0.2.0-rc.2`. GroupWeave owns
identity, current permissions, task persistence, bounded conversation input,
accounting and delivery. The legacy host AI entry is a different path and must
not run alongside the native receiver with the same Telegram token.

## Current evidence

Real Telegram private/group ask, summary, translation and code-plus-model brief
results are recorded in the [native history](ACCEPTANCE-20261022-NATIVE.md).
The [2026-10-31 delivery](DELIVERY-20261031.md) adds an actual downloaded
Markdown result, a follow-up using context across restart, and reviewed AI group
configuration with confirmed apply/rollback. Native mTLS is deployed: the
protected anonymous RPC returned 16 (denied), the certified call returned 0
(success), and the Bot's three authenticated native CLI list commands returned
0. These facts do not prove provider uptime, monetary billing or every model.
The live deployment currently exposes only the `default` profile.

## Required deployment

- `ENABLE_AI=1` and an absolute protected `SANDBOX_AI_BINDING_MODULE` select the
  trusted binding. Missing credentials, unsupported paths, accounting failure
  or failed cleanup stop the request; there is no fallback to a host executor.
- The binding supplies an immutable workload image, native CLI, logical
  workspace, native policy and DSH patch. The [DSH recipe](../deploy/dsh/README.md)
  includes the fixed completion observer for Markdown export.
- CLI HOME/XDG roots are existing, real owner-only 0700 directories outside the
  application user's HOME. Each task receives its own native roots, provider
  admission and cleanup. Native mTLS CA/client files stay on the trusted host,
  never in DSH HOME, the uploaded Skill, patch, workspace or model prompt.
- The existing [Sub2API adapter](../integrations/sub2api-openshell/README.md)
  handles its provider-specific admission and usage evidence. Provider secrets
  stay in private deployment configuration. Compose mount/env steps are in
  [repository setup](REPOSITORY-SETUP.md); copying an API key is insufficient
  to provision OpenShell/DSH.

Fixed features work with `ENABLE_AI=0`. Telegram connection and its token are
separate from the model deployment. Do not mount Docker's socket into the Bot
or a workload as a substitute for the existing native control plane.

## Request and result path

The host reserves a task and builds a frozen internal request containing the
server-owned task, group/private scope, actor, audience and current permission
versions. Prompt text cannot supply or override those fields. The adapter
resolves that exact pending task, checks current admission, rechecks before
each business native operation and result release, then checks final stored
ownership and audience before delivery. Cancellation, revoked access, late
results and uncertain cleanup cannot become a successful delivery.

`assistant` and `digest` use pinned ordinary Skills with one allowed model
request and zero model tools. Translation uses the existing isolated assistant
path without conversation history. `link-brief` performs the existing link
cleanup code first and asks the model to explain its actual result; it does
not grant web access. AI rule interpretation also excludes conversation
history and can only propose supported configuration fields.

Ordinary assistant questions include the requester's current group/private,
same-audience context, bounded to 12 messages/24 KB. Reset or audience change
starts empty context and prevents late writes to the old revision. Each turn
still starts a new Docker sandbox; no old HOME or workspace is reused. Trusted
model profile selection uses a protected file of existing binding module IDs,
not caller endpoints or automatic provider failover. See [usage](M1-M4-USAGE.md).

A completed turn exports only `/workspace/exports/result.md`, at most 64,000
bytes of regular UTF-8 text exactly matching the validated final answer. Native
download happens before sandbox cleanup; result authorization still applies.
The host keeps short-lived file bytes for one owner-scoped pickup (five
minutes), while SQLite retains metadata and authorized textual history.
Arbitrary filenames/paths and durable artifact storage are outside this seam.

## Limits and accounting

The work deadline comes from the trusted binding (120 seconds by default,
accepted range 1–300 seconds), plus 60 seconds for native cleanup and five
seconds of handoff margin. Fixed-code execution retains its separate ten-second
limit. The bridge's model request count is `null`: native completion or tool
call events alone do not prove usage or cost.

The application requires an external verified max-one request admission before
DSH execution and a usage receipt bound to task, tenant, actor, sandbox, DSH
session and admission ID before success. The current adapter supplies its own
request gate and measured supplier usage; other bindings must supply their own
compatible evidence. This is not a monetary account balance or global resource
budget. Synthetic accounting in local tests exercises the binding contract,
not provider billing. Broader guarantees still depend on the actual policy,
network, runtime images and trusted host. See [security notes](../../../SECURITY.md).
