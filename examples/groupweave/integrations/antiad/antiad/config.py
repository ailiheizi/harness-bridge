"""Inference-only Tunables subset compatible with the private upstream scorer.

This is deliberately not the original TOML/env configuration loader. The host
supplies a bounded group-specific snapshot for one invocation.
"""
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Tunables:
    prompt_threshold: float = 0.55
    action_threshold: float = 0.90
    min_msg_len: int = 6
    prohibited_scripts: tuple[str, ...] = ()
    prohibited_scripts_min: int = 4
    stopwords: tuple[str, ...] = ()
    contact_patterns: tuple[str, ...] = ()
    contact_patterns_min: int = 1
    max_links: int = 2
    max_mentions: int = 4
    max_emoji: int = 8
    block_links_only: bool = True
    block_mentions_only: bool = True
    weights: dict[str, float] = field(default_factory=lambda: {
        "classifier": 3.0, "stopwords": 3.0, "contact_patterns": 2.5,
        "nickname": 2.5, "id_age": 1.5, "duplicate": 2.0, "meta": 1.5,
    })
