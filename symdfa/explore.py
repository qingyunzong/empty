"""On-demand product exploration for symbolic DFA equivalence / inclusion.

The product of two machines is explored lazily: for each visited pair of
states the outgoing transitions are partitioned into maximal segments on
which both machines behave uniformly (interval-overlap partitioning), so
individual characters are never enumerated.  A segment is one *product
edge*; the search budget is counted in newly computed product edges.  When
the budget runs out the exploration returns ``unknown`` together with a
frontier that can be resumed later (per-edge granularity).
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .machine import MAX_CHAR

EQUIVALENCE = "equivalence"
INCLUSION = "inclusion"  # L(a) subset of L(b)

_PROOF_TYPE = {EQUIVALENCE: "equivalence_proof", INCLUSION: "inclusion_proof"}
_DIFFERENT = {EQUIVALENCE: "different", INCLUSION: "not_included"}
_SAME = {EQUIVALENCE: "equivalent", INCLUSION: "included"}


def _lookup(intervals, char):
    for lo, hi, target in intervals:
        if char < lo:
            return None
        if lo <= char <= hi:
            return target
    return None


def partition_transitions(ta, tb):
    """Partition [0, MAX_CHAR] into maximal uniform segments.

    ``ta`` / ``tb`` are the sorted disjoint interval lists of one state of
    each machine.  Returns a list of ``(lo, hi, next_a, next_b)`` covering
    the whole alphabet; ``next_*`` is None for the implicit sink.
    """
    cuts = {0, MAX_CHAR + 1}
    for lo, hi, _ in ta:
        cuts.add(lo)
        cuts.add(hi + 1)
    for lo, hi, _ in tb:
        cuts.add(lo)
        cuts.add(hi + 1)
    points = sorted(cuts)
    segments = []
    for i in range(len(points) - 1):
        lo, hi = points[i], points[i + 1] - 1
        segments.append((lo, hi, _lookup(ta, lo), _lookup(tb, lo)))
    return segments


@dataclass
class Result:
    status: str  # equivalent | different | included | not_included | unknown
    mode: str
    proof: dict | None = None
    counterexample: dict | None = None
    frontier: dict | None = None
    stats: dict = field(default_factory=dict)

    def to_json(self):
        out = {"status": self.status, "mode": self.mode, "stats": self.stats}
        if self.proof is not None:
            out["proof"] = self.proof
        if self.counterexample is not None:
            out["counterexample"] = self.counterexample
        if self.frontier is not None:
            out["frontier"] = self.frontier
        return out


class _Exploration:
    """Resumable BFS over product states, layer by layer.

    Within a layer states are expanded in lexicographic order of their
    shortest reaching word and segments in increasing ``lo`` order, so the
    first mismatch found is minimal by (length, lexicographic order).
    """

    def __init__(self, a, b, mode, reuse=None):
        self.a = a
        self.b = b
        self.mode = mode
        self.reuse = reuse or {}
        self.edges = []        # (pair, lo, hi, succ_pair) in expansion order
        self.visited = set()   # all enqueued pairs
        self.queue = []        # [[pair, word, expanded]] current layer
        self.next_layer = {}   # pair -> word
        self.depth = 0
        self.new_edges = 0
        self.reused_edges = 0

    # -- frontier (de)serialization --------------------------------------

    def frontier(self):
        return {
            "mode": self.mode,
            "version_a": self.a.version,
            "version_b": self.b.version,
            "depth": self.depth,
            "queue": [[[p[0], p[1]], list(w), e] for p, w, e in self.queue],
            "next_layer": [[[p[0], p[1]], list(w)]
                           for p, w in self.next_layer.items()],
            "visited": [[p[0], p[1]] for p in self.visited],
            "edges": [[[p[0], p[1]], lo, hi, [s[0], s[1]]]
                      for p, lo, hi, s in self.edges],
            "new_edges": self.new_edges,
            "reused_edges": self.reused_edges,
        }

    @classmethod
    def from_frontier(cls, a, b, data, reuse=None):
        if data.get("version_a") != a.version or data.get("version_b") != b.version:
            raise ValueError("frontier is bound to different machine versions")
        ex = cls(a, b, data["mode"], reuse)
        ex.depth = data["depth"]
        ex.queue = [[(p[0], p[1]), tuple(w), e] for p, w, e in data["queue"]]
        ex.next_layer = {(p[0], p[1]): tuple(w) for p, w in data["next_layer"]}
        ex.visited = {(p[0], p[1]) for p in data["visited"]}
        ex.edges = [((p[0], p[1]), lo, hi, (s[0], s[1]))
                    for p, lo, hi, s in data["edges"]]
        ex.new_edges = data.get("new_edges", 0)
        ex.reused_edges = data.get("reused_edges", 0)
        return ex

    # -- search ----------------------------------------------------------

    def is_mismatch(self, pair):
        acc_a = self.a.is_accepting(pair[0])
        acc_b = self.b.is_accepting(pair[1])
        if self.mode == EQUIVALENCE:
            return acc_a != acc_b
        return acc_a and not acc_b

    def stats(self):
        return {
            "new_edges": self.new_edges,
            "reused_edges": self.reused_edges,
            "product_states": len(self.visited),
            "depth": self.depth,
        }

    def run(self, budget):
        while True:
            while self.queue:
                pair, word, expanded = self.queue[0]
                if expanded == 0 and self.is_mismatch(pair):
                    return Result(
                        status=_DIFFERENT[self.mode],
                        mode=self.mode,
                        counterexample={
                            "type": "counterexample",
                            "mode": self.mode,
                            "word": list(word),
                            "accepts_a": self.a.is_accepting(pair[0]),
                            "accepts_b": self.b.is_accepting(pair[1]),
                        },
                        stats=self.stats(),
                    )
                segments = self.reuse.get(pair)
                reused = segments is not None
                if segments is None:
                    segments = partition_transitions(
                        self.a.intervals(pair[0]), self.b.intervals(pair[1]))
                while expanded < len(segments):
                    if not reused:
                        if budget is not None:
                            if budget <= 0:
                                self.queue[0][2] = expanded
                                return Result(status="unknown", mode=self.mode,
                                              frontier=self.frontier(),
                                              stats=self.stats())
                            budget -= 1
                        self.new_edges += 1
                    else:
                        self.reused_edges += 1
                    lo, hi, next_a, next_b = segments[expanded]
                    succ = (next_a, next_b)
                    self.edges.append((pair, lo, hi, succ))
                    if succ not in self.visited and succ not in self.next_layer:
                        self.next_layer[succ] = word + (lo,)
                    expanded += 1
                self.queue.pop(0)
            if not self.next_layer:
                return Result(status=_SAME[self.mode], mode=self.mode,
                              proof=self.build_proof(), stats=self.stats())
            self.visited.update(self.next_layer)
            self.queue = [[p, w, 0] for p, w in
                          sorted(self.next_layer.items(), key=lambda kv: kv[1])]
            self.next_layer = {}
            self.depth += 1

    def build_proof(self):
        entries = {}
        order = []
        for pair, lo, hi, succ in self.edges:
            if pair not in entries:
                entries[pair] = []
                order.append(pair)
            entries[pair].append({"lo": lo, "hi": hi, "next": [succ[0], succ[1]]})
        return {
            "type": _PROOF_TYPE[self.mode],
            "version_a": self.a.version,
            "version_b": self.b.version,
            "initial": [self.a.initial, self.b.initial],
            "entries": [{"pair": [p[0], p[1]], "edges": entries[p]} for p in order],
        }


def check(a, b, mode=EQUIVALENCE, budget=None, frontier=None, reuse=None):
    """Check equivalence (or inclusion) of ``a`` and ``b``.

    ``budget`` bounds the number of *new* product edges computed in this
    call; reused edges (from ``reuse``, a dict pair -> segments) are free.
    ``frontier`` resumes a previous ``unknown`` result.
    """
    if frontier is not None:
        ex = _Exploration.from_frontier(a, b, frontier, reuse)
    else:
        ex = _Exploration(a, b, mode, reuse)
        pair = (a.initial, b.initial)
        ex.queue = [[pair, (), 0]]
        ex.visited = {pair}
    return ex.run(budget)
