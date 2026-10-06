"""Query evaluation: equality filters, existence, conjunction, ordering."""
from __future__ import annotations

from . import pointers
from .strictjson import sort_key, value_key

__all__ = ["QueryError", "run_query"]


class QueryError(ValueError):
    """Raised for malformed queries or unknown index references."""


def _exists(node, segments):
    for seg in segments:
        if isinstance(node, dict):
            if seg not in node:
                return False
            node = node[seg]
        elif isinstance(node, list):
            if not seg.isdigit() or int(seg) >= len(node):
                return False
            node = node[int(seg)]
        else:
            return False
    return True


def run_query(docs, indexes, query):
    """Run ``query`` against ``docs``/``indexes`` of one store version.

    Query shape::

        {"where": [{"eq": ["<index>", <value>]},
                   {"exists": "<pointer>"}, ...],
         "order_by": "<index>"}

    All ``where`` conditions are conjoined. Returns a sorted list of
    document ids; with ``order_by`` the sort key is each document's
    smallest indexed value (documents without a value sort last).
    """
    if not isinstance(query, dict):
        raise QueryError("query must be an object")
    result = None
    for cond in query.get("where", []):
        if not isinstance(cond, dict):
            raise QueryError("condition must be an object")
        if "eq" in cond:
            eq = cond["eq"]
            if not isinstance(eq, (list, tuple)) or len(eq) != 2:
                raise QueryError("eq condition must be [index, value]")
            name, value = eq
            idx = indexes.get(name)
            if idx is None:
                raise QueryError("no such index: %r" % name)
            matched = {doc_id for doc_id, _ in idx.entries.get(value_key(value), ())}
        elif "exists" in cond:
            segments = pointers.parse(cond["exists"])
            matched = {
                doc_id
                for doc_id in (result if result is not None else docs)
                if _exists(docs[doc_id], segments)
            }
        else:
            raise QueryError("unknown condition: %r" % (cond,))
        result = matched if result is None else (result & matched)
    if result is None:
        result = set(docs)
    order = query.get("order_by")
    if order is not None:
        idx = indexes.get(order)
        if idx is None:
            raise QueryError("no such index: %r" % order)

        def keyfn(doc_id):
            pairs = idx.by_doc.get(doc_id, ())
            if not pairs:
                return (1, None)
            return (0, min(sort_key(vk) for _, vk in pairs))

        return sorted(result, key=lambda doc_id: (keyfn(doc_id), doc_id))
    return sorted(result)
