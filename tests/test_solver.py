import unittest

from mealy_dist.solver import DistinguishingTreeSolver
from mealy_dist.tree import check_certificate, verify_tree

from fixtures import (
    budget_machine,
    equivalent_machine,
    gap_machine,
    no_preset_machine,
    partial_no_experiment_machine,
    shared_subproblem_machine,
    three_state_machine,
)


class TestOptimalTrees(unittest.TestCase):
    def solve(self, machine, **kwargs):
        return DistinguishingTreeSolver(machine).solve(**kwargs)

    def test_three_state_machine(self):
        machine = three_state_machine()
        status = self.solve(machine)
        self.assertTrue(status.optimal)
        self.assertEqual(status.best_height, 2)
        self.assertLessEqual(status.lower_bound, 2)
        ok, errors = check_certificate(machine, status.current_tree().to_dict())
        self.assertTrue(ok, errors)

    def test_adaptive_beats_preset(self):
        machine = gap_machine()
        status = self.solve(machine)
        self.assertTrue(status.optimal)
        self.assertEqual(status.best_height, 2)
        ok, errors = check_certificate(machine, status.current_tree().to_dict())
        self.assertTrue(ok, errors)

    def test_tree_without_preset_sequence(self):
        machine = no_preset_machine()
        status = self.solve(machine)
        self.assertTrue(status.optimal)
        self.assertEqual(status.best_height, 4)
        ok, errors = check_certificate(machine, status.current_tree().to_dict())
        self.assertTrue(ok, errors)

    def test_tree_is_adaptive(self):
        # The tree must branch on observed outputs: every internal node
        # chooses the next input per branch, and the root splits the
        # candidate set into more than one output class.
        machine = no_preset_machine()
        status = self.solve(machine)
        tree = status.current_tree()
        self.assertEqual(tree.kind, "node")
        self.assertGreater(len(tree.children), 1)
        ok, errors = verify_tree(machine, tree)
        self.assertTrue(ok, errors)


class TestImpossibility(unittest.TestCase):
    def test_equivalent_states_reported_with_closure(self):
        machine = equivalent_machine()
        status = DistinguishingTreeSolver(machine).solve()
        self.assertFalse(status.possible)
        self.assertFalse(status.optimal)
        report = status.to_dict()["indistinguishable"]
        self.assertIn(["e0", "e1"], report["classes"])
        # Closure evidence: within a class, equal outputs and successors
        # that stay inside common classes.
        classes = report["classes"]
        for entry in report["evidence"]:
            rows = {}
            for row in entry["closure"]:
                rows.setdefault(row["input"], []).append(row)
                self.assertIn(row["next"], row["next_class"])
            for symbol, group in rows.items():
                outputs = {row["output"] for row in group}
                next_classes = {tuple(row["next_class"]) for row in group}
                self.assertEqual(len(outputs), 1, f"outputs differ on {symbol}")
                self.assertEqual(len(next_classes), 1, f"successor classes differ on {symbol}")

    def test_pairwise_distinguishable_but_no_tree(self):
        # Completeness: impossibility is decided by exhaustive search,
        # not by a greedy failure; every pair here is distinguishable.
        machine = partial_no_experiment_machine()
        status = DistinguishingTreeSolver(machine).solve()
        self.assertFalse(status.possible)
        report = status.to_dict()["indistinguishable"]
        self.assertEqual(report["classes"], [])  # no equivalent pairs


class TestSharedSubproblems(unittest.TestCase):
    def test_memoised_subproblem_solved_once(self):
        machine = shared_subproblem_machine()
        status = DistinguishingTreeSolver(machine).solve()
        self.assertTrue(status.optimal)
        self.assertEqual(status.best_height, 3)
        # The set {s0, s1} appears under two different root branches and
        # is solved once through the memo table: only 4 expansions total.
        self.assertIn(frozenset(("s0", "s1")), status._memo)
        self.assertEqual(status.nodes_expanded, 4)
        ok, errors = check_certificate(machine, status.current_tree().to_dict())
        self.assertTrue(ok, errors)


class TestBudgetAndResume(unittest.TestCase):
    def test_budget_exhaustion_returns_tree_and_bound_without_optimality(self):
        machine = budget_machine()
        status = DistinguishingTreeSolver(machine).solve(budget=4)
        self.assertTrue(status.exhausted)
        self.assertFalse(status.optimal)
        tree = status.current_tree()
        self.assertIsNotNone(tree)
        self.assertEqual(tree.height(), 4)
        self.assertEqual(status.lower_bound, 3)
        self.assertLessEqual(status.lower_bound, tree.height())
        # The partial tree is still a valid distinguishing experiment.
        ok, errors = check_certificate(machine, tree.to_dict())
        self.assertTrue(ok, errors)
        data = status.to_dict()
        self.assertEqual(data["status"], "partial")
        self.assertFalse(data["optimal"])

    def test_resume_from_carried_state(self):
        machine = budget_machine()
        paused = DistinguishingTreeSolver(machine).solve(budget=4)
        self.assertTrue(paused.exhausted)
        resumed = DistinguishingTreeSolver(machine).solve(budget=100_000, carry=paused)
        self.assertTrue(resumed.optimal)
        self.assertEqual(resumed.best_height, 4)
        ok, errors = check_certificate(machine, resumed.current_tree().to_dict())
        self.assertTrue(ok, errors)

    def test_tiny_budget_then_fresh_run_agree(self):
        machine = three_state_machine()
        paused = DistinguishingTreeSolver(machine).solve(budget=1)
        self.assertTrue(paused.exhausted)
        self.assertFalse(paused.optimal)
        fresh = DistinguishingTreeSolver(machine).solve()
        self.assertTrue(fresh.optimal)
        self.assertEqual(fresh.best_height, 2)


if __name__ == "__main__":
    unittest.main()
