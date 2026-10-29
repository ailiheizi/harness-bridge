"""Fixed, one-shot, stdin/stdout inference adapter. Never starts a Telegram bot.

The deployment administrator chooses the absolute trusted model path. A joblib
model is executable pickle content: this is NOT an untrusted model upload API.
"""
from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import sys
import warnings

INPUT_LIMIT = 16_384
OUTPUT_LIMIT = 8_192


class BoundaryError(Exception):
    def __init__(self, code: str) -> None:
        self.code = code


def exact_keys(value: object, required: set[str], optional: set[str] = set()) -> dict:
    if not isinstance(value, dict) or set(value) - required - optional or required - set(value):
        raise BoundaryError("INVALID_INPUT")
    return value


def string(value: object, max_bytes: int) -> str:
    if not isinstance(value, str) or len(value.encode("utf-8")) > max_bytes:
        raise BoundaryError("INVALID_INPUT")
    return value


def probability(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 < value <= 1:
        raise BoundaryError("INVALID_INPUT")
    return float(value)


def request() -> dict:
    raw = sys.stdin.buffer.read(INPUT_LIMIT + 1)
    if len(raw) > INPUT_LIMIT:
        raise BoundaryError("INPUT_LIMIT")
    try:
        obj = json.loads(raw.decode("utf-8"), parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (ValueError, UnicodeError):
        raise BoundaryError("INVALID_INPUT") from None
    obj = exact_keys(obj, {"text", "rules", "message"})
    text = string(obj["text"], 8_192)
    if not text.strip():
        raise BoundaryError("INVALID_INPUT")
    rules = exact_keys(obj["rules"], {"promptThreshold", "actionThreshold", "stopwords"})
    prompt = probability(rules["promptThreshold"])
    action = probability(rules["actionThreshold"])
    if action < prompt:
        raise BoundaryError("INVALID_INPUT")
    words = rules["stopwords"]
    if not isinstance(words, list) or len(words) > 50:
        raise BoundaryError("INVALID_INPUT")
    words = [string(word, 320).strip() for word in words]
    if any(not word or len(word) > 80 for word in words):
        raise BoundaryError("INVALID_INPUT")
    message = exact_keys(obj["message"], {"userId", "fullName", "username", "isForward"})
    user_id = message["userId"]
    if isinstance(user_id, bool) or not isinstance(user_id, int) or not 0 <= user_id <= 9_007_199_254_740_991:
        raise BoundaryError("INVALID_INPUT")
    if not isinstance(message["isForward"], bool):
        raise BoundaryError("INVALID_INPUT")
    return {
        "text": text, "prompt": prompt, "action": action, "stopwords": words,
        "user_id": user_id, "full_name": string(message["fullName"], 256),
        "username": string(message["username"], 128), "is_forward": message["isForward"],
    }


def load_model(path: str):
    # Keep the original package name for existing antiad.model.TextClassifier
    # joblib compatibility; no production bot/config/db modules are importable.
    from antiad.model import ClassifierBundle, TextClassifier
    from sklearn.exceptions import InconsistentVersionWarning

    model_path = Path(path)
    if not model_path.is_absolute() or not model_path.is_file() or not os.access(model_path, os.R_OK):
        raise BoundaryError("MODEL_UNAVAILABLE")
    with warnings.catch_warnings():
        # A model saved by another sklearn version must be revalidated/re-exported
        # before deployment, not silently presented as a ready classifier.
        warnings.simplefilter("error", InconsistentVersionWarning)
        model = TextClassifier.load(model_path)
    bundle = ClassifierBundle(message=model)
    if not bundle.ready:
        raise BoundaryError("MODEL_UNAVAILABLE")
    # Probe actual inference, not merely the presence of two attributes.
    prob = bundle.spam_probability("deployment readiness probe")
    sim = bundle.spam_similarity("deployment readiness probe")
    if not math.isfinite(prob) or not 0 <= prob <= 1 or not math.isfinite(sim) or not 0 <= sim <= 1.000001:
        raise BoundaryError("MODEL_UNAVAILABLE")
    return bundle


def classify(bundle, obj: dict) -> dict:
    from antiad.config import Tunables
    from antiad.scoring import Scorer, MessageContext, count_links, count_mentions, count_emoji

    tun = Tunables(prompt_threshold=obj["prompt"], action_threshold=obj["action"], stopwords=tuple(obj["stopwords"]))
    ctx = MessageContext(
        chat_id=0, user_id=obj["user_id"], text=obj["text"],
        full_name=obj["full_name"], username=obj["username"], is_forward=obj["is_forward"],
        link_count=count_links(obj["text"]), mention_count=count_mentions(obj["text"]), emoji_count=count_emoji(obj["text"]),
    )
    verdict = Scorer(bundle).score(ctx, tun)
    # Cosine products can exceed one by a floating-point epsilon on an exact
    # reference match. Reject invalid model values, clamp only that epsilon.
    if any(not math.isfinite(item.score) or not -0.000001 <= item.score <= 1.000001 for item in verdict.contributions):
        raise BoundaryError("CLASSIFIER_FAILURE")
    # Recommendations do not execute moderation. Content evidence remains
    # required for the high-confidence band; identity alone cannot grant it.
    recommendation = "allow"
    if verdict.total >= obj["prompt"]:
        recommendation = "review"
    if verdict.total >= obj["action"] and verdict.content_score >= obj["prompt"]:
        recommendation = "high-confidence-review"
    return {
        "version": 1, "classifierReady": True, "total": verdict.total,
        "contentScore": verdict.content_score, "recommendation": recommendation,
        "contributions": [{"name": item.name, "score": min(1.0, max(0.0, item.score)), "weight": item.weight} for item in verdict.contributions],
    }


def write(payload: dict) -> None:
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    if len(raw.encode("utf-8")) > OUTPUT_LIMIT:
        raise BoundaryError("OUTPUT_LIMIT")
    sys.stdout.write(raw + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--model", required=True)
    parser.add_argument("--probe", action="store_true")
    args = parser.parse_args()
    try:
        obj = None if args.probe else request()
        bundle = load_model(args.model)
        write({"version": 1, "classifierReady": True} if args.probe else classify(bundle, obj))
        return 0
    except BoundaryError as error:
        write({"version": 1, "error": error.code})
        return 2
    except (ImportError, ModuleNotFoundError):
        write({"version": 1, "error": "DEPENDENCY_UNAVAILABLE"})
        return 2
    except Exception:
        # Never return traceback, model path, group rules, message or identity.
        write({"version": 1, "error": "CLASSIFIER_FAILURE"})
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
