"""Canonical subproblem cache.

Cache keys are the canonical content of a subproblem: the exact variable
domains plus the content of every constraint contained in it.  Every
entry additionally records the variable domains, the constraint version
at insertion time, and a ``constraint id -> content digest`` map.  An
entry is only reused when the current problem still contains exactly the
same constraints (by id and content) over those variables, so entries
whose proof basis was revoked or extended are never reused.
"""

from __future__ import annotations

import json


class Cache:
    def __init__(self):
        self.entries = {}
        self.hits = 0
        self.stale = 0
        self.misses = 0

    @staticmethod
    def key_for(vars_, domains, cons):
        data = {
            "domains": [[v, list(domains[v])] for v in sorted(vars_)],
            "constraints": sorted(
                [[list(c.scope), [list(t) for t in c.tuples]] for c in cons]
            ),
        }
        return json.dumps(data, sort_keys=True, separators=(",", ":"))

    def insert(self, problem, vars_, domains, cons, count):
        key = self.key_for(vars_, domains, cons)
        self.entries[key] = {
            "key": key,
            "count": int(count),
            "domains": {v: list(domains[v]) for v in sorted(vars_)},
            "constraints": {c.cid: c.digest() for c in cons},
            "constraint_version": problem.constraint_version,
        }

    def lookup(self, problem, vars_, domains, cons):
        key = self.key_for(vars_, domains, cons)
        entry = self.entries.get(key)
        if entry is None:
            self.misses += 1
            return None
        varset = set(vars_)
        current = {
            c.cid: c.digest()
            for c in problem.constraints.values()
            if set(c.scope) <= varset
        }
        if current != entry["constraints"]:
            # The proof basis changed (constraint added, removed or
            # replaced over these variables): the entry is not reusable.
            self.stale += 1
            return None
        self.hits += 1
        return entry["count"]

    def to_json(self):
        return [self.entries[k] for k in sorted(self.entries)]

    @classmethod
    def from_json(cls, data):
        cache = cls()
        for entry in data:
            cache.entries[entry["key"]] = {
                "key": entry["key"],
                "count": int(entry["count"]),
                "domains": {v: list(vals) for v, vals in entry["domains"].items()},
                "constraints": dict(entry["constraints"]),
                "constraint_version": int(entry["constraint_version"]),
            }
        return cache
