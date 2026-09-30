"""Disjunctive interval scheduling on top of DifferenceConstraints.

Each task ``t`` has a positive integer duration and a start variable.
A disjunctive pair ``(i, j)`` forbids overlap; the solver branches on the
ordering  i -> j  (edge  x_i - x_j <= -d_i)  versus  j -> i.

Search is an iterative DFS with an explicit choice-point stack, so the whole
frontier (open alternatives plus completed conflict subtrees) can be saved
to JSON and resumed later -- repeatedly, on the same branch.

Budgets are charged separately: relaxation steps inside the constraint
engine, and branch nodes here.  Exhaustion yields ``unknown`` together with
the current candidate (a schedule satisfying only the *asserted*
constraints -- local consistency is never reported as global feasibility).
"""

from __future__ import annotations

from .diffcon import DifferenceConstraints, RelaxBudgetExhausted
from .errors import InputError, InconsistentStateError


def _check_int(value, name):
    if isinstance(value, bool) or not isinstance(value, int):
        raise InputError(f"{name} must be an int, got {value!r}")
    return value


class Budget:
    """Separate budgets for relaxation steps and branch nodes.

    Each argument is the maximum number of units the search may spend, or
    None for unlimited.
    """

    def __init__(self, relax=None, branch=None):
        for name, val in (("relax", relax), ("branch", branch)):
            if val is not None:
                _check_int(val, f"{name}_budget")
                if val < 0:
                    raise InputError(f"{name}_budget must be >= 0")
        self.relax_cell = [relax] if relax is not None else None
        self.branch = branch


class _ChoicePoint:
    __slots__ = ("index", "pair", "chosen", "remaining", "subtrees")

    def __init__(self, index, pair, chosen, remaining, subtrees):
        self.index = index
        self.pair = pair
        self.chosen = chosen
        self.remaining = remaining
        self.subtrees = subtrees

    def to_json(self):
        return {
            "index": self.index,
            "pair": [self.pair[0], self.pair[1]],
            "chosen": self.chosen,
            "remaining": list(self.remaining),
            "subtrees": self.subtrees,
        }


class Result:
    """Outcome of Solver.solve().  Exactly one status:

    "sat"     - ``schedule`` maps every task index (as string) to its integer
                start time; a complete, checkable timetable.
    "unsat"   - ``conflict_tree`` is a replayable branch tree whose leaves are
                negative-cycle certificates.
    "unknown" - budget exhausted; ``candidate`` is the current schedule for
                the asserted constraints only, ``frontier`` allows resuming.
    """

    def __init__(self, status, schedule=None, conflict_tree=None,
                 candidate=None, frontier=None, stats=None):
        self.status = status
        self.schedule = schedule
        self.conflict_tree = conflict_tree
        self.candidate = candidate
        self.frontier = frontier
        self.stats = stats or {}

    def to_json(self):
        out = {"status": self.status}
        if self.schedule is not None:
            out["schedule"] = self.schedule
        if self.conflict_tree is not None:
            out["conflict_tree"] = self.conflict_tree
        if self.candidate is not None:
            out["candidate"] = self.candidate
        if self.frontier is not None:
            out["frontier"] = self.frontier
        out["stats"] = dict(self.stats)
        return out

    def __repr__(self):
        return f"Result(status={self.status!r}, stats={self.stats!r})"


class Solver:
    """Branching solver over difference constraints + disjunctive pairs."""

    def __init__(self, n_tasks, durations):
        _check_int(n_tasks, "n_tasks")
        if n_tasks <= 0:
            raise InputError("n_tasks must be positive")
        if not isinstance(durations, (list, tuple)) or len(durations) != n_tasks:
            raise InputError("durations must be a list of length n_tasks")
        for d in durations:
            _check_int(d, "duration")
            if d <= 0:
                raise InputError("all task durations must be positive")
        self.n = n_tasks
        self.durations = list(durations)
        self.dc = DifferenceConstraints(n_tasks)
        self.constraints = []   # (uid, u, v, c)
        self.disjuncts = []     # (i, j) with i < j
        self._uids = set()
        self.stats = {"relax_steps": 0, "branch_nodes": 0, "conflicts": 0}

    # ------------------------------------------------------------- modelling

    def add_constraint(self, u, v, c, uid=None):
        """Add  x_v - x_u <= c .  Returns None, or the conflict certificate
        if this constraint closes a negative cycle at the current level.
        Invalid input raises InputError and changes nothing."""
        _check_int(u, "u")
        _check_int(v, "v")
        _check_int(c, "c")
        for name, idx in (("u", u), ("v", v)):
            if not (0 <= idx < self.n):
                raise InputError(f"{name}={idx} out of range [0,{self.n})")
        if uid is None:
            uid = f"k{len(self.constraints)}"
        if not isinstance(uid, str) or not uid:
            raise InputError("uid must be a non-empty string")
        if uid in self._uids or uid.startswith("ord:"):
            raise InputError(f"duplicate or reserved uid {uid!r}")
        cert = self.dc.add_edge(u, v, c, uid)
        self._uids.add(uid)
        self.constraints.append((uid, u, v, c))
        return cert

    def add_disjunct(self, i, j):
        """Declare that tasks i and j must not overlap."""
        _check_int(i, "i")
        _check_int(j, "j")
        if not (0 <= i < self.n) or not (0 <= j < self.n):
            raise InputError("disjunct task index out of range")
        if i == j:
            raise InputError("disjunct needs two distinct tasks")
        pair = (i, j) if i < j else (j, i)
        if pair in self.disjuncts:
            raise InputError(f"duplicate disjunct {pair}")
        self.disjuncts.append(pair)

    def push(self):
        self.dc.push()

    def pop(self):
        self.dc.pop()

    # ------------------------------------------------------------- ordering

    def _ordering_edge(self, i, j, alt):
        """Edge enforcing the chosen order.  alt 0: i before j, alt 1: j before i."""
        first, second = (i, j) if alt == 0 else (j, i)
        # x_second >= x_first + d_first  <=>  x_first - x_second <= -d_first
        return second, first, -self.durations[first], f"ord:{first}:{second}"

    def _add_ordering(self, i, j, alt):
        u, v, c, uid = self._ordering_edge(i, j, alt)
        return self.dc.add_edge(u, v, c, uid)

    # ----------------------------------------------------------------- solve

    def solve(self, relax_budget=None, branch_budget=None, frontier=None):
        """Run the search.  See Result for the three possible statuses."""
        budget = Budget(relax_budget, branch_budget)
        self.dc.set_budget(budget.relax_cell)
        choices = []
        resolved = set()
        base_depth = self.dc.level
        try:
            if frontier is not None:
                self._restore_frontier(frontier, choices, resolved)
            if self.dc.conflict is not None:
                # Inconsistent already at the base level.
                return Result(
                    "unsat",
                    conflict_tree={"type": "leaf", "cycle": self.dc.conflict},
                    stats=self._stats(),
                )
            while True:
                if self.dc.conflict is not None:
                    self.stats["conflicts"] += 1
                    tree = {"type": "leaf", "cycle": self.dc.conflict}
                    # Unwind: record the failed alternative, try the next one.
                    while True:
                        if not choices:
                            return Result("unsat", conflict_tree=tree,
                                          stats=self._stats())
                        cp = choices[-1]
                        self.dc.pop()
                        resolved.discard(cp.index)
                        cp.subtrees[str(cp.chosen)] = tree
                        if cp.remaining:
                            cp.chosen = cp.remaining.pop(0)
                            self.dc.push()
                            try:
                                self._add_ordering(cp.pair[0], cp.pair[1], cp.chosen)
                            except RelaxBudgetExhausted:
                                self.dc.pop()
                                raise
                            resolved.add(cp.index)
                            break
                        choices.pop()
                        tree = {
                            "type": "node",
                            "pair": [cp.pair[0], cp.pair[1]],
                            "children": cp.subtrees,
                        }
                    continue
                if len(resolved) == len(self.disjuncts):
                    return Result("sat", schedule=self._schedule(),
                                  stats=self._stats())
                if budget.branch is not None and budget.branch <= 0:
                    return self._unknown(choices)
                idx = next(k for k in range(len(self.disjuncts))
                           if k not in resolved)
                if budget.branch is not None:
                    budget.branch -= 1
                self.stats["branch_nodes"] += 1
                i, j = self.disjuncts[idx]
                cp = _ChoicePoint(idx, (i, j), 0, [1], {})
                self.dc.push()
                try:
                    self._add_ordering(i, j, 0)
                except RelaxBudgetExhausted:
                    self.dc.pop()
                    raise
                choices.append(cp)
                resolved.add(idx)
        except RelaxBudgetExhausted:
            return self._unknown(choices)
        finally:
            # Search levels never leak: the frontier captures everything.
            while self.dc.level > base_depth:
                self.dc.pop()
            self.dc.set_budget(None)

    # -------------------------------------------------------------- frontier

    def _unknown(self, choices):
        return Result(
            "unknown",
            candidate=self._schedule(),
            frontier={"choices": [cp.to_json() for cp in choices]},
            stats=self._stats(),
        )

    def _restore_frontier(self, frontier, choices, resolved):
        if not isinstance(frontier, dict) or "choices" not in frontier:
            raise InputError("frontier must be a dict with a 'choices' list")
        saved_budget = self.dc._budget
        self.dc.set_budget(None)  # replaying already-paid decisions is free
        pushed = 0
        try:
            for entry in frontier["choices"]:
                cp = self._parse_choice(entry)
                if self.disjuncts[cp.index] != cp.pair:
                    raise InputError(
                        f"frontier pair {cp.pair} does not match disjunct "
                        f"{cp.index} = {self.disjuncts[cp.index]}"
                    )
                self.dc.push()
                pushed += 1
                cert = self._add_ordering(cp.pair[0], cp.pair[1], cp.chosen)
                if cert is not None:
                    raise InputError(
                        "frontier replays into a conflict; not a live frontier"
                    )
                choices.append(cp)
                resolved.add(cp.index)
        except Exception:
            # Roll back any partially restored levels before re-raising.
            for _ in range(pushed):
                self.dc.pop()
            choices.clear()
            resolved.clear()
            raise
        finally:
            self.dc.set_budget(saved_budget)

    def _parse_choice(self, entry):
        try:
            index = entry["index"]
            pair = tuple(entry["pair"])
            chosen = entry["chosen"]
            remaining = list(entry["remaining"])
            subtrees = entry.get("subtrees", {})
        except (KeyError, TypeError) as exc:
            raise InputError(f"malformed frontier choice: {exc}") from exc
        _check_int(index, "frontier index")
        if not (0 <= index < len(self.disjuncts)):
            raise InputError(f"frontier disjunct index {index} out of range")
        if chosen not in (0, 1) or any(a not in (0, 1) for a in remaining):
            raise InputError("frontier alternatives must be 0 or 1")
        if chosen in remaining:
            raise InputError("frontier choice repeats the chosen alternative")
        return _ChoicePoint(index, pair, chosen, remaining, subtrees)

    # ----------------------------------------------------------------- misc

    def _schedule(self):
        shift = min(self.dc.pi)
        return {str(t): self.dc.pi[t] - shift for t in range(self.n)}

    def _stats(self):
        return {
            "relax_steps": self.dc.relax_steps,
            "branch_nodes": self.stats["branch_nodes"],
            "conflicts": self.stats["conflicts"],
        }
