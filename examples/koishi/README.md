# Koishi thin integration example

This optional example shows one ordinary Koishi plugin calling
`bridge.execute()` from a native Koishi command. It uses the pinned Koishi core
and Koishi's mock bot to exercise real command dispatch. The included bridge
is synthetic: it does not connect Telegram, Docker/OpenShell, DSH, a model, or
production accounting.

The sample adds two commands: `isolated-summary <text>` and
`isolated-cancel`. Direct messages are rejected. A single active task is
allowed by default; further requests receive a busy response. Cancellation is
limited to an active task for the same platform, bot, group, channel, and
actor. It aborts the bridge signal and does not queue work. Once native message
sending starts, Koishi cannot guarantee that cancellation will retract it;
send attempts are never retried and are not treated as delivery receipts.

## Host integration

The authenticated Koishi application constructs the real bridge with its
private native configuration and required bridge-level callbacks, then passes
that bridge and its own current-permission callback when loading the plugin.
Use Koishi's normal plugin lifecycle:

```js
import { createHarnessBridge } from '@actweave/harness-bridge'
import { installKoishiBridge } from './src/index.mjs'
import trustedConfig from './trusted-host-config.mjs'

const bridge = createHarnessBridge(trustedConfig.bridge)
let controller
ctx.plugin((pluginContext) => {
  controller = installKoishiBridge(pluginContext, {
    bridge,
    authorize: async (action, request) => {
      // Query current app permissions here. Return exactly true to allow.
      return trustedConfig.authorize(action, request)
    },
  })
})
// During host shutdown, await this before disposing Koishi's context.
const closeResult = await controller.close()
if (closeResult.status === 'blocked') {
  throw new Error(`Harness shutdown is blocked with ${closeResult.pendingCount} active task(s)`)
}
```

`controller.close()` closes admission and aborts active work, then waits up to
`shutdownTimeoutMs` (default 90,000 ms; configurable from 1 to 180,000 ms).
It returns a frozen `{ status: 'drained', pendingCount: 0 }` only after every
tracked action finishes, or `{ status: 'blocked', pendingCount }` when the
deadline expires. Repeated calls return the same promise and result. A blocked
result leaves active entries tracked and admission closed; it does not prove
that a native sandbox was cleaned up. The adapter cannot forcibly stop an
unresponsive bridge or host process. If `sendMessage` has started, Koishi may
already be delivering the result and the adapter cannot retract it. The host
must treat `blocked` as an incomplete shutdown and apply its own escalation
policy; it must not record a clean drain or reuse the adapter as open.

`trustedConfig.bridge` contains the native CLI, workspace, image, policy,
private CLI roots, DSH patch, and bridge-level admission/native-call/result
authorization callbacks required by `createHarnessBridge`. The host owns
those paths, credentials, accounting checks, business authorization, and
plugin lifecycle. None can be supplied by a chat message. The adapter derives
tenant scope and actor only from the Koishi session's platform, bot self ID,
guild, channel, and user IDs; prompt text remains ordinary task input.

The adapter asks the host callback for admission, cancellation, and delivery
authorization and allows an action only when it returns exactly `true`.
Delivery also requires a matching task ID, successful native exit, a DSH
session ID, sandbox identity, completed execution, and verified cleanup.
Koishi owns native message delivery; this adapter does not retry send failures
and cannot claim that a send attempt proves delivery. Results are sent to the
original bot and conversation as Koishi text elements.
Adapter-native referrer metadata is snapshotted from the original Session,
following the pinned `Session.send()` argument contract; no guild ID is
invented in its place. Platform-specific routing still needs real-adapter tests.
Cancellation applies
while the task is executing or waiting for delivery authorization. Once
`sendMessage` starts, Koishi cannot guarantee that a message can be retracted.
A Koishi `dispose` hook immediately closes admission and aborts active work;
Cordis does not await async disposers, so the host should await the returned
`controller.close()` before disposing its Koishi context. A `blocked` result
means the bounded wait expired with work still active; it is not a cleanup
receipt, and no process-level or message-delivery cancellation is guaranteed.

This is a programmatic adapter example, not a Console one-click integration
for every bot or a claim that arbitrary plugins are isolated. It does not
provide a production billable model receipt; the underlying bridge reports
model request count as unknown.

## Run the synthetic example

From this directory:

```sh
npm ci
npm test
npm run test:native-config
npm run demo
```

The test suite dispatches synthetic messages through Koishi's actual App,
MockBot, session, parser, command, and send path. It emits no real identity or
prompt. The demo prints only synthetic JSON.

Run from this source checkout: the private bridge dependency is `file:../..`.
The checked-in `.npmrc` uses npm's `install-links=true` to install that package
and its dependencies as regular package files rather than following a symlink
to an already-prepared parent checkout. No registry publication is required.
The local bridge package's runtime dependency graph and packed file list do not
include Koishi or this example.

## Native target acceptance

`native-live.mjs` uses this same plugin with the real bridge, fixed OpenShell
Docker target and existing one-turn synthetic model fixture. It requires a
private synthetic config; it never falls back to the demo bridge. Run only
after the target preconditions in the [quickstart](../../docs/QUICKSTART.md)
and [native guide](../../docs/NATIVE-ACCEPTANCE.md) have been checked:

```sh
node native-live.mjs --config /absolute/private/config.mjs
```

`test:native-config` is offline. A native pass still uses MockBot, synthetic
identities and a controlled model, so it does not establish real platform
delivery, real-user isolation or production billing. Independent Docker-role
and volume cleanup must be verified by the existing trusted controller.
