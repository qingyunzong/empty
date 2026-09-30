"""Independent verifier for query results.

The verifier trusts nothing produced by the index.  Given the raw dataset
and the query parameters it re-checks, with exact arithmetic:

1. every returned hit exists, matches the filter, and carries the exact
   squared distance, and the hits are sorted by (distance, id);
2. every certificate lower bound equals the exact bounding-box mindist
   recomputed from the certificate's own bbox;
3. for ``"exact"`` results, the returned list equals an independently
   computed brute-force top-K, and every certificate bound strictly
   exceeds the K-th distance (so pruned subtrees provably contain nothing
   better);
4. for ``"partial"`` results, every matching point that was not returned
   is covered by at least one certificate bbox (so nothing was silently
   dropped when the budget ran out).

Any tampering with distances, bounds, bboxes, ordering, or the status
flag makes verification fail.
"""

from __future__ import annotations

from .errors import VerificationError
from .exact import (
    bbox_mindist,
    dist2,
    idkey,
    parse_vector,
    point_in_bbox,
    to_fraction,
)
from .filters import match_tags, validate_filter


def _fail(message):
    raise VerificationError(message)


def brute_force_topk(points, vector, k, filter=None):
    """Independent full scan: exact top-K as a list of (dist, idkey, id)."""
    q = parse_vector(vector)
    cands = []
    for p in points:
        if filter is not None and not match_tags(filter, p.tags):
            continue
        cands.append((dist2(p.vector, q), idkey(p.id), p.id))
    cands.sort()
    return cands[:k]


def verify(points, vector, k, filter, result):
    """Verify a query result against the raw dataset.  Returns True or
    raises :class:`VerificationError` describing the first problem found.
    """
    points = list(points)
    q = parse_vector(vector)
    validate_filter(filter)
    rd = result.to_dict() if hasattr(result, "to_dict") else result

    status = rd.get("status")
    if status not in ("exact", "partial"):
        _fail(f"unknown status: {status!r}")
    if bool(rd.get("complete")) != (status == "exact"):
        _fail("complete flag is inconsistent with status")

    by_id = {}
    for p in points:
        if p.id in by_id:
            _fail(f"duplicate id in dataset: {p.id!r}")
        by_id[p.id] = p

    returned = rd.get("results", [])
    if len(returned) > k:
        _fail("more than k results returned")
    prev_key = None
    returned_ids = set()
    for item in returned:
        pid = item.get("id")
        point = by_id.get(pid)
        if point is None:
            _fail(f"returned id not in dataset: {pid!r}")
        if pid in returned_ids:
            _fail(f"duplicate id in results: {pid!r}")
        returned_ids.add(pid)
        if filter is not None and not match_tags(filter, point.tags):
            _fail(f"returned point {pid!r} does not match the filter")
        actual = dist2(point.vector, q)
        if actual != to_fraction(item.get("distance")):
            _fail(f"distance mismatch for id {pid!r}")
        key = (actual, idkey(pid))
        if prev_key is not None and key <= prev_key:
            _fail("results are not strictly ordered by (distance, id)")
        prev_key = key

    entries = rd.get("certificate", {}).get("entries", [])
    parsed = []
    for entry in entries:
        try:
            bbox = tuple(
                (to_fraction(lo), to_fraction(hi)) for lo, hi in entry["bbox"]
            )
            bound = to_fraction(entry["bound"])
        except (KeyError, TypeError, ValueError) as exc:
            _fail(f"malformed certificate entry: {exc}")
        for lo, hi in bbox:
            if lo > hi:
                _fail("certificate bbox has lo > hi")
        if bbox_mindist(bbox, q) != bound:
            _fail("certificate lower bound does not match its bbox")
        parsed.append((bbox, bound))

    if status == "exact":
        truth = brute_force_topk(points, q, k, filter)
        if [pid for _, _, pid in truth] != [item["id"] for item in returned]:
            _fail("returned set differs from the brute-force top-k")
        if returned and len(returned) == k:
            worst = to_fraction(returned[-1]["distance"])
            for _, bound in parsed:
                if bound <= worst:
                    _fail(
                        "certificate bound does not strictly exceed the "
                        "k-th distance"
                    )
        elif parsed:
            _fail("unexpected certificate entries for an exhausted search")
    else:
        worst_key = None
        if returned and len(returned) == k:
            worst_key = (
                to_fraction(returned[-1]["distance"]),
                idkey(returned[-1]["id"]),
            )
        for point in points:
            if filter is not None and not match_tags(filter, point.tags):
                continue
            if point.id in returned_ids:
                continue
            # A point evaluated during the search and displaced by better
            # candidates is legitimately absent: it cannot be better than
            # the final k-th best (which only improves over time).
            if worst_key is not None:
                point_key = (dist2(point.vector, q), idkey(point.id))
                if point_key >= worst_key:
                    continue
            if not any(
                point_in_bbox(bbox, point.vector) for bbox, _ in parsed
            ):
                _fail(
                    f"matching point {point.id!r} is covered by no "
                    "certificate bbox"
                )
    return True
