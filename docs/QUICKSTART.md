# Quickstart

This is a source integration guide for the current preview, not a one-click
installer. The host must already have a trusted OpenShell CLI configuration,
an OpenShell workspace and policy, a prepared workload image containing the
pinned DSH headless Harness, and an app-owned DSH patch. The current binding
targets OpenShell CLI v0.1.3 behavior and DSH `@deepseek-ai/dsh@0.2.0-rc.2`.
Other versions require their own contract and live validation.

Use Node.js 24 or later. This package is not published to npm. Start from a
source checkout:

```sh
git clone https://github.com/ailiheizi/harness-bridge.git
cd harness-bridge
npm ci --ignore-scripts
npm test
```

In another application, add `"@actweave/harness-bridge": "file:../harness-bridge"`
to its dependencies (adjust the path to this checkout), then run `npm install`.
The included Koishi example uses `file:../..` and requires no registry release.
To keep the consumer independent of the checkout layout, package the existing
library rather than copying the Bot:

```sh
# In the source checkout; this emits actweave-harness-bridge-0.1.6-preview.1.tgz
npm pack --ignore-scripts
# In your own application directory; adjust the absolute checkout path
npm install --ignore-scripts /absolute/path/harness-bridge/actweave-harness-bridge-0.1.6-preview.1.tgz
```

The archive contains the Bridge entrypoint, runtime, types, README and license;
it does not bundle GroupWeave, Docker, OpenShell, DSH or private deployment
configuration. Package version `0.1.6-preview.1` was installed from its archive
into a separate temporary consumer on 2026-10-31, then imported and called
through one synthetic native-CLI completion/cleanup example. This checks
packaging, not a new real-provider run. The package remains unpublished to npm.

Create a private host configuration module. Keep native
credentials in OpenShell's trusted configuration; never place them in the
request, prompt, image, or arbitrary environment variables.

## Host call

```js
import { createHarnessBridge } from '@actweave/harness-bridge';
import trusted from './trusted-bridge-config.mjs';

const bridge = createHarnessBridge({
  native: trusted.native,
  dsh: trusted.dsh,
  limits: { totalTimeoutMs: 120_000, commandTimeoutMs: 20_000 },
  authorizeAdmission: ({ request, providerNames }) =>
    trusted.authorizeAdmission(request, providerNames),
  authorizeNativeCall: (context) => trusted.authorizeNativeCall(context),
  authorizeResult: ({ request, result }) =>
    trusted.authorizeResult(request, result),
});

const result = await bridge.execute({
  taskId: task.id,
  tenantId: session.tenantId,
  actorId: session.userId,
  prompt: task.prompt,
  skillPath: task.skillPath,
}, abortSignal);

if (result.status !== 'completed' || result.cleanup.status !== 'verified') {
  return trusted.recordAndReport(result);
}

// The host still applies any required trusted usage/accounting and current
// permission/audience checks before it releases output to a user.
return trusted.checkAndDeliver(result);
```

The `task`, `session`, and `trusted` names above are host-owned examples. The
application must construct the IDs from authenticated state; callbacks must
read current policy where needed. A resolved bridge call does not imply that
`checkAndDeliver` should approve the result. Do not deliver a blocked result or
an unverified cleanup as success.

## Configuration fields

`native` requires absolute `cliPath`, `policyPath`, private `home` and
`xdgConfigHome` paths, a logical OpenShell `workspace`, and the target `image`.
Optional `gatewayEndpoint` is a non-secret endpoint; `providers` names existing
OpenShell providers and does not contain credentials. `dsh.patchPath` must be
an absolute path to the host-prepared patch; optional `skillRoot` selects the
remote root where an optional ordinary Skill is uploaded. `limits` may set
positive integer `totalTimeoutMs`, `commandTimeoutMs`, and `maxOutputBytes`.
Optional `dsh.downloadResult: true` collects only `/workspace/exports/result.md`,
a regular UTF-8 file of at most 64,000 bytes matching the verified final text.
The workload must include the existing [DSH completion observer](../examples/groupweave/deploy/dsh/README.md).
The host receives bytes in `result.artifact` after result authorization; it owns
any persistence or platform delivery.

The bridge fixes the native CLI command shape, path/environment inheritance,
and DSH invocation. It does not accept arbitrary shell strings or caller
environment. The chosen policy, image, patch, provider setup, and host paths
must be reviewed and prepared by the deployment owner.

## Local package checks

From the repository root, run `npm test`. These tests use a fake native CLI and
verify the library contract; they do not start OpenShell, DSH, a model, or a
real platform adapter. For the optional Koishi source example, follow its
README and keep its synthetic checks separate from native acceptance.

For a native synthetic run, read [native acceptance](NATIVE-ACCEPTANCE.md) and
the [validation notes](validation.md) first. No generic fixture server,
provider installer, OpenShell policy, or private target configuration is
included here.
