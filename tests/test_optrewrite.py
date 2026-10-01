import json
import subprocess
import sys
import tempfile
import unittest
from fractions import Fraction
from pathlib import Path

from optrewrite import core

ROOT = Path(__file__).resolve().parent.parent


def make_stats():
    return core.Stats.from_dict(
        {
            "relations": {
                "R": {
                    "cardinality": 1000,
                    "columns": {"a": {"ndv": 100}, "b": {"ndv": 50}, "x": {"ndv": 200}},
                },
                "S": {
                    "cardinality": 500,
                    "columns": {"a": {"ndv": 100}, "c": {"ndv": 25}, "y": {"ndv": 200}},
                },
            },
            "selectivities": {"R.a": 0.1, "R.b": 0.5, "S.c": 0.2},
        }
    )


def scan(rel):
    return {"type": "scan", "relation": rel}


def select(conds, child):
    return {"type": "select", "conditions": conds, "input": child}


def join(left, right, conds):
    return {"type": "join", "conditions": conds, "left": left, "right": right}


def run_cli(query, stats, budget):
    with tempfile.TemporaryDirectory() as tmp:
        q = Path(tmp) / "query.json"
        s = Path(tmp) / "stats.json"
        b = Path(tmp) / "budget.json"
        q.write_text(json.dumps(query))
        s.write_text(json.dumps(stats))
        b.write_text(json.dumps(budget))
        return subprocess.run(
            [sys.executable, "-m", "optrewrite", str(q), str(s), str(b)],
            capture_output=True,
            text=True,
            cwd=ROOT,
        )


class TestSelectionPushdown(unittest.TestCase):
    def setUp(self):
        self.stats = make_stats()
        self.query = select(
            [{"column": "R.a", "op": "=", "value": 42}],
            join(scan("R"), scan("S"), [{"left": "R.x", "right": "S.y"}]),
        )

    def test_pushdown_reduces_cost(self):
        unoptimized = core.plan_cost(core.canonicalize(self.query), self.stats)
        plan, cost = core.optimize(self.query, self.stats)
        self.assertLess(cost, unoptimized)
        # select(R.a) ends up below the join, directly over scan R
        self.assertEqual(plan["type"], "join")
        pushed = plan["left"] if plan["left"]["type"] == "select" else plan["right"]
        self.assertEqual(pushed["type"], "select")
        self.assertEqual(pushed["input"], {"type": "scan", "relation": "R"})
        self.assertEqual(pushed["conditions"][0]["column"], "R.a")

    def test_exact_cost_values(self):
        # unoptimized: join card 1000*500/200 = 2500, select card 250
        # optimized: select card 100, join card 100*500/200 = 250
        unoptimized = core.plan_cost(core.canonicalize(self.query), self.stats)
        self.assertEqual(unoptimized, Fraction(2750))
        _plan, cost = core.optimize(self.query, self.stats)
        self.assertEqual(cost, Fraction(350))

    def test_no_pushdown_past_projection_of_dropped_column(self):
        query = select(
            [
                {"column": "R.a", "op": "=", "value": 1},
                {"column": "R.b", "op": "<", "value": 10},
            ],
            {"type": "project", "columns": ["R.a"], "input": scan("R")},
        )
        plan, _cost = core.optimize(query, self.stats)
        # predicate on dropped column R.b stays above the projection
        self.assertEqual(plan["type"], "select")
        self.assertEqual([c["column"] for c in plan["conditions"]], ["R.b"])
        proj = plan["input"]
        self.assertEqual(proj["type"], "project")
        # predicate on kept column R.a is pushed below the projection
        self.assertEqual(proj["input"]["type"], "select")
        self.assertEqual([c["column"] for c in proj["input"]["conditions"]], ["R.a"])
        self.assertEqual(proj["input"]["input"], scan("R"))

    def test_two_column_predicate_becomes_join_condition(self):
        query = select(
            [{"left": "R.x", "right": "S.y"}],
            join(scan("R"), scan("S"), []),
        )
        plan, _cost = core.optimize(query, self.stats)
        self.assertEqual(plan["type"], "join")
        self.assertEqual(plan["conditions"], [{"left": "R.x", "right": "S.y"}])


class TestCardinality(unittest.TestCase):
    def test_equi_join_formula(self):
        stats = make_stats()
        node = join(scan("R"), scan("S"), [{"left": "R.x", "right": "S.y"}])
        # |R|*|S| / max(V(R,x), V(S,y)) = 1000*500/200
        self.assertEqual(core.cardinality(node, stats), Fraction(2500))

    def test_selectivity_applied(self):
        stats = make_stats()
        node = select([{"column": "R.a", "op": "=", "value": 1}], scan("R"))
        self.assertEqual(core.cardinality(node, stats), Fraction(100))


class TestBudgetBoundary(unittest.TestCase):
    STATS = {
        "relations": {
            "R": {"cardinality": 1000, "columns": {"a": {"ndv": 100}, "x": {"ndv": 200}}},
            "S": {"cardinality": 500, "columns": {"y": {"ndv": 200}}},
        },
        "selectivities": {"R.a": 0.1},
    }
    QUERY = select(
        [{"column": "R.a", "op": "=", "value": 42}],
        join(scan("R"), scan("S"), [{"left": "R.x", "right": "S.y"}]),
    )

    def test_budget_equal_to_boundary_accepted(self):
        # optimal cost is exactly 350
        result = run_cli(self.QUERY, self.STATS, {"budget": 350})
        self.assertEqual(result.returncode, 0, result.stderr)
        plan = json.loads(result.stdout)
        self.assertEqual(plan["type"], "join")

    def test_budget_below_boundary_rejected(self):
        result = run_cli(self.QUERY, self.STATS, {"budget": 349})
        self.assertEqual(result.returncode, 3)
        error = json.loads(result.stderr)
        self.assertEqual(error["error"], "budget_exceeded")
        self.assertEqual(error["optimal_cost"], 350)
        self.assertEqual(error["budget"], 349)


class TestTieBreak(unittest.TestCase):
    """Two structurally different plans with identical cost: the one with the
    lexicographically smaller canonical plan JSON must win."""

    STATS = {
        "relations": {
            "R": {"cardinality": 100, "columns": {"x": {"ndv": 10}}},
            "S": {"cardinality": 100, "columns": {"x": {"ndv": 10}, "y": {"ndv": 10}}},
            "T": {"cardinality": 100, "columns": {"y": {"ndv": 10}}},
        }
    }

    def test_canonical_order(self):
        stats = core.Stats.from_dict(self.STATS)
        query = join(
            scan("R"),
            join(scan("S"), scan("T"), [{"left": "S.y", "right": "T.y"}]),
            [{"left": "R.x", "right": "S.x"}],
        )
        plan_a = core.canonicalize(
            join(
                join(scan("R"), scan("S"), [{"left": "R.x", "right": "S.x"}]),
                scan("T"),
                [{"left": "S.y", "right": "T.y"}],
            )
        )
        plan_b = core.canonicalize(
            join(
                scan("R"),
                join(scan("S"), scan("T"), [{"left": "S.y", "right": "T.y"}]),
                [{"left": "R.x", "right": "S.x"}],
            )
        )
        json_a = core.canonical_json(plan_a)
        json_b = core.canonical_json(plan_b)
        # genuinely two different plans ...
        self.assertNotEqual(json_a, json_b)
        # ... with identical cost: 1000 + 10000 = 11000
        self.assertEqual(core.plan_cost(plan_a, stats), Fraction(11000))
        self.assertEqual(core.plan_cost(plan_b, stats), Fraction(11000))

        plan, cost = core.optimize(query, stats)
        self.assertEqual(cost, Fraction(11000))
        self.assertEqual(core.canonical_json(plan), min(json_a, json_b))


class TestIndependentEnumeration(unittest.TestCase):
    """Independently enumerate ALL binary join trees and check the optimizer
    picks the minimum-cost, lexicographically-smallest canonical plan."""

    STATS = {
        "relations": {
            "R": {"cardinality": 1000, "columns": {"a": {"ndv": 100}}},
            "S": {"cardinality": 2000, "columns": {"a": {"ndv": 200}, "b": {"ndv": 50}}},
            "T": {"cardinality": 4000, "columns": {"b": {"ndv": 100}, "c": {"ndv": 80}}},
            "U": {"cardinality": 800, "columns": {"c": {"ndv": 40}}},
        }
    }
    RELS = ["R", "S", "T", "U"]
    PREDS = [("R.a", "S.a"), ("S.b", "T.b"), ("T.c", "U.c")]

    def _all_trees(self, mask):
        if mask & (mask - 1) == 0:
            return [mask]
        trees = []
        sub = (mask - 1) & mask
        while sub:
            other = mask ^ sub
            if sub < other:
                for left in self._all_trees(sub):
                    for right in self._all_trees(other):
                        trees.append((left, right))
            sub = (sub - 1) & mask
        return trees

    def _card(self, mask, cards, pred_factors):
        c = Fraction(1)
        for i, card in enumerate(cards):
            if mask >> i & 1:
                c *= card
        for (i, j), factor in pred_factors.items():
            if (mask >> i & 1) and (mask >> j & 1):
                c *= factor
        return c

    def _cost(self, tree, cards, pred_factors):
        if isinstance(tree, int):
            return Fraction(0)
        mask = self._mask(tree)
        return (
            self._card(mask, cards, pred_factors)
            + self._cost(tree[0], cards, pred_factors)
            + self._cost(tree[1], cards, pred_factors)
        )

    def _mask(self, tree):
        if isinstance(tree, int):
            return tree
        return self._mask(tree[0]) | self._mask(tree[1])

    def _canonical(self, tree, rels, preds):
        if isinstance(tree, int):
            rel = rels[int(tree).bit_length() - 1]
            return {"type": "scan", "relation": rel}
        left = self._canonical(tree[0], rels, preds)
        right = self._canonical(tree[1], rels, preds)
        mask_l, mask_r = self._mask(tree[0]), self._mask(tree[1])
        conds = []
        for (i, j), (col_i, col_j) in preds.items():
            in_l = (mask_l >> i & 1, mask_l >> j & 1)
            in_r = (mask_r >> i & 1, mask_r >> j & 1)
            if any(in_l) and any(in_r) and not all(in_l) and not all(in_r):
                conds.append({"left": col_i, "right": col_j})
        conds.sort(key=lambda c: json.dumps(c, sort_keys=True))
        dump = lambda n: json.dumps(n, sort_keys=True, separators=(",", ":"))
        if dump(right) < dump(left):
            left, right = right, left
        return {"type": "join", "conditions": conds, "left": left, "right": right}

    def test_full_enumeration_agrees(self):
        stats = core.Stats.from_dict(self.STATS)
        rels = self.RELS
        col_index = {f"{r}.{c}": i for i, r in enumerate(rels) for c in stats.relations[r]["columns"]}
        cards = [stats.relations[r]["cardinality"] for r in rels]
        pred_pairs = {}
        pred_cols = {}
        for left, right in self.PREDS:
            i, j = col_index[left], col_index[right]
            pred_pairs[(i, j)] = Fraction(1) / max(stats.ndv(left), stats.ndv(right))
            pred_cols[(i, j)] = (left, right)

        full = (1 << len(rels)) - 1
        trees = self._all_trees(full)
        self.assertGreaterEqual(len(trees), 15)  # 4 leaves -> many bushy trees
        costs = [self._cost(t, cards, pred_pairs) for t in trees]
        best_cost = min(costs)
        candidates = [
            json.dumps(
                self._canonical(t, rels, pred_cols), sort_keys=True, separators=(",", ":")
            )
            for t, c in zip(trees, costs)
            if c == best_cost
        ]
        expected_json = min(candidates)

        query = join(
            join(scan("R"), scan("S"), [{"left": "R.a", "right": "S.a"}]),
            join(scan("T"), scan("U"), [{"left": "T.c", "right": "U.c"}]),
            [{"left": "S.b", "right": "T.b"}],
        )
        plan, cost = core.optimize(query, stats)
        self.assertEqual(cost, best_cost)
        self.assertEqual(core.canonical_json(plan), expected_json)


class TestErrors(unittest.TestCase):
    STATS = {
        "relations": {"R": {"cardinality": 100, "columns": {"a": {"ndv": 10}}}},
        "selectivities": {"R.a": 0.5},
    }

    def test_unknown_column_exit_code_2(self):
        query = select([{"column": "R.zzz", "op": "=", "value": 1}], scan("R"))
        with self.assertRaises(core.UnknownColumnError):
            core.optimize(query, core.Stats.from_dict(self.STATS))
        result = run_cli(query, self.STATS, {"budget": 10})
        self.assertEqual(result.returncode, 2)
        error = json.loads(result.stderr)
        self.assertEqual(error["error"], "unknown_column")
        self.assertEqual(error["column"], "R.zzz")

    def test_unknown_join_column_exit_code_2(self):
        stats = {
            "relations": {
                "R": {"cardinality": 100, "columns": {"a": {"ndv": 10}}},
                "S": {"cardinality": 100, "columns": {"b": {"ndv": 10}}},
            }
        }
        query = join(scan("R"), scan("S"), [{"left": "R.a", "right": "S.nope"}])
        result = run_cli(query, stats, {"budget": 10})
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stderr)["column"], "S.nope")


class TestCliSuccess(unittest.TestCase):
    def test_stdout_is_canonical_plan(self):
        stats = {
            "relations": {
                "R": {"cardinality": 1000, "columns": {"a": {"ndv": 100}, "x": {"ndv": 200}}},
                "S": {"cardinality": 500, "columns": {"y": {"ndv": 200}}},
            },
            "selectivities": {"R.a": 0.1},
        }
        query = select(
            [{"column": "R.a", "op": "=", "value": 42}],
            join(scan("R"), scan("S"), [{"left": "R.x", "right": "S.y"}]),
        )
        result = run_cli(query, stats, {"budget": 350})
        self.assertEqual(result.returncode, 0, result.stderr)
        plan = json.loads(result.stdout)
        self.assertEqual(plan["type"], "join")
        # stdout is the canonical serialization of the module result
        expected, _cost = core.optimize(query, core.Stats.from_dict(stats))
        self.assertEqual(plan, expected)


if __name__ == "__main__":
    unittest.main()
