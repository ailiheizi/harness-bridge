# Contributor boundaries

This repository is a preview of the Harness Bridge binding. Keep
changes within the small, explicit integration boundary:

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

Before changing the runtime, read `docs/design.md`, `docs/architecture.md`,
`SECURITY.md` and the relevant decision in `docs/adr/`. Add tests for
meaningful lifecycle or denial behavior when changing runtime code. This file
does not authorize live provider, platform, server, or production operations.
