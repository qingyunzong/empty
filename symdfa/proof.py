"""Equivalence / inclusion proofs and their incremental revalidation.

A proof is a relation over product pairs together with, for each pair, the
exact alphabet segments and successors used.  It is bound to the versions
of both machines; after a transition correction the versions change and
the proof must be revalidated item by item instead of being reused as-is.
"""

from __future__ import annotations

from dataclasses import dataclass

from .dfa import DFA
from .product import (
    CheckResult, partition_segments, is_mismatch,
    EQUIVALENT, INCLUDED,
)


@dataclass(frozen=True)
class RelationItem:
    pair: tuple          # (state1 | None, state2 | None)
    segments: tuple      # tuple of (lo, hi, dst1 | None, dst2 | None)


@dataclass(frozen=True)
class Proof:
    mode: str
    version1: int
    version2: int
    items: tuple  # tuple[RelationItem, ...]


def build_proof(result: CheckResult, dfa1: DFA, dfa2: DFA) -> Proof:
    """Freeze a successful check result into a version-bound proof."""
    if result.status not in (EQUIVALENT, INCLUDED) or result.items is None:
        raise ValueError("can only build a proof from a positive result")
    items = tuple(
        RelationItem(pair=pair, segments=tuple(segs))
        for pair, segs in sorted(result.items.items(), key=lambda kv: _sort_key(kv[0]))
    )
    return Proof(mode=result.mode, version1=dfa1.version,
                 version2=dfa2.version, items=items)


def _sort_key(pair):
    return tuple(-1 if s is None else s for s in pair)


def revalidate(proof: Proof, dfa1: DFA, dfa2: DFA) -> dict:
    """Return the still-valid part of ``proof`` as a reuse cache.

    If both machine versions still match, every item is valid.  Otherwise
    each item is recomputed against the current machines and only items
    whose acceptance status and segments are unchanged survive.  The
    returned mapping (pair -> segments) can be passed as ``cache`` to
    ``product.check`` so that only invalidated pairs are re-explored.
    """
    if proof.version1 == dfa1.version and proof.version2 == dfa2.version:
        return {item.pair: item.segments for item in proof.items}
    cache = {}
    for item in proof.items:
        p, q = item.pair
        if is_mismatch(proof.mode, dfa1, dfa2, p, q):
            continue  # acceptance changed: item is void
        current = tuple(partition_segments(dfa1, dfa2, p, q))
        if current == tuple(item.segments):
            cache[item.pair] = item.segments
    return cache


# -- serialisation ---------------------------------------------------------

def proof_to_json(proof: Proof) -> dict:
    return {
        "mode": proof.mode,
        "version1": proof.version1,
        "version2": proof.version2,
        "items": [
            {
                "pair": list(item.pair),
                "segments": [list(seg) for seg in item.segments],
            }
            for item in proof.items
        ],
    }


def proof_from_json(data: dict) -> Proof:
    return Proof(
        mode=data["mode"],
        version1=int(data["version1"]),
        version2=int(data["version2"]),
        items=tuple(
            RelationItem(
                pair=tuple(item["pair"]),
                segments=tuple(tuple(seg) for seg in item["segments"]),
            )
            for item in data["items"]
        ),
    )
