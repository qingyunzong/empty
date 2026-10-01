"""Core engine for the radb mini relational database.

Pipeline: load -> validate -> optimize (left-deep, cost based) -> execute.

Semantics
---------
* Filter selectivity: equality on a column is 1/NDV(column); ``<`` and ``>``
  are 1/3.  Filters are pushed down to the base tables.
* Join cardinality: card(L) * card(R) / max(NDV(left key), NDV(right key))
  for every equality predicate connecting the two sides.
* Cost of a left-deep join order: sum of the (filtered) base-table scan
  cardinalities plus the cardinality of every intermediate join result.
  The cheapest order wins; ties are broken by the lexicographically
  smallest sequence of joined table names.
* All estimation uses exact rational arithmetic (fractions.Fraction).
* Actual results use set semantics (duplicates removed) and are sorted by
  their JSON representation.
"""

from __future__ import annotations

import csv
import json
import os
from dataclasses import dataclass, field
from fractions import Fraction

RESULT_FILE = "result.json"
COMPARISON_SELECTIVITY = Fraction(1, 3)
SUPPORTED_OPS = ("=", "<", ">")


class RadbError(Exception):
    """An error that must be reported to the user as a JSON object."""


# ---------------------------------------------------------------------------
# Loading and validation
# ---------------------------------------------------------------------------

def load_json_file(path, what):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        raise RadbError(f"{what} file not found: {path}") from None
    except json.JSONDecodeError as exc:
        raise RadbError(f"invalid JSON in {what} file {path}: {exc}") from None
    except OSError as exc:
        raise RadbError(f"cannot read {what} file {path}: {exc}") from None


def _positive_int(value):
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def load_catalog(path):
    """Load and strictly validate the statistics catalog."""
    raw = load_json_file(path, "catalog")
    if not isinstance(raw, dict):
        raise RadbError("catalog must be a JSON object mapping table names to stats")
    catalog = {}
    for table, entry in raw.items():
        if not isinstance(entry, dict):
            raise RadbError(f"catalog entry for table {table!r} must be an object")
        card = entry.get("cardinality")
        columns = entry.get("columns")
        if not _positive_int(card):
            raise RadbError(
                f"catalog entry for table {table!r} needs a positive integer 'cardinality'")
        if not isinstance(columns, dict) or not columns:
            raise RadbError(f"catalog entry for table {table!r} needs a 'columns' object")
        cols = {}
        for col, col_entry in columns.items():
            ndv = col_entry.get("ndv") if isinstance(col_entry, dict) else None
            if not _positive_int(ndv):
                raise RadbError(
                    f"catalog column {table}.{col} needs a positive integer 'ndv'")
            cols[col] = ndv
        catalog[table] = {"cardinality": card, "columns": cols}
    return catalog


# ---------------------------------------------------------------------------
# Query parsing
# ---------------------------------------------------------------------------

@dataclass
class Query:
    select: list                 # list of (table, column)
    from_tables: list            # list of table names, in written order
    filters: dict                # table -> list of ((table, col), op, ("const", v) | ("column", (t, c)))
    joins: list = field(default_factory=list)  # list of ((t, c), (t, c))


def _resolve_column(ref, from_tables, catalog):
    """Resolve a column reference to (table, column); raise on unknown/ambiguous."""
    if not isinstance(ref, str) or not ref:
        raise RadbError(f"invalid column reference: {ref!r}")
    parts = ref.split(".")
    if len(parts) == 2 and all(parts):
        table, col = parts
        if table not in from_tables:
            raise RadbError(f"unknown column: {ref} (table {table!r} is not in FROM)")
        if col not in catalog[table]["columns"]:
            raise RadbError(f"unknown column: {ref}")
        return (table, col)
    if len(parts) == 1:
        matches = [t for t in from_tables if ref in catalog[t]["columns"]]
        if not matches:
            raise RadbError(f"unknown column: {ref}")
        if len(matches) > 1:
            raise RadbError(f"ambiguous column: {ref}")
        return (matches[0], ref)
    raise RadbError(f"invalid column reference: {ref!r}")


def _parse_side(value):
    """Classify a condition operand as ('column', name) or ('const', value)."""
    if isinstance(value, str):
        return ("column", value)
    if isinstance(value, bool) or value is None or isinstance(value, (int, float)):
        return ("const", value)
    if isinstance(value, dict):
        if "const" in value:
            return ("const", value["const"])
        if "column" in value:
            return ("column", value["column"])
    raise RadbError(f"invalid operand in WHERE condition: {value!r}")


def compile_query(raw, catalog):
    if not isinstance(raw, dict):
        raise RadbError("query must be a JSON object")
    select = raw.get("select")
    from_tables = raw.get("from")
    where = raw.get("where", [])
    if not isinstance(select, list) or not select or not all(isinstance(s, str) for s in select):
        raise RadbError("query 'select' must be a non-empty list of column references")
    if (not isinstance(from_tables, list) or not from_tables
            or not all(isinstance(t, str) for t in from_tables)):
        raise RadbError("query 'from' must be a non-empty list of table names")
    if len(set(from_tables)) != len(from_tables):
        raise RadbError("query 'from' lists a table more than once (self-joins are unsupported)")
    for table in from_tables:
        if table not in catalog:
            raise RadbError(f"unknown table: {table}")
    if not isinstance(where, list):
        raise RadbError("query 'where' must be a list of conditions")

    select_cols = [_resolve_column(ref, from_tables, catalog) for ref in select]
    filters = {t: [] for t in from_tables}
    joins = []
    for cond in where:
        if not isinstance(cond, dict) or not {"left", "op", "right"} <= set(cond):
            raise RadbError("each WHERE condition needs 'left', 'op' and 'right'")
        op = cond["op"]
        if op not in SUPPORTED_OPS:
            raise RadbError(f"unsupported operator: {op!r}")
        left_kind, left_val = _parse_side(cond["left"])
        right_kind, right_val = _parse_side(cond["right"])
        if left_kind == "column" and right_kind == "column":
            if op != "=":
                raise RadbError("conditions between two columns must use '='")
            lref = _resolve_column(left_val, from_tables, catalog)
            rref = _resolve_column(right_val, from_tables, catalog)
            if lref[0] == rref[0]:
                filters[lref[0]].append((lref, op, ("column", rref)))
            else:
                joins.append((lref, rref))
        elif left_kind == "column" or right_kind == "column":
            if left_kind == "column":
                col_ref, const = _resolve_column(left_val, from_tables, catalog), right_val
                filters[col_ref[0]].append((col_ref, op, ("const", const)))
            else:
                col_ref, const = _resolve_column(right_val, from_tables, catalog), left_val
                flipped = {"<": ">", ">": "<", "=": "="}[op]
                filters[col_ref[0]].append((col_ref, flipped, ("const", const)))
        else:
            raise RadbError("conditions must compare a column to a column or a constant")
    return Query(select=select_cols, from_tables=from_tables, filters=filters, joins=joins)


# ---------------------------------------------------------------------------
# Cost model and join-order optimization
# ---------------------------------------------------------------------------

def base_cardinality(table, catalog, table_filters):
    """Cardinality of a base table after pushed-down filters (exact Fraction)."""
    card = Fraction(catalog[table]["cardinality"])
    for (col_ref, op, operand) in table_filters:
        kind, value = operand
        if kind == "column":
            other_ndv = catalog[value[0]]["columns"][value[1]]
            own_ndv = catalog[col_ref[0]]["columns"][col_ref[1]]
            card *= Fraction(1, max(own_ndv, other_ndv))
        elif op == "=":
            card *= Fraction(1, catalog[table]["columns"][col_ref[1]])
        else:  # '<' or '>'
            card *= COMPARISON_SELECTIVITY
    return card


def order_cost(order, base_cards, catalog, joins):
    """Cost of a left-deep order: base scans + intermediate join cardinalities."""
    total = Fraction(0)
    acc_card = None
    acc_tables = set()
    for table in order:
        total += base_cards[table]
        if acc_card is None:
            acc_card = base_cards[table]
        else:
            join_card = acc_card * base_cards[table]
            for (lt, lc), (rt, rc) in joins:
                if (lt in acc_tables and rt == table) or (rt in acc_tables and lt == table):
                    l_ndv = catalog[lt]["columns"][lc]
                    r_ndv = catalog[rt]["columns"][rc]
                    join_card /= max(l_ndv, r_ndv)
            total += join_card
            acc_card = join_card
        acc_tables.add(table)
    return total


def _enumerate_left_deep(tables):
    """Yield every left-deep join order (every permutation) of the tables."""
    def rec(prefix, rest):
        if not rest:
            yield prefix
            return
        for index, table in enumerate(rest):
            yield from rec(prefix + (table,), rest[:index] + rest[index + 1:])

    yield from rec((), tuple(tables))


def optimize(from_tables, base_cards, catalog, joins):
    """Return (best_order, best_cost); ties broken by lexicographic table order."""
    best_order = None
    best_cost = None
    for order in _enumerate_left_deep(from_tables):
        cost = order_cost(order, base_cards, catalog, joins)
        if best_cost is None or cost < best_cost or (cost == best_cost and order < best_order):
            best_cost, best_order = cost, order
    return list(best_order), best_cost


# ---------------------------------------------------------------------------
# Execution
# ---------------------------------------------------------------------------

def parse_value(text):
    """Interpret a CSV field as int, then float, else keep the string."""
    try:
        return int(text)
    except ValueError:
        pass
    try:
        return float(text)
    except ValueError:
        return text


def load_table(tables_dir, table, catalog):
    path = os.path.join(tables_dir, table + ".csv")
    try:
        handle = open(path, "r", newline="", encoding="utf-8")
    except FileNotFoundError:
        raise RadbError(f"table file not found: {path}") from None
    except OSError as exc:
        raise RadbError(f"cannot read table file {path}: {exc}") from None
    with handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames is None:
            raise RadbError(f"table file is empty (no header): {path}")
        missing = [c for c in catalog[table]["columns"] if c not in reader.fieldnames]
        if missing:
            raise RadbError(
                f"table file {path} is missing columns: {', '.join(sorted(missing))}")
        rows = []
        for raw_row in reader:
            rows.append({(table, col): parse_value(raw_row[col])
                         for col in catalog[table]["columns"]})
    return rows


def _compare(left, op, right):
    try:
        if op == "=":
            return left == right
        if op == "<":
            return left < right
        return left > right
    except TypeError:
        raise RadbError(f"type mismatch comparing {left!r} {op} {right!r}") from None


def _row_passes(row, table_filters):
    for col_ref, op, operand in table_filters:
        kind, value = operand
        other = row[value] if kind == "column" else value
        if not _compare(row[col_ref], op, other):
            return False
    return True


def execute_join(order, filtered_data, joins):
    """Execute the joins in the chosen left-deep order over actual rows."""
    acc = list(filtered_data[order[0]])
    acc_tables = {order[0]}
    for table in order[1:]:
        preds = []
        for (lref, rref) in joins:
            if lref[0] in acc_tables and rref[0] == table:
                preds.append((lref, rref, False))
            elif rref[0] in acc_tables and lref[0] == table:
                preds.append((rref, lref, False))
        next_rows = []
        for acc_row in acc:
            for new_row in filtered_data[table]:
                if all(acc_row[left_ref] == new_row[right_ref]
                       for left_ref, right_ref, _ in preds):
                    merged = dict(acc_row)
                    merged.update(new_row)
                    next_rows.append(merged)
        acc = next_rows
        acc_tables.add(table)
    return acc


def project(rows, select_cols):
    """Project, deduplicate (set semantics) and sort by JSON representation."""
    out = []
    seen = set()
    for row in rows:
        obj = {f"{table}.{col}": row[(table, col)] for table, col in select_cols}
        key = json.dumps(obj, sort_keys=True)
        if key not in seen:
            seen.add(key)
            out.append(obj)
    out.sort(key=lambda obj: json.dumps(obj, sort_keys=True))
    return out


# ---------------------------------------------------------------------------
# Top-level driver
# ---------------------------------------------------------------------------

def run(query_path, catalog_path, tables_dir, result_path=RESULT_FILE):
    """Run the whole pipeline; returns a summary dict. Raises RadbError."""
    raw_query = load_json_file(query_path, "query")
    catalog = load_catalog(catalog_path)
    query = compile_query(raw_query, catalog)

    base_cards = {t: base_cardinality(t, catalog, query.filters[t])
                  for t in query.from_tables}
    order, cost = optimize(query.from_tables, base_cards, catalog, query.joins)

    data = {t: load_table(tables_dir, t, catalog) for t in query.from_tables}
    filtered = {t: [row for row in data[t] if _row_passes(row, query.filters[t])]
                for t in query.from_tables}
    joined = execute_join(order, filtered, query.joins)
    rows = project(joined, query.select)

    with open(result_path, "w", encoding="utf-8") as handle:
        json.dump(rows, handle, indent=2, sort_keys=True)
        handle.write("\n")
    return {"join_order": order, "cost": cost, "rows": len(rows)}
