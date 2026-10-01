"""Core logical-plan optimizer for optrewrite.

Optimizes logical trees made of scans, conjunctive selections, projections
and binary inner joins:

1. Conjunctive selection predicates are pushed down through projections and
   joins as far as possible.  A predicate is never pushed through a
   projection that drops a column it references.
2. All binary join trees over the base inputs of a join skeleton are
   enumerated.  Cardinalities use the given selectivities for predicates and
   the equi-key formula |R|*|S| / max(V(R,a), V(S,b)) for join keys.  The
   cost of a plan is the sum of the cardinalities of all intermediate
   (non-scan) nodes.
3. Ties between minimum-cost plans are broken by the lexicographic order of
   the canonical plan JSON.
"""

from __future__ import annotations

import json
from fractions import Fraction


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------

class OptRewriteError(Exception):
    """Base class for expected, user-facing errors."""

    exit_code = 1

    def to_object(self):
        return {"error": "invalid_input", "message": str(self)}


class InvalidQueryError(OptRewriteError):
    exit_code = 1

    def to_object(self):
        return {"error": "invalid_query", "message": str(self)}


class UnknownColumnError(OptRewriteError):
    exit_code = 2

    def __init__(self, column):
        self.column = column
        super().__init__(f"unknown column: {column}")

    def to_object(self):
        return {"error": "unknown_column", "column": self.column}


class MissingSelectivityError(OptRewriteError):
    exit_code = 2

    def __init__(self, column):
        self.column = column
        super().__init__(f"missing selectivity for column: {column}")

    def to_object(self):
        return {"error": "missing_selectivity", "column": self.column}


# ---------------------------------------------------------------------------
# Stats
# ---------------------------------------------------------------------------

def to_fraction(value):
    if isinstance(value, Fraction):
        return value
    if isinstance(value, float):
        return Fraction(str(value))
    return Fraction(value)


class Stats:
    """Relation cardinalities, per-column NDVs and predicate selectivities."""

    def __init__(self, relations, selectivities):
        self.relations = relations
        self.selectivities = selectivities

    @classmethod
    def from_dict(cls, data):
        relations = {}
        for name, rel in data.get("relations", {}).items():
            columns = {
                col: to_fraction(info["ndv"])
                for col, info in rel.get("columns", {}).items()
            }
            relations[name] = {
                "cardinality": to_fraction(rel["cardinality"]),
                "columns": columns,
            }
        selectivities = {
            col: to_fraction(sel)
            for col, sel in data.get("selectivities", {}).items()
        }
        return cls(relations, selectivities)

    def has_relation(self, name):
        return name in self.relations

    def has_column(self, qname):
        rel, _, col = qname.rpartition(".")
        return rel in self.relations and col in self.relations[rel]["columns"]

    def ndv(self, qname):
        rel, _, col = qname.rpartition(".")
        if not self.has_column(qname):
            raise UnknownColumnError(qname)
        return self.relations[rel]["columns"][col]

    def selectivity(self, qname):
        if qname not in self.selectivities:
            raise MissingSelectivityError(qname)
        return self.selectivities[qname]


# ---------------------------------------------------------------------------
# Node helpers
# ---------------------------------------------------------------------------

def normalize_condition(cond):
    if "column" in cond:
        return {
            "column": cond["column"],
            "op": cond.get("op", "="),
            "value": cond.get("value"),
        }
    left, right = cond["left"], cond["right"]
    if right < left:
        left, right = right, left
    return {"left": left, "right": right}


def normalize_join_condition(cond):
    left, right = cond["left"], cond["right"]
    if right < left:
        left, right = right, left
    return {"left": left, "right": right}


def condition_columns(cond):
    if "column" in cond:
        return {cond["column"]}
    return {cond["left"], cond["right"]}


def join_conditions_of(node):
    if "conditions" in node:
        return [normalize_join_condition(c) for c in node["conditions"]]
    if "condition" in node:
        return [normalize_join_condition(node["condition"])]
    return []


def condition_key(cond):
    return json.dumps(cond, sort_keys=True)


def output_columns(node, stats):
    t = node["type"]
    if t == "scan":
        rel = node["relation"]
        if not stats.has_relation(rel):
            raise UnknownColumnError(rel)
        return {f"{rel}.{c}" for c in stats.relations[rel]["columns"]}
    if t == "select":
        return output_columns(node["input"], stats)
    if t == "project":
        return set(node["columns"])
    if t == "join":
        return output_columns(node["left"], stats) | output_columns(
            node["right"], stats
        )
    raise InvalidQueryError(f"unknown node type: {t}")


def validate(node, stats, scan_relations=None):
    """Check that every referenced column exists and is available."""
    if scan_relations is None:
        scan_relations = []
    t = node["type"]
    if t == "scan":
        rel = node.get("relation")
        if not stats.has_relation(rel):
            raise UnknownColumnError(rel)
        scan_relations.append(rel)
        cols = output_columns(node, stats)
    elif t == "select":
        cols = validate(node["input"], stats, scan_relations)
        # A selection may legitimately reference columns dropped by a
        # projection below it; such predicates simply cannot be pushed
        # through.  Only columns missing from the stats are unknown.
        for cond in node.get("conditions", []):
            for col in condition_columns(cond):
                if not stats.has_column(col):
                    raise UnknownColumnError(col)
    elif t == "project":
        child_cols = validate(node["input"], stats, scan_relations)
        for col in node["columns"]:
            if not stats.has_column(col) or col not in child_cols:
                raise UnknownColumnError(col)
        cols = set(node["columns"])
    elif t == "join":
        left_cols = validate(node["left"], stats, scan_relations)
        right_cols = validate(node["right"], stats, scan_relations)
        available = left_cols | right_cols
        for cond in join_conditions_of(node):
            for col in (cond["left"], cond["right"]):
                if not stats.has_column(col) or col not in available:
                    raise UnknownColumnError(col)
        cols = available
    else:
        raise InvalidQueryError(f"unknown node type: {t}")
    if len(scan_relations) != len(set(scan_relations)):
        raise InvalidQueryError(
            "self joins are not supported: relation names must be unique"
        )
    return cols


# ---------------------------------------------------------------------------
# Selection pushdown
# ---------------------------------------------------------------------------

def pushdown(node, stats):
    t = node["type"]
    if t == "scan":
        return node
    if t == "project":
        return {
            "type": "project",
            "columns": list(node["columns"]),
            "input": pushdown(node["input"], stats),
        }
    if t == "select":
        conds = [normalize_condition(c) for c in node.get("conditions", [])]
        child = pushdown(node["input"], stats)
        return push_select(conds, child, stats)
    if t == "join":
        return {
            "type": "join",
            "conditions": join_conditions_of(node),
            "left": pushdown(node["left"], stats),
            "right": pushdown(node["right"], stats),
        }
    raise InvalidQueryError(f"unknown node type: {t}")


def push_select(conds, child, stats):
    if not conds:
        return child
    t = child["type"]
    if t == "scan":
        return {"type": "select", "conditions": conds, "input": child}
    if t == "select":
        return push_select(conds + child["conditions"], child["input"], stats)
    if t == "project":
        kept = set(child["columns"])
        push = [c for c in conds if condition_columns(c) <= kept]
        stay = [c for c in conds if not condition_columns(c) <= kept]
        proj = {
            "type": "project",
            "columns": child["columns"],
            "input": push_select(push, child["input"], stats),
        }
        if stay:
            return {"type": "select", "conditions": stay, "input": proj}
        return proj
    if t == "join":
        left_cols = output_columns(child["left"], stats)
        right_cols = output_columns(child["right"], stats)
        join_conds = list(child["conditions"])
        left_conds, right_conds, stay = [], [], []
        for cond in conds:
            cols = condition_columns(cond)
            if cols <= left_cols:
                left_conds.append(cond)
            elif cols <= right_cols:
                right_conds.append(cond)
            elif len(cols) == 2 and cols <= (left_cols | right_cols):
                join_conds.append(normalize_join_condition(cond))
            else:
                stay.append(cond)
        join = {
            "type": "join",
            "conditions": join_conds,
            "left": push_select(left_conds, child["left"], stats),
            "right": push_select(right_conds, child["right"], stats),
        }
        if stay:
            return {"type": "select", "conditions": stay, "input": join}
        return join
    raise InvalidQueryError(f"unknown node type: {t}")


# ---------------------------------------------------------------------------
# Canonical form
# ---------------------------------------------------------------------------

def canonicalize(node):
    t = node["type"]
    if t == "scan":
        return {"type": "scan", "relation": node["relation"]}
    if t == "select":
        conds = sorted(
            (normalize_condition(c) for c in node["conditions"]),
            key=condition_key,
        )
        child = canonicalize(node["input"])
        if not conds:
            return child
        return {"type": "select", "conditions": conds, "input": child}
    if t == "project":
        return {
            "type": "project",
            "columns": list(node["columns"]),
            "input": canonicalize(node["input"]),
        }
    if t == "join":
        left = canonicalize(node["left"])
        right = canonicalize(node["right"])
        if canonical_json(right) < canonical_json(left):
            left, right = right, left
        conds = sorted(
            (normalize_join_condition(c) for c in join_conditions_of(node)),
            key=condition_key,
        )
        return {
            "type": "join",
            "conditions": conds,
            "left": left,
            "right": right,
        }
    raise InvalidQueryError(f"unknown node type: {t}")


def canonical_json(node):
    return json.dumps(node, sort_keys=True, separators=(",", ":"))


# ---------------------------------------------------------------------------
# Cardinality and cost
# ---------------------------------------------------------------------------

def condition_selectivity(cond, stats):
    if "column" in cond:
        return stats.selectivity(cond["column"])
    left, right = cond["left"], cond["right"]
    return Fraction(1) / max(stats.ndv(left), stats.ndv(right))


def cardinality(node, stats):
    t = node["type"]
    if t == "scan":
        return stats.relations[node["relation"]]["cardinality"]
    if t == "select":
        card = cardinality(node["input"], stats)
        for cond in node["conditions"]:
            card *= condition_selectivity(cond, stats)
        return card
    if t == "project":
        return cardinality(node["input"], stats)
    if t == "join":
        card = cardinality(node["left"], stats) * cardinality(
            node["right"], stats
        )
        for cond in join_conditions_of(node):
            card *= Fraction(1) / max(
                stats.ndv(cond["left"]), stats.ndv(cond["right"])
            )
        return card
    raise InvalidQueryError(f"unknown node type: {t}")


def plan_cost(node, stats):
    """Sum of the cardinalities of all intermediate (non-scan) nodes."""
    t = node["type"]
    if t == "scan":
        return Fraction(0)
    if t in ("select", "project"):
        return cardinality(node, stats) + plan_cost(node["input"], stats)
    if t == "join":
        return (
            cardinality(node, stats)
            + plan_cost(node["left"], stats)
            + plan_cost(node["right"], stats)
        )
    raise InvalidQueryError(f"unknown node type: {t}")


# ---------------------------------------------------------------------------
# Join-order enumeration
# ---------------------------------------------------------------------------

def flatten_join_skeleton(node, leaves, predicates):
    if node["type"] == "join":
        flatten_join_skeleton(node["left"], leaves, predicates)
        flatten_join_skeleton(node["right"], leaves, predicates)
        predicates.extend(join_conditions_of(node))
    else:
        leaves.append(node)


def best_join_tree(leaves, predicates, stats):
    """Enumerate all binary join trees over leaves; return the best one.

    Cost of a skeleton is the sum of join-node cardinalities.  Ties are
    broken by the lexicographic order of the canonical plan JSON.
    """
    n = len(leaves)
    if n == 1:
        return leaves[0]

    leaves = [canonicalize(leaf) for leaf in leaves]
    leaf_cols = [output_columns(leaf, stats) for leaf in leaves]
    col_to_leaf = {}
    for i, cols in enumerate(leaf_cols):
        for col in cols:
            col_to_leaf[col] = i

    preds = []
    for cond in predicates:
        cond = normalize_join_condition(cond)
        i, j = col_to_leaf[cond["left"]], col_to_leaf[cond["right"]]
        factor = Fraction(1) / max(
            stats.ndv(cond["left"]), stats.ndv(cond["right"])
        )
        preds.append((i, j, cond, factor))

    leaf_card = [cardinality(leaf, stats) for leaf in leaves]
    full = (1 << n) - 1

    card = [Fraction(0)] * (full + 1)
    for mask in range(1, full + 1):
        c = Fraction(1)
        for i in range(n):
            if mask >> i & 1:
                c *= leaf_card[i]
        for i, j, _cond, factor in preds:
            if (mask >> i & 1) and (mask >> j & 1):
                c *= factor
        card[mask] = c

    cost = [None] * (full + 1)
    plans = [None] * (full + 1)
    for i in range(n):
        mask = 1 << i
        cost[mask] = Fraction(0)
        plans[mask] = {canonical_json(leaves[i]): leaves[i]}

    masks_by_size = [[] for _ in range(n + 1)]
    for mask in range(1, full + 1):
        masks_by_size[bin(mask).count("1")].append(mask)

    for size in range(2, n + 1):
        for mask in masks_by_size[size]:
            best_cost = None
            best_plans = {}
            sub = (mask - 1) & mask
            while sub:
                other = mask ^ sub
                if sub < other:
                    crossing = [
                        cond
                        for i, j, cond, _f in preds
                        if ((mask >> i & 1) and (mask >> j & 1))
                        and ((sub >> i & 1) != (sub >> j & 1))
                    ]
                    crossing = sorted(crossing, key=condition_key)
                    for j1, n1 in plans[sub].items():
                        for j2, n2 in plans[other].items():
                            if j2 < j1:
                                left, right = n2, n1
                            else:
                                left, right = n1, n2
                            node = {
                                "type": "join",
                                "conditions": crossing,
                                "left": left,
                                "right": right,
                            }
                            c = cost[sub] + cost[other] + card[mask]
                            key = canonical_json(node)
                            if best_cost is None or c < best_cost:
                                best_cost = c
                                best_plans = {key: node}
                            elif c == best_cost:
                                best_plans[key] = node
                sub = (sub - 1) & mask
            cost[mask] = best_cost
            plans[mask] = best_plans

    return plans[full][min(plans[full])]


def reorder_joins(node, stats):
    t = node["type"]
    if t in ("select", "project"):
        return {**node, "input": reorder_joins(node["input"], stats)}
    if t == "join":
        left = reorder_joins(node["left"], stats)
        right = reorder_joins(node["right"], stats)
        rebuilt = {
            "type": "join",
            "conditions": join_conditions_of(node),
            "left": left,
            "right": right,
        }
        leaves, predicates = [], []
        flatten_join_skeleton(rebuilt, leaves, predicates)
        return best_join_tree(leaves, predicates, stats)
    return node


# ---------------------------------------------------------------------------
# Top-level driver
# ---------------------------------------------------------------------------

def optimize(query, stats):
    """Return (canonical_plan, cost) for the optimal rewritten plan."""
    validate(query, stats)
    pushed = pushdown(query, stats)
    reordered = reorder_joins(pushed, stats)
    plan = canonicalize(reordered)
    return plan, plan_cost(plan, stats)


def number(value):
    """Serialize a Fraction as int when integral, else float."""
    if isinstance(value, Fraction):
        if value.denominator == 1:
            return value.numerator
        return float(value)
    return value
