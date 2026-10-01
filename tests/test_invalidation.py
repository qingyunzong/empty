import itertools
import unittest

from lazydfa import ACCEPT, REJECT, LazyDFA, NFA, interp_accepts


def cycle_nfa():
    # 0 -[0]-> 1 -eps-> 2 -[1]-> 3(final) -eps-> 1
    # Language: 0 (11)* 1  i.e. "01", "011", "0111", ...
    nfa = NFA(4, start=0, finals=[3])
    e0 = nfa.add_edge(0, 1, lo=0, hi=0)
    e1 = nfa.add_edge(1, 2)
    e2 = nfa.add_edge(2, 3, lo=1, hi=1)
    e3 = nfa.add_edge(3, 1)
    return nfa, (e0, e1, e2, e3)


def assert_matches_interpreter(testcase, nfa, dfa, alphabet=(0, 1, 2),
                               max_len=4):
    dfa.expand_all()
    for length in range(max_len + 1):
        for tup in itertools.product(alphabet, repeat=length):
            want = ACCEPT if interp_accepts(nfa, tup) else REJECT
            testcase.assertEqual(dfa.query(tup), want,
                                 msg=f"string {tup}")


class InvalidationTest(unittest.TestCase):
    def test_removing_cycle_epsilon_edge_shrinks_language(self):
        nfa, (_, _, _, e3) = cycle_nfa()
        dfa = LazyDFA(nfa)
        dfa.expand_all()
        self.assertEqual(dfa.query([0, 1]), ACCEPT)
        self.assertEqual(dfa.query([0, 1, 1]), ACCEPT)
        self.assertEqual(dfa.query([0, 1, 1, 1]), ACCEPT)

        nfa.remove_edge(e3)  # break the loop back edge
        # Closure index must not keep the stale closure through 3->1.
        self.assertEqual(dfa.closure_index.closure({3}), frozenset({3}))
        assert_matches_interpreter(self, nfa, dfa)
        self.assertEqual(dfa.query([0, 1]), ACCEPT)
        self.assertEqual(dfa.query([0, 1, 1]), REJECT)
        self.assertEqual(dfa.query([0, 1, 1, 1]), REJECT)

    def test_removing_symbol_edge_shrinks_language(self):
        nfa, (_, _, e2, _) = cycle_nfa()
        dfa = LazyDFA(nfa)
        dfa.expand_all()
        self.assertEqual(dfa.query([0, 1]), ACCEPT)
        nfa.remove_edge(e2)  # remove 2 -[1]-> 3
        assert_matches_interpreter(self, nfa, dfa)
        self.assertEqual(dfa.query([0, 1]), REJECT)
        self.assertEqual(dfa.query([]), REJECT)

    def test_adding_edges_grows_language(self):
        nfa, _ = cycle_nfa()
        dfa = LazyDFA(nfa)
        dfa.expand_all()
        self.assertEqual(dfa.query([2]), REJECT)
        nfa.add_edge(0, 3, lo=2, hi=2)   # direct jump to the final
        assert_matches_interpreter(self, nfa, dfa)
        self.assertEqual(dfa.query([2]), ACCEPT)
        nfa.add_edge(3, 0)               # epsilon from final back to start
        assert_matches_interpreter(self, nfa, dfa)
        self.assertEqual(dfa.query([2, 0, 1]), ACCEPT)

    def test_unaffected_subtrees_survive_invalidation(self):
        # Two independent branches; mutating one must keep the other.
        nfa = NFA(5, start=0, finals=[2, 4])
        nfa.add_edge(0, 1, lo=0, hi=0)
        nfa.add_edge(1, 2, lo=1, hi=1)
        nfa.add_edge(0, 3, lo=5, hi=5)
        e_keep = nfa.add_edge(3, 4, lo=6, hi=6)
        dfa = LazyDFA(nfa)
        dfa.expand_all()
        before = {sid: dfa.subset_of(sid) for sid in dfa.state_ids()}
        nfa.remove_edge(e_keep)
        dfa.expand_all()
        # The branch through state 1 was untouched and keeps its ids.
        self.assertEqual(dfa.query([0, 1]), ACCEPT)
        self.assertEqual(dfa.query([5, 6]), REJECT)
        after = {sid: dfa.subset_of(sid) for sid in dfa.state_ids()}
        # The start state is an ancestor of the removed edge and is
        # rebuilt; only the strictly unaffected branch keeps its ids.
        kept = {sid for sid, sub in before.items() if sub and sub <= {1, 2}}
        self.assertTrue(kept)
        for sid in kept:
            self.assertIn(sid, after)
            self.assertEqual(after[sid], before[sid])

    def test_repeated_mutation_stays_consistent(self):
        nfa, (e0, e1, e2, e3) = cycle_nfa()
        dfa = LazyDFA(nfa)
        dfa.expand_all()
        nfa.remove_edge(e3)
        assert_matches_interpreter(self, nfa, dfa)
        nfa.add_edge(3, 1)  # restore the loop
        assert_matches_interpreter(self, nfa, dfa)
        self.assertEqual(dfa.query([0, 1, 1, 1]), ACCEPT)
        nfa.remove_edge(e1)  # cut 1 -eps-> 2 instead
        assert_matches_interpreter(self, nfa, dfa)
        self.assertEqual(dfa.query([0, 1]), REJECT)


if __name__ == "__main__":
    unittest.main()
