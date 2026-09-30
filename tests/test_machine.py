import unittest

from mealy_dist.machine import ERROR_OUTPUT, FAULT_STATE, MealyMachine

from fixtures import three_state_machine


class TestFaultSemantics(unittest.TestCase):
    def setUp(self):
        self.machine = MealyMachine(
            states=("s0", "s1"),
            inputs=("a", "b"),
            outputs=("0", "1"),
            transitions={"s0": {"a": ("s1", "0")}, "s1": {"b": ("s0", "1")}},
        )

    def test_undefined_transition_raises_error_output_and_faults(self):
        nxt, out = self.machine.step("s0", "b")
        self.assertEqual(out, ERROR_OUTPUT)
        self.assertEqual(nxt, FAULT_STATE)

    def test_fault_state_is_absorbing(self):
        outputs = self.machine.run("s0", ["b", "a", "a"])
        self.assertEqual(outputs, [ERROR_OUTPUT, ERROR_OUTPUT, ERROR_OUTPUT])
        self.assertEqual(self.machine.end_state("s0", ["b", "a"]), FAULT_STATE)

    def test_defined_transitions_behave_normally(self):
        self.assertEqual(self.machine.run("s0", ["a", "b"]), ["0", "1"])
        self.assertEqual(self.machine.end_state("s0", ["a", "b"]), "s0")

    def test_is_defined(self):
        self.assertTrue(self.machine.is_defined("s0", "a"))
        self.assertFalse(self.machine.is_defined("s1", "a"))


class TestValidation(unittest.TestCase):
    def test_state_limit(self):
        states = tuple(f"s{i}" for i in range(11))
        with self.assertRaises(ValueError):
            MealyMachine(states=states, inputs=("a",), outputs=("0",), transitions={})

    def test_ten_states_allowed(self):
        states = tuple(f"s{i}" for i in range(10))
        machine = MealyMachine(states=states, inputs=("a",), outputs=("0",), transitions={})
        self.assertEqual(len(machine.states), 10)

    def test_unknown_names_rejected(self):
        with self.assertRaises(ValueError):
            MealyMachine(
                states=("s0",), inputs=("a",), outputs=("0",),
                transitions={"s0": {"a": ("nowhere", "0")}},
            )
        with self.assertRaises(ValueError):
            MealyMachine(
                states=("s0",), inputs=("a",), outputs=("0",),
                transitions={"s0": {"a": ("s0", "mystery")}},
            )

    def test_reserved_names_rejected(self):
        with self.assertRaises(ValueError):
            MealyMachine(states=(FAULT_STATE,), inputs=("a",), outputs=("0",), transitions={})
        with self.assertRaises(ValueError):
            MealyMachine(states=("s0",), inputs=("a",), outputs=(ERROR_OUTPUT,), transitions={})


class TestSerialization(unittest.TestCase):
    def test_json_round_trip(self):
        machine = three_state_machine()
        clone = MealyMachine.from_json(machine.to_json())
        self.assertEqual(clone.states, machine.states)
        self.assertEqual(clone.inputs, machine.inputs)
        self.assertEqual(clone.outputs, machine.outputs)
        self.assertEqual(dict(clone.transitions), dict(machine.transitions))


if __name__ == "__main__":
    unittest.main()
