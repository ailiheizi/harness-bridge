# ADR 0005: Keep evidence scoped to what it proves

**Status:** Accepted.

## Decision

Represent native execution, cleanup, DSH session, and parsed tool-call events
separately. Keep `modelRequestCount` unknown. Require any needed usage or
accounting receipt to come from a trusted external source and bind it to the
exact task and native sandbox before the host releases a result.

## Rationale

A final answer, process exit, DSH event count, or model catalog cannot prove
the provider's exact billable request count, business success, or user
delivery.

## Consequences

The host applies its own current permission, budget, accounting, and audience
checks. Local fake-CLI tests, controlled synthetic native runs, real inference,
and production platform behavior remain distinct evidence classes.
