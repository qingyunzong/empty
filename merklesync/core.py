"""Core Merkle-interval sync logic for ordered key-value JSONL streams."""

from __future__ import annotations

import hashlib
import json
from bisect import bisect_left, bisect_right
from dataclasses import dataclass

# Fixed hash constant for an empty interval: sha256 of the empty byte string.
EMPTY_HASH = hashlib.sha256(b"").hexdigest()

EXIT_ORDER_ERROR = 3


class InputError(Exception):
    """Malformed input that is not an ordering violation (exit code 2)."""


class OrderError(InputError):
    """Duplicate or out-of-order keys (exit code 3)."""


def canonicalize(value) -> str:
    """Canonical JSON serialization used for hashing and comparison."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def key_order(key):
    """Total ordering for keys: numbers before strings, canonical JSON as tiebreak."""
    if isinstance(key, bool):
        return (0, float(key), canonicalize(key))
    if isinstance(key, (int, float)):
        return (0, key, canonicalize(key))
    if isinstance(key, str):
        return (1, key, canonicalize(key))
    raise InputError(f"unsupported key type: {type(key).__name__}")


def key_equal(a, b) -> bool:
    return canonicalize(a) == canonicalize(b)


class Stream:
    """A parsed, validated, canonicalized ordered key-value stream."""

    def __init__(self, entries):
        self.keys = [k for k, _ in entries]
        self.values = [v for _, v in entries]
        self.orders = [key_order(k) for k in self.keys]
        self.lines = [
            canonicalize({"key": k, "value": v}) + "\n" for k, v in entries
        ]

    def __len__(self):
        return len(self.keys)

    def interval_hash(self, lo: int, hi: int) -> str:
        """sha256 of the canonicalized substream; fixed constant when empty."""
        if lo >= hi:
            return EMPTY_HASH
        return hashlib.sha256("".join(self.lines[lo:hi]).encode("utf-8")).hexdigest()


def load_stream(path: str) -> Stream:
    """Load a JSONL file of {"key": ..., "value": ...} entries sorted by key."""
    entries = []
    try:
        fh = open(path, "r", encoding="utf-8")
    except OSError as exc:
        raise InputError(f"cannot open {path}: {exc}") from exc
    with fh:
        for lineno, raw in enumerate(fh, 1):
            if not raw.strip():
                continue
            try:
                obj = json.loads(raw)
            except json.JSONDecodeError as exc:
                raise InputError(f"{path}:{lineno}: invalid JSON: {exc}") from exc
            if not isinstance(obj, dict) or set(obj) != {"key", "value"}:
                raise InputError(
                    f"{path}:{lineno}: each line must be an object with exactly "
                    f'"key" and "value"'
                )
            entries.append((obj["key"], obj["value"]))
    for i in range(1, len(entries)):
        prev, cur = entries[i - 1][0], entries[i][0]
        if key_equal(prev, cur):
            raise OrderError(f"{path}: duplicate key {canonicalize(prev)}")
        if key_order(prev) > key_order(cur):
            raise OrderError(
                f"{path}: keys not in ascending order at line {i + 1}: "
                f"{canonicalize(prev)} > {canonicalize(cur)}"
            )
    return Stream(entries)


@dataclass
class Interval:
    """Aligned index ranges [lo, hi) of streams A and B covering one key span."""

    a_lo: int
    a_hi: int
    b_lo: int
    b_hi: int

    @property
    def is_leaf(self) -> bool:
        return (self.a_hi - self.a_lo) <= 1 and (self.b_hi - self.b_lo) <= 1


class _Engine:
    def __init__(self, a: Stream, b: Stream):
        self.a = a
        self.b = b
        self._cache = {}

    def hashes_equal(self, iv: Interval) -> bool:
        return self._hash(self.a, 0, iv.a_lo, iv.a_hi) == self._hash(
            self.b, 1, iv.b_lo, iv.b_hi
        )

    def _hash(self, stream: Stream, side: int, lo: int, hi: int) -> str:
        cache_key = (side, lo, hi)
        if cache_key not in self._cache:
            self._cache[cache_key] = stream.interval_hash(lo, hi)
        return self._cache[cache_key]

    def bisect(self, iv: Interval):
        """Split an interval at the median key of the merged key multiset."""
        merged = sorted(
            self.a.orders[iv.a_lo : iv.a_hi] + self.b.orders[iv.b_lo : iv.b_hi]
        )
        pivot = merged[len(merged) // 2]
        a_mid = bisect_left(self.a.orders, pivot, iv.a_lo, iv.a_hi)
        b_mid = bisect_left(self.b.orders, pivot, iv.b_lo, iv.b_hi)
        if a_mid == iv.a_lo and b_mid == iv.b_lo:
            # All items share the pivot order; split inclusively to guarantee progress.
            a_mid = bisect_right(self.a.orders, pivot, iv.a_lo, iv.a_hi)
            b_mid = bisect_right(self.b.orders, pivot, iv.b_lo, iv.b_hi)
        left = Interval(iv.a_lo, a_mid, iv.b_lo, b_mid)
        right = Interval(a_mid, iv.a_hi, b_mid, iv.b_hi)
        return left, right

    def resolve_leaf(self, iv: Interval, diff: list):
        """Transfer key-values at a leaf and record the concrete difference."""
        has_a = iv.a_lo < iv.a_hi
        has_b = iv.b_lo < iv.b_hi
        if has_a and has_b:
            ka, kb = self.a.keys[iv.a_lo], self.b.keys[iv.b_lo]
            va, vb = self.a.values[iv.a_lo], self.b.values[iv.b_lo]
            if key_equal(ka, kb):
                if canonicalize(va) != canonicalize(vb):
                    diff.append({"op": "change", "key": ka, "a": va, "b": vb})
            else:
                diff.append({"op": "remove", "key": ka, "value": va})
                diff.append({"op": "add", "key": kb, "value": vb})
        elif has_a:
            diff.append(
                {"op": "remove", "key": self.a.keys[iv.a_lo], "value": self.a.values[iv.a_lo]}
            )
        elif has_b:
            diff.append(
                {"op": "add", "key": self.b.keys[iv.b_lo], "value": self.b.values[iv.b_lo]}
            )

    def describe(self, iv: Interval) -> dict:
        desc = {"a_range": [iv.a_lo, iv.a_hi], "b_range": [iv.b_lo, iv.b_hi]}
        keys = []
        if iv.a_lo < iv.a_hi:
            keys += [self.a.keys[iv.a_lo], self.a.keys[iv.a_hi - 1]]
        if iv.b_lo < iv.b_hi:
            keys += [self.b.keys[iv.b_lo], self.b.keys[iv.b_hi - 1]]
        if keys:
            desc["key_min"] = min(keys, key=key_order)
            desc["key_max"] = max(keys, key=key_order)
        return desc


def merkle_diff(a: Stream, b: Stream, max_rounds: int) -> dict:
    """Run the bounded-round Merkle interval protocol between streams A and B.

    Round 1 compares root hashes. Each further round bisects every differing
    non-leaf interval; only leaves transfer key-values. If max_rounds elapse
    with unresolved intervals remaining, the result is marked incomplete and
    the suspicious intervals are reported instead of fabricated differences.
    """
    if max_rounds < 1:
        raise ValueError("max_rounds must be >= 1")
    engine = _Engine(a, b)
    diff: list = []
    root = Interval(0, len(a), 0, len(b))
    rounds = 1

    if engine.hashes_equal(root):
        return {
            "equal": True,
            "diff": [],
            "rounds": rounds,
            "incomplete": False,
            "suspects": [],
        }

    suspects: list[Interval] = []
    if root.is_leaf:
        engine.resolve_leaf(root, diff)
    else:
        suspects.append(root)

    incomplete = False
    while suspects:
        if rounds >= max_rounds:
            incomplete = True
            break
        rounds += 1
        next_suspects: list[Interval] = []
        for iv in suspects:
            for child in engine.bisect(iv):
                if engine.hashes_equal(child):
                    continue
                if child.is_leaf:
                    engine.resolve_leaf(child, diff)
                else:
                    next_suspects.append(child)
        suspects = next_suspects

    diff.sort(key=lambda entry: key_order(entry["key"]))
    result = {
        "equal": not incomplete and not diff,
        "diff": [] if incomplete else diff,
        "rounds": rounds,
        "incomplete": incomplete,
        "suspects": [engine.describe(iv) for iv in suspects] if incomplete else [],
    }
    return result
