"""Problem definition: finite integer domains and allowed-tuple table constraints."""

from __future__ import annotations

import json


class ProblemError(ValueError):
    """Raised for malformed problems or constraints."""


class Problem:
    """A finite-domain CSP.

    Variables map to non-empty sorted lists of integer values.  Constraints
    are allowed-tuple tables over an ordered scope.  Every mutation bumps
    ``_mod_counter`` so solvers can detect stale search state; each constraint
    carries a stable ``id`` and ``version`` used by the subproblem cache.
    """

    def __init__(self, variables, constraints=None):
        self.variables = {}
        for name, values in variables.items():
            name = str(name)
            if name in self.variables:
                raise ProblemError(f"duplicate variable {name!r}")
            vals = sorted({self._check_value(v) for v in values})
            if not vals:
                raise ProblemError(f"variable {name!r} has an empty domain")
            self.variables[name] = vals
        if not self.variables:
            raise ProblemError("problem needs at least one variable")
        self.constraints = {}
        self._next_id = 1
        self._mod_counter = 0
        for c in constraints or []:
            self.add_constraint(c["scope"], c["tuples"])

    @staticmethod
    def _check_value(value):
        if isinstance(value, bool) or not isinstance(value, int):
            raise ProblemError(f"domain value {value!r} is not an integer")
        return value

    def _insert_constraint(self, scope, tuples, cid=None, version=1):
        scope = [str(s) for s in scope]
        if not scope:
            raise ProblemError("constraint scope must be non-empty")
        if len(set(scope)) != len(scope):
            raise ProblemError("constraint scope has duplicate variables")
        for s in scope:
            if s not in self.variables:
                raise ProblemError(f"unknown variable {s!r} in constraint scope")
        norm = set()
        for t in tuples:
            t = tuple(t)
            if len(t) != len(scope):
                raise ProblemError("tuple arity does not match constraint scope")
            for value, var in zip(t, scope):
                self._check_value(value)
                if value not in self.variables[var]:
                    raise ProblemError(
                        f"tuple value {value!r} outside domain of {var!r}"
                    )
            norm.add(t)
        if cid is None:
            cid = self._next_id
        if cid in self.constraints:
            raise ProblemError(f"constraint id {cid} already in use")
        self._next_id = max(self._next_id, cid + 1)
        self.constraints[cid] = {
            "id": cid,
            "version": int(version),
            "scope": scope,
            "tuples": sorted(list(t) for t in norm),
        }
        self._mod_counter += 1
        return cid

    def add_constraint(self, scope, tuples):
        """Add a table constraint; returns its new constraint id."""
        return self._insert_constraint(scope, tuples)

    def remove_constraint(self, cid):
        """Revoke a constraint by id."""
        if cid not in self.constraints:
            raise ProblemError(f"no constraint with id {cid}")
        del self.constraints[cid]
        self._mod_counter += 1

    def signature(self):
        """Canonical string identifying variables + constraints (+versions)."""
        return json.dumps(self.to_dict(), sort_keys=True)

    def to_dict(self):
        return {
            "variables": {v: list(d) for v, d in sorted(self.variables.items())},
            "constraints": [
                {
                    "id": c["id"],
                    "version": c["version"],
                    "scope": list(c["scope"]),
                    "tuples": [list(t) for t in c["tuples"]],
                }
                for _, c in sorted(self.constraints.items())
            ],
        }

    @classmethod
    def from_dict(cls, data):
        problem = cls(data["variables"])
        for c in data.get("constraints", []):
            if "id" in c:
                problem._insert_constraint(
                    c["scope"],
                    c["tuples"],
                    cid=int(c["id"]),
                    version=c.get("version", 1),
                )
            else:
                problem.add_constraint(c["scope"], c["tuples"])
        return problem
