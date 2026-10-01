"""Explanation and conflict tests (acceptance scenarios 1, 2 and 4)."""

import unittest

from csp_arith import Propagator
from tests.reference import naive_traced_propagate

EXPLANATION_KEYS = {"var", "value", "constraint", "constraint_id", "other_var", "premise"}


def run(variables, constraints):
    prop = Propagator(variables, constraints)
    consistent = prop.propagate()
    return consistent, prop


class ExplanationShapeTest(unittest.TestCase):
    def test_explanations_contain_only_direct_premises(self):
        variables = {"a": [1, 2, 3, 4], "b": [2, 3], "c": [3]}
        constraints = [(0, "lt", "a", "b"), (1, "le", "b", "c"), (2, "ne", "a", "c")]
        _, prop = run(variables, constraints)
        report = prop.explanation_report()
        self.assertTrue(report)
        for entries in report.values():
            for expl in entries:
                # no extra fields, no unrelated propagation operations
                self.assertEqual(set(expl), EXPLANATION_KEYS)
                premise = expl["premise"]
                self.assertEqual(set(premise) & {"max", "min", "values", "value"},
                                 set(premise) - {"var"})
                self.assertEqual(premise["var"], expl["other_var"])
                # exactly one bound/value premise
                self.assertEqual(len(premise), 2)


class ConflictExplanationTest(unittest.TestCase):
    """Acceptance scenario 2: conflict equals the naive dependency-chain
    enumeration of the last value-removal event."""

    PROBLEMS = [
        # single-revision wipe-out: x > 5 impossible for all of x
        ({"x": [1, 2, 3], "y": [5]}, [(0, "lt", "y", "x")]),
        # multi-step: x<y prunes x, then y<z empties y
        (
            {"x": [1, 2, 3], "y": [2, 3], "z": [1]},
            [(0, "lt", "x", "y"), (1, "lt", "y", "z")],
        ),
        # eq-chain wipe-out
        (
            {"a": [1, 2], "b": [2, 3], "c": [3, 4]},
            [(0, "eq", "a", "b"), (1, "eq", "b", "c")],
        ),
    ]

    def test_conflict_matches_naive_trace(self):
        for variables, constraints in self.PROBLEMS:
            with self.subTest(variables=variables, constraints=constraints):
                consistent, prop = run(variables, constraints)
                self.assertFalse(consistent)
                _, trace = naive_traced_propagate(variables, constraints)
                self.assertTrue(trace)
                last = trace[-1]
                self.assertEqual(last["var"], prop.conflict_var)
                # conflict = explanations of the last value-removal event
                self.assertEqual(
                    sorted(prop.conflict, key=lambda e: e["value"]),
                    sorted(last["removed"], key=lambda e: e["value"]),
                )

    def test_conflict_is_usable_as_nogood(self):
        variables = {"x": [1, 2, 3], "y": [5]}
        constraints = [(0, "gt", "x", "y")]
        consistent, prop = run(variables, constraints)
        self.assertFalse(consistent)
        self.assertEqual(prop.conflict_var, "x")
        # every wiped value of x is explained by the same premise y <= 5
        self.assertEqual(len(prop.conflict), 3)
        for expl in prop.conflict:
            self.assertEqual(expl["constraint"], "gt")
            self.assertEqual(expl["premise"], {"var": "y", "min": 5})


class SingletonVariableTest(unittest.TestCase):
    """Acceptance scenario 4: explanations with single-valued variables."""

    def test_ne_with_singleton_other(self):
        variables = {"x": [2], "y": [1, 2, 3]}
        constraints = [(0, "ne", "x", "y")]
        consistent, prop = run(variables, constraints)
        self.assertTrue(consistent)
        self.assertEqual(prop.sorted_domains(), {"x": [2], "y": [1, 3]})
        report = prop.explanation_report()
        # y=2 removed because x == 2 (singleton domain)
        self.assertEqual(
            report["y"],
            [
                {
                    "var": "y",
                    "value": 2,
                    "constraint": "ne",
                    "constraint_id": 0,
                    "other_var": "x",
                    "premise": {"var": "x", "value": 2},
                }
            ],
        )

    def test_eq_with_singleton_other(self):
        variables = {"x": [2], "y": [1, 2, 3]}
        constraints = [(0, "eq", "x", "y")]
        consistent, prop = run(variables, constraints)
        self.assertTrue(consistent)
        self.assertEqual(prop.sorted_domains(), {"x": [2], "y": [2]})
        report = prop.explanation_report()
        self.assertEqual(
            report["y"],
            [
                {
                    "var": "y",
                    "value": 1,
                    "constraint": "eq",
                    "constraint_id": 0,
                    "other_var": "x",
                    "premise": {"var": "x", "values": [2]},
                },
                {
                    "var": "y",
                    "value": 3,
                    "constraint": "eq",
                    "constraint_id": 0,
                    "other_var": "x",
                    "premise": {"var": "x", "values": [2]},
                },
            ],
        )

    def test_lt_with_singleton_other(self):
        variables = {"x": [1, 2, 3], "y": [2]}
        constraints = [(0, "lt", "x", "y")]
        consistent, prop = run(variables, constraints)
        self.assertTrue(consistent)
        self.assertEqual(prop.sorted_domains(), {"x": [1], "y": [2]})
        report = prop.explanation_report()
        self.assertEqual(
            [e["premise"] for e in report["x"]],
            [{"var": "y", "max": 2}, {"var": "y", "max": 2}],
        )
        self.assertEqual([e["value"] for e in report["x"]], [2, 3])


if __name__ == "__main__":
    unittest.main()
