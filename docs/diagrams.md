# Diagram sources and rendering

Each diagram has one editable Mermaid source. SVG and PNG are generated
exports of that source, not separate manually maintained drawings.

| Purpose | Source | SVG | PNG |
| --- | --- | --- | --- |
| README system overview | [architecture.mmd](../assets/architecture.mmd) | [SVG](../assets/architecture.svg) | [PNG](../assets/architecture.png) |
| Isolation and authority | [isolation.mmd](../assets/isolation.mmd) | [SVG](../assets/isolation.svg) | [PNG](../assets/isolation.png) |
| Bounded task lifecycle | [task-lifecycle.mmd](../assets/task-lifecycle.mmd) | [SVG](../assets/task-lifecycle.svg) | [PNG](../assets/task-lifecycle.png) |

## Build

The documentation-only package in `tools/diagrams` pins Mermaid CLI and the
PNG renderer in its own lockfile. It is not imported by the bridge and does
not change the core or Koishi dependency graphs. Use Node.js 24 or newer.

The CLI loads KaTeX's stylesheet by package path. The tool package overrides
that dependency to patched `0.18.10`, matching the version used by the locked
Mermaid renderer, instead of retaining CLI 12's vulnerable `0.16` range. These
three sources contain no TeX; verify all exports after renderer upgrades.

From the repository root:

```sh
npm ci --ignore-scripts --prefix tools/diagrams
cd tools/diagrams
npx puppeteer browsers install chrome-headless-shell
npm run render
```

If an appropriate Chrome/Chromium executable is already installed, skip the
browser download and pass its path when rendering:

```sh
PUPPETEER_EXECUTABLE_PATH=/absolute/path/to/chrome npm run render
```

`render.mjs` calls the pinned Mermaid CLI for all three SVGs, then renders PNGs
from those same SVGs with Sharp. The export step preserves SVG whitespace
and flattens PNGs onto white for consistent reading. The shared `mermaid.json` keeps colors, labels
and line styles consistent. Browser configuration is written to a temporary
directory and removed after rendering; no machine-specific path is committed.

## Review changes

Edit `.mmd` sources, run the renderer, then inspect all three exports at README
and documentation scale. Commit the source and exports together. Do not patch
node coordinates or text in an exported SVG. Keep implementation claims tied
to the native contracts in `src/bridge.mjs` and `index.d.mts`.

The overview answers what calls what. The isolation view answers where trust
and authorization sit. The sequence answers when execution, cleanup and result
release occur. Policy limitations and deployment prerequisites belong in the
accompanying [architecture text](architecture.md), not long paragraphs inside
nodes. See [references](references.md) for the official examples that informed
these choices.
