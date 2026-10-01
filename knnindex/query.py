"""Exact top-K branch-and-bound search with budgets, certificates and cursors.

The search is a best-first traversal over a priority queue keyed by exact
rational lower bounds.  A candidate enters the result set only after its
*exact* squared distance has been computed.  The search is ``complete`` only
when every remaining queue item has a lower bound strictly greater than the
current K-th worst exact distance (ties are still expanded, so equal-distance
competitors are never dropped).  When a node budget runs out first, the
result is honestly reported as ``"unknown"`` together with the certificates
(lower bounds) of every unvisited subtree, plus a cursor that can resume the
identical search later -- but only against the same data version.
"""

from __future__ import annotations

import heapq
import itertools
from dataclasses import dataclass, field
from fractions import Fraction
from typing import List, Optional, Tuple

from .filters import evaluate, evaluate_summary
from .geometry import box_dist2, dist2
from .tree import Entry, Internal, Leaf, Node

Path = Tuple[int, ...]  # 0 = left, 1 = right, from the root


class StaleCursorError(Exception):
    """Raised when a cursor cannot be resolved against the given tree."""


@dataclass(frozen=True)
class Certificate:
    """Lower-bound certificate for one unvisited (pruned or deferred) subtree."""

    bound: Fraction          # exact lower bound on squared distance inside
    reason: str              # "distance" | "filter" | "budget"
    node_count: int          # points in the certified subtree
    path: Path = ()

    def to_json(self):
        return {
            "bound": str(self.bound),
            "reason": self.reason,
            "node_count": self.node_count,
            "path": list(self.path),
        }


@dataclass
class QueryResult:
    hits: List[Tuple[Fraction, str]] = field(default_factory=list)  # (dist2, id), sorted
    status: str = "complete"           # "complete" | "unknown"
    kth_dist: Optional[Fraction] = None
    certificates: List[Certificate] = field(default_factory=list)
    resume_items: List[Tuple[Fraction, Path]] = field(default_factory=list)
    resume_hits: List[Tuple[Fraction, str]] = field(default_factory=list)
    nodes_visited: int = 0
    leaves_visited: int = 0
    budget: Optional[int] = None
    version: int = 0
    resumed: bool = False

    def to_json(self):
        return {
            "status": self.status,
            "version": self.version,
            "hits": [{"id": pid, "dist2": str(d)} for d, pid in self.hits],
            "kth_dist": None if self.kth_dist is None else str(self.kth_dist),
            "certificates": [c.to_json() for c in self.certificates],
            "resume": {
                "frontier": [
                    {"bound": str(b), "path": list(p)} for b, p in self.resume_items
                ],
                "hits": [{"id": pid, "dist2": str(d)} for d, pid in self.resume_hits],
            },
            "stats": {
                "nodes_visited": self.nodes_visited,
                "leaves_visited": self.leaves_visited,
                "budget": self.budget,
            },
            "resumed": self.resumed,
        }


def resolve_path(root: Node, path: Path) -> Node:
    node = root
    for step in path:
        if not isinstance(node, Internal):
            raise StaleCursorError(f"cursor path {path} does not resolve in this tree")
        node = node.left if step == 0 else node.right
        if node is None:
            raise StaleCursorError(f"cursor path {path} does not resolve in this tree")
    return node


def search(
    root: Optional[Node],
    query,
    k: int,
    filter_expr=None,
    budget: Optional[int] = None,
    version: int = 0,
    resume: Optional[Tuple[List[Tuple[Fraction, Path]], List[Tuple[Fraction, str]]]] = None,
) -> QueryResult:
    """Exact top-K by squared Euclidean distance.

    ``budget`` caps the number of tree nodes visited; ``None`` means
    unlimited.  Results are ordered by (distance, id).  ``status`` is
    ``"complete"`` only when exactness is proven; ``"unknown"`` means the
    budget was exhausted and the hits are the best candidates found so far.
    ``resume`` replays the frontier of a previously interrupted search.
    """
    result = QueryResult(budget=budget, version=version, resumed=resume is not None)
    if k <= 0 or root is None:
        result.status = "complete"
        return result

    counter = itertools.count()
    heap: List[Tuple[Fraction, int, Path, Node]] = []
    best: List[Tuple[Fraction, str]] = []  # sorted ascending, worst last
    if resume is None:
        heapq.heappush(heap, (box_dist2(root.box, query), next(counter), (), root))
    else:
        frontier, prior_hits = resume
        for bound, path in frontier:
            node = resolve_path(root, path)
            heapq.heappush(heap, (bound, next(counter), path, node))
        for d, pid in prior_hits:
            _insert_best(best, k, d, pid)
    certificates: List[Certificate] = []
    exhausted = False

    def kth_bound() -> Optional[Fraction]:
        return best[-1][0] if len(best) >= k else None

    while heap:
        bound, _, path, node = heapq.heappop(heap)
        limit = kth_bound()
        if limit is not None and bound > limit:
            # nothing in this subtree (or any later one) can improve top-K
            certificates.append(Certificate(bound, "distance", node.count, path))
            continue
        if budget is not None and result.nodes_visited >= budget:
            heapq.heappush(heap, (bound, next(counter), path, node))
            exhausted = True
            break
        result.nodes_visited += 1
        if filter_expr is not None:
            verdict = evaluate_summary(filter_expr, node.present, node.absent)
            if verdict is False:
                certificates.append(Certificate(bound, "filter", node.count, path))
                continue
        if isinstance(node, Leaf):
            result.leaves_visited += 1
            for entry in node.entries:
                if filter_expr is not None and not evaluate(filter_expr, entry.labels):
                    continue
                d = dist2(entry.coords, query)
                _insert_best(best, k, d, entry.point_id)
        else:  # Internal
            for step, child in ((0, node.left), (1, node.right)):
                if child is None:
                    continue
                heapq.heappush(
                    heap, (box_dist2(child.box, query), next(counter), path + (step,), child)
                )

    if exhausted:
        result.status = "unknown"
        for bound, _, path, node in heap:
            certificates.append(Certificate(bound, "budget", node.count, path))
            result.resume_items.append((bound, path))
        result.resume_items.sort(key=lambda item: (item[0], item[1]))
        result.resume_hits = list(best)
    else:
        result.status = "complete"

    result.hits = list(best)
    result.kth_dist = best[-1][0] if len(best) >= k else None
    result.certificates = certificates
    return result


def _insert_best(best: List[Tuple[Fraction, str]], k: int, d: Fraction, pid: str):
    entry = (d, pid)
    lo, hi = 0, len(best)
    while lo < hi:
        mid = (lo + hi) // 2
        if best[mid] < entry:
            lo = mid + 1
        else:
            hi = mid
    best.insert(lo, entry)
    if len(best) > k:
        best.pop()
