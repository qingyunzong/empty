"""Exact model counter with strict budget, pausable anywhere.

Search tree node kinds
----------------------
- ``leaf``:    unexplored frontier node.  Its interval is
               ``[0, product of current domain sizes]``.  Carries its own
               propagation work queue so a pause inside propagation can
               be resumed exactly, without recounting.
- ``sum``:     deterministic branch on one variable; children restrict
               that variable to each value of its (propagated) domain, so
               the children partition the parent's assignment space into
               pairwise disjoint regions.
- ``product``: factorization over the connected components of the
               constraint graph; the node count is the product of the
               independent component counts.
- ``solved``:  exact count known.

The confirmed lower bound sums solved leaf contributions; the certified
upper bound adds, for every frontier leaf, the product of its current
domain sizes (a verifiable bound).  Frontier regions are disjoint by
construction, so bounds never double count, even when paused in the
middle of propagation.

Budget is measured in value-support checks (one unit per
value/tuple support test inside arc-consistency revision).  The state is
serializable after every single check.
"""

from __future__ import annotations

import json

from .cache import Cache
from .problem import Problem


class _Pause(Exception):
    """Raised internally when the budget is exhausted mid-check."""


class _Budget:
    def __init__(self, limit):
        self.limit = limit
        self.used = 0

    def consume(self):
        if self.limit is not None and self.used >= self.limit:
            raise _Pause()
        self.used += 1


def _components(vars_, cons):
    """Connected components of the constraint graph over ``vars_``."""
    adjacency = {v: set() for v in vars_}
    for c in cons:
        for a in c.scope:
            for b in c.scope:
                if a != b:
                    adjacency[a].add(b)
                    adjacency[b].add(a)
    seen = set()
    out = []
    for v in vars_:
        if v in seen:
            continue
        stack = [v]
        comp = []
        while stack:
            x = stack.pop()
            if x in seen:
                continue
            seen.add(x)
            comp.append(x)
            stack.extend(sorted(adjacency[x]))
        out.append(sorted(comp))
    return out


def _bounds(node):
    kind = node["kind"]
    if kind == "leaf":
        ub = 1
        for vals in node["domains"].values():
            ub *= len(vals)
        return (0, ub)
    if kind == "solved":
        return (node["count"], node["count"])
    if kind == "sum":
        lo = hi = 0
        for child in node["children"]:
            l, h = _bounds(child)
            lo += l
            hi += h
        return (lo, hi)
    lo = hi = 1
    for child in node["children"]:
        l, h = _bounds(child)
        lo *= l
        hi *= h
    return (lo, hi)


def _cert_node(node):
    out = {
        "kind": node["kind"],
        "vars": list(node["vars"]),
        "domains": {v: list(node["domains"][v]) for v in node["vars"]},
    }
    if "decision" in node:
        out["decision"] = list(node["decision"])
    kind = node["kind"]
    if kind == "leaf":
        ub = 1
        for v in node["vars"]:
            ub *= len(node["domains"][v])
        out["ub"] = ub
    elif kind == "solved":
        out["count"] = node["count"]
    elif kind == "sum":
        out["var"] = node["var"]
        out["children"] = [_cert_node(ch) for ch in node["children"]]
    elif kind == "product":
        out["children"] = [_cert_node(ch) for ch in node["children"]]
    return out


def _cert_node(node):
    out = {
        "kind": node["kind"],
        "vars": list(node["vars"]),
        "domains": {v: list(node["domains"][v]) for v in node["vars"]},
    }
    if "decision" in node:
        out["decision"] = list(node["decision"])
    kind = node["kind"]
    if kind == "leaf":
        ub = 1
        for v in node["vars"]:
            ub *= len(node["domains"][v])
        out["ub"] = ub
    elif kind == "solved":
        out["count"] = node["count"]
    elif kind == "sum":
        out["var"] = node["var"]
        out["children"] = [_cert_node(ch) for ch in node["children"]]
    elif kind == "product":
        out["children"] = [_cert_node(ch) for ch in node["children"]]
    return out


class Solver:
    CHECKPOINT_FORMAT = "schcount-checkpoint/1"
    CERTIFICATE_FORMAT = "schcount-certificate/1"

    def __init__(self, problem, cache=None):
        self.problem = problem
        self.cache = cache if cache is not None else Cache()
        self.version = problem.constraint_version
        self.spent = 0
        self.stats = {
            "expansions": 0,
            "component_splits": 0,
            "sum_branches": 0,
            "leaves_solved": 0,
            "support_checks": 0,
        }
        self.root = self._fresh_root()

    # ------------------------------------------------------------------
    # state construction
    # ------------------------------------------------------------------
    def _fresh_root(self):
        return {
            "kind": "leaf",
            "vars": sorted(self.problem.domains),
            "domains": {v: list(self.problem.domains[v]) for v in self.problem.domains},
            "queue": None,
        }

    def _subconstraints(self, vars_):
        varset = set(vars_)
        return sorted(
            (c for c in self.problem.constraints.values() if set(c.scope) <= varset),
            key=lambda c: c.cid,
        )

    # ------------------------------------------------------------------
    # propagation (resumable after every single support check)
    # ------------------------------------------------------------------
    # Queue items are ``[cid, var, remaining, kept, tuple_index]``:
    # ``remaining``/``kept`` are None until the revision starts, then hold
    # the values still to check and the values kept so far, while
    # ``tuple_index`` is the scan position inside the constraint table.
    # Every consumed budget unit advances ``tuple_index`` (or finishes a
    # value), so even a one-unit budget always makes progress and a pause
    # after any single check resumes exactly where it stopped.
    def _propagate(self, node, budget):
        cons = {c.cid: c for c in self._subconstraints(node["vars"])}
        if node["queue"] is None:
            node["queue"] = [
                [c.cid, v, None, None, 0]
                for c in self._subconstraints(node["vars"])
                for v in c.scope
            ]
        queue = node["queue"]
        doms = node["domains"]
        while queue:
            item = queue[0]
            cid, var = item[0], item[1]
            c = cons.get(cid)
            if c is None or var not in c.scope:
                queue.pop(0)
                continue
            original = doms[var]
            if item[2] is None:
                item[2] = list(original)
                item[3] = []
            remaining = item[2]
            kept = item[3]
            idx = c.scope.index(var)
            others = [j for j in range(len(c.scope)) if j != idx]
            tuples = c.tuples
            while remaining:
                val = remaining[0]
                supported = False
                ti = item[4]
                while ti < len(tuples):
                    budget.consume()
                    t = tuples[ti]
                    ti += 1
                    # Persist the scan position immediately: a pause on the
                    # next consume() must not lose this unit of progress.
                    item[4] = ti
                    if t[idx] == val and all(
                        t[j] in doms[c.scope[j]] for j in others
                    ):
                        supported = True
                        break
                item[4] = ti
                if supported:
                    kept.append(val)
                    remaining.pop(0)
                    item[4] = 0
                elif ti >= len(tuples):
                    remaining.pop(0)
                    item[4] = 0
            queue.pop(0)
            if len(kept) != len(original):
                doms[var] = kept
                if not kept:
                    queue.clear()
                    return
                for c2 in self._subconstraints(node["vars"]):
                    if c2.cid == cid or var not in c2.scope:
                        continue
                    for v2 in c2.scope:
                        if v2 == var:
                            continue
                        if any(it[0] == c2.cid and it[1] == v2 for it in queue):
                            continue
                        queue.append([c2.cid, v2, None, None, 0])

    # ------------------------------------------------------------------
    # search
    # ------------------------------------------------------------------
    def _expand_once(self, budget):
        node = self.root
        path = []
        while node["kind"] in ("sum", "product"):
            for child in node["children"]:
                if child["kind"] != "solved":
                    path.append(node)
                    node = child
                    break
            else:
                raise AssertionError("unsolved node with all children solved")
        if node["kind"] == "solved":
            return False
        self._expand_leaf(node, budget)
        self.stats["expansions"] += 1
        for ancestor in reversed(path):
            self._maybe_solve(ancestor)
        return True

    def _expand_leaf(self, node, budget):
        self._propagate(node, budget)
        vars_ = node["vars"]
        doms = node["domains"]
        cons = self._subconstraints(vars_)
        if any(not doms[v] for v in vars_):
            self._mark_solved(node, 0, cons)
            return
        if all(len(doms[v]) == 1 for v in vars_):
            self._mark_solved(node, 1, cons)
            return
        comps = _components(vars_, cons)
        if len(comps) > 1:
            self.stats["component_splits"] += 1
            children = [
                {
                    "kind": "leaf",
                    "vars": comp,
                    "domains": {v: list(doms[v]) for v in comp},
                    # Parent was fully propagated; each component inherits
                    # the arc-consistent domains, so no re-propagation.
                    "queue": [],
                }
                for comp in comps
            ]
            node.clear()
            node.update(
                {
                    "kind": "product",
                    "vars": vars_,
                    "domains": doms,
                    "children": children,
                }
            )
            return
        hit = self.cache.lookup(self.problem, vars_, doms, cons)
        if hit is not None:
            self._mark_solved(node, hit, cons)
            return
        var = min((len(doms[v]), v) for v in vars_ if len(doms[v]) > 1)[1]
        self.stats["sum_branches"] += 1
        children = []
        for val in doms[var]:
            child_domains = {v: list(doms[v]) for v in vars_}
            child_domains[var] = [val]
            children.append(
                {
                    "kind": "leaf",
                    "vars": list(vars_),
                    "domains": child_domains,
                    "queue": None,
                    "decision": [var, val],
                }
            )
        node.clear()
        node.update(
            {
                "kind": "sum",
                "vars": vars_,
                "domains": doms,
                "var": var,
                "children": children,
            }
        )

    def _mark_solved(self, node, count, cons):
        vars_ = node["vars"]
        doms = node["domains"]
        node.clear()
        node.update(
            {"kind": "solved", "vars": vars_, "domains": doms, "count": int(count)}
        )
        self.stats["leaves_solved"] += 1
        self.cache.insert(self.problem, vars_, doms, cons, count)

    def _maybe_solve(self, node):
        if node["kind"] not in ("sum", "product"):
            return
        children = node["children"]
        if any(ch["kind"] != "solved" for ch in children):
            return
        if node["kind"] == "sum":
            total = sum(ch["count"] for ch in children)
        else:
            total = 1
            for ch in children:
                total *= ch["count"]
        cons = self._subconstraints(node["vars"])
        self._mark_solved(node, total, cons)

    # ------------------------------------------------------------------
    # public API
    # ------------------------------------------------------------------
    def solve(self, budget=None):
        """Run until completion or until ``budget`` support checks are used."""
        if self.problem.constraint_version != self.version:
            # Constraints were added or revoked: previously derived tree
            # structure no longer has a proof basis.  Restart the tree;
            # cache entries are kept and revalidated individually.
            self.version = self.problem.constraint_version
            self.root = self._fresh_root()
        b = _Budget(budget)
        try:
            while self._expand_once(b):
                pass
        except _Pause:
            pass
        self.spent += b.used
        self.stats["support_checks"] = self.spent
        return self.result()

    def result(self):
        lo, hi = _bounds(self.root)
        return {
            "confirmed_lower": lo,
            "certified_upper": hi,
            "complete": lo == hi,
            "exact": lo if lo == hi else None,
            "support_checks": self.spent,
        }

    # ------------------------------------------------------------------
    # checkpointing
    # ------------------------------------------------------------------
    def to_checkpoint(self):
        return {
            "format": self.CHECKPOINT_FORMAT,
            "problem": self.problem.to_json(),
            "constraint_version": self.version,
            "spent": self.spent,
            "stats": dict(self.stats),
            "tree": self.root,
            "cache": self.cache.to_json(),
        }

    @classmethod
    def from_checkpoint(cls, data):
        if data.get("format") != cls.CHECKPOINT_FORMAT:
            raise ValueError("not a schcount checkpoint")
        problem = Problem.from_json(data["problem"])
        cache = Cache.from_json(data.get("cache", []))
        solver = cls(problem, cache)
        solver.version = int(data["constraint_version"])
        solver.spent = int(data["spent"])
        solver.stats.update(data.get("stats", {}))
        solver.root = data["tree"]
        return solver

    def save_checkpoint(self, path):
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(self.to_checkpoint(), fh, indent=2, sort_keys=True)

    @classmethod
    def load_checkpoint(cls, path):
        with open(path, "r", encoding="utf-8") as fh:
            return cls.from_checkpoint(json.load(fh))

    # ------------------------------------------------------------------
    # certificates
    # ------------------------------------------------------------------
    def certificate(self):
        lo, hi = _bounds(self.root)
        return {
            "format": self.CERTIFICATE_FORMAT,
            "problem": self.problem.to_json(),
            "problem_digest": self.problem.digest(),
            "constraint_version": self.problem.constraint_version,
            "lower": lo,
            "upper": hi,
            "complete": lo == hi,
            "tree": _cert_node(self.root),
        }
