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
```

Build or import the image into the Docker image store used by your existing
OpenShell driver. Use the resulting immutable `sha256:...` image ID in the
protected application provider configuration; a local image in an unrelated
Docker daemon is not sufficient. Match the workload architecture to that
driver. OpenShell itself must already be installed and running on a compatible
Linux host; follow its [official sandbox guide](https://docs.nvidia.com/openshell/v0.1.3/how-it-works/sandboxes/overview).

The image uses the same DSH and Node base versions as the recorded live case.
This public recipe omits private test fixtures and credentials. The repository
packaging check does not rebuild or re-accept every upstream DSH function;
recorded real-task evidence is described in the application acceptance notes.

For a complete application-to-sandbox call, configure the existing
[Sub2API/OpenAI-compatible binding](../../integrations/sub2api-openshell/README.md)
and its loopback gateway/meter routes. The real model key stays in the trusted
application; only a one-task admission credential reaches the sandbox.

For direct calls without the Bot UI, use the root
[`createHarnessBridge`](../../../../index.mjs) API and
[binding quickstart](../../../../docs/QUICKSTART.md). Receivers and final result
delivery remain the caller's responsibility.
