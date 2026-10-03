"""Dotted version vectors with epochs.

A :class:`CausalContext` is a set of dots ``(node, epoch, counter)`` stored
per ``(node, epoch)`` as a contiguous prefix plus a set of out-of-order
counters.  Holes are preserved structurally: a context holding counters
``{1, 3}`` can never masquerade as the contiguous prefix ``{1, 2, 3}``.
"""
from __future__ import annotations


class CausalContext:
    __slots__ = ("entries",)

    def __init__(self, entries=None):
        # entries: {(node_id, epoch): [contiguous_counter, {extra_counters}]}
        self.entries = entries if entries is not None else {}

    # ------------------------------------------------------------------
    def copy(self):
        return CausalContext({k: [c, set(d)] for k, (c, d) in self.entries.items()})

    def _normalized(self):
        for key in list(self.entries):
            contig, dots = self.entries[key]
            dots = {d for d in dots if d > contig}
            while contig + 1 in dots:
                contig += 1
                dots.discard(contig)
            if contig == 0 and not dots:
                del self.entries[key]
            else:
                self.entries[key] = [contig, dots]
        return self

    def is_canonical(self):
        """True iff no dot below/inside the prefix is duplicated as an extra
        and no extra dot could be folded into the prefix."""
        for contig, dots in self.entries.values():
            if contig == 0 and not dots:
                return False
            if any(d <= contig for d in dots):
                return False
            if contig + 1 in dots:
                return False
        return True

    @classmethod
    def from_dots(cls, dots):
        ctx = cls()
        for dot in dots:
            ctx.add(dot)
        return ctx

    # ------------------------------------------------------------------
    def add(self, dot):
        """Insert a dot.  Returns True iff the dot was not already present."""
        node, epoch, counter = dot
        key = (node, epoch)
        contig, dots = self.entries.get(key, (0, frozenset()))
        dots = set(dots)
        if counter <= contig or counter in dots:
            return False
        if counter == contig + 1:
            contig = counter
            while contig + 1 in dots:
                contig += 1
                dots.discard(contig)
        else:
            dots.add(counter)
        self.entries[key] = [contig, dots]
        return True

    def __contains__(self, dot):
        node, epoch, counter = dot
        entry = self.entries.get((node, epoch))
        if entry is None:
            return False
        contig, dots = entry
        return counter <= contig or counter in dots

    def __len__(self):
        return sum(c + len(d) for c, d in self.entries.values())

    def dots(self):
        for (node, epoch), (contig, dots) in sorted(self.entries.items()):
            for counter in range(1, contig + 1):
                yield (node, epoch, counter)
            for counter in sorted(dots):
                yield (node, epoch, counter)

    def max_counter(self, node, epoch):
        entry = self.entries.get((node, epoch))
        if entry is None:
            return 0
        contig, dots = entry
        return max([contig, *dots])

    # ------------------------------------------------------------------
    def leq(self, other):
        """True iff every dot of self is contained in other."""
        for key, (contig, dots) in self.entries.items():
            other_entry = other.entries.get(key)
            if other_entry is None:
                if contig == 0 and not dots:
                    continue
                return False
            o_contig, o_dots = other_entry
            if contig > o_contig:
                return False
            if any(d > o_contig and d not in o_dots for d in dots):
                return False
        return True

    def merge(self, other):
        """Join (least upper bound).  Associative, commutative, idempotent."""
        result = {}
        for key in set(self.entries) | set(other.entries):
            c1, d1 = self.entries.get(key, (0, frozenset()))
            c2, d2 = other.entries.get(key, (0, frozenset()))
            contig = max(c1, c2)
            dots = {d for d in set(d1) | set(d2) if d > contig}
            result[key] = [contig, dots]
        return CausalContext(result)._normalized()

    def meet(self, other):
        """Greatest lower bound: dots present in *both* contexts."""
        result = {}
        for key in set(self.entries) & set(other.entries):
            c1, d1 = self.entries[key]
            c2, d2 = other.entries[key]
            dots1 = set(range(1, c1 + 1)) | set(d1)
            dots2 = set(range(1, c2 + 1)) | set(d2)
            common = dots1 & dots2
            contig = 0
            while contig + 1 in common:
                contig += 1
            result[key] = [contig, {d for d in common if d > contig}]
        return CausalContext(result)._normalized()

    def compare(self, other):
        s_leq, o_leq = self.leq(other), other.leq(self)
        if s_leq and o_leq:
            return "equal"
        if s_leq:
            return "less"
        if o_leq:
            return "greater"
        return "concurrent"

    # ------------------------------------------------------------------
    def __eq__(self, other):
        if not isinstance(other, CausalContext):
            return NotImplemented
        keys = set(self.entries) | set(other.entries)
        for key in keys:
            c1, d1 = self.entries.get(key, (0, frozenset()))
            c2, d2 = other.entries.get(key, (0, frozenset()))
            if c1 != c2 or set(d1) != set(d2):
                return False
        return True

    __hash__ = None

    def __repr__(self):
        return f"CausalContext({self.to_json()!r})"

    # ------------------------------------------------------------------
    def to_json(self):
        return [
            {"node": n, "epoch": e, "contig": c, "dots": sorted(d)}
            for (n, e), (c, d) in sorted(self.entries.items())
        ]

    @classmethod
    def from_json(cls, data):
        ctx = cls()
        for entry in data:
            key = (entry["node"], int(entry["epoch"]))
            ctx.entries[key] = [int(entry["contig"]), {int(d) for d in entry["dots"]}]
        if not ctx.is_canonical():
            raise ValueError(f"non-canonical causal context: {data!r}")
        return ctx
