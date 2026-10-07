"""Integer difference-constraint + disjunctive interval solver.

The solver combines:

* integer difference constraints  x_v - x_u <= w  (potentials maintained by
  Bellman-Ford rounds; negative cycles are extracted as conflict
  certificates), and
* disjunctive (mutual exclusion) constraints between task intervals
  [s_a, s_a + d_a) and [s_b, s_b + d_b), resolved by branching on the
  ordering of the two tasks.

All task durations must be positive integers.

Undo is trail based: every mutation (potential tightening, added edge,
recorded conflict, decision) is logged, and ``pop()`` reverts to the
matching ``push()`` checkpoint.  Removing an edge also purges every
recorded conflict whose dependency set mentions that edge, so undoing a
constraint restores both the tightenings and the conflict dependencies it
caused -- not merely the edge itself.

Budgets are counted separately: relaxation (slack) steps and branch nodes.
Exhaustion yields status ``unknown`` together with the current feasible
candidate (potentials of the last fully consistent node) and a serializable
search frontier that can be resumed later.  Local consistency is never
reported as global feasibility.
"""

from __future__ import annotations

import json


class InputError(ValueError):
    """Raised when instance data or constraint input is malformed."""


class BudgetExhausted(Exception):
    """Raised when a search budget (slack or branch) runs out."""

    def __init__(self, kind):
        self.kind = kind
        super().__init__(f"{kind} budget exhausted")


def _as_int(value, name):
    if isinstance(value, bool) or not isinstance(value, int):
        raise InputError(f"{name} must be an integer, got {value!r}")
    return value


class Conflict:
    """A negative-cycle certificate plus the constraint tags it depends on."""

    __slots__ = ("cycle", "weight", "deps")

    def __init__(self, cycle, weight):
        self.cycle = [tuple(tag) for tag in cycle]
        self.weight = weight
        self.deps = frozenset(self.cycle)

    def to_json(self):
        return {
            "type": "leaf",
            "cycle": [list(tag) for tag in self.cycle],
            "weight": self.weight,
        }


class _Frame:
    """One open choice point of the branch-and-bound search."""

    __slots__ = ("disjunct", "current", "untried", "children")

    def __init__(self, disjunct, current, untried, children):
        self.disjunct = disjunct
        self.current = current
        self.untried = untried
        self.children = children


class Solver:
    """Incremental solver for difference constraints + disjunctive intervals."""

    def __init__(self, num_tasks, durations):
        num_tasks = _as_int(num_tasks, "num_tasks")
        if num_tasks < 0:
            raise InputError("num_tasks must be >= 0")
        if not isinstance(durations, (list, tuple)) or len(durations) != num_tasks:
            raise InputError("durations must be a list with one entry per task")
        durs = []
        for d in durations:
            _as_int(d, "duration")
            if d <= 0:
                raise InputError(f"durations must be positive, got {d}")
            durs.append(d)
        self.num_tasks = num_tasks
        self.durations = durs
        self.zero = num_tasks            # extra reference variable, value 0
        self.num_vars = num_tasks + 1
        self.pot = [0] * self.num_vars   # current potentials
        self.edges = []                  # (u, v, w, tag); x_v - x_u <= w
        self.static_constraints = []     # (u, v, w)
        self.disjuncts = []              # (a, b) task pairs
        self.decisions = {}              # disjunct index -> 0/1
        self.conflicts = []              # list[Conflict]
        self.trail = []
        self._decision_depth = 0
        self._last_consistent = list(self.pot)
        self._slack_limit = None
        self._slack_used = 0

    # ------------------------------------------------------------------ input

    def _var(self, value, name):
        value = _as_int(value, name)
        if not 0 <= value <= self.num_tasks:
            raise InputError(
                f"{name} must be a task index 0..{self.num_tasks - 1} "
                f"or {self.num_tasks} (zero), got {value}")
        return value

    def _task(self, value, name):
        value = _as_int(value, name)
        if not 0 <= value < self.num_tasks:
            raise InputError(f"{name} must be a task index 0..{self.num_tasks - 1}, got {value}")
        return value

    def add_constraint(self, u, v, w, slack_budget=None):
        """Add x_v - x_u <= w.  Returns None, or a Conflict if inconsistent.

        The state is fully trailed: a later ``pop()`` undoes the constraint,
        the tightenings it caused and any conflict depending on it.
        Raises BudgetExhausted if slack_budget runs out mid-propagation.
        """
        u = self._var(u, "u")
        v = self._var(v, "v")
        w = _as_int(w, "w")
        self.trail.append(("static",))
        self.static_constraints.append((u, v, w))
        self.trail.append(("edge",))
        self.edges.append((u, v, w, ("static", len(self.static_constraints) - 1)))
        prev = (self._slack_limit, self._slack_used)
        self._slack_limit, self._slack_used = slack_budget, 0
        try:
            conflict = self._propagate()
        finally:
            self._slack_limit, self._slack_used = prev
        if conflict is not None:
            self.trail.append(("conflict", conflict))
            self.conflicts.append(conflict)
            return conflict
        self._last_consistent = list(self.pot)
        return None

    def add_constraints(self, constraints, slack_budget=None):
        """Batch add; validates everything first (atomic on input errors)."""
        if not isinstance(constraints, (list, tuple)):
            raise InputError("constraints must be a list of (u, v, w)")
        parsed = []
        for item in constraints:
            if not isinstance(item, (list, tuple)) or len(item) != 3:
                raise InputError(f"constraint must be a (u, v, w) triple, got {item!r}")
            u = self._var(item[0], "u")
            v = self._var(item[1], "v")
            w = _as_int(item[2], "w")
            parsed.append((u, v, w))
        for u, v, w in parsed:
            conflict = self.add_constraint(u, v, w, slack_budget=slack_budget)
            if conflict is not None:
                return conflict
        return None

    def add_disjunct(self, a, b):
        """Tasks a and b must not overlap in time."""
        a = self._task(a, "a")
        b = self._task(b, "b")
        if a == b:
            raise InputError("disjunct endpoints must be two different tasks")
        self.trail.append(("disjunct",))
        self.disjuncts.append((a, b))
        return len(self.disjuncts) - 1

    # ------------------------------------------------------------------- undo

    def push(self):
        """Open a nested checkpoint."""
        self.trail.append(("checkpoint",))

    def pop(self):
        """Revert everything since the matching push.  Returns success."""
        if not self.trail:
            return False
        while self.trail:
            entry = self.trail.pop()
            if entry[0] == "checkpoint":
                return True
            self._undo(entry)
        return False

    def _undo(self, entry):
        kind = entry[0]
        if kind == "pot":
            self.pot[entry[1]] = entry[2]
        elif kind == "edge":
            tag = self.edges.pop()[3]
            # purge conflicts that depend on the removed edge
            self.conflicts = [c for c in self.conflicts if tag not in c.deps]
        elif kind == "static":
            self.static_constraints.pop()
        elif kind == "disjunct":
            self.disjuncts.pop()
        elif kind == "decision":
            del self.decisions[entry[1]]
        elif kind == "conflict":
            try:
                self.conflicts.remove(entry[1])
            except ValueError:
                pass
        else:  # pragma: no cover - defensive
            raise RuntimeError(f"unknown trail entry {kind}")

    # ------------------------------------------------------------ propagation

    def _spend_slack(self):
        self._slack_used += 1
        if self._slack_limit is not None and self._slack_used > self._slack_limit:
            raise BudgetExhausted("slack")

    def _propagate(self):
        """Bellman-Ford rounds; returns a Conflict on a negative cycle."""
        n = self.num_vars
        pred = [-1] * n
        for rnd in range(1, n + 1):
            changed = False
            for ei, (u, v, w, _tag) in enumerate(self.edges):
                if self.pot[v] > self.pot[u] + w:
                    if rnd == n:
                        # relaxation still possible in round V: negative cycle
                        pred[v] = ei
                        return self._extract_cycle(v, pred)
                    self._spend_slack()
                    self.trail.append(("pot", v, self.pot[v]))
                    self.pot[v] = self.pot[u] + w
                    pred[v] = ei
                    changed = True
            if not changed:
                return None
        return None

    def _extract_cycle(self, start, pred):
        x = start
        for _ in range(self.num_vars):
            ei = pred[x]
            if ei < 0:  # pragma: no cover - defensive
                raise RuntimeError("broken predecessor chain")
            x = self.edges[ei][0]
        cycle_edges = []
        anchor = x
        while True:
            ei = pred[x]
            cycle_edges.append(ei)
            x = self.edges[ei][0]
            if x == anchor:
                break
        weight = sum(self.edges[ei][2] for ei in cycle_edges)
        tags = [self.edges[ei][3] for ei in cycle_edges]
        if weight >= 0:  # pragma: no cover - defensive
            raise RuntimeError("extracted cycle is not negative")
        return Conflict(tags, weight)

    # --------------------------------------------------------------- decisions

    def _apply_decision(self, k, value):
        self.push()
        self._decision_depth += 1
        a, b = self.disjuncts[k]
        if value == 0:   # a before b: x_b >= x_a + d_a  <=>  x_a - x_b <= -d_a
            u, v, w = b, a, -self.durations[a]
        else:            # b before a
            u, v, w = a, b, -self.durations[b]
        self.trail.append(("edge",))
        self.edges.append((u, v, w, ("decision", k)))
        self.trail.append(("decision", k))
        self.decisions[k] = value

    def _retract_decision(self):
        self.pop()
        self._decision_depth -= 1

    def _retract_all(self):
        while self._decision_depth:
            self._retract_decision()

    def _next_undecided(self):
        for k in range(len(self.disjuncts)):
            if k not in self.decisions:
                return k
        return None

    # ------------------------------------------------------------------ solve

    def solve(self, slack_budget=None, branch_budget=None, frontier=None):
        """Run the search.  Budgets are per-call; None means unlimited.

        Returns a JSON-serializable dict with status sat / unsat / unknown.
        """
        if slack_budget is not None:
            _as_int(slack_budget, "slack_budget")
            if slack_budget < 0:
                raise InputError("slack_budget must be >= 0")
        if branch_budget is not None:
            _as_int(branch_budget, "branch_budget")
            if branch_budget < 0:
                raise InputError("branch_budget must be >= 0")
        if frontier is not None:
            stack = self._restore_frontier(frontier)
        else:
            self._retract_all()
            stack = []
        prev = (self._slack_limit, self._slack_used)
        self._slack_limit, self._slack_used = slack_budget, 0
        branches_used = 0
        try:
            while True:
                conflict = self._propagate()
                if conflict is not None:
                    self.trail.append(("conflict", conflict))
                    self.conflicts.append(conflict)
                    node = conflict.to_json()
                    while True:  # backtrack
                        if not stack:
                            return self._finish(
                                "unsat", self._slack_used, branches_used,
                                certificate={"type": "unsat", "tree": node})
                        frame = stack[-1]
                        frame.children.append(node)
                        self._retract_decision()
                        if frame.untried:
                            frame.current = frame.untried.pop(0)
                            self._apply_decision(frame.disjunct, frame.current)
                            break
                        node = {"type": "branch",
                                "disjunct": frame.disjunct,
                                "children": frame.children}
                        stack.pop()
                    continue
                self._last_consistent = list(self.pot)
                nxt = self._next_undecided()
                if nxt is None:
                    schedule = self._schedule()
                    return self._finish(
                        "sat", self._slack_used, branches_used,
                        schedule=schedule,
                        certificate={"type": "sat", "schedule": schedule})
                if branch_budget is not None and branches_used >= branch_budget:
                    raise BudgetExhausted("branch")
                branches_used += 1
                stack.append(_Frame(nxt, 0, [1], []))
                self._apply_decision(nxt, 0)
        except BudgetExhausted as exc:
            result = {
                "status": "unknown",
                "reason": f"{exc.kind} budget exhausted",
                "candidate": self._candidate(),
                "frontier": self._snapshot(stack),
                "stats": {"relaxations": self._slack_used, "branches": branches_used},
            }
            self._retract_all()
            return result
        finally:
            self._slack_limit, self._slack_used = prev

    def _finish(self, status, relaxations, branches, **extra):
        self._retract_all()
        result = {"status": status,
                  "stats": {"relaxations": relaxations, "branches": branches}}
        result.update(extra)
        return result

    def _schedule(self):
        shift = self.pot[self.zero]
        return [self.pot[i] - shift for i in range(self.num_tasks)]

    def _candidate(self):
        shift = self._last_consistent[self.zero]
        return {
            "schedule": [self._last_consistent[i] - shift
                         for i in range(self.num_tasks)],
            "decisions": {str(k): v for k, v in sorted(self.decisions.items())},
            "undecided": [k for k in range(len(self.disjuncts))
                          if k not in self.decisions],
            "note": ("satisfies the static constraints and the decided "
                     "orderings only; not a proof of global feasibility"),
        }

    # --------------------------------------------------------------- frontier

    def _fingerprint(self):
        return json.dumps({
            "durations": self.durations,
            "constraints": [list(c) for c in self.static_constraints],
            "disjuncts": [list(d) for d in self.disjuncts],
        }, sort_keys=True)

    def _snapshot(self, stack):
        return {
            "fingerprint": self._fingerprint(),
            "frames": [
                {"disjunct": f.disjunct, "current": f.current,
                 "untried": list(f.untried), "children": f.children}
                for f in stack
            ],
        }

    def _restore_frontier(self, token):
        if not isinstance(token, dict) or not isinstance(token.get("frames"), list):
            raise InputError("frontier must be an object with a 'frames' list")
        if token.get("fingerprint") != self._fingerprint():
            raise InputError("frontier does not match the solver's static state")
        self._retract_all()
        stack = []
        try:
            for entry in token["frames"]:
                if not isinstance(entry, dict):
                    raise InputError("frontier frame must be an object")
                k = _as_int(entry.get("disjunct"), "frame.disjunct")
                if not 0 <= k < len(self.disjuncts):
                    raise InputError(f"frame references unknown disjunct {k}")
                if k in self.decisions:
                    raise InputError(f"disjunct {k} decided twice in frontier")
                current = _as_int(entry.get("current"), "frame.current")
                if current not in (0, 1):
                    raise InputError("frame.current must be 0 or 1")
                untried = entry.get("untried", [])
                if not isinstance(untried, list) or any(v not in (0, 1) for v in untried):
                    raise InputError("frame.untried must be a list of 0/1 values")
                children = entry.get("children", [])
                if not isinstance(children, list):
                    raise InputError("frame.children must be a list")
                self._apply_decision(k, current)
                stack.append(_Frame(k, current, list(untried), children))
        except InputError:
            self._retract_all()
            raise
        return stack
