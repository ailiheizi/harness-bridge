# Contributing

Contributions may improve the complete GroupWeave application in
`examples/groupweave/` or the existing small host-to-Harness binding. Keep
application responsibilities in the example. Further framework extraction is
deferred by [ADR 0007](docs/adr/0007-complete-bot-case-first.md).

## Development

- Use Node.js 24 or later.
- Install dependencies with `npm ci`.
- Check the seam you actually changed; `npm test` is the available library
  contract suite, not a prerequisite for every documentation or app change.
- Keep synthetic tests and private native acceptance clearly separated.
- For runtime changes, cover meaningful denial, cancellation, wrong identity,
  partial creation, and uncertain cleanup behavior where applicable.

Reuse upstream and previous acceptance evidence for unchanged versions and
contracts. Do not retest every Koishi plugin, model, media format, or input
combination. A representative working integration is sufficient unless a
related change or actual failure justifies more. Unexercised combinations do
not automatically create issues or block delivery. See `AGENTS.md` and
[ADR-039](examples/groupweave/docs/DECISIONS.md#adr-039复用上游验证以代表性接入和本项目接缝作为交付依据).

Do not add private configuration, credentials, `.local` material, raw receipts,
or host-specific paths to the repository. Do not claim live behavior from fake
CLI tests. Native acceptance is opt-in and requires an independently prepared
target and synthetic fixture; see [the native guide](docs/NATIVE-ACCEPTANCE.md).

## Scope

The library currently binds OpenShell Docker and the existing DSH headless
Harness. Proposals for another backend, Agent loop, workflow engine, provider
router, tool registry, permission protocol, queue, scheduler, or persistent
task store fall outside the current design. Document missing host/native
capabilities as integration gaps instead of adding a parallel runtime. These
library restrictions do not prohibit the example's existing receiver,
business state, permissions, or result delivery.

For changes that affect claims or trust boundaries, update the relevant design
or ADR documentation and keep the validation record precise about what was
actually run.

## Architecture diagrams

Edit Mermaid sources under `assets/` and regenerate SVG/PNG exports using the
[diagram build guide](docs/diagrams.md). Keep each view focused: overview,
isolation/authority, or task lifecycle. Review the generated images at the size
where readers will see them. Do not maintain hand-edited copies of exports.
