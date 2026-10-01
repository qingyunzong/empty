"""CSP solver core with a non-copying Trail mechanism and AC-3 propagation.

Decision levels start at 0. Initial propagation runs at level 0 and its
trail entries are never undone. Each new variable assignment pushes a new
decision level; backtracking to level L undoes, in reverse order, exactly
the trail entries recorded at levels strictly greater than L.
"""

from __future__ import annotations

import json
from collections import deque


class CspError(Exception):
    """Base class for all CSP errors."""


class ProblemFormatError(CspError):
    """The problem definition is malformed."""


class UnknownVariableError(CspError):
    """Assignment targets a variable that does not exist."""


class DomainValueError(CspError):
    """Assigned value is not in the declared domain of the variable."""


class InvalidLevelError(CspError):
    """Backtrack target level is negative or above the current level."""


class Problem:
    """Finite integer domains plus binary allowed (table) constraints."""

    def __init__(self, domains, constraints):
        # domains: {name: iterable[int]}; constraints: [(x, y, iterable[(a, b)])]
        self.domains = {name: tuple(values) for name, values in domains.items()}
        self.constraints = [
            (x, y, frozenset(pairs)) for x, y, pairs in constraints
        ]
        # arcs_to[x]: entries (y, allowed) to revise x against y, allowed
        # pairs oriented as (x_value, y_value).
        self.arcs_to = {name: [] for name in self.domains}
        # dependent[x]: entries (y, allowed) to re-check when x changes,
        # allowed pairs oriented as (y_value, x_value).
        self.dependent = {name: [] for name in self.domains}
        for x, y, allowed in self.constraints:
            reversed_allowed = frozenset((b, a) for a, b in allowed)
            self.arcs_to[x].append((y, allowed))
            self.arcs_to[y].append((x, reversed_allowed))
            self.dependent[x].append((y, reversed_allowed))
            self.dependent[y].append((x, allowed))

    @classmethod
    def from_dict(cls, data):
        if not isinstance(data, dict):
            raise ProblemFormatError("problem must be a JSON object")
        variables = data.get("variables")
        if not isinstance(variables, dict) or not variables:
            raise ProblemFormatError("'variables' must be a non-empty object")
        domains = {}
        for name, values in variables.items():
            if not isinstance(name, str):
                raise ProblemFormatError("variable names must be strings")
            if (
                not isinstance(values, list)
                or not values
                or any(not isinstance(v, int) or isinstance(v, bool) for v in values)
            ):
                raise ProblemFormatError(
                    f"domain of '{name}' must be a non-empty list of integers"
                )
            if len(set(values)) != len(values):
                raise ProblemFormatError(f"domain of '{name}' contains duplicates")
            domains[name] = list(values)
        raw_constraints = data.get("constraints", [])
        if not isinstance(raw_constraints, list):
            raise ProblemFormatError("'constraints' must be a list")
        constraints = []
        for index, item in enumerate(raw_constraints):
            if not isinstance(item, dict):
                raise ProblemFormatError(f"constraint #{index} must be an object")
            scope = item.get("vars")
            if (
                not isinstance(scope, list)
                or len(scope) != 2
                or not all(isinstance(v, str) for v in scope)
            ):
                raise ProblemFormatError(
                    f"constraint #{index}: 'vars' must be a list of two names"
                )
            x, y = scope
            for var in (x, y):
                if var not in domains:
                    raise ProblemFormatError(
                        f"constraint #{index}: unknown variable '{var}'"
                    )
            allowed = item.get("allowed")
            if not isinstance(allowed, list):
                raise ProblemFormatError(
                    f"constraint #{index}: 'allowed' must be a list of pairs"
                )
            pairs = set()
            for pair in allowed:
                if (
                    not isinstance(pair, list)
                    or len(pair) != 2
                    or any(
                        not isinstance(v, int) or isinstance(v, bool) for v in pair
                    )
                ):
                    raise ProblemFormatError(
                        f"constraint #{index}: allowed entries must be [int, int]"
                    )
                a, b = pair
                if a not in domains[x] or b not in domains[y]:
                    raise ProblemFormatError(
                        f"constraint #{index}: pair [{a}, {b}] outside domains"
                    )
                pairs.add((a, b))
            constraints.append((x, y, frozenset(pairs)))
        return cls(domains, constraints)

    @classmethod
    def from_json_file(cls, path):
        try:
            with open(path, "r", encoding="utf-8") as handle:
                data = json.load(handle)
        except OSError as exc:
            raise ProblemFormatError(f"cannot read problem file: {exc}") from exc
        except json.JSONDecodeError as exc:
            raise ProblemFormatError(f"invalid JSON in problem file: {exc}") from exc
        return cls.from_dict(data)


class Solver:
    """Trail-based solver. Domains are mutated in place; every value removal
    is recorded on the trail as (variable, value, level)."""

    def __init__(self, problem):
        self.problem = problem
        self.domains = {name: set(values) for name, values in problem.domains.items()}
        self.trail = []  # list of (variable, value, level), levels non-decreasing
        self.level = 0
        self.assignments = []  # list of (variable, value, level)
        self.status = "ok"
        queue = deque()
        for xi, arcs in problem.arcs_to.items():
            for xj, allowed in arcs:
                queue.append((xi, xj, allowed))
        if not self._ac3(queue):
            # Empty domain during level-0 propagation of the raw constraints.
            self.status = "unsat"

    def _remove(self, var, value):
        self.domains[var].remove(value)
        self.trail.append((var, value, self.level))

    def _ac3(self, queue):
        while queue:
            xi, xj, allowed = queue.popleft()
            domain = self.domains[xi]
            other = self.domains[xj]
            doomed = [a for a in domain if not any((a, b) in allowed for b in other)]
            if not doomed:
                continue
            for a in doomed:
                self._remove(xi, a)
            if not domain:
                return False
            for xk, allowed_ki in self.problem.dependent[xi]:
                if xk != xj:
                    queue.append((xk, xi, allowed_ki))
        return True

    def assign(self, var, value):
        """Assign var=value on a new decision level and propagate with AC-3.

        Returns True on success. On a propagation conflict the assignment and
        all its propagated removals are undone automatically, the level drops
        back, status becomes "conflict" and False is returned.
        """
        if self.status == "unsat":
            raise CspError("cannot assign: problem is unsat")
        if var not in self.domains:
            raise UnknownVariableError(f"unknown variable '{var}'")
        if value not in self.problem.domains[var]:
            raise DomainValueError(
                f"value {value!r} not in declared domain of '{var}'"
            )
        previous_level = self.level
        self.level += 1
        for other in list(self.domains[var]):
            if other != value:
                self._remove(var, other)
        self.assignments.append((var, value, self.level))
        ok = bool(self.domains[var])
        if ok:
            queue = deque(
                (xk, var, allowed) for xk, allowed in self.problem.dependent[var]
            )
            ok = self._ac3(queue)
        if not ok:
            self._undo_to(previous_level)
            self.status = "conflict"
        else:
            self.status = "ok"
        return ok

    def backtrack(self, level):
        """Undo, in reverse order, every trail entry above the target level."""
        if not isinstance(level, int) or isinstance(level, bool):
            raise InvalidLevelError(f"invalid backtrack level {level!r}")
        if level < 0 or level > self.level:
            raise InvalidLevelError(
                f"cannot backtrack to level {level}: current level is {self.level}"
            )
        self._undo_to(level)
        if self.status != "unsat":
            self.status = "ok"

    def _undo_to(self, level):
        while self.trail and self.trail[-1][2] > level:
            var, value, _ = self.trail.pop()
            self.domains[var].add(value)
        while self.assignments and self.assignments[-1][2] > level:
            self.assignments.pop()
        self.level = level

    def snapshot(self):
        return {
            "current_level": self.level,
            "domains": {var: sorted(dom) for var, dom in self.domains.items()},
            "status": self.status,
        }
