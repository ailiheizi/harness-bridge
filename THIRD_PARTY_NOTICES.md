# Third-party notices

## Application integrations

The complete GroupWeave example reuses published Koishi, grammY, Fastify,
DSH, React/Vite, Sharp, pdf-lib, FFmpeg and rendering/RSS/schedule integrations.
Its lockfile records package versions; installed upstream packages retain
their own licenses. Repository code does not replace those upstream terms.
The example's `patches/README.md` records the small versioned compatibility
patches. OpenShell and DSH remain external projects with their own licenses.

The optional legacy antiad classifier implementation and production models are
not included in the public case. Its adapter guide describes the separately
supplied implementation requirement; no redistribution license for the private
legacy modules is asserted.

## Diagram icons

The generated documentation diagrams embed paths from these pinned icon sets:

| Icon set | Package | License / notice | Use |
| --- | --- | --- | --- |
| Lucide | `@iconify-json/lucide@1.2.147` | [ISC and included Feather MIT notices](assets/licenses/lucide.txt) | Task, authorization, Agent, result and capacity symbols |
| Simple Icons | `@iconify-json/simple-icons@1.2.100` | [CC0-1.0](assets/licenses/simple-icons.txt) | Telegram and Docker integration marks |

Icon sets are loaded locally by Mermaid CLI; the exported SVG/PNG files do not
fetch external icon URLs. The documentation-only dependencies are separate
from the bridge runtime. Package lockfiles pin the icon data used to build the
figures. Branding identifies integrations and does not imply endorsement.

Upstream sources: [Lucide](https://github.com/lucide-icons/lucide) and
[Simple Icons](https://github.com/simple-icons/simple-icons).
