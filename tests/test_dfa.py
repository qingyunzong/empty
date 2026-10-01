import unittest

from symdfa import (
    GapError,
    InverseIndex,
    OverlapError,
    SymbolicDFA,
    merge_intervals,
    reachable,
)


def chain_dfa(length, finals=()):
    """Chain 0 -0-> 1 -0-> ... with 1-loops on every state."""
    transitions = {}
    for s in range(length):
        transitions[s] = [(0, 0, min(s + 1, length - 1)), (1, 1, s)]
    return SymbolicDFA(2, 0, set(finals), transitions)


class TestDFAValidation(unittest.TestCase):
    def test_overlap_rejected(self):
        with self.assertRaises(OverlapError):
            SymbolicDFA(10, 0, set(), {
                0: [(0, 5, 0), (4, 9, 1)],
                1: [(0, 9, 1)],
            })

    def test_gap_rejected(self):
        with self.assertRaises(GapError):
            SymbolicDFA(10, 0, set(), {
                0: [(0, 3, 0), (5, 9, 0)],
            })

    def test_incomplete_cover_rejected(self):
        with self.assertRaises(GapError):
            SymbolicDFA(10, 0, set(), {0: [(0, 8, 0)]})

    def test_unknown_target_rejected(self):
        with self.assertRaises(Exception):
            SymbolicDFA(2, 0, set(), {0: [(0, 1, 7)]})

    def test_step_run_accepts(self):
        dfa = chain_dfa(3, finals={2})
        self.assertTrue(dfa.accepts([0, 0]))
        self.assertTrue(dfa.accepts([0, 1, 0]))
        self.assertFalse(dfa.accepts([0, 1, 1]))
        self.assertEqual(dfa.step(0, 1), 0)

    def test_reachable(self):
        dfa = SymbolicDFA(2, 0, {2}, {
            0: [(0, 1, 0)],
            1: [(0, 1, 1)],
            2: [(0, 1, 2)],
        })
        self.assertEqual(reachable(dfa), {0})

    def test_merge_intervals_event_sweep(self):
        self.assertEqual(
            merge_intervals([(5, 7), (0, 2), (3, 4), (9, 9)]),
            ((0, 7), (9, 9)),
        )


class TestInverseIndex(unittest.TestCase):
    def test_build_and_replace(self):
        dfa = chain_dfa(3)
        index = InverseIndex.build(dfa)
        entries = sorted(index.entries_into({2}))
        self.assertEqual(entries, [(0, 0, 1), (0, 0, 2), (1, 1, 2)])
        # Rewire state 1 to point at 0 on char 0.
        index.replace_source(1, [(0, 0, 0), (1, 1, 1)])
        entries = sorted(index.entries_into({2}))
        self.assertEqual(entries, [(0, 0, 2), (1, 1, 2)])
        entries = sorted(index.entries_into({0}))
        self.assertEqual(entries, [(0, 0, 1), (1, 1, 0)])

    def test_copy_is_independent(self):
        dfa = chain_dfa(2)
        index = InverseIndex.build(dfa)
        clone = index.copy()
        clone.replace_source(0, [(0, 1, 1)])
        self.assertNotEqual(index.by_source[0], clone.by_source[0])


if __name__ == "__main__":
    unittest.main()
