"""aggql: a tiny JSON aggregation query engine.

Supports GROUP BY, COUNT/SUM/AVG/MIN/MAX aggregates (with DISTINCT)
and HAVING filters evaluated under SQL three-valued logic.
"""

from __future__ import annotations

import json
from fractions import Fraction

AGG_FUNCS = ("COUNT", "SUM", "AVG", "MIN", "MAX")
CMP_OPS = ("=", "!=", "<", "<=", ">", ">=")


class QueryError(Exception):
    """Invalid query (e.g. unknown aggregate column). CLI exits with code 2."""


def _norm(value):
    """Hashable, type-aware normal form used for grouping and DISTINCT."""
    return (type(value).__name__, json.dumps(value, sort_keys=True))


def _to_fraction(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise QueryError(f"AVG requires numeric values, got {value!r}")
    if isinstance(value, int):
        return Fraction(value)
    return Fraction(str(value))


def _sum_values(values):
    total = 0
    for value in values:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise QueryError(f"SUM requires numeric values, got {value!r}")
        total += value
    return total


def _compute_aggregate(func, arg, distinct, rows):
    if arg == "*":
        return len(rows)
    values = [row.get(arg) for row in rows]
    if distinct:
        seen = {}
        for value in values:
            seen.setdefault(_norm(value), value)
        values = list(seen.values())
    values = [value for value in values if value is not None]
    if func == "COUNT":
        return len(values)
    if not values:
        return None
    if func == "SUM":
        return _sum_values(values)
    if func == "MIN":
        return min(values)
    if func == "MAX":
        return max(values)
    if func == "AVG":
        total = Fraction(0)
        for value in values:
            total += _to_fraction(value)
        avg = total / len(values)
        return f"{avg.numerator}/{avg.denominator}"
    raise QueryError(f"unknown aggregate function: {func}")


def _parse_aggregates(specs, schema):
    parsed = []
    used_aliases = set()
    for spec in specs:
        if not isinstance(spec, dict):
            raise QueryError("aggregate spec must be an object")
        func = str(spec.get("func", "")).upper()
        if func not in AGG_FUNCS:
            raise QueryError(f"unknown aggregate function: {func!r}")
        arg = spec.get("arg")
        distinct = bool(spec.get("distinct", False))
        if arg == "*":
            if func != "COUNT":
                raise QueryError(f"{func}(*) is not supported")
            if distinct:
                raise QueryError("COUNT(DISTINCT *) is not supported")
        else:
            if not isinstance(arg, str):
                raise QueryError("aggregate arg must be a column name or '*'")
            if arg not in schema:
                raise QueryError(f"unknown aggregate column: {arg}")
        alias = spec.get("as")
        if alias is None:
            alias = f"{func.lower()}_{'star' if arg == '*' else arg}"
            if distinct:
                alias = "distinct_" + alias
        if alias in used_aliases:
            raise QueryError(f"duplicate aggregate alias: {alias}")
        used_aliases.add(alias)
        parsed.append((func, arg, distinct, alias))
    return parsed


def _eval_having(expr, env, aliases, group_cols):
    """Evaluate a HAVING expression under three-valued logic.

    Returns True, False or None (UNKNOWN) for boolean expressions,
    and a plain value for operand expressions.
    """
    if isinstance(expr, dict):
        if "agg" in expr:
            name = expr["agg"]
            if name not in aliases:
                raise QueryError(f"unknown aggregate column in HAVING: {name}")
            return env[("agg", name)]
        if "col" in expr:
            name = expr["col"]
            if name not in group_cols:
                raise QueryError(f"unknown group-by column in HAVING: {name}")
            return env[("col", name)]
        if "lit" in expr:
            return expr["lit"]
        if "cmp" in expr:
            op = expr["cmp"]
            if op not in CMP_OPS:
                raise QueryError(f"unknown comparison operator: {op!r}")
            left = _eval_having(expr["left"], env, aliases, group_cols)
            right = _eval_having(expr["right"], env, aliases, group_cols)
            if left is None or right is None:
                return None
            try:
                if op == "=":
                    return left == right
                if op == "!=":
                    return left != right
                if op == "<":
                    return left < right
                if op == "<=":
                    return left <= right
                if op == ">":
                    return left > right
                return left >= right
            except TypeError as exc:
                raise QueryError(f"incomparable values in HAVING: {exc}") from exc
        if "and" in expr:
            result = True
            for sub in expr["and"]:
                value = _eval_having(sub, env, aliases, group_cols)
                if value is False:
                    return False
                if value is None:
                    result = None
            return result
        if "or" in expr:
            result = False
            for sub in expr["or"]:
                value = _eval_having(sub, env, aliases, group_cols)
                if value is True:
                    return True
                if value is None:
                    result = None
            return result
        if "not" in expr:
            value = _eval_having(expr["not"], env, aliases, group_cols)
            return None if value is None else not value
        raise QueryError(f"invalid HAVING expression: {expr!r}")
    if isinstance(expr, (str, int, float, bool)) or expr is None:
        return expr
    raise QueryError(f"invalid HAVING expression: {expr!r}")


def run_query(query, rows):
    """Run an aggregation query (dict) over rows (list of dicts).

    Returns a list of result rows (dicts) sorted deterministically.
    """
    if not isinstance(query, dict):
        raise QueryError("query must be a JSON object")
    group_cols = list(query.get("group_by", []))
    for col in group_cols:
        if not isinstance(col, str):
            raise QueryError("group_by entries must be column names")

    schema = set()
    for row in rows:
        schema.update(row.keys())

    aggregates = _parse_aggregates(query.get("aggregates", []), schema)
    aliases = {alias for _, _, _, alias in aggregates}
    having = query.get("having")

    groups = {}
    order = []
    for row in rows:
        key = tuple(_norm(row.get(col)) for col in group_cols)
        if key not in groups:
            groups[key] = {
                "values": [row.get(col) for col in group_cols],
                "rows": [],
            }
            order.append(key)
        groups[key]["rows"].append(row)
    if not group_cols and not groups:
        key = ()
        groups[key] = {"values": [], "rows": []}
        order.append(key)

    results = []
    for key in order:
        group = groups[key]
        out = {}
        env = {}
        for col, value in zip(group_cols, group["values"]):
            out[col] = value
            env[("col", col)] = value
        for func, arg, distinct, alias in aggregates:
            value = _compute_aggregate(func, arg, distinct, group["rows"])
            out[alias] = value
            env[("agg", alias)] = value
        if having is not None:
            verdict = _eval_having(having, env, aliases, set(group_cols))
            if verdict is not True:
                continue
        results.append(out)

    results.sort(key=lambda r: json.dumps(r, sort_keys=True, default=str))
    return results
