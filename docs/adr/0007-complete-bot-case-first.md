# ADR 0007: Complete the Bot case before further framework extraction

**Status:** Accepted.

**Date:** 2026-10-29, following the user's request to present the complete Bot
case in the existing repository and defer further standalone extraction.

## Context

The repository began as a small callable binding around OpenShell and DSH. It
now contains the full source of the GroupWeave Bot case, including its host
application, business policy, storage, integrations and delivery paths. Some
of that application is working and has scoped real acceptance evidence; other
features remain explicit gaps. Packaging another reusable layer before the
existing consumer case is complete would make the repository boundary less
clear without demonstrating a second consumer need.

The library still provides a useful direct host API and remains available as
such. Its existing implementation uses OpenShell's Docker lifecycle and DSH
headless Harness; GroupWeave is the complete application example. The smaller
`examples/koishi` remains a focused adapter demonstration.

## Decision

Keep the GroupWeave Bot case in this repository and finish its already scoped
features here. Keep the current library callable, but defer further framework
extraction, new packages, protocols, or a separate repository until a
demonstrated consumer requires them and the boundary is reviewed.

Do not expand this decision into a second sandbox backend, local Agent loop,
copied workflow engine, generic plugin runtime, or new authorization or
artifact protocol. Use existing OpenShell, DSH, Koishi and host application
contracts. If a required native capability is missing, record the integration
gap and deliver the Bot case only when the existing contracts support it.

## Consequences

- Repository entry documentation leads with GroupWeave and describes the
  library as its concrete, independently callable binding.
- Application responsibilities and actual code stay with GroupWeave; the
  library does not acquire bot-specific identity, persistence or delivery
  behavior.
- `examples/koishi` remains intentionally small and focused.
- Console online installation, AI sandbox artifact return, multi-turn memory,
  and broader plugin permissions remain unimplemented until delivered and
  verified. Existing fixed media workflows do not imply AI artifact return.
- Validation follows the GroupWeave scope and evidence records. Root-level
  fake-native contract tests remain evidence for the library seam, not for
  Telegram/provider behavior.

## Revisit when

A second concrete consumer or a required target-native capability provides
evidence that extraction is useful. Reconsider the boundary with that consumer
and its contracts; do not infer a need for a new framework from generality
alone.
