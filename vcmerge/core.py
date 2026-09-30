"""Deterministic convergence core for vcmerge.

A document is a JSON object mapping keys to entries.  Each entry carries

    value     : any JSON value (null when tombstoned)
    clock     : {node: counter} vector clock of the winning update(s)
    tombstone : bool, True when the key is deleted
    origin    : node id of the winning update
    conflict  : bool, True when concurrent non-delete updates were resolved
    versions  : list of concurrent maximal update records, the source of truth

Merging keeps the set of causally maximal versions per key and derives the
visible fields deterministically from that set.  This makes merge a
join-semilattice: commutative, associative and idempotent, so replicas
converge under any synchronisation order without wall-clock tie-breaking.
"""

from __future__ import annotations

import json


class MergeError(Exception):
    """Base class for vcmerge errors; ``exit_code`` is used by the CLI."""

    exit_code = 1


class DocumentError(MergeError):
    """Malformed document structure."""

    exit_code = 2


class NegativeClockError(MergeError):
    """A vector clock contains a negative counter."""

    exit_code = 3


def canonical_dumps(obj):
    """Canonical JSON serialisation used for output and comparisons."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


# ---------------------------------------------------------------------------
# validation


def _validate_clock(clock, where):
    if clock is None:
        return {}
    if not isinstance(clock, dict):
        raise DocumentError(f"{where}: clock must be an object")
    out = {}
    for node, counter in clock.items():
        if not isinstance(node, str):
            raise DocumentError(f"{where}: clock node ids must be strings")
        if isinstance(counter, bool) or not isinstance(counter, int):
            raise DocumentError(f"{where}: counter for node {node!r} must be an integer")
        if counter < 0:
            raise NegativeClockError(f"{where}: negative counter for node {node!r}")
        if counter > 0:
            out[node] = counter
    return out


def _validate_version(raw, where):
    if not isinstance(raw, dict):
        raise DocumentError(f"{where}: version must be an object")
    tombstone = raw.get("tombstone", False)
    if not isinstance(tombstone, bool):
        raise DocumentError(f"{where}: tombstone must be a boolean")
    origin = raw.get("origin", "")
    if origin is None:
        origin = ""
    if not isinstance(origin, str):
        raise DocumentError(f"{where}: origin must be a string")
    return {
        "value": raw.get("value"),
        "clock": _validate_clock(raw.get("clock", {}), where),
        "tombstone": tombstone,
        "origin": origin,
    }


# ---------------------------------------------------------------------------
# vector clocks (missing entries count as 0)


def _clock_join(c1, c2):
    out = dict(c1)
    for node, counter in c2.items():
        if counter > out.get(node, 0):
            out[node] = counter
    return out


def _dominates(c1, c2):
    """True iff c1 >= c2 pointwise and strictly greater somewhere."""
    greater = False
    for node in set(c1) | set(c2):
        a, b = c1.get(node, 0), c2.get(node, 0)
        if a < b:
            return False
        if a > b:
            greater = True
    return greater


# ---------------------------------------------------------------------------
# version-set join


def _version_identity(v):
    return canonical_dumps([v["clock"], v["value"], v["tombstone"], v["origin"]])


def _version_tiebreak(v):
    return (0 if v["tombstone"] else 1, canonical_dumps(v["value"]), v["origin"])


def _join_versions(left, right):
    """Join two lists of versions into the set of causally maximal ones."""
    unique = {}
    for v in left + right:
        unique.setdefault(_version_identity(v), v)
    versions = list(unique.values())
    maximal = [
        v for v in versions
        if not any(_dominates(u["clock"], v["clock"]) for u in versions)
    ]
    # Distinct updates may share a clock (malformed histories); collapse
    # equal clocks to a single deterministic representative.
    by_clock = {}
    for v in maximal:
        key = canonical_dumps(v["clock"])
        current = by_clock.get(key)
        if current is None or _version_tiebreak(v) < _version_tiebreak(current):
            by_clock[key] = v
    return sorted(by_clock.values(), key=_version_tiebreak)


def _derive_entry(versions):
    clock = {}
    for v in versions:
        clock = _clock_join(clock, v["clock"])
    tombstones = [v for v in versions if v["tombstone"]]
    if tombstones:
        # A delete concurrent with any update wins; only a causally newer
        # update (which would have dominated the tombstone) can revive a key.
        winner = min(tombstones, key=_version_tiebreak)
        tombstone, value, conflict = True, None, False
    else:
        winner = min(versions, key=lambda v: (canonical_dumps(v["value"]), v["origin"]))
        tombstone, value = False, winner["value"]
        conflict = len(versions) > 1
    return {
        "value": value,
        "clock": clock,
        "tombstone": tombstone,
        "origin": winner["origin"],
        "conflict": conflict,
        "versions": versions,
    }


def _normalize_entry(raw, where):
    if not isinstance(raw, dict):
        raise DocumentError(f"{where}: entry must be an object")
    if "versions" in raw:
        raws = raw["versions"]
        if not isinstance(raws, list) or not raws:
            raise DocumentError(f"{where}: versions must be a non-empty list")
        versions = _join_versions([_validate_version(v, where) for v in raws], [])
    else:
        versions = [_validate_version(raw, where)]
    return _derive_entry(versions)


# ---------------------------------------------------------------------------
# public API


def merge_documents(left, right):
    """Merge two parsed JSON documents into their deterministic join."""
    if not isinstance(left, dict) or not isinstance(right, dict):
        raise DocumentError("document must be a JSON object mapping keys to entries")
    out = {}
    for key in set(left) | set(right):
        where = f"entry {key!r}"
        if key in left and key in right:
            lv = _normalize_entry(left[key], where)["versions"]
            rv = _normalize_entry(right[key], where)["versions"]
            out[key] = _derive_entry(_join_versions(lv, rv))
        elif key in left:
            out[key] = _normalize_entry(left[key], where)
        else:
            out[key] = _normalize_entry(right[key], where)
    return out


def count_conflicts(document):
    return sum(1 for entry in document.values() if entry.get("conflict"))


def dump_document(document):
    return canonical_dumps(document) + "\n"
