"""Data model and validation for conflict records.

A conflict record describes the state of a backtracking search with
implication (propagation) logging at the moment a conflict is detected:

- ``decisions``:    variables assigned by the search, each at a decision level >= 1.
- ``implications``: value removals produced by constraint propagation.  Each
                    removal records the triggering constraint and the premises
                    (antecedents) that caused it.
- ``conflict``:     the current conflict, described by the premises that
                    directly caused it (e.g. the removals that wiped out a
                    domain) and the level at which it occurred.

Every node in the implication graph corresponds to one value removal (or, for
decisions, one assignment); edges go from premises to conclusions.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Union

KIND_ASSIGNED = "assigned"
KIND_REMOVED = "removed"
_KINDS = (KIND_ASSIGNED, KIND_REMOVED)


class ValidationError(Exception):
    """Raised when a conflict record is structurally invalid."""


def _is_scalar(value: Any) -> bool:
    return value is None or isinstance(value, (str, int, float, bool))


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


@dataclass(frozen=True)
class Literal:
    """A premise: an assignment assertion or a value-removal assertion."""

    variable: str
    value: Any
    kind: str

    def key(self) -> tuple:
        return (self.kind, self.variable, self.value)

    def to_dict(self) -> dict:
        return {"variable": self.variable, "value": self.value, "kind": self.kind}


@dataclass
class Decision:
    variable: str
    value: Any
    level: int


@dataclass
class Implication:
    variable: str
    value: Any
    level: int
    constraint: Optional[str]
    antecedents: List[Literal]
    index: int  # position in the propagation log (topological order)

    def key(self) -> tuple:
        return (KIND_REMOVED, self.variable, self.value)


@dataclass
class Conflict:
    level: int
    antecedents: List[Literal]
    variable: Optional[str] = None
    constraint: Optional[str] = None


Node = Union[Decision, Implication]


@dataclass
class Model:
    decisions: List[Decision]
    implications: List[Implication]
    conflict: Conflict
    _nodes: Dict[tuple, Node] = field(default_factory=dict)

    def node_for(self, literal: Literal) -> Node:
        return self._nodes[literal.key()]

    def implication_for(self, literal: Literal) -> Implication:
        node = self._nodes[literal.key()]
        if not isinstance(node, Implication):
            raise ValidationError(
                f"literal {literal.variable}={literal.value!r} is not an implied removal"
            )
        return node


def _parse_literal(raw: Any, where: str) -> Literal:
    if not isinstance(raw, dict):
        raise ValidationError(f"{where}: antecedent must be an object, got {raw!r}")
    variable = raw.get("variable")
    if not isinstance(variable, str) or not variable:
        raise ValidationError(f"{where}: antecedent requires a non-empty 'variable' string")
    if "value" not in raw or not _is_scalar(raw["value"]):
        raise ValidationError(f"{where}: antecedent requires a scalar 'value'")
    kind = raw.get("kind")
    if kind is not None and kind not in _KINDS:
        raise ValidationError(
            f"{where}: antecedent 'kind' must be one of {_KINDS}, got {kind!r}"
        )
    return Literal(variable=variable, value=raw["value"], kind=kind)


def _parse_literal_list(raw: Any, where: str) -> List[Literal]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValidationError(f"{where}: 'antecedents' must be a list")
    return [_parse_literal(item, where) for item in raw]


def parse_model(data: Any) -> Model:
    """Parse and validate a conflict record, raising ValidationError on bad input."""
    if not isinstance(data, dict):
        raise ValidationError("top-level JSON value must be an object")

    decisions_raw = data.get("decisions", [])
    if not isinstance(decisions_raw, list):
        raise ValidationError("'decisions' must be a list")
    decisions: List[Decision] = []
    seen_decision_vars = set()
    seen_decision_levels = set()
    for pos, raw in enumerate(decisions_raw):
        where = f"decisions[{pos}]"
        if not isinstance(raw, dict):
            raise ValidationError(f"{where}: must be an object")
        variable = raw.get("variable")
        if not isinstance(variable, str) or not variable:
            raise ValidationError(f"{where}: requires a non-empty 'variable' string")
        if "value" not in raw or not _is_scalar(raw["value"]):
            raise ValidationError(f"{where}: requires a scalar 'value'")
        level = raw.get("level")
        if not _is_int(level) or level < 1:
            raise ValidationError(f"{where}: 'level' must be an integer >= 1")
        if variable in seen_decision_vars:
            raise ValidationError(f"{where}: duplicate decision for variable {variable!r}")
        if level in seen_decision_levels:
            raise ValidationError(f"{where}: duplicate decision level {level}")
        seen_decision_vars.add(variable)
        seen_decision_levels.add(level)
        decisions.append(Decision(variable=variable, value=raw["value"], level=level))

    implications_raw = data.get("implications", [])
    if not isinstance(implications_raw, list):
        raise ValidationError("'implications' must be a list")
    implications: List[Implication] = []
    seen_removals = set()
    for pos, raw in enumerate(implications_raw):
        where = f"implications[{pos}]"
        if not isinstance(raw, dict):
            raise ValidationError(f"{where}: must be an object")
        variable = raw.get("variable")
        if not isinstance(variable, str) or not variable:
            raise ValidationError(f"{where}: requires a non-empty 'variable' string")
        if "value" not in raw or not _is_scalar(raw["value"]):
            raise ValidationError(f"{where}: requires a scalar 'value'")
        level = raw.get("level")
        if not _is_int(level) or level < 0:
            raise ValidationError(f"{where}: 'level' must be an integer >= 0")
        constraint = raw.get("constraint")
        if constraint is not None and not isinstance(constraint, str):
            raise ValidationError(f"{where}: 'constraint' must be a string")
        antecedents = _parse_literal_list(raw.get("antecedents"), where)
        if level > 0 and not antecedents:
            raise ValidationError(
                f"{where}: a removal above level 0 must record at least one antecedent"
            )
        key = (variable, raw["value"])
        if key in seen_removals:
            raise ValidationError(
                f"{where}: duplicate removal of {variable}={raw['value']!r}"
            )
        seen_removals.add(key)
        implications.append(
            Implication(
                variable=variable,
                value=raw["value"],
                level=level,
                constraint=constraint,
                antecedents=antecedents,
                index=pos,
            )
        )

    if "conflict" not in data or data["conflict"] is None:
        raise ValidationError("missing conflict state: 'conflict' is required")
    raw_conflict = data["conflict"]
    if not isinstance(raw_conflict, dict):
        raise ValidationError("'conflict' must be an object")
    c_level = raw_conflict.get("level")
    if not _is_int(c_level) or c_level < 0:
        raise ValidationError("conflict: 'level' must be an integer >= 0")
    c_variable = raw_conflict.get("variable")
    if c_variable is not None and not isinstance(c_variable, str):
        raise ValidationError("conflict: 'variable' must be a string")
    c_constraint = raw_conflict.get("constraint")
    if c_constraint is not None and not isinstance(c_constraint, str):
        raise ValidationError("conflict: 'constraint' must be a string")
    c_antecedents = _parse_literal_list(raw_conflict.get("antecedents"), "conflict")
    conflict = Conflict(
        level=c_level,
        antecedents=c_antecedents,
        variable=c_variable,
        constraint=c_constraint,
    )

    model = Model(decisions=decisions, implications=implications, conflict=conflict)
    _link_and_validate(model)
    return model


def _link_and_validate(model: Model) -> None:
    nodes: Dict[tuple, Node] = {}
    decision_keys = set()
    for dec in model.decisions:
        key = (KIND_ASSIGNED, dec.variable, dec.value)
        nodes[key] = dec
        decision_keys.add(key)
    for imp in model.implications:
        if (KIND_ASSIGNED, imp.variable, imp.value) in decision_keys:
            raise ValidationError(
                f"inconsistent record: {imp.variable}={imp.value!r} is both decided and removed"
            )
        nodes[imp.key()] = imp
    model._nodes = nodes

    def resolve(literal: Literal, where: str) -> Node:
        kind = literal.kind
        if kind is None:
            assigned = nodes.get((KIND_ASSIGNED, literal.variable, literal.value))
            removed = nodes.get((KIND_REMOVED, literal.variable, literal.value))
            if assigned is not None and removed is None:
                kind = KIND_ASSIGNED
            elif removed is not None and assigned is None:
                kind = KIND_REMOVED
            else:
                raise ValidationError(
                    f"{where}: antecedent references unknown variable/value "
                    f"{literal.variable}={literal.value!r}"
                )
        key = (kind, literal.variable, literal.value)
        node = nodes.get(key)
        if node is None:
            if kind == KIND_ASSIGNED:
                raise ValidationError(
                    f"{where}: antecedent references unknown decision "
                    f"{literal.variable}={literal.value!r}"
                )
            raise ValidationError(
                f"{where}: antecedent references unknown removal "
                f"{literal.variable}={literal.value!r}"
            )
        object.__setattr__(literal, "kind", kind)
        return node

    for imp in model.implications:
        where = f"implications[{imp.index}]"
        for ant in imp.antecedents:
            node = resolve(ant, where)
            if node.level > imp.level:
                raise ValidationError(
                    f"{where}: antecedent {ant.variable}={ant.value!r} is at level "
                    f"{node.level}, above the implied removal's level {imp.level}"
                )
            if isinstance(node, Implication) and node.index >= imp.index:
                raise ValidationError(
                    f"{where}: antecedent {ant.variable}={ant.value!r} is not earlier "
                    "in the propagation log (implication graph must be acyclic)"
                )

    conflict = model.conflict
    for ant in conflict.antecedents:
        node = resolve(ant, "conflict")
        if node.level > conflict.level:
            raise ValidationError(
                f"conflict: antecedent {ant.variable}={ant.value!r} is at level "
                f"{node.level}, above the conflict level {conflict.level}"
            )
    if conflict.level > 0:
        if not any(dec.level == conflict.level for dec in model.decisions):
            raise ValidationError(
                f"conflict: no decision recorded at the conflict level {conflict.level}"
            )
