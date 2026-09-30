import json
import math
import random
import subprocess
import sys
import unittest
from fractions import Fraction
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analyzer import (
    Analyzer,
    STATUS_DIV_BY_ZERO,
    STATUS_OK,
    STATUS_OVERFLOW,
    result_to_json,
)

ROOT = Path(__file__).resolve().parent.parent


def const(x):
    return {"const": x}


def node(op, left, right):
    return {"op": op, "left": left, "right": right}


def random_tree(rng, budget):
    """Build a random expression tree with at most `budget` nodes."""
    if budget <= 2 or rng.random() < 0.3:
        # Small-magnitude decimal constants, occasionally large ones.
        if rng.random() < 0.1:
            return const(rng.choice(["1e5", "-3e4", "7e3", "0.0001"]))
        num = rng.randint(-1000, 1000)
        den = rng.choice([1, 2, 4, 5, 8, 10, 16, 20, 25, 100])
        return const(Fraction(num, den))
    left_budget = rng.randint(1, budget - 2)
    right_budget = budget - 1 - left_budget
    return node(
        rng.choice(["add", "sub", "mul", "div"]),
        random_tree(rng, left_budget),
        random_tree(rng, right_budget),
    )


def tree_size(tree):
    if "const" in tree:
        return 1
    return 1 + tree_size(tree["left"]) + tree_size(tree["right"])


class TestRandomBoundSoundness(unittest.TestCase):
    """(a) 1000 random expressions of at most 8 nodes: bound >= true error."""

    def test_random_expressions(self):
        rng = random.Random(20260930)
        checked_ok = 0
        checked_flagged = 0
        for i in range(1000):
            tree = random_tree(rng, 8)
            self.assertLessEqual(tree_size(tree), 8)
            analyzer = Analyzer()
            root = analyzer.analyze(tree)
            for n in analyzer.nodes:
                if n.status == STATUS_OK:
                    self.assertIsNotNone(n.exact)
                    self.assertTrue(math.isfinite(n.rounded))
                    true_error = abs(Fraction(n.rounded) - n.exact)
                    self.assertIsNotNone(n.bound)
                    self.assertGreaterEqual(
                        n.bound, true_error,
                        msg=f"case {i}: bound {n.bound} < true error "
                            f"{true_error} at node {n.op} of {tree}",
                    )
                    checked_ok += 1
                else:
                    # Non-ok nodes must report an unbounded (infinite) bound.
                    self.assertIsNone(n.bound)
                    checked_flagged += 1
        print(f"\n[random] ok nodes checked: {checked_ok}, "
              f"flagged nodes: {checked_flagged}")
        self.assertGreater(checked_ok, 3000)  # sanity: real coverage


class TestDivisionByZero(unittest.TestCase):
    """(b) Division-by-zero status output."""

    def test_div_by_zero(self):
        analyzer = Analyzer()
        root = analyzer.analyze(node("div", const(1), node("sub", const(1), const(1))))
        self.assertEqual(root.status, STATUS_DIV_BY_ZERO)
        self.assertIsNone(root.bound)
        self.assertTrue(math.isinf(root.rounded))

    def test_zero_over_zero_is_nan(self):
        analyzer = Analyzer()
        root = analyzer.analyze(node("div", const(0), const(0)))
        self.assertEqual(root.status, STATUS_DIV_BY_ZERO)
        self.assertTrue(math.isnan(root.rounded))

    def test_div_by_zero_propagates(self):
        tree = node("add", node("div", const(1), const(0)), const(2))
        analyzer = Analyzer()
        root = analyzer.analyze(tree)
        self.assertEqual(root.status, STATUS_DIV_BY_ZERO)
        self.assertIsNone(root.bound)


class TestOverflow(unittest.TestCase):
    """(b) Overflow-to-inf status output."""

    def test_overflow_multiply(self):
        tree = node("mul", const("1e308"), const("1e308"))
        analyzer = Analyzer()
        root = analyzer.analyze(tree)
        self.assertEqual(root.status, STATUS_OVERFLOW)
        self.assertIsNone(root.bound)
        self.assertEqual(root.rounded, math.inf)

    def test_overflow_constant(self):
        analyzer = Analyzer()
        root = analyzer.analyze(const("1e999"))
        self.assertEqual(root.status, STATUS_OVERFLOW)
        self.assertIsNone(root.bound)

    def test_overflow_propagates(self):
        tree = node("add", node("mul", const("1e308"), const("1e308")), const(1))
        analyzer = Analyzer()
        root = analyzer.analyze(tree)
        self.assertEqual(root.status, STATUS_OVERFLOW)


class TestCatastrophicCancellation(unittest.TestCase):
    """(c) Cancellation: bound must grow far beyond the naive result scale."""

    def test_cancellation_bound_amplified(self):
        # fl(1e16 + 1) == 1e16 in binary64, so (1e16 + 1) - 1e16 computes 0
        # while the exact result is 1.
        tree = node(
            "sub",
            node("add", const("10000000000000000"), const(1)),
            const("10000000000000000"),
        )
        analyzer = Analyzer()
        root = analyzer.analyze(tree)
        self.assertEqual(root.status, STATUS_OK)
        self.assertEqual(root.exact, Fraction(1))
        self.assertEqual(root.rounded, 0.0)
        true_error = abs(Fraction(root.rounded) - root.exact)
        self.assertEqual(true_error, Fraction(1))
        self.assertGreaterEqual(root.bound, true_error)
        # Bound is significantly amplified relative to the computed result (0).
        self.assertGreaterEqual(root.bound, Fraction(1, 2))

    def test_cancellation_repeated(self):
        # Subtracting two nearly-equal large values repeatedly: bound grows.
        tree = node(
            "sub",
            node("add", const("1234567890123456"), const("0.1")),
            const("1234567890123456"),
        )
        analyzer = Analyzer()
        root = analyzer.analyze(tree)
        self.assertEqual(root.status, STATUS_OK)
        true_error = abs(Fraction(root.rounded) - root.exact)
        self.assertGreaterEqual(root.bound, true_error)
        self.assertGreater(root.bound, 0)


class TestExactRounding(unittest.TestCase):
    def test_tenth_not_exact(self):
        analyzer = Analyzer()
        root = analyzer.analyze(const("0.1"))
        self.assertEqual(root.status, STATUS_OK)
        self.assertGreater(root.bound, 0)
        true_error = abs(Fraction(root.rounded) - Fraction(1, 10))
        self.assertEqual(root.bound, true_error)

    def test_exact_arithmetic_has_zero_bound(self):
        tree = node("add", const("0.5"), const("0.25"))
        analyzer = Analyzer()
        root = analyzer.analyze(tree)
        self.assertEqual(root.bound, 0)
        self.assertEqual(root.rounded, 0.75)


class TestCli(unittest.TestCase):
    def run_cli(self, tree):
        proc = subprocess.run(
            [sys.executable, str(ROOT / "analyzer.py")],
            input=json.dumps(tree),
            capture_output=True,
            text=True,
        )
        self.assertEqual(proc.returncode, 0, msg=proc.stderr)
        return json.loads(proc.stdout)

    def test_cli_basic(self):
        out = self.run_cli(node("mul", const("0.1"), const("0.2")))
        self.assertIn("nodes", out)
        self.assertEqual(len(out["nodes"]), 3)
        root_node = out["nodes"][out["root"]]
        self.assertEqual(root_node["op"], "mul")
        self.assertEqual(root_node["status"], "ok")
        exact = Fraction(root_node["exact"])
        bound = Fraction(root_node["bound"])
        rounded = Fraction(root_node["rounded"])
        self.assertGreaterEqual(bound, abs(rounded - exact))

    def test_cli_div_by_zero(self):
        out = self.run_cli(node("div", const(1), const(0)))
        root_node = out["nodes"][out["root"]]
        self.assertEqual(root_node["status"], "div_by_zero")
        self.assertEqual(root_node["bound"], "inf")
        self.assertEqual(root_node["rounded"], "inf")

    def test_cli_overflow(self):
        out = self.run_cli(node("mul", const("1e308"), const("1e308")))
        root_node = out["nodes"][out["root"]]
        self.assertEqual(root_node["status"], "overflow")
        self.assertEqual(root_node["bound"], "inf")
        self.assertEqual(root_node["rounded"], "inf")

    def test_cli_invalid_json(self):
        proc = subprocess.run(
            [sys.executable, str(ROOT / "analyzer.py")],
            input="not json",
            capture_output=True,
            text=True,
        )
        self.assertEqual(proc.returncode, 1)
        self.assertIn("error", json.loads(proc.stdout))


if __name__ == "__main__":
    unittest.main()
