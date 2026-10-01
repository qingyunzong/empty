"""Backtracking CSP solver with conflict-driven nogood learning and restarts.

Semantics:
- Every time propagation empties a variable domain during search, exactly
  one conflict is counted.
- When the number of conflicts since the last restart reaches the restart
  threshold, a restart is triggered immediately: all nogoods learned so
  far are kept, every decision above level 0 is undone, domains are
  restored to their initial state, and the decision counter is cleared.
- When the total conflict budget is exhausted the search stops at once
  with status "timeout" (undecided) -- never "unsat" -- unless a
  contradiction at decision level 0 has already been derived.
- A contradiction found by propagation at level 0 yields "unsat"
  immediately, without triggering a restart.
"""

SAT = "sat"
UNSAT = "unsat"
TIMEOUT = "timeout"


class _Restart(Exception):
    """Internal signal: restart threshold reached."""


class _BudgetExhausted(Exception):
    """Internal signal: total conflict budget exhausted."""


class Solver:
    def __init__(self, problem, restart_threshold, total_budget, on_restart=None):
        if restart_threshold < 0:
            raise ValueError("restart_threshold must be a non-negative integer")
        if total_budget < 0:
            raise ValueError("total_budget must be a non-negative integer")
        self.problem = problem
        self.restart_threshold = restart_threshold
        self.total_budget = total_budget
        self.on_restart = on_restart

        self.nogoods = []
        self.restart_count = 0
        self.total_conflicts = 0
        self.conflicts_since_restart = 0
        self.attempts = []
        self.status = None
        self.solution = None
        self._reset_attempt()

    # ------------------------------------------------------------------
    # state management
    # ------------------------------------------------------------------
    def _reset_attempt(self):
        """Undo all decisions and restore the initial domains."""
        self.domains = {v: list(d) for v, d in self.problem.domains.items()}
        self.assignment = {}
        self.level = 0
        self.decisions = 0
        self._stats = {"decisions": 0, "conflicts": 0, "prunes": 0}

    def _finish_attempt(self):
        self.attempts.append(self._stats)

    # ------------------------------------------------------------------
    # main loop
    # ------------------------------------------------------------------
    def solve(self):
        try:
            if not self._propagate():
                # Contradiction at decision level 0: unsat, no restart.
                self._finish_attempt()
                self.status = UNSAT
                return self.status
            if self.total_conflicts >= self.total_budget:
                self._finish_attempt()
                self.status = TIMEOUT
                return self.status
            while True:
                try:
                    if self._search():
                        self.status = SAT
                        self.solution = dict(self.assignment)
                    else:
                        self.status = UNSAT
                    self._finish_attempt()
                    return self.status
                except _Restart:
                    self._finish_attempt()
                    self.restart_count += 1
                    self.conflicts_since_restart = 0
                    self._reset_attempt()
                    if self.on_restart is not None:
                        self.on_restart(self)
                    if not self._propagate():
                        # Learned nogoods make level 0 inconsistent: unsat.
                        self._finish_attempt()
                        self.status = UNSAT
                        return self.status
        except _BudgetExhausted:
            self._finish_attempt()
            self.status = TIMEOUT
            return self.status

    # ------------------------------------------------------------------
    # search
    # ------------------------------------------------------------------
    def _search(self):
        var = next(
            (v for v in self.problem.variables if v not in self.assignment), None
        )
        if var is None:
            return True
        for value in list(self.domains[var]):
            snapshot = {v: list(d) for v, d in self.domains.items()}
            self.assignment[var] = value
            self.level += 1
            self.decisions += 1
            self._stats["decisions"] += 1
            if self._propagate():
                if self._search():
                    return True
            else:
                self._on_conflict()
            del self.assignment[var]
            self.level -= 1
            self.domains = snapshot
        return False

    def _on_conflict(self):
        self.total_conflicts += 1
        self.conflicts_since_restart += 1
        self._stats["conflicts"] += 1
        if self.assignment:
            nogood = dict(self.assignment)
            if nogood not in self.nogoods:
                self.nogoods.append(nogood)
        if self.total_conflicts >= self.total_budget:
            raise _BudgetExhausted
        if self.conflicts_since_restart >= self.restart_threshold:
            raise _Restart

    # ------------------------------------------------------------------
    # propagation
    # ------------------------------------------------------------------
    def _propagate(self):
        """Prune domains until fixpoint. Returns False on a domain wipeout."""
        changed = True
        while changed:
            changed = False
            for con in self.problem.constraints:
                unassigned = [v for v in con.variables if v not in self.assignment]
                if not unassigned:
                    if not con.is_consistent(self.assignment):
                        return False
                elif len(unassigned) == 1:
                    ok, pruned = self._prune_by_constraint(con, unassigned[0])
                    if not ok:
                        return False
                    changed = changed or pruned
            for nogood in self.nogoods:
                ok, pruned = self._prune_by_nogood(nogood)
                if not ok:
                    return False
                changed = changed or pruned
        return True

    def _prune_by_constraint(self, con, var):
        kept = []
        for value in self.domains[var]:
            self.assignment[var] = value
            ok = con.is_consistent(self.assignment)
            del self.assignment[var]
            if ok:
                kept.append(value)
        return self._apply_prune(var, kept)

    def _prune_by_nogood(self, nogood):
        rest = []
        for var, value in nogood.items():
            if var in self.assignment:
                if self.assignment[var] != value:
                    return True, False  # nogood is inactive
            else:
                rest.append((var, value))
        if not rest:
            return False, False  # assignment matches the whole nogood: conflict
        if len(rest) == 1:
            var, value = rest[0]
            kept = [v for v in self.domains[var] if v != value]
            return self._apply_prune(var, kept)
        return True, False

    def _apply_prune(self, var, kept):
        removed = len(self.domains[var]) - len(kept)
        if removed:
            self._stats["prunes"] += removed
            self.domains[var] = kept
        return bool(kept), removed > 0
