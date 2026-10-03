"""Tests for the state-pair distinguishing graph."""
import unittest

from mealy.machine import ERROR_OUTPUT, FAULT_STATE, MachineError, MealyMachine
from mealy.pairs import PairAnalysis

from machines import (
    adaptive_only_machine,
    equivalent_machine,
    partial_machine,
    simple_machine,
)


class TestPairGraph(unittest.TestCase):
    def test_shortest_witnesses(self):
        machine = simple_machine()
        analysis = PairAnalysis(machine)
        self.assertEqual(analysis.distance("s1", "s2"), 1)
        self.assertEqual(analysis.witness("s1", "s2"), ["b"])
        self.assertEqual(analysis.distance("s1", "s3"), 1)
        self.assertEqual(analysis.witness("s2", "s3"), ["a"])

    def test_witness_actually_separates(self):
        machine = simple_machine()
        analysis = PairAnalysis(machine)
        states = machine.states
        for i, s in enumerate(states):
            for t in states[i + 1:]:
                witness = analysis.witness(s, t)
                self.assertIsNotNone(witness)
                self.assertEqual(len(witness), analysis.distance(s, t))
                self.assertNotEqual(
                    machine.simulate_outputs(s, witness),
                    machine.simulate_outputs(t, witness),
                )

    def test_equivalent_states_and_closure_evidence(self):
        machine = equivalent_machine()
        analysis = PairAnalysis(machine)
        self.assertFalse(analysis.distinguishable("E1", "E2"))
        self.assertIsNone(analysis.witness("E1", "E2"))
        classes = analysis.equivalent_classes()
        self.assertIn(["E1", "E2"], classes)
        evidence = analysis.closure_evidence()
        self.assertEqual(len(evidence), 1)
        entry = evidence[0]
        self.assertEqual(entry["pair"], ["E1", "E2"])
        self.assertEqual({c["input"] for c in entry["checks"]}, {"x", "y"})
        for check in entry["checks"]:
            self.assertIn(check["successor_status"], ("same-state", "equivalent"))
            ns, nt = check["successors"]
            if ns != nt:
                self.assertFalse(analysis.distinguishable(ns, nt))

    def test_fault_state_distinguishable_from_all(self):
        machine = partial_machine()
        analysis = PairAnalysis(machine)
        for state in machine.user_states:
            self.assertTrue(analysis.distinguishable(state, FAULT_STATE))
        witness = analysis.witness("S1", "S2")
        self.assertEqual(witness, ["b"])
        self.assertEqual(machine.simulate_outputs("S1", witness), [ERROR_OUTPUT])

    def test_adaptive_only_machine_is_pairwise_distinguishable(self):
        machine = adaptive_only_machine()
        analysis = PairAnalysis(machine)
        group = ["A1", "A2", "B1", "B2"]
        for i, s in enumerate(group):
            for t in group[i + 1:]:
                self.assertTrue(analysis.distinguishable(s, t), f"pair {s},{t}")
        self.assertEqual(analysis.distance("A1", "A2"), 2)
        self.assertEqual(analysis.distance("B1", "B2"), 2)

    def test_state_limit(self):
        with self.assertRaises(MachineError):
            MealyMachine(
                states=[f"s{i}" for i in range(11)],
                inputs=["a"],
                transitions={},
            )

    def test_invalid_descriptions_rejected(self):
        with self.assertRaises(MachineError):
            MealyMachine(states=[], inputs=["a"])
        with self.assertRaises(MachineError):
            MealyMachine(states=["s"], inputs=[])
        with self.assertRaises(MachineError):
            MealyMachine(
                states=["s"], inputs=["a"],
                transitions={"s": {"a": ["nowhere", "0"]}},
            )
        with self.assertRaises(MachineError):
            MealyMachine(states=["__bad__"], inputs=["a"])


if __name__ == "__main__":
    unittest.main()
