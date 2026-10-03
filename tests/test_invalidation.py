import unittest

from lazydfa import NFA, LazyDFA, ACCEPT, REJECT, UNKNOWN, interpreter


class InvalidationTest(unittest.TestCase):
    def test_delete_epsilon_cycle_edge_shrinks_closure_and_language(self):
        # 0 -eps-> 1 -eps-> 2 -eps-> 0 (cycle), 2 accepting.
        nfa = NFA(3, 0, accepting=[2])
        nfa.add_epsilon(0, 1)
        nfa.add_epsilon(1, 2)
        back = nfa.add_epsilon(2, 0)
        nfa.add_symbol_edge(0, 0, 97, 97)
        dfa = LazyDFA(nfa)
        dfa.expand()
        self.assertEqual(dfa.match([]), ACCEPT)  # 2 reachable via eps cycle
        nfa.remove_edge(back)  # splits the SCC
        dfa2 = LazyDFA(nfa)
        dfa2.expand()
        # Still accepts empty string (0->1->2 chain intact) but closures
        # from 2 must no longer include 0.
        self.assertEqual(dfa2.match([]), ACCEPT)
        self.assertEqual(dfa2.match([97]), ACCEPT)  # 0 -a-> 0, then eps to 2
        # Now remove the chain edge and confirm the language shrinks.
        nfa2 = NFA(3, 0, accepting=[2])
        e01 = nfa2.add_epsilon(0, 1)
        nfa2.add_epsilon(1, 2)
        nfa2.add_epsilon(2, 0)
        d = LazyDFA(nfa2)
        d.expand()
        self.assertEqual(d.match([]), ACCEPT)
        nfa2.remove_edge(e01)
        self.assertEqual(d.match([]), REJECT)  # closure of {0} is just {0}

    def test_delete_symbol_cycle_edge_shrinks_language(self):
        # Self-loop on 'a' plus exit on 'b' to accept: a*b
        nfa = NFA(2, 0, accepting=[1])
        loop = nfa.add_symbol_edge(0, 0, 97, 97)
        nfa.add_symbol_edge(0, 1, 98, 98)
        dfa = LazyDFA(nfa)
        dfa.expand()
        self.assertEqual(dfa.match([97, 97, 98]), ACCEPT)
        nfa.remove_edge(loop)  # language shrinks from a*b to b
        dfa.expand()
        self.assertEqual(dfa.match([97, 97, 98]), REJECT)
        self.assertEqual(dfa.match([98]), ACCEPT)
        self.assertEqual(dfa.match([97]), REJECT)

    def test_add_edge_grows_language(self):
        nfa = NFA(2, 0, accepting=[1])
        nfa.add_symbol_edge(0, 1, 97, 97)
        dfa = LazyDFA(nfa)
        dfa.expand()
        self.assertEqual(dfa.match([98]), REJECT)
        nfa.add_symbol_edge(0, 1, 98, 98)
        dfa.expand()
        self.assertEqual(dfa.match([98]), ACCEPT)
        self.assertEqual(dfa.match([97]), ACCEPT)

    def test_only_dependent_states_reexpanded(self):
        # Two independent branches; touching one must not unexpand the other.
        nfa = NFA(4, 0, accepting=[2, 3])
        nfa.add_symbol_edge(0, 1, 0, 0)
        nfa.add_symbol_edge(1, 2, 1, 1)
        nfa.add_symbol_edge(0, 3, 2, 2)
        dfa = LazyDFA(nfa)
        dfa.expand()
        branch_state = None
        for sid in range(dfa.num_states):
            if dfa.state_subset(sid) == frozenset({1}):
                branch_state = sid
        self.assertIsNotNone(branch_state)
        nfa.add_symbol_edge(3, 3, 3, 3)  # touches state 3 only
        dfa.expand()
        # The {1} subset's expansion did not depend on state 3.
        self.assertTrue(dfa.is_expanded(branch_state))
        self.assertEqual(dfa.match([0, 1]), ACCEPT)
        self.assertEqual(dfa.match([2, 3, 3]), ACCEPT)

    def test_mutation_after_checkpoint_restore(self):
        nfa = NFA(2, 0, accepting=[1])
        nfa.add_symbol_edge(0, 1, 97, 97)
        dfa = LazyDFA(nfa)
        dfa.expand()
        restored = LazyDFA.restore(nfa, dfa.save_checkpoint())
        e = nfa.add_symbol_edge(0, 1, 98, 98)
        restored.expand()
        self.assertEqual(restored.match([98]), ACCEPT)
        nfa.remove_edge(e)
        restored.expand()
        self.assertEqual(restored.match([98]), REJECT)

    def test_language_matches_interpreter_after_mutations(self):
        nfa = NFA(4, 0, accepting=[3])
        nfa.add_epsilon(0, 1)
        e12 = nfa.add_epsilon(1, 2)
        nfa.add_epsilon(2, 1)
        nfa.add_symbol_edge(1, 3, 0, 2)
        nfa.add_symbol_edge(2, 3, 1, 3)
        dfa = LazyDFA(nfa)
        dfa.expand()
        for s in ([], [0], [1], [2], [3], [0, 1], [3, 3]):
            self.assertEqual(dfa.match(s),
                             "accept" if interpreter.accepts(nfa, s) else "reject")
        nfa.remove_edge(e12)  # break the eps cycle
        dfa.expand()
        for s in ([], [0], [1], [2], [3], [0, 1], [3, 3]):
            self.assertEqual(dfa.match(s),
                             "accept" if interpreter.accepts(nfa, s) else "reject")


if __name__ == "__main__":
    unittest.main()
