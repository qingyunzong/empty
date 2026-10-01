"""aggql: tiny JSON-driven aggregation query engine.

Query format (query.json)::

    {
      "group_by": ["col_a", ...],            # optional, default []
      "aggregates": [                         # optional, default []
        {"func": "COUNT", "arg": "*", "distinct": false, "as": "cnt"},
        ...
      ],
      "having": <expr>                        # optional
    }

Aggregate func: COUNT | SUM | AVG | MIN | MAX.  arg: column name or "*"
(only valid for COUNT).  "distinct" and "as" are optional.

HAVING expression nodes::

    {"op": "AND", "args": [<expr>, ...]}
    {"op": "OR",  "args": [<expr>, ...]}
    {"op": "NOT", "arg": <expr>}
    {"op": "EQ"|"NE"|"LT"|"LE"|"GT"|"GE", "left": <operand>, "right": <operand>}
    {"op": "IS_NULL"|"IS_NOT_NULL", "arg": <operand>}

Operand nodes::

    {"const": <json value>}
    {"alias": "<aggregate output name>"}
    {"col": "<group-by column name>"}
    {"agg": {"func": ..., "arg": ..., "distinct": ...}}

Rows file (rows.json): a JSON array of objects.
Output: JSON array of result objects on stdout.
"""

from __future__ import annotations

from fractions import Fraction

FUNCS = ("COUNT", "SUM", "AVG", "MIN", "MAX")

UNKNOWN = None  # three-valued logic: True / False / None(UNKNOWN)


class AggqlError(Exception):
    """User-facing query error; the CLI exits with code 2."""


def _schema(rows):
    cols = set()
    for row in rows:
        if not isinstance(row, dict):
            raise AggqlError("each row must be a JSON object")
        cols.update(row.keys())
    return cols


def _normalize_agg(spec, schema):
    if not isinstance(spec, dict):
        raise AggqlError("aggregate spec must be an object")
    func = str(spec.get("func", "")).upper()
    if func not in FUNCS:
        raise AggqlError(f"unknown aggregate function: {spec.get('func')!r}")
    arg = spec.get("arg", "*")
    distinct = bool(spec.get("distinct", False))
    if arg == "*":
        if func != "COUNT":
            raise AggqlError(f"{func}(*) is not supported")
        if distinct:
            raise AggqlError("COUNT(DISTINCT *) is not supported")
    elif schema is not None and arg not in schema:
        raise AggqlError(f"unknown aggregate column: {arg!r}")
    alias = spec.get("as")
    if not alias:
        alias = f"{func.lower()}_{'star' if arg == '*' else arg}"
        if distinct:
            alias = "distinct_" + alias
    return {"func": func, "arg": arg, "distinct": distinct, "as": alias}


def _eval_agg(agg, rows):
    """Evaluate one normalized aggregate over a list of rows."""
    func = agg["func"]
    if func == "COUNT" and agg["arg"] == "*":
        return len(rows)
    # COUNT(col)/SUM/AVG/MIN/MAX all ignore NULLs.
    values = [row.get(agg["arg"]) for row in rows]
    values = [v for v in values if v is not None]
    if agg["distinct"]:
        # Dedup preserving first-seen order; all NULLs would collapse to
        # one, but NULLs are already filtered out above.
        seen = []
        for v in values:
            if v not in seen:
                seen.append(v)
        values = seen
    if func == "COUNT":
        return len(values)
    if not values:
        return None  # empty set: SUM/MIN/MAX/AVG are NULL
    if func == "SUM":
        return sum(values)
    if func == "MIN":
        return min(values)
    if func == "MAX":
        return max(values)
    # AVG: reduced fraction string, e.g. "3/2"; integers are "n/1".
    frac = Fraction(sum(values), len(values))
    return f"{frac.numerator}/{frac.denominator}"


def _eval_operand(node, out, group_rows, schema):
    if not isinstance(node, dict) or len(node) != 1:
        raise AggqlError(f"invalid HAVING operand: {node!r}")
    if "const" in node:
        return node["const"]
    if "alias" in node:
        name = node["alias"]
        if name not in out:
            raise AggqlError(f"unknown aggregate alias in HAVING: {name!r}")
        return out[name]
    if "col" in node:
        name = node["col"]
        if name not in out:
            raise AggqlError(f"unknown group-by column in HAVING: {name!r}")
        return out[name]
    # inline aggregate, e.g. {"agg": {"func": "SUM", "arg": "x"}}
    spec = node.get("agg")
    if not isinstance(spec, dict):
        raise AggqlError(f"invalid HAVING operand: {node!r}")
    return _eval_agg(_normalize_agg(spec, schema), group_rows)


_COMPARE_OPS = {
    "EQ": lambda a, b: a == b,
    "NE": lambda a, b: a != b,
    "LT": lambda a, b: a < b,
    "LE": lambda a, b: a <= b,
    "GT": lambda a, b: a > b,
    "GE": lambda a, b: a >= b,
}


def _eval_having(node, out, group_rows, schema):
    """Three-valued evaluation: returns True, False or None (UNKNOWN)."""
    if not isinstance(node, dict) or "op" not in node:
        raise AggqlError(f"invalid HAVING expression: {node!r}")
    op = str(node["op"]).upper()
    if op in ("AND", "OR"):
        args = node.get("args")
        if not isinstance(args, list) or not args:
            raise AggqlError(f"{op} requires a non-empty 'args' list")
        vals = [_eval_having(a, out, group_rows, schema) for a in args]
        if op == "AND":
            if any(v is False for v in vals):
                return False
            return True if all(v is True for v in vals) else UNKNOWN
        if any(v is True for v in vals):
            return True
        return False if all(v is False for v in vals) else UNKNOWN
    if op == "NOT":
        val = _eval_having(node.get("arg"), out, group_rows, schema)
        return UNKNOWN if val is UNKNOWN else not val
    if op in ("IS_NULL", "IS_NOT_NULL"):
        val = _eval_operand(node.get("arg"), out, group_rows, schema)
        is_null = val is None
        return is_null if op == "IS_NULL" else not is_null
    if op in _COMPARE_OPS:
        left = _eval_operand(node.get("left"), out, group_rows, schema)
        right = _eval_operand(node.get("right"), out, group_rows, schema)
        if left is None or right is None:
            return UNKNOWN
        try:
            return bool(_COMPARE_OPS[op](left, right))
        except TypeError as exc:
            raise AggqlError(f"incomparable values in HAVING: {exc}") from exc
    raise AggqlError(f"unknown HAVING op: {node['op']!r}")


def compute(rows, query):
    """Run the aggregation query and return a list of result dicts."""
    if not isinstance(rows, list):
        raise AggqlError("rows.json must contain a JSON array")
    if not isinstance(query, dict):
        raise AggqlError("query.json must contain a JSON object")
    schema = _schema(rows)
    # With no input rows there is no schema to validate against; column
    # validation is skipped and aggregates simply see empty groups.
    check = schema if rows else None

    group_cols = query.get("group_by", [])
    if not isinstance(group_cols, list):
        raise AggqlError("group_by must be a list")
    for col in group_cols:
        if check is not None and col not in check:
            raise AggqlError(f"unknown group-by column: {col!r}")

    aggs = [_normalize_agg(spec, check) for spec in query.get("aggregates", [])]
    aliases = [a["as"] for a in aggs]
    if len(set(aliases)) != len(aliases):
        raise AggqlError("duplicate aggregate alias")

    groups = {}
    order = []
    for row in rows:
        key = tuple(row.get(c) for c in group_cols)
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(row)
    if not group_cols and not groups:
        groups[()] = []  # empty input, no GROUP BY: one empty group

    results = []
    for key, group_rows in groups.items():
        out = dict(zip(group_cols, key))
        for agg in aggs:
            out[agg["as"]] = _eval_agg(agg, group_rows)
        results.append((out, group_rows))

    having = query.get("having")
    if having is not None:
        results = [
            (out, grows)
            for out, grows in results
            if _eval_having(having, out, grows, check) is True
        ]

    rows_out = [out for out, _ in results]
    import json

    rows_out.sort(key=lambda r: json.dumps(r, sort_keys=True, default=str))
    return rows_out
