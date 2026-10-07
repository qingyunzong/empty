"""Brute-force enumeration of all legal matchings (independent checker).

Used by the test-suite to cross-check the optimiser for up to 7 files:
enumerates every legal source/destination pairing, computes each total
cost, and returns the minimum cost together with the lexicographically
smallest normalised operation sequence among all min-cost matchings.
"""
from __future__ import annotations

from .distance import content_distance, path_distance
from .matching import pair_op
from .model import byte_count


def brute_force_best(src_tree, dst_tree):
    """Return ``(cost, ops)``: optimum cost and canonical operation list."""
    src = sorted(src_tree.files.items())
    dst = sorted(dst_tree.files.items())
    n, m = len(src), len(dst)
    best = None

    def rec(i, used, cost, ops):
        nonlocal best
        if i == n:
            final_ops = list(ops)
            total = cost
            for j in range(m):
                if j not in used:
                    final_ops.append(("add", dst[j][0]))
                    total += byte_count(dst[j][1])
            final_ops.sort()
            key = (total, final_ops)
            if best is None or key < best:
                best = key
            return
        sp, sl = src[i]
        rec(i + 1, used, cost + byte_count(sl), ops + [("delete", sp)])
        for j in range(m):
            if j in used:
                continue
            dp, dl = dst[j]
            c = path_distance(sp, dp) + content_distance(sl, dl)
            op = pair_op(sp, sl, dp, dl)
            rec(i + 1, used | {j}, cost + c,
                ops + ([op] if op is not None else []))

    rec(0, frozenset(), 0, [])
    return best
