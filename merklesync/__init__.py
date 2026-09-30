"""merklesync: locate differences between two sorted key-value streams
using hash-based interval bisection (a Merkle-style sync protocol).

Stream format: JSON Lines, one record per line, each record a JSON array
``[key, value]`` with a string ``key``.  Keys must be strictly ascending.

Interval hash: sha256 over the canonical substream (each record serialized
canonically, terminated by "\n").  The empty interval hashes to a fixed
constant (sha256 of the empty byte string).
"""

from __future__ import annotations

import bisect
import hashlib
import json

__all__ = [
    "EMPTY_HASH",
    "OrderError",
    "ParseError",
    "Stream",
    "canonical_line",
    "diff_streams",
    "load_stream",
    "parse_stream",
]

# Fixed constant hash for an empty interval: sha256 of b"".
EMPTY_HASH = hashlib.sha256(b"").hexdigest()


class ParseError(ValueError):
    """A line is not valid JSON or not a [key, value] record."""


class OrderError(ValueError):
    """Keys are not in strictly ascending order (duplicate or out of order)."""


def canonical_line(key: str, value) -> str:
    """Canonical serialization of one record (whitespace-insensitive)."""
    return json.dumps([key, value], ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"))


def _hash_lines(lines) -> str:
    if not lines:
        return EMPTY_HASH
    h = hashlib.sha256()
    for line in lines:
        h.update(line.encode("utf-8"))
        h.update(b"\n")
    return h.hexdigest()


class Stream:
    """A parsed, validated, sorted key-value stream."""

    def __init__(self, records):
        # records: list of (key, canonical_line, value)
        self.keys = [r[0] for r in records]
        self.lines = [r[1] for r in records]
        self.values = {}
        for key, _, value in records:
            self.values[key] = value

    def __len__(self):
        return len(self.keys)

    def _bounds(self, lo, hi):
        """Index range of keys in (lo, hi]; None means unbounded."""
        start = 0 if lo is None else bisect.bisect_right(self.keys, lo)
        end = len(self.keys) if hi is None else bisect.bisect_right(self.keys, hi)
        return start, end

    def range_hash(self, lo, hi) -> str:
        """Hash of the canonical substream with keys in (lo, hi]."""
        start, end = self._bounds(lo, hi)
        return _hash_lines(self.lines[start:end])

    def keys_in(self, lo, hi):
        start, end = self._bounds(lo, hi)
        return self.keys[start:end]


def parse_stream(text: str) -> Stream:
    """Parse JSONL text into a Stream, validating strict key order."""
    records = []
    prev = None
    for lineno, raw in enumerate(text.splitlines(), 1):
        if not raw.strip():
            continue
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ParseError(f"line {lineno}: invalid JSON: {exc}") from exc
        if not (isinstance(obj, list) and len(obj) == 2
                and isinstance(obj[0], str)):
            raise ParseError(
                f"line {lineno}: expected a [key, value] array with a string key")
        key, value = obj
        if prev is not None and key <= prev:
            if key == prev:
                raise OrderError(f"line {lineno}: duplicate key {key!r}")
            raise OrderError(
                f"line {lineno}: key {key!r} out of order (after {prev!r})")
        prev = key
        records.append((key, canonical_line(key, value), value))
    return Stream(records)


def load_stream(path: str) -> Stream:
    with open(path, "r", encoding="utf-8") as fh:
        return parse_stream(fh.read())


def diff_streams(a: Stream, b: Stream, max_rounds: int) -> dict:
    """Run the bounded-round Merkle interval diff protocol.

    Each round, every suspect interval whose two side hashes differ is
    bisected at the median union key; leaf intervals (a single key) are
    resolved by transferring that key's record(s).  If suspects remain
    after ``max_rounds`` rounds, the result is marked incomplete and the
    suspicious key ranges are reported instead of a concrete diff.
    """
    if max_rounds < 0:
        raise ValueError("max_rounds must be >= 0")

    rounds = 0
    suspects = [(None, None)]  # (lo, hi] key range; None = unbounded
    diff = []

    while suspects and rounds < max_rounds:
        rounds += 1
        next_suspects = []
        for lo, hi in suspects:
            if a.range_hash(lo, hi) == b.range_hash(lo, hi):
                continue
            keys = sorted(set(a.keys_in(lo, hi)) | set(b.keys_in(lo, hi)))
            if len(keys) == 1:
                key = keys[0]
                diff.append({
                    "key": key,
                    "a": a.values.get(key),
                    "b": b.values.get(key),
                })
            else:
                mid = keys[(len(keys) - 1) // 2]
                next_suspects.append((lo, mid))
                next_suspects.append((mid, hi))
        suspects = next_suspects

    incomplete = bool(suspects)
    diff.sort(key=lambda entry: entry["key"])
    return {
        "equal": not incomplete and not diff,
        "incomplete": incomplete,
        "rounds": rounds,
        "diff": diff,
        "suspects": [{"from": lo, "to": hi} for lo, hi in suspects],
    }
