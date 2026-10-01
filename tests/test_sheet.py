import os
import random
import subprocess
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sheet import E_DIV0, CycleError, ParseError, Sheet, parse

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_cli(stdin_text):
    env = dict(os.environ)
    env["PYTHONPATH"] = REPO_ROOT + os.pathsep + env.get("PYTHONPATH", "")
    return subprocess.run(
        [sys.executable, "-m", "sheet"],
        input=stdin_text,
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
        env=env,
    )


class TestAcceptanceAChain(unittest.TestCase):
    """A: chain A1=B1+1, B1=C1+1; changing C1 recomputes exactly 3 cells."""

    def test_chain_minimal_recompute(self):
        sheet = Sheet()
        sheet.set("A1", parse("B1 + 1"))
        sheet.set("B1", parse("C1 + 1"))
        sheet.set("C1", parse("1"))
        sheet.set("D1", parse("100"))  # unrelated cell
        versions_before = dict(sheet.versions)
        recomputes_before = sheet.recomputes

        sheet.set("C1", parse("5"))

        self.assertEqual(sheet.recomputes - recomputes_before, 3)
        self.assertEqual(sheet.values["C1"], 5)
        self.assertEqual(sheet.values["B1"], 6)
        self.assertEqual(sheet.values["A1"], 7)
        for cell in ("A1", "B1", "C1"):
            self.assertEqual(sheet.versions[cell], versions_before[cell] + 1)
        self.assertEqual(sheet.versions["D1"], versions_before["D1"])


class TestAcceptanceBDiamond(unittest.TestCase):
    """B: diamond with shared subexpression; each node computed once."""

    def test_diamond_single_recompute_per_node(self):
        sheet = Sheet()
        sheet.set("A1", parse("B1 + C1"))
        sheet.set("B1", parse("D1 * 2"))
        sheet.set("C1", parse("D1 * 3"))
        sheet.set("D1", parse("1"))
        recomputes_before = sheet.recomputes

        sheet.set("D1", parse("4"))

        # D1, B1, C1, A1: exactly 4 recomputes, A1 only once.
        self.assertEqual(sheet.recomputes - recomputes_before, 4)
        self.assertEqual(sheet.values["A1"], 20)
        self.assertEqual(sheet.values["B1"], 8)
        self.assertEqual(sheet.values["C1"], 12)


class TestAcceptanceCCycle(unittest.TestCase):
    """C: cycle A1=B1, B1=A1 must fail atomically."""

    def test_two_node_cycle_atomic(self):
        sheet = Sheet()
        sheet.set("A1", parse("B1"))
        snapshot = (dict(sheet.exprs), dict(sheet.values), dict(sheet.versions))
        with self.assertRaises(CycleError):
            sheet.set("B1", parse("A1"))
        self.assertEqual((sheet.exprs, sheet.values, sheet.versions), snapshot)
        self.assertNotIn("B1", sheet.exprs)

    def test_self_cycle(self):
        sheet = Sheet()
        with self.assertRaises(CycleError):
            sheet.set("A1", parse("A1 + 1"))
        self.assertNotIn("A1", sheet.exprs)

    def test_three_node_cycle_atomic(self):
        sheet = Sheet()
        sheet.set("A1", parse("B1"))
        sheet.set("B1", parse("C1"))
        snapshot = (dict(sheet.exprs), dict(sheet.values))
        with self.assertRaises(CycleError):
            sheet.set("C1", parse("A1"))
        self.assertEqual((sheet.exprs, sheet.values), snapshot)

    def test_cli_cycle_exit_3(self):
        result = run_cli("set A1 B1\nset B1 A1\n")
        self.assertEqual(result.returncode, 3)
        self.assertIn("cycle", result.stderr.lower())


class Oracle:
    """Brute-force full-recompute oracle over a final exprs dict."""

    def __init__(self, exprs):
        self.exprs = exprs
        self.memo = {}

    def value(self, cell):
        if cell in self.memo:
            return self.memo[cell]
        if cell not in self.exprs:
            return 0
        self.memo[cell] = self._eval(self.exprs[cell])
        return self.memo[cell]

    def _eval(self, node):
        kind = node[0]
        if kind == "num":
            return node[1]
        if kind == "ref":
            return self.value(node[1])
        if kind == "neg":
            value = self._eval(node[1])
            return E_DIV0 if value == E_DIV0 else -value
        left = self._eval(node[1])
        right = self._eval(node[2])
        if left == E_DIV0 or right == E_DIV0:
            return E_DIV0
        if kind == "add":
            return left + right
        if kind == "sub":
            return left - right
        if kind == "mul":
            return left * right
        if kind == "div":
            if right == 0:
                return E_DIV0
            quotient = abs(left) // abs(right)
            return -quotient if (left < 0) != (right < 0) else quotient
        raise AssertionError("bad node")


def random_ast(rng, index, names, depth=0):
    """Random AST for node `index`, referencing only lower-indexed nodes."""
    if depth >= 2 or index == 0 or rng.random() < 0.35:
        if index > 0 and rng.random() < 0.6:
            return ("ref", names[rng.randrange(index)])
        return ("num", rng.randint(0, 9))
    op = rng.choice(["add", "sub", "mul", "div"])
    return (op, random_ast(rng, index, names, depth + 1),
            random_ast(rng, index, names, depth + 1))


class TestAcceptanceDRandomVsOracle(unittest.TestCase):
    """D: random 20-node workloads must match full-recompute enumeration."""

    def test_random_matches_oracle(self):
        for seed in range(20):
            rng = random.Random(1000 + seed)
            names = ["N%d" % i for i in range(20)]
            sheet = Sheet()
            for i, name in enumerate(names):
                sheet.set(name, random_ast(rng, i, names))
            for _ in range(40):
                index = rng.randrange(20)
                if rng.random() < 0.25:
                    sheet.delete(names[index])
                else:
                    sheet.set(names[index], random_ast(rng, index, names))
            oracle = Oracle(sheet.exprs)
            for name in names:
                expected = oracle.value(name)
                if name in sheet.values:
                    actual = sheet.values[name]
                else:
                    actual = 0  # deleted cells read as 0
                self.assertEqual(
                    actual, expected,
                    "seed=%d cell=%s" % (seed, name),
                )


class TestSemantics(unittest.TestCase):
    def test_identical_expression_is_noop(self):
        sheet = Sheet()
        sheet.set("B1", parse("2"))
        sheet.set("A1", parse("B1 + 1"))
        recomputes = sheet.recomputes
        versions = dict(sheet.versions)
        sheet.set("A1", parse("  B1+1 "))  # same AST, different whitespace
        self.assertEqual(sheet.recomputes, recomputes)
        self.assertEqual(sheet.versions, versions)

    def test_delete_sets_zero_and_drops_edges(self):
        sheet = Sheet()
        sheet.set("B1", parse("5"))
        sheet.set("A1", parse("B1 + 1"))
        self.assertEqual(sheet.values["A1"], 6)
        sheet.delete("B1")
        self.assertEqual(sheet.values["A1"], 1)
        self.assertEqual(sheet.get("B1"), 0)
        self.assertNotIn("B1", sheet.exprs)
        # B1 no longer depends on anything; re-adding must not see stale edges.
        sheet.set("B1", parse("7"))
        self.assertEqual(sheet.values["A1"], 8)

    def test_delete_undefined_is_noop(self):
        sheet = Sheet()
        sheet.delete("Z9")
        self.assertEqual(sheet.recomputes, 0)

    def test_div_by_zero_sticky(self):
        sheet = Sheet()
        sheet.set("A1", parse("1 / 0"))
        sheet.set("B1", parse("A1 * 2"))
        self.assertEqual(sheet.values["A1"], E_DIV0)
        self.assertEqual(sheet.values["B1"], E_DIV0)
        sheet.set("A1", parse("8 / 2"))
        self.assertEqual(sheet.values["A1"], 4)
        self.assertEqual(sheet.values["B1"], 8)

    def test_truncating_division(self):
        sheet = Sheet()
        sheet.set("A1", parse("7 / 2"))
        sheet.set("B1", parse("-7 / 2"))
        sheet.set("C1", parse("7 / -2"))
        self.assertEqual(sheet.values["A1"], 3)
        self.assertEqual(sheet.values["B1"], -3)
        self.assertEqual(sheet.values["C1"], -3)

    def test_undefined_reference_reads_zero_with_warning(self):
        warnings = []
        sheet = Sheet()
        sheet.warn = warnings.append
        sheet.set("A1", parse("B1 + 3"))
        self.assertEqual(sheet.values["A1"], 3)
        self.assertTrue(any("B1" in w for w in warnings))
        # Later definition of B1 must propagate.
        sheet.set("B1", parse("10"))
        self.assertEqual(sheet.values["A1"], 13)

    def test_dump_sorted_by_name(self):
        sheet = Sheet()
        sheet.set("Z1", parse("1"))
        sheet.set("A1", parse("2"))
        sheet.set("M5", parse("3"))
        self.assertEqual([name for name, _ in sheet.dump()], ["A1", "M5", "Z1"])

    def test_no_propagation_when_value_unchanged(self):
        sheet = Sheet()
        sheet.set("B1", parse("2"))
        sheet.set("A1", parse("B1 * 0"))  # constantly 0
        versions = dict(sheet.versions)
        sheet.set("B1", parse("5"))  # B1 changes, A1 stays 0
        self.assertEqual(sheet.values["A1"], 0)
        # A1's dependency changed so it may be recomputed, but nothing beyond.
        self.assertEqual(sheet.versions["B1"], versions["B1"] + 1)


class TestParser(unittest.TestCase):
    def test_precedence_and_parens(self):
        sheet = Sheet()
        sheet.set("A1", parse("2 + 3 * 4"))
        sheet.set("B1", parse("(2 + 3) * 4"))
        sheet.set("C1", parse("-(1 + 2)"))
        self.assertEqual(sheet.values["A1"], 14)
        self.assertEqual(sheet.values["B1"], 20)
        self.assertEqual(sheet.values["C1"], -3)

    def test_parse_errors(self):
        for bad in ("1 +", "(1", "1 2", "1 & 2", "", "1 + * 2"):
            with self.assertRaises(ParseError, msg=bad):
                parse(bad)


class TestCli(unittest.TestCase):
    def test_parse_error_exit_2(self):
        result = run_cli("set A1 1 +\n")
        self.assertEqual(result.returncode, 2)
        self.assertIn("error", result.stderr.lower())

    def test_unknown_command_exit_2(self):
        result = run_cli("frobnicate A1\n")
        self.assertEqual(result.returncode, 2)

    def test_get_and_dump(self):
        result = run_cli(
            "set B1 3\n"
            "set A1 = B1 * 2 + 1\n"
            "get A1\n"
            "dump\n"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = result.stdout.splitlines()
        self.assertEqual(lines[0], "7")
        self.assertEqual(lines[1:], ["A1 = 7", "B1 = 3"])

    def test_undefined_reference_warning_on_stderr(self):
        result = run_cli("set A1 B1 + 1\nget A1\n")
        self.assertEqual(result.returncode, 0)
        self.assertIn("warning", result.stderr.lower())
        self.assertIn("B1", result.stderr)
        self.assertEqual(result.stdout.strip(), "1")

    def test_div_zero_output(self):
        result = run_cli("set A1 1/0\nget A1\n")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.strip(), E_DIV0)

    def test_del_via_cli(self):
        result = run_cli("set B1 5\nset A1 B1+1\ndel B1\nget A1\n")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.strip(), "1")


if __name__ == "__main__":
    unittest.main()
