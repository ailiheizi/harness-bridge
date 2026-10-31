ARG NODE_IMAGE=node:26.13.0-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39
FROM ${NODE_IMAGE} AS build
WORKDIR /repo
COPY package.json package-lock.json ./
RUN --mount=type=tmpfs,target=/root/.npm npm ci --omit=dev --no-audit --no-fund
COPY . .
WORKDIR /repo/examples/groupweave
RUN --mount=type=tmpfs,target=/root/.npm npm ci --no-audit --no-fund
RUN npm run build
RUN npm prune --omit=dev --ignore-scripts

FROM ${NODE_IMAGE} AS runtime
ARG ENABLE_ANTIAD_RUNTIME=0
ARG ENABLE_OPENSHELL_CLIENT=0
ARG ENABLE_MEDIA_RUNTIME=0
ARG ENABLE_RENDER_RUNTIME=0
ARG ENABLE_SITE_PARSER_RUNTIME=0
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4318 DATA_DIR=/data
WORKDIR /repo
# OpenShell's native upload/exec uses its system OpenSSH client. The trusted
# application can opt into this dependency; agent workloads keep their own
# independently constrained images and receive no application socket or HOME.
# Install optional system dependencies in one transaction. Retain downloaded
# archives between at most three attempts: APT's transfer retry does not cover
# every HTTP 502. Persistent failures still stop the build, with signatures on.
RUN set -eu; \
    packages=""; \
    case "$ENABLE_OPENSHELL_CLIENT" in 0) ;; 1) packages="$packages openssh-client ca-certificates" ;; *) exit 1 ;; esac; \
    case "$ENABLE_MEDIA_RUNTIME" in 0) ;; 1) packages="$packages ffmpeg" ;; *) exit 1 ;; esac; \
    case "$ENABLE_RENDER_RUNTIME" in 0) ;; 1) packages="$packages chromium fonts-noto-cjk ca-certificates" ;; *) exit 1 ;; esac; \
    case "$ENABLE_ANTIAD_RUNTIME" in 0) ;; 1) packages="$packages python3 python3-venv" ;; *) exit 1 ;; esac; \
    case "$ENABLE_SITE_PARSER_RUNTIME" in 0) ;; 1) packages="$packages python3 python3-venv ca-certificates ffmpeg" ;; *) exit 1 ;; esac; \
    if [ -n "$packages" ]; then \
      apt-get -o Acquire::Retries=3 update; \
      for attempt in 1 2 3; do \
        if apt-get -o Acquire::Retries=3 install -y --no-install-recommends $packages; then break; fi; \
        [ "$attempt" -lt 3 ] || exit 1; \
      done; \
      rm -rf /var/lib/apt/lists/*; \
    fi; \
    if [ "$ENABLE_OPENSHELL_CLIENT" = "1" ]; then ssh -V; fi; \
    if [ "$ENABLE_MEDIA_RUNTIME" = "1" ]; then ffmpeg -version && ffprobe -version; fi; \
    if [ "$ENABLE_RENDER_RUNTIME" = "1" ]; then chromium --version; fi
RUN mkdir -p /data && chown node:node /data
# Rendering remains opt-in and keeps Chromium's sandbox enabled. Installing the
# browser does not prove the deployment supports launching it.
COPY --from=build /repo/examples/groupweave/integrations/antiad/requirements.txt /opt/antiad-requirements.txt
COPY --from=build /repo/examples/groupweave/integrations/site-parser/requirements.txt /opt/site-parser-requirements.txt
RUN if [ "$ENABLE_SITE_PARSER_RUNTIME" = "1" ]; then \
      python3 -m venv /opt/site-parser && \
      /opt/site-parser/bin/pip install --no-cache-dir --require-hashes -r /opt/site-parser-requirements.txt && \
      /opt/site-parser/bin/yt-dlp --version; \
    fi
# Optional inference remains inside this one application container. The default
# image stays Node-only; model files are mounted read-only by the platform owner.
RUN if [ "$ENABLE_ANTIAD_RUNTIME" = "1" ]; then \
      python3 -c 'import sys; assert sys.version_info >= (3, 12)' && \
      python3 -m venv /opt/antiad-venv && \
      /opt/antiad-venv/bin/pip install --no-cache-dir -r /opt/antiad-requirements.txt && \
      rm -rf /var/lib/apt/lists/*; \
    elif [ "$ENABLE_ANTIAD_RUNTIME" != "0" ]; then exit 1; fi
# The app stays in its repository directory so the local file:../.. bridge link
# resolves to the real root package and its production dependencies.
COPY --from=build --chown=node:node /repo/package.json /repo/package-lock.json ./
COPY --from=build --chown=node:node /repo/index.mjs /repo/index.d.ts /repo/index.d.mts ./
COPY --from=build --chown=node:node /repo/src/bridge.mjs ./src/bridge.mjs
COPY --from=build --chown=node:node /repo/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/examples/groupweave/package.json /repo/examples/groupweave/package-lock.json ./examples/groupweave/
# The example build applies its dependency patches before pruning build-only
# tools. tsx and the native npm Installer remain production dependencies.
# Online trusted plugin writes are restricted to the mounted data directory.
COPY --from=build --chown=node:node /repo/examples/groupweave/node_modules ./examples/groupweave/node_modules
COPY --from=build --chown=node:node /repo/examples/groupweave/src ./examples/groupweave/src
COPY --from=build --chown=node:node /repo/examples/groupweave/koishi.yml ./examples/groupweave/koishi.yml
COPY --from=build --chown=node:node /repo/examples/groupweave/audited ./examples/groupweave/audited
COPY --from=build --chown=node:node /repo/examples/groupweave/integrations ./examples/groupweave/integrations
COPY --from=build --chown=node:node /repo/examples/groupweave/patches ./examples/groupweave/patches
COPY --from=build --chown=node:node /repo/examples/groupweave/dist ./examples/groupweave/dist
RUN ln -s /repo/examples/groupweave /app
WORKDIR /app
USER node
EXPOSE 4318
CMD ["npm", "start"]
