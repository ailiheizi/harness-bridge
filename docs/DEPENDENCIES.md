# Dependency and audit note

This repository contains a private preview package, not a published npm
release. The core package targets Node.js 24 or newer and directly depends on
`execa@10.1.0`. The root npm lockfile pins its complete install graph. A fresh
`npm ci --ignore-scripts` followed by `npm audit` reported zero vulnerabilities
in the core package graph.

The optional Koishi example pins `@koishijs/core@4.18.11` and
`@koishijs/plugin-mock@2.6.6`; its lockfile also resolves the bridge from the
local checkout. On 2026-10-21, `npm audit` reported 11 moderate dependency
findings in the example graph. The report traces them to one `file-type`
advisory, [GHSA-5v7r-6r5c-r473](https://github.com/advisories/GHSA-5v7r-6r5c-r473)
(infinite loop parsing malformed ASF input),
through the Koishi dependency tree. The locked `file-type` version is 16.5.4.
This is an audit observation, not a claim that the example is production-safe
or a complete license/security review.

Reproduce the checks from a clean checkout:

```sh
npm ci --ignore-scripts
npm audit
npm test
cd examples/koishi
npm ci --ignore-scripts
npm audit
npm test
npm run test:native-config
node --test --test-concurrency=1 native-cancel-checks.mjs
```

Native OpenShell and live provider acceptance use private deployment
configuration and are intentionally outside CI. The Koishi checks above use
synthetic identities and mock dispatch only.
