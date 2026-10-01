import unittest

from lazydfa import (ACCEPT, REJECT, UNKNOWN, LazyDFA, NFA,
                     STATUS_EXPANDED, STATUS_PARTIAL)


def interval_nfa():
    # Two overlapping interval edges out of the start state.
    nfa = NFA(3, start=0, finals=[1, 2])
    e1 = nfa.add_edge(0, 1, lo=0, hi=5)
    e2 = nfa.add_edge(0, 2, lo=3, hi=8)
    return nfa, (e1, e2)


class IntervalSplittingTest(unittest.TestCase):
    def test_atomic_intervals_from_overlapping_edges(self):
        nfa, (e1, e2) = interval_nfa()
        dfa = LazyDFA(nfa)
        dfa.expand_all()
        trans = dfa.transitions_of(dfa.start_id)
        self.assertEqual([(t.lo, t.hi) for t in trans],
                         [(0, 2), (3, 5), (6, 8)])
        targets = [frozenset(dfa.subset_of(t.target)) for t in trans]
        self.assertEqual(targets, [frozenset({1}), frozenset({1, 2}),
                                   frozenset({2})])
        self.assertEqual(trans[0].witnesses, (e1,))
        self.assertEqual(trans[1].witnesses, (e1, e2))
        self.assertEqual(trans[2].witnesses, (e2,))

    def test_endpoints_land_in_correct_atoms(self):
        nfa, _ = interval_nfa()
        dfa = LazyDFA(nfa)
        dfa.expand_all()
        # Atomic split must route boundary symbols exactly right.
        for sym in (0, 1, 2):
            self.assertEqual(dfa.query([sym]), ACCEPT)  # only edge 1
        for sym in (3, 4, 5):
            self.assertEqual(dfa.query([sym]), ACCEPT)  # both edges
        for sym in (6, 7, 8):
            self.assertEqual(dfa.query([sym]), ACCEPT)  # only edge 2
        self.assertEqual(dfa.query([9]), REJECT)
        self.assertEqual(dfa.query([-1]), REJECT)

    def test_endpoint_witnesses_are_exact(self):
        # Verify each witness independently: the witness NFA edges of a
        # DFA transition must be exactly the edges leaving the subset
        # that cover the whole atomic interval, and their destinations
        # must lie in the target subset.
        nfa, _ = interval_nfa()
        dfa = LazyDFA(nfa)
        dfa.expand_all()
        for sid in dfa.state_ids():
            subset = dfa.subset_of(sid)
            for t in dfa.transitions_of(sid):
                expected = sorted(
                    e.id for s in subset for e in nfa.symbol_edges(s)
                    if e.lo <= t.lo and e.hi >= t.hi)
                self.assertEqual(sorted(t.witnesses), expected)
                for wid in t.witnesses:
                    e = nfa.edges[wid]
                    self.assertIn(e.src, subset)
                    self.assertIn(e.dst, dfa.subset_of(t.target))


class EpsilonStructureTest(unittest.TestCase):
    def test_empty_string_acceptance_through_epsilon(self):
        nfa = NFA(2, start=0, finals=[1])
        nfa.add_edge(0, 1)  # epsilon
        dfa = LazyDFA(nfa)
        dfa.expand_all()
        self.assertEqual(dfa.query([]), ACCEPT)

    def test_epsilon_cycle_terminates_and_accepts(self):
        nfa = NFA(3, start=0, finals=[2])
        nfa.add_edge(0, 1)          # epsilon
        nfa.add_edge(1, 0)          # epsilon cycle
        nfa.add_edge(1, 2, lo=ord("a"), hi=ord("a"))
        dfa = LazyDFA(nfa)
        dfa.expand_all()
        self.assertTrue(dfa.is_complete())
        self.assertEqual(dfa.query("a"), ACCEPT)
        self.assertEqual(dfa.query(""), REJECT)
        self.assertEqual(dfa.query("aa"), REJECT)

    def test_start_subset_is_full_closure(self):
        nfa = NFA(4, start=0, finals=[3])
        nfa.add_edge(0, 1)
        nfa.add_edge(1, 2)
        nfa.add_edge(2, 0)  # cycle back
        nfa.add_edge(2, 3)
        dfa = LazyDFA(nfa)
        self.assertEqual(dfa.subset_of(dfa.start_id),
                         frozenset({0, 1, 2, 3}))


class BudgetTest(unittest.TestCase):
    def chain_nfa(self):
        # 0 -[0]-> 1 -[1]-> 2(final); DFA needs 3 states, 2 transitions.
        nfa = NFA(3, start=0, finals=[2])
        nfa.add_edge(0, 1, lo=0, hi=0)
        nfa.add_edge(1, 2, lo=1, hi=1)
        return nfa

    def test_budget_exactly_exhausted_completes(self):
        nfa = self.chain_nfa()
        dfa = LazyDFA(nfa, state_budget=3, transition_budget=2)
        dfa.expand_all()
        self.assertTrue(dfa.is_complete())
        self.assertEqual(dfa.num_states(), 3)
        self.assertEqual(dfa.num_transitions(), 2)
        self.assertEqual(dfa.query([0, 1]), ACCEPT)
        self.assertEqual(dfa.query([0]), REJECT)

    def test_state_budget_marks_unknown_target(self):
        nfa = self.chain_nfa()
        dfa = LazyDFA(nfa, state_budget=2)
        dfa.expand_all()
        self.assertEqual(dfa.num_states(), 2)
        self.assertFalse(dfa.is_complete())
        # The transition into the missing third state is unknown,
        # and unknown must never be reported as rejection.
        self.assertEqual(dfa.query([0, 1]), UNKNOWN)
        self.assertEqual(dfa.query([0]), REJECT)  # subset {1} non-final
        self.assertEqual(dfa.query([1]), REJECT)  # dead symbol, expanded

    def test_transition_budget_marks_partial_state(self):
        nfa = self.chain_nfa()
        dfa = LazyDFA(nfa, transition_budget=1)
        dfa.expand_all()
        statuses = sorted(dfa.status_of(s) for s in dfa.state_ids())
        self.assertIn(STATUS_PARTIAL, statuses)
        self.assertEqual(dfa.query([0, 1]), UNKNOWN)
        self.assertEqual(dfa.query([9]), REJECT)  # start fully expanded

    def test_pending_state_is_unknown_not_reject(self):
        nfa = self.chain_nfa()
        dfa = LazyDFA(nfa)  # nothing expanded yet
        self.assertEqual(dfa.query([0, 1]), UNKNOWN)
        # Acceptance of the empty string is decidable from the subset.
        self.assertEqual(dfa.query([]), REJECT)
        dfa.expand(1)
        self.assertEqual(dfa.status_of(dfa.start_id), STATUS_EXPANDED)
        self.assertEqual(dfa.query([0, 1]), UNKNOWN)  # hits pending state
        dfa.expand_all()
        self.assertEqual(dfa.query([0, 1]), ACCEPT)


if __name__ == "__main__":
    unittest.main()
