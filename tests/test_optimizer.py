"""Tests for optrewrite.

The join-order tests brute-force every binary tree independently of the
optimizer's own enumeration and compare the resulting minimum cost.
"""

import json
import math
import subprocess
import sys
import tempfile
import unittest
from itertools import permutations
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from optrewrite import UnknownColumnError, optimize_query  # noqa: E402


# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------

def select(conditions, input_node):
    return {"type": "select", "conditions": conditions, "input": input_node}


def project(columns, input_node):
    return {"type": "project", "columns": columns, "input": input_node}


def join(left, right):
    return {"type": "join", "left": left, "right": right}


def relation(name):
    return {"type": "relation", "name": name}


def eq_const(column, value):
    return {"left": column, "op": "=", "right": {"const": value}}


def eq_col(left, right):
    return {"left": left, "op": "=", "right": {"col": right}}


# Query used by several tests: select over join(R, S).
PUSHDOWN_STATS = {
    "relations": {
        "R": {"cardinality": 1000, "columns": {"a": 100, "b": 10}},
        "S": {"cardinality": 2000, "columns": {"c": 100}},
    },
    "selectivities": {"R.b": 0.1},
}
PUSHDOWN_QUERY = select(
    [eq_const("R.b", 5), eq_col("R.a", "S.c")],
    join(relation("R"), relation("S")),
)
# R' = 1000 * 0.1 = 100; join = 100 * 2000 / max(100, 100) = 2000.
PUSHDOWN_OPTIMAL_COST = 100 + 2000
# Without pushdown: cartesian 2_000_000, then select 2_000_000 * 0.1 / 100.
PUSHDOWN_UNOPTIMIZED_COST = 2_000_000 + 2000


def find_nodes(plan, node_type):
    found = []

    def walk(node):
        if node["type"] == node_type:
            found.append(node)
        for key in ("input", "left", "right"):
            if key in node:
                walk(node[key])

    walk(plan)
    return found


# ---------------------------------------------------------------------------
# Independent enumeration of all binary join trees (acceptance requirement)
# ---------------------------------------------------------------------------

def all_binary_trees(items):
    """Every full binary tree whose in-order leaves equal ``items``."""
    if len(items) == 1:
        yield items[0]
        return
    for split in range(1, len(items)):
        for left in all_binary_trees(items[:split]):
            for right in all_binary_trees(items[split:]):
                yield (left, right)


def tree_leaves(tree):
    if isinstance(tree, str):
        return {tree}
    return tree_leaves(tree[0]) | tree_leaves(tree[1])


def brute_force_join_cost(leaf_cards, predicates):
    """Minimum sum of join cardinalities over all ordered binary trees.

    ``leaf_cards`` maps relation name -> cardinality after local selections.
    ``predicates`` maps (rel1, rel2) -> join selectivity (1 / max(NDV)).
    """
    best = math.inf
    relations = sorted(leaf_cards)
    for order in permutations(relations):
        for tree in all_binary_trees(list(order)):
            _, cost = _brute_evaluate(tree, leaf_cards, predicates)
            best = min(best, cost)
    return best


def _brute_evaluate(tree, leaf_cards, predicates):
    if isinstance(tree, str):
        return leaf_cards[tree], 0.0
    left_card, left_cost = _brute_evaluate(tree[0], leaf_cards, predicates)
    right_card, right_cost = _brute_evaluate(tree[1], leaf_cards, predicates)
    left_rels = tree_leaves(tree[0])
    right_rels = tree_leaves(tree[1])
    card = left_card * right_card
    for (rel1, rel2), selectivity in predicates.items():
        if (rel1 in left_rels and rel2 in right_rels) or (
            rel2 in left_rels and rel1 in right_rels
        ):
            card *= selectivity
    return card, left_cost + right_cost + card


# ---------------------------------------------------------------------------
# Unit tests
# ---------------------------------------------------------------------------

class SelectionPushdownTests(unittest.TestCase):
    def test_pushdown_reduces_cost(self):
        result = optimize_query(PUSHDOWN_QUERY, PUSHDOWN_STATS)
        self.assertEqual(result["cost"], PUSHDOWN_OPTIMAL_COST)
        self.assertLess(result["cost"], PUSHDOWN_UNOPTIMIZED_COST)

    def test_selection_pushed_below_join_to_relation(self):
        plan = optimize_query(PUSHDOWN_QUERY, PUSHDOWN_STATS)["plan"]
        selects = find_nodes(plan, "select")
        self.assertEqual(len(selects), 1)
        self.assertEqual(selects[0]["input"], {"type": "relation", "name": "R"})
        self.assertEqual(selects[0]["conditions"], [eq_const("R.b", 5)])
        joins = find_nodes(plan, "join")
        self.assertEqual(joins[0]["predicates"], [eq_col("R.a", "S.c")])

    def test_selection_pushed_through_projection(self):
        stats = {
            "relations": {"R": {"cardinality": 1000, "columns": {"a": 100, "b": 10}}},
            "selectivities": {"R.a": 0.1},
        }
        query = select([eq_const("R.a", 1)], project(["R.a", "R.b"], relation("R")))
        result = optimize_query(query, stats)
        plan = result["plan"]
        self.assertEqual(plan["type"], "project")
        self.assertEqual(plan["input"]["type"], "select")
        self.assertEqual(plan["input"]["input"], {"type": "relation", "name": "R"})
        self.assertEqual(result["cost"], 100 + 100)

    def test_condition_on_dropped_column_not_pushed(self):
        stats = {
            "relations": {"R": {"cardinality": 1000, "columns": {"a": 100, "b": 10}}},
            "selectivities": {"R.b": 0.5},
        }
        query = select([eq_const("R.b", 2)], project(["R.a"], relation("R")))
        result = optimize_query(query, stats)
        plan = result["plan"]
        self.assertEqual(plan["type"], "select")
        self.assertEqual(plan["input"]["type"], "project")
        self.assertEqual(plan["input"]["input"], {"type": "relation", "name": "R"})
        self.assertEqual(result["cost"], 1000 + 500)

    def test_conjunction_split_and_routed_to_both_sides(self):
        stats = {
            "relations": {
                "R": {"cardinality": 100, "columns": {"a": 10}},
                "S": {"cardinality": 200, "columns": {"b": 20}},
            },
            "selectivities": {"R.a": 0.5, "S.b": 0.25},
        }
        query = select(
            [eq_const("R.a", 1), eq_const("S.b", 2)],
            join(relation("R"), relation("S")),
        )
        result = optimize_query(query, stats)
        # R' = 50, S' = 50, join = 2500; cost = 50 + 50 + 2500.
        self.assertEqual(result["cost"], 2600)
        selects = find_nodes(result["plan"], "select")
        self.assertEqual(len(selects), 2)


class JoinEnumerationTests(unittest.TestCase):
    STATS = {
        "relations": {
            "R": {"cardinality": 100, "columns": {"a": 10}},
            "S": {"cardinality": 200, "columns": {"a": 20, "b": 5}},
            "T": {"cardinality": 300, "columns": {"b": 6, "c": 15}},
            "U": {"cardinality": 400, "columns": {"c": 12}},
        }
    }
    QUERY = select(
        [eq_col("R.a", "S.a"), eq_col("S.b", "T.b"), eq_col("T.c", "U.c")],
        join(join(relation("R"), relation("S")), join(relation("T"), relation("U"))),
    )

    def test_matches_independent_brute_force(self):
        leaf_cards = {"R": 100.0, "S": 200.0, "T": 300.0, "U": 400.0}
        predicates = {
            ("R", "S"): 1 / 20,
            ("S", "T"): 1 / 6,
            ("T", "U"): 1 / 15,
        }
        expected = brute_force_join_cost(leaf_cards, predicates)
        result = optimize_query(self.QUERY, self.STATS)
        self.assertEqual(result["cost"], expected)

    def test_enumeration_covers_all_binary_trees(self):
        # 4 relations => 4! orderings * 5 shapes = 120 candidate trees.
        trees = set()
        for order in permutations(["R", "S", "T", "U"]):
            for tree in all_binary_trees(list(order)):
                trees.add(json.dumps(tree))
        self.assertEqual(len(trees), 120)

    def test_input_shape_does_not_change_optimum(self):
        left_deep = select(
            [eq_col("R.a", "S.a"), eq_col("S.b", "T.b"), eq_col("T.c", "U.c")],
            join(join(join(relation("U"), relation("T")), relation("S")), relation("R")),
        )
        self.assertEqual(
            optimize_query(left_deep, self.STATS)["cost"],
            optimize_query(self.QUERY, self.STATS)["cost"],
        )


class CanonicalOrderTests(unittest.TestCase):
    def test_tie_broken_by_plan_json_order(self):
        stats = {
            "relations": {
                "R": {"cardinality": 100, "columns": {"a": 10}},
                "S": {"cardinality": 100, "columns": {"b": 10}},
            }
        }
        # join(S, R) and join(R, S) have identical cost (100 * 100 = 10000).
        result = optimize_query(join(relation("S"), relation("R")), stats)
        self.assertEqual(result["cost"], 10000)
        plan = result["plan"]
        self.assertEqual(plan["left"], {"type": "relation", "name": "R"})
        self.assertEqual(plan["right"], {"type": "relation", "name": "S"})

    def test_canonical_serialization_is_min_of_tied_plans(self):
        stats = {
            "relations": {
                "R": {"cardinality": 100, "columns": {"a": 10}},
                "S": {"cardinality": 100, "columns": {"b": 10}},
            }
        }
        result = optimize_query(join(relation("S"), relation("R")), stats)
        serialized = json.dumps(result["plan"], sort_keys=True, separators=(",", ":"))
        swapped = join(relation("S"), relation("R"))
        swapped_serialized = json.dumps(swapped, sort_keys=True, separators=(",", ":"))
        self.assertLess(serialized, swapped_serialized)


class ValidationTests(unittest.TestCase):
    def test_unknown_column_raises(self):
        query = select([eq_const("R.nope", 1)], relation("R"))
        stats = {"relations": {"R": {"cardinality": 10, "columns": {"a": 5}}}}
        with self.assertRaises(UnknownColumnError) as ctx:
            optimize_query(query, stats)
        self.assertEqual(ctx.exception.column, "R.nope")

    def test_unknown_column_in_projection(self):
        query = project(["R.a", "R.zzz"], relation("R"))
        stats = {"relations": {"R": {"cardinality": 10, "columns": {"a": 5}}}}
        with self.assertRaises(UnknownColumnError):
            optimize_query(query, stats)


# ---------------------------------------------------------------------------
# CLI tests
# ---------------------------------------------------------------------------

class CliTests(unittest.TestCase):
    def run_cli(self, query, stats, budget):
        with tempfile.TemporaryDirectory() as tmp:
            paths = []
            for name, payload in (
                ("query.json", query),
                ("stats.json", stats),
                ("budget.json", budget),
            ):
                path = Path(tmp) / name
                path.write_text(json.dumps(payload), encoding="utf-8")
                paths.append(str(path))
            proc = subprocess.run(
                [sys.executable, "-m", "optrewrite", *paths],
                cwd=REPO_ROOT,
                capture_output=True,
                text=True,
            )
        return proc

    def test_budget_equal_to_cost_is_accepted(self):
        proc = self.run_cli(PUSHDOWN_QUERY, PUSHDOWN_STATS, PUSHDOWN_OPTIMAL_COST)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        output = json.loads(proc.stdout)
        self.assertEqual(output["cost"], PUSHDOWN_OPTIMAL_COST)
        self.assertEqual(output["plan"]["type"], "join")

    def test_budget_below_cost_is_rejected_with_exit_3(self):
        proc = self.run_cli(PUSHDOWN_QUERY, PUSHDOWN_STATS, PUSHDOWN_OPTIMAL_COST - 1)
        self.assertEqual(proc.returncode, 3)
        error = json.loads(proc.stdout)
        self.assertEqual(error["error"], "budget_exceeded")
        self.assertEqual(error["cost"], PUSHDOWN_OPTIMAL_COST)
        self.assertEqual(error["budget"], PUSHDOWN_OPTIMAL_COST - 1)

    def test_unknown_column_exits_2(self):
        query = select([eq_const("R.nope", 1)], relation("R"))
        stats = {"relations": {"R": {"cardinality": 10, "columns": {"a": 5}}}}
        proc = self.run_cli(query, stats, 10)
        self.assertEqual(proc.returncode, 2)
        error = json.loads(proc.stdout)
        self.assertEqual(error["error"], "unknown_column")
        self.assertEqual(error["column"], "R.nope")

    def test_cli_tie_break_outputs_canonical_plan(self):
        stats = {
            "relations": {
                "R": {"cardinality": 100, "columns": {"a": 10}},
                "S": {"cardinality": 100, "columns": {"b": 10}},
            }
        }
        proc = self.run_cli(join(relation("S"), relation("R")), stats, 10000)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        plan = json.loads(proc.stdout)["plan"]
        self.assertEqual(plan["left"]["name"], "R")
        self.assertEqual(plan["right"]["name"], "S")


if __name__ == "__main__":
    unittest.main()
