"""Independent sweep-line reference model.

Deliberately naive: keeps a flat multiset of (source, lo, hi) records and
recomputes everything by scanning finite endpoint coordinates.  Used by the
test-suite to cross-check the treap-based IntervalMap operation by operation.
"""

from __future__ import annotations

from fractions import Fraction

from .endpoints import NEG_INF, POS_INF, parse_endpoint


class SweepModel:
    def __init__(self):
        self.records: list[tuple[str, object, object]] = []

    # ---------------- mutators ---------------- #
    def add(self, source, lo, hi):
        lo, hi = parse_endpoint(lo), parse_endpoint(hi)
        if lo > hi:
            raise ValueError("illegal range")
        if lo == hi:
            return
        self.records.append((source, lo, hi))

    def remove_source(self, source, lo=None, hi=None):
        lo = NEG_INF if lo is None else parse_endpoint(lo)
        hi = POS_INF if hi is None else parse_endpoint(hi)
        if lo > hi:
            raise ValueError("illegal range")
        if lo == hi:
            return
        kept = []
        for src, rlo, rhi in self.records:
            if src != source or rhi <= lo or rlo >= hi:
                kept.append((src, rlo, rhi))
                continue
            if rlo < lo:
                kept.append((src, rlo, lo))
            if hi < rhi:
                kept.append((src, hi, rhi))
        self.records = kept

    # ---------------- queries ---------------- #
    def _finite_endpoints(self):
        eps = set()
        for _, lo, hi in self.records:
            if not isinstance(lo, type(POS_INF)):
                eps.add(lo)
            if not isinstance(hi, type(POS_INF)):
                eps.add(hi)
        return sorted(eps)

    def _coverage_at(self, point):
        counts = {}
        for src, lo, hi in self.records:
            if lo <= point < hi:
                counts[src] = counts.get(src, 0) + 1
        return counts

    def intervals(self):
        """Canonical merged segments: (lo, hi, {source: count})."""
        eps = self._finite_endpoints()
        zones = []
        points = [NEG_INF] + eps + [POS_INF]
        for lo, hi in zip(points, points[1:]):
            if lo >= hi:
                continue
            if lo == NEG_INF and hi == POS_INF:
                sample = Fraction(0)
            elif lo == NEG_INF:
                sample = hi - 1
            elif hi == POS_INF:
                sample = lo + 1
            else:
                sample = (lo + hi) / 2
            zones.append((lo, hi, self._coverage_at(sample)))
        out = []
        for lo, hi, cov in zones:
            if not cov:
                continue
            if out and out[-1][1] == lo and out[-1][2] == cov:
                out[-1] = (out[-1][0], hi, cov)
            else:
                out.append((lo, hi, cov))
        return out

    def covered_at_least(self, k):
        out = []
        for lo, hi, cov in self.intervals():
            if sum(cov.values()) >= k:
                if out and out[-1][1] == lo and out[-1][2] == cov:
                    out[-1] = (out[-1][0], hi, cov)
                else:
                    out.append((lo, hi, cov))
        return out

    def length(self):
        total = Fraction(0)
        for lo, hi, _ in self.intervals():
            total += hi - lo
        return total

    def refcounts(self):
        refs = {}
        for _, _, cov in self.intervals():
            for src, cnt in cov.items():
                refs[src] = refs.get(src, 0) + cnt
        return refs
