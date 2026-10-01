"""CSP solver core with a non-copying Trail mechanism.

Semantics:
- Decision levels start at 0. Initial AC-3 propagation runs at level 0.
- Each new variable assignment pushes a new decision level and triggers
  AC-3 propagation automatically.
- Every domain value removal is recorded on the trail as (var, value, level).
  No full deep copies of domain state are ever made.
- If propagation after an assignment empties a domain, the assignment and
  its propagation are undone (conflict). If level-0 propagation on the
  original constraints empties a domain, the problem is unsat.
- Backtracking to a target level undoes, in reverse order, exactly the
  trail entries with level strictly greater than the target. Level-0
  entries are never undone.
"""

from __future__ import annotations


class CSPError(Exception):
    """Base class for CSP errors."""


class UnknownVariableError(CSPError):
    """Assignment targets a variable that does not exist."""


class ValueNotInDomainError(CSPError):
    """Assigned value is not in the variable's current domain."""


class InvalidLevelError(CSPError):
    """Backtrack level is negative or exceeds the current maximum level."""


class TrailCSP:
    """Finite-domain integer CSP with binary allowed-constraints and a trail."""

    STATUS_OK = "ok"
    STATUS_CONFLICT = "conflict"
    STATUS_UNSAT = "unsat"

    def __init__(self, variables, constraints):
        """
        variables: dict mapping variable name -> iterable of int values.
        constraints: iterable of (var1, var2, allowed) where allowed is an
        iterable of (value1, value2) permitted pairs.
        """
        self.domains = {name: set(values) for name, values in variables.items()}
        for name, values in variables.items():
            if not values:
                raise CSPError(f"variable {name!r} has an empty initial domain")
        # neighbors[var] = list of (other_var, allowed_pairs) where
        # allowed_pairs contains (value_of_var, value_of_other_var) tuples.
        self._neighbors = {name: [] for name in variables}
        for var1, var2, allowed in constraints:
            if var1 not in self.domains:
                raise UnknownVariableError(f"unknown variable in constraint: {var1!r}")
            if var2 not in self.domains:
                raise UnknownVariableError(f"unknown variable in constraint: {var2!r}")
            forward = {(int(a), int(b)) for a, b in allowed}
            self._neighbors[var1].append((var2, forward))
            self._neighbors[var2].append((var1, {(b, a) for a, b in forward}))
        # Trail of (var, removed_value, level); never deep-copied state.
        self.trail = []
        self.current_level = 0
        self.status = self.STATUS_OK
        # Initial propagation of the original constraints at level 0.
        queue = [
            (var, other)
            for var in self.domains
            for other, _ in self._neighbors[var]
        ]
        if not self._ac3(queue):
            self.status = self.STATUS_UNSAT

    # ------------------------------------------------------------------
    # propagation
    # ------------------------------------------------------------------
    def _remove_value(self, var, value):
        self.domains[var].discard(value)
        self.trail.append((var, value, self.current_level))

    def _revise(self, var, other, allowed):
        revised = False
        domain_other = self.domains[other]
        for value in list(self.domains[var]):
            if not any((value, b) in allowed for b in domain_other):
                self._remove_value(var, value)
                revised = True
        return revised

    def _ac3(self, queue):
        """Run AC-3 from the given arc queue. Returns False on empty domain."""
        allowed_map = {}
        for var in self.domains:
            for other, allowed in self._neighbors[var]:
                allowed_map[(var, other)] = allowed
        while queue:
            var, other = queue.pop()
            allowed = allowed_map.get((var, other))
            if allowed is None:
                continue
            if self._revise(var, other, allowed):
                if not self.domains[var]:
                    return False
                for neighbor, _ in self._neighbors[var]:
                    if neighbor != other:
                        queue.append((neighbor, var))
        return True

    # ------------------------------------------------------------------
    # public operations
    # ------------------------------------------------------------------
    def assign(self, var, value):
        """Assign var=value at a new decision level and propagate with AC-3.

        Returns STATUS_OK or STATUS_CONFLICT. On conflict the assignment and
        all of its propagation effects are undone automatically.
        """
        if var not in self.domains:
            raise UnknownVariableError(f"unknown variable: {var!r}")
        if value not in self.domains[var]:
            raise ValueNotInDomainError(
                f"value {value!r} is not in the domain of {var!r}"
            )
        self.current_level += 1
        level = self.current_level
        for other_value in sorted(self.domains[var]):
            if other_value != value:
                self._remove_value(var, other_value)
        queue = [(neighbor, var) for neighbor, _ in self._neighbors[var]]
        if not self._ac3(queue):
            self._undo_to(level - 1)
            return self.STATUS_CONFLICT
        return self.STATUS_OK

    def backtrack(self, level):
        """Undo, in reverse order, all trail entries above the target level."""
        if isinstance(level, bool) or not isinstance(level, int):
            raise InvalidLevelError(f"invalid backtrack level: {level!r}")
        if level < 0:
            raise InvalidLevelError(f"backtrack level must be >= 0, got {level}")
        if level > self.current_level:
            raise InvalidLevelError(
                f"backtrack level {level} exceeds current level {self.current_level}"
            )
        self._undo_to(level)

    def _undo_to(self, level):
        while self.trail and self.trail[-1][2] > level:
            var, value, _ = self.trail.pop()
            self.domains[var].add(value)
        self.current_level = level

    # ------------------------------------------------------------------
    # inspection helpers
    # ------------------------------------------------------------------
    def snapshot(self):
        """Sorted-list view of current domains (for output/comparison)."""
        return {name: sorted(values) for name, values in self.domains.items()}


def load_problem(path):
    """Load a JSON problem file into (variables, constraints)."""
    import json

    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    variables = data.get("variables")
    if not isinstance(variables, dict) or not variables:
        raise CSPError("problem file must define a non-empty 'variables' object")
    parsed_variables = {}
    for name, values in variables.items():
        if not isinstance(values, list) or not all(
            isinstance(v, int) and not isinstance(v, bool) for v in values
        ):
            raise CSPError(f"domain of {name!r} must be a list of integers")
        parsed_variables[str(name)] = list(values)
    constraints = []
    for entry in data.get("constraints", []):
        try:
            var1 = str(entry["var1"])
            var2 = str(entry["var2"])
            allowed = [tuple(pair) for pair in entry["allowed"]]
        except (KeyError, TypeError, ValueError) as exc:
            raise CSPError(f"malformed constraint entry: {entry!r}") from exc
        constraints.append((var1, var2, allowed))
    return parsed_variables, constraints
