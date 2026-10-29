# Repository checkout setup

The example consumes the Harness Bridge package from this repository through
`file:../..`; it does not carry a packaged copy of the Bridge source. Install
the root package dependencies first, then install and build the example:

```sh
# From the Harness Bridge repository root
npm ci
cd examples/groupweave
npm ci
npm run build
```

The first install provides the root package's production dependencies. The
example's local file dependency links to the repository root, so keep this
checkout structure intact while using the example. The Dockerfile performs
both installs from a repository-root build context and keeps the app at
`/repo/examples/groupweave`; `/app` is a compatibility symlink to that folder.

For a local preview from the repository root:

```sh
docker compose -f examples/groupweave/compose.yaml up --build
```

For the native Koishi entry, copy the example environment template to a private
file and select both compose files from the repository root:

```sh
cp examples/groupweave/.env.koishi.example examples/groupweave/.env.local
docker compose --env-file examples/groupweave/.env.local \
  -f examples/groupweave/compose.yaml \
  -f examples/groupweave/compose.koishi.yaml up -d --build
```

Compose resolves the build context to the repository root, while the example
Dockerfile selects the GroupWeave files. Keep `.env.local` private and do not
commit credentials.
