# Roadmap

This roadmap follows the current repository direction: complete and maintain
the GroupWeave Bot case in this repository, while keeping the bridge API
callable for hosts that use the same native contracts. It does not propose a
new package, protocol, or separate framework project.

## Current scope

- GroupWeave is the full application example, with its source in
  [`examples/groupweave/`](../examples/groupweave/README.md). Its own acceptance
  record distinguishes delivered features, observed outcomes, and limits.
- `createHarnessBridge(options).execute(...)` remains a small JavaScript
  library for the pinned OpenShell Docker + DSH headless binding.
- [`examples/koishi/`](../examples/koishi/README.md) remains a minimal,
  focused adapter for the host/library seam.
- Reuse upstream OpenShell and DSH behavior. Do not extract more packages or
  add an Agent loop, workflow engine, provider router, tool registry, durable
  queue, scheduler, task store, or second isolation backend.

## GroupWeave's known remaining features

The application record identifies actual product gaps rather than treating
every untested combination as a feature request:

- Console online plugin installation and a complete dependency interface are
  not delivered.
- AI sandbox file artifact return is not delivered; the library currently
  returns bounded text and evidence only.
- Multi-turn AI memory and broad plugin permissions are not delivered.
- Anonymous site parsing is best-effort. Remote failures remain visible and
  are not described as successful extraction.

See GroupWeave's [TODO](../examples/groupweave/docs/TODO.md) and
[fourteenth acceptance batch](../examples/groupweave/docs/ACCEPTANCE-20261022-NATIVE.md)
for current feature evidence and the limits on real Telegram/provider claims.

## Before broader deployment claims

- Validate the exact OpenShell CLI, DSH image and patch, native policy and
  deployment paths used by a consumer.
- Keep host identity, current permissions, audience, storage, cancellation and
  recovery responsibilities in the host application.
- For a consumer requiring hard model budgets, use an external trusted
  pre-request gate and task/sandbox-bound usage receipt.
- Do not infer provider cost, business correctness, delivery or complete
  isolation from a completed native turn or representative integration path.

## Capacity and extension boundary

The bridge creates a fresh Docker-backed OpenShell sandbox for each task and
performs bounded cleanup. Deployment-side immutable image/dependency reuse may
be possible but is not a bridge-managed cache or measured performance claim.
ADR 0006 remains a proposed optimization only; no warm pool or used-instance
reuse is implemented.

Do not add another isolation backend, Harness loop, permission protocol,
provider router, or generic framework layer to make the repository appear
more general. Work on the existing Bot case or bind a demonstrated consumer
need to the existing native contracts, documenting a real capability gap when
the target does not support it.
