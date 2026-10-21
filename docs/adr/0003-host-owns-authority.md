# ADR 0003: The host owns business authority

**Status:** Accepted.

## Decision

The authenticated application supplies trusted task, tenant, and actor context
and implements the bridge's required admission, native-call, and result
authorization callbacks. Business APIs must enforce their own current object,
operation, and recipient permissions. Prompt text is never identity or
authority.

## Rationale

The bridge cannot infer whether an actor may read a particular record or send
a result to a particular audience. Nor can a generic callback replace checks
at the business API that performs the operation.

## Consequences

The callbacks are host policy seams, not a library-owned authorization gateway
or tool broker. Hosts retain persistence, business state, trusted accounting,
and delivery. Permission and accounting gaps remain host integration work.
