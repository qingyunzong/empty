import os
import random
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from all_different import check_feasible, propagate
from independent_check import (
    enumerate_solutions,
    exhaustive_supported_pairs,
    has_solution,
    is_all_different_solution,
    supported_pairs_to_domains,
)


def pairwise_fixed_assignment_ok(domains):
    """Naive check: only look at pairs of already-fixed variables.

    Returns True iff no two singleton domains carry the same value.
    This is deliberately insufficient for allDifferent feasibility.
    """
    fixed = [dom[0] for dom in domains.values() if len(dom) == 1]
    return len(set(fixed)) == len(fixed)


class TestRequiredCases(unittest.TestCase):
    def test_three_variables_domain_12_infeasible(self):
        domains = {"x": [1, 2], "y": [1, 2], "z": [1, 2]}
        result = check_feasible(domains)
        self.assertFalse(result.feasible)
        self.assertIsNone(result.witness)
        self.assertIsNotNone(result.hall_conflict)
        self.assertEqual(result.hall_conflict.variables, frozenset("xyz"))
        self.assertEqual(result.hall_conflict.values, frozenset({1, 2}))
        # Independent brute-force reference agrees.
        self.assertFalse(has_solution(domains))

    def test_fixed_value_removed_from_other_domains(self):
        domains = {"x": [1, 2, 3], "y": [1, 2], "z": [1]}
        prop = propagate(domains)
        self.assertTrue(prop.feasible)
        self.assertEqual(prop.pruned_domains["z"], [1])
        self.assertNotIn(1, prop.pruned_domains["x"])
        self.assertNotIn(1, prop.pruned_domains["y"])
        self.assertEqual(prop.pruned_domains, {"x": [3], "y": [2], "z": [1]})

    def test_pairwise_assigned_check_is_insufficient(self):
        # No two variables are fixed to the same value, so the naive
        # pairwise check accepts this -- yet {a,b,c} all live in {1,2},
        # which is a genuine Hall violation.
        domains = {"x": [5], "a": [1, 2], "b": [1, 2], "c": [1, 2]}
        self.assertTrue(pairwise_fixed_assignment_ok(domains))
        result = check_feasible(domains)
        self.assertFalse(result.feasible)
        self.assertIsNotNone(result.hall_conflict)

    def test_hall_conflict_is_a_real_violation(self):
        domains = {"x": [1, 2], "y": [1, 2], "z": [1, 2]}
        conflict = check_feasible(domains).hall_conflict
        neighborhood = {
            value
            for name in conflict.variables
            for value in domains[name]
        }
        self.assertEqual(set(conflict.values), neighborhood)
        self.assertGreater(len(conflict.variables), len(conflict.values))


class TestSupportFiltering(unittest.TestCase):
    def test_unsupported_value_removed_while_feasible(self):
        domains = {"x": [1, 2], "y": [1], "z": [1, 2, 3]}
        prop = propagate(domains)
        self.assertTrue(prop.feasible)
        self.assertEqual(prop.pruned_domains, {"x": [2], "y": [1], "z": [3]})
        self.assertEqual(prop.removed, {"x": [1], "y": [], "z": [1, 2]})

    def test_propagation_idempotent(self):
        domains = {"x": [1, 2, 3], "y": [1, 2], "z": [1, 2]}
        once = propagate(domains)
        twice = propagate(once.pruned_domains)
        self.assertTrue(twice.feasible)
        self.assertEqual(once.pruned_domains, twice.pruned_domains)

    def test_cycle_values_remain_supported(self):
        # 3 variables over {1,2}: infeasible; adding a fourth breaks the
        # Hall set and every edge on the alternating cycle stays supported.
        domains = {"x": [1, 2], "y": [2, 3], "z": [3, 1]}
        prop = propagate(domains)
        self.assertTrue(prop.feasible)
        self.assertEqual(prop.pruned_domains, domains)


class TestIndependentVerification(unittest.TestCase):
    def test_every_positive_claim_witness_validates_on_original(self):
        cases = [
            {"x": [1, 2], "y": [2, 3], "z": [3, 4]},
            {"a": [1], "b": [1, 2], "c": [2, 3]},
            {"p": [1, 2, 3], "q": [1, 2, 3]},
        ]
        for domains in cases:
            with self.subTest(domains=domains):
                result = check_feasible(domains)
                self.assertTrue(result.feasible)
                self.assertTrue(
                    is_all_different_solution(result.witness, domains)
                )

    def test_independent_checker_rejects_bad_assignments(self):
        domains = {"x": [1, 2], "y": [1, 2]}
        self.assertFalse(
            is_all_different_solution({"x": 1, "y": 1}, domains)
        )
        self.assertFalse(
            is_all_different_solution({"x": 3, "y": 2}, domains)
        )
        self.assertTrue(
            is_all_different_solution({"x": 1, "y": 2}, domains)
        )


class TestExhaustiveCrossCheck(unittest.TestCase):
    def test_random_small_instances_against_brute_force(self):
        rng = random.Random(20260927)
        checked = 0
        for _ in range(400):
            n = rng.randint(1, 5)
            universe = list(range(rng.randint(1, 4)))
            domains = {}
            for i in range(n):
                size = rng.randint(1, len(universe))
                domains[f"v{i}"] = sorted(rng.sample(universe, size))

            result = check_feasible(domains)
            brute_feasible = has_solution(domains)
            self.assertEqual(result.feasible, brute_feasible, domains)

            prop = propagate(domains)
            self.assertEqual(prop.feasible, brute_feasible, domains)

            if brute_feasible:
                # Claimed witness must satisfy the original constraint.
                self.assertTrue(
                    is_all_different_solution(result.witness, domains)
                )
                # Filtered support sets must equal brute-force supports.
                expected = supported_pairs_to_domains(
                    domains, exhaustive_supported_pairs(domains)
                )
                self.assertEqual(prop.pruned_domains, expected, domains)
                # Every surviving pair must be witnessed by a real solution.
                surviving = {
                    (name, value)
                    for name, dom in prop.pruned_domains.items()
                    for value in dom
                }
                used_pairs = {
                    (name, value)
                    for solution in enumerate_solutions(domains)
                    for name, value in solution.items()
                }
                self.assertEqual(surviving, used_pairs, domains)
            else:
                # Returned conflict must be a genuine Hall violation.
                conflict = result.hall_conflict
                neighborhood = {
                    value
                    for name in conflict.variables
                    for value in domains[name]
                }
                self.assertEqual(set(conflict.values), neighborhood, domains)
                self.assertGreater(
                    len(conflict.variables), len(conflict.values), domains
                )
            checked += 1
        self.assertGreaterEqual(checked, 400)


if __name__ == "__main__":
    unittest.main()
