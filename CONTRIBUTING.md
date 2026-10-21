# Contributing

Contributions should preserve the small host-to-Harness integration boundary.
Before proposing a new capability, identify the existing host or native
component that owns it and show a concrete consumer need.

## Development

- Use Node.js 24 or later.
- Install dependencies with `npm ci`.
- Run the core suite with `npm test`.
- Keep synthetic tests and private native acceptance clearly separated.
- For runtime changes, cover meaningful denial, cancellation, wrong identity,
  partial creation, and uncertain cleanup behavior where applicable.

Do not add private configuration, credentials, `.local` material, raw receipts,
or host-specific paths to the repository. Do not claim live behavior from fake
CLI tests. Native acceptance is opt-in and requires an independently prepared
target and synthetic fixture; see [the native guide](docs/NATIVE-ACCEPTANCE.md).

## Scope

This project currently binds OpenShell Docker and the existing DSH headless
Harness. Proposals for another backend, Agent loop, workflow engine, provider
router, tool registry, permission protocol, queue, scheduler, or persistent
task store fall outside the current design. Document missing host/native
capabilities as integration gaps instead of adding a parallel runtime.

For changes that affect claims or trust boundaries, update the relevant design
or ADR documentation and keep the validation record precise about what was
actually run.

## Architecture diagrams

Edit Mermaid sources under `assets/` and regenerate SVG/PNG exports using the
[diagram build guide](docs/diagrams.md). Keep each view focused: overview,
isolation/authority, or task lifecycle. Review the generated images at the size
where readers will see them. Do not maintain hand-edited copies of exports.
