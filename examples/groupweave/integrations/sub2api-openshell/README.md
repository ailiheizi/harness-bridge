# Sub2API + OpenShell deployment binding

This binding connects GroupWeave's existing Docker/DSH sandbox executor to one
fixed Sub2API OpenAI-compatible endpoint. The GroupWeave application owns the
real Sub2API API key and enforces the task budget at its local egress route.
OpenShell and DSH still create and run each task sandbox; this module does not
replace them with another executor or router.

## Configure

Create a private JSON file for the application deployment. Keep it out of Git
and mount it read-only if the app runs in a container. For example:

```json
{
  "cliPath": "/opt/openshell",
  "stateDir": "/data/sub2api-control",
  "workspace": "default",
  "image": "sha256:REPLACE_WITH_64_LOWERCASE_HEX_DIGEST",
  "model": "your-enabled-model-id",
  "apiKey": "READ_FROM_YOUR_SECRET_STORE",
  "meterPort": 4319,
  "gatewayEndpoint": "http://127.0.0.1:8080",
  "upstreamUrl": "https://your-sub2api-host.example/v1"
}
```

The accepted fields are fixed:

| Field | Requirement |
| --- | --- |
| `cliPath` | Absolute path to the installed OpenShell CLI. |
| `stateDir` | Absolute, application-owned directory with mode `0700`; it stores short-lived per-task files. |
| `workspace` | OpenShell workspace name. |
| `image` | Immutable OCI image digest in `sha256:<64 lowercase hex>` form. |
| `model` | One administrator-selected model ID used for every request. |
| `apiKey` | Real Sub2API key, available only to the trusted GroupWeave application process. |
| `meterPort` | Free loopback TCP port from 1024 through 65535 for the local admission route. |
| `gatewayEndpoint` | Native OpenShell gateway URL on `127.0.0.1`, with no path, query, or credentials. |
| `upstreamUrl` | HTTPS OpenAI-compatible API URL with no credentials, query, or fragment; its trusted path must end in `/v1` or `/v1/chat/completions`. A provider prefix such as `/zen/go/v1` is retained. |
| `upstreamSessionHeader` | Optional; the only accepted value is `x-opencode-session`. When set, GroupWeave generates a fresh UUID per task lease and sends it only to the configured upstream. |

Protect the JSON file with mode `0600` and make its parent directories
non-writable by other users. The configured model and image must already be
available to the deployment. Do not put the real API key in a sandbox provider
profile, task file, prompt, command line, or container workload environment.

The deployment entry module is
[`deployment.mjs`](./deployment.mjs). Point GroupWeave at it and at the private
config file, then enable the native AI entry:

```sh
ENABLE_AI=1
SANDBOX_AI_BINDING_MODULE=/absolute/path/to/groupweave/integrations/sub2api-openshell/deployment.mjs
GROUPWEAVE_MODEL_CONFIG=/absolute/path/to/private/groupweave-sub2api.json
```

`GROUPWEAVE_MODEL_CONFIG` must be present in the GroupWeave process environment
when the deployment module loads. `SANDBOX_AI_BINDING_MODULE` must be an
absolute protected `.mjs` path. The normal native entry also requires the
platform-level `assistant` and `digest` features to be enabled before users
can invoke those capabilities.

For the existing Linux native-host deployment, include
`compose.koishi.sub2api.yaml` after `compose.yaml` and `compose.koishi.yaml`.
Set `OPENSHELL_CLI_PATH` and `GROUPWEAVE_MODEL_CONFIG_PATH` to the reviewed host
files. This overlay installs the OpenSSH client, mounts the native CLI and
private JSON read-only, and uses host networking with the app bound to
`127.0.0.1`. It does not start or replace the external OpenShell gateway.
Add `compose.koishi.render.yaml` when enabling Markdown rendering.

## OpenShell and task isolation

The configured gateway must be the native host's loopback OpenShell gateway.
The per-task OpenShell network policy exposes only
`host.openshell.internal:<meterPort>` for `POST /v1/chat/completions`; ensure
that OpenShell maps this host alias to the GroupWeave admission listener in the
same native-host network context. The admission listener itself binds only to
`127.0.0.1`. If GroupWeave runs in a separate container network namespace,
container loopback and native-host loopback are different: provide a protected
host-local forwarding arrangement or run this binding where that loopback
route is reachable. Do not expose the meter port publicly or allow the sandbox
to connect directly to the Sub2API endpoint.

Each task gets a fresh provider name, provider profile, random short-lived
bearer token, native `HOME`, and XDG config directory. The task provider contains
the random GroupWeave token and the fixed local relay URL; the real Sub2API key
stays in the application process. The relay accepts one model request for the
task, fixes the model and endpoint, removes advertised model tools, and does
not retry or follow redirects. Native `/skill` loading remains enabled; the
model receives no callable tools. DSH sandbox completion is still subject to
the existing native result and zero-tool-call checks.

Some OpenCode Go compatible endpoints require `x-opencode-session`. Configure
that exact optional header only when the selected endpoint requires it. Its
value is newly generated for each task lease; never map an incoming DSH session
or caller-provided header into it. The application key is sent separately as
the upstream Bearer credential. The default is no extra session header.

OpenShell CLI `HOME` and `XDG_CONFIG_HOME` are created as separate owner-only
`0700` directories below the protected `stateDir`, then removed with the task.
They must not point at the host user's `HOME`; the trusted sandbox binding
rejects CLI roots that overlap the application user's home.

## Evidence and compatibility

The relay receipt records one real upstream HTTP dispatch, its HTTP status, and
usage counters returned by Sub2API when present. Missing usage remains `null`.
Token usage is not a billing receipt and does not prove monetary charges or
provider-side account totals. A successful task requires the existing
task/sandbox/session-bound admission and read checks; unknown evidence remains
a failure.

The original static `SandboxBindingModule` form remains supported for existing
deployments. This integration uses the existing task-scoped
`SandboxBindingFactory` contract so each task can receive its own native
provider/profile and accounting lease. The application still invokes the
ordinary sandbox executor and DSH workflow.

The 2026-10-26 deployment was exercised through real AyuGram private `/ask`,
`/digest`, and `/translate` requests. Each returned a real model result to the
same chat with one measured dispatch and supplier usage. See
`../../docs/ACCEPTANCE-20261022-NATIVE.md` for the deployment evidence and its
remaining scope. This does not establish billing totals or long-term uptime.
