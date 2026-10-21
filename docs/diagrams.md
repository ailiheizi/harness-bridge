# Diagram sources and rendering

Each diagram has one editable Mermaid source. SVG and PNG are generated
exports of that source, not separate manually maintained drawings.

| Purpose | Source | SVG | PNG |
| --- | --- | --- | --- |
| README current binding (English) | [current-architecture.mmd](../assets/current-architecture.mmd) | [SVG](../assets/current-architecture.svg) | [PNG](../assets/current-architecture.png) |
| README current binding (Chinese) | [current-architecture.zh-CN.mmd](../assets/current-architecture.zh-CN.mmd) | [SVG](../assets/current-architecture.zh-CN.svg) | [PNG](../assets/current-architecture.zh-CN.png) |
| Detailed flexible-task example | [architecture.mmd](../assets/architecture.mmd) | [SVG](../assets/architecture.svg) | [PNG](../assets/architecture.png) |
| Isolation and authority | [isolation.mmd](../assets/isolation.mmd) | [SVG](../assets/isolation.svg) | [PNG](../assets/isolation.png) |
| Bounded task lifecycle | [task-lifecycle.mmd](../assets/task-lifecycle.mmd) | [SVG](../assets/task-lifecycle.svg) | [PNG](../assets/task-lifecycle.png) |
| Current preparation / proposed clean capacity | [capacity-reuse.mmd](../assets/capacity-reuse.mmd) | [SVG](../assets/capacity-reuse.svg) | [PNG](../assets/capacity-reuse.png) |

## Build

The documentation-only package in `tools/diagrams` pins Mermaid CLI and the
PNG renderer in its own lockfile. It is not imported by the bridge and does
not change the core or Koishi dependency graphs. Use Node.js 24 or newer.

The CLI loads KaTeX's stylesheet by package path. The tool package overrides
that dependency to patched `0.18.10`, matching the version used by the locked
Mermaid renderer, instead of retaining CLI 12's vulnerable `0.16` range. These
diagrams contain no TeX; verify all exports after renderer upgrades.

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

`render.mjs` calls the pinned Mermaid CLI for all six SVGs, then renders PNGs
from those same SVGs with Sharp. The export step preserves SVG whitespace
and flattens PNGs onto white for consistent reading. The shared `mermaid.json` keeps colors, labels
and line styles consistent. Locally pinned Lucide and Simple Icons packs
supply real vector icons; no icon CDN is fetched by the exported images.
See [icon notices](../THIRD_PARTY_NOTICES.md). Browser configuration is written to a temporary
directory and removed after rendering; no machine-specific path is committed.

## Review changes

Edit `.mmd` sources, run the renderer, then inspect all exports at README
and documentation scale. Commit the source and exports together. Do not patch
node coordinates or text in an exported SVG. Keep implementation claims tied
to the native contracts in `src/bridge.mjs` and `index.d.mts`.

The README images preserve the text diagram's two branches and mark current
ownership explicitly: host-provided capabilities, implemented bridge behavior,
and reused systems. The host selects its path; the library does not implement a
router or the depicted host features. Text fallbacks remain in both READMEs.

The detailed overview shows input, execution and output with a concrete host example. The isolation view answers where trust
and authorization sit. The sequence answers when execution, cleanup and result
release occur. Policy limitations and deployment prerequisites belong in the
accompanying [architecture text](architecture.md), not long paragraphs inside
nodes. The capacity view clearly separates current behavior from a proposed,
unimplemented optimization. See [references](references.md) for the official examples that informed
these choices.
