"""Core engine for radb: JSON query parsing, cost-based left-deep join
ordering, and set-semantics execution over CSV tables."""
from __future__ import annotations

import csv
import json
import os
from itertools import permutations

COMPARE_SELECTIVITY = 1.0 / 3.0
OPERATORS = {"=", "<", ">", "<=", ">=", "!="}
_SWAP_OP = {"<": ">", ">": "<", "<=": ">=", ">=": "<=", "=": "=", "!=": "!="}


class RadbError(Exception):
    """User-facing error, reported as a JSON object with exit code 2."""


# ---------------------------------------------------------------- loading

def _load_json(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        raise RadbError(f"missing file: {path}") from None
    except json.JSONDecodeError as exc:
        raise RadbError(f"invalid JSON in {path}: {exc}") from None


def load_catalog(path):
    """Return {table: {"file": str, "rows": int, "ndv": {col: int}}}."""
    data = _load_json(path)
    if not isinstance(data, dict):
        raise RadbError("catalog must be a JSON object")
    catalog = {}
    for name, entry in data.items():
        if not isinstance(entry, dict):
            raise RadbError(f"catalog entry for table {name!r} must be an object")
        try:
            rows = int(entry["rows"])
            ndv = {col: int(n) for col, n in entry["ndv"].items()}
        except (KeyError, TypeError, ValueError) as exc:
            raise RadbError(f"invalid catalog entry for table {name!r}: {exc}") from None
        if any(n <= 0 for n in ndv.values()):
            raise RadbError(f"NDV must be positive for table {name!r}")
        catalog[name] = {
            "file": entry.get("file", f"{name}.csv"),
            "rows": rows,
            "ndv": ndv,
        }
    return catalog


# ---------------------------------------------------------------- parsing

def _parse_operand(value):
    """Return ("col", name) or ("lit", value)."""
    if isinstance(value, dict):
        if "literal" in value:
            return ("lit", value["literal"])
        if "column" in value:
            return ("col", value["column"])
        raise RadbError(f"invalid operand: {value!r}")
    if isinstance(value, str):
        return ("col", value)
    if isinstance(value, (int, float, bool)):
        return ("lit", value)
    raise RadbError(f"invalid operand: {value!r}")


def resolve_column(ref, tables, catalog):
    """Resolve a possibly unqualified column reference to (table, column)."""
    if not isinstance(ref, str):
        raise RadbError(f"invalid column reference: {ref!r}")
    if "." in ref:
        table, col = ref.split(".", 1)
        if table not in tables:
            raise RadbError(f"unknown table in column reference: {ref}")
        if col not in catalog[table]["ndv"]:
            raise RadbError(f"unknown column: {ref}")
        return table, col
    matches = [t for t in tables if ref in catalog[t]["ndv"]]
    if not matches:
        raise RadbError(f"unknown column: {ref}")
    if len(matches) > 1:
        raise RadbError(f"ambiguous column: {ref}")
    return matches[0], ref


def parse_query(path, catalog):
    """Parse the query JSON into selects, filters and join conditions."""
    data = _load_json(path)
    if not isinstance(data, dict):
        raise RadbError("query must be a JSON object")
    try:
        select = list(data["select"])
        tables = list(data["from"])
    except (KeyError, TypeError):
        raise RadbError("query must contain 'select' and 'from' lists") from None
    if not tables:
        raise RadbError("query 'from' list must not be empty")
    if len(set(tables)) != len(tables):
        raise RadbError("duplicate table in 'from' list")
    for t in tables:
        if t not in catalog:
            raise RadbError(f"unknown table: {t}")

    where = data.get("where", [])
    if isinstance(where, dict):
        where = where.get("and", [where])
    if not isinstance(where, list):
        raise RadbError("query 'where' must be a condition or a list of conditions")

    selects = []
    for ref in select:
        t, c = resolve_column(ref, tables, catalog)
        selects.append({"ref": ref, "table": t, "column": c})

    filters = []      # {"table", "column", "op", "value"}
    join_conds = []   # ((t1, c1), (t2, c2))
    for cond in where:
        if not isinstance(cond, dict):
            raise RadbError(f"invalid condition: {cond!r}")
        op = cond.get("op")
        if op not in OPERATORS:
            raise RadbError(f"unsupported operator: {op!r}")
        try:
            lkind, lval = _parse_operand(cond["left"])
            rkind, rval = _parse_operand(cond["right"])
        except KeyError:
            raise RadbError(f"condition needs 'left' and 'right': {cond!r}") from None
        if lkind == "col" and rkind == "col":
            if op != "=":
                raise RadbError("only equality joins between columns are supported")
            left = resolve_column(lval, tables, catalog)
            right = resolve_column(rval, tables, catalog)
            if left == right:
                raise RadbError(f"invalid self comparison: {cond!r}")
            join_conds.append((left, right))
        elif lkind == "col" or rkind == "col":
            if lkind == "lit":  # normalize: column on the left
                lkind, lval, rkind, rval = rkind, rval, lkind, lval
                op = _SWAP_OP[op]
            t, c = resolve_column(lval, tables, catalog)
            filters.append({"table": t, "column": c, "op": op, "value": rval})
        else:
            raise RadbError("condition compares two literals")

    return {"select": selects, "from": tables, "filters": filters,
            "join_conds": join_conds}


# ---------------------------------------------------------------- costing

def selectivity(op, ndv):
    if op == "=":
        return 1.0 / ndv
    if op in ("<", ">", "<=", ">="):
        return COMPARE_SELECTIVITY
    if op == "!=":
        return 1.0 - 1.0 / ndv
    raise RadbError(f"unsupported operator: {op!r}")


def scan_cardinalities(tables, catalog, filters):
    """Base scan cardinality per table with filters pushed down."""
    cards = {}
    for t in tables:
        card = float(catalog[t]["rows"])
        for f in filters:
            if f["table"] == t:
                card *= selectivity(f["op"], catalog[t]["ndv"][f["column"]])
        cards[t] = card
    return cards


def join_order_cost(order, scan_cards, catalog, join_conds):
    """Cost of a left-deep order: sum of scans and all join-step results."""
    cost = sum(scan_cards[t] for t in order)
    present = {order[0]}
    card = scan_cards[order[0]]
    ndv = {(order[0], c): n for c, n in catalog[order[0]]["ndv"].items()}
    applied = set()
    for t in order[1:]:
        for c, n in catalog[t]["ndv"].items():
            ndv[(t, c)] = n
        new_card = card * scan_cards[t]
        for i, (a, b) in enumerate(join_conds):
            if i in applied:
                continue
            if a in ndv and b in ndv and (a[0] == t or b[0] == t):
                new_card /= max(ndv[a], ndv[b])
                shared = min(ndv[a], ndv[b])
                ndv[a] = ndv[b] = shared
                applied.add(i)
        card = new_card
        cost += card
        present.add(t)
    return cost


def best_join_order(tables, scan_cards, catalog, join_conds):
    """Enumerate all left-deep orders; min cost, ties by name order."""
    best_key = None
    best = None
    for perm in permutations(sorted(tables)):
        cost = join_order_cost(perm, scan_cards, catalog, join_conds)
        key = (round(cost, 9), perm)
        if best_key is None or key < best_key:
            best_key = key
            best = (list(perm), cost)
    return best


# ---------------------------------------------------------------- execution

def _convert(text):
    try:
        return int(text)
    except ValueError:
        pass
    try:
        return float(text)
    except ValueError:
        pass
    return text


def _load_csv(path):
    try:
        with open(path, newline="", encoding="utf-8") as fh:
            reader = csv.reader(fh)
            try:
                header = next(reader)
            except StopIteration:
                raise RadbError(f"empty csv file: {path}")
            rows = [dict(zip(header, (_convert(v) for v in row)))
                    for row in reader if row]
    except FileNotFoundError:
        raise RadbError(f"missing file: {path}") from None
    return header, rows


def _apply_op(lhs, op, rhs):
    if op == "=":
        return lhs == rhs
    if op == "!=":
        return lhs != rhs
    try:
        if op == "<":
            return lhs < rhs
        if op == ">":
            return lhs > rhs
        if op == "<=":
            return lhs <= rhs
        return lhs >= rhs
    except TypeError:
        raise RadbError(f"cannot compare {lhs!r} {op} {rhs!r}") from None


def execute(query, catalog, tables_dir, order):
    """Execute with filters pushed to base tables and the given join order."""
    filtered = {}
    for t in query["from"]:
        path = os.path.join(tables_dir, catalog[t]["file"])
        header, rows = _load_csv(path)
        for col in catalog[t]["ndv"]:
            if col not in header:
                raise RadbError(f"unknown column: {t}.{col} (not in {path})")
        table_filters = [f for f in query["filters"] if f["table"] == t]
        kept = []
        for row in rows:
            if all(_apply_op(row[f["column"]], f["op"], f["value"])
                   for f in table_filters):
                kept.append({(t, c): row[c] for c in header})
        filtered[t] = kept

    present = {order[0]}
    result = [dict(row) for row in filtered[order[0]]]
    applied = set()
    for t in order[1:]:
        conds = []
        for i, (a, b) in enumerate(query["join_conds"]):
            if i in applied:
                continue
            in_a, in_b = a[0] in present, b[0] in present
            if (in_a and b[0] == t) or (in_b and a[0] == t):
                conds.append((a, b))
                applied.add(i)
        joined = []
        for left_row in result:
            for right_row in filtered[t]:
                if all(left_row[a] == right_row[b] if a[0] != t
                       else left_row[b] == right_row[a]
                       for a, b in conds):
                    merged = dict(left_row)
                    merged.update(right_row)
                    joined.append(merged)
        result = joined
        present.add(t)

    keys = [(s["table"], s["column"]) for s in query["select"]]
    seen = set()
    rows = []
    for row in result:
        tup = tuple(row[k] for k in keys)
        if tup not in seen:
            seen.add(tup)
            rows.append(list(tup))
    rows.sort(key=lambda r: json.dumps(r))
    return rows


# ---------------------------------------------------------------- driver

def run_query(query_path, catalog_path, tables_dir):
    catalog = load_catalog(catalog_path)
    query = parse_query(query_path, catalog)
    scan_cards = scan_cardinalities(query["from"], catalog, query["filters"])
    order, cost = best_join_order(query["from"], scan_cards, catalog,
                                  query["join_conds"])
    rows = execute(query, catalog, tables_dir, order)
    return {
        "columns": [s["ref"] for s in query["select"]],
        "order": order,
        "cost": cost,
        "rows": rows,
    }
