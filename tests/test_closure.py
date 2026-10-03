import unittest

from lazydfa import NFA, ClosureIndex


class ClosureIndexTest(unittest.TestCase):
    def test_simple_chain(self):
        nfa = NFA(4, 0, accepting=[3])
        nfa.add_epsilon(0, 1)
        nfa.add_epsilon(1, 2)
        idx = ClosureIndex(nfa)
        self.assertEqual(idx.closure({0}), frozenset({0, 1, 2}))
        self.assertEqual(idx.closure({2}), frozenset({2}))
        self.assertEqual(idx.closure(set()), frozenset())

    def test_epsilon_cycle_is_one_scc(self):
        nfa = NFA(4, 0)
        nfa.add_epsilon(0, 1)
        nfa.add_epsilon(1, 2)
        nfa.add_epsilon(2, 0)  # cycle 0->1->2->0
        nfa.add_epsilon(2, 3)
        idx = ClosureIndex(nfa)
        self.assertEqual(idx.component_of(0), idx.component_of(1))
        self.assertEqual(idx.component_of(1), idx.component_of(2))
        self.assertNotEqual(idx.component_of(0), idx.component_of(3))
        self.assertEqual(idx.closure({0}), frozenset({0, 1, 2, 3}))
        self.assertEqual(idx.closure({3}), frozenset({3}))

    def test_removing_epsilon_edge_splits_scc(self):
        nfa = NFA(3, 0)
        nfa.add_epsilon(0, 1)
        nfa.add_epsilon(1, 2)
        back = nfa.add_epsilon(2, 0)  # closes the cycle
        idx = ClosureIndex(nfa)
        self.assertEqual(idx.closure({0}), frozenset({0, 1, 2}))
        nfa.remove_edge(back)  # SCC splits; old closures must not survive
        self.assertEqual(idx.closure({0}), frozenset({0, 1, 2}))
        self.assertEqual(idx.closure({1}), frozenset({1, 2}))
        self.assertEqual(idx.closure({2}), frozenset({2}))
        self.assertNotEqual(idx.component_of(0), idx.component_of(2))

    def test_stale_cache_not_reused_after_mutation(self):
        nfa = NFA(2, 0)
        idx = ClosureIndex(nfa)
        self.assertEqual(idx.closure({0}), frozenset({0}))
        nfa.add_epsilon(0, 1)
        self.assertEqual(idx.closure({0}), frozenset({0, 1}))


if __name__ == "__main__":
    unittest.main()
