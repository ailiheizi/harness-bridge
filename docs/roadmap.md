# Roadmap

This roadmap is intentionally evidence-led. It does not promise dates or
general Harness support.

## Preview scope

- Keep the OpenShell Docker and DSH headless binding small and tied to their
  pinned native contracts.
- Publish the host integration boundary, synthetic examples, and truthful
  validation notes.
- The independent publication copy passes its local clean-install, contract
  checks and package preview. Preserve these checks in CI. See
  [validation](validation.md) for environment and scope.

## Before broader deployment claims

- Keep package and example checks green in clean-checkout CI; validate the
  minimum Node.js version and each supported operating system separately.
- Validate against the exact target image, OpenShell CLI, policy, DSH patch,
  and deployment paths a consumer intends to use.
- For applications that require model budgets, wire a trusted pre-request
  budget and task/sandbox-bound usage receipt outside this library.
- Validate real host identity, current-permission checks, result audience,
  delivery, persistence, and restart recovery within the consumer application.
- Independently verify controller-owned roles, volumes, and other external
  resources after native acceptance.

## Capacity optimization research

- The current bridge creates and deletes one fresh Docker-backed OpenShell
  sandbox per task. Existing image-layer or dependency caching may be shared
  by the deployment, but the bridge has not measured or claimed a performance
  benefit from it.
- Do not add instance pooling, VM isolation, or a local capacity service.
  Consider only an OpenShell-native, unused clean capacity unit leased once,
  run once, destroyed, then replenished, and only after native lifecycle
  evidence and a representative benchmark. A used or uncertain instance must
  not be wiped and returned to dispatch; pause is not reset.
- The host application owns concurrency, admission, and capacity accounting.
  See [reuse boundary](reuse.md) and [ADR 0006](adr/0006-clean-capacity-reuse.md).

## Expansion rule

Do not add another isolation backend, Harness loop, provider router, tool
registry, permission protocol, queue, scheduler, or durable task store to make
the project appear more general. Add a concrete target binding only when an
actual consumer contract shows what must be adapted and the new boundary can
be validated. A second language or platform binding needs its own demonstrated
consumer and review of the maintenance and security consequences.
