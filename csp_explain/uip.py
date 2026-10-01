"""First-UIP conflict explanation generation.

The algorithm performs conflict-directed resolution on the implication graph,
exactly as in CDCL-style conflict analysis:

1. Seed the explanation clause with the premises of the conflict.
2. While the clause contains more than one literal from the current
   (conflict) decision level, resolve away the most recently implied
   current-level literal by replacing it with the antecedents of the
   implication that produced it.
3. Stop when exactly one current-level literal remains: that literal is the
   first unique implication point (1-UIP), and the remaining literals are the
   necessary and sufficient premises of the conflict.

Literals grounded at level 0 are facts of the problem and are dropped from
the clause.  The backjump level is the highest level among the remaining
non-UIP literals (0 when the clause is asserting).  A conflict that occurs
entirely at level 0 yields the empty clause with backjump level -1, proving
the problem unsatisfiable.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List

from .model import KIND_REMOVED, Literal, Model


class AnalysisError(Exception):
    """Raised when conflict analysis cannot be performed on a valid model."""


@dataclass(frozen=True)
class ClauseLiteral:
    """A literal of the explanation clause.

    The clause is the disjunction of the negations of these premises: it
    asserts that the listed assignment/removal assertions cannot all hold
    simultaneously.
    """

    variable: str
    value: Any
    kind: str
    level: int

    def key(self) -> tuple:
        return (self.kind, self.variable, self.value)

    def to_dict(self) -> dict:
        return {
            "variable": self.variable,
            "value": self.value,
            "kind": self.kind,
            "level": self.level,
        }


@dataclass
class Explanation:
    clause: List[ClauseLiteral]
    backjump_level: int
    unsatisfiable: bool

    def to_dict(self) -> dict:
        return {
            "clause": [lit.to_dict() for lit in self.clause],
            "backjump_level": self.backjump_level,
            "unsatisfiable": self.unsatisfiable,
        }


def _seed_literal(model: Model, literal) -> ClauseLiteral:
    node = model.node_for(literal)
    return ClauseLiteral(
        variable=literal.variable,
        value=literal.value,
        kind=literal.kind,
        level=node.level,
    )


def generate_explanation(model: Model) -> Explanation:
    """Generate the 1-UIP explanation clause and backjump level."""
    conflict = model.conflict
    if conflict.level == 0:
        # The conflict follows from level-0 propagation alone: the problem is
        # unsatisfiable.  Report the empty clause and backjump level -1.
        return Explanation(clause=[], backjump_level=-1, unsatisfiable=True)

    current = conflict.level
    clause: Dict[tuple, ClauseLiteral] = {}
    for ant in conflict.antecedents:
        lit = _seed_literal(model, ant)
        if lit.level > 0:
            clause[lit.key()] = lit

    if not any(lit.level == current for lit in clause.values()):
        raise AnalysisError(
            "conflict does not depend on any premise from its own decision level"
        )

    while sum(1 for lit in clause.values() if lit.level == current) > 1:
        candidates = [
            lit
            for lit in clause.values()
            if lit.level == current and lit.kind == KIND_REMOVED
        ]
        if not candidates:
            raise AnalysisError(
                "cannot reach a single UIP: no resolvable literal at the "
                "current decision level"
            )
        pivot = max(
            candidates,
            key=lambda lit: model.implication_for(_as_literal(lit)).index,
        )
        node = model.implication_for(_as_literal(pivot))
        del clause[pivot.key()]
        for ant in node.antecedents:
            lit = _seed_literal(model, ant)
            if lit.level > 0:
                clause[lit.key()] = lit

    external_levels = [lit.level for lit in clause.values() if lit.level < current]
    backjump_level = max(external_levels) if external_levels else 0
    ordered = sorted(
        clause.values(),
        key=lambda lit: (-lit.level, lit.variable, str(lit.value), lit.kind),
    )
    return Explanation(
        clause=ordered, backjump_level=backjump_level, unsatisfiable=False
    )


def _as_literal(clause_literal: ClauseLiteral) -> Literal:
    return Literal(
        variable=clause_literal.variable,
        value=clause_literal.value,
        kind=clause_literal.kind,
    )
