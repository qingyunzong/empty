"""Maskview query engine.

Pipeline (order matters for error determinism):

  1. Load + validate table and policy (E_DATA / E_POLICY).
  2. Select rules applicable to the queried role and compile their
     expressions, validating every referenced column (E_SCHEMA).
  3. Resolve column-level ``drop`` actions (drop is unconditional).
  4. Validate the sort key: it must exist and must not be dropped
     (E_SCHEMA) -- a dropped column never participates in ordering.
  5. Row filtering: a row survives only if every row filter is TRUE.
     UNKNOWN is never treated as false; it raises E_EVAL.
  6. Sort surviving rows by the *original* values of the sort column.
  7. Projection + masking in schema column order: for each cell the
     strictest applicable action wins (drop > redact > hash > clear).

Output is a list of objects whose keys follow schema order with dropped
columns removed; invisible rows vanish entirely (no null placeholders,
no count metadata).
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field

from . import expr as exprmod
from .errors import PolicyError

STRICTNESS = {"clear": 0, "hash": 1, "redact": 2, "drop": 3}
ACTIONS = frozenset(STRICTNESS)
REDACTED = "***"


def hash_value(value):
    """Deterministic, JSON-stable content hash for the ``hash`` action."""
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True)
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


def apply_action(action, value):
    if action == "clear":
        return value
    if action == "hash":
        return hash_value(value)
    if action == "redact":
        return REDACTED
    raise PolicyError("E_POLICY", "cannot apply action %r to a cell" % action)


@dataclass
class Column:
    name: str
    sensitivity: int = 0


@dataclass
class Table:
    columns: list
    rows: list
    sort_column: str = None
    sort_desc: bool = False

    @property
    def column_names(self):
        return [c.name for c in self.columns]


@dataclass
class Rule:
    kind: str                      # "row_filter" | "mask"
    roles: frozenset = None        # None => applies to every role
    expr_text: str = None          # row_filter expression
    column: str = None             # mask target column
    level: int = None              # mask target sensitivity level
    action: str = None             # mask action
    when_text: str = None          # optional per-row condition
    expr_ast: object = field(default=None, repr=False)
    when_ast: object = field(default=None, repr=False)

    def applies_to(self, role):
        return self.roles is None or role in self.roles


def load_table(obj):
    if not isinstance(obj, dict):
        raise PolicyError("E_DATA", "data file must contain a JSON object")
    schema = obj.get("schema")
    if not isinstance(schema, list) or not schema:
        raise PolicyError("E_DATA", "schema must be a non-empty list")
    columns = []
    seen = set()
    for entry in schema:
        if isinstance(entry, str):
            name, sensitivity = entry, 0
        elif isinstance(entry, dict) and isinstance(entry.get("name"), str):
            name = entry["name"]
            sensitivity = entry.get("sensitivity", 0)
            if not isinstance(sensitivity, int) or isinstance(sensitivity, bool):
                raise PolicyError("E_DATA", "sensitivity of %r must be an int" % name)
        else:
            raise PolicyError("E_DATA", "bad schema entry %r" % (entry,))
        if name in seen:
            raise PolicyError("E_DATA", "duplicate column %r" % name)
        seen.add(name)
        columns.append(Column(name, sensitivity))

    raw_rows = obj.get("rows", [])
    if not isinstance(raw_rows, list):
        raise PolicyError("E_DATA", "rows must be a list")
    names = [c.name for c in columns]
    rows = []
    for raw in raw_rows:
        if isinstance(raw, dict):
            rows.append({name: raw.get(name) for name in names})
        elif isinstance(raw, list):
            if len(raw) != len(names):
                raise PolicyError("E_DATA", "row %r does not match schema arity" % (raw,))
            rows.append(dict(zip(names, raw)))
        else:
            raise PolicyError("E_DATA", "row must be an object or array, got %r" % (raw,))

    sort_column = None
    sort_desc = False
    sort = obj.get("sort")
    if isinstance(sort, str):
        sort_column = sort
    elif isinstance(sort, dict):
        sort_column = sort.get("column")
        sort_desc = bool(sort.get("desc", False))
        if not isinstance(sort_column, str):
            raise PolicyError("E_DATA", "sort.column must be a string")
    elif sort is not None:
        raise PolicyError("E_DATA", "sort must be a column name or an object")
    return Table(columns, rows, sort_column, sort_desc)


def load_policy(obj):
    if isinstance(obj, list):
        obj = {"rules": obj}
    if not isinstance(obj, dict) or not isinstance(obj.get("rules"), list):
        raise PolicyError("E_POLICY", "policy must be an object with a 'rules' list")
    rules = []
    for raw in obj["rules"]:
        if not isinstance(raw, dict):
            raise PolicyError("E_POLICY", "rule must be an object: %r" % (raw,))
        kind = raw.get("type")
        if kind not in ("row_filter", "mask"):
            raise PolicyError("E_POLICY", "rule type must be 'row_filter' or 'mask': %r" % (kind,))
        roles = None
        if "role" in raw:
            roles = frozenset([raw["role"]])
        elif "roles" in raw:
            if not isinstance(raw["roles"], list):
                raise PolicyError("E_POLICY", "roles must be a list")
            roles = frozenset(raw["roles"])
        rule = Rule(kind=kind, roles=roles)
        if kind == "row_filter":
            rule.expr_text = raw.get("expr")
            if not isinstance(rule.expr_text, str):
                raise PolicyError("E_POLICY", "row_filter rule requires an 'expr' string")
        else:
            rule.column = raw.get("column")
            rule.level = raw.get("level")
            if (rule.column is None) == (rule.level is None):
                raise PolicyError("E_POLICY", "mask rule needs exactly one of 'column' or 'level'")
            if rule.column is not None and not isinstance(rule.column, str):
                raise PolicyError("E_POLICY", "mask 'column' must be a string")
            if rule.level is not None and (not isinstance(rule.level, int) or isinstance(rule.level, bool)):
                raise PolicyError("E_POLICY", "mask 'level' must be an int")
            rule.action = raw.get("action")
            if rule.action not in ACTIONS:
                raise PolicyError("E_POLICY", "unknown mask action %r" % (rule.action,))
            rule.when_text = raw.get("when")
            if rule.when_text is not None and not isinstance(rule.when_text, str):
                raise PolicyError("E_POLICY", "'when' must be an expression string")
            if rule.action == "drop" and rule.when_text is not None:
                raise PolicyError("E_POLICY", "drop rules cannot have a 'when' clause")
        rules.append(rule)
    return rules


def compile_rules(rules, role, column_names):
    """Select rules for ``role`` and compile/validate their expressions."""
    compiled = []
    for rule in rules:
        if not rule.applies_to(role):
            continue
        if rule.kind == "row_filter":
            rule.expr_ast = exprmod.parse(rule.expr_text, column_names)
        else:
            if rule.column is not None and rule.column not in column_names:
                raise PolicyError("E_SCHEMA", "unknown column %r in mask rule" % rule.column)
            if rule.when_text is not None:
                rule.when_ast = exprmod.parse(rule.when_text, column_names)
        compiled.append(rule)
    return compiled


def _eval_condition(ast, row, what):
    value = exprmod.evaluate(ast, row)
    if value is exprmod.UNKNOWN:
        raise PolicyError("E_EVAL", "%s evaluated to UNKNOWN" % what)
    if not isinstance(value, bool):
        raise PolicyError("E_EVAL", "%s must be boolean, got %r" % (what, value))
    return value


def _sort_key(value):
    return (value is None, value if value is not None else 0)


def run_query(data_obj, policy_obj, role):
    """Execute a masked query. Returns a list of row dicts in schema order."""
    if not isinstance(role, str):
        raise PolicyError("E_USAGE", "role must be a string")
    table = load_table(data_obj)
    rules = compile_rules(load_policy(policy_obj), role, table.column_names)

    row_filters = [r for r in rules if r.kind == "row_filter"]
    mask_rules = [r for r in rules if r.kind == "mask"]

    # Column-level resolution: group mask rules per target column.
    rules_by_column = {name: [] for name in table.column_names}
    dropped = set()
    for rule in mask_rules:
        if rule.column is not None:
            targets = [rule.column]
        else:
            targets = [c.name for c in table.columns if c.sensitivity >= rule.level]
        for name in targets:
            rules_by_column[name].append(rule)
            if rule.action == "drop":
                dropped.add(name)

    # Sort key validation happens before any row is emitted.
    if table.sort_column is not None:
        if table.sort_column not in rules_by_column:
            raise PolicyError("E_SCHEMA", "unknown sort column %r" % table.sort_column)
        if table.sort_column in dropped:
            raise PolicyError("E_SCHEMA", "cannot sort by dropped column %r" % table.sort_column)

    # Row filtering: invisible rows disappear entirely.
    visible = []
    for row in table.rows:
        keep = True
        for rule in row_filters:
            if not _eval_condition(rule.expr_ast, row, "row filter"):
                keep = False
                break
        if keep:
            visible.append(row)

    if table.sort_column is not None:
        key = table.sort_column
        try:
            visible.sort(key=lambda row: _sort_key(row.get(key)), reverse=table.sort_desc)
        except TypeError as exc:
            raise PolicyError("E_EVAL", "cannot sort column %r: %s" % (key, exc)) from exc

    # Projection + per-cell masking in schema order.
    out_columns = [name for name in table.column_names if name not in dropped]
    output = []
    for row in visible:
        out_row = {}
        for name in out_columns:
            action = "clear"
            for rule in rules_by_column[name]:
                if rule.action == "drop":
                    continue  # unreachable: column would be dropped
                if rule.when_ast is not None and not _eval_condition(rule.when_ast, row, "when clause"):
                    continue
                if STRICTNESS[rule.action] > STRICTNESS[action]:
                    action = rule.action
            out_row[name] = apply_action(action, row.get(name))
        output.append(out_row)
    return output
