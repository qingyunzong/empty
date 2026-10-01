import unittest

from symdfa import DFA, DFAError


class TestDFABasics(unittest.TestCase):
    def test_implicit_sink_rejects(self):
        dfa = DFA(2, 0, {1}, {0: [(0, 9, 1)]})
        self.assertFalse(dfa.accepts([10]))        # no transition -> sink
        self.assertFalse(dfa.accepts([0, 5]))      # state 1 has no transition
        self.assertTrue(dfa.accepts([0]))
        self.assertIsNone(dfa.step(1, 0))

    def test_interval_boundaries(self):
        dfa = DFA(2, 0, {1}, {0: [(0, 65535, 1)]})
        self.assertEqual(dfa.step(0, 0), 1)
        self.assertEqual(dfa.step(0, 65535), 1)

    def test_overlapping_intervals_rejected_at_construction(self):
        with self.assertRaises(DFAError):
            DFA(2, 0, set(), {0: [(0, 10, 1), (10, 20, 1)]})

    def test_interval_out_of_range(self):
        with self.assertRaises(DFAError):
            DFA(2, 0, set(), {0: [(0, 65536, 1)]})

    def test_atomic_overlapping_update_rejected(self):
        dfa = DFA(3, 0, set(), {0: [(0, 10, 1), (20, 30, 2)]})
        before = {s: list(ivs) for s, ivs in dfa.transitions.items()}
        version = dfa.version
        with self.assertRaises(DFAError):
            dfa.set_transition(0, 5, 25, 1)   # overlaps both, illegal
        self.assertEqual(dfa.transitions, before)  # untouched
        self.assertEqual(dfa.version, version)     # no version bump

    def test_exact_replacement_and_disjoint_addition(self):
        dfa = DFA(3, 0, set(), {0: [(0, 10, 1)]})
        self.assertTrue(dfa.set_transition(0, 0, 10, 2))   # exact replace
        self.assertEqual(dfa.step(0, 5), 2)
        self.assertFalse(dfa.set_transition(0, 20, 30, 1))  # disjoint add
        self.assertEqual(dfa.step(0, 25), 1)
        self.assertEqual(dfa.version, 2)

    def test_json_roundtrip(self):
        dfa = DFA(2, 0, {1}, {0: [(0, 9, 1)]})
        dfa.set_transition(1, 100, 200, 0)
        clone = DFA.from_json(dfa.to_json())
        self.assertEqual(clone.version, dfa.version)
        self.assertEqual(clone.transitions, dfa.transitions)
        self.assertEqual(clone.accepting, dfa.accepting)


if __name__ == "__main__":
    unittest.main()
