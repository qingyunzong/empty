"""Conflict explanation via first-UIP clause generation.

The input describes a backtracking search state:

- ``variables``:  list of variable names.
- ``decisions``:  list of ``{"variable", "value", "level"}`` (level >= 1).
- ``implications``: list of value-removal records, in propagation order::

      {"id", "variable", "removed_value", "level", "constraint",
       "antecedents": [<ref>, ...]}

  A reference is either another implication id or ``"decision:<var>"``.
- ``conflict``: ``{"constraint", "antecedents": [<ref>, ...]}``.

Every node of the implication graph is a value removal (an implication);
edges run from antecedents to the removal they triggered.  Decisions are
root nodes.  The conflict is a sink node whose antecedents are the
removals/assignments that made some constraint inconsistent.

The 1-UIP scheme resolves the conflict clause against antecedent records
until exactly one literal from the current decision level remains.  The
backjump level is the highest level in the clause below the conflict
level (0 for a unit clause, -1 for the empty clause derived from a
level-0 conflict, meaning the problem is unsatisfiable).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

# A literal identifies one node of the implication graph:
#   ("decision", <variable>)    - an assignment assertion
#   ("implication", <id>)       - a value-removal assertion
Literal = Tuple[str, str]

DECISION_PREFIX = "decision:"


class ExplainError(Exception):
    """Raised for malformed or inconsistent input records."""


@dataclass(frozen=True)
class Decision:
    variable: str
    value: Any
    level: int


@dataclass(frozen=True)
class Implication:
    ident: str
    variable: str
    removed_value: Any
    level: int
    constraint: Any
    antecedents: Tuple[Literal, ...]
    order: int


class Model:
    def __init__(
        self,
        variables: List[str],
        decisions: Dict[str, Decision],
        implications: Dict[str, Implication],
        conflict_constraint: Any,
        conflict_antecedents: List[Literal],
    ) -> None:
        self.variables = variables
        self.decisions = decisions
        self.implications = implications
        self.conflict_constraint = conflict_constraint
        self.conflict_antecedents = conflict_antecedents

    def level_of(self, lit: Literal) -> int:
        kind, key = lit
        if kind == "decision":
            return self.decisions[key].level
        return self.implications[key].level

    def order_of(self, lit: Literal) -> int:
        kind, key = lit
        if kind == "decision":
            return -1
        return self.implications[key].order

    def antecedents_of(self, lit: Literal) -> Tuple[Literal, ...]:
        kind, key = lit
        if kind == "decision":
            return ()
        return self.implications[key].antecedents


def _require(cond: bool, message: str) -> None:
    if not cond:
        raise ExplainError(message)


def _resolve_ref(
    ref: Any,
    decisions: Dict[str, Decision],
    implications: Dict[str, Implication],
) -> Literal:
    _require(isinstance(ref, str), f"antecedent reference must be a string, got {ref!r}")
    if ref.startswith(DECISION_PREFIX):
        var = ref[len(DECISION_PREFIX):]
        _require(
            var in decisions,
            f"antecedent references unknown decision variable {var!r}",
        )
        return ("decision", var)
    _require(ref in implications, f"antecedent references unknown implication {ref!r}")
    return ("implication", ref)


def load_model(data: Any) -> Model:
    """Parse and validate the JSON record, raising ExplainError if broken."""
    _require(isinstance(data, dict), "top-level record must be a JSON object")

    variables = data.get("variables")
    _require(
        isinstance(variables, list) and all(isinstance(v, str) for v in variables),
        "'variables' must be a list of variable names",
    )
    _require(len(set(variables)) == len(variables), "duplicate variable names")
    var_set = set(variables)

    decisions: Dict[str, Decision] = {}
    for entry in data.get("decisions", []):
        _require(isinstance(entry, dict), "decision entries must be objects")
        var = entry.get("variable")
        _require(var in var_set, f"decision references unknown variable {var!r}")
        _require(var not in decisions, f"duplicate decision for variable {var!r}")
        level = entry.get("level")
        _require(
            isinstance(level, int) and not isinstance(level, bool) and level >= 1,
            f"decision for {var!r} must have an integer level >= 1",
        )
        _require("value" in entry, f"decision for {var!r} is missing 'value'")
        decisions[var] = Decision(variable=var, value=entry["value"], level=level)

    implications: Dict[str, Implication] = {}
    raw_implications = data.get("implications", [])
    _require(isinstance(raw_implications, list), "'implications' must be a list")
    for order, entry in enumerate(raw_implications):
        _require(isinstance(entry, dict), "implication entries must be objects")
        ident = entry.get("id")
        _require(isinstance(ident, str) and ident, "implication is missing a string 'id'")
        _require(
            not ident.startswith(DECISION_PREFIX),
            f"implication id {ident!r} clashes with decision reference syntax",
        )
        _require(ident not in implications, f"duplicate implication id {ident!r}")
        var = entry.get("variable")
        _require(
            var in var_set,
            f"implication {ident!r} references unknown variable {var!r}",
        )
        _require(
            "removed_value" in entry,
            f"implication {ident!r} is missing 'removed_value'",
        )
        level = entry.get("level")
        _require(
            isinstance(level, int) and not isinstance(level, bool) and level >= 0,
            f"implication {ident!r} must have an integer level >= 0",
        )
        raw_ants = entry.get("antecedents", [])
        _require(
            isinstance(raw_ants, list),
            f"implication {ident!r} has a non-list 'antecedents'",
        )
        antecedents: List[Literal] = []
        for ref in raw_ants:
            lit = _resolve_ref(ref, decisions, implications)
            if lit not in antecedents:
                antecedents.append(lit)
        expected_level = max(
            (
                decisions[lit[1]].level
                if lit[0] == "decision"
                else implications[lit[1]].level
                for lit in antecedents
            ),
            default=0,
        )
        _require(
            level == expected_level,
            f"implication {ident!r} has level {level} but its antecedents imply "
            f"level {expected_level}",
        )
        implications[ident] = Implication(
            ident=ident,
            variable=var,
            removed_value=entry["removed_value"],
            level=level,
            constraint=entry.get("constraint"),
            antecedents=tuple(antecedents),
            order=order,
        )

    conflict = data.get("conflict")
    _require(
        isinstance(conflict, dict),
        "conflict state does not exist or is not an object",
    )
    raw_conf_ants = conflict.get("antecedents")
    _require(
        isinstance(raw_conf_ants, list),
        "conflict record must contain an 'antecedents' list",
    )
    conflict_antecedents: List[Literal] = []
    for ref in raw_conf_ants:
        lit = _resolve_ref(ref, decisions, implications)
        if lit not in conflict_antecedents:
            conflict_antecedents.append(lit)

    return Model(
        variables=list(variables),
        decisions=decisions,
        implications=implications,
        conflict_constraint=conflict.get("constraint"),
        conflict_antecedents=conflict_antecedents,
    )


def _reason_covered(model: Model, lit: Literal, clause: set, memo: dict) -> bool:
    """True if `lit` is in the clause or fully explained by covered nodes."""
    if lit in clause:
        return True
    antecedents = model.antecedents_of(lit)
    if not antecedents:
        return False
    if lit in memo:
        return memo[lit]
    memo[lit] = False
    covered = all(_reason_covered(model, ant, clause, memo) for ant in antecedents)
    memo[lit] = covered
    return covered


def _minimize(model: Model, clause: set, uip: Literal) -> set:
    """Drop literals whose antecedents are all covered by the clause.

    Keeps only necessary premises: a literal is redundant when every one
    of its antecedents is itself in the clause or recursively redundant.
    """
    memo: dict = {}
    return {
        lit
        for lit in clause
        if lit == uip
        or not model.antecedents_of(lit)
        or not all(
            _reason_covered(model, ant, clause, memo)
            for ant in model.antecedents_of(lit)
        )
    }


def analyze_literals(model: Model) -> Tuple[List[Literal], int]:
    """Run 1-UIP resolution; return (clause literals, backjump level).

    The empty clause with backjump level -1 signals unsatisfiability
    (the conflict follows from level-0 propagation alone).
    """
    current_level = max(
        (model.level_of(lit) for lit in model.conflict_antecedents), default=0
    )
    if current_level == 0:
        return [], -1

    clause = set(model.conflict_antecedents)
    while True:
        at_current = [lit for lit in clause if model.level_of(lit) == current_level]
        if len(at_current) <= 1:
            break
        lit = max(at_current, key=model.order_of)
        if lit[0] == "decision":
            raise ExplainError(
                "implication graph is inconsistent: cannot resolve past the "
                f"decision of variable {lit[1]!r}"
            )
        clause.discard(lit)
        clause.update(model.implications[lit[1]].antecedents)

    uip = next(iter(at_current))
    clause = _minimize(model, clause, uip)

    lower_levels = [
        model.level_of(lit) for lit in clause if model.level_of(lit) < current_level
    ]
    backjump_level = max(lower_levels) if lower_levels else 0
    return sorted(clause, key=lambda l: (model.level_of(l), l[1], l[0])), backjump_level

def _literal_to_json(model: Model, lit: Literal) -> Dict[str, Any]:
    kind, key = lit
    if kind == "decision":
        dec = model.decisions[key]
        return {
            "kind": "assignment",
            "variable": dec.variable,
            "value": dec.value,
            "level": dec.level,
        }
    imp = model.implications[key]
    return {
        "kind": "removal",
        "variable": imp.variable,
        "value": imp.removed_value,
        "level": imp.level,
        "constraint": imp.constraint,
    }


def analyze(model: Model) -> Dict[str, Any]:
    """Produce the JSON-serializable explanation result."""
    clause, backjump_level = analyze_literals(model)
    result: Dict[str, Any] = {
        "clause": [_literal_to_json(model, lit) for lit in clause],
        "backjump_level": backjump_level,
    }
    if backjump_level < 0:
        result["status"] = "unsat"
    else:
        result["status"] = "backjump"
    return result


def load_and_explain(path: str) -> Dict[str, Any]:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except OSError as exc:
        raise ExplainError(f"cannot read input file: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise ExplainError(f"input is not valid JSON: {exc}") from exc
    return analyze(load_model(data))
