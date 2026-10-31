# Existing DSH workload image

This is an ordinary OCI image containing the shipped DSH headless Harness.
OpenShell owns the Docker sandbox lifecycle; GroupWeave supplies each task's
policy, Skill, provider profile and patch through the existing binding. There
is no new executor, Agent loop, or sandbox backend in this directory.

From the repository root:

```sh
docker build -f examples/groupweave/deploy/dsh/Dockerfile \
  -t groupweave-dsh:0.2.0-rc.2 .
docker image inspect groupweave-dsh:0.2.0-rc.2 --format '{{.Id}}'
docker run --rm --network none --entrypoint node groupweave-dsh:0.2.0-rc.2 --version
docker run --rm --network none --entrypoint dsh groupweave-dsh:0.2.0-rc.2 --version
```

Build or import the image into the Docker image store used by your existing
OpenShell driver. Use the resulting immutable `sha256:...` image ID in the
protected application provider configuration; a local image in an unrelated
Docker daemon is not sufficient. Match the workload architecture to that
driver. OpenShell itself must already be installed and running on a compatible
Linux host; follow its [official sandbox guide](https://docs.nvidia.com/openshell/v0.1.3/how-it-works/sandboxes/overview).

The recipe pins Node 26.13.0 by image digest and DSH 0.2.0-rc.2. Image tags
are build conveniences: use the inspected immutable image ID in the protected
provider JSON, and record the actual versions on the target architecture.
When upgrading Node or the exporter, build a new image and update that reviewed
binding explicitly; merely rebuilding a mutable tag does not update the JSON.
This public recipe omits private test fixtures and credentials. The repository
packaging check does not rebuild or re-accept every upstream DSH function;
recorded real-task evidence is described in the application acceptance notes.

For a complete application-to-sandbox call, configure the existing
[Sub2API/OpenAI-compatible binding](../../integrations/sub2api-openshell/README.md)
and its loopback gateway/meter routes. The real model key stays in the trusted
application; only a one-task admission credential reaches the sandbox.
The gateway, Docker driver and native CLI must already use compatible
OpenShell 0.1.3 contracts. The production Compose binding mounts its native
mTLS client bundle into the **trusted Bot only**. Do not copy that bundle,
host HOME, provider JSON, a real model key or a Docker socket into this image
or its task workspace. The gateway's server certificate/CA and the driver's
callback configuration are external deployment prerequisites, not DSH image
settings. Public gateway health does not verify protected API authentication.

For direct calls without the Bot UI, use the root
[`createHarnessBridge`](../../../../index.mjs) API and
[binding quickstart](../../../../docs/QUICKSTART.md). Receivers and final result
delivery remain the caller's responsibility.

The image now includes the trusted `result-export.mjs` Cordis plugin. The
application's existing per-task DSH patch inserts that module by its fixed
`/opt/actweave/result-export.mjs` path. Rebuild the image before enabling this
version of Sandbox AI; an older image lacks the producer and fails closed at
download rather than manufacturing an attachment from host text.

On `session/event`, the observer tracks the committed final assistant text of
the current turn and synchronously writes `/workspace/exports/result.md` only
when `turn/end` is `completed` and the UTF-8 text is nonempty and <=64000 bytes.
It grants no model tools or additional model requests. This uses the real
`@deepseek-ai/dsh-session@0.2.0-rc.2` event contract, also consumed by the pinned
headless runner; it does not rely on the locally installed newer CLI version.

Sandbox AI opts into `dsh.downloadResult: true` on the bridge. The bridge
rechecks current task/native identity and authorizes `download`, invokes the
OpenShell v0.1.3 native `sandbox download NAME REMOTE LOCAL` command with only
the fixed export path, validates the downloaded regular file and exact final
text bytes, then cleans both the sandbox and its private temporary directory.
Result authorization covers text and attachment together. Telegram delivery
still belongs to the host and requires its current task/recipient permission;
attachment bytes are transient and must not enter the task database.

Scoped checks: `node --test test/artifact.test.mjs` at the repository root
exercises an actual producer file through a local native-CLI stand-in and
relevant denial/cleanup cases. `test/artifact-pinned-session.mjs` optionally
exercises this observer with the exact pinned upstream Session package from a
temporary install. These checks do not claim live OpenShell/Docker, provider,
or Telegram delivery.
