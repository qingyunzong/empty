"""Acceptance and unit tests for budgetsync."""

from __future__ import annotations

import itertools
import json
import os
import random
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

from budgetsync import (  # noqa: E402
    OP_DELETE,
    OP_SET,
    apply_plan,
    build_plan,
    canonical,
    matched_fields,
    needed_ops,
    select_ops,
)

OP_RANK = {OP_DELETE: 0, OP_SET: 1}


def op_key(op):
    return (op["key"], OP_RANK[op["op"]])


def brute_force_best(a, b, budget):
    """Reference solver: enumerate every op subset, return (benefit, signature).

    Benefit is computed by simulating each subset over canonical value
    strings (equivalent to applying ops to B and counting matched fields).
    """
    candidates = needed_ops(a, b)
    canon_a = {key: canonical(value) for key, value in a.items()}
    canon_b = {key: canonical(value) for key, value in b.items()}
    canon_set = {
        op["key"]: canonical(op["value"]) for op in candidates if op["op"] == OP_SET
    }
    universe = set(canon_a) | set(canon_b)

    def benefit(combo):
        state = dict(canon_b)
        for op in combo:
            if op["op"] == OP_SET:
                state[op["key"]] = canon_set[op["key"]]
            else:
                state.pop(op["key"], None)
        count = 0
        for key in universe:
            in_a = key in canon_a
            in_state = key in state
            if in_a != in_state:
                continue
            if not in_a or canon_a[key] == state[key]:
                count += 1
        return count

    best_benefit = -1
    best_signature = None
    max_size = min(max(budget, 0), len(candidates))
    for size in range(0, max_size + 1):
        for combo in itertools.combinations(candidates, size):
            combo_benefit = benefit(combo)
            signature = tuple(sorted(op_key(op) for op in combo))
            if combo_benefit > best_benefit or (
                combo_benefit == best_benefit
                and (best_signature is None or signature < best_signature)
            ):
                best_benefit = combo_benefit
                best_signature = signature
    return best_benefit, best_signature


class OptimalityTest(unittest.TestCase):
    """Acceptance A: plan is budget-optimal with deterministic tie-breaks."""

    def check_case(self, a, b, budget):
        plan = build_plan(a, b, budget)
        benefit, signature = brute_force_best(a, b, budget)
        plan_state = apply_plan(b, plan)
        self.assertEqual(matched_fields(a, plan_state, set(a) | set(b)), benefit)
        self.assertEqual(tuple(op_key(op) for op in plan), signature)
        self.assertLessEqual(len(plan), max(budget, 0))

    def test_exhaustive_subsets_n12(self):
        keys = [f"k{i:02d}" for i in range(12)]
        full_a = {key: i for i, key in enumerate(keys)}
        # B ranges over all 2**12 key subsets (present keys match A).
        for mask in range(1 << 12):
            b = {keys[i]: i for i in range(12) if mask & (1 << i)}
            for budget in (0, 1, 5, 15):
                self.check_case(full_a, b, budget)

    def test_exhaustive_mixed_ops(self):
        keys = [f"k{i:02d}" for i in range(12)]
        rng = random.Random(20261001)
        for _ in range(25):
            a = {}
            b = {}
            for i, key in enumerate(keys):
                if rng.random() < 0.7:
                    a[key] = rng.choice([i, "s%d" % i, [i], {"n": i}, None, True])
                if rng.random() < 0.7:
                    b[key] = rng.choice([i, "s%d" % i, [i], {"n": i}, None, True])
            for budget in (0, 1, 3, 6, 12, 20):
                self.check_case(a, b, budget)

    def test_tie_break_delete_before_set(self):
        a = {"b": 1}
        b = {"a": 9, "b": 2}
        plan = build_plan(a, b, 1)
        self.assertEqual(plan, [{"op": OP_DELETE, "key": "a"}])

    def test_tie_break_key_order(self):
        a = {"x": 1, "y": 2, "z": 3}
        b = {}
        plan = build_plan(a, b, 2)
        self.assertEqual([op["key"] for op in plan], ["x", "y"])


class BudgetZeroTest(unittest.TestCase):
    """Acceptance B: budget 0 yields an empty plan."""

    def test_budget_zero(self):
        a = {"x": 1, "y": {"n": [1, 2]}}
        b = {"z": 3}
        self.assertEqual(build_plan(a, b, 0), [])
        self.assertEqual(select_ops(needed_ops(a, b), 0), [])


class CanonicalCompareTest(unittest.TestCase):
    """Acceptance C: nested JSON normalization, -0.0 equals 0.0."""

    def test_negative_zero_equal(self):
        self.assertEqual(canonical(-0.0), canonical(0.0))
        self.assertEqual(needed_ops({"z": 0.0}, {"z": -0.0}), [])

    def test_nested_key_order_equal(self):
        a = {"x": {"a": 1, "b": [1, {"c": 2, "d": 3}]}}
        b = {"x": {"b": [1, {"d": 3, "c": 2}], "a": 1}}
        self.assertEqual(needed_ops(a, b), [])

    def test_nested_difference_sets_full_value(self):
        a = {"x": {"a": [1, {"b": 2}]}}
        b = {"x": {"a": [1, {"b": 3}]}}
        ops = needed_ops(a, b)
        self.assertEqual(ops, [{"op": OP_SET, "key": "x", "value": a["x"]}])

    def test_int_float_equal(self):
        self.assertEqual(needed_ops({"n": 1}, {"n": 1.0}), [])

    def test_bool_distinct_from_number(self):
        ops = needed_ops({"n": 1}, {"n": True})
        self.assertEqual(len(ops), 1)
        self.assertEqual(ops[0]["op"], OP_SET)


class IdempotencyTest(unittest.TestCase):
    """Acceptance D: re-applying a plan leaves state unchanged."""

    def test_reapply_plan_stable(self):
        rng = random.Random(7)
        for _ in range(50):
            keys = [f"k{i}" for i in range(rng.randint(0, 10))]
            a = {k: rng.randint(0, 5) for k in keys if rng.random() < 0.6}
            b = {k: rng.randint(0, 5) for k in keys if rng.random() < 0.6}
            plan = build_plan(a, b, rng.randint(0, 12))
            once = apply_plan(b, plan)
            twice = apply_plan(once, plan)
            self.assertEqual(canonical(once), canonical(twice))

    def test_full_budget_converges(self):
        a = {"x": 1, "y": [1, {"z": 2}], "w": None}
        b = {"y": 0, "q": "extra"}
        plan = build_plan(a, b, 100)
        self.assertEqual(canonical(apply_plan(b, plan)), canonical(a))


class CliTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.a_path = os.path.join(self.tmp.name, "a.json")
        self.b_path = os.path.join(self.tmp.name, "b.json")
        self.out_path = os.path.join(self.tmp.name, "plan.jsonl")

    def write(self, path, obj):
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(obj, handle)

    def run_cli(self, *argv):
        return subprocess.run(
            [sys.executable, "-m", "budgetsync", *argv],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )

    def test_plan_cli_end_to_end(self):
        self.write(self.a_path, {"a": 1, "b": 2, "c": 3})
        self.write(self.b_path, {"b": 20, "d": 4})
        result = self.run_cli(
            "plan", self.a_path, self.b_path, "--budget", "2", "--out", self.out_path
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("selected=2", result.stdout)
        self.assertIn("budget=2", result.stdout)
        self.assertIn("remaining=0", result.stdout)
        with open(self.out_path, encoding="utf-8") as handle:
            lines = [json.loads(line) for line in handle if line.strip()]
        self.assertEqual(
            lines,
            [
                {"op": "set", "key": "a", "value": 1},
                {"op": "set", "key": "b", "value": 2},
            ],
        )

    def test_budget_zero_writes_empty_file(self):
        self.write(self.a_path, {"a": 1})
        self.write(self.b_path, {})
        result = self.run_cli(
            "plan", self.a_path, self.b_path, "--budget", "0", "--out", self.out_path
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("selected=0", result.stdout)
        self.assertIn("remaining=0", result.stdout)
        with open(self.out_path, encoding="utf-8") as handle:
            self.assertEqual(handle.read(), "")

    def test_negative_budget_exit_2(self):
        self.write(self.a_path, {"a": 1})
        self.write(self.b_path, {})
        result = self.run_cli(
            "plan", self.a_path, self.b_path, "--budget", "-1", "--out", self.out_path
        )
        self.assertEqual(result.returncode, 2)
        self.assertFalse(os.path.exists(self.out_path))

    def test_non_object_exit_3(self):
        self.write(self.a_path, [1, 2, 3])
        self.write(self.b_path, {})
        result = self.run_cli(
            "plan", self.a_path, self.b_path, "--budget", "1", "--out", self.out_path
        )
        self.assertEqual(result.returncode, 3)
        self.write(self.a_path, {"a": 1})
        self.write(self.b_path, "hello")
        result = self.run_cli(
            "plan", self.a_path, self.b_path, "--budget", "1", "--out", self.out_path
        )
        self.assertEqual(result.returncode, 3)


if __name__ == "__main__":
    unittest.main()
