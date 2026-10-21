# References and reuse

Harness Bridge's current implementation is a thin binding around existing projects.
The architecture artwork in this repository is original SVG; no upstream logos,
illustrations or diagram assets are bundled.

| Source | What we reuse or learn | Boundary in this project |
| --- | --- | --- |
| [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) and its [architecture guide](https://docs.nvidia.com/openshell/latest/about/architecture) | Native sandbox lifecycle, Docker isolation, policy enforcement and native provider configuration; show trusted supervision separately from agent workload. | The current adapter targets CLI 0.1.3 behavior. Current upstream documentation describes a newer system; it does not prove that all upstream features exist in the tested stack. No alternative isolation backend is added here. |
| [DeepSeek DSH](https://github.com/deepseek-ai/deepseek-harness) | Existing headless Agent Harness, ordinary Skill loading, tools and session events. | The tested Harness is `@deepseek-ai/dsh@0.2.0-rc.2`. Harness Bridge does not copy the Agent loop, implement provider routing or promise compatibility with arbitrary Harnesses. |
| [Koishi](https://github.com/koishijs/koishi) | Existing plugin/context/command system, with native mock-based tests for the thin consumer example. | Koishi is an example host, not a dependency of the bridge core. In-process Koishi plugins are not isolated by this library. |
| [Execa](https://github.com/sindresorhus/execa) | Argument-based subprocess calls, cancellation and bounded output. | Used for the specific OpenShell CLI adapter. There is no caller-supplied arbitrary command endpoint. |
| [NanoClaw](https://github.com/nanocoai/nanoclaw), especially its [architecture notes](https://github.com/nanocoai/nanoclaw/blob/main/docs/architecture.md) | Make the host/agent boundary visible and keep responsibilities readable. | This is a conceptual comparison, not a copied implementation. Its host, session storage, channel orchestration and container communication are outside this library's scope. Its architecture notes identify themselves as a draft. |
| [C4 container diagrams](https://c4model.com/diagrams/container) | Label responsibilities, communicating components and system boundaries instead of drawing unlabeled boxes. | Our README image combines an overview with an execution trust boundary; it is not a formal C4 deployment specification. A C4 container is a software abstraction, not necessarily a Docker container. |

These references explain design choices, not a claim of novelty, superiority,
a security audit, endorsement or an apples-to-apples performance comparison.

See [design](design.md), [architecture](architecture.md) and the
[decision records](adr/) for the project's own choices and limits.
