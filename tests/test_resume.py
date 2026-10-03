"""Tests for budget-limited search and pause/resume."""
import unittest

from mealy.tree import Solver, tree_to_json
from mealy.verify import check_certificate

from machines import resume_machine

INITIALS = ["r1", "r2", "r3"]


class TestPauseResume(unittest.TestCase):
    def test_budget_exhaustion_returns_partial_with_lower_bound(self):
        machine = resume_machine()
        result = Solver(machine).solve(INITIALS, budget=1)
        self.assertEqual(result["status"], "partial")
        self.assertFalse(result["optimal"])
        # A valid (not necessarily optimal) tree is still returned...
        self.assertIsNotNone(result["tree"])
        tree = tree_to_json(result["tree"])
        check = check_certificate(machine, tree, INITIALS)
        self.assertTrue(check["valid"], check["errors"])
        # ... together with a certified lower bound, no optimality claim.
        self.assertIsNotNone(result["lower_bound"])
        self.assertLessEqual(result["lower_bound"], 2)
        self.assertGreaterEqual(result["upper_bound"], result["lower_bound"])
        self.assertIsNotNone(result["resume_state"])

    def test_resume_reaches_same_optimum_as_one_shot(self):
        machine = resume_machine()
        partial = Solver(machine).solve(INITIALS, budget=1)
        self.assertEqual(partial["status"], "partial")
        resumed = Solver(machine).solve(
            INITIALS, budget=100000, resume=partial["resume_state"]
        )
        self.assertEqual(resumed["status"], "optimal")
        one_shot = Solver(machine).solve(INITIALS, budget=100000)
        self.assertEqual(one_shot["status"], "optimal")
        self.assertEqual(resumed["depth"], one_shot["depth"])
        tree = tree_to_json(resumed["tree"])
        check = check_certificate(machine, tree, INITIALS)
        self.assertTrue(check["valid"], check["errors"])

    def test_incremental_budgets_converge(self):
        machine = resume_machine()
        state = None
        spent = 0
        final = None
        for _ in range(10):
            result = Solver(machine).solve(INITIALS, budget=2, resume=state)
            spent += 1
            if result["status"] == "optimal":
                final = result
                break
            self.assertEqual(result["status"], "partial")
            state = result["resume_state"]
        self.assertIsNotNone(final, "search did not converge")
        self.assertEqual(final["depth"], 2)
        self.assertGreater(spent, 1, "budget slices should actually pause")

    def test_resume_state_rejects_mismatched_initials(self):
        machine = resume_machine()
        partial = Solver(machine).solve(INITIALS, budget=1)
        with self.assertRaises(ValueError):
            Solver(machine).solve(
                ["r1", "r2"], budget=10, resume=partial["resume_state"]
            )

    def test_partial_does_not_claim_optimality(self):
        machine = resume_machine()
        for budget in (0, 1, 2, 3):
            result = Solver(machine).solve(INITIALS, budget=budget)
            if result["status"] == "partial":
                self.assertFalse(result["optimal"])
                self.assertNotEqual(result["lower_bound"], result["depth"])


if __name__ == "__main__":
    unittest.main()
