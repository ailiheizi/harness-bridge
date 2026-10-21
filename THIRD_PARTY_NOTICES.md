# Diagram icon notices

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
