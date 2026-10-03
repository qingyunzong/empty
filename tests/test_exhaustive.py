"""Cross-check the optimised solver against independent brute force."""
import random
import unittest

from mealy.exhaustive import (
    min_adaptive_depth,
    min_preset_length,
    pairwise_witness_length,
)
from mealy.machine import MealyMachine
from mealy.pairs import PairAnalysis
from mealy.preset import min_preset_sequence
from mealy.tree import Solver

from machines import (
    ADAPTIVE_SET,
    SHARING_SET,
    adaptive_only_machine,
    cycle_machine,
    equivalent_machine,
    partial_machine,
    resume_machine,
    same_name_output_machine,
    sharing_machine,
    simple_machine,
)


def random_machine(rng, n_states=4, n_inputs=2, n_outputs=2, partial_prob=0.0):
    states = [f"s{i}" for i in range(n_states)]
    inputs = [f"i{k}" for k in range(n_inputs)]
    outputs = [f"o{j}" for j in range(n_outputs)]
    transitions = {}
    for s in states:
        row = {}
        for x in inputs:
            if rng.random() < partial_prob:
                continue
            row[x] = [rng.choice(states), rng.choice(outputs)]
        transitions[s] = row
    return MealyMachine(states=states, inputs=inputs, transitions=transitions)


class TestExhaustiveCrossCheck(unittest.TestCase):
    def check_machine(self, machine, initials):
        result = Solver(machine).solve(initials, budget=200000)
        brute = min_adaptive_depth(machine, initials)
        if brute is None:
            self.assertEqual(result["status"], "infeasible")
            self.assertTrue(result["evidence"])
            self.assertTrue(result["undistinguishable_subsets"])
        else:
            self.assertEqual(result["status"], "optimal")
            self.assertEqual(result["depth"], brute)

    def test_named_machines_match_brute_force(self):
        cases = [
            (simple_machine(), ["s1", "s2", "s3"]),
            (adaptive_only_machine(), ADAPTIVE_SET),
            (sharing_machine(), SHARING_SET),
            (partial_machine(), ["S1", "S2"]),
            (equivalent_machine(), ["E1", "E2", "E3"]),
            (same_name_output_machine(), ["N1", "N2", "N3"]),
            (resume_machine(), ["r1", "r2", "r3"]),
            (cycle_machine(), ["c1", "c2"]),
        ]
        for machine, initials in cases:
            with self.subTest(initials=initials):
                self.check_machine(machine, initials)

    def test_random_machines_match_brute_force(self):
        rng = random.Random(20261004)
        for trial in range(30):
            machine = random_machine(
                rng,
                n_states=rng.choice([3, 4]),
                n_inputs=2,
                n_outputs=2,
                partial_prob=rng.choice([0.0, 0.2]),
            )
            with self.subTest(trial=trial):
                self.check_machine(machine, machine.user_states)

    def test_larger_random_machines_match_brute_force(self):
        rng = random.Random(555)
        for trial in range(10):
            machine = random_machine(
                rng,
                n_states=5,
                n_inputs=rng.choice([2, 3]),
                n_outputs=rng.choice([2, 3]),
                partial_prob=rng.choice([0.0, 0.15]),
            )
            with self.subTest(trial=trial):
                self.check_machine(machine, machine.user_states)

    def test_pairwise_witness_lengths_match_brute_force(self):
        rng = random.Random(7)
        machines = [simple_machine(), adaptive_only_machine(), partial_machine()]
        machines += [random_machine(rng, n_states=4) for _ in range(5)]
        for machine in machines:
            analysis = PairAnalysis(machine)
            states = machine.states
            for i, s in enumerate(states):
                for t in states[i + 1:]:
                    brute = pairwise_witness_length(machine, s, t, max_len=12)
                    self.assertEqual(
                        analysis.distance(s, t), brute, f"pair {s},{t}"
                    )

    def test_preset_search_matches_full_enumeration(self):
        rng = random.Random(99)
        machines = [simple_machine(), adaptive_only_machine(), resume_machine()]
        machines += [random_machine(rng, n_states=3) for _ in range(5)]
        for machine in machines:
            initials = machine.user_states
            bfs = min_preset_sequence(machine, initials, max_len=4)
            length, _seq = min_preset_length(machine, initials, max_len=4)
            if length is None:
                self.assertIsNone(bfs)
            else:
                self.assertIsNotNone(bfs)
                self.assertEqual(len(bfs), length)


if __name__ == "__main__":
    unittest.main()
