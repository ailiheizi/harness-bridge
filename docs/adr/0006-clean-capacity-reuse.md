# ADR 0006: Research clean-capacity reuse only with native evidence

**Status:** Proposed optimization; not implemented. ADR 0004 remains the
accepted current lifecycle.

## Context

Fresh creation and deletion may have measurable startup cost. Sharing
immutable image layers or dependency preparation may reduce deployment work,
but does not reuse a sandbox instance and has not been benchmarked by this
project. Reusing an instance after it has handled a task introduces residual
files, processes, credentials, memory, and network state that a file wipe or
pause operation does not establish as clean.

## Proposal

Keep one fresh sandbox per task as the current behavior. Consider a future
optimization only if the pinned OpenShell implementation has documented and
validated native support for prepared clean capacity, exclusive single-use
claiming, identity checks, destruction, replenishment, and failure isolation,
and a representative benchmark shows a worthwhile improvement with total
resource costs included.

If that gate is met, evaluate only this lifecycle:

```text
unused clean capacity -> exclusive single-task lease -> run -> destroy -> replenish
```

Do not return a used instance after wiping it. Pause/resume is not reset and
does not make a used instance eligible for another task. Any uncertain or
failed capacity is quarantined from dispatch and remains accounted for by the
host until its disposition is verified.

## Boundaries and consequences

- Docker-backed OpenShell remains the sole isolation path; this proposal does
  not authorize a VM backend or another sandbox implementation.
- Existing OpenShell and Docker mechanisms may share immutable image and
  dependency layers. The bridge does not claim measured cache performance or
  manage those caches.
- The host application owns concurrency, admission, and capacity accounting.
  Any external waiting mechanism remains outside this package; no local pool
  service, queue, or scheduler is introduced.
- Until the evidence gate is satisfied and a separate implementation is
  reviewed, fresh-per-task create/run/destroy remains required.

## Evidence required to revisit

1. Pin and inspect the actual OpenShell version's native lifecycle contract.
2. Demonstrate exclusive claim, clean-state provenance, identity binding,
   destruction, replenishment, and quarantine behavior using that contract.
3. Benchmark against the current path and report latency and full resource
   accounting, including idle, creating, running, deleting, and failed units.
4. Review the resulting security and operational claims before changing ADR
   0004 or runtime behavior.
