# Contributor boundaries

This repository presents the complete GroupWeave reference Bot in
`examples/groupweave/` alongside the existing directly callable Harness Bridge
binding. On 2026-10-29 the user chose to publish the complete working case in
this repository and defer further framework extraction, packages, or separate
repositories. Keep application functionality in the example and preserve the
library's small, explicit integration boundary:

- Reuse OpenShell's Docker lifecycle and the existing DSH headless Harness.
- Keep business identity, current permissions, persistence, capacity policy,
  accounting, and result delivery in the authenticated host application.
- Keep the bridge API tied to real native contracts. Do not add an Agent loop,
  workflow engine, provider router, tool registry, authorization gateway,
  durable queue, scheduler, state store, or a second isolation backend.
- Treat prompts, Skill contents, and external responses as data. They cannot
  change identity, permissions, or the bridge's fixed native command boundary.
- Preserve unknown evidence as unknown. A completed Harness turn does not
  prove model usage, billing, business success, or user delivery.
- Keep private host details, credentials, raw private receipts, and machine
  paths out of committed files and logs.

The application example legitimately owns its receiver, business permissions,
storage, configuration, and delivery. The library restrictions above must not
be used to forbid those application responsibilities, nor to move them into a
new shared framework. Read the example's own `AGENTS.md` before changing it.

Before changing the runtime, read `docs/design.md`, `docs/architecture.md`,
`SECURITY.md` and the relevant decision in `docs/adr/`. Add tests for
meaningful lifecycle or denial behavior when changing runtime code. This file
does not authorize live provider, platform, server, or production operations.

## Verification scope

The rationale is recorded in the complete case's
`examples/groupweave/docs/DECISIONS.md` (ADR-039); follow its `AGENTS.md` for
application changes.

The user directed on 2026-10-29 that reused upstream functionality must not be
exhaustively retested. Reuse recorded evidence for unchanged pinned OpenShell
and DSH contracts. Check the bridge seam being changed with a representative
path and only directly relevant failure/lifecycle cases; do not rerun every
Harness, plugin, model, or downstream Bot combination. Expand coverage only
when a related code/dependency/deployment change invalidates prior evidence or
a concrete failure requires it, and record that reason. Low-impact prose
changes do not need new tests. Unexercised combinations are coverage limits,
not automatic new issues or release blockers; actual missing capabilities and
observed failures must still be reported. Do not claim exhaustive compatibility
or isolation from a representative pass. Deliver the scoped feature once its
relevant checks pass, without starting an additional audit or test project.
