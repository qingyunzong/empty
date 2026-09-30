"""Exact top-K branch-and-bound search with budgets and certificates.

The search is best-first over the node hierarchy using each node's exact
bounding-box lower bound.  A subtree is distance-pruned only when its
lower bound is *strictly greater* than the current K-th best distance, so
boundary ties (equal distance, smaller id) are never lost.

Every query returns a :class:`QueryResult` whose status is either
``"exact"`` (the returned list is proven to be the true top-K) or
``"partial"`` (the node-visit budget ran out; the result is the best
candidates found so far and must not be treated as exact KNN).  The
certificate lists every unvisited subtree together with its exact
distance lower bound, so an independent verifier can check both the
pruning bounds and the coverage of the search.
"""

from __future__ import annotations

import bisect
import heapq

from .errors import DimensionError, StaleCursorError
from .exact import bbox_mindist, dist2, frac_str, idkey, parse_vector
from .filters import match_tags, may_match, validate_filter


class QueryResult:
    """Outcome of one KNN query."""

    def __init__(self, status, k, items, cert_entries, stats):
        if status not in ("exact", "partial"):
            raise ValueError(f"bad status: {status!r}")
        self.status = status
        self.k = k
        self.items = items  # list of (id, Fraction distance), sorted
        self.cert_entries = cert_entries  # list of {node_id, bbox, bound}
        self.stats = stats

    @property
    def complete(self):
        """True only when the top-K answer is proven complete."""
        return self.status == "exact"

    def to_dict(self):
        return {
            "status": self.status,
            "complete": self.complete,
            "k": self.k,
            "results": [
                {"id": pid, "distance": frac_str(d)} for pid, d in self.items
            ],
            "certificate": {
                "entries": [
                    {
                        "node_id": e["node_id"],
                        "bbox": [
                            [frac_str(lo), frac_str(hi)] for lo, hi in e["bbox"]
                        ],
                        "bound": frac_str(e["bound"]),
                    }
                    for e in self.cert_entries
                ]
            },
            "stats": dict(self.stats),
        }


def _cert_entry(node, bound):
    return {"node_id": node.node_id, "bbox": node.bbox, "bound": bound}


def run_query(index, vector, k, filter=None, budget=None):
    """Run an exact top-K query.

    ``budget`` bounds the number of tree nodes visited; ``None`` means
    unlimited.  When the budget is exhausted the result is ``"partial"``
    and its certificate covers every subtree that was not visited.
    """
    q = parse_vector(vector)
    if len(q) != index.dim:
        raise DimensionError(
            f"expected query dimension {index.dim}, got {len(q)}"
        )
    if not isinstance(k, int) or isinstance(k, bool) or k < 0:
        raise ValueError("k must be a non-negative integer")
    validate_filter(filter)
    if budget is not None and (
        not isinstance(budget, int) or isinstance(budget, bool) or budget < 0
    ):
        raise ValueError("budget must be a non-negative integer or None")

    best = []  # sorted list of (dist, idkey, id), worst last
    certs = []
    visited = 0
    evals = 0
    filter_pruned = 0
    distance_pruned = 0
    heap = []  # (mindist, node_id, node), min-heap

    def consider(node):
        nonlocal filter_pruned
        if node.bbox is None:
            return
        if filter is not None and not may_match(
            filter, node.tags_any, node.tags_all
        ):
            filter_pruned += 1
            return
        heapq.heappush(heap, (bbox_mindist(node.bbox, q), node.node_id, node))

    if k > 0:
        consider(index.root)

    status = "exact"
    while heap:
        if budget is not None and visited >= budget:
            status = "partial"
            break
        bound, _, node = heapq.heappop(heap)
        visited += 1
        if len(best) == k and bound > best[-1][0]:
            # Strict inequality: ties on distance must still be explored
            # because a tied point may win on the id tie-break.
            distance_pruned += 1
            certs.append(_cert_entry(node, bound))
            while heap:
                other_bound, _, other = heapq.heappop(heap)
                certs.append(_cert_entry(other, other_bound))
                distance_pruned += 1
            break
        if node.leaf:
            for point in node.entries:
                if filter is not None and not match_tags(filter, point.tags):
                    continue
                d = dist2(point.vector, q)
                evals += 1
                item = (d, idkey(point.id), point.id)
                if len(best) < k or item[:2] < best[-1][:2]:
                    bisect.insort(best, item)
                    if len(best) > k:
                        best.pop()
        else:
            for child in node.children:
                consider(child)

    if status == "partial":
        for bound, _, node in heap:
            certs.append(_cert_entry(node, bound))

    items = [(pid, d) for (d, _, pid) in best]
    stats = {
        "visited_nodes": visited,
        "point_evals": evals,
        "filter_pruned": filter_pruned,
        "distance_pruned": distance_pruned,
    }
    return QueryResult(status, k, items, certs, stats)


class Cursor:
    """A query cursor bound to the index data version at creation time.

    Running the cursor after any mutation of the index raises
    :class:`StaleCursorError`; cursors on snapshots stay valid because a
    snapshot's data version never moves.
    """

    def __init__(self, index, vector, k, filter=None, budget=None):
        self._index = index
        self._version = index.data_version
        self._vector = parse_vector(vector)
        self._k = k
        self._filter = filter
        self._budget = budget

    @property
    def data_version(self):
        return self._version

    def run(self):
        if self._index.data_version != self._version:
            raise StaleCursorError(
                f"cursor bound to data version {self._version}, "
                f"index is at {self._index.data_version}"
            )
        return run_query(
            self._index, self._vector, self._k, self._filter, self._budget
        )
