# Validation and evidence

Keep reproducible checks in this repository separate from recorded tests on a
private target. This preview is source version `0.1.6-preview.1`; the core
bridge implementation was carried forward unchanged from the `0.1.5` source.
That statement is source lineage, not a new live acceptance result.

## Complete Bot case publication, 2026-10-29

`examples/groupweave/` contains the existing application case, its ordinary
Koishi configuration, dependency patches, Docker/Compose deployment and scoped
historical acceptance notes. This publication changes the checkout and image
packaging, not the bridge runtime or upstream plugin implementations.

For this packaging change, root/example dependency installation, the example's
TypeScript/Vite build, the local Bridge import and Compose context resolution
passed. The native Koishi entry then started from the published checkout:
health reported `ok` and `koishiConfigured`, and the built page returned HTTP
200. Telegram and AI were disabled for that startup check; it made no model
request and the temporary process was stopped afterward.

The local Docker rebuild did not complete: Docker Hub token requests were
reset before application build, and the official image cache download was
stopped after remaining slow. Compose configuration and Docker paths were
reviewed, but this is not a successful new Docker image build receipt. Prior
deployment evidence does not turn this unfinished rebuild into a pass.

No upstream plugin matrix, full application suite, new model call, or
new Telegram acceptance run was required. Existing real task results are
described in the example's acceptance history; private raw receipts are omitted.

Verification follows root `AGENTS.md` and the example's ADR-039. Unexercised
combinations are coverage limits, not automatic new delivery tasks. The small
`examples/koishi` below is distinct from the complete application case.

## Reproducible from this repository

`npm test` runs the package's node:test suite against a fake native CLI. It
checks bridge behavior, including native command construction, identity
handling, lifecycle failures, cancellation, and result evidence. It does not
launch OpenShell, DSH, Docker, a provider, a real bot platform, or a production
business API.

The Koishi example has its own synthetic tests for native Koishi App/Session/
command dispatch with MockBot, configuration checks, and cancellation checks.
They do not send Telegram messages or verify real-user identity, provider
accounting, or production authorization. See the example README for its exact
scope.

On 2026-10-21 this independent publication copy passed clean installs and
these checks on macOS with Node.js 26.5.0 / npm 11.17.0:

| Command | Result |
| --- | --- |
| `npm ci --ignore-scripts` | PASS |
| `npm test` | 46/46 PASS |
| `npm audit` | 0 known vulnerabilities in the root graph |
| `npm ci --ignore-scripts` in `examples/koishi` | PASS |
| `npm test` in `examples/koishi` | 17/17 PASS |
| `npm run test:native-config` in `examples/koishi` | 10/10 PASS |
| `node --test --test-concurrency=1 native-cancel-checks.mjs` in `examples/koishi` | 3/3 PASS |
| `npm run demo` in `examples/koishi` | PASS; synthetic reply only |
| `npm pack --dry-run --ignore-scripts` | PASS; core entrypoints, types and README included |

The public core suite omits two HTTP model-server fixture tests that depended
on a separate private PoC. The three native-caller contract tests remain. No
core bridge implementation was removed or changed. The core source SHA-256 is
`1bcbaa1c00f65b669e59c2a93f82b1e79b1fce7c95182c01867f9e7a301915c1`.

CI is configured for Ubuntu with Node.js 24; its run status must be checked
separately. Koishi's dependency audit reports 11 moderate package-path
findings traced to a single transitive advisory, not 11 distinct CVEs. See
[dependency notes](DEPENDENCIES.md). This is a source preview, not an npm release.

## Recorded private native run

A prior controlled private run recorded three of three successful synthetic
provider roundtrips through OpenShell and DSH, with exact synthetic output and
verified bridge cleanup. It also recorded earlier provider failures and a
separate host-side HTTP 520; their cause was not established. This run depends
on private fixture hooks and configuration absent from this repository and is
not independently reproducible from the public files alone. Raw receipt IDs,
private host details, and credentials are intentionally not published.

That evidence does not establish Skill-load proof for those three rounds,
accurate request counts, production billing, a hard model budget, provider
reliability, real Telegram delivery, or production readiness. The bridge's
`modelRequestCount` remains `null`; usage and billing remain unknown unless a
separate trusted receipt proves them for the exact task and sandbox.

## Claims to keep separate

Report these separately in any release note or deployment report:

- local fake-CLI checks;
- host framework dispatch tests with synthetic messages;
- controlled native execution and cleanup;
- external fixture receipts;
- real provider inference and its usage evidence;
- production authorization and platform delivery.

Passing one layer does not promote another layer to verified. No comparative
performance, cost, security, or operational advantage has been measured here.
