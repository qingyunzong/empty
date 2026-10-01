"""Minimal-explanation tests: every pruned value must map to exactly
the direct premise that triggered its removal (acceptance scenarios
1, 2 and 4).
"""

import unittest

from csp_arith import propagate
from tests.reference import naive_dependency_chain_explanations


class Scenario1ExplanationTest(unittest.TestCase):
    """x in {1,2,3}, y in {2,3}, x < y: the explanation for x=3 must
    equal the hand-computed minimal premise, nothing more."""

    def test_explanation_equals_manual_minimal_premise(self):
        result = propagate({"x": [1, 2, 3], "y": [2, 3]}, [("lt", "x", "y")])
        # Hand computation: x=3 loses its only support because
        # max(domain(y)) == 3 and 3 < 3 is false.  The minimal direct
        # premise is exactly (constraint lt, other bound max(y) = 3).
        expected = [
            {
                "variable": "x",
                "value": 3,
                "constraint": "lt",
                "vars": ["x", "y"],
                "premise": {"max": 3},
            }
        ]
        self.assertEqual(expected, result["explanations"])

    def test_explanation_contains_no_irrelevant_operations(self):
        result = propagate({"x": [1, 2, 3], "y": [2, 3]}, [("lt", "x", "y")])
        for explanation in result["explanations"]:
            self.assertEqual(
                {"variable", "value", "constraint", "vars", "premise"},
                set(explanation),
            )


class Scenario2ConflictTest(unittest.TestCase):
    """Domain wipe-out: the conflict explanation must equal the naive
    enumeration of all propagation dependency chains."""

    def test_conflict_matches_naive_dependency_chains(self):
        # a=1 forces b={2} (via ne), b={2} forces c={2} (via eq),
        # then c < a removes c=2 and empties c.
        domains = {"a": [1], "b": [1, 2], "c": [1, 2]}
        constraints = [("ne", "a", "b"), ("eq", "b", "c"), ("lt", "c", "a")]
        result = propagate(domains, constraints)
        self.assertEqual("inconsistent", result["status"])
        self.assertIn("conflict", result)

        naive = naive_dependency_chain_explanations(domains, constraints)
        self.assertIsNotNone(naive)
        naive_variable, naive_explanations = naive
        self.assertEqual(naive_variable, result["conflict"]["variable"])
        self.assertEqual("c", result["conflict"]["variable"])
        # Same dependency chains, order-insensitive.
        self.assertEqual(
            sorted(map(str, naive_explanations)),
            sorted(map(str, result["conflict"]["explanations"])),
        )

    def test_conflict_is_usable_as_nogood(self):
        domains = {"a": [1], "b": [1, 2], "c": [1, 2]}
        constraints = [("ne", "a", "b"), ("eq", "b", "c"), ("lt", "c", "a")]
        result = propagate(domains, constraints)
        conflict = result["conflict"]
        # The conflict covers every value of the wiped domain: each
        # value of c has exactly one explanation.
        explained_values = sorted(e["value"] for e in conflict["explanations"])
        self.assertEqual([1, 2], explained_values)
        # Hand-computed minimal premises:
        # c=1 removed by eq(b, c) because 1 not in domain(b) == {2};
        # c=2 removed by lt(c, a) because max(domain(a)) == 1.
        self.assertIn(
            {
                "variable": "c",
                "value": 1,
                "constraint": "eq",
                "vars": ["b", "c"],
                "premise": {"domain": [2]},
            },
            conflict["explanations"],
        )
        self.assertIn(
            {
                "variable": "c",
                "value": 2,
                "constraint": "lt",
                "vars": ["c", "a"],
                "premise": {"max": 1},
            },
            conflict["explanations"],
        )

    def test_single_constraint_wipeout(self):
        result = propagate({"x": [1, 2], "y": [3]}, [("eq", "x", "y")])
        self.assertEqual("inconsistent", result["status"])
        self.assertEqual("x", result["conflict"]["variable"])
        self.assertEqual(
            [
                {
                    "variable": "x",
                    "value": 1,
                    "constraint": "eq",
                    "vars": ["x", "y"],
                    "premise": {"domain": [3]},
                },
                {
                    "variable": "x",
                    "value": 2,
                    "constraint": "eq",
                    "vars": ["x", "y"],
                    "premise": {"domain": [3]},
                },
            ],
            result["conflict"]["explanations"],
        )
class Scenario4SingletonTest(unittest.TestCase):
    """Single-valued variables: explanations must match hand computation."""

    def test_ne_with_singletons_wipes_out(self):
        result = propagate({"x": [1], "y": [1]}, [("ne", "x", "y")])
        self.assertEqual("inconsistent", result["status"])
        # x=1 is removed because domain(y) is exactly {1}.
        self.assertEqual(
            [
                {
                    "variable": "x",
                    "value": 1,
                    "constraint": "ne",
                    "vars": ["x", "y"],
                    "premise": {"domain": [1]},
                }
            ],
            result["explanations"],
        )
        self.assertEqual(result["explanations"], result["conflict"]["explanations"])

    def test_singleton_prunes_other_side(self):
        # y <= x with x == 3 removes every y > 3; premise is max(domain(x)).
        result = propagate({"x": [3], "y": [1, 2, 3, 4, 5]}, [("le", "y", "x")])
        self.assertEqual("consistent", result["status"])
        self.assertEqual({"x": [3], "y": [1, 2, 3]}, result["domains"])
        for explanation, value in zip(result["explanations"], [4, 5]):
            self.assertEqual(
                {
                    "variable": "y",
                    "value": value,
                    "constraint": "le",
                    "vars": ["y", "x"],
                    "premise": {"max": 3},
                },
                explanation,
            )

    def test_reversed_arc_singleton_premise(self):
        # x < y with x == 5 removes every y <= 5; premise is min(domain(x)).
        result = propagate({"x": [5], "y": [3, 5, 7]}, [("lt", "x", "y")])
        self.assertEqual("consistent", result["status"])
        self.assertEqual({"x": [5], "y": [7]}, result["domains"])
        self.assertEqual(
            [
                {
                    "variable": "y",
                    "value": 3,
                    "constraint": "lt",
                    "vars": ["x", "y"],
                    "premise": {"min": 5},
                },
                {
                    "variable": "y",
                    "value": 5,
                    "constraint": "lt",
                    "vars": ["x", "y"],
                    "premise": {"min": 5},
                },
            ],
            result["explanations"],
        )

    def test_singletons_already_consistent(self):
        result = propagate({"x": [2], "y": [3]}, [("lt", "x", "y")])
        self.assertEqual("consistent", result["status"])
        self.assertEqual([], result["explanations"])
        self.assertEqual({"x": [2], "y": [3]}, result["domains"])


if __name__ == "__main__":
    unittest.main()
