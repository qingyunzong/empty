import unittest

from lazydfa import ClosureIndex, NFA


def make_cycle_nfa():
    # 0 -> 1 -> 2 -> 0 epsilon cycle, plus 2 -> 3 epsilon tail.
    nfa = NFA(4, start=0, finals=[3])
    e01 = nfa.add_edge(0, 1)
    e12 = nfa.add_edge(1, 2)
    e20 = nfa.add_edge(2, 0)
    e23 = nfa.add_edge(2, 3)
    return nfa, (e01, e12, e20, e23)


class ClosureIndexTest(unittest.TestCase):
    def test_epsilon_cycle_shares_one_scc(self):
        nfa, _ = make_cycle_nfa()
        idx = ClosureIndex(nfa)
        self.assertEqual(idx.scc_of(0), idx.scc_of(1))
        self.assertEqual(idx.scc_of(1), idx.scc_of(2))
        self.assertNotEqual(idx.scc_of(0), idx.scc_of(3))
        self.assertEqual(idx.closure({0}), frozenset({0, 1, 2, 3}))
        self.assertEqual(idx.closure({3}), frozenset({3}))

    def test_closure_updates_when_cycle_edge_removed(self):
        nfa, (_, _, e20, _) = make_cycle_nfa()
        idx = ClosureIndex(nfa)
        self.assertEqual(idx.closure({0}), frozenset({0, 1, 2, 3}))
        nfa.remove_edge(e20)  # splits the SCC 0->1->2->0
        # No stale closure may survive the SCC split.
        self.assertEqual(idx.closure({0}), frozenset({0, 1, 2, 3}))
        # 0 still reaches 1,2,3 via 0->1->2->3.
        self.assertEqual(idx.closure({3}), frozenset({3}))
        nfa2, (_, _, e20b, _) = make_cycle_nfa()
        idx2 = ClosureIndex(nfa2)
        nfa2.remove_edge(e20b)
        nfa2.remove_edge(1)  # remove 1->2 as well
        self.assertEqual(idx2.closure({0}), frozenset({0, 1}))
        self.assertEqual(idx2.closure({2}), frozenset({2, 3}))

    def test_closure_shrinks_after_tail_edge_removal(self):
        nfa, (_, _, _, e23) = make_cycle_nfa()
        idx = ClosureIndex(nfa)
        nfa.remove_edge(e23)
        self.assertEqual(idx.closure({0}), frozenset({0, 1, 2}))

    def test_eps_deps_track_edges_inside_closure(self):
        nfa, (e01, e12, e20, e23) = make_cycle_nfa()
        sym = nfa.add_edge(0, 3, lo=7, hi=9)
        idx = ClosureIndex(nfa)
        deps = idx.eps_deps({0})
        self.assertEqual(deps, frozenset({e01, e12, e20, e23}))
        self.assertNotIn(sym, deps)
        self.assertEqual(idx.eps_deps({3}), frozenset())

    def test_nested_cycles(self):
        nfa = NFA(5, start=0)
        nfa.add_edge(0, 1)
        nfa.add_edge(1, 0)      # cycle A: {0,1}
        nfa.add_edge(1, 2)
        nfa.add_edge(2, 3)
        nfa.add_edge(3, 2)      # cycle B: {2,3}
        nfa.add_edge(3, 4)
        idx = ClosureIndex(nfa)
        self.assertEqual(idx.closure({0}), frozenset({0, 1, 2, 3, 4}))
        self.assertEqual(idx.closure({2}), frozenset({2, 3, 4}))
        self.assertEqual(idx.closure({4}), frozenset({4}))


if __name__ == "__main__":
    unittest.main()
