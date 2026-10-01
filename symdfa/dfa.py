"""Symbolic DFA over integer character intervals.

The alphabet is the integer range ``[0, alphabet_size)``.  Every state
carries a sorted list of disjoint ``(lo, hi, target)`` intervals that
partition the whole alphabet, so transitions are never expanded per
character.
"""
from __future__ import annotations

from bisect import bisect_right


class DFAError(ValueError):
    """Base class for malformed DFA input."""


class OverlapError(DFAError):
    """Raised when a state's transition intervals overlap."""


class GapError(DFAError):
    """Raised when a state's intervals do not cover the whole alphabet."""


def merge_intervals(intervals):
    """Event-sweep merge of ``(lo, hi)`` intervals into a disjoint sorted tuple.

    Adjacent or overlapping intervals are coalesced; the result describes a
    set of characters without ever enumerating them.
    """
    merged = []
    for lo, hi in sorted(intervals):
        if merged and lo <= merged[-1][1] + 1:
            if hi > merged[-1][1]:
                merged[-1] = (merged[-1][0], hi)
        else:
            merged.append((lo, hi))
    return tuple(merged)


class SymbolicDFA:
    """A total deterministic automaton whose edges carry char intervals."""

    __slots__ = ("alphabet_size", "start", "finals", "transitions", "states", "_los")

    def __init__(self, alphabet_size, start, finals, transitions):
        alphabet_size = int(alphabet_size)
        if alphabet_size < 1:
            raise DFAError("alphabet_size must be a positive integer")
        self.alphabet_size = alphabet_size
        norm = {}
        for state, rows in transitions.items():
            norm[int(state)] = self._normalize_state(int(state), rows)
        self.transitions = norm
        self.states = frozenset(norm)
        self.start = int(start)
        if self.start not in self.states:
            raise DFAError(f"start state {self.start} is not a state")
        self.finals = frozenset(int(s) for s in finals)
        unknown = self.finals - self.states
        if unknown:
            raise DFAError(f"final states not in DFA: {sorted(unknown)}")
        for state, rows in norm.items():
            for _, _, target in rows:
                if target not in self.states:
                    raise DFAError(
                        f"state {state}: transition target {target} is not a state"
                    )
        self._los = {s: tuple(r[0] for r in rows) for s, rows in norm.items()}

    def _normalize_state(self, state, rows):
        rows = sorted((int(lo), int(hi), int(t)) for lo, hi, t in rows)
        if not rows:
            raise GapError(f"state {state}: no outgoing transitions")
        expect = 0
        for lo, hi, _ in rows:
            if lo > hi:
                raise DFAError(f"state {state}: empty interval [{lo}, {hi}]")
            if lo < 0 or hi >= self.alphabet_size:
                raise DFAError(
                    f"state {state}: interval [{lo}, {hi}] outside alphabet"
                )
            if lo < expect:
                raise OverlapError(
                    f"state {state}: interval [{lo}, {hi}] overlaps a previous interval"
                )
            if lo > expect:
                raise GapError(
                    f"state {state}: alphabet gap before interval [{lo}, {hi}]"
                )
            expect = hi + 1
        if expect != self.alphabet_size:
            raise GapError(
                f"state {state}: intervals stop at {expect - 1}, "
                f"alphabet ends at {self.alphabet_size - 1}"
            )
        return tuple(rows)

    def step(self, state, char):
        """Single symbolic transition; O(log k) via bisect on interval lows."""
        rows = self.transitions[state]
        idx = bisect_right(self._los[state], char) - 1
        if idx < 0:
            raise DFAError(f"character {char} out of range for state {state}")
        lo, hi, target = rows[idx]
        if not lo <= char <= hi:
            raise DFAError(f"character {char} out of range for state {state}")
        return target

    def run(self, state, word):
        for char in word:
            state = self.step(state, char)
        return state

    def accepts(self, word, state=None):
        state = self.start if state is None else state
        return self.run(state, word) in self.finals


def reachable(dfa):
    """Set of states reachable from the start state (interval-level BFS)."""
    seen = {dfa.start}
    stack = [dfa.start]
    while stack:
        state = stack.pop()
        for _, _, target in dfa.transitions[state]:
            if target not in seen:
                seen.add(target)
                stack.append(target)
    return seen


class InverseIndex:
    """Inverse transition index keyed by interval events.

    ``by_target[t]`` holds ``(lo, hi, src)`` entries meaning ``src`` moves to
    ``t`` on every character of ``[lo, hi]``.  ``by_source`` mirrors the same
    information per source so entries can be replaced incrementally when one
    state's outgoing transitions change.
    """

    def __init__(self):
        self.by_target = {}
        self.by_source = {}

    @classmethod
    def build(cls, dfa):
        index = cls()
        for state, rows in dfa.transitions.items():
            index.replace_source(state, rows)
        return index

    def replace_source(self, state, rows):
        """Incrementally swap all inverse entries originating at ``state``."""
        for lo, hi, target in self.by_source.get(state, ()):
            entries = self.by_target.get(target)
            if entries:
                self.by_target[target] = [
                    e for e in entries if e != (lo, hi, state)
                ]
        rows = tuple((int(lo), int(hi), int(t)) for lo, hi, t in rows)
        self.by_source[state] = rows
        for lo, hi, target in rows:
            self.by_target.setdefault(target, []).append((lo, hi, state))

    def entries_into(self, targets):
        """All ``(lo, hi, src)`` interval events landing in ``targets``."""
        out = []
        for target in targets:
            out.extend(self.by_target.get(target, ()))
        return out

    def copy(self):
        index = InverseIndex()
        index.by_target = {t: list(e) for t, e in self.by_target.items()}
        index.by_source = {s: tuple(r) for s, r in self.by_source.items()}
        return index
