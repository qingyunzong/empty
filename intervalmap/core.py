"""Persistent interval map with per-source coverage counts.

Half-open intervals [lo, hi) with exact rational (or infinite) endpoints.
Every point carries a multiset of sources; adjacent canonical segments
merge only when their source multisets are identical.  All operations
return new ``IntervalMap`` values; nothing is mutated in place, which is
what makes nested transactions, historical snapshots and rollback
branching cheap and safe.
"""
from __future__ import annotations

import math
from fractions import Fraction
from typing import Optional

from . import treap
from .endpoints import NEG_INF, POS_INF, cmp as epcmp, eq as epeq, fmt, fmt_length, normalize, parse, seg_length


def _merge_sorted(xs, ys):
    out = []
    i = j = 0
    while i < len(xs) and j < len(ys):
        c = epcmp(xs[i], ys[j])
        if c < 0:
            out.append(xs[i]); i += 1
        elif c > 0:
            out.append(ys[j]); j += 1
        else:
            out.append(xs[i]); i += 1; j += 1
    out.extend(xs[i:])
    out.extend(ys[j:])
    return out


def _push(out, lo, hi, src):
    """Append a segment, merging with the previous one when adjacent and
    carrying an identical source multiset (canonical maximally-merged form)."""
    if not src or epcmp(lo, hi) >= 0:
        return
    if out and out[-1][2] == src and epeq(out[-1][1], lo):
        out[-1] = (out[-1][0], hi, src)
    else:
        out.append((lo, hi, src))


def _refcounts_of(segments):
    refs = {}
    for _, _, src in segments:
        for s, c in src.items():
            refs[s] = refs.get(s, 0) + c
    return refs


class IntervalMap:
    """Immutable persistent interval map."""

    __slots__ = ("_root", "_refcounts")

    def __init__(self, root=None, refcounts=None):
        self._root = root
        self._refcounts = dict(refcounts) if refcounts else {}

    # ------------------------------------------------------------------
    # inspection
    # ------------------------------------------------------------------
    @property
    def total_length(self):
        """Aggregate covered length (Fraction, or math.inf)."""
        return self._root.total if self._root is not None else Fraction(0)

    @property
    def segment_count(self):
        return self._root.size if self._root is not None else 0

    def refcount(self, source):
        return self._refcounts.get(source, 0)

    @property
    def refcounts(self):
        return dict(self._refcounts)

    def segments(self):
        """Canonical list of (lo, hi, {source: count})."""
        return [(lo, hi, dict(src)) for lo, hi, src in treap.inorder(self._root)]

    def sources_at(self, x):
        """Source multiset covering point x (the coverage proof for x)."""
        x = normalize(x)
        node = self._root
        while node is not None:
            if epcmp(x, node.lo) < 0:
                node = node.left
            elif epcmp(x, node.hi) >= 0:
                node = node.right
            else:
                return dict(node.src)
        return {}

    # ------------------------------------------------------------------
    # modification
    # ------------------------------------------------------------------
    def add(self, lo, hi, source, count=1):
        """Return a new map with `source` added `count` times over [lo, hi).

        Zero-length input is a no-op; reversed endpoints raise ValueError
        without touching any index.  Only nodes intersecting [lo, hi) are
        touched (split at the bounds, rebuild of the intersecting middle).
        """
        lo = normalize(lo)
        hi = normalize(hi)
        if not isinstance(source, str) or not source:
            raise ValueError("source must be a non-empty string")
        if not isinstance(count, int) or isinstance(count, bool) or count < 1:
            raise ValueError("count must be a positive integer")
        c = epcmp(lo, hi)
        if c == 0:
            return self
        if c > 0:
            raise ValueError(f"invalid endpoint order: {fmt(lo)} > {fmt(hi)}")

        left, mid = treap.split_at(self._root, lo)
        mid, right = treap.split_at(mid, hi)

        new_segments = []
        cursor = lo
        for slo, shi, ssrc in treap.inorder(mid):
            if epcmp(cursor, slo) < 0:
                _push(new_segments, cursor, slo, {source: count})
            d = dict(ssrc)
            d[source] = d.get(source, 0) + count
            _push(new_segments, slo, shi, d)
            cursor = shi
        if epcmp(cursor, hi) < 0:
            _push(new_segments, cursor, hi, {source: count})

        root = treap.concat(treap.concat(left, treap.build(new_segments)), right)
        refs = _refcounts_of(
            (lo, hi, dict(src)) for lo, hi, src in treap.inorder(root))
        return IntervalMap(root, refs)

    def revoke(self, source, count=None):
        """Undo coverage by `source` everywhere.

        With ``count=None`` the source is removed entirely; otherwise its
        per-segment count is decremented by ``count`` (partial revoke of
        repeated adds).  Other sources covering the same time range are
        never affected.
        """
        if count is not None and (not isinstance(count, int) or isinstance(count, bool) or count < 1):
            raise ValueError("count must be a positive integer or None")
        segments = []
        changed = False
        for lo, hi, src in treap.inorder(self._root):
            d = dict(src)
            if source in d:
                changed = True
                if count is None:
                    del d[source]
                else:
                    remaining = d[source] - count
                    if remaining > 0:
                        d[source] = remaining
                    else:
                        del d[source]
            if d:
                segments.append((lo, hi, d))
        if not changed:
            return self
        merged = []
        for lo, hi, d in segments:
            _push(merged, lo, hi, d)
        return IntervalMap(treap.build(merged), _refcounts_of(merged))

    # ------------------------------------------------------------------
    # binary combination
    # ------------------------------------------------------------------
    def _combine(self, other, fn):
        a_segs = treap.inorder(self._root)
        b_segs = treap.inorder(other._root)
        bounds = _merge_sorted(
            [b for lo, hi, _ in a_segs for b in (lo, hi)],
            [b for lo, hi, _ in b_segs for b in (lo, hi)],
        )
        out = []
        ia = ib = 0
        for i in range(len(bounds) - 1):
            x, y = bounds[i], bounds[i + 1]
            if epeq(x, y):
                continue
            while ia < len(a_segs) and epcmp(a_segs[ia][1], x) <= 0:
                ia += 1
            while ib < len(b_segs) and epcmp(b_segs[ib][1], x) <= 0:
                ib += 1
            a = dict(a_segs[ia][2]) if ia < len(a_segs) and epcmp(a_segs[ia][0], x) <= 0 else None
            b = dict(b_segs[ib][2]) if ib < len(b_segs) and epcmp(b_segs[ib][0], x) <= 0 else None
            _push(out, x, y, fn(a, b))
        return IntervalMap(treap.build(out), _refcounts_of(out))

    @staticmethod
    def _sum_sources(a, b):
        d = dict(a)
        for s, c in b.items():
            d[s] = d.get(s, 0) + c
        return d

    def union(self, other):
        return self._combine(other, lambda a, b: (
            self._sum_sources(a, b) if a and b else (a or b)))

    def intersection(self, other):
        """Regions covered by both maps; proofs are the summed multisets."""
        return self._combine(other, lambda a, b: (
            self._sum_sources(a, b) if a and b else None))

    def difference(self, other):
        """Regions covered by self but not by other."""
        return self._combine(other, lambda a, b: (a if a and not b else None))

    # ------------------------------------------------------------------
    # threshold query
    # ------------------------------------------------------------------
    def covered_by_at_least(self, k, count_mode=False):
        """Canonical intervals covered by >= k distinct sources (or, with
        count_mode=True, by a total coverage count >= k).

        Returns a list of (lo, hi, proof) where proof is the exact source
        multiset justifying coverage of that interval.
        """
        if not isinstance(k, int) or isinstance(k, bool) or k < 1:
            raise ValueError("k must be a positive integer")
        out = []
        for lo, hi, src in treap.inorder(self._root):
            n = sum(c for _, c in src) if count_mode else len(src)
            if n >= k:
                _push(out, lo, hi, dict(src))
        return out

    def length_at_least(self, k, count_mode=False):
        total = Fraction(0)
        for lo, hi, _ in self.covered_by_at_least(k, count_mode):
            total = total + seg_length(lo, hi)
        return total

    # ------------------------------------------------------------------
    # serialization
    # ------------------------------------------------------------------
    def to_json(self):
        return {
            "segments": [
                {"lo": fmt(lo), "hi": fmt(hi), "sources": dict(src)}
                for lo, hi, src in self.segments()
            ]
        }

    @classmethod
    def from_json(cls, data):
        segments = []
        for item in data.get("segments", []):
            lo = parse(str(item["lo"]))
            hi = parse(str(item["hi"]))
            if epcmp(lo, hi) >= 0:
                raise ValueError(f"invalid segment: {item!r}")
            src = {str(s): int(c) for s, c in item["sources"].items()}
            if not src or any(c < 1 for c in src.values()):
                raise ValueError(f"invalid sources: {item!r}")
            _push(segments, lo, hi, src)
        return cls(treap.build(segments), _refcounts_of(segments))
