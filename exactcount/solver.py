"""Exact solution counter: GAC propagation + deterministic branching with
connected-component factorization, a canonical subproblem cache, support-check
budgeting and JSON-serializable checkpoints.

Budget unit: one value-support check (one call testing whether a value of a
variable still has a supporting allowed tuple in one constraint).  The solver
may pause after any check; the search tree's leaves always form a partition
of the remaining assignment space, so bounds never double-count.
"""

from __future__ import annotations

import copy
import json

from .problem import Problem


class _Pause(Exception):
    """Internal: raised when the support-check budget is exhausted."""


class Solver:
    CHECKPOINT_FORMAT = "exactcount-checkpoint-1"
    CERTIFICATE_FORMAT = "exactcount-certificate-1"

    def __init__(self, problem):
        if not isinstance(problem, Problem):
            raise TypeError("Solver expects a Problem instance")
        self.problem = problem
        self.cache = {}
        self.checks_total = 0
        self.checks_this_run = 0
        self.budget = 0
        self.stats = {"cache_hits": 0, "cache_misses": 0}
        self.root = None
        self._built_mod = -1
        self._ensure_tree()

    # ------------------------------------------------------------------ state

    def _ensure_tree(self):
        if self.root is None or self._built_mod != self.problem._mod_counter:
            # Constraints were added/revoked (or first build): the old search
            # tree lost its proof basis and is discarded.  Cache entries are
            # kept; their keys carry domains and constraint versions, so only
            # still-valid entries can be reused.
            self.root = {
                "type": "frontier",
                "context": sorted(self.problem.variables),
                "cids": sorted(self.problem.constraints),
                "domains": {v: list(d) for v, d in self.problem.variables.items()},
                "queue": self._initial_queue(sorted(self.problem.constraints)),
            }
            self._built_mod = self.problem._mod_counter

    def _initial_queue(self, cids):
        return sorted(
            [cid, var]
            for cid in cids
            for var in self.problem.constraints[cid]["scope"]
        )

    def solve(self, budget=None):
        """Run until complete or until ``budget`` support checks are consumed.

        Returns a dict with confirmed_lower / certified_upper / complete;
        ``exact`` is only set when the bounds coincide (complete search).
        """
        if budget is not None and budget < 0:
            raise ValueError("budget must be non-negative")
        self._ensure_tree()
        self.budget = float("inf") if budget is None else budget
        self.checks_this_run = 0
        try:
            self._process(self.root)
        except _Pause:
            pass
        lower, upper = self._bounds(self.root)
        complete = not self._has_frontier(self.root)
        if complete and lower != upper:
            raise AssertionError("complete search produced inconsistent bounds")
        return {
            "confirmed_lower": lower,
            "certified_upper": upper,
            "complete": complete,
            "exact": lower if complete else None,
            "checks_this_run": self.checks_this_run,
            "checks_total": self.checks_total,
            "cache_hits": self.stats["cache_hits"],
            "cache_misses": self.stats["cache_misses"],
        }

    # ---------------------------------------------------------------- search

    def _process(self, node):
        kind = node["type"]
        if kind == "frontier":
            self._expand(node)
        elif kind in ("branch", "decompose"):
            for child in node["children"]:
                self._process(child)

    def _expand(self, node):
        self._propagate(node)
        if node["type"] == "dead":
            return
        if all(len(node["domains"][v]) == 1 for v in node["context"]):
            node["type"] = "solution"
            node.pop("queue", None)
            return
        key = self._cache_key(node)
        cached = self.cache.get(key)
        if cached is not None:
            self.stats["cache_hits"] += 1
            node.clear()
            node.update(copy.deepcopy(cached["subtree"]))
            return
        self.stats["cache_misses"] += 1
        components, isolated = self._split(node)
        if not components:
            count = 1
            for v in node["context"]:
                count *= len(node["domains"][v])
            node.pop("queue", None)
            node["type"] = "free"
            node["count"] = count
        elif len(components) == 1 and not isolated:
            self._branch(node)
        else:
            node.pop("queue", None)
            node["type"] = "decompose"
            children = []
            if isolated:
                children.append(self._make_free_child(node, isolated))
            for comp in components:
                children.append(self._make_component_child(node, comp))
            node["children"] = children
            for child in children:
                if child["type"] == "frontier":
                    self._process(child)
        if not self._has_frontier(node):
            self.cache[key] = {
                "count": self._bounds(node)[0],
                "subtree": copy.deepcopy(node),
            }

    def _make_free_child(self, node, isolated):
        iso_set = set(isolated)
        cids = self._cids_with_open_scope_in(node, iso_set)
        relevant = set(isolated)
        for cid in cids:
            relevant.update(self.problem.constraints[cid]["scope"])
        count = 1
        for v in isolated:
            count *= len(node["domains"][v])
        return {
            "type": "free",
            "context": sorted(isolated),
            "cids": sorted(cids),
            "domains": {v: list(node["domains"][v]) for v in sorted(relevant)},
            "count": count,
        }

    def _make_component_child(self, node, comp):
        comp_set = set(comp)
        cids = self._cids_with_open_scope_in(node, comp_set)
        relevant = set(comp)
        for cid in cids:
            relevant.update(self.problem.constraints[cid]["scope"])
        return {
            "type": "frontier",
            "context": sorted(comp),
            "cids": sorted(cids),
            "domains": {v: list(node["domains"][v]) for v in sorted(relevant)},
            "queue": [],
        }

    def _branch(self, node):
        var = min(
            (v for v in node["context"] if len(node["domains"][v]) > 1),
            key=lambda v: (len(node["domains"][v]), v),
        )
        node.pop("queue", None)
        node["type"] = "branch"
        node["var"] = var
        node["children"] = []
        for value in node["domains"][var]:
            queue = sorted(
                [cid, x]
                for cid in node["cids"]
                if var in self.problem.constraints[cid]["scope"]
                for x in self.problem.constraints[cid]["scope"]
            )
            child = {
                "type": "frontier",
                "context": list(node["context"]),
                "cids": list(node["cids"]),
                "domains": {v: list(d) for v, d in node["domains"].items()},
                "queue": queue,
            }
            child["domains"][var] = [value]
            node["children"].append(child)
        for child in node["children"]:
            self._process(child)

    # ------------------------------------------------------------ propagation

    def _propagate(self, node):
        # Queue entries are [cid, var] or [cid, var, pending_values, changed]:
        # when a pause interrupts the revision of one (constraint, variable)
        # pair, the not-yet-checked values and the "domain changed" flag stay
        # in the entry, so resuming never loses nor repeats revision progress.
        queue = [list(e) for e in node.get("queue", [])]
        queued = {(e[0], e[1]) for e in queue}
        domains = node["domains"]
        while queue:
            entry = queue[0]
            cid, x = entry[0], entry[1]
            constraint = self.problem.constraints[cid]
            if x not in constraint["scope"]:
                queue.pop(0)
                queued.discard((cid, x))
                continue
            if len(entry) == 2:
                entry.extend([list(domains[x]), False])
            pending = entry[2]
            while pending:
                value = pending[0]
                if self.checks_this_run >= self.budget:
                    node["queue"] = queue
                    raise _Pause()
                self.checks_this_run += 1
                self.checks_total += 1
                pending.pop(0)
                if value in domains[x] and not self._has_support(
                    constraint, x, value, domains
                ):
                    domains[x].remove(value)
                    entry[3] = True
                    if not domains[x]:
                        node["type"] = "dead"
                        node["queue"] = []
                        return
            queue.pop(0)
            queued.discard((cid, x))
            if entry[3]:
                for cid2 in node["cids"]:
                    if cid2 == cid:
                        continue
                    c2 = self.problem.constraints[cid2]
                    if x not in c2["scope"]:
                        continue
                    for x2 in c2["scope"]:
                        if (cid2, x2) not in queued:
                            queued.add((cid2, x2))
                            queue.append([cid2, x2])
                queue.sort()
        node["queue"] = []

    @staticmethod
    def _has_support(constraint, var, value, domains):
        scope = constraint["scope"]
        idx = scope.index(var)
        for t in constraint["tuples"]:
            if t[idx] != value:
                continue
            if all(t[j] in domains[s] for j, s in enumerate(scope)):
                return True
        return False

    # ------------------------------------------------------------- components

    def _split(self, node):
        """Connected components of the constraint graph over open variables."""
        open_vars = [v for v in node["context"] if len(node["domains"][v]) > 1]
        parent = {v: v for v in open_vars}

        def find(a):
            while parent[a] != a:
                parent[a] = parent[parent[a]]
                a = parent[a]
            return a

        def union(a, b):
            ra, rb = find(a), find(b)
            if ra != rb:
                hi, lo = max(ra, rb), min(ra, rb)
                parent[hi] = lo

        for cid in node["cids"]:
            ovs = [
                v
                for v in self.problem.constraints[cid]["scope"]
                if len(node["domains"][v]) > 1
            ]
            for other in ovs[1:]:
                union(ovs[0], other)
        groups = {}
        for v in open_vars:
            groups.setdefault(find(v), []).append(v)
        components = sorted(sorted(g) for g in groups.values() if len(g) > 1)
        isolated = sorted(v for g in groups.values() if len(g) == 1 for v in g)
        return components, isolated

    def _cids_with_open_scope_in(self, node, var_set):
        result = []
        for cid in node["cids"]:
            scope = self.problem.constraints[cid]["scope"]
            oscope = [s for s in scope if len(node["domains"][s]) > 1]
            if oscope and all(s in var_set for s in oscope):
                result.append(cid)
        return result

    # ------------------------------------------------------------------ cache

    def _cache_key(self, node):
        """Canonical key: variable domains + constraint contents + versions."""
        relevant = set(node["context"])
        cons = []
        for cid in sorted(node["cids"]):
            c = self.problem.constraints[cid]
            relevant.update(c["scope"])
            cons.append(
                {
                    "id": c["id"],
                    "version": c["version"],
                    "scope": list(c["scope"]),
                    "tuples": [list(t) for t in c["tuples"]],
                }
            )
        key_obj = {
            "context": sorted(node["context"]),
            "domains": [[v, list(node["domains"][v])] for v in sorted(relevant)],
            "constraints": cons,
        }
        return json.dumps(key_obj, sort_keys=True)

    # ----------------------------------------------------------------- bounds

    def _bounds(self, node):
        kind = node["type"]
        if kind == "solution":
            return (1, 1)
        if kind == "dead":
            return (0, 0)
        if kind == "free":
            return (node["count"], node["count"])
        if kind == "frontier":
            upper = 1
            for v in node["context"]:
                upper *= len(node["domains"][v])
            return (0, upper)
        if kind == "branch":
            lo = hi = 0
            for child in node["children"]:
                l, u = self._bounds(child)
                lo += l
                hi += u
            return (lo, hi)
        if kind == "decompose":
            lo = hi = 1
            for child in node["children"]:
                l, u = self._bounds(child)
                lo *= l
                hi *= u
            return (lo, hi)
        raise AssertionError(f"unknown node type {kind!r}")

    def _has_frontier(self, node):
        if node["type"] == "frontier":
            return True
        return any(self._has_frontier(c) for c in node.get("children", []))

    # --------------------------------------------------------- serialization

    def certificate(self):
        """Self-contained proof artifact for the independent checker."""
        lower, upper = self._bounds(self.root)
        complete = not self._has_frontier(self.root)
        return {
            "format": self.CERTIFICATE_FORMAT,
            "problem": self.problem.to_dict(),
            "confirmed_lower": lower,
            "certified_upper": upper,
            "complete": complete,
            "tree": _strip_operational(self.root),
            "frontier": self._flatten_frontier(),
        }

    def _flatten_frontier(self):
        """Frontier leaves as full assignment-space descriptions (all vars)."""
        result = []

        def walk(node, full):
            current = dict(full)
            current.update(node["domains"])
            if node["type"] == "frontier":
                result.append(
                    {"domains": {v: list(current[v]) for v in sorted(current)}}
                )
                return
            for child in node.get("children", []):
                walk(child, current)

        walk(self.root, {})
        return result

    def checkpoint(self):
        """JSON-serializable resumable state."""
        return {
            "format": self.CHECKPOINT_FORMAT,
            "problem": self.problem.to_dict(),
            "problem_signature": self.problem.signature(),
            "checks_total": self.checks_total,
            "stats": dict(self.stats),
            "cache": self.cache,
            "tree": self.root,
        }

    @classmethod
    def from_checkpoint(cls, data, problem=None):
        """Restore from a checkpoint dict.

        If ``problem`` is given and differs from the checkpoint's problem
        (constraints added/revoked), the stale search tree is discarded and
        only cache entries whose keys still carry valid domain/constraint
        versions can be reused.
        """
        if data.get("format") != cls.CHECKPOINT_FORMAT:
            raise ValueError("not an exactcount checkpoint")
        stored_problem = Problem.from_dict(data["problem"])
        problem = problem if problem is not None else stored_problem
        solver = cls(problem)
        if problem.signature() == data.get("problem_signature"):
            solver.root = copy.deepcopy(data["tree"])
            solver._built_mod = problem._mod_counter
        solver.cache = copy.deepcopy(data.get("cache", {}))
        solver.checks_total = int(data.get("checks_total", 0))
        for key, value in data.get("stats", {}).items():
            solver.stats[key] = value
        return solver


def _strip_operational(node):
    result = {k: v for k, v in node.items() if k != "queue"}
    if "children" in result:
        result["children"] = [_strip_operational(c) for c in node["children"]]
    return result
