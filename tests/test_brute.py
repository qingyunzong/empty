import random
import unittest

from mealy_dist.brute import (
    exhaustive_check,
    optimal_adaptive_depth,
    optimal_preset_length,
)
from mealy_dist.machine import MealyMachine
from mealy_dist.solver import DistinguishingTreeSolver
from mealy_dist.tree import check_certificate

from fixtures import (
    equivalent_machine,
    gap_machine,
    no_preset_machine,
    partial_no_experiment_machine,
    same_output_machine,
    three_state_machine,
)


class TestPresetEnumeration(unittest.TestCase):
    def test_preset_lengths(self):
        self.assertEqual(optimal_preset_length(three_state_machine()), 2)
        self.assertEqual(optimal_preset_length(gap_machine()), 3)

    def test_no_preset_sequence_exists(self):
        # Pairwise distinguishable, yet no single input sequence works.
        self.assertIsNone(optimal_preset_length(no_preset_machine(), max_depth=12))

    def test_impossible_machine(self):
        self.assertIsNone(optimal_preset_length(equivalent_machine()))


class TestAdaptiveEnumeration(unittest.TestCase):
    def test_adaptive_depths(self):
        self.assertEqual(optimal_adaptive_depth(three_state_machine()), 2)
        self.assertEqual(optimal_adaptive_depth(gap_machine()), 2)
        self.assertEqual(optimal_adaptive_depth(no_preset_machine()), 4)
        self.assertIsNone(optimal_adaptive_depth(partial_no_experiment_machine()))
        self.assertIsNone(optimal_adaptive_depth(equivalent_machine()))

    def test_limits_enforced(self):
        machine = three_state_machine()
        with self.assertRaises(ValueError):
            optimal_adaptive_depth(machine, max_depth=99)
        # machines above 10 states are rejected at construction time
        with self.assertRaises(ValueError):
            MealyMachine(
                states=tuple(f"s{i}" for i in range(11)),
                inputs=("a",), outputs=("0",), transitions={},
            )

    def test_exhaustive_check_consistency(self):
        for machine in (three_state_machine(), gap_machine(), no_preset_machine(),
                        same_output_machine()):
            status = DistinguishingTreeSolver(machine).solve()
            report = exhaustive_check(machine, status.best_height)
            self.assertTrue(report["consistent"], report)


class TestRandomizedCrossCheck(unittest.TestCase):
    def test_solver_matches_brute_force(self):
        rng = random.Random(20261001)
        checked = 0
        for _ in range(60):
            n = rng.choice((2, 3, 4))
            states = tuple(f"s{i}" for i in range(n))
            inputs = ("a", "b")
            outputs = ("0", "1")
            transitions = {}
            for state in states:
                row = {}
                for symbol in inputs:
                    if rng.random() < 0.85:  # include partial machines
                        row[symbol] = (rng.choice(states), rng.choice(outputs))
                transitions[state] = row
            machine = MealyMachine(
                states=states, inputs=inputs, outputs=outputs, transitions=transitions
            )
            status = DistinguishingTreeSolver(machine).solve(budget=100_000)
            brute = optimal_adaptive_depth(machine, max_depth=6)
            got = status.best_height if status.possible else None
            self.assertEqual(got, brute, machine.to_dict())
            if status.possible:
                self.assertTrue(status.optimal)
                ok, errors = check_certificate(machine, status.current_tree().to_dict())
                self.assertTrue(ok, errors)
            checked += 1
        self.assertGreater(checked, 0)


if __name__ == "__main__":
    unittest.main()
