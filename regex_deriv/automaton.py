"""Symbolic DFA construction (Brzozowski derivatives as states) and
minimization by partition refinement.  Transitions are labelled with
code-point intervals instead of single characters."""
from __future__ import annotations

from collections import deque

from .derivative import derive, partition
from .syntax import nullable, to_json


class BudgetExceeded(Exception):
    """Raised when the automaton state budget is exhausted."""


class DFA:
    def __init__(self, alphabet):
        self.alphabet = alphabet
        self.states = []        # state id -> regex Node
        self.index = {}         # regex Node -> state id
        self.start = 0
        self.accepting = set()
        self.transitions = []   # state id -> sorted list of (lo, hi, target)

    def add(self, node):
        idx = self.index.get(node)
        if idx is None:
            idx = len(self.states)
            self.index[node] = idx
            self.states.append(node)
            self.transitions.append([])
        return idx

    def matches(self, s):
        cur = self.start
        for ch in s:
            cp = ord(ch)
            nxt = None
            for lo, hi, tgt in self.transitions[cur]:
                if lo <= cp <= hi:
                    nxt = tgt
                    break
            if nxt is None:
                return False
            cur = nxt
        return cur in self.accepting

    def to_json(self):
        return {
            "start": self.start,
            "states": [to_json(s) for s in self.states],
            "accepting": sorted(self.accepting),
            "transitions": [
                [i, lo, hi, j]
                for i, st in enumerate(self.transitions)
                for (lo, hi, j) in st
            ],
        }


def build_dfa(node, alphabet, max_states=None):
    """Explore all derivatives reachable from `node`; one transition per
    maximal interval of the per-state alphabet partition."""
    dfa = DFA(alphabet)
    dfa.add(node)
    queue = deque([node])
    while queue:
        s = queue.popleft()
        i = dfa.index[s]
        if nullable(s):
            dfa.accepting.add(i)
        trans = []
        for lo, hi in partition(alphabet, s):
            t = derive(s, lo)
            if t not in dfa.index:
                dfa.add(t)
                queue.append(t)
                if max_states is not None and len(dfa.states) > max_states:
                    raise BudgetExceeded(
                        f"state budget {max_states} exceeded")
            j = dfa.index[t]
            if trans and trans[-1][2] == j and trans[-1][1] == lo - 1:
                trans[-1] = (trans[-1][0], hi, j)
            else:
                trans.append((lo, hi, j))
        dfa.transitions[i] = trans
    return dfa


def _atomic_intervals(alphabet, dfa):
    extra = set()
    for st in dfa.transitions:
        for lo, hi, _ in st:
            extra.add(lo)
            extra.add(hi + 1)
    atoms = []
    for alo, ahi in alphabet.intervals():
        pts = sorted(c for c in ({alo, ahi + 1} | extra) if alo <= c <= ahi + 1)
        atoms.extend((a, b - 1) for a, b in zip(pts, pts[1:]) if a <= b - 1)
    return atoms


def _renumber(classes):
    ids = {}
    out = []
    for c in classes:
        if c not in ids:
            ids[c] = len(ids)
        out.append(ids[c])
    return out


def minimize(dfa, alphabet):
    """Minimize a DFA built by `build_dfa` via partition refinement.
    Returns a new DFA whose transitions are re-merged into maximal
    intervals."""
    n = len(dfa.states)
    atoms = _atomic_intervals(alphabet, dfa)

    def row(i, cls):
        st = dfa.transitions[i]
        out = []
        k = 0
        for lo, hi in atoms:
            while st[k][1] < lo:
                k += 1
            out.append(cls[st[k][2]])
        return tuple(out)

    cls = _renumber([1 if i in dfa.accepting else 0 for i in range(n)])
    while True:
        sigs = [(i in dfa.accepting, row(i, cls)) for i in range(n)]
        new = _renumber(sigs)
        if new == cls:
            break
        cls = new

    reps = {}
    for i, c in enumerate(cls):
        reps.setdefault(c, i)

    out = DFA(alphabet)
    out.states = [dfa.states[reps[c]] for c in range(len(reps))]
    out.index = {node: i for i, node in enumerate(out.states)}
    out.start = cls[dfa.start]
    out.accepting = {cls[i] for i in dfa.accepting}
    out.transitions = [[] for _ in out.states]
    for c, rep in reps.items():
        st = dfa.transitions[rep]
        k = 0
        trans = []
        for lo, hi in atoms:
            while st[k][1] < lo:
                k += 1
            tgt = cls[st[k][2]]
            if trans and trans[-1][2] == tgt and trans[-1][1] == lo - 1:
                trans[-1] = (trans[-1][0], hi, tgt)
            else:
                trans.append((lo, hi, tgt))
        out.transitions[c] = trans
    return out
