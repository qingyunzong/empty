"""Independent full-relation bag relational algebra interpreter.

This module evaluates a whole plan over committed base tables from
scratch.  It serves two purposes:

* bulk-initializing the state of newly compiled nodes, and
* acting as the reference oracle that the incremental engine is
  differentially tested against.

A relation is a dict mapping a tuple of JSON scalars (None == NULL) to a
non-negative integer multiplicity.
"""
from __future__ import annotations

from collections import defaultdict

from .plans import Plan


def join_key(row: tuple, cols: tuple):
    """Join key for a row, or None if any key component is NULL."""
    key = tuple(row[i] for i in cols)
    if any(v is None for v in key):
        return None
    return key


def evaluate(plan: Plan, tables: dict) -> dict:
    op = plan.op
    if op == "scan":
        return dict(tables.get(plan.table, {}))

    if op == "join":
        left = evaluate(plan.inputs[0], tables)
        right = evaluate(plan.inputs[1], tables)
        ridx = defaultdict(list)
        for row, mult in right.items():
            key = join_key(row, plan.right_cols)
            if key is not None:
                ridx[key].append((row, mult))
        out = defaultdict(int)
        for row, mult in left.items():
            key = join_key(row, plan.cols)
            if key is None:
                continue
            for rrow, rmult in ridx.get(key, ()):
                out[row + rrow] += mult * rmult
        return dict(out)

    if op in ("union_all", "intersect_all", "except_all"):
        left = evaluate(plan.inputs[0], tables)
        right = evaluate(plan.inputs[1], tables)
        if op == "union_all":
            out = defaultdict(int)
            for src in (left, right):
                for row, mult in src.items():
                    out[row] += mult
            return dict(out)
        if op == "intersect_all":
            return {
                row: min(mult, right[row])
                for row, mult in left.items()
                if right.get(row, 0) > 0
            }
        # except_all is max(left - right, 0); it never errors on
        # right-heavier keys, it simply floors at zero.
        return {
            row: mult - right.get(row, 0)
            for row, mult in left.items()
            if mult - right.get(row, 0) > 0
        }

    inp = evaluate(plan.inputs[0], tables)
    if op == "filter":
        return {row: mult for row, mult in inp.items() if plan.pred.test(row)}
    if op == "project":
        out = defaultdict(int)
        for row, mult in inp.items():
            out[tuple(row[i] for i in plan.cols)] += mult
        return dict(out)
    if op == "distinct":
        return {row: 1 for row, mult in inp.items() if mult > 0}
    raise ValueError(f"unknown plan op {op!r}")  # pragma: no cover
