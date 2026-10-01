"""Logical plan optimizer.

Optimizes logical plans built from relations, conjunctive selections,
projections and binary inner joins:

1. Conjunctive selection conditions are pushed down through projections
   and joins as far as possible.  A condition is never pushed through a
   projection that drops one of the columns it references.
2. For every maximal group of joins, all binary join trees are enumerated.
   The cardinality of an equi-join on keys ``R.a = S.b`` is estimated as
   ``|R| * |S| / max(NDV(R.a), NDV(S.b))``; equality predicates on constants
   use the selectivities given in the statistics.  The cost of a plan is the
   sum of the cardinalities of all of its intermediate (non-relation) nodes.
3. Ties between plans of equal cost are broken by choosing the plan whose
   canonical JSON serialization is lexicographically smallest.
"""

from __future__ import annotations

import json
from itertools import permutations


class UnknownColumnError(Exception):
    """A referenced column does not exist in the query or statistics."""

    def __init__(self, column):
        super().__init__(f"unknown column: {column}")
        self.column = column


class UnknownRelationError(Exception):
    """A referenced relation does not exist in the statistics."""

    def __init__(self, relation):
        super().__init__(f"unknown relation: {relation}")
        self.relation = relation


class MalformedQueryError(Exception):
    """The query or statistics document is structurally invalid."""


# ---------------------------------------------------------------------------
# Statistics
# ---------------------------------------------------------------------------

class RelationStats:
    def __init__(self, cardinality, ndv):
        self.cardinality = cardinality
        self.ndv = ndv  # column name -> number of distinct values


class Stats:
    def __init__(self, relations, selectivities):
        self.relations = relations          # relation name -> RelationStats
        self.selectivities = selectivities  # "R.a" -> selectivity of "=" on a constant

    @classmethod
    def from_json(cls, data):
        try:
            relations = {}
            for name, rel in data["relations"].items():
                relations[name] = RelationStats(
                    cardinality=float(rel["cardinality"]),
                    ndv={col: float(v) for col, v in rel["columns"].items()},
                )
            selectivities = {
                col: float(sel) for col, sel in data.get("selectivities", {}).items()
            }
        except (KeyError, TypeError, ValueError, AttributeError) as exc:
            raise MalformedQueryError(f"invalid statistics: {exc}") from exc
        return cls(relations, selectivities)


# ---------------------------------------------------------------------------
# Conditions
# ---------------------------------------------------------------------------

def _validate_condition(cond):
    if not isinstance(cond, dict):
        raise MalformedQueryError("condition must be an object")
    if not isinstance(cond.get("left"), str):
        raise MalformedQueryError("condition 'left' must be a column name")
    if cond.get("op") != "=":
        raise MalformedQueryError("only '=' conditions are supported")
    right = cond.get("right")
    if not isinstance(right, dict) or ("const" in right) == ("col" in right):
        raise MalformedQueryError(
            "condition 'right' must contain exactly one of 'const' or 'col'"
        )
    if "col" in right and not isinstance(right["col"], str):
        raise MalformedQueryError("condition 'right.col' must be a column name")


def _condition_columns(cond):
    columns = {cond["left"]}
    right = cond["right"]
    if "col" in right:
        columns.add(right["col"])
    return columns


def _sort_conditions(conditions):
    return sorted(conditions, key=_canonical_json)


def _canonical_json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def _ndv_of(qualified_column, stats):
    relation, column = qualified_column.split(".", 1)
    return stats.relations[relation].ndv[column]


def _condition_selectivity(cond, stats):
    right = cond["right"]
    if "const" in right:
        return stats.selectivities.get(cond["left"], 1.0)
    left_ndv = _ndv_of(cond["left"], stats)
    right_ndv = _ndv_of(right["col"], stats)
    return 1.0 / max(left_ndv, right_ndv)


# ---------------------------------------------------------------------------
# Schemas and validation
# ---------------------------------------------------------------------------

def _node_schema(node, stats):
    node_type = node["type"]
    if node_type == "relation":
        name = node["name"]
        if name not in stats.relations:
            raise UnknownRelationError(name)
        return [f"{name}.{col}" for col in stats.relations[name].ndv]
    if node_type == "select":
        return _node_schema(node["input"], stats)
    if node_type == "project":
        return list(node["columns"])
    if node_type == "join":
        return _node_schema(node["left"], stats) + _node_schema(node["right"], stats)
    raise MalformedQueryError(f"unknown node type: {node_type}")


def _validate_structure(node, stats, relations):
    if not isinstance(node, dict) or "type" not in node:
        raise MalformedQueryError("plan node must be an object with a 'type'")
    node_type = node["type"]
    if node_type == "relation":
        name = node.get("name")
        if not isinstance(name, str):
            raise MalformedQueryError("relation node requires a 'name'")
        if name not in stats.relations:
            raise UnknownRelationError(name)
        relations.append(name)
    elif node_type == "select":
        conditions = node.get("conditions")
        if not isinstance(conditions, list):
            raise MalformedQueryError("select node requires a 'conditions' list")
        for cond in conditions:
            _validate_condition(cond)
        _validate_structure(node.get("input"), stats, relations)
    elif node_type == "project":
        columns = node.get("columns")
        if not isinstance(columns, list) or not all(
            isinstance(col, str) for col in columns
        ):
            raise MalformedQueryError("project node requires a 'columns' list of names")
        _validate_structure(node.get("input"), stats, relations)
    elif node_type == "join":
        _validate_structure(node.get("left"), stats, relations)
        _validate_structure(node.get("right"), stats, relations)
    else:
        raise MalformedQueryError(f"unknown node type: {node_type}")


def _referenced_columns(node):
    node_type = node["type"]
    if node_type == "relation":
        return
    if node_type == "select":
        for cond in node["conditions"]:
            yield from _condition_columns(cond)
        yield from _referenced_columns(node["input"])
    elif node_type == "project":
        yield from node["columns"]
        yield from _referenced_columns(node["input"])
    elif node_type == "join":
        yield from _referenced_columns(node["left"])
        yield from _referenced_columns(node["right"])


def _validate_projections(node, stats):
    node_type = node["type"]
    if node_type == "project":
        input_schema = set(_node_schema(node["input"], stats))
        for col in node["columns"]:
            if col not in input_schema:
                raise UnknownColumnError(col)
    for child_key in ("input", "left", "right"):
        if child_key in node:
            _validate_projections(node[child_key], stats)


def validate(query, stats):
    relations = []
    _validate_structure(query, stats, relations)
    if len(set(relations)) != len(relations):
        raise MalformedQueryError(
            "duplicate relation names; self joins are not supported"
        )
    known_columns = set()
    for relation in relations:
        for col in stats.relations[relation].ndv:
            known_columns.add(f"{relation}.{col}")
    for col in _referenced_columns(query):
        if "." not in col:
            raise MalformedQueryError(f"unqualified column reference: {col}")
        if col not in known_columns:
            raise UnknownColumnError(col)
    _validate_projections(query, stats)


# ---------------------------------------------------------------------------
# Optimization
# ---------------------------------------------------------------------------

def optimize(node, stats, pending):
    """Optimize ``node`` with ``pending`` conditions pushed in from above.

    Returns ``(plan, cardinality, cost)`` where ``cost`` is the sum of the
    cardinalities of all intermediate (non-relation) nodes of ``plan``.
    """
    node_type = node["type"]
    if node_type == "select":
        return optimize(node["input"], stats, pending + list(node["conditions"]))
    if node_type == "relation":
        return _optimize_relation(node, stats, pending)
    if node_type == "project":
        return _optimize_project(node, stats, pending)
    if node_type == "join":
        return _optimize_join_group(node, stats, pending)
    raise MalformedQueryError(f"unknown node type: {node_type}")


def _optimize_relation(node, stats, pending):
    name = node["name"]
    rel_stats = stats.relations[name]
    schema = {f"{name}.{col}" for col in rel_stats.ndv}
    local = [cond for cond in pending if _condition_columns(cond) <= schema]
    if len(local) != len(pending):
        raise MalformedQueryError("condition cannot be evaluated at relation")
    card = rel_stats.cardinality
    for cond in local:
        card *= _condition_selectivity(cond, stats)
    plan = {"type": "relation", "name": name}
    cost = 0.0
    if local:
        plan = {"type": "select", "conditions": _sort_conditions(local), "input": plan}
        cost += card
    return plan, card, cost


def _optimize_project(node, stats, pending):
    columns = list(node["columns"])
    kept = set(columns)
    pushed = [cond for cond in pending if _condition_columns(cond) <= kept]
    retained = [cond for cond in pending if not _condition_columns(cond) <= kept]
    inner, card, cost = optimize(node["input"], stats, pushed)
    plan = {"type": "project", "columns": columns, "input": inner}
    cost += card
    if retained:
        for cond in retained:
            card *= _condition_selectivity(cond, stats)
        plan = {
            "type": "select",
            "conditions": _sort_conditions(retained),
            "input": plan,
        }
        cost += card
    return plan, card, cost


def _optimize_join_group(node, stats, pending):
    leaves = []      # (subtree, [conditions pushed into it])
    predicates = []  # equi-conditions spanning two leaves of the group

    def collect(current, conditions):
        if current["type"] == "join":
            left_schema = set(_node_schema(current["left"], stats))
            right_schema = set(_node_schema(current["right"], stats))
            left_conds, right_conds, join_conds = [], [], []
            for cond in conditions:
                cols = _condition_columns(cond)
                if cols <= left_schema:
                    left_conds.append(cond)
                elif cols <= right_schema:
                    right_conds.append(cond)
                else:
                    join_conds.append(cond)
            collect(current["left"], left_conds)
            collect(current["right"], right_conds)
            predicates.extend(join_conds)
        else:
            leaves.append((current, conditions))

    collect(node, pending)

    leaf_plans, leaf_cards, leaf_costs = [], [], []
    column_owner = {}
    for index, (subtree, conditions) in enumerate(leaves):
        plan, card, cost = optimize(subtree, stats, conditions)
        leaf_plans.append(plan)
        leaf_cards.append(card)
        leaf_costs.append(cost)
        for col in _node_schema(subtree, stats):
            column_owner[col] = index

    pred_terms = []
    for cond in predicates:
        try:
            endpoints = tuple(sorted(column_owner[col]
                                     for col in _condition_columns(cond)))
        except KeyError as exc:
            raise MalformedQueryError(
                f"join predicate column not available in join inputs: {exc}"
            ) from exc
        if len(endpoints) != 2 or endpoints[0] == endpoints[1]:
            raise MalformedQueryError("join predicate does not span two inputs")
        pred_terms.append((endpoints, cond))

    best_key = None
    best_tree = None
    best_card = None
    for order in permutations(range(len(leaves))):
        for tree in _ordered_trees(list(order)):
            card, cost = _evaluate_tree(
                tree, leaf_cards, leaf_costs, pred_terms, stats
            )
            key = (cost, _canonical_json(_build_join_plan(
                tree, leaf_plans, pred_terms
            )))
            if best_key is None or key < best_key:
                best_key = key
                best_tree = tree
                best_card = card
    plan = _build_join_plan(best_tree, leaf_plans, pred_terms)
    return plan, best_card, best_key[0]


def _ordered_trees(items):
    """Yield every binary tree whose in-order leaves equal ``items``."""
    if len(items) == 1:
        yield items[0]
        return
    for split in range(1, len(items)):
        for left in _ordered_trees(items[:split]):
            for right in _ordered_trees(items[split:]):
                yield (left, right)


def _tree_leaves(tree):
    if isinstance(tree, int):
        return {tree}
    return _tree_leaves(tree[0]) | _tree_leaves(tree[1])


def _split_predicates(tree, pred_terms):
    left_leaves = _tree_leaves(tree[0])
    right_leaves = _tree_leaves(tree[1])
    return [
        cond for (i, j), cond in pred_terms
        if (i in left_leaves and j in right_leaves)
        or (j in left_leaves and i in right_leaves)
    ]


def _evaluate_tree(tree, leaf_cards, leaf_costs, pred_terms, stats):
    if isinstance(tree, int):
        return leaf_cards[tree], leaf_costs[tree]
    left_card, left_cost = _evaluate_tree(
        tree[0], leaf_cards, leaf_costs, pred_terms, stats
    )
    right_card, right_cost = _evaluate_tree(
        tree[1], leaf_cards, leaf_costs, pred_terms, stats
    )
    card = left_card * right_card
    for cond in _split_predicates(tree, pred_terms):
        card *= _condition_selectivity(cond, stats)
    return card, left_cost + right_cost + card


def _build_join_plan(tree, leaf_plans, pred_terms):
    if isinstance(tree, int):
        return leaf_plans[tree]
    return {
        "type": "join",
        "predicates": _sort_conditions(_split_predicates(tree, pred_terms)),
        "left": _build_join_plan(tree[0], leaf_plans, pred_terms),
        "right": _build_join_plan(tree[1], leaf_plans, pred_terms),
    }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def _normalize_number(value):
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def optimize_query(query, stats_data):
    """Validate and optimize ``query``; return ``{"cost": ..., "plan": ...}``."""
    stats = Stats.from_json(stats_data)
    validate(query, stats)
    plan, _card, cost = optimize(query, stats, [])
    return {"cost": _normalize_number(cost), "plan": plan}
