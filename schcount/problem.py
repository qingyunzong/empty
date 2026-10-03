"""Finite-integer-domain problem definition with allowed-tuple table constraints."""

from __future__ import annotations

import hashlib
import json


def _canonical_problem_json(data):
    """Return the canonical JSON-able form of a problem description."""
    variables = {
        str(name): sorted({int(x) for x in values})
        for name, values in data["variables"].items()
    }
    constraints = []
    for c in data.get("constraints", []):
        scope = [str(v) for v in c["scope"]]
        tuples = sorted({tuple(int(x) for x in t) for t in c["tuples"]})
        constraints.append(
            {"id": str(c["id"]), "scope": scope, "tuples": [list(t) for t in tuples]}
        )
    constraints.sort(key=lambda c: c["id"])
    return {"variables": variables, "constraints": constraints}


def problem_digest(data):
    """Stable SHA-256 digest binding a certificate/checkpoint to a problem."""
    canonical = _canonical_problem_json(data)
    blob = json.dumps(canonical, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


class Constraint:
    """A table constraint: only the listed tuples of values are allowed."""

    def __init__(self, cid, scope, tuples):
        scope = tuple(str(v) for v in scope)
        if not scope:
            raise ValueError("constraint scope must be non-empty")
        if len(set(scope)) != len(scope):
            raise ValueError("duplicate variable in constraint scope")
        normalized = set()
        for t in tuples:
            t = tuple(int(x) for x in t)
            if len(t) != len(scope):
                raise ValueError("tuple arity does not match constraint scope")
            normalized.add(t)
        if not normalized:
            raise ValueError("table constraint must allow at least one tuple")
        self.cid = str(cid)
        self.scope = scope
        self.tuples = tuple(sorted(normalized))
        self.tuple_set = frozenset(normalized)

    def digest(self):
        blob = json.dumps(
            [self.cid, list(self.scope), [list(t) for t in self.tuples]],
            sort_keys=True,
            separators=(",", ":"),
        )
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()

    def to_json(self):
        return {
            "id": self.cid,
            "scope": list(self.scope),
            "tuples": [list(t) for t in self.tuples],
        }

    @classmethod
    def from_json(cls, data):
        return cls(data["id"], data["scope"], data["tuples"])


class Problem:
    """Variables with finite integer domains plus table constraints.

    ``constraint_version`` is bumped on every constraint addition or
    removal so that derived artifacts (search trees, cache entries) can
    tell whether their proof basis is still intact.
    """

    def __init__(self):
        self.domains = {}
        self.constraints = {}
        self.constraint_version = 0

    def add_variable(self, name, values):
        name = str(name)
        vals = sorted({int(v) for v in values})
        if not vals:
            raise ValueError("variable domain must be non-empty")
        if name in self.domains:
            raise ValueError("duplicate variable: %s" % name)
        self.domains[name] = vals

    def add_constraint(self, constraint):
        for var in constraint.scope:
            if var not in self.domains:
                raise ValueError("constraint references unknown variable: %s" % var)
        for t in constraint.tuples:
            for var, val in zip(constraint.scope, t):
                if val not in self.domains[var]:
                    raise ValueError(
                        "tuple value %r not in domain of %s" % (val, var)
                    )
        self.constraints[constraint.cid] = constraint
        self.constraint_version += 1

    def remove_constraint(self, cid):
        if cid not in self.constraints:
            raise KeyError("unknown constraint: %s" % cid)
        del self.constraints[cid]
        self.constraint_version += 1

    def to_json(self):
        return {
            "variables": {v: list(vals) for v, vals in sorted(self.domains.items())},
            "constraints": [
                self.constraints[cid].to_json() for cid in sorted(self.constraints)
            ],
            "constraint_version": self.constraint_version,
        }

    @classmethod
    def from_json(cls, data):
        problem = cls()
        for name, values in data["variables"].items():
            problem.add_variable(name, values)
        for c in data.get("constraints", []):
            problem.add_constraint(Constraint.from_json(c))
        problem.constraint_version = int(
            data.get("constraint_version", problem.constraint_version)
        )
        return problem

    def digest(self):
        return problem_digest(self.to_json())
