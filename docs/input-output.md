# Follow a task from input to output

This example is synthetic documentation, not a live Telegram receipt. It
shows the existing bridge API and the host work around it. The diagram's
Telegram, HTTP and external-event entrypoints are host-owned integrations;
the library does not install a bot, HTTP endpoint, natural-language router or
business-data gateway.

## 1. User input and trusted task context

A user asks a host application to summarize this text:

> Release approved. Tests passed. Deploy Friday.

The host authenticates the actor, identifies the conversation/tenant, checks
current permission and builds the bridge request. Identity is never extracted
from the prompt. For example:

```json
{
  "taskId": "demo-task",
  "tenantId": "demo-group",
  "actorId": "demo-actor",
  "prompt": "Summarize in one sentence: Release approved. Tests passed. Deploy Friday.",
  "skillPath": "/app/skills/summarize/SKILL.md"
}
```

The IDs and path are placeholders. `skillPath` is optional and points to an
application-owned, ordinary Skill on the trusted host. Native CLI roots,
image, policy, DSH patch, configured provider names and required callbacks
come from separate trusted options, not user input. This is a JavaScript
request object; no equivalent built-in HTTP route is claimed.

## 2. What the binding does

| Input | Operation | Observable result |
| --- | --- | --- |
| Trusted task and provider names | Ask host admission callback | Admission allowed or denied |
| Native image, policy, ownership labels | Create and inspect a new OpenShell Docker sandbox | Verified native ID/name/workspace/labels |
| Optional Skill and host-prepared DSH patch | Upload task-scoped configuration | Native upload results |
| Prompt string | Run fixed DSH headless command through native exec; prompt is stdin | Final text, completion event, session ID and native exit code |
| Owned sandbox identity | Stop, verify stopped, delete and check generated name absence | Verified cleanup or blocked uncertainty |
| Result and trusted task context | Ask host result authorization callback | Result release or blocked return without output |

DSH uses its own model and tool interfaces. Tool registration, model routing,
business operations and the Agent loop are not implemented by this bridge.
The optional Skill can describe a method; it cannot grant permissions or add
a tool that the Harness does not have.

Malformed configuration can throw before a bridge is created. Invalid task
fields can reject `execute()` before a native sandbox is created. The host must
handle those exceptions as well as the structured results below; it must not
assume every invalid call resolves to a `BridgeResult`.

## 3. Structured output to the host

An illustrative successful result has the existing `BridgeSuccess` shape:

```json
{
  "taskId": "demo-task",
  "status": "completed",
  "output": "Tests passed; the release is approved for Friday.",
  "sandbox": {
    "id": "demo-native-id",
    "name": "aw-synthetic",
    "workspace": "default"
  },
  "cleanup": { "status": "verified" },
  "evidence": {
    "execution": "verified",
    "cleanup": "verified",
    "modelRequestCount": null,
    "dshSessionId": "demo-session",
    "nativeExitCode": 0
  }
}
```

These identifiers and output are example values, not recorded execution proof.
The full type definitions are in [index.d.mts](../index.d.mts).

| Outcome | What the host receives | What it must not infer |
| --- | --- | --- |
| `completed` | Output, native identity, execution and cleanup evidence | Business correctness, a billing receipt, or user delivery |
| `failed` | A stage/code and available evidence; no success output | That an Agent completed the intended business action |
| `blocked` | A stage/code and available evidence; no success output | That uncertain cleanup, revoked permission or denied release can be ignored |

The host checks any required independent accounting receipt and the current
result audience before replying in the original conversation. The displayed
summary is a host delivery step, not a second return channel from the sandbox.
Fixed, approved operations can remain on the host's normal code/plugin path;
they do not need this Agent execution path or an invented model call.

See [architecture](architecture.md), [Koishi integration](../examples/koishi/README.md)
and [reuse boundaries](reuse.md).
