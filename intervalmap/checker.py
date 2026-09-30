"""Independent checker for canonical output and threshold queries.

The checker never reuses query code paths: it re-derives coverage from
the raw canonical segment list, walks every endpoint-delimited atomic
interval, and validates coverage, source proofs and total lengths.
"""
from __future__ import annotations

import math
from fractions import Fraction

from .endpoints import cmp as epcmp, eq as epeq, fmt, seg_length


def _coverage(src, count_mode):
    return sum(c for _, c in src.items()) if count_mode else len(src)


def check_canonical(imap) -> list[str]:
    """Validate canonical-form invariants of a map.  Returns error list."""
    errors = []
    segs = imap.segments()
    prev = None
    total = Fraction(0)
    for lo, hi, src in segs:
        if epcmp(lo, hi) >= 0:
            errors.append(f"non-positive segment [{fmt(lo)}, {fmt(hi)})")
        if not src or any(c < 1 for c in src.values()):
            errors.append(f"empty/invalid sources on [{fmt(lo)}, {fmt(hi)})")
        if prev is not None:
            plo, phi, psrc = prev
            if epcmp(phi, lo) > 0:
                errors.append(f"overlapping segments at {fmt(lo)}")
            if epeq(phi, lo) and psrc == src:
                errors.append(f"adjacent segments not merged at {fmt(lo)}")
        total = total + seg_length(lo, hi)
        prev = (lo, hi, src)
    if total != imap.total_length:
        errors.append(
            f"cached total length {imap.total_length} != recomputed {total}")
    # reference counts must match the segment contents exactly
    refs = {}
    for _, _, src in segs:
        for s, c in src.items():
            refs[s] = refs.get(s, 0) + c
    if refs != imap.refcounts:
        errors.append(f"refcounts {imap.refcounts} != recomputed {refs}")
    return errors


def verify_threshold(imap, k, result, count_mode=False) -> list[str]:
    """Independently verify a covered_by_at_least query result.

    Recomputes, per endpoint-delimited atomic interval, whether coverage
    meets the threshold, checks each returned interval's source proof
    against the actual sources, and cross-checks the total length.
    Returns a list of error strings (empty means verified).
    """
    errors = []
    expected = []
    for lo, hi, src in imap.segments():
        if _coverage(src, count_mode) >= k:
            proof = dict(src)
            if expected and expected[-1][2] == proof and epeq(expected[-1][1], lo):
                expected[-1] = (expected[-1][0], hi, proof)
            else:
                expected.append((lo, hi, proof))

    got = [(lo, hi, dict(proof)) for lo, hi, proof in result]
    if len(got) != len(expected):
        errors.append(f"interval count {len(got)} != expected {len(expected)}")
    for i, (g, e) in enumerate(zip(got, expected)):
        if not (epeq(g[0], e[0]) and epeq(g[1], e[1])):
            errors.append(f"interval {i}: [{fmt(g[0])}, {fmt(g[1])}) != "
                          f"[{fmt(e[0])}, {fmt(e[1])})")
        elif g[2] != e[2]:
            errors.append(f"interval {i}: proof {g[2]} != actual sources {e[2]}")

    total_got = Fraction(0)
    for lo, hi, _ in got:
        total_got = total_got + seg_length(lo, hi)
    total_exp = Fraction(0)
    for lo, hi, _ in expected:
        total_exp = total_exp + seg_length(lo, hi)
    if total_got != total_exp:
        errors.append(f"total length {total_got} != expected {total_exp}")

    # per-atom containment: every qualifying atom must be covered by
    # exactly one returned interval whose proof equals the atom's sources
    for lo, hi, src in imap.segments():
        if _coverage(src, count_mode) < k:
            continue
        hits = [g for g in got
                if epcmp(g[0], lo) <= 0 and epcmp(hi, g[1]) <= 0]
        if len(hits) != 1:
            errors.append(f"atom [{fmt(lo)}, {fmt(hi)}) covered by "
                          f"{len(hits)} result intervals")
        elif hits[0][2] != dict(src):
            errors.append(f"atom [{fmt(lo)}, {fmt(hi)}) proof mismatch")
    return errors
