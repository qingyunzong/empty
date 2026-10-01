"""Minimal backtracking CSP solver with a nogood clause database.

A nogood is a set of (var, value) assignments that must not all hold
simultaneously. During search, any partial assignment that subsumes a
stored nogood is pruned immediately. The clause database deduplicates
clauses so the same conflict is never derived twice.

The solver keeps persistence strictly separate: loading nogoods from a
log is done by the caller, and any persistence failure never affects
the in-memory search state.
"""

from __future__ import annotations

from typing import Dict, Iterable, List, Optional, Tuple

Literal = Tuple[str, int]


class NogoodStore:
    """In-memory clause database with deduplication."""

    def __init__(self) -> None:
        self._clauses: List[frozenset] = []
        self._keys: set = set()

    def add(self, clause: Iterable[Iterable]) -> bool:
        """Add a clause; returns False if it was already present."""
        key = frozenset((lit[0], lit[1]) for lit in clause)
        if key in self._keys:
            return False
        self._keys.add(key)
        self._clauses.append(key)
        return True

    def clauses(self) -> List[List[list]]:
        """Return clauses in canonical sorted-pair form, insertion order."""
        return [sorted(([v, val] for v, val in c), key=lambda p: p[0]) for c in self._clauses]

    def is_violated(self, assignment: Dict[str, int]) -> bool:
        """True if the partial assignment subsumes any stored nogood."""
        items = set(assignment.items())
        return any(key <= items for key in self._clauses)

    def __len__(self) -> int:
        return len(self._clauses)


class CSPSolver:
    """Backtracking search over finite integer domains with nogood pruning."""

    def __init__(self, domains: Dict[str, List[int]], store: Optional[NogoodStore] = None):
        self.domains = {var: list(vals) for var, vals in domains.items()}
        self.store = store if store is not None else NogoodStore()
        self.nodes = 0  # search nodes visited, for pruning observability
        self.pruned = 0  # assignments rejected by the nogood store

    def solve(self) -> Optional[Dict[str, int]]:
        """Return the first solution consistent with all nogoods, or None."""
        self.nodes = 0
        self.pruned = 0
        variables = list(self.domains)
        assignment: Dict[str, int] = {}

        def search(idx: int) -> Optional[Dict[str, int]]:
            if idx == len(variables):
                return dict(assignment)
            var = variables[idx]
            for value in self.domains[var]:
                self.nodes += 1
                assignment[var] = value
                if self.store.is_violated(assignment):
                    self.pruned += 1
                else:
                    result = search(idx + 1)
                    if result is not None:
                        return result
                del assignment[var]
            return None

        return search(0)
