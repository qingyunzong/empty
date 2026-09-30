"""Independent scanline reference model over finite endpoint coordinates.

Deliberately naive and fully separate from the treap implementation:
every operation is recomputed from scratch with a plane sweep over
endpoint events.  Used by the test-suite to cross-check the persistent
interval tree operation by operation.  Finite Fraction endpoints only.
"""
from __future__ import annotations

from fractions import Fraction


def _finite(v, name):
    v = Fraction(v)
    return v


class ScanlineModel:
    def __init__(self, atoms=None):
        # atoms: canonical list of (lo, hi, {source: count})
        self.atoms = list(atoms) if atoms else []

    # -- core sweep -------------------------------------------------------
    @staticmethod
    def _sweep(atoms):
        events = {}
        for lo, hi, src in atoms:
            for s, c in src.items():
                events.setdefault(lo, {})[s] = events.setdefault(lo, {}).get(s, 0) + c
                events.setdefault(hi, {})[s] = events.setdefault(hi, {}).get(s, 0) - c
        out = []
        active = {}
        prev = None
        for x in sorted(events):
            if prev is not None and prev < x:
                live = {s: c for s, c in active.items() if c > 0}
                if live:
                    ScanlineModel._push(out, prev, x, live)
            for s, delta in events[x].items():
                active[s] = active.get(s, 0) + delta
            prev = x
        return out

    @staticmethod
    def _push(out, lo, hi, src):
        if out and out[-1][2] == src and out[-1][1] == lo:
            out[-1] = (out[-1][0], hi, src)
        else:
            out.append((lo, hi, dict(src)))

    # -- operations ---------------------------------------------------------
    def add(self, lo, hi, source, count=1):
        lo, hi = _finite(lo, "lo"), _finite(hi, "hi")
        if lo == hi:
            return
        if lo > hi:
            raise ValueError("invalid endpoint order")
        self.atoms = self._sweep(self.atoms + [(lo, hi, {source: count})])

    def revoke(self, source, count=None):
        atoms = []
        for lo, hi, src in self.atoms:
            d = dict(src)
            if source in d:
                if count is None:
                    del d[source]
                else:
                    remaining = d[source] - count
                    if remaining > 0:
                        d[source] = remaining
                    else:
                        del d[source]
            if d:
                atoms.append((lo, hi, d))
        self.atoms = self._sweep(atoms)

    def _combine(self, other, fn):
        coords = sorted({c for lo, hi, _ in self.atoms + other.atoms for c in (lo, hi)})
        out = []
        for x, y in zip(coords, coords[1:]):
            if x == y:
                continue
            a = next((dict(src) for lo, hi, src in self.atoms if lo <= x < hi), None)
            b = next((dict(src) for lo, hi, src in other.atoms if lo <= x < hi), None)
            s = fn(a, b)
            if s:
                self._push(out, x, y, s)
        return ScanlineModel(out)

    @staticmethod
    def _sum(a, b):
        d = dict(a)
        for s, c in b.items():
            d[s] = d.get(s, 0) + c
        return d

    def union(self, other):
        return self._combine(other, lambda a, b: self._sum(a, b) if a and b else (a or b))

    def intersection(self, other):
        return self._combine(other, lambda a, b: self._sum(a, b) if a and b else None)

    def difference(self, other):
        return self._combine(other, lambda a, b: a if a and not b else None)

    def covered_by_at_least(self, k, count_mode=False):
        out = []
        for lo, hi, src in self.atoms:
            n = sum(src.values()) if count_mode else len(src)
            if n >= k:
                self._push(out, lo, hi, dict(src))
        return out

    @property
    def total_length(self):
        return sum((hi - lo for lo, hi, _ in self.atoms), Fraction(0))
