"""State-pair distinguishing graph with shortest witnesses.

A pair of states is distinguished at length 1 when some input produces
different outputs, and at length k+1 when some input produces equal outputs
and successor states that are distinguishable at length k.  Reverse BFS
over the pair graph yields the shortest witness for every distinguishable
pair; pairs never reached are (provably) equivalent.
"""
from __future__ import annotations

from collections import deque


def pair_key(s, t):
    return (s, t) if s <= t else (t, s)


class PairAnalysis:
    """Shortest distinguishing witness for every pair of states."""

    def __init__(self, machine):
        self.machine = machine
        self.dist = {}     # pair_key -> shortest witness length
        self._choice = {}  # pair_key -> (input, successor pair_key or None)
        preds = {}         # pair_key -> [(predecessor pair_key, input)]
        sources = []
        states = machine.states
        for i, s in enumerate(states):
            for t in states[i + 1:]:
                key = pair_key(s, t)
                direct = None
                for inp in machine.inputs:
                    if machine.output(s, inp) != machine.output(t, inp):
                        if direct is None:
                            direct = inp
                    else:
                        ns = machine.successor(s, inp)
                        nt = machine.successor(t, inp)
                        if ns != nt:
                            succ = pair_key(ns, nt)
                            preds.setdefault(succ, []).append((key, inp))
                if direct is not None:
                    self.dist[key] = 1
                    self._choice[key] = (direct, None)
                    sources.append(key)
        queue = deque(sources)
        while queue:
            succ = queue.popleft()
            depth = self.dist[succ]
            for pre, inp in preds.get(succ, ()):
                if pre not in self.dist:
                    self.dist[pre] = depth + 1
                    self._choice[pre] = (inp, succ)
                    queue.append(pre)

    # -- queries ----------------------------------------------------------

    def distinguishable(self, s, t):
        if s == t:
            return False
        return pair_key(s, t) in self.dist

    def distance(self, s, t):
        """Shortest witness length, or ``None`` if equivalent."""
        if s == t:
            return None
        return self.dist.get(pair_key(s, t))

    def witness(self, s, t):
        """Shortest preset input sequence separating ``s`` and ``t``."""
        if s == t:
            return None
        key = pair_key(s, t)
        if key not in self.dist:
            return None
        seq = []
        while True:
            inp, succ = self._choice[key]
            seq.append(inp)
            if succ is None:
                return seq
            key = succ

    def equivalent_pairs(self, states=None):
        states = list(states) if states is not None else list(self.machine.states)
        result = []
        for i, s in enumerate(states):
            for t in states[i + 1:]:
                if not self.distinguishable(s, t):
                    result.append((s, t))
        return result

    def equivalent_classes(self, states=None):
        """Partition ``states`` into classes of indistinguishable states."""
        states = list(states) if states is not None else list(self.machine.states)
        parent = {s: s for s in states}

        def find(s):
            while parent[s] != s:
                parent[s] = parent[parent[s]]
                s = parent[s]
            return s

        for s, t in self.equivalent_pairs(states):
            rs, rt = find(s), find(t)
            if rs != rt:
                parent[rs] = rt
        classes = {}
        for s in states:
            classes.setdefault(find(s), []).append(s)
        return sorted(classes.values(), key=lambda c: (len(c), c[0]))

    # -- closure evidence -------------------------------------------------

    def closure_evidence(self, pairs=None):
        """Bisimulation-style evidence that the given pairs are equivalent.

        For every equivalent pair and every input, the outputs are equal and
        the successor states are either identical or again an equivalent
        pair, so the relation is closed under transitions.
        """
        if pairs is None:
            pairs = self.equivalent_pairs()
        evidence = []
        for s, t in pairs:
            if self.distinguishable(s, t):
                raise ValueError(f"pair {s!r},{t!r} is distinguishable")
            checks = []
            for inp in self.machine.inputs:
                out_s = self.machine.output(s, inp)
                out_t = self.machine.output(t, inp)
                ns = self.machine.successor(s, inp)
                nt = self.machine.successor(t, inp)
                if out_s != out_t:
                    raise AssertionError("equivalent pair with different outputs")
                if ns == nt:
                    status = "same-state"
                else:
                    if self.distinguishable(ns, nt):
                        raise AssertionError("successor pair is distinguishable")
                    status = "equivalent"
                checks.append(
                    {
                        "input": inp,
                        "output": out_s,
                        "successors": [ns, nt],
                        "successor_status": status,
                    }
                )
            evidence.append({"pair": [s, t], "checks": checks})
        return evidence
