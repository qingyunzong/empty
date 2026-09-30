"""Backtracking CSP solver with conflict-triggered restarts and nogoods.

Semantics:
- Every domain wipeout during search counts as one conflict.
- When the conflicts accumulated since the last restart reach the restart
  threshold, a restart is triggered immediately.
- A restart keeps every globally valid nogood generated so far, undoes all
  non-level-0 decisions, restores the initial domains, and resets the
  decision counter to zero. No temporary propagation state is kept.
- When the total conflict budget is exhausted the search stops at once
  with status "timeout" (undecided); "unsat" is only reported when a
  contradiction is derived at level 0.
- A conflict during level-0 propagation never triggers a restart; the
  problem is reported "unsat" directly.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass


class Nogood:
    """A globally valid forbidden combination of assignments."""

    def __init__(self, pairs):
        self.pairs = frozenset(pairs)

    def propagate(self, assignment, domains):
        remaining = []
        for var, value in self.pairs:
            if var in assignment:
                if assignment[var] != value:
                    return True, 0
            else:
                remaining.append((var, value))
        if not remaining:
            return False, 0
        if len(remaining) == 1:
            var, value = remaining[0]
            domain = domains[var]
            if value in domain:
                domains[var] = [item for item in domain if item != value]
                if not domains[var]:
                    return False, 1
                return True, 1
        return True, 0


class _RestartRequested(Exception):
    pass


class _BudgetExhausted(Exception):
    pass


@dataclass
class Result:
    status: str  # "sat" | "unsat" | "timeout"
    solution: dict | None
    nogoods: list
    restart_count: int

    def to_dict(self):
        return {
            "status": self.status,
            "solution": self.solution,
            "nogoods": [[list(pair) for pair in nogood] for nogood in self.nogoods],
            "restart_count": self.restart_count,
        }


class Solver:
    def __init__(self, problem, restart_threshold, total_budget):
        if restart_threshold < 0:
            raise ValueError("restart_threshold must be a non-negative integer")
        if total_budget < 0:
            raise ValueError("total_budget must be a non-negative integer")
        self.problem = problem
        self.restart_threshold = restart_threshold
        self.total_budget = total_budget
        self.initial_domains = {v: list(d) for v, d in problem.domains.items()}
        self.nogoods = []
        self._nogood_set = set()
        self.restart_count = 0
        self.conflicts_total = 0
        self.conflicts_since_restart = 0
        self.decisions = 0
        self.assignment = {}
        self.domains = {}
        self.run_stats = []
        self.restart_snapshots = []
        self._reset_run_stats()

    def _reset_run_stats(self):
        self._run = {"conflicts": 0, "prunes": 0, "nogood_prunes": 0}

    def _close_run(self):
        self._run["decisions"] = self.decisions
        self.run_stats.append(self._run)

    def solve(self):
        self.assignment = {}
        self.domains = copy.deepcopy(self.initial_domains)
        if not self._propagate():
            self._close_run()
            return self._result("unsat", None)
        if self.total_budget == 0:
            self._close_run()
            return self._result("timeout", None)
        while True:
            try:
                if self._search():
                    solution = dict(self.assignment)
                    self._close_run()
                    return self._result("sat", solution)
                self._close_run()
                return self._result("unsat", None)
            except _RestartRequested:
                self._close_run()
                self.restart_count += 1
                self.restart_snapshots.append(
                    {
                        "decisions_before_reset": self.decisions,
                        "decisions_after_reset": 0,
                        "nogoods_retained": len(self.nogoods),
                    }
                )
                self.assignment = {}
                self.domains = copy.deepcopy(self.initial_domains)
                self.decisions = 0
                self.conflicts_since_restart = 0
                self._reset_run_stats()
                if not self._propagate():
                    self._close_run()
                    return self._result("unsat", None)
            except _BudgetExhausted:
                self._close_run()
                return self._result("timeout", None)

    def _select_variable(self):
        for var in self.problem.variables:
            if var not in self.assignment:
                return var
        return None

    def _search(self):
        var = self._select_variable()
        if var is None:
            return True
        for value in list(self.domains[var]):
            saved_domains = {v: list(d) for v, d in self.domains.items()}
            self.decisions += 1
            self.assignment[var] = value
            if self._propagate():
                if self._search():
                    return True
            else:
                self._on_conflict()
            del self.assignment[var]
            self.domains = saved_domains
        return False

    def _on_conflict(self):
        self.conflicts_total += 1
        self.conflicts_since_restart += 1
        self._run["conflicts"] += 1
        nogood = frozenset(self.assignment.items())
        if nogood and nogood not in self._nogood_set:
            self._nogood_set.add(nogood)
            self.nogoods.append(Nogood(nogood))
        if self.conflicts_total >= self.total_budget:
            raise _BudgetExhausted()
        if self.conflicts_since_restart >= self.restart_threshold:
            raise _RestartRequested()

    def _propagate(self):
        while True:
            changed = False
            for constraint in self.problem.constraints:
                ok, pruned = constraint.propagate(self.assignment, self.domains)
                self._run["prunes"] += pruned
                if not ok:
                    return False
                changed = changed or pruned > 0
            for nogood in self.nogoods:
                ok, pruned = nogood.propagate(self.assignment, self.domains)
                self._run["prunes"] += pruned
                self._run["nogood_prunes"] += pruned
                if not ok:
                    return False
                changed = changed or pruned > 0
            if not changed:
                return True

    def _result(self, status, solution):
        return Result(
            status=status,
            solution=solution,
            nogoods=[sorted(ng.pairs) for ng in self.nogoods],
            restart_count=self.restart_count,
        )


def naive_solve(problem):
    """Plain backtracking reference: no propagation, nogoods, or restarts."""
    assignment = {}

    def consistent():
        for constraint in problem.constraints:
            if all(v in assignment for v in constraint.variables):
                if constraint.is_violated(assignment):
                    return False
        return True

    def backtrack(index):
        if index == len(problem.variables):
            return dict(assignment)
        var = problem.variables[index]
        for value in problem.domains[var]:
            assignment[var] = value
            if consistent():
                result = backtrack(index + 1)
                if result is not None:
                    return result
            del assignment[var]
        return None

    return backtrack(0)
