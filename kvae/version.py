"""Version-vector comparison."""

EQ = "equal"
LT = "lt"          # a is strictly older than b (b dominates)
GT = "gt"          # a is strictly newer than b (a dominates)
CONCURRENT = "concurrent"


def compare(vv_a, vv_b):
    """Compare two version vectors {replica_id: counter}."""
    a_newer = False
    b_newer = False
    for rep in set(vv_a) | set(vv_b):
        ca = vv_a.get(rep, 0)
        cb = vv_b.get(rep, 0)
        if ca > cb:
            a_newer = True
        elif cb > ca:
            b_newer = True
    if a_newer and b_newer:
        return CONCURRENT
    if a_newer:
        return GT
    if b_newer:
        return LT
    return EQ
