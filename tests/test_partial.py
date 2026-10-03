"""Tests for partial transition functions and the fault-state completion."""
import unittest

from mealy.machine import ERROR_OUTPUT, FAULT_STATE, MealyMachine
from mealy.pairs import PairAnalysis
from mealy.tree import Solver, tree_to_json
from mealy.verify import check_certificate

from machines import partial_machine


class TestPartialTransitions(unittest.TestCase):
    def test_completion_adds_fault_state(self):
        machine = partial_machine()
        self.assertIn(FAULT_STATE, machine.states)
        self.assertEqual(machine.output("S1", "b"), ERROR_OUTPUT)
        self.assertEqual(machine.successor("S1", "b"), FAULT_STATE)
        for inp in machine.inputs:
            self.assertEqual(machine.output(FAULT_STATE, inp), ERROR_OUTPUT)
            self.assertEqual(machine.successor(FAULT_STATE, inp), FAULT_STATE)

    def test_error_output_distinguishes(self):
        machine = partial_machine()
        result = Solver(machine).solve(["S1", "S2"])
        self.assertEqual(result["status"], "optimal")
        self.assertEqual(result["depth"], 1)
        tree = tree_to_json(result["tree"])
        self.assertEqual(tree["input"], "b")
        self.assertEqual(
            tree["children"][ERROR_OUTPUT], {"type": "leaf", "state": "S1"}
        )
        self.assertEqual(tree["children"]["1"], {"type": "leaf", "state": "S2"})
        check = check_certificate(machine, tree, ["S1", "S2"])
        self.assertTrue(check["valid"], check["errors"])

    def test_roundtrip_preserves_partialness(self):
        machine = partial_machine()
        clone = MealyMachine.from_dict(machine.to_dict())
        self.assertNotIn("b", clone.to_dict()["transitions"]["S1"])
        self.assertEqual(clone.output("S1", "b"), ERROR_OUTPUT)
        self.assertEqual(clone.successor("S1", "b"), FAULT_STATE)

    def test_fully_undefined_state_equals_fault(self):
        machine = MealyMachine(states=["only"], inputs=["a", "b"], transitions={})
        for inp in machine.inputs:
            self.assertEqual(machine.output("only", inp), ERROR_OUTPUT)
        # A state with no defined transitions behaves exactly like the
        # fault state, so the two are indistinguishable.
        analysis = PairAnalysis(machine)
        self.assertFalse(analysis.distinguishable("only", FAULT_STATE))
        result = Solver(machine).solve(["only", FAULT_STATE])
        self.assertEqual(result["status"], "infeasible")
        self.assertEqual(result["equivalent_pairs"], [["only", FAULT_STATE]])


if __name__ == "__main__":
    unittest.main()
