"""Independent per-cell reference evaluator.

Deliberately written as a straightforward, naive re-implementation of
the maskview semantics: it iterates every row and every cell, scanning
the full rule list each time.  The randomized differential test
(tests.test_maskview.RandomizedConsistencyTest) cross-checks the real
engine against this evaluator on generated tables and policies.
"""

from __future__ import annotations

from . import expr as exprmod
from .engine import STRICTNESS, apply_action, load_policy, load_table
from .errors import PolicyError


def _targets_column(rule, column):
    if rule.column is not None:
        return rule.column == column.name
    return column.sensitivity >= rule.level


def _condition_is_true(expr_text, row, columns, what):
    ast = exprmod.parse(expr_text, columns)
    value = exprmod.evaluate(ast, row)
    if value is exprmod.UNKNOWN:
        raise PolicyError("E_EVAL", "%s evaluated to UNKNOWN" % what)
    if not isinstance(value, bool):
        raise PolicyError("E_EVAL", "%s must be boolean, got %r" % (what, value))
    return value


def reference_query(data_obj, policy_obj, role):
    table = load_table(data_obj)
    columns = table.column_names

    applicable = [r for r in load_policy(policy_obj) if r.applies_to(role)]

    # Validate every referenced column up front (E_SCHEMA).
    for rule in applicable:
        if rule.kind == "row_filter":
            exprmod.parse(rule.expr_text, columns)
        else:
            if rule.column is not None and rule.column not in columns:
                raise PolicyError("E_SCHEMA", "unknown column %r in mask rule" % rule.column)
            if rule.when_text is not None:
                exprmod.parse(rule.when_text, columns)

    mask_rules = [r for r in applicable if r.kind == "mask"]
    filter_rules = [r for r in applicable if r.kind == "row_filter"]

    # A column is dropped iff any applicable drop rule targets it.
    dropped = set()
    for rule in mask_rules:
        if rule.action != "drop":
            continue
        for column in table.columns:
            if _targets_column(rule, column):
                dropped.add(column.name)

    if table.sort_column is not None:
        if table.sort_column not in columns:
            raise PolicyError("E_SCHEMA", "unknown sort column %r" % table.sort_column)
        if table.sort_column in dropped:
            raise PolicyError("E_SCHEMA", "cannot sort by dropped column %r" % table.sort_column)

    # Per-row visibility: a row is kept only if every filter is TRUE.
    visible_rows = []
    for row in table.rows:
        visible = True
        for rule in filter_rules:
            if not _condition_is_true(rule.expr_text, row, columns, "row filter"):
                visible = False
                break
        if visible:
            visible_rows.append(row)

    if table.sort_column is not None:
        key = table.sort_column
        try:
            visible_rows.sort(
                key=lambda row: (row.get(key) is None, row.get(key) if row.get(key) is not None else 0),
                reverse=table.sort_desc,
            )
        except TypeError as exc:
            raise PolicyError("E_EVAL", "cannot sort column %r: %s" % (key, exc)) from exc

    # Per-cell masking: scan every mask rule for every single cell and
    # keep the strictest applicable action (drop > redact > hash > clear).
    output = []
    for row in visible_rows:
        out_row = {}
        for column in table.columns:
            if column.name in dropped:
                continue
            best = "clear"
            for rule in mask_rules:
                if rule.action == "drop":
                    continue
                if not _targets_column(rule, column):
                    continue
                if rule.when_text is not None and not _condition_is_true(
                    rule.when_text, row, columns, "when clause"
                ):
                    continue
                if STRICTNESS[rule.action] > STRICTNESS[best]:
                    best = rule.action
            out_row[column.name] = apply_action(best, row.get(column.name))
        output.append(out_row)
    return output
