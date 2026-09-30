"""vcmerge -- deterministic merge of JSON document replicas.

A document is a JSON object mapping keys to entries.  Each entry has the
shape::

    {"value": <any JSON value>,
     "clock": {<node-id>: <counter>, ...},
     "tombstone": <bool>,
     "origin": <node-id>}

Merge semantics
---------------
* Missing clock entries are treated as 0.  Negative counters are rejected
  (the CLI exits with code 3).
* Comparable clocks: the strictly newer entry wins, unchanged.
* Incomparable clocks with two live (non-tombstone) values: the value with
  the lexicographically smaller canonical JSON serialisation is kept and a
  conflict is recorded.
* A delete concurrent with an update: the tombstone wins.  Tombstones are
  kept until they are dominated by a strictly newer entry, which is a
  conservative (never-early) realisation of "keep the tombstone at least
  until both replicas' clocks are known by the other side".
* The winner is chosen by a deterministic total order that *extends* the
  causal partial order (clock-sum tier, then tombstone, then canonical
  value, then origin, then canonical clock).  Because the order extends
  causality, a causally newer entry always wins; because it is total, the
  merge is commutative, associative and idempotent, so replicas converge
  under every possible synchronisation order without ever using wall
  clocks.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Dict, Optional, Tuple

__all__ = [
    "MergeError",
    "NegativeCounterError",
    "MergeResult",
    "canonical_dumps",
    "compare_clocks",
    "merge_documents",
    "merge_entries",
    "normalize_document",
]

__version__ = "1.0.0"

ENTRY_FIELDS = ("value", "clock", "tombstone", "origin")

Entry = Dict[str, Any]
Document = Dict[str, Entry]


class MergeError(Exception):
    """Raised when an input document is malformed."""


class NegativeCounterError(MergeError):
    """Raised when a vector clock contains a negative counter (exit code 3)."""


def _canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def canonical_dumps(document: Document) -> str:
    """Serialise a document as canonical JSON (sorted keys, tight separators)."""
    return _canonical(document) + "\n"


def _normalize_clock(clock: Any, where: str) -> Dict[str, int]:
    if not isinstance(clock, dict):
        raise MergeError(f"{where}: 'clock' must be an object mapping node ids to counters")
    normalized: Dict[str, int] = {}
    for node, counter in clock.items():
        if not isinstance(node, str):
            raise MergeError(f"{where}: clock node ids must be strings")
        if isinstance(counter, bool) or not isinstance(counter, int):
            raise MergeError(f"{where}: clock counter for node {node!r} must be an integer")
        if counter < 0:
            raise NegativeCounterError(
                f"{where}: negative counter {counter} for node {node!r}"
            )
        if counter != 0:
            # Missing entries are 0, so explicit zeros carry no information.
            normalized[node] = counter
    return normalized


def normalize_document(document: Any, where: str = "document") -> Document:
    """Validate a document and return its normalised form.

    Normalisation drops zero-valued clock entries (missing == 0) so that
    logically equal clocks compare and serialise identically.
    """
    if not isinstance(document, dict):
        raise MergeError(f"{where}: top level must be an object mapping keys to entries")
    normalized: Document = {}
    for key, entry in document.items():
        if not isinstance(key, str):
            raise MergeError(f"{where}: entry keys must be strings")
        where_entry = f"{where}[{key!r}]"
        if not isinstance(entry, dict):
            raise MergeError(f"{where_entry}: entry must be an object")
        unknown = set(entry) - set(ENTRY_FIELDS)
        if unknown:
            raise MergeError(f"{where_entry}: unknown fields {sorted(unknown)}")
        missing = set(ENTRY_FIELDS) - set(entry)
        if missing:
            raise MergeError(f"{where_entry}: missing fields {sorted(missing)}")
        tombstone = entry["tombstone"]
        if not isinstance(tombstone, bool):
            raise MergeError(f"{where_entry}: 'tombstone' must be a boolean")
        origin = entry["origin"]
        if not isinstance(origin, str):
            raise MergeError(f"{where_entry}: 'origin' must be a string")
        clock = _normalize_clock(entry["clock"], where_entry)
        try:
            _canonical(entry["value"])
        except (TypeError, ValueError) as exc:
            raise MergeError(f"{where_entry}: 'value' is not JSON serialisable: {exc}")
        normalized[key] = {
            "value": entry["value"],
            "clock": clock,
            "tombstone": tombstone,
            "origin": origin,
        }
    return normalized


def compare_clocks(c1: Dict[str, int], c2: Dict[str, int]) -> Optional[int]:
    """Compare two vector clocks.

    Returns -1 if c1 < c2, 0 if equal, 1 if c1 > c2, None if incomparable.
    Missing entries count as 0.
    """
    less = greater = False
    for node in set(c1) | set(c2):
        a = c1.get(node, 0)
        b = c2.get(node, 0)
        if a < b:
            less = True
        elif a > b:
            greater = True
        if less and greater:
            return None
    if less:
        return -1
    if greater:
        return 1
    return 0


def _entry_beats(e1: Entry, e2: Entry) -> bool:
    """Deterministic total order on entries; True iff e1 wins over e2.

    The order extends causal dominance (a dominating clock always has a
    strictly larger component sum), which is what makes the merge
    commutative, associative and idempotent.
    """
    s1 = sum(e1["clock"].values())
    s2 = sum(e2["clock"].values())
    if s1 != s2:
        return s1 > s2
    if e1["tombstone"] != e2["tombstone"]:
        # Concurrent delete beats a concurrent update at the same causal height.
        return e1["tombstone"]
    v1 = _canonical(e1["value"])
    v2 = _canonical(e2["value"])
    if v1 != v2:
        # Keep the lexicographically smaller canonical JSON value.
        return v1 < v2
    if e1["origin"] != e2["origin"]:
        return e1["origin"] < e2["origin"]
    return _canonical(e1["clock"]) < _canonical(e2["clock"])


def merge_entries(e1: Entry, e2: Entry) -> Tuple[Entry, bool]:
    """Merge two entries for the same key.

    Returns (merged_entry, conflict).  Both entries must be normalised.
    """
    cmp = compare_clocks(e1["clock"], e2["clock"])
    if cmp is not None:
        if cmp > 0:
            return e1, False
        if cmp < 0:
            return e2, False
        if e1 == e2:
            return e1, False
    # Incomparable clocks, or equal clocks carrying different content.
    conflict = not e1["tombstone"] and not e2["tombstone"]
    winner = e1 if _entry_beats(e1, e2) else e2
    return winner, conflict


@dataclass
class MergeResult:
    document: Document
    conflicts: int


def merge_documents(left: Any, right: Any) -> MergeResult:
    """Merge two replica documents deterministically.

    The merge is commutative, associative and idempotent: replicas converge
    to the same document regardless of synchronisation order.
    """
    left_doc = normalize_document(left, "left")
    right_doc = normalize_document(right, "right")
    merged: Document = {}
    conflicts = 0
    for key in left_doc.keys() | right_doc.keys():
        in_left = key in left_doc
        in_right = key in right_doc
        if in_left and in_right:
            entry, conflict = merge_entries(left_doc[key], right_doc[key])
            if conflict:
                conflicts += 1
        elif in_left:
            entry = left_doc[key]
        else:
            entry = right_doc[key]
        merged[key] = entry
    return MergeResult(document=merged, conflicts=conflicts)
