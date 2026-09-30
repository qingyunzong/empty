"""Core maskview evaluation engine.

Semantics
---------
* Row filtering: a row is visible only when the combined row-filter
  predicate is TRUE (three-valued logic).  Invisible rows disappear
  entirely -- they never appear as null/placeholder rows.
* Column masking: applicable column rules resolve per cell to the
  strictest action, where ``drop > redact > hash > clear``.
* ``drop`` removes the key from the output row; a dropped column may
  not be used as a sort key (E_SCHEMA).
* Output column order is always the schema order, regardless of the
  order rules appear in the policy.
"""
from __future__ import annotations

import hashlib

from . import expr
from .errors import PolicyError

ACTIONS = ("clear", "hash", "redact", "drop")
_STRICTNESS = {name: rank for rank, name in enumerate(ACTIONS)}

SENSITIVITY_LEVELS = ("low", "medium", "high")
_SENSITIVITY_RANK = {name: rank for rank, name in enumerate(SENSITIVITY_LEVELS)}

REDACTED = "***"


class _ColumnRule:
    def __init__(self, raw, schema, sensitivity):
        self.action = raw.get("action")
        if self.action not in _STRICTNESS:
            raise PolicyError("E_POLICY", f"invalid column rule action {self.action!r}")
        has_column = "column" in raw
        has_sensitivity = "sensitivity_at_least" in raw
        if has_column == has_sensitivity:
            raise PolicyError(
                "E_POLICY",
                "column rule needs exactly one of 'column' or 'sensitivity_at_least'",
            )
        self.column = None
        self.min_sensitivity = None
        if has_column:
            self.column = raw["column"]
            if self.column not in schema:
                raise PolicyError("E_SCHEMA", f"column rule targets unknown column {self.column!r}")
        else:
            level = raw["sensitivity_at_least"]
            if level not in _SENSITIVITY_RANK:
                raise PolicyError("E_POLICY", f"invalid sensitivity level {level!r}")
            self.min_sensitivity = level
        self.when = expr.parse(raw["when"]) if "when" in raw else None
        if self.when is not None:
            _check_expression_columns(self.when, schema)
        self._sensitivity = sensitivity

    def matches_column(self, column):
        if self.column is not None:
            return self.column == column
        level = self._sensitivity.get(column, "low")
        return _SENSITIVITY_RANK[level] >= _SENSITIVITY_RANK[self.min_sensitivity]


class _RowFilter:
    def __init__(self, raw, schema):
        if "when" not in raw:
            raise PolicyError("E_POLICY", "row filter requires a 'when' expression")
        self.effect = raw.get("effect", "deny")
        if self.effect not in ("allow", "deny"):
            raise PolicyError("E_POLICY", f"invalid row filter effect {self.effect!r}")
        self.when = expr.parse(raw["when"])
        _check_expression_columns(self.when, schema)


class _RolePolicy:
    def __init__(self, raw, schema, sensitivity):
        if not isinstance(raw, dict):
            raise PolicyError("E_POLICY", "role policy must be an object")
        self.row_filters = [
            _RowFilter(item, schema) for item in raw.get("row_filters", [])
        ]
        self.column_rules = [
            _ColumnRule(item, schema, sensitivity) for item in raw.get("column_rules", [])
        ]


def _check_expression_columns(node, schema):
    for name in expr.expression_columns(node):
        if name not in schema:
            raise PolicyError("E_SCHEMA", f"unknown column {name!r} in expression")


class MaskView:
    """Evaluates a data table against a masking policy."""

    def __init__(self, data, policy):
        if not isinstance(data, dict) or not isinstance(policy, dict):
            raise PolicyError("E_INPUT", "data and policy must be JSON objects")
        self.schema = self._load_schema(data)
        self.schema_set = set(self.schema)
        self.rows = self._load_rows(data)
        self.sensitivity = self._load_sensitivity(policy)
        roles = policy.get("roles")
        if not isinstance(roles, dict) or not roles:
            raise PolicyError("E_POLICY", "policy must define at least one role")
        self._roles = {
            name: _RolePolicy(raw, self.schema_set, self.sensitivity)
            for name, raw in roles.items()
        }

    @staticmethod
    def _load_schema(data):
        columns = data.get("columns")
        if not isinstance(columns, list) or not columns:
            raise PolicyError("E_INPUT", "data must define a non-empty 'columns' list")
        names = []
        for entry in columns:
            name = entry.get("name") if isinstance(entry, dict) else entry
            if not isinstance(name, str) or not name:
                raise PolicyError("E_INPUT", f"invalid column entry {entry!r}")
            if name in names:
                raise PolicyError("E_INPUT", f"duplicate column {name!r}")
            names.append(name)
        return names

    def _load_rows(self, data):
        rows = data.get("rows", [])
        if not isinstance(rows, list):
            raise PolicyError("E_INPUT", "'rows' must be a list")
        for row in rows:
            if not isinstance(row, dict):
                raise PolicyError("E_INPUT", "each row must be an object")
            unknown = set(row) - self.schema_set
            if unknown:
                raise PolicyError(
                    "E_SCHEMA", f"row contains columns outside the schema: {sorted(unknown)}"
                )
        return rows

    def _load_sensitivity(self, policy):
        sensitivity = policy.get("sensitivity", {})
        if not isinstance(sensitivity, dict):
            raise PolicyError("E_POLICY", "'sensitivity' must be an object")
        for column, level in sensitivity.items():
            if column not in self.schema_set:
                raise PolicyError("E_SCHEMA", f"sensitivity refers to unknown column {column!r}")
            if level not in _SENSITIVITY_RANK:
                raise PolicyError("E_POLICY", f"invalid sensitivity level {level!r}")
        return sensitivity

    def _role(self, role):
        try:
            return self._roles[role]
        except KeyError:
            raise PolicyError("E_ROLE", f"unknown role {role!r}") from None

    # -- row visibility -------------------------------------------------

    def _is_visible(self, row, role_policy):
        result = True
        for row_filter in role_policy.row_filters:
            condition = expr.evaluate(row_filter.when, row, self.schema_set)
            term = condition if row_filter.effect == "allow" else expr.tri_not(condition)
            result = expr.tri_and(result, term)
            if result is False:
                break
        return result is True

    # -- column masking ---------------------------------------------------

    def _strictest_action(self, row, column, role_policy):
        strictest = "clear"
        for rule in role_policy.column_rules:
            if not rule.matches_column(column):
                continue
            if rule.when is not None:
                condition = expr.evaluate(rule.when, row, self.schema_set)
                if condition is not True:
                    continue
            if _STRICTNESS[rule.action] > _STRICTNESS[strictest]:
                strictest = rule.action
        return strictest

    @staticmethod
    def _hash_value(column, value):
        digest = hashlib.sha256(f"{column}={value!r}".encode("utf-8")).hexdigest()
        return f"sha256:{digest}"

    def _mask_row(self, row, role_policy):
        masked = {}
        dropped = set()
        for column in self.schema:
            action = self._strictest_action(row, column, role_policy)
            if action == "drop":
                dropped.add(column)
                continue
            value = row.get(column)
            if action == "hash":
                value = self._hash_value(column, value)
            elif action == "redact":
                value = REDACTED
            masked[column] = value
        return masked, dropped

    def _statically_dropped(self, column, role_policy):
        """True if an unconditional drop rule applies to this column/role."""
        return any(
            rule.action == "drop" and rule.when is None and rule.matches_column(column)
            for rule in role_policy.column_rules
        )

    # -- public API -------------------------------------------------------

    def query(self, role, sort_by=None, descending=False):
        role_policy = self._role(role)
        if sort_by is not None and sort_by not in self.schema_set:
            raise PolicyError("E_SCHEMA", f"cannot sort by unknown column {sort_by!r}")
        if sort_by is not None and self._statically_dropped(sort_by, role_policy):
            raise PolicyError(
                "E_SCHEMA", f"cannot sort by dropped column {sort_by!r}"
            )
        output = []
        dropped_columns = set()
        for row in self.rows:
            if not self._is_visible(row, role_policy):
                continue
            masked, dropped = self._mask_row(row, role_policy)
            dropped_columns |= dropped
            output.append(masked)
        if sort_by is not None:
            if sort_by in dropped_columns:
                raise PolicyError(
                    "E_SCHEMA", f"cannot sort by dropped column {sort_by!r}"
                )
            try:
                output.sort(
                    key=lambda item: (item[sort_by] is None, item[sort_by]),
                    reverse=descending,
                )
            except TypeError as exc:
                raise PolicyError("E_SORT", f"values of column {sort_by!r} are not orderable") from exc
        return output

    def count(self, role):
        """The count interface: number of visible rows, nothing else."""
        role_policy = self._role(role)
        return sum(1 for row in self.rows if self._is_visible(row, role_policy))
