"""Persistent interval map with per-source coverage counts.

Public API: IntervalMap.  Internally every state is an immutable Version
(treap root + source refcounts + endpoint events + aggregate length), so
snapshots, nested transactions and rollback are all O(1) pointer swaps.
"""

from __future__ import annotations

from fractions import Fraction

from . import tree
from .endpoints import NEG_INF, POS_INF, parse_endpoint


class Version:
    """An immutable, shareable snapshot of the whole map state."""

    __slots__ = ("root", "refcounts", "events", "total_len")

    def __init__(self, root, refcounts, events):
        self.root = root
        self.refcounts = refcounts          # source -> sum of per-segment layer counts
        self.events = events                # endpoint -> {"enter": {}, "leave": {}}
        self.total_len = tree.total_length(root)

    def __repr__(self):
        return f"Version(segments={len(tree.inorder(self.root))}, total={self.total_len})"


def _validate_range(lo, hi):
    if lo > hi:
        raise ValueError(f"empty/illegal range: lo={lo!r} > hi={hi!r}")


class IntervalMap:
    def __init__(self):
        self._version = Version(None, {}, {})
        self._tx_stack: list[Version] = []

    # ------------------------------------------------------------------ #
    # versioning: snapshots + nested transactions
    # ------------------------------------------------------------------ #
    def snapshot(self) -> Version:
        """O(1) persistent snapshot; safe to keep forever."""
        return self._version

    def restore(self, version: Version) -> None:
        if not isinstance(version, Version):
            raise TypeError("restore() expects a Version from snapshot()")
        self._version = version

    def begin(self) -> None:
        """Open a (possibly nested) transaction."""
        self._tx_stack.append(self._version)

    def commit(self) -> None:
        if not self._tx_stack:
            raise RuntimeError("commit without begin")
        self._tx_stack.pop()

    def rollback(self) -> None:
        if not self._tx_stack:
            raise RuntimeError("rollback without begin")
        self._version = self._tx_stack.pop()

    @property
    def transaction_depth(self) -> int:
        return len(self._tx_stack)

    # ------------------------------------------------------------------ #
    # batch modification (touches only intersecting nodes)
    # ------------------------------------------------------------------ #
    def _modify(self, lo, hi, fn):
        """Apply fn(sources_tuple)->sources_tuple to every point of [lo, hi).

        Splits at lo/hi, rewrites exactly the intersecting segments, fills
        gaps, merges adjacent segments with identical source sets, and rolls
        refcounts / endpoint events / aggregate length forward together.
        """
        version = self._version
        left, rest = tree.split_at(version.root, lo)
        mid, right = tree.split_at(rest, hi)

        # Segments whose source references may change: everything
        # intersecting [lo, hi) plus the boundary neighbours that could
        # merge with rewritten pieces.
        old_region = self._region_segments(version.root, lo, hi)

        # Elementary pieces covering [lo, hi): existing segments + gaps.
        pieces = []
        cursor = lo
        for node in tree.inorder(mid):
            if cursor < node.start:
                pieces.append((cursor, node.start, tree.EMPTY_SOURCES))
            pieces.append((node.start, node.end, node.sources))
            cursor = node.end
        if cursor < hi:
            pieces.append((cursor, hi, tree.EMPTY_SOURCES))

        new_pieces = []
        for start, end, sources in pieces:
            new_sources = fn(sources)
            if new_sources:
                if new_pieces and new_pieces[-1][2] == new_sources \
                        and new_pieces[-1][1] == start:
                    prev = new_pieces[-1]
                    new_pieces[-1] = (prev[0], end, prev[2])
                else:
                    new_pieces.append((start, end, new_sources))

        mid_root = tree.build_from_sorted(new_pieces)
        root = tree.merge_canonical(left, mid_root)
        root = tree.merge_canonical(root, right)

        # Refcounts follow the canonical (merged) structure: subtract the
        # old region's references, add the new region's.
        refcounts = dict(version.refcounts)
        for node in old_region:
            for src, cnt in node.sources:
                refcounts[src] -= cnt
                if refcounts[src] == 0:
                    del refcounts[src]
        for node in self._region_segments(root, lo, hi):
            for src, cnt in node.sources:
                refcounts[src] = refcounts.get(src, 0) + cnt

        events = dict(version.events)
        affected = {lo, hi}
        for start, end, _ in pieces:
            affected.add(start)
            affected.add(end)
        for start, end, _ in new_pieces:
            affected.add(start)
            affected.add(end)
        for ep in affected:
            self._recompute_event(root, events, ep)

        self._version = Version(root, refcounts, events)

    @staticmethod
    def _recompute_event(root, events, ep):
        left_seg = None
        node = tree.find_containing(root, ep)
        if node is not None and node.start == ep:
            right_seg = node
        else:
            right_seg = None
        # predecessor segment ending exactly at ep
        pred = None
        cur = root
        while cur is not None:
            if cur.start < ep:
                pred = cur
                cur = cur.right
            else:
                cur = cur.left
        if pred is not None and pred.end == ep:
            left_seg = pred
        enter = tree.sources_to_dict(right_seg.sources) if right_seg else {}
        leave = tree.sources_to_dict(left_seg.sources) if left_seg else {}
        if enter or leave:
            events[ep] = {"enter": enter, "leave": leave}
        else:
            events.pop(ep, None)

    @staticmethod
    def _region_segments(root, lo, hi):
        """Segments intersecting [lo, hi) plus boundary neighbours."""
        out = []
        for node in tree.inorder(root):
            if node.end <= lo:
                continue
            if node.start >= hi:
                if node.start == hi:
                    out.append(node)
                break
            out.append(node)
        # neighbour ending exactly at lo
        pred = None
        cur = root
        while cur is not None:
            if cur.start < lo:
                pred = cur
                cur = cur.right
            else:
                cur = cur.left
        if pred is not None and pred.end == lo:
            out.insert(0, pred)
        return out

    # ------------------------------------------------------------------ #
    # public mutators
    # ------------------------------------------------------------------ #
    def add(self, source: str, lo, hi) -> None:
        """Add one coverage layer of `source` over [lo, hi)."""
        lo, hi = parse_endpoint(lo), parse_endpoint(hi)
        _validate_range(lo, hi)  # illegal order: nothing is touched
        if lo == hi:
            return  # zero-length input is a no-op
        if not isinstance(source, str) or not source:
            raise ValueError("source must be a non-empty string")

        def fn(sources):
            d = dict(sources)
            d[source] = d.get(source, 0) + 1
            return tree.norm_sources(d)

        self._modify(lo, hi, fn)

    def remove_source(self, source: str, lo=None, hi=None) -> None:
        """Undo every layer of `source`, optionally restricted to [lo, hi)."""
        lo = NEG_INF if lo is None else parse_endpoint(lo)
        hi = POS_INF if hi is None else parse_endpoint(hi)
        _validate_range(lo, hi)
        if lo == hi:
            return

        def fn(sources):
            if not any(s == source for s, _ in sources):
                return sources
            return tuple((s, c) for s, c in sources if s != source)

        self._modify(lo, hi, fn)

    # ------------------------------------------------------------------ #
    # set operations (produce new maps, operands untouched)
    # ------------------------------------------------------------------ #
    def _sources_over(self, lo, hi):
        node = tree.find_containing(self._version.root, lo)
        if node is not None and node.end >= hi:
            return node.sources
        return tree.EMPTY_SOURCES

    def _endpoints(self):
        eps = set()
        for node in tree.inorder(self._version.root):
            if not isinstance(node.start, type(POS_INF)):
                eps.add(node.start)
            if not isinstance(node.end, type(POS_INF)):
                eps.add(node.end)
        return eps

    def _combine(self, b: "IntervalMap", fn) -> "IntervalMap":
        a = self
        eps = sorted(a._endpoints() | b._endpoints())
        zones = []
        points = [NEG_INF] + eps + [POS_INF]
        for lo, hi in zip(points, points[1:]):
            if lo < hi:
                zones.append((lo, hi))
        result = IntervalMap()
        pieces = []
        for lo, hi in zones:
            merged = fn(dict(a._sources_over(lo, hi)), dict(b._sources_over(lo, hi)))
            merged = tree.norm_sources(merged)
            if merged:
                if pieces and pieces[-1][2] == merged and pieces[-1][1] == lo:
                    pieces[-1] = (pieces[-1][0], hi, merged)
                else:
                    pieces.append((lo, hi, merged))
        root = tree.build_from_sorted(pieces)
        refcounts = {}
        events = {}
        for node in tree.inorder(root):
            for src, cnt in node.sources:
                refcounts[src] = refcounts.get(src, 0) + cnt
        for node in tree.inorder(root):
            IntervalMap._recompute_event(root, events, node.start)
            IntervalMap._recompute_event(root, events, node.end)
        result._version = Version(root, refcounts, events)
        return result

    def union(self, other: "IntervalMap") -> "IntervalMap":
        def fn(a, b):
            for src, cnt in b.items():
                a[src] = a.get(src, 0) + cnt
            return a
        return self._combine(other, fn)

    def intersection(self, other: "IntervalMap") -> "IntervalMap":
        """Points covered by both maps; proofs are the combined sources."""
        def fn(a, b):
            if not a or not b:
                return {}
            for src, cnt in b.items():
                a[src] = a.get(src, 0) + cnt
            return a
        return self._combine(other, fn)

    def difference(self, other: "IntervalMap") -> "IntervalMap":
        """Points covered by self but not other; keeps self's sources."""
        def fn(a, b):
            return {} if b else a
        return self._combine(other, fn)

    # ------------------------------------------------------------------ #
    # queries
    # ------------------------------------------------------------------ #
    def intervals(self):
        """Canonical, maximally merged segments with source proofs."""
        out = []
        for node in tree.inorder(self._version.root):
            out.append({
                "lo": node.start,
                "hi": node.end,
                "sources": tree.sources_to_dict(node.sources),
                "count": tree.source_total(node.sources),
            })
        return out

    def covered_at_least(self, k: int):
        """Canonical segments whose coverage count >= k, with source proof."""
        if k < 1:
            raise ValueError("k must be >= 1")
        out = []
        for node in tree.inorder(self._version.root):
            total = tree.source_total(node.sources)
            if total >= k:
                proof = tree.sources_to_dict(node.sources)
                if out and out[-1]["hi"] == node.start and out[-1]["sources"] == proof:
                    out[-1]["hi"] = node.end
                else:
                    out.append({"lo": node.start, "hi": node.end,
                                "sources": proof, "count": total})
        return out

    def length(self):
        """Aggregate covered length (Fraction or +inf)."""
        return self._version.total_len

    def refcounts(self) -> dict:
        return dict(self._version.refcounts)

    def events(self) -> dict:
        return {ep: {"enter": dict(ev["enter"]), "leave": dict(ev["leave"])}
                for ep, ev in self._version.events.items()}

    def __eq__(self, other):
        if not isinstance(other, IntervalMap):
            return NotImplemented
        a = [(s["lo"], s["hi"], sorted(s["sources"].items())) for s in self.intervals()]
        b = [(s["lo"], s["hi"], sorted(s["sources"].items())) for s in other.intervals()]
        return a == b
