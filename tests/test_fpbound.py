import json
import random
import subprocess
import sys
import unittest
from fractions import Fraction

from fpbound import analyze, to_json, round_binary64, INF, NAN


def float_eval(tree):
    """Evaluate the expression tree with actual IEEE doubles."""
    if "const" in tree:
        return float(Fraction(tree["const"]))
    left = float_eval(tree["left"])
    right = float_eval(tree["right"])
    op = tree["op"]
    if op == "add":
        return left + right
    if op == "sub":
        return left - right
    if op == "mul":
        return left * right
    return left / right


def iter_nodes(node):
    yield node
    if "left" in node:
        yield from iter_nodes(node["left"])
        yield from iter_nodes(node["right"])


def random_const(rng):
    kind = rng.random()
    if kind < 0.45:
        return Fraction(rng.randint(-100, 100), rng.randint(1, 100))
    if kind < 0.75:
        return Fraction(rng.randint(-10, 10))
    return Fraction(rng.randint(1, 1000), rng.randint(1, 1000)) * Fraction(
        2) ** rng.randint(-40, 40)


def random_tree(rng, budget):
    """Random expression tree with at most `budget` nodes."""
    if budget <= 2 or rng.random() < 0.3:
        return {"const": random_const(rng)}
    op = rng.choice(["add", "sub", "mul", "div"])
    left_budget = rng.randint(1, budget - 2)
    right_budget = budget - 1 - left_budget
    return {
        "op": op,
        "left": random_tree(rng, left_budget),
        "right": random_tree(rng, right_budget),
    }


def tree_size(tree):
    if "const" in tree:
        return 1
    return 1 + tree_size(tree["left"]) + tree_size(tree["right"])


class TestRounding(unittest.TestCase):
    def test_known_ties_to_even(self):
        # Halfway between 1 and 1+2^-52: tie -> even -> 1.
        self.assertEqual(round_binary64(1 + Fraction(1, 2**53)), Fraction(1))
        # Halfway between 1+2^-52 and 1+2^-51: tie -> even -> 1+2^-51.
        self.assertEqual(
            round_binary64(1 + Fraction(3, 2**53)),
            1 + Fraction(1, 2**51))
        # Subnormal tie: 2^-1075 -> 0 (even), 3*2^-1075 -> 2^-1073 (even).
        self.assertEqual(round_binary64(Fraction(1, 2**1075)), Fraction(0))
        self.assertEqual(round_binary64(Fraction(3, 2**1075)),
                         Fraction(1, 2**1073))

    def test_overflow_threshold(self):
        max_finite = Fraction(2 - Fraction(1, 2**52)) * Fraction(2)**1023
        self.assertEqual(round_binary64(max_finite), max_finite)
        # Halfway to 2^1024 rounds to inf (tie to even significand).
        self.assertEqual(round_binary64(Fraction(2)**1024 - Fraction(2)**970),
                         INF)
        self.assertEqual(round_binary64(Fraction(2)**1024), INF)
        self.assertEqual(round_binary64(-Fraction(2)**1024), -INF)

    def test_matches_float_for_random_values(self):
        rng = random.Random(1234)
        for _ in range(5000):
            x = Fraction(rng.randint(-10**12, 10**12),
                         rng.randint(1, 10**6)) * Fraction(
                             2)**rng.randint(-1100, 1000)
            got = round_binary64(x)
            want = float(x)
            if want in (INF, -INF):
                self.assertEqual(got, want)
            else:
                self.assertEqual(float(got), want)


class TestRandomExpressions(unittest.TestCase):
    def test_bounds_conservative_1000_random_trees(self):
        rng = random.Random(20260930)
        checked = 0
        for _ in range(1000):
            tree = random_tree(rng, 8)
            self.assertLessEqual(tree_size(tree), 8)
            result = analyze(tree)

            # Cross-check simulated rounding against real IEEE doubles.
            try:
                want = float_eval(tree)
            except ZeroDivisionError:
                want = None
            if want is not None and result["rounded"] is not None:
                got = result["rounded"]
                if want in (INF, -INF):
                    self.assertEqual(got, want)
                elif got not in (INF, -INF, NAN):
                    self.assertEqual(float(got), want)

            for node in iter_nodes(result):
                if node["status"] != "ok":
                    self.assertEqual(node["bound"], INF)
                    continue
                true_error = abs(node["rounded"] - node["exact"])
                self.assertGreaterEqual(node["bound"], true_error)
                checked += 1
        self.assertGreater(checked, 2000)  # actually exercised many nodes


class TestStatusFlags(unittest.TestCase):
    def test_division_by_exact_zero(self):
        tree = {"op": "div", "left": {"const": 1},
                "right": {"op": "sub", "left": {"const": 1},
                          "right": {"const": 1}}}
        result = analyze(tree)
        self.assertEqual(result["status"], "div_zero")
        self.assertEqual(result["rounded"], INF)
        self.assertEqual(result["bound"], INF)

    def test_zero_over_zero_is_invalid(self):
        tree = {"op": "div", "left": {"const": 0}, "right": {"const": 0}}
        result = analyze(tree)
        self.assertEqual(result["status"], "invalid")
        self.assertTrue(result["rounded"] != result["rounded"])  # nan

    def test_division_by_underflowed_zero(self):
        # 2^-1075 is nonzero but rounds to binary64 zero.
        tiny = Fraction(1, 2**1075)
        tree = {"op": "div", "left": {"const": 1}, "right": {"const": tiny}}
        result = analyze(tree)
        self.assertEqual(result["status"], "div_zero")
        self.assertEqual(result["rounded"], INF)

    def test_overflow_to_inf(self):
        tree = {"op": "mul", "left": {"const": Fraction(10)**308},
                "right": {"const": 2}}
        result = analyze(tree)
        self.assertEqual(result["status"], "overflow")
        self.assertEqual(result["rounded"], INF)
        self.assertEqual(result["bound"], INF)

    def test_overflow_propagates(self):
        tree = {"op": "add",
                "left": {"op": "mul", "left": {"const": Fraction(10)**308},
                         "right": {"const": 2}},
                "right": {"const": 1}}
        result = analyze(tree)
        self.assertEqual(result["status"], "overflow")
        self.assertEqual(result["bound"], INF)


class TestCatastrophicCancellation(unittest.TestCase):
    def test_bound_amplifies(self):
        # (1e16 + 1) - 1e16: exact 1, binary64 computes 0.
        big = Fraction(10)**16
        tree = {"op": "sub",
                "left": {"op": "add", "left": {"const": big},
                         "right": {"const": 1}},
                "right": {"const": big}}
        result = analyze(tree)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["exact"], 1)
        self.assertEqual(result["rounded"], 0)
        true_error = abs(result["rounded"] - result["exact"])
        self.assertEqual(true_error, 1)
        self.assertGreaterEqual(result["bound"], true_error)
        # Bound is dramatically amplified relative to the operands' local
        # rounding errors (each <= 2^-53 in relative terms / tiny here).
        local = sum(n["bound"] for n in iter_nodes(result)
                    if n["op"] == "const")
        self.assertGreater(result["bound"], local * 10**6)
        self.assertGreaterEqual(result["bound"], Fraction(1, 2))


class TestCli(unittest.TestCase):
    def test_cli_roundtrip(self):
        tree = {"op": "add", "left": {"const": 0.1}, "right": {"const": 0.2}}
        proc = subprocess.run(
            [sys.executable, "-m", "fpbound"],
            input=json.dumps(tree), capture_output=True, text=True,
            check=True)
        out = json.loads(proc.stdout)
        self.assertEqual(out["status"], "ok")
        self.assertEqual(out["op"], "add")
        self.assertEqual(out["rounded"], str(Fraction(float(0.1) + float(0.2))))
        self.assertIn("left", out)
        self.assertIn("right", out)
        # Bound covers the true error.
        self.assertGreaterEqual(Fraction(out["bound"]),
                                abs(Fraction(out["rounded"]) -
                                    Fraction(out["exact"])))

    def test_cli_div_zero(self):
        tree = {"op": "div", "left": {"const": 1}, "right": {"const": 0}}
        proc = subprocess.run(
            [sys.executable, "-m", "fpbound"],
            input=json.dumps(tree), capture_output=True, text=True,
            check=True)
        out = json.loads(proc.stdout)
        self.assertEqual(out["status"], "div_zero")
        self.assertEqual(out["rounded"], "inf")
        self.assertEqual(out["bound"], "inf")


if __name__ == "__main__":
    unittest.main()
