"""Independent, non-incremental bag relational algebra interpreter.

Used to verify the incremental engine: it evaluates a query graph from
scratch over full base-table snapshots.  It shares no operator code with
the incremental implementation.
"""

_CMP = {
    "eq": lambda a, b: a == b,
    "ne": lambda a, b: a != b,
    "lt": lambda a, b: a < b,
    "le": lambda a, b: a <= b,
    "gt": lambda a, b: a > b,
    "ge": lambda a, b: a >= b,
}


def eval_predicate(spec, row):
    if spec is None:
        return True
    op = spec["op"]
    if op == "and":
        return all(eval_predicate(s, row) for s in spec["args"])
    if op == "or":
        return any(eval_predicate(s, row) for s in spec["args"])
    if op == "not":
        return not eval_predicate(spec["arg"], row)
    if op == "const":
        return bool(spec["value"])
    if op == "is_null":
        return row[spec["col"]] is None
    if op == "is_not_null":
        return row[spec["col"]] is not None
    if op in _CMP:
        left = row[spec["col"]]
        right = row[spec["other_col"]] if "other_col" in spec else spec["value"]
        if left is None or right is None:
            return False
        return _CMP[op](left, right)
    raise ValueError(f"unknown predicate op: {op!r}")


def _join_key(row, keys):
    key = tuple(row[i] for i in keys)
    if any(v is None for v in key):
        return None
    return key


def evaluate(node_id, nodes, tables):
    """Return the full multiset {row: count} for `node_id`.

    `nodes` maps node id -> spec dict; `tables` maps name -> {row: count}.
    """
    spec = nodes[node_id]
    kind = spec["type"]
    if kind == "scan":
        return {row: c for row, c in tables[spec["table"]].items() if c}
    inputs = [evaluate(p, nodes, tables) for p in spec.get("inputs", [])]
    if kind == "filter":
        return {r: c for r, c in inputs[0].items() if eval_predicate(spec.get("predicate"), r)}
    if kind == "project":
        cols = tuple(spec["columns"])
        out = {}
        for row, c in inputs[0].items():
            key = tuple(row[i] for i in cols)
            out[key] = out.get(key, 0) + c
        return out
    if kind == "distinct":
        return {r: 1 for r, c in inputs[0].items() if c > 0}
    if kind == "union_all":
        out = {}
        for rel in inputs:
            for row, c in rel.items():
                out[row] = out.get(row, 0) + c
        return {r: c for r, c in out.items() if c}
    if kind == "intersect_all":
        left, right = inputs
        return {r: min(c, right[r]) for r, c in left.items() if r in right and min(c, right[r]) > 0}
    if kind == "except_all":
        left, right = inputs
        return {r: c - right.get(r, 0) for r, c in left.items() if c - right.get(r, 0) > 0}
    if kind == "join":
        left, right = inputs
        lkeys, rkeys = tuple(spec["left_keys"]), tuple(spec["right_keys"])
        rindex = {}
        for row, c in right.items():
            key = _join_key(row, rkeys)
            if key is not None:
                rindex.setdefault(key, []).append((row, c))
        out = {}
        for lrow, lc in left.items():
            key = _join_key(lrow, lkeys)
            if key is None:
                continue
            for rrow, rc in rindex.get(key, ()):
                joined = lrow + rrow
                out[joined] = out.get(joined, 0) + lc * rc
        return out
    raise ValueError(f"unknown node type: {kind!r}")
