import unittest

from propcore.expr import compile_expr, evaluate
from propcore.generators import order_key
from propcore.runner import run_spec, shrink


def reference_minimal_int(low, high, expr):
    """Brute-force canonical minimal counterexample over a small domain."""
    code = compile_expr(expr)
    failing = [
        v for v in range(low, high + 1)
        if evaluate(code, v)[0] != "pass"
    ]
    return min(failing, key=order_key) if failing else None


def make_spec(gen, expr, name="p"):
    return {"properties": [{"name": name, "gen": gen, "expr": expr}]}


class AcceptanceAReferenceEnumerationTests(unittest.TestCase):
    """A: the shrunk counterexample matches reference enumeration."""

    def test_int_small_domain_matches_reference(self):
        gen = {"type": "int", "min": 0, "max": 5}
        expr = "value < 4"
        expected = reference_minimal_int(0, 5, expr)
        self.assertEqual(expected, 4)
        code = compile_expr(expr)
        for start in (4, 5):
            minimal, _ = shrink(code, gen, start, "PROPERTY_FAIL")
            self.assertEqual(minimal, expected)
        result = run_spec(make_spec(gen, expr), runs=50, seed=11)
        self.assertEqual(result["status"], "FAIL")
        self.assertEqual(len(result["failures"]), 1)
        self.assertEqual(result["failures"][0]["value"], expected)
        self.assertEqual(result["failures"][0]["kind"], "PROPERTY_FAIL")

    def test_list_shrinks_to_reference_minimum(self):
        gen = {"type": "list",
               "of": {"type": "int", "min": 0, "max": 3},
               "min_len": 0, "max_len": 3}
        expr = "len(value) < 2"
        code = compile_expr(expr)
        minimal, _ = shrink(code, gen, [3, 3, 3], "PROPERTY_FAIL")
        self.assertEqual(minimal, [0, 0])

    def test_dict_shrinks_to_reference_minimum(self):
        gen = {"type": "dict", "fields": {
            "a": {"type": "int", "min": 0, "max": 3},
            "b": {"type": "int", "min": 0, "max": 3},
        }}
        expr = "value['a'] + value['b'] < 2"
        code = compile_expr(expr)
        minimal, _ = shrink(code, gen, {"a": 3, "b": 3}, "PROPERTY_FAIL")
        self.assertEqual(minimal, {"a": 0, "b": 2})

    def test_oneof_shrinks_within_and_across_options(self):
        gen = {"type": "oneof", "options": [
            {"type": "int", "min": 0, "max": 2},
            {"type": "int", "min": 5, "max": 7},
        ]}
        expr = "value != 0"
        code = compile_expr(expr)
        # Cross-option: 6 shrinks to the canonical default 0.
        minimal, _ = shrink(code, gen, 6, "PROPERTY_FAIL")
        self.assertEqual(minimal, 0)
        # 2 also reaches the canonical minimum 0 (0 is both an in-option
        # candidate and option 1's default, and it fails the property).
        minimal, _ = shrink(code, gen, 2, "PROPERTY_FAIL")
        self.assertEqual(minimal, 0)


class AcceptanceDStableTieTests(unittest.TestCase):
    """D: tied minimal counterexamples are chosen stably."""

    def test_tie_broken_by_json_order_regardless_of_seed(self):
        gen = {"type": "int", "min": -3, "max": 3}
        expr = "abs(value) < 2"
        expected = reference_minimal_int(-3, 3, expr)
        self.assertEqual(expected, -2)  # "-2" < "2" in JSON order
        for seed in range(10):
            result = run_spec(make_spec(gen, expr), runs=30, seed=seed)
            self.assertEqual(result["status"], "FAIL")
            self.assertEqual(len(result["failures"]), 1)
            self.assertEqual(result["failures"][0]["value"], -2)

    def test_shrink_from_positive_side_converges_to_negative_tie(self):
        gen = {"type": "int", "min": -3, "max": 3}
        code = compile_expr("abs(value) < 2")
        for start in (2, 3, -3, -2):
            minimal, _ = shrink(code, gen, start, "PROPERTY_FAIL")
            self.assertEqual(minimal, -2)


if __name__ == "__main__":
    unittest.main()
