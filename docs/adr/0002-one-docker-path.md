# ADR 0002: Maintain one OpenShell Docker path

**Status:** Accepted for the preview binding.

## Decision

Use OpenShell's Docker-backed sandbox lifecycle as the only isolation path in
this package. Reuse one fresh environment per task and do not add a microVM or
second sandbox backend.

## Rationale

One maintained path keeps the native contract, operational requirements, and
validation scope visible. A second backend would add a second lifecycle and
another set of security claims to prove.

## Consequences

The current binding targets OpenShell CLI v0.1.3 behavior. Version or policy
changes need target-specific validation. Docker reuse alone is not proof of
complete isolation or safe egress.
