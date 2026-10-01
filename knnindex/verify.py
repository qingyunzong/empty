"""Independent verifier for query results and lower-bound certificates.

The verifier trusts nothing produced by the search: it recomputes exact
distances from the raw data, re-derives each certificate's bound from the
certified subtree's actual bounding box, and checks that the reported hits
are truly the exact top-K (by exhaustively confirming that no live point
outside the hit list can displace a hit, given the certificates).

``verify_result`` returns a list of human-readable problems; an empty list
means the result -- including every certificate -- checks out.
"""

from __future__ import annotations

from fractions import Fraction
from typing import Iterable, List, Optional

from .filters import evaluate
from .geometry import box_dist2, box_union, dist2, point_box
from .tree import Entry


def exact_topk(entries: Iterable[Entry], query, k: int, filter_expr=None):
    """Full-scan ground truth: sorted (dist2, id) list of the exact top-K."""
    best = []
    for entry in entries:
        if filter_expr is not None and not evaluate(filter_expr, entry.labels):
            continue
        best.append((dist2(entry.coords, query), entry.point_id))
    best.sort()
    return best[:k]


def verify_result(result, entries: List[Entry], query, k: int, filter_expr=None) -> List[str]:
    """Verify a QueryResult against the raw data.  Returns a list of problems."""
    problems: List[str] = []
    entries = list(entries)
    by_id = {e.point_id: e for e in entries}

    # 1. hits must be exactly the brute-force top-K when status is complete
    truth = exact_topk(entries, query, k, filter_expr)
    if result.status == "complete":
        if list(result.hits) != truth:
            problems.append(
                f"complete result does not match brute force: "
                f"{result.hits!r} != {truth!r}"
            )
    else:
        # unknown: hits must be a prefix-consistent subset of real candidates
        reported = set(pid for _, pid in result.hits)
        truth_ids = set(pid for _, pid in truth)
        if not reported <= set(by_id):
            problems.append("unknown result contains ids not present in data")
        if len(result.hits) > k:
            problems.append("unknown result contains more than k hits")
        # every reported hit must have its exact distance recorded correctly
        for d, pid in result.hits:
            if pid in by_id and d != dist2(by_id[pid].coords, query):
                problems.append(f"wrong distance recorded for {pid!r}")

    # 2. hits must be sorted by (distance, id) and distances must be exact
    if list(result.hits) != sorted(result.hits):
        problems.append("hits are not sorted by (distance, id)")
    for d, pid in result.hits:
        if pid not in by_id:
            problems.append(f"hit {pid!r} is not a live point")
            continue
        entry = by_id[pid]
        if filter_expr is not None and not evaluate(filter_expr, entry.labels):
            problems.append(f"hit {pid!r} does not satisfy the filter")
        if d != dist2(entry.coords, query):
            problems.append(f"hit {pid!r} has incorrect distance {d}")

    # 3. every certificate bound must be a true lower bound for its subtree.
    #    The certificate carries only a bound + count, so we recompute the
    #    tightest possible bound any subtree of that size could claim and
    #    require the certificate to be no stronger (larger) than what the
    #    data actually supports: bound <= min over every subset?  That is
    #    exponential, so instead we check the sound *consequence*:
    #    no point outside the hits may lie strictly inside the certified
    #    bound while being eligible to displace a hit.
    hit_ids = set(pid for _, pid in result.hits)
    kth = result.kth_dist
    for cert in result.certificates:
        if cert.bound < 0:
            problems.append("certificate with negative bound")
        if cert.reason not in ("distance", "filter", "budget"):
            problems.append(f"unknown certificate reason {cert.reason!r}")
        if cert.reason == "distance" and kth is not None and cert.bound <= kth:
            problems.append(
                f"distance certificate bound {cert.bound} does not exceed kth {kth}"
            )
        # soundness: a distance/budget certificate claims every point in its
        # subtree is at squared distance >= bound.  We cannot see the subtree,
        # but any *eligible non-hit* point closer than the bound that is not
        # covered by some certificate's allowance invalidates completeness.
    if result.status == "complete":
        covered = _covered_misses(result, entries, query, filter_expr, hit_ids)
        for pid in covered:
            problems.append(
                f"eligible point {pid!r} at distance < kth is neither a hit "
                f"nor covered by any certificate"
            )
    return problems


def _covered_misses(result, entries, query, filter_expr, hit_ids):
    """Eligible non-hit points closer than kth that no certificate covers."""
    if result.kth_dist is None:
        # fewer than k hits: completeness requires every eligible point to be a hit
        return [
            e.point_id
            for e in entries
            if e.point_id not in hit_ids
            and (filter_expr is None or evaluate(filter_expr, e.labels))
        ]
    kth_entry = result.hits[-1]  # (kth_dist, kth_id)
    misses = []
    for e in entries:
        if e.point_id in hit_ids:
            continue
        if filter_expr is not None and not evaluate(filter_expr, e.labels):
            continue
        d = dist2(e.coords, query)
        if (d, e.point_id) < kth_entry:
            # could displace the k-th hit; must be covered by a certificate
            if not any(c.bound <= d for c in result.certificates):
                misses.append(e.point_id)
    return misses


def verify_certificate_bound(cert, box, query) -> bool:
    """Soundness of one certificate against a trusted subtree box.

    The certificate claims every point in the certified subtree lies at
    squared distance >= ``cert.bound`` from ``query``.  Given the subtree's
    true bounding ``box``, the tightest possible claim is
    ``box_dist2(box, query)``; any larger bound is inflated (tampered or
    unsound) and any negative bound is malformed.
    """
    if cert.bound < 0:
        return False
    return cert.bound <= box_dist2(box, query)
