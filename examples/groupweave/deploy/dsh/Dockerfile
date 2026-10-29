# Ordinary workload image for the existing DSH headless Harness.
# Build with the repository root as context; no credentials are baked in.
ARG NODE_IMAGE=node:26.5.0-slim@sha256:715e55e4b84e4bb0ff48e49b398a848f08e55daed8eb6a0ea1839ae53bc57583
FROM ${NODE_IMAGE}
ARG DSH_VERSION=0.2.0-rc.2
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "@deepseek-ai/dsh@${DSH_VERSION}" \
 && dsh --version
RUN mkdir -p /workspace /opt/actweave \
 && chown -R 1000:1000 /workspace /opt/actweave
USER 1000:1000
WORKDIR /workspace
ENV HOME=/workspace DSH_HOME=/workspace/.dsh
# OpenShell starts the workload and the bridge invokes the native dsh command.
# Per-task policy, Skill and provider patches are supplied at runtime.
CMD ["/bin/sleep", "300"]
