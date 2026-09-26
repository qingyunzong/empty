import random
import unittest

from alldiff import (
    FilterResult,
    brute_force_solution,
    exhaustive_supported_values,
    filter_domains,
    find_matching,
    validate_assignment,
)


class FeasibilityTests(unittest.TestCase):
    def test_three_vars_two_values_infeasible(self):
        domains = [{1, 2}, {1, 2}, {1, 2}]
        matching, conflict = find_matching(domains)
        self.assertIsNone(matching)
        self.assertEqual(conflict.variables, (0, 1, 2))
        self.assertEqual(conflict.neighborhood, (1, 2))
        self.assertEqual(conflict.deficit, 1)
        self.assertIsNone(brute_force_solution(domains))

    def test_feasible_matching_validated_by_independent_checker(self):
        domains = [{1, 2}, {2, 3}, {1, 3}, {3, 4}]
        matching, conflict = find_matching(domains)
        self.assertIsNone(conflict)
        self.assertTrue(validate_assignment(domains, matching))

    def test_empty_domain_infeasible(self):
        matching, conflict = find_matching([{1}, set()])
        self.assertIsNone(matching)
        self.assertIn(1, conflict.variables)
        self.assertIsNone(brute_force_solution([{1}, set()]))

    def test_empty_instance_feasible(self):
        matching, conflict = find_matching([])
        self.assertEqual(matching, ())
        self.assertIsNone(conflict)


class FilteringTests(unittest.TestCase):
    def test_fixed_value_removed_from_other_domains(self):
        domains = [{1}, {1, 2, 3}, {2, 3}]
        result = filter_domains(domains)
        self.assertTrue(result.feasible)
        self.assertEqual(result.domains[0], frozenset({1}))
        self.assertNotIn(1, result.domains[1])
        self.assertEqual(result.domains[1], frozenset({2, 3}))

    def test_not_just_pairwise_assigned_check(self):
        # 没有任何变量被赋值（无单值域），两两已赋值检查不会发现任何冲突，
        # 但 {x1,x2} 抢占 {1,2}，x3 的 1、2 必须被过滤掉。
        domains = [{1, 2}, {1, 2}, {1, 2, 3}]
        result = filter_domains(domains)
        self.assertTrue(result.feasible)
        self.assertEqual(result.domains[2], frozenset({3}))
        self.assertEqual(result.domains[0], frozenset({1, 2}))
        self.assertEqual(result.domains[1], frozenset({1, 2}))

    def test_filtering_preserves_all_solutions(self):
        domains = [{1, 2, 3}, {1, 2, 3}, {2, 3, 4}]
        result = filter_domains(domains)
        self.assertTrue(result.feasible)
        for x in range(3):
            self.assertEqual(result.domains[x], frozenset(domains[x]))

    def test_infeasible_filter_returns_hall_conflict(self):
        result = filter_domains([{1, 2}, {1, 2}, {1, 2}])
        self.assertFalse(result.feasible)
        self.assertEqual(result.conflict.variables, (0, 1, 2))
        self.assertEqual(result.conflict.neighborhood, (1, 2))

    def test_matching_is_valid_assignment(self):
        domains = [{1}, {1, 2, 3}, {2, 3}]
        result = filter_domains(domains)
        self.assertTrue(validate_assignment(domains, result.matching))


class ExhaustiveComparisonTests(unittest.TestCase):
    """小规模随机实例上，与独立穷举检查器全量对照。"""

    def test_random_instances_against_exhaustive(self):
        rng = random.Random(20260927)
        for trial in range(400):
            n = rng.randint(1, 6)
            universe = list(range(1, 8))
            domains = []
            for _ in range(n):
                k = rng.randint(1, len(universe))
                domains.append(set(rng.sample(universe, k)))
            with self.subTest(trial=trial, domains=domains):
                self._check_instance(domains)

    def _check_instance(self, domains):
        result = filter_domains(domains)
        brute_assignment = brute_force_solution(domains)
        if result.feasible:
            # 声称有解：独立检查器必须确认原约束可满足，且匹配本身是合法赋值。
            self.assertIsNotNone(brute_assignment)
            self.assertTrue(validate_assignment(domains, brute_assignment))
            self.assertTrue(validate_assignment(domains, result.matching))
            # 过滤结果必须与穷举支持集完全一致。
            expected = exhaustive_supported_values(domains)
            for x in range(len(domains)):
                self.assertEqual(set(result.domains[x]), set(expected[x]))
                self.assertTrue(set(result.domains[x]) <= set(domains[x]))
        else:
            # 声称不可行：独立检查器必须确认无解。
            self.assertIsNone(brute_assignment)
            # Hall 证据必须真实：邻域恰为变量集域的并，且 |S| > |N(S)|。
            conflict = result.conflict
            neighborhood = set()
            for x in conflict.variables:
                neighborhood |= domains[x]
            self.assertEqual(set(conflict.neighborhood), neighborhood)
            self.assertGreater(len(conflict.variables), len(conflict.neighborhood))


if __name__ == "__main__":
    unittest.main()
