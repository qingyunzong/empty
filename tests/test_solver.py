import itertools
import json
import random
import unittest

from exactcount import Problem, Solver, verify_certificate
from exactcount.reference import brute_force_count


def random_problem(rng, nvars):
    variables = {f"v{i}": [0, 1, 2] for i in range(nvars)}
    constraints = []
    for _ in range(rng.randint(1, max(1, nvars - 1))):
        k = rng.randint(1, min(3, nvars))
        scope = sorted(rng.sample(sorted(variables), k))
        tuples = [
            list(t)
            for t in itertools.product(*[variables[s] for s in scope])
            if rng.random() < 0.5
        ]
        constraints.append({"scope": scope, "tuples": tuples})
    return {"variables": variables, "constraints": constraints}


class SimpleCountTest(unittest.TestCase):
    def test_single_free_variable(self):
        solver = Solver(Problem({"x": [0, 1, 2]}))
        result = solver.solve()
        self.assertTrue(result["complete"])
        self.assertEqual(result["exact"], 3)
        self.assertEqual(result["checks_total"], 0)

    def test_equality_constraint(self):
        problem = Problem({"x": [0, 1, 2], "y": [0, 1, 2]})
        problem.add_constraint(["x", "y"], [[0, 0], [1, 1], [2, 2]])
        result = Solver(problem).solve()
        self.assertEqual(result["exact"], 3)
        self.assertEqual(result["confirmed_lower"], result["certified_upper"])

    def test_unsatisfiable(self):
        problem = Problem({"x": [0, 1, 2], "y": [0, 1, 2]})
        problem.add_constraint(["x", "y"], [])
        result = Solver(problem).solve()
        self.assertTrue(result["complete"])
        self.assertEqual(result["exact"], 0)

    def test_budget_exhaustion_never_claims_unsat_or_exact(self):
        problem = Problem({"x": [0, 1, 2], "y": [0, 1, 2]})
        problem.add_constraint(["x", "y"], [])  # actually unsatisfiable
        result = Solver(problem).solve(0)
        self.assertFalse(result["complete"])
        self.assertIsNone(result["exact"])
        self.assertEqual(result["confirmed_lower"], 0)
        self.assertGreater(result["certified_upper"], 0)

    def test_exact_only_when_bounds_equal(self):
        problem = Problem({"x": [0, 1, 2], "y": [0, 1, 2]})
        problem.add_constraint(["x", "y"], [[0, 0], [1, 1], [2, 2]])
        solver = Solver(problem)
        result = solver.solve(1)
        self.assertFalse(result["complete"])
        self.assertIsNone(result["exact"])
        self.assertLess(result["confirmed_lower"], result["certified_upper"])


class PauseResumeBoundsTest(unittest.TestCase):
    """Enumerate every solution (<=7 vars, 3 values each) and check the
    confirmed/certified bounds at every pause while resuming."""

    def test_bounds_at_every_pause(self):
        rng = random.Random(20261007)
        for trial in range(15):
            nvars = rng.randint(2, 7)
            pdict = random_problem(rng, nvars)
            exact = brute_force_count(pdict)
            problem = Problem.from_dict(pdict)
            solver = Solver(problem)
            budget = 0
            for step in range(300):
                result = solver.solve(budget)
                # The independent checker must accept the certificate at
                # every pause, not only at completion.
                self.assertEqual(
                    verify_certificate(solver.certificate()), [], pdict
                )
                # JSON round trip: resume as if in a fresh process.
                solver = Solver.from_checkpoint(
                    json.loads(json.dumps(solver.checkpoint())), problem
                )
                self.assertLessEqual(result["confirmed_lower"], exact, pdict)
                self.assertLessEqual(exact, result["certified_upper"], pdict)
                self.assertLessEqual(
                    result["confirmed_lower"], result["certified_upper"]
                )
                if result["complete"]:
                    self.assertEqual(
                        result["confirmed_lower"], result["certified_upper"]
                    )
                    self.assertEqual(result["exact"], exact, pdict)
                    break
                self.assertIsNone(result["exact"])
                self.assertLess(
                    result["confirmed_lower"], result["certified_upper"]
                )
                budget = 1 if budget == 0 else budget * 2
            else:
                self.fail(f"search did not terminate for {pdict}")

    def test_tiny_budgets_with_certificate_each_pause(self):
        rng = random.Random(99)
        for _ in range(8):
            pdict = random_problem(rng, rng.randint(2, 4))
            exact = brute_force_count(pdict)
            problem = Problem.from_dict(pdict)
            solver = Solver(problem)
            for step in range(2000):
                result = solver.solve(rng.randint(1, 3))
                self.assertEqual(verify_certificate(solver.certificate()), [])
                solver = Solver.from_checkpoint(
                    json.loads(json.dumps(solver.checkpoint())), problem
                )
                self.assertLessEqual(result["confirmed_lower"], exact)
                self.assertLessEqual(exact, result["certified_upper"])
                if result["complete"]:
                    self.assertEqual(result["exact"], exact)
                    break
            else:
                self.fail(f"no termination for {pdict}")

    def test_checkpoint_roundtrip_matches_uninterrupted(self):
        rng = random.Random(7)
        pdict = random_problem(rng, 5)
        problem = Problem.from_dict(pdict)
        reference = Solver(Problem.from_dict(pdict)).solve()
        solver = Solver(problem)
        solver.solve(3)
        restored = Solver.from_checkpoint(
            json.loads(json.dumps(solver.checkpoint())), problem
        )
        result = restored.solve()
        self.assertEqual(result["exact"], reference["exact"])
        self.assertEqual(result["confirmed_lower"], reference["confirmed_lower"])
        self.assertEqual(result["certified_upper"], reference["certified_upper"])


if __name__ == "__main__":
    unittest.main()
