"""Symbolic DFA over integer character intervals."""

from __future__ import annotations

from collections import deque
from typing import Dict, List, Sequence, Tuple

from . import intervals as I
from .intervals import Interval, IntervalError

Transition = Tuple[Tuple[Interval, ...], int]


class SymbolicDFA:
    """A deterministic automaton whose edge labels are interval sets.

    ``transitions[q]`` is a tuple of ``(interval_set, target)`` whose interval
    sets are pairwise disjoint (validated on construction).  The automaton
    may be partial: characters with no outgoing edge lead to rejection.
    """

    def __init__(
        self,
        alphabet_size: int,
        num_states: int,
        start: int,
        finals: Sequence[int],
        transitions: Sequence[Sequence[Tuple[Sequence[Interval], int]]],
    ):
        if alphabet_size <= 0:
            raise ValueError("alphabet_size must be positive")
        if not 0 <= start < num_states:
            raise ValueError("start state out of range")
        self.alphabet_size = int(alphabet_size)
        self.num_states = int(num_states)
        self.start = int(start)
        self.finals = frozenset(int(f) for f in finals)
        for f in self.finals:
            if not 0 <= f < num_states:
                raise ValueError(f"final state {f} out of range")
        norm: List[Tuple[Transition, ...]] = []
        for q, edges in enumerate(transitions):
            seen: Tuple[Interval, ...] = ()
            row: List[Transition] = []
            for ivs, tgt in edges:
                if not 0 <= tgt < num_states:
                    raise ValueError(f"transition target {tgt} out of range")
                ivset = I.normalize(ivs, alphabet_size)
                if not ivset:
                    raise IntervalError("empty interval set on transition")
                if I.intersect(seen, ivset):
                    raise IntervalError(
                        f"overlapping transition labels on state {q}"
                    )
                seen = I.union(seen, ivset)
                row.append((ivset, int(tgt)))
            # deterministic edge order, independent of input order
            row.sort(key=lambda e: (e[0], e[1]))
            norm.append(tuple(row))
        if len(norm) != num_states:
            raise ValueError("transition count != num_states")
        self.transitions: Tuple[Tuple[Transition, ...], ...] = tuple(norm)

    # ------------------------------------------------------------------
    def step(self, state: int, char: int) -> int | None:
        """Follow one character (O(log) per edge set); None means reject."""
        for ivset, tgt in self.transitions[state]:
            for lo, hi in ivset:
                if lo <= char <= hi:
                    return tgt
        return None

    def accepts(self, word: Sequence[int]) -> bool:
        q = self.start
        for c in word:
            q = self.step(q, c)
            if q is None:
                return False
        return q in self.finals

    def reachable_states(self) -> frozenset:
        """States reachable from the start, via interval edges only."""
        seen = {self.start}
        dq = deque([self.start])
        while dq:
            q = dq.popleft()
            for _ivs, tgt in self.transitions[q]:
                if tgt not in seen:
                    seen.add(tgt)
                    dq.append(tgt)
        return frozenset(seen)

    def trim(self) -> "SymbolicDFA":
        """Drop unreachable states and renumber the survivors canonically.

        Survivors are numbered by BFS discovery order from the start, where
        each state's outgoing edges are explored in sorted interval order.
        The result depends only on the automaton's structure, never on set
        iteration order.
        """
        order: List[int] = []
        index: Dict[int, int] = {}
        dq = deque([self.start])
        index[self.start] = 0
        while dq:
            q = dq.popleft()
            order.append(q)
            for _ivs, tgt in self.transitions[q]:
                if tgt not in index:
                    index[tgt] = len(index)
                    dq.append(tgt)
        new_trans = []
        for q in order:
            new_trans.append(
                tuple((ivs, index[tgt]) for ivs, tgt in self.transitions[q])
            )
        return SymbolicDFA(
            self.alphabet_size,
            len(order),
            0,
            sorted(index[f] for f in self.finals if f in index),
            new_trans,
        )

    # ------------------------------------------------------------------
    def to_dict(self) -> dict:
        return {
            "alphabet_size": self.alphabet_size,
            "num_states": self.num_states,
            "start": self.start,
            "finals": sorted(self.finals),
            "transitions": [
                [
                    {"intervals": [list(iv) for iv in ivs], "target": tgt}
                    for ivs, tgt in row
                ]
                for row in self.transitions
            ],
        }

    @classmethod
    def from_dict(cls, data: dict) -> "SymbolicDFA":
        return cls(
            data["alphabet_size"],
            data["num_states"],
            data["start"],
            data["finals"],
            [
                [( [tuple(iv) for iv in edge["intervals"]], edge["target"])
                 for edge in row]
                for row in data["transitions"]
            ],
        )
