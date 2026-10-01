"""Propagation correctness tests, cross-checked against the naive
AC-3 reference that pregenerates all allowed value pairs."""

import random
import unittest

from csp_arith import propagate
from tests.reference import ac3_reference


class AcceptanceScenario1Test(unittest.TestCase):
    """x in {1,2,3}, y in {2,3}, x < y."""

    def setUp(self):
        self.domains = {"x": [1, 2, 3], "y": [2, 3]}
        self.constraints = [("lt", "x", "y")]
        self.result = propagate(self.domains, self.constraints)

    def test_domains_match_tuple_based_reference(self):
        ref_status, ref_domains = ac3_reference(self.domains, self.constraints)
        self.assertEqual(ref_status, self.result["status"])
        self.assertEqual(ref_domains, self.result["domains"])
        self.assertEqual({"x": [1, 2], "y": [2, 3]}, self.result["domains"])

    def test_single_pruned_value(self):
        self.assertEqual("consistent", self.result["status"])
        pruned = [(e["variable"], e["value"]) for e in self.result["explanations"]]
        self.assertEqual([("x", 3)], pruned)
        self.assertNotIn("conflict", self.result)


class TupleTableCrossCheckTest(unittest.TestCase):
    """Randomised differential test: lazy propagation must produce the
    exact same arc-consistency result as AC-3 over pregenerated tuples."""

    def test_random_problems_match_reference(self):
        rng = random.Random(20261001)
        checked_consistent = 0
        checked_inconsistent = 0
        for _ in range(1000):
            n_vars = rng.randint(2, 5)
            names = ["v%d" % i for i in range(n_vars)]
            domains = {}
            for name in names:
                lo = rng.randint(-4, 4)
                size = rng.randint(1, 5)
                values = sorted({lo + rng.randint(0, 4) for _ in range(size)})
                domains[name] = values
            constraints = []
            for _ in range(rng.randint(1, 6)):
                ctype = rng.choice(["lt", "le", "eq", "ne"])
                var_a = rng.choice(names)
                var_b = rng.choice(names)
                constraints.append((ctype, var_a, var_b))

            result = propagate(domains, constraints)
            ref_status, ref_domains = ac3_reference(domains, constraints)
            self.assertEqual(
                ref_status,
                result["status"],
                msg="status mismatch for %r %r" % (domains, constraints),
            )
            if ref_status == "consistent":
                # Arc consistency is confluent: final domains must be
                # identical to the tuple-based reference.
                checked_consistent += 1
                self.assertEqual(
                    ref_domains,
                    result["domains"],
                    msg="domain mismatch for %r %r" % (domains, constraints),
                )
            else:
                checked_inconsistent += 1
                self.assertIn("conflict", result)
                wiped = result["conflict"]["variable"]
                self.assertEqual([], result["domains"][wiped])
        # Sanity: the random suite must exercise both outcomes.
        self.assertGreater(checked_consistent, 50)
        self.assertGreater(checked_inconsistent, 20)

    def test_opposite_direction_arcs_are_not_deduplicated(self):
        # Regression: lt(v1, v0) and lt(v0, v1) produce arcs with the
        # same (target, ctype, other) key but opposite semantics; both
        # must be propagated (together they are unsatisfiable).
        domains = {"v0": [1, 2], "v1": [1, 2, 3, 4]}
        constraints = [
            ("ne", "v1", "v0"),
            ("le", "v0", "v1"),
            ("lt", "v1", "v0"),
            ("lt", "v0", "v1"),
        ]
        result = propagate(domains, constraints)
        ref_status, _ = ac3_reference(domains, constraints)
        self.assertEqual("inconsistent", ref_status)
        self.assertEqual(ref_status, result["status"])

    def test_each_constraint_type_in_isolation(self):
        cases = [
            (("lt", "a", "b"), {"a": [1, 5, 9], "b": [3, 7]}),
            (("le", "a", "b"), {"a": [1, 5, 9], "b": [3, 7]}),
            (("eq", "a", "b"), {"a": [1, 2, 3], "b": [2, 3, 4]}),
            (("ne", "a", "b"), {"a": [1, 2], "b": [2]}),
        ]
        for constraint, domains in cases:
            with self.subTest(constraint=constraint, domains=domains):
                result = propagate(domains, [constraint])
                ref_status, ref_domains = ac3_reference(domains, [constraint])
                self.assertEqual(ref_status, result["status"])
                if ref_status == "consistent":
                    self.assertEqual(ref_domains, result["domains"])

    def test_chain_propagation_matches_reference(self):
        domains = {"a": [1, 2, 3], "b": [1, 2, 3], "c": [1, 2, 3]}
        constraints = [("lt", "a", "b"), ("lt", "b", "c"), ("ne", "a", "c")]
        result = propagate(domains, constraints)
        ref_status, ref_domains = ac3_reference(domains, constraints)
        self.assertEqual(ref_status, result["status"])
        self.assertEqual(ref_domains, result["domains"])
        self.assertEqual({"a": [1], "b": [2], "c": [3]}, result["domains"])

    def test_self_constraints_reach_true_fixpoint(self):
        # x < x is unsatisfiable: repeated revision must empty the domain.
        result = propagate({"x": [4, 6, 7]}, [("lt", "x", "x")])
        self.assertEqual("inconsistent", result["status"])
        self.assertEqual([], result["domains"]["x"])
        ref_status, _ = ac3_reference({"x": [4, 6, 7]}, [("lt", "x", "x")])
        self.assertEqual(ref_status, result["status"])

        # x != x wipes out a singleton but leaves larger domains intact.
        result = propagate({"x": [1]}, [("ne", "x", "x")])
        self.assertEqual("inconsistent", result["status"])
        result = propagate({"x": [1, 2]}, [("ne", "x", "x")])
        self.assertEqual("consistent", result["status"])
        self.assertEqual({"x": [1, 2]}, result["domains"])

        # x == x never prunes anything.
        result = propagate({"x": [1, 2]}, [("eq", "x", "x")])
        self.assertEqual("consistent", result["status"])
        self.assertEqual([], result["explanations"])

        # Mixed self- and cross-variable constraints (the case that
        # exposed the fixpoint bug in the differential test).
        domains = {"v0": [3, 6, 7], "v1": [4, 6, 7]}
        constraints = [("lt", "v1", "v1"), ("lt", "v0", "v1"), ("ne", "v0", "v1")]
        result = propagate(domains, constraints)
        ref_status, ref_domains = ac3_reference(domains, constraints)
        self.assertEqual(ref_status, result["status"])
        self.assertEqual(ref_domains, result["domains"])


if __name__ == "__main__":
    unittest.main()
