# ADR 0001: Compose existing systems

**Status:** Accepted for the preview binding.

## Decision

Use OpenShell's native Docker lifecycle and DSH's existing headless Harness.
The bridge connects the authenticated host request to that path and returns
native execution and cleanup evidence.

## Rationale

The reusable value is a small integration boundary around systems that already
own isolation and Agent execution. Reimplementing an Agent loop, workflow
engine, or tool runtime would create a second execution system and duplicate
existing contracts.

## Consequences

The API is a binding for the current pinned target, not a universal Harness
protocol. When a required capability is absent, document the host or target
integration gap instead of inventing a local runtime.
