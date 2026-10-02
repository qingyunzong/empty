import random
import unittest

from mincostflow import verify

from support import brute_force, make_solver, random_model


class TestAgainstBruteForce(unittest.TestCase):
    """Cross-check feasibility and optimal cost against full enumeration
    of every integer flow on small random networks."""

    def test_random_small_models(self):
        rng = random.Random(20261003)
        checked = {"feasible": 0, "infeasible": 0}
        for _ in range(200):
            demands, edges = random_model(rng)
            best_cost, _ = brute_force(demands, edges)
            result = make_solver(demands, edges).solve()

            self.assertEqual(result.feasible, best_cost is not None,
                             msg=f"{demands} {edges}")
            if best_cost is None:
                checked["infeasible"] += 1
                self.assertFalse(result.optimal)
                self.assertEqual(verify.check_cut_certificate(
                    demands, edges, result.certificate), [])
            else:
                checked["feasible"] += 1
                self.assertTrue(result.optimal)
                self.assertEqual(result.cost, best_cost,
                                 msg=f"{demands} {edges}")
                self.assertEqual(verify.check_optimality(
                    demands, edges, result.flow, result.potentials), [])
        # Make sure the random suite actually exercised both outcomes.
        self.assertGreater(checked["feasible"], 20)
        self.assertGreater(checked["infeasible"], 5)


if __name__ == "__main__":
    unittest.main()
