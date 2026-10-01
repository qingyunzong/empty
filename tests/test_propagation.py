"""Propagation result tests, cross-checked against the naive reference."""

import random
import unittest

from csp_arith import Propagator
from tests.reference import ac3_with_tuples


def run(variables, constraints):
    prop = Propagator(variables, constraints)
    consistent = prop.propagate()
    return consistent, prop


def assert_matches_reference(testcase, variables, constraints):
    """Library stops at the first wipe-out; the naive reference keeps
    revising afterwards, so once any domain is empty we only require the
    library to report inconsistency on an emptied domain."""
    consistent, prop = run(variables, constraints)
    expected = ac3_with_tuples(variables, constraints)
    if any(not domain for domain in expected.values()):
        testcase.assertFalse(consistent)
        testcase.assertEqual(prop.sorted_domains()[prop.conflict_var], [])
    else:
        testcase.assertTrue(consistent)
        testcase.assertEqual(prop.sorted_domains(), expected)
    return prop


class AcceptanceScenario1Test(unittest.TestCase):
    """x in {1,2,3}, y in {2,3}, x < y."""

    def setUp(self):
        self.variables = {"x": [1, 2, 3], "y": [2, 3]}
        self.constraints = [(0, "lt", "x", "y")]

    def test_domains_match_tuple_reference(self):
        consistent, prop = run(self.variables, self.constraints)
        self.assertTrue(consistent)
        self.assertEqual(prop.sorted_domains(), {"x": [1, 2], "y": [2, 3]})
        assert_matches_reference(self, self.variables, self.constraints)

    def test_explanation_of_x3_is_minimal(self):
        _, prop = run(self.variables, self.constraints)
        report = prop.explanation_report()
        self.assertEqual(list(report), ["x"])
        self.assertEqual(len(report["x"]), 1)
        expl = report["x"][0]
        # manual minimal premise: x=3 needs y > 3, but y <= max(D_y) = 3
        self.assertEqual(
            expl,
            {
                "var": "x",
                "value": 3,
                "constraint": "lt",
                "constraint_id": 0,
                "other_var": "y",
                "premise": {"var": "y", "max": 3},
            },
        )


class ReferenceComparisonTest(unittest.TestCase):
    """Propagation results must equal AC-3 over pre-generated tuples."""

    def test_all_ops_handcrafted(self):
        problems = [
            ({"x": [1, 2, 3], "y": [2, 3]}, [(0, "lt", "x", "y")]),
            ({"x": [1, 2, 3], "y": [2, 3]}, [(0, "le", "x", "y")]),
            ({"x": [1, 2, 3], "y": [2, 3]}, [(0, "eq", "x", "y")]),
            ({"x": [1, 2, 3], "y": [2, 3]}, [(0, "ne", "x", "y")]),
            (
                {"a": [1, 2, 3, 4], "b": [2, 3], "c": [1, 2, 3]},
                [(0, "lt", "a", "b"), (1, "eq", "b", "c"), (2, "ne", "a", "c")],
            ),
            (
                {"a": [5, 6, 7], "b": [1, 2], "c": [4, 5, 6]},
                [(0, "le", "a", "b"), (1, "lt", "b", "c"), (2, "ne", "c", "a")],
            ),
            ({"x": [1, 2], "y": [1], "z": [2]}, [(0, "eq", "x", "y"), (1, "eq", "x", "z")]),
        ]
        for variables, constraints in problems:
            with self.subTest(variables=variables, constraints=constraints):
                assert_matches_reference(self, variables, constraints)

    def test_random_problems_match_reference(self):
        rng = random.Random(20261001)
        ops = ["lt", "le", "eq", "ne"]
        for trial in range(60):
            n_vars = rng.randint(2, 5)
            names = [f"v{i}" for i in range(n_vars)]
            variables = {
                name: sorted(rng.sample(range(-5, 10), rng.randint(1, 6)))
                for name in names
            }
            constraints = []
            for cid in range(rng.randint(1, 7)):
                a, b = rng.choice(names), rng.choice(names)
                constraints.append((cid, rng.choice(ops), a, b))
            with self.subTest(trial=trial, variables=variables, constraints=constraints):
                assert_matches_reference(self, variables, constraints)

    def test_large_domain_without_pregenerated_tuples(self):
        # 200k values: pre-generating pairs would need ~2e10 tuples,
        # so this only terminates because supports are computed on the fly
        variables = {"x": list(range(200000)), "y": [100000]}
        constraints = [(0, "lt", "x", "y")]
        consistent, prop = run(variables, constraints)
        self.assertTrue(consistent)
        self.assertEqual(prop.sorted_domains()["x"], list(range(100000)))


if __name__ == "__main__":
    unittest.main()
