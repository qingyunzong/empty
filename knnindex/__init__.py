"""Exact rational branch-and-bound KNN index.

Public API: :class:`KNNIndex`, :class:`Cursor`, :class:`QueryResult`,
:class:`Certificate`, :class:`StaleCursorError`, and :func:`brute_force`
(an independent full-scan reference used for cross-checking).
"""

from .filters import evaluate, evaluate_summary
from .geometry import box_dist2, dist2, to_point
from .index import FORMAT_VERSION, Cursor, KNNIndex
from .query import Certificate, QueryResult, StaleCursorError
from .tree import Entry

__all__ = [
    "KNNIndex",
    "Cursor",
    "QueryResult",
    "Certificate",
    "StaleCursorError",
    "Entry",
    "evaluate",
    "evaluate_summary",
    "to_point",
    "dist2",
    "box_dist2",
    "brute_force",
    "FORMAT_VERSION",
]


def brute_force(entries, query, k, filter_expr=None):
    """Independent full-scan exact top-K over an iterable of Entries."""
    best = []
    for entry in entries:
        if filter_expr is not None and not evaluate(filter_expr, entry.labels):
            continue
        best.append((dist2(entry.coords, query), entry.point_id))
    best.sort()
    return best[:k]
