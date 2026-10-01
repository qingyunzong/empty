import random
import unittest

from sheetcalc import E_DIV0, CycleError, Sheet
from sheetcalc.parser import eval_ast, parse, refs_of


def oracle_values(exprs):
    """Full from-scratch recompute: name -> value for every defined cell."""
    asts = {name: parse(src) for name, src in exprs.items()}
    values = {}

    def lookup(name):
        if name in values:
            return values[name]
        if name not in asts:
            values[name] = 0
            return 0
        values[name] = eval_ast(asts[name], lookup)
        return values[name]

    for name in asts:
        lookup(name)
    return values


class TestParser(unittest.TestCase):
    def test_precedence_and_parens(self):
        sheet = Sheet()
        sheet.set("A1", "1+2*3")
        self.assertEqual(sheet.get("A1"), 7)
        sheet.set("A2", "(1+2)*3")
        self.assertEqual(sheet.get("A2"), 9)
        sheet.set("A3", "-4 + 10 / 3")
        self.assertEqual(sheet.get("A3"), -1)  # truncating division

    def test_div_zero_fixed_error(self):
        sheet = Sheet()
        sheet.set("A1", "1/0")
        self.assertEqual(sheet.get("A1"), E_DIV0)
        sheet.set("B1", "A1+1")
        self.assertEqual(sheet.get("B1"), E_DIV0)  # error propagates


class TestIncremental(unittest.TestCase):
    def test_chain_recomputes_exactly_three(self):
        sheet = Sheet()
        sheet.set("A1", "B1+1")
        sheet.set("B1", "C1+1")
        sheet.set("C1", "1")
        self.assertEqual(sheet.get("A1"), 3)
        sheet.eval_count = 0
        sheet.set("C1", "5")
        self.assertEqual(sheet.eval_count, 3)  # C1, B1, A1 only
        self.assertEqual((sheet.get("A1"), sheet.get("B1"), sheet.get("C1")),
                         (7, 6, 5))

    def test_diamond_shared_subexpr_computed_once(self):
        sheet = Sheet()
        sheet.set("D1", "1")
        sheet.set("B1", "D1*2")
        sheet.set("C1", "D1*2")
        sheet.set("A1", "B1+C1")
        self.assertEqual(sheet.get("A1"), 4)
        sheet.eval_count = 0
        sheet.set("D1", "3")
        self.assertEqual(sheet.eval_count, 4)  # D1, B1, C1, A1 each once
        self.assertEqual(sheet.get("A1"), 12)

    def test_cycle_is_atomic(self):
        sheet = Sheet()
        sheet.set("A1", "B1")
        with self.assertRaises(CycleError):
            sheet.set("B1", "A1")
        # State unchanged: A1 still references B1, B1 still undefined.
        self.assertEqual(sheet.src["A1"], "B1")
        self.assertNotIn("B1", sheet.ast)
        self.assertEqual(sheet.get("A1"), 0)
        # Self-reference is also a cycle.
        with self.assertRaises(CycleError):
            sheet.set("A1", "A1+1")
        self.assertEqual(sheet.src["A1"], "B1")

    def test_repeat_set_is_noop(self):
        sheet = Sheet()
        sheet.set("A1", "1+1")
        sheet.set("B1", "A1*10")
        version_a = sheet.version["A1"]
        version_b = sheet.version["B1"]
        sheet.eval_count = 0
        sheet.set("A1", "1 + 1")  # same AST, different whitespace
        self.assertEqual(sheet.eval_count, 0)
        self.assertEqual(sheet.version["A1"], version_a)
        self.assertEqual(sheet.version["B1"], version_b)

    def test_unaffected_versions_not_bumped(self):
        sheet = Sheet()
        sheet.set("X1", "1")
        sheet.set("Y1", "2")
        sheet.set("Z1", "X1+Y1")
        version_y = sheet.version["Y1"]
        sheet.set("X1", "5")
        self.assertEqual(sheet.version["Y1"], version_y)
        self.assertEqual(sheet.get("Z1"), 7)

    def test_delete_sets_zero_and_drops_edges(self):
        sheet = Sheet()
        sheet.set("B1", "5")
        sheet.set("A1", "B1+1")
        self.assertEqual(sheet.get("A1"), 6)
        sheet.delete("B1")
        self.assertEqual(sheet.get("B1"), 0)
        self.assertEqual(sheet.get("A1"), 1)
        self.assertEqual(sheet.deps["B1"], set())
        # B1 no longer depends on anything; redefining it still propagates.
        sheet.set("B1", "9")
        self.assertEqual(sheet.get("A1"), 10)

    def test_undefined_reference_warns_and_uses_zero(self):
        sheet = Sheet()
        sheet.set("A1", "Z9+1")
        self.assertTrue(any("Z9" in w for w in sheet.warnings))
        self.assertEqual(sheet.get("A1"), 1)

    def test_dump_sorted_by_name(self):
        sheet = Sheet()
        sheet.set("B2", "2")
        sheet.set("A10", "1")
        sheet.set("A2", "A10+B2")
        names = [row[0] for row in sheet.dump()]
        self.assertEqual(names, sorted(names))
        self.assertEqual(names, ["A10", "A2", "B2"])


class TestRandomConsistency(unittest.TestCase):
    def test_random_20_nodes_matches_full_recompute(self):
        rng = random.Random(20261001)
        names = ["N%d" % i for i in range(20)]
        sheet = Sheet()
        exprs = {}

        def random_expr():
            parts = []
            for _ in range(rng.randint(1, 4)):
                if rng.random() < 0.5:
                    parts.append(str(rng.randint(0, 9)))
                else:
                    parts.append(rng.choice(names))
                parts.append(rng.choice(["+", "-", "*", "/"]))
            return " ".join(parts[:-1])

        for step in range(200):
            name = rng.choice(names)
            if rng.random() < 0.2:
                sheet.delete(name)
                exprs.pop(name, None)
            else:
                src = random_expr()
                try:
                    sheet.set(name, src)
                except CycleError:
                    continue  # atomic failure: state and oracle unchanged
                exprs[name] = src
            expected = oracle_values(exprs)
            for cell, value in expected.items():
                self.assertEqual(
                    sheet.value.get(cell, 0), value,
                    "step %d: cell %s" % (step, cell))
        # Every live cell in the engine matches the oracle at the end.
        self.assertEqual(len(sheet.dump()), len(exprs))


if __name__ == "__main__":
    unittest.main()
