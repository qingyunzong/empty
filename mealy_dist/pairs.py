"""Pairwise distinguishability: distinguishing graph and shortest witnesses.

A pair (p, q) is distinguishable iff some input sequence produces
different output sequences from p and from q.  Undefined transitions are
already folded into the machine semantics via the fault state, so a pair
in which exactly one side faults on the next input is immediately
distinguishable.
"""

from __future__ import annotations

from collections import deque
from typing import Dict, List, Optional, Tuple

from .machine import MealyMachine

Pair = Tuple[str, str]


def ordered_pair(a: str, b: str) -> Pair:
    return (a, b) if a <= b else (b, a)


class PairAnalysis:
    def __init__(self, machine: MealyMachine) -> None:
        self.machine = machine
        self.pairs: List[Pair] = [
            (machine.states[i], machine.states[j])
            for i in range(len(machine.states))
            for j in range(i + 1, len(machine.states))
        ]
        self._witness: Dict[Pair, Optional[Tuple[str, ...]]] = {}
        self._compute()

    def _compute(self) -> None:
        machine = self.machine
        dist: Dict[Pair, Optional[int]] = {pair: None for pair in self.pairs}
        witness: Dict[Pair, Optional[Tuple[str, ...]]] = {pair: None for pair in self.pairs}
        # Reverse edges: pair -> list of (predecessor pair, input symbol).
        reverse: Dict[Pair, List[Tuple[Pair, str]]] = {pair: [] for pair in self.pairs}
        queue: deque[Pair] = deque()

        for pair in self.pairs:
            for symbol in machine.inputs:
                np_, op = machine.step(pair[0], symbol)
                nq_, oq = machine.step(pair[1], symbol)
                if op != oq:
                    dist[pair] = 1
                    witness[pair] = (symbol,)
                    break
            if dist[pair] is not None:
                queue.append(pair)

        for pair in self.pairs:
            if dist[pair] is not None:
                continue
            for symbol in machine.inputs:
                np_, _ = machine.step(pair[0], symbol)
                nq_, _ = machine.step(pair[1], symbol)
                if np_ == nq_:
                    continue
                succ = ordered_pair(np_, nq_)
                reverse[succ].append((pair, symbol))

        while queue:
            pair = queue.popleft()
            for pred, symbol in reverse[pair]:
                if dist[pred] is None:
                    dist[pred] = dist[pair] + 1
                    witness[pred] = (symbol,) + witness[pair]
                    queue.append(pred)

        self._dist = dist
        self._witness = witness

    # -- queries -----------------------------------------------------------
    def witness(self, a: str, b: str) -> Optional[Tuple[str, ...]]:
        return self._witness[ordered_pair(a, b)]

    def distance(self, a: str, b: str) -> Optional[int]:
        w = self.witness(a, b)
        return None if w is None else len(w)

    def distinguishable_pairs(self) -> List[Pair]:
        return [pair for pair in self.pairs if self._witness[pair] is not None]

    def indistinguishable_pairs(self) -> List[Pair]:
        return [pair for pair in self.pairs if self._witness[pair] is None]

    def equivalence_classes(self) -> List[List[str]]:
        """Maximal groups of pairwise indistinguishable states."""
        parent = {s: s for s in self.machine.states}

        def find(x: str) -> str:
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        for a, b in self.indistinguishable_pairs():
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[ra] = rb
        groups: Dict[str, List[str]] = {}
        for s in self.machine.states:
            groups.setdefault(find(s), []).append(s)
        return sorted((sorted(g) for g in groups.values()), key=lambda g: (g[0], len(g)))

    def adjacency(self) -> Dict[Pair, List[Tuple[str, Pair]]]:
        """Distinguishing graph edges: pair -> [(input, successor pair)]."""
        machine = self.machine
        graph: Dict[Pair, List[Tuple[str, Pair]]] = {}
        for pair in self.pairs:
            edges: List[Tuple[str, Pair]] = []
            for symbol in machine.inputs:
                np_, _ = machine.step(pair[0], symbol)
                nq_, _ = machine.step(pair[1], symbol)
                if np_ != nq_:
                    edges.append((symbol, ordered_pair(np_, nq_)))
            graph[pair] = edges
        return graph

    def to_dict(self) -> dict:
        return {
            "distinguishable": {
                f"{a}|{b}": list(self._witness[(a, b)])
                for a, b in self.distinguishable_pairs()
            },
            "indistinguishable": [
                [a, b] for a, b in self.indistinguishable_pairs()
            ],
            "equivalence_classes": self.equivalence_classes(),
        }
