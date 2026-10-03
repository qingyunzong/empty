import unittest

from symdfa import MAX_CHAR, Machine, MachineError


def base_machine():
    return Machine.create(["q0", "q1"], "q0", ["q1"], {"q0": [[0, 10, "q1"]]})


class TestValidation(unittest.TestCase):
    def test_overlapping_intervals_rejected(self):
        with self.assertRaises(MachineError):
            Machine.create(["q0"], "q0", [], {"q0": [[0, 5, "q0"], [5, 9, "q0"]]})

    def test_out_of_range_rejected(self):
        with self.assertRaises(MachineError):
            Machine.create(["q0"], "q0", [], {"q0": [[-1, 5, "q0"]]})
        with self.assertRaises(MachineError):
            Machine.create(["q0"], "q0", [], {"q0": [[0, MAX_CHAR + 1, "q0"]]})

    def test_unknown_target_rejected(self):
        with self.assertRaises(MachineError):
            Machine.create(["q0"], "q0", [], {"q0": [[0, 5, "nope"]]})

    def test_unknown_states_rejected(self):
        with self.assertRaises(MachineError):
            Machine.create(["q0"], "nope", [])
        with self.assertRaises(MachineError):
            Machine.create(["q0"], "q0", ["nope"])

    def test_implicit_sink(self):
        m = base_machine()
        self.assertIsNone(m.step("q0", 100))
        self.assertIsNone(m.step(None, 5))
        self.assertFalse(m.accepts([100]))
        self.assertFalse(m.accepts([5, 100]))
        self.assertTrue(m.accepts([5]))

    def test_json_roundtrip(self):
        m = base_machine().add_transition("q1", 3, 4, "q0")
        self.assertEqual(Machine.from_json(m.to_json()), m)


class TestUpdates(unittest.TestCase):
    def test_overlapping_add_rejected_atomically(self):
        m = base_machine()
        with self.assertRaises(MachineError):
            m.add_transition("q0", 5, 20, "q1")
        self.assertEqual(m.version, 0)
        self.assertEqual(m.intervals("q0"), ((0, 10, "q1"),))
        self.assertEqual(m.changes, ())

    def test_overlapping_replace_rejected_atomically(self):
        m = base_machine().add_transition("q0", 20, 30, "q1")
        with self.assertRaises(MachineError):
            m.replace_transition("q0", 0, 10, 25, 40, "q1")
        self.assertEqual(m.version, 1)
        self.assertEqual(m.intervals("q0"), ((0, 10, "q1"), (20, 30, "q1")))

    def test_add_success_bumps_version(self):
        m = base_machine()
        m2 = m.add_transition("q0", 20, 30, "q0")
        self.assertEqual(m2.version, 1)
        self.assertEqual(m2.intervals("q0"), ((0, 10, "q1"), (20, 30, "q0")))
        self.assertEqual(m2.changes, ((1, "q0", 20, 30),))
        self.assertEqual(m.version, 0)

    def test_replace_transition(self):
        m = base_machine()
        m2 = m.replace_transition("q0", 0, 10, 0, 10, "q0")
        self.assertEqual(m2.intervals("q0"), ((0, 10, "q0"),))
        self.assertEqual(m2.version, 1)

    def test_remove_transition(self):
        m = base_machine()
        m2 = m.remove_transition("q0", 0, 10)
        self.assertEqual(m2.intervals("q0"), ())
        with self.assertRaises(MachineError):
            m.remove_transition("q0", 3, 4)

    def test_update_errors(self):
        m = base_machine()
        with self.assertRaises(MachineError):
            m.add_transition("ghost", 0, 1, "q0")
        with self.assertRaises(MachineError):
            m.add_transition("q0", 0, 1, "ghost")
        with self.assertRaises(MachineError):
            m.add_transition("q0", 10, 5, "q0")


if __name__ == "__main__":
    unittest.main()
