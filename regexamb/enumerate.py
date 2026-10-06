"""Bounded parse-tree enumeration with a work budget and checkpoints.

For every AST node and every length ``n`` we compute the map
``word -> [parse trees]`` (at most ``cap`` trees per word; two suffice to
prove ambiguity).  Levels are computed by increasing ``n`` so the first
ambiguous word found is the shortest.  The star level is a least
fixpoint, which keeps zero-length (epsilon) repetitions finite: a
nullable starred child only ever contributes up to ``cap`` trees.

Exhausting the budget raises :class:`BudgetExhausted`; the caller can
serialise :meth:`Enumerator.checkpoint` and resume later.
"""
from __future__ import annotations

from .syntax import LIT, EPS, ALT, CAT, STAR, fingerprint
from .parsetree import Tree, shift, tree_to_json, tree_from_json


class BudgetExhausted(Exception):
    """Raised when the work budget is exhausted mid-search."""


def _postorder(root):
    order = []

    def visit(node):
        for child in node.children:
            visit(child)
        order.append(node)

    visit(root)
    return order


class Enumerator:
    def __init__(self, root, cap: int = 2, budget: int = 200000, state: dict | None = None):
        self.root = root
        self.cap = cap
        self.budget = budget
        self.work = 0
        self.nodes = _postorder(root)
        self.levels = {node.id: [] for node in self.nodes}
        self.n_done = -1
        if state is not None:
            self._load(state)

    def _tick(self):
        self.work += 1
        if self.work > self.budget:
            raise BudgetExhausted()

    def compute_level(self, n: int):
        if n != self.n_done + 1:
            raise ValueError("levels must be computed in increasing order")
        cur = {}
        for node in self.nodes:
            cur[node.id] = self._level(node, n, cur)
        for node in self.nodes:
            self.levels[node.id].append(cur[node.id])
        self.n_done = n
        return self.levels

    def _level(self, node, n, cur):
        def child_level(child_id, k):
            return cur[child_id] if k == n else self.levels[child_id][k]

        kind = node.kind
        if kind == LIT:
            return {node.char: [Tree(node.id, 0, 1)]} if n == 1 else {}
        if kind == EPS:
            return {"": [Tree(node.id, 0, 0)]} if n == 0 else {}
        if kind == ALT:
            out = {}
            for child in node.children:
                for word, trees in child_level(child.id, n).items():
                    self._tick()
                    lst = out.setdefault(word, [])
                    for t in trees:
                        if len(lst) >= self.cap:
                            break
                        cand = Tree(node.id, 0, n, (t,))
                        if cand not in lst:
                            lst.append(cand)
            return out
        if kind == CAT:
            out = {}
            left, right = node.children
            for k in range(n + 1):
                for w1, ts1 in child_level(left.id, k).items():
                    for w2, ts2 in child_level(right.id, n - k).items():
                        self._tick()
                        lst = out.setdefault(w1 + w2, [])
                        for t1 in ts1:
                            for t2 in ts2:
                                self._tick()
                                if len(lst) >= self.cap:
                                    break
                                cand = Tree(node.id, 0, n, (t1, shift(t2, k)))
                                if cand not in lst:
                                    lst.append(cand)
            return out
        # STAR
        child = node.children[0]
        out = {}
        if n == 0:
            out[""] = [Tree(node.id, 0, 0, ())]
        # First repetition consumes k >= 1 characters; the remaining
        # repetitions are a star parse of a strictly shorter word.
        for k in range(1, n + 1):
            self._merge_star(out, child_level(child.id, k), self.levels[node.id][n - k], k, node, n)
        # First repetition consumes nothing: least fixpoint over this level.
        child_eps = child_level(child.id, 0)
        if child_eps:
            while True:
                before = sum(len(ts) for ts in out.values())
                snapshot = {w: list(ts) for w, ts in out.items()}
                self._merge_star(out, child_eps, snapshot, 0, node, n)
                after = sum(len(ts) for ts in out.values())
                if after == before:
                    break
        return out

    def _merge_star(self, out, child_map, star_map, k, node, n):
        for w1, ts1 in child_map.items():
            for w2, ts2 in star_map.items():
                self._tick()
                lst = out.setdefault(w1 + w2, [])
                for t1 in ts1:
                    for t2 in ts2:
                        self._tick()
                        if len(lst) >= self.cap:
                            break
                        rest = tuple(shift(c, k) for c in t2.children)
                        cand = Tree(node.id, 0, n, (t1,) + rest)
                        if cand not in lst:
                            lst.append(cand)

    def checkpoint(self) -> dict:
        return {
            "fingerprint": fingerprint(self.root),
            "cap": self.cap,
            "next_length": self.n_done + 1,
            "levels": {
                str(nid): [
                    [[w, [tree_to_json(t) for t in ts]] for w, ts in per_level.items()]
                    for per_level in self.levels[nid]
                ]
                for nid in self.levels
            },
        }

    def _load(self, state: dict):
        if state.get("fingerprint") != fingerprint(self.root):
            raise ValueError("checkpoint does not match this expression")
        self.cap = int(state.get("cap", self.cap))
        levels = {}
        for nid_s, per_levels in state["levels"].items():
            levels[int(nid_s)] = [
                {w: [tree_from_json(t) for t in ts] for w, ts in per_level}
                for per_level in per_levels
            ]
        self.levels = levels
        self.n_done = int(state["next_length"]) - 1
