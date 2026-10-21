# Native acceptance

Native acceptance is an opt-in check against a separately prepared target. It
is not part of `npm test`, and this repository does not include a generic
fixture server, provider installer, OpenShell policy generator, or production
deployment recipe.

The current `test/native-live.mjs` caller requires a private config file whose
default export contains:

- `synthetic: true`;
- `bridgeOptions` with trusted native and DSH paths plus all three required
  host authorization callbacks;
- a trusted `request` with task, tenant, actor, prompt, and an absolute ordinary
  `SKILL.md` path;
- `prepareFixture`, `verifyFixtureReceipt`, and `closeFixture` hooks.

The config must be a regular, non-symlink file with no group or other
permissions (normally mode `0600`). Its `prepareFixture` hook must arrange the
already-approved controlled model fixture and native policy on the target and
return `{ ready: true, ... }`. The receipt hook must verify a synthetic receipt
bound to the exact task ID, native sandbox ID, and DSH session. The caller
requires a completed DSH turn, exact fixture final text, verified bridge
cleanup, two accepted fixture requests plus a subsequent over-budget request
denied by the fixture, and proof that the ordinary Skill was loaded and invoked. `closeFixture` is called for
fixture cleanup.

Run against an authorized, prepared target only:

```sh
node test/native-live.mjs --config /absolute/private/config.mjs
```

The caller prints a sanitized summary. The external fixture/controller remains
responsible for any resources outside the bridge-owned sandbox; verify its
cleanup independently. If fixture setup, native identity, execution, receipt,
or cleanup cannot be verified, report the run as failed or blocked. Do not
convert a provider catalog check or request submission into a pass.

A native acceptance pass demonstrates only that exact synthetic path and
target. It does not prove real platform identity or delivery, production
accounting/billing, provider reliability, global resource budgets, all network
egress behavior, or general support for arbitrary OpenShell/DSH versions. The
bridge itself still reports `modelRequestCount: null`, even when the external
fixture has its own receipt.
