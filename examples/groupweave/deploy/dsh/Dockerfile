# Ordinary workload image for the existing DSH headless Harness.
# Build with the repository root as context; no credentials are baked in.
ARG NODE_IMAGE=node:26.13.0-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39
FROM ${NODE_IMAGE}
ARG DSH_VERSION=0.2.0-rc.2
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "@deepseek-ai/dsh@${DSH_VERSION}" \
 && dsh --version
RUN mkdir -p /workspace /opt/actweave \
 && chown -R 1000:1000 /workspace /opt/actweave
COPY --chown=1000:1000 examples/groupweave/deploy/dsh/result-export.mjs /opt/actweave/result-export.mjs
USER 1000:1000
WORKDIR /workspace
ENV HOME=/workspace DSH_HOME=/workspace/.dsh
# OpenShell starts the workload and the bridge invokes the native dsh command.
# Per-task policy, Skill and provider patches are supplied at runtime.
CMD ["/bin/sleep", "300"]
