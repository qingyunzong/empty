import unittest

from symdfa import SymbolicDFA
from symdfa.intervals import IntervalError


def chain_dfa():
    # 0 -a-> 1 -a-> 2 (final, loops on a,b); alphabet {a,b}
    return SymbolicDFA(2, 3, 0, [2], [
        [([(0, 0)], 1)],
        [([(0, 0)], 2)],
        [([(0, 1)], 2)],
    ])


class TestAutomaton(unittest.TestCase):
    def test_accepts(self):
        dfa = chain_dfa()
        self.assertTrue(dfa.accepts([0, 0]))
        self.assertTrue(dfa.accepts([0, 0, 1, 0]))
        self.assertFalse(dfa.accepts([0]))
        self.assertFalse(dfa.accepts([1]))  # no edge -> reject

    def test_overlapping_edge_labels_rejected(self):
        with self.assertRaises(IntervalError):
            SymbolicDFA(4, 2, 0, [], [
                [([(0, 2)], 1), ([(2, 3)], 1)],
                [],
            ])

    def test_intervals_spanning_edges_rejected(self):
        with self.assertRaises(IntervalError):
            SymbolicDFA(4, 2, 0, [], [
                [([(0, 1), (2, 3)], 1), ([(1, 2)], 1)],
                [],
            ])

    def test_trim_drops_unreachable(self):
        dfa = SymbolicDFA(2, 4, 0, [2, 3], [
            [([(0, 0)], 1)],
            [([(0, 0)], 2)],
            [([(0, 1)], 2)],
            [([(0, 1)], 3)],  # unreachable final
        ])
        trimmed = dfa.trim()
        self.assertEqual(trimmed.num_states, 3)
        self.assertEqual(trimmed.finals, frozenset({2}))
        self.assertEqual(trimmed.start, 0)

    def test_roundtrip_dict(self):
        dfa = chain_dfa()
        clone = SymbolicDFA.from_dict(dfa.to_dict())
        self.assertEqual(clone.to_dict(), dfa.to_dict())


if __name__ == "__main__":
    unittest.main()
