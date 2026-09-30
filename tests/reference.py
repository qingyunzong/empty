"""Independent per-cell reference evaluator for maskview semantics.

Written separately from ``maskview.engine`` (direct AST interpretation,
explicit Kleene truth tables, brute-force per-cell rule resolution) so
the fuzz test compares two independent implementations of the spec.
"""
from __future__ import annotations

import ast
import hashlib

RANK = {"clear": 0, "hash": 1, "redact": 2, "drop": 3}
SENS = {"low": 0, "medium": 1, "high": 2}


class RefError(Exception):
    def __init__(self, code, message):
        super().__init__(f"{code}: {message}")
        self.code = code


# --- three-valued logic, table-driven -----------------------------------

_NOT = {True: False, False: True, "U": "U"}

_AND = {
    (True, True): True, (True, False): False, (True, "U"): "U",
    (False, True): False, (False, False): False, (False, "U"): False,
    ("U", True): "U", ("U", False): False, ("U", "U"): "U",
}

_OR = {
    (True, True): True, (True, False): True, (True, "U"): True,
    (False, True): True, (False, False): False, (False, "U"): "U",
    ("U", True): True, ("U", False): "U", ("U", "U"): "U",
}


def _lift(value):
    return "U" if value is UNKNOWN else value


class _U:
    pass


UNKNOWN = _U()

_LITERALS = {"null": None, "true": True, "false": False}


def _eval(node, row, columns):
    if isinstance(node, ast.Expression):
        return _eval(node.body, row, columns)
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.Name):
        if node.id in _LITERALS:
            return _LITERALS[node.id]
        if node.id not in columns:
            raise RefError("E_SCHEMA", f"unknown column {node.id!r}")
        return row.get(node.id)
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
        operand = _eval(node.operand, row, columns)
        if operand is not UNKNOWN and not isinstance(operand, bool):
            raise RefError("E_EXPR", "not-a-boolean")
        negated = _NOT[_lift(operand)]
        return UNKNOWN if negated == "U" else negated
    if isinstance(node, ast.BoolOp):
        table = _AND if isinstance(node.op, ast.And) else _OR
        acc = _eval(node.values[0], row, columns)
        if acc is not UNKNOWN and not isinstance(acc, bool):
            raise RefError("E_EXPR", "not-a-boolean")
        for child in node.values[1:]:
            other = _eval(child, row, columns)
            if other is not UNKNOWN and not isinstance(other, bool):
                raise RefError("E_EXPR", "not-a-boolean")
            acc = table[(_lift(acc), _lift(other))]
        return UNKNOWN if acc == "U" else acc
    if isinstance(node, ast.Compare):
        return _compare(node, row, columns)
    if isinstance(node, (ast.List, ast.Tuple)):
        return [_eval(elt, row, columns) for elt in node.elts]
    raise RefError("E_EXPR", f"unsupported node {type(node).__name__}")


def _compare(node, row, columns):
    values = [_eval(node.left, row, columns)]
    values += [_eval(c, row, columns) for c in node.comparators]
    outcome = True
    for op, lhs, rhs in zip(node.ops, values, values[1:]):
        if isinstance(op, ast.Is):
            piece = lhs is None
        elif isinstance(op, ast.IsNot):
            piece = lhs is not None
        elif lhs is None or rhs is None or lhs is UNKNOWN or rhs is UNKNOWN:
            piece = UNKNOWN
        else:
            try:
                if isinstance(op, ast.Eq):
                    piece = lhs == rhs
                elif isinstance(op, ast.NotEq):
                    piece = lhs != rhs
                elif isinstance(op, ast.Lt):
                    piece = lhs < rhs
                elif isinstance(op, ast.LtE):
                    piece = lhs <= rhs
                elif isinstance(op, ast.Gt):
                    piece = lhs > rhs
                elif isinstance(op, ast.GtE):
                    piece = lhs >= rhs
                elif isinstance(op, ast.In):
                    piece = lhs in rhs
                elif isinstance(op, ast.NotIn):
                    piece = lhs not in rhs
                else:
                    raise RefError("E_EXPR", "bad operator")
            except TypeError:
                raise RefError("E_EXPR", "incomparable")
        outcome = _AND[(_lift(outcome), _lift(piece))]
        if outcome is False:
            return False
    return UNKNOWN if outcome == "U" else outcome


def _parse(text):
    try:
        return ast.parse(text, mode="eval")
    except SyntaxError:
        raise RefError("E_EXPR", f"bad expression {text!r}")


def _visible(row, filters, columns):
    state = True
    for flt in filters:
        cond = _eval(_parse(flt["when"]), row, columns)
        effect = flt.get("effect", "deny")
        term = cond if effect == "allow" else _NOT[_lift(cond)]
        state = _AND[(_lift(state), _lift(term))]
        if state is False:
            return False
    return state is True


def _rule_applies(rule, column, sensitivity):
    if "column" in rule:
        return rule["column"] == column
    level = sensitivity.get(column, "low")
    return SENS[level] >= SENS[rule["sensitivity_at_least"]]


def _cell_action(row, column, rules, sensitivity, columns):
    best = "clear"
    for rule in rules:
        if not _rule_applies(rule, column, sensitivity):
            continue
        when = rule.get("when")
        if when is not None and _eval(_parse(when), row, columns) is not True:
            continue
        if RANK[rule["action"]] > RANK[best]:
            best = rule["action"]
    return best


def reference_query(data, policy, role, sort_by=None, descending=False):
    columns = [c["name"] if isinstance(c, dict) else c for c in data["columns"]]
    colset = set(columns)
    sensitivity = policy.get("sensitivity", {})
    try:
        role_policy = policy["roles"][role]
    except KeyError:
        raise RefError("E_ROLE", f"unknown role {role!r}")
    filters = role_policy.get("row_filters", [])
    rules = role_policy.get("column_rules", [])

    if sort_by is not None:
        if sort_by not in colset:
            raise RefError("E_SCHEMA", f"unknown sort column {sort_by!r}")
        for rule in rules:
            if rule["action"] == "drop" and "when" not in rule and _rule_applies(rule, sort_by, sensitivity):
                raise RefError("E_SCHEMA", f"cannot sort by dropped column {sort_by!r}")

    out = []
    dropped_anywhere = set()
    for row in data.get("rows", []):
        if not _visible(row, filters, colset):
            continue
        record = {}
        for column in columns:  # schema order, always
            action = _cell_action(row, column, rules, sensitivity, colset)
            if action == "drop":
                dropped_anywhere.add(column)
                continue
            if action == "hash":
                record[column] = "sha256:" + hashlib.sha256(
                    f"{column}={row.get(column)!r}".encode("utf-8")
                ).hexdigest()
            elif action == "redact":
                record[column] = "***"
            else:
                record[column] = row.get(column)
        out.append(record)

    if sort_by is not None:
        if sort_by in dropped_anywhere:
            raise RefError("E_SCHEMA", f"cannot sort by dropped column {sort_by!r}")
        try:
            out = sorted(
                out,
                key=lambda rec: (rec[sort_by] is None, rec[sort_by]),
                reverse=descending,
            )
        except TypeError:
            raise RefError("E_SORT", f"values of column {sort_by!r} are not orderable")
    return out
