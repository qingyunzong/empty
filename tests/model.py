"""Independent reference model: recompute the view by join + sort.

Nothing here shares code with the mvview package; the engine is checked
against this brute-force recomputation after every batch.
"""

from fractions import Fraction

from mvview import num_from_json


def apply_to_model(ops, left, right):
    """Apply a batch of canonical JSON ops to plain dict tables."""
    for op in ops:
        kind = op["op"]
        if kind == "insert_tx" or kind == "replace_tx":
            left[op["txid"]] = (op.get("customer"),
                                num_from_json(op.get("value")))
        elif kind == "retract_tx":
            del left[op["txid"]]
        elif kind == "insert_cust":
            key = (op.get("customer"), op.get("group"))
            right[key] = right.get(key, 0) + op.get("count", 1)
        elif kind == "retract_cust":
            key = (op.get("customer"), op.get("group"))
            remain = right[key] - op.get("count", 1)
            if remain:
                right[key] = remain
            else:
                del right[key]
        elif kind == "migrate":
            cid = op.get("customer")
            gfrom = op.get("from")
            gto = op.get("to")
            count = op.get("count")
            if count is None:
                count = right.get((cid, gfrom), 0)
            remain = right.get((cid, gfrom), 0) - count
            if remain:
                right[(cid, gfrom)] = remain
            else:
                right.pop((cid, gfrom), None)
            right[(cid, gto)] = right.get((cid, gto), 0) + count
        else:
            raise AssertionError(f"unknown op {kind!r}")


def reference_values(left, right):
    """{group: sorted list of joined non-NULL values with multiplicity}."""
    groups = {}
    for cid, val in left.values():
        if cid is None or val is None:
            continue
        for (rcid, grp), mult in right.items():
            if rcid is not None and rcid == cid:
                groups.setdefault(grp, []).extend([val] * mult)
    for vals in groups.values():
        vals.sort()
    return groups


def reference_view(left, right):
    """{group: (count, sum_or_None, median_or_None)} via join + sort."""
    counts = {}
    values = {}
    for cid, val in left.values():
        if cid is None:
            continue
        for (rcid, grp), mult in right.items():
            if rcid is None or rcid != cid:
                continue
            counts[grp] = counts.get(grp, 0) + mult
            if val is not None:
                values.setdefault(grp, []).extend([val] * mult)
    out = {}
    for grp, count in counts.items():
        if count == 0:
            continue
        vals = sorted(values.get(grp, []))
        n = len(vals)
        total = sum(vals, Fraction(0)) if vals else None
        if n == 0:
            median = None
        elif n % 2 == 1:
            median = vals[n // 2]
        else:
            median = (vals[n // 2 - 1] + vals[n // 2]) / 2
        out[grp] = (count, total, median)
    return out


def engine_view_tuples(engine):
    return {grp: (s["count"], s["sum"], s["median"])
            for grp, s in engine.view().items()}
