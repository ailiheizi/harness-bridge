# ADR 0004: Use a fresh sandbox and conservative cleanup

**Status:** Accepted for the current lifecycle binding.

## Decision

Create a new sandbox for each execution. Verify its native ID, name, workspace,
and ownership labels before acting on it. On completion, failure, cancellation,
or deadline, attempt bounded cleanup with controller authority. Treat uncertain
identity or cleanup as unverified and do not report the task as completed.

## Rationale

Reusing a task's writable environment could carry files, processes, or
credentials into another task. Business permission revocation and caller
cancellation must not prevent a trusted cleanup attempt for the owned
instance.

## Consequences

The current CLI deletes by name. Identity checks narrow the rebind window but
do not make deletion atomic. `cleanup: verified` confirms the bridge's stop
observation and native name absence; it does not prove that every external
role, volume, or backing resource is gone.
