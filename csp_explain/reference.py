"""Naive reference implementation of 1-UIP explanation generation.

This module enumerates every cut of the implication graph that separates the
source nodes (decisions and level-0 facts) from the conflict node, derives
the explanation clause induced by each cut, keeps exactly the cuts whose
clause contains a single literal from the conflict level (the 1-UIP cuts),
and selects the cut closest to the conflict (smallest conflict side), which
corresponds to the first UIP.

It is exponentially slow and only meant as an independent cross-check for
the resolver-based implementation in :mod:`csp_explain.uip`.
"""
from __future__ import annotations

from itertools import combinations
from typing import Dict, List, Optional, Tuple

from .model import Decision, Implication, Model
from .uip import ClauseLiteral, Explanation


def _node_key(node) -> tuple:
    if isinstance(node, Decision):
        return ("assigned", node.variable, node.value)
    return node.key()


def enumerate_first_uip(model: Model) -> Explanation:
    """Compute the first-UIP explanation by brute-force cut enumeration."""
    conflict = model.conflict
    if conflict.level == 0:
        return Explanation(clause=[], backjump_level=-1, unsatisfiable=True)
    current = conflict.level

    nodes: List = list(model.decisions) + list(model.implications)
    movable = [imp for imp in model.implications if imp.level > 0]

    # Antecedent keys for every node that may sit on the conflict side.
    antecedent_keys: Dict[tuple, List[tuple]] = {
        imp.key(): [ant.key() for ant in imp.antecedents] for imp in movable
    }
    conflict_ante_keys = [ant.key() for ant in conflict.antecedents]

    best: Optional[Tuple[int, tuple, frozenset]] = None
    for size in range(len(movable) + 1):
        for subset in combinations(movable, size):
            t_keys = {imp.key() for imp in subset}
            premise_keys = set(conflict_ante_keys)
            for imp in subset:
                premise_keys.update(antecedent_keys[imp.key()])
            clause = set()
            for node in nodes:
                key = _node_key(node)
                if key in t_keys or key not in premise_keys:
                    continue
                if node.level > 0:
                    clause.add(
                        ClauseLiteral(
                            variable=node.variable,
                            value=node.value,
                            kind=key[0],
                            level=node.level,
                        )
                    )
            if sum(1 for lit in clause if lit.level == current) != 1:
                continue
            frozen = frozenset(clause)
            order = tuple(
                sorted((lit.level, lit.variable, str(lit.value), lit.kind) for lit in clause)
            )
            candidate = (len(t_keys), order, frozen)
            if best is None or candidate < best:
                best = candidate

    if best is None:
        return Explanation(clause=[], backjump_level=-1, unsatisfiable=True)

    clause = sorted(
        best[2],
        key=lambda lit: (-lit.level, lit.variable, str(lit.value), lit.kind),
    )
    external_levels = [lit.level for lit in clause if lit.level < current]
    backjump_level = max(external_levels) if external_levels else 0
    return Explanation(
        clause=clause, backjump_level=backjump_level, unsatisfiable=False
    )
