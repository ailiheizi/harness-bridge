# Harness Bridge

**A thin bridge from your app to an isolated Agent Harness.**

[简体中文](README.zh-CN.md) · [Quickstart](docs/QUICKSTART.md) · [Design](docs/design.md) · [Decisions](docs/adr/) · [Validation](docs/validation.md)

Harness Bridge explores a simple idea: **describe adaptable work as an ordinary Skill,
keep predictable work in reusable code, and let existing systems do the work.**
Your application owns identity, data and delivery. An existing Harness runs the
Agent. An existing isolation system contains its workload.

The current implementation is a small JavaScript library connecting a trusted host application to **OpenShell's Docker lifecycle** and
an existing **DSH headless Harness**. A bot is one possible host; the core has
no Telegram or Koishi dependency.

> **Source preview · `0.1.6-preview.1`**
> The concrete binding and offline examples are available today. Deployment
> setup and business authorization remain host responsibilities. This is not
> a production-ready bot platform or a universal Harness runtime.

![Harness Bridge architecture: host authority, thin bridge and a fresh OpenShell-managed agent workload](assets/architecture.svg)

The diagram separates the **host application**, the **implemented bridge**, and
**reused upstream components**. Policy and mounts must be verified on the actual
target. [Architecture details](docs/architecture.md) · [Editable SVG](assets/architecture.svg) · [Mermaid source](assets/architecture.mmd)

## The idea

Four existing pieces can cover a large part of an AI application's structure:

| Piece | Responsibility | Where it lives |
| --- | --- | --- |
| Receiver | Accept a message, API call or external event and authenticate its origin. | Your app / existing adapter |
| Storage | Persist configuration, business data, task history and access policy. | Your app / existing datastore |
| Harness | Load ordinary Skills, reason when needed, invoke tools and produce results. | Existing DSH inside a fresh sandbox |
| CLI / API capabilities | Perform the real operations, with enforcement at the actual data and service boundary. | Existing tools and services |

Harness Bridge connects these responsibilities through a small concrete binding. It
keeps stable, approved operations on the application's normal code path;
flexible Agent work goes through an isolated Harness. Moving a repeatedly used
method from Skill guidance into reviewed code is an application development
choice. There is no automatic Skill compiler or promotion pipeline here.

A decision model such as JEV can eventually help an application select an
approved action. It is optional application policy, not a required framework
concept, permission authority or an implemented bridge feature.

## What works today

- `createHarnessBridge(options).execute(trustedRequest, signal?)` with TypeScript declarations.
- Required host admission, native-call and result authorization callbacks.
- A fresh OpenShell sandbox for each task, with native ID, name, workspace and ownership checks.
- An optional ordinary `SKILL.md`, a host-prepared DSH patch and prompt submission through stdin.
- Bounded native commands and output, task cancellation, and cleanup with a separate deadline.
- Separate execution / cleanup evidence. Uncertain cleanup remains blocked; the instance is never reused.
- A thin Koishi consumer using real Koishi command dispatch with synthetic messages, including scoped cancellation and bounded shutdown.

The binding targets **OpenShell CLI 0.1.3 behavior** and
**`@deepseek-ai/dsh@0.2.0-rc.2`**. Other versions and Harnesses require their own
contract and live validation. The only isolation path in this implementation
is OpenShell + Docker.

## Try the source

Use **Node.js 24+**. This package is not published to npm.

```sh
git clone https://github.com/ailiheizi/harness-bridge.git
cd harness-bridge
npm ci --ignore-scripts
npm test

cd examples/koishi
npm ci --ignore-scripts
npm test
npm run demo
```

These checks are offline: they exercise the bridge through a fake native CLI
and Koishi through its real App / Session / MockBot. They do not start Docker,
contact a provider or send real Telegram messages.

A real host imports the library and supplies its own trusted configuration:

```js
import { createHarnessBridge } from '@actweave/harness-bridge';
import trusted from './trusted-bridge-config.mjs';

const bridge = createHarnessBridge(trusted.bridge);
const result = await bridge.execute(trusted.task, trusted.abortSignal);

if (result.status !== 'completed' || result.cleanup.status !== 'verified') {
  await trusted.recordFailure(result);
} else {
  // Recheck accounting, current permissions and the audience before delivery.
  await trusted.checkAndDeliver(result);
}
```

`trusted` is an application-owned module, not a bundled service. Install the
bridge from this source checkout with a local `file:` dependency when integrating
it into another package. The [quickstart](docs/QUICKSTART.md) explains the
required native image, policy, patch, private CLI roots and host callbacks.

## Authority and isolation

Tenant and actor IDs come from authenticated host state. Prompt text cannot
grant access. Row, field and resource permissions must be enforced by business
APIs; the bridge's callbacks are not a universal tool authorization gateway.
Only approved deterministic code belongs on the trusted host path. Generated
or untrusted code belongs in the isolated workload.

The workload must not receive host HOME, business-data or Docker-socket mounts.
Provider secrets stay in native trusted configuration. These are deployment
requirements, not assurances obtained merely by importing the library.

A `completed` result establishes the expected native DSH completion and the
bridge's cleanup condition. It does **not** prove business success, user delivery
or usage billing. `modelRequestCount` is always `null`. The current native
name-based delete also has a documented rebind race; verified cleanup does
not prove removal of all upstream roles or volumes. See [security notes](SECURITY.md).

## Evidence and remaining work

| Check | Status and scope |
| --- | --- |
| Public core suite | **46/46 PASS** — clean install; fake native CLI and local contracts |
| Koishi example | **17/17 PASS**, configuration **10/10**, cancellation contracts **3/3** — offline |
| Core dependency audit | **0 known vulnerabilities** at publication check |
| Koishi dependency audit | **Known moderate advisory** in transitive `file-type`; see [dependency notes](docs/DEPENDENCIES.md) |
| Earlier private native/provider experiment | Recorded **3/3** synthetic-output roundtrips; private setup, not reproducible from this repository alone |
| Production multi-user authorization, delivery, hard budgets and restart recovery | **Not established** by this preview |

The private experiment is context, not a public acceptance certificate. The
[validation record](docs/validation.md) identifies evidence limits. The
[roadmap](docs/roadmap.md) lists the gates before broader deployment claims.

## Documentation and reuse

- [Design and core ideas](docs/design.md)
- [Architecture and lifecycle](docs/architecture.md)
- [Architecture decision records](docs/adr/)
- [Host integration quickstart](docs/QUICKSTART.md)
- [Koishi consumer example](examples/koishi/README.md)
- [Opt-in native acceptance](docs/NATIVE-ACCEPTANCE.md)
- [Dependencies and security limitations](docs/DEPENDENCIES.md)
- [Contributing](CONTRIBUTING.md)

We reuse [OpenShell](https://github.com/NVIDIA/OpenShell),
[DSH](https://github.com/deepseek-ai/deepseek-harness),
[Execa](https://github.com/sindresorhus/execa), and optional
[Koishi](https://github.com/koishijs/koishi). The original architecture artwork
learns from OpenShell's trust-boundary presentation, NanoClaw's host/agent
separation, and C4's responsibility labels. [References and differences](docs/references.md)
explain each relationship; no upstream diagram assets were copied.

[Apache-2.0](LICENSE).
