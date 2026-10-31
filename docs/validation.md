# Validation and evidence

## 2026-10-31 status update

M1 / AIL-28, M2 / AIL-29, and the five M3/M4 items are Done; the integration
checklist is complete. The latest application `npm run build` passed, five
independent review items are closed, and the receipt ID regression passed 2/2.
These are scoped results, not an exhaustive ecosystem or security audit.

Real target evidence: Telegram delivered a 23-byte Markdown file that was
downloaded and checked. After restart, a follow-up in the same DM received a
real DSH reply using prior context and delivered a 10-byte file. A real group AI
proposal changed max from 10 to 7 at v4→v5; a confirmed rollback proposal
restored max 10 at v6, verified through `/settings`, without additional model
calls for apply/rollback. The deployed model set remains the default model;
multiple profile selection was checked locally only.

Node 26.13.0 with OpenShell 0.1.3 native mTLS is deployed. The anonymous
protected RPC returned code 16 (denied); its credentialed equivalent returned
0 (success). All three Bot UID 1000 native CLI list checks returned 0 (success).
The final command fix and DSH export image are deployed; health, Telegram and
executor connections are healthy with zero restarts and the current database
preserved. This initial deployment alone did not close M6. M5's deployment
recipe/documentation and M6's six bounded negative cases were then completed;
see the [closeout record](../examples/groupweave/docs/CLOSEOUT-20261031.md).
Fresh-checkout installs/build/native default/minimal startup, five Compose
configurations and standalone archive consumption passed. The sole clean
Docker build attempt timed out at DockerHub token retrieval and remains
unverified. Six negative cases combined signed native-mode application APIs,
real local plugin/file seams, and two actual OpenShell/Docker sandboxes with
cleanup. No model was invoked and production egress was not tested. These
scoped passes do not establish universal isolation or prompt-injection resistance.

Keep reproducible checks in this repository separate from recorded tests on a
private target. The package is source version `0.1.6-preview.1`; the current
2026-10-31 changes add an optional fixed Markdown download to its bridge API.
Earlier records below describe their own source and evidence dates.

## 2026-10-31 application and fixed-result additions

The complete case now has native platform plugin maintenance, group-native
tool switches, reviewed configuration proposals, bounded personal contexts,
model presets and task history. The bridge can optionally download one fixed
Markdown result before sandbox cleanup. See the
[usage guide](../examples/groupweave/docs/M1-M4-USAGE.md).

New-seam checks covered a real npm/Loader install and enable/disable path,
original environment and database paths with managed configuration, a pinned
DSH SessionStore completion observer producing a file, native-command artifact
transfer with a CLI stand-in, and application routes through proposals, model
selection and a downloadable file. Conversation checks included restart
interruption, reset and audience changes. A real pinned RSS emitter verified
that the group switch suppresses existing subscriptions while removal remains
available. The complete application builds and starts natively with AI off,
including its maintenance service and new commands. A focused independent
review found five integration defects, which were corrected and rechecked.

These results establish the changed seams, not an exhaustive plugin matrix or
final security review. Target deployment and real external results are recorded
separately in the application's dated delivery record when available. Existing
evidence for unchanged pinned upstream functions is reused under ADR-039.

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
