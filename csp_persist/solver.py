"""Backtracking CSP solver with nogood-based pruning.

A nogood is a set of (variable, value) assignments that must not all
hold simultaneously.  During search, any partial assignment that covers
every literal of a known nogood is pruned immediately.  Nogoods are
deduplicated by canonical form so a clause is never derived twice.
"""

from __future__ import annotations

_SENTINEL = object()


class CSPSolver:
    def __init__(self, domains):
        """domains: mapping of variable name -> iterable of candidate values."""
        self.domains = {var: list(values) for var, values in domains.items()}
        self.nogoods = []          # list of frozenset[(var, value)]
        self._nogood_keys = set()  # dedup index
        self.pruned_nodes = 0      # search nodes cut by nogood pruning

    @staticmethod
    def _key(clause):
        return frozenset((lit["var"], lit["value"]) for lit in clause)

    def add_nogood(self, clause):
        """Add one nogood clause; returns False if it was already known."""
        key = self._key(clause)
        if key in self._nogood_keys:
            return False
        self._nogood_keys.add(key)
        self.nogoods.append(key)
        return True

    def add_nogoods(self, clauses):
        """Add loaded nogoods to the clause database; returns count added."""
        return sum(1 for clause in clauses if self.add_nogood(clause))

    def persist_nogood(self, log, clause):
        """Best-effort persistence of a nogood.

        I/O failures (e.g. unwritable log path) are swallowed so that
        in-memory search state is never affected; returns False on failure.
        Malformed clauses still raise ClauseFormatError.
        """
        try:
            log.append(clause)
        except OSError:
            return False
        return True

    def _violates_nogood(self, assignment):
        for nogood in self.nogoods:
            if all(assignment.get(var, _SENTINEL) == value
                   for var, value in nogood):
                return True
        return False

    def solve(self, max_solutions=None):
        """Backtracking search; returns the list of solutions found."""
        variables = list(self.domains)
        assignment = {}
        solutions = []

        def backtrack(index):
            if max_solutions is not None and len(solutions) >= max_solutions:
                return
            if index == len(variables):
                solutions.append(dict(assignment))
                return
            var = variables[index]
            for value in self.domains[var]:
                assignment[var] = value
                if self._violates_nogood(assignment):
                    self.pruned_nodes += 1
                else:
                    backtrack(index + 1)
                del assignment[var]

        backtrack(0)
        return solutions
