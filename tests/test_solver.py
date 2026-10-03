"""Core solver tests: bounds at every pause, budget edge cases, determinism."""

import json
import random
import unittest

from schcount import Constraint, Problem, Solver

from helpers import brute_force, random_problem


class TestBoundsAtEveryPause(unittest.TestCase):
    def check_every_pause(self, problem, exact, step, max_rounds):
        solver = Solver(problem)
        rounds = 0
        while True:
            result = solver.solve(budget=step)
            self.assertLessEqual(result["confirmed_lower"], exact)
            self.assertLessEqual(exact, result["certified_upper"])
            if not result["complete"]:
                self.assertIsNone(result["exact"])
            solver = Solver.from_checkpoint(solver.to_checkpoint())
            if result["complete"]:
                self.assertEqual(result["exact"], exact)
                return rounds
            rounds += 1
            self.assertLess(rounds, max_rounds, "search did not terminate")

    def test_small_problems_one_unit_budget(self):
        for seed in range(6):
            rng = random.Random(1000 + seed)
            problem = random_problem(rng, max_vars=4, max_dom=3)
            exact = brute_force(problem)
            with self.subTest(seed=seed, exact=exact):
                self.check_every_pause(problem, exact, step=1, max_rounds=200000)

    def test_seven_variable_problems(self):
        for seed in range(4):
            rng = random.Random(2000 + seed)
            problem = random_problem(rng, max_vars=7, max_dom=3)
            exact = brute_force(problem)
            with self.subTest(seed=seed, exact=exact):
                self.check_every_pause(problem, exact, step=7, max_rounds=200000)

    def test_matches_brute_force_unlimited(self):
        for seed in range(12):
            rng = random.Random(3000 + seed)
            problem = random_problem(rng, max_vars=6, max_dom=3)
            exact = brute_force(problem)
            result = Solver(problem).solve()
            self.assertTrue(result["complete"])
            self.assertEqual(result["exact"], exact)
            self.assertEqual(result["confirmed_lower"], exact)
            self.assertEqual(result["certified_upper"], exact)


class TestBudgetEdges(unittest.TestCase):
    def problem(self):
        p = Problem()
        p.add_variable("x", [0, 1, 2])
        p.add_variable("y", [0, 1, 2])
        p.add_constraint(Constraint("c1", ("x", "y"), [(0, 1), (1, 2)]))
        return p

    def test_budget_zero(self):
        result = Solver(self.problem()).solve(budget=0)
        self.assertEqual(result["confirmed_lower"], 0)
        self.assertEqual(result["certified_upper"], 9)
        self.assertFalse(result["complete"])
        self.assertIsNone(result["exact"])
        self.assertEqual(result["support_checks"], 0)

    def test_exact_completion(self):
        result = Solver(self.problem()).solve()
        self.assertTrue(result["complete"])
        self.assertEqual(result["exact"], 2)

    def test_budget_exhaustion_never_claims_unsat(self):
        p = Problem()
        p.add_variable("x", [0, 1])
        p.add_variable("y", [0, 1])
        p.add_constraint(Constraint("eq", ("x", "y"), [(0, 0), (1, 1)]))
        p.add_constraint(Constraint("ne", ("x", "y"), [(0, 1), (1, 0)]))
        result = Solver(p).solve(budget=0)
        self.assertFalse(result["complete"])
        self.assertIsNone(result["exact"])
        self.assertGreater(result["certified_upper"], 0)
        result = Solver(p).solve()
        self.assertTrue(result["complete"])
        self.assertEqual(result["exact"], 0)
        self.assertEqual(result["confirmed_lower"], 0)

    def test_deterministic_search(self):
        rng = random.Random(42)
        problem = random_problem(rng, max_vars=5, max_dom=3)
        a = Solver(problem)
        b = Solver(problem)
        a.solve(budget=13)
        b.solve(budget=13)
        self.assertEqual(
            json.dumps(a.to_checkpoint(), sort_keys=True),
            json.dumps(b.to_checkpoint(), sort_keys=True),
        )
        a.solve()
        b.solve()
        self.assertEqual(a.result(), b.result())


if __name__ == "__main__":
    unittest.main()
