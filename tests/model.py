"""Independent reference model: full join + sort recomputation."""

from fractions import Fraction


def model_groups(left, right):
    """left: {id: (cid, value)}, right: {(cid, grp): mult}
    -> {grp: sorted list of join values (None included, multiplicity kept)}"""
    groups = {}
    for (cid, grp), mult in right.items():
        if cid is None:
            continue
        for _tid, (lcid, val) in left.items():
            if lcid is None or lcid != cid:
                continue
            bucket = groups.setdefault(grp, [])
            for _ in range(mult):
                bucket.append(val)
    return groups


def model_view(left, right):
    """-> {grp: {"count", "sum", "median", "vals"}} recomputed from scratch."""
    out = {}
    for grp, vals in model_groups(left, right).items():
        nonnull = sorted(v for v in vals if v is not None)
        n = len(nonnull)
        if n == 0:
            median = None
        elif n % 2 == 1:
            median = nonnull[n // 2]
        else:
            median = (nonnull[n // 2 - 1] + nonnull[n // 2]) / 2
        out[grp] = {
            "count": len(vals),
            "sum": sum(nonnull, Fraction(0)) if nonnull else None,
            "median": median,
            "vals": nonnull,
        }
    return out


def as_frac(json_val):
    if json_val is None:
        return None
    return Fraction(json_val)


def check_engine_vs_model(testcase, engine):
    """Assert the engine's incremental view matches the from-scratch model."""
    expected = model_view(engine.left, engine.right)
    actual = engine.view()
    testcase.assertEqual(sorted(actual, key=str), sorted(expected, key=str))
    for grp, exp in expected.items():
        got = actual[grp]
        testcase.assertEqual(got["count"], exp["count"], f"group {grp} count")
        testcase.assertEqual(as_frac(got["sum"]), exp["sum"], f"group {grp} sum")
        testcase.assertEqual(as_frac(got["median"]), exp["median"], f"group {grp} median")
        # rank queries against the order-statistics structure
        probes = exp["vals"] + [Fraction(-1000), Fraction(0), Fraction(1000)]
        for v in probes:
            want = sum(1 for x in exp["vals"] if x < v)
            testcase.assertEqual(engine.rank(grp, v), want, f"group {grp} rank({v})")
