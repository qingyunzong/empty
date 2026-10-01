"""Filter predicates over rows (tuples). SQL-style NULL semantics:
any comparison involving None evaluates to unknown -> False.
"""

_OPS = {
    "eq": lambda a, b: a == b,
    "ne": lambda a, b: a != b,
    "lt": lambda a, b: a < b,
    "le": lambda a, b: a <= b,
    "gt": lambda a, b: a > b,
    "ge": lambda a, b: a >= b,
}


def compile_predicate(spec):
    """Compile a JSON-style predicate spec into a callable row -> bool."""
    if spec is None:
        return lambda row: True
    op = spec["op"]
    if op == "and":
        parts = [compile_predicate(s) for s in spec["args"]]
        return lambda row: all(p(row) for p in parts)
    if op == "or":
        parts = [compile_predicate(s) for s in spec["args"]]
        return lambda row: any(p(row) for p in parts)
    if op == "not":
        inner = compile_predicate(spec["arg"])
        return lambda row: not inner(row)
    if op == "const":
        value = bool(spec["value"])
        return lambda row: value
    if op == "is_null":
        col = spec["col"]
        return lambda row: row[col] is None
    if op == "is_not_null":
        col = spec["col"]
        return lambda row: row[col] is not None
    if op in _OPS:
        func = _OPS[op]
        col = spec["col"]
        if "other_col" in spec:
            other = spec["other_col"]

            def pred(row, col=col, other=other, func=func):
                left, right = row[col], row[other]
                if left is None or right is None:
                    return False
                return func(left, right)

            return pred
        value = spec["value"]

        def pred(row, col=col, value=value, func=func):
            cell = row[col]
            if cell is None or value is None:
                return False
            return func(cell, value)

        return pred
    raise ValueError(f"unknown predicate op: {op!r}")
