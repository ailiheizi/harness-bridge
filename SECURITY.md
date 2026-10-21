# Security notes

This package starts a fixed Harness command through OpenShell's native CLI. It
is an integration component, not a complete security boundary or business
authorization service. Review the target OpenShell policy, image, DSH patch,
provider configuration, host callbacks, and deployment filesystem as one
system.

## Host responsibilities

- Construct task, tenant, and actor identifiers from authenticated application
  state. Never take them from Agent text.
- Implement all required callbacks using current policy. Enforce access again
  in each business API and recheck the result audience before delivery.
- Keep OpenShell credentials and provider secrets in trusted configuration;
  do not pass secrets or arbitrary environment values through task input.
- Keep private CLI home/config roots and DSH patch under trusted control.
  Review policy and egress for each deployment.
- Persist failed and blocked results, including uncertain cleanup identity, in
  host operations records. Do not reuse an instance with unverified cleanup.
- Obtain trusted request accounting and pre-request budget controls separately
  when the application requires them. The bridge reports a null model request
  count.

## Known limitations

The current OpenShell CLI delete is name-based. A pre-delete identity check
does not make that operation atomic. A verified bridge cleanup result confirms
the observed stop and native name absence only; it does not confirm deletion of
all controller-side roles, volumes, or backing resources.

The bridge's fixed command limits and sandbox CPU/memory request do not create
a global capacity, disk, network, or monetary budget. Docker containers share
the host kernel. No claim of complete egress control, kernel isolation,
production authorization, provider reliability, billing accuracy, or
platform delivery follows from local tests or a synthetic native pass.

The native CLI process receives a fixed environment rather than inheriting the
host process environment. This reduces accidental environment propagation;
it does not replace host hardening, secret handling, filesystem permissions,
or review of the native control plane.

## Reporting a concern

Please report suspected vulnerabilities through the repository's private
security reporting feature when enabled. Include the affected version and a
minimal, sanitized reproduction. Do not include credentials, private prompts,
raw provider responses, user records, or private infrastructure identifiers in
a public issue.
