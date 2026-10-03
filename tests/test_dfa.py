import itertools
import random
import unittest

from lazydfa import NFA, LazyDFA, ACCEPT, REJECT, UNKNOWN, interpreter


def all_strings(alphabet, max_len):
    for n in range(max_len + 1):
        for tup in itertools.product(alphabet, repeat=n):
            yield list(tup)


class BasicDFATest(unittest.TestCase):
    def test_interval_partition_on_overlap(self):
        # [0,5] from 0->1, [3,10] from 0->2; accept only via 2.
        nfa = NFA(3, 0, accepting=[2])
        nfa.add_symbol_edge(0, 1, 0, 5)
        nfa.add_symbol_edge(0, 2, 3, 10)
        dfa = LazyDFA(nfa)
        dfa.expand()
        trans = dfa.to_json()["transitions"]
        parts = sorted((t["lo"], t["hi"]) for t in trans)
        self.assertEqual(parts, [(0, 2), (3, 5), (6, 10)])
        self.assertEqual(dfa.match([1]), REJECT)   # only reaches state 1
        self.assertEqual(dfa.match([4]), ACCEPT)   # reaches 1 and 2
        self.assertEqual(dfa.match([8]), ACCEPT)   # only reaches 2

    def test_atomic_reject_of_bad_endpoints(self):
        nfa = NFA(2, 0, accepting=[1])
        nfa.add_symbol_edge(0, 1, 2, 4)
        dfa = LazyDFA(nfa)
        dfa.expand()
        self.assertEqual(dfa.match([1]), REJECT)   # just below lo
        self.assertEqual(dfa.match([2]), ACCEPT)   # lo boundary
        self.assertEqual(dfa.match([4]), ACCEPT)   # hi boundary
        self.assertEqual(dfa.match([5]), REJECT)   # just above hi
        self.assertEqual(dfa.match([2, 2]), REJECT)  # no edge out of {1}

    def test_empty_string_acceptance(self):
        nfa = NFA(3, 0, accepting=[2])
        nfa.add_epsilon(0, 1)
        nfa.add_epsilon(1, 2)
        dfa = LazyDFA(nfa)
        dfa.expand()
        self.assertEqual(dfa.match([]), ACCEPT)
        nfa2 = NFA(2, 0, accepting=[1])
        nfa2.add_symbol_edge(0, 1, 0, 0)
        dfa2 = LazyDFA(nfa2)
        dfa2.expand()
        self.assertEqual(dfa2.match([]), REJECT)

    def test_epsilon_cycle_language(self):
        # (a)* via an epsilon cycle: 0 -a-> 1, 1 -eps-> 0; accept in 0.
        nfa = NFA(2, 0, accepting=[0])
        nfa.add_symbol_edge(0, 1, ord("a"), ord("a"))
        nfa.add_epsilon(1, 0)
        dfa = LazyDFA(nfa)
        dfa.expand()
        for n in range(6):
            self.assertEqual(dfa.match([ord("a")] * n), ACCEPT)
        self.assertEqual(dfa.match([ord("b")]), REJECT)


class BudgetTest(unittest.TestCase):
    def build_chain(self):
        # 0 -a-> 1 -a-> 2 (accept). DFA needs 3 states, 2 transitions.
        nfa = NFA(3, 0, accepting=[2])
        nfa.add_symbol_edge(0, 1, 97, 97)
        nfa.add_symbol_edge(1, 2, 97, 97)
        return nfa

    def test_budget_exactly_exhausted(self):
        nfa = self.build_chain()
        dfa = LazyDFA(nfa, state_budget=3, transition_budget=2)
        dfa.expand()
        self.assertFalse(dfa.budget_exhausted)
        self.assertEqual(dfa.num_states, 3)
        self.assertEqual(dfa.num_transitions, 2)
        self.assertEqual(dfa.match([97, 97]), ACCEPT)

    def test_tight_state_budget_leaves_unknown(self):
        nfa = self.build_chain()
        dfa = LazyDFA(nfa, state_budget=2)
        dfa.expand()
        self.assertTrue(dfa.budget_exhausted)
        self.assertEqual(dfa.num_states, 2)
        self.assertEqual(len(dfa.unknown_states()), 1)
        # Reaching the unexpanded state with input left: UNKNOWN, not REJECT.
        self.assertEqual(dfa.match([97, 97]), UNKNOWN)
        # A string ending in a known non-accepting state is still REJECT.
        self.assertEqual(dfa.match([97]), REJECT)
        # A string failing on a known transition is still REJECT.
        self.assertEqual(dfa.match([98]), REJECT)

    def test_tight_transition_budget_leaves_unknown(self):
        nfa = self.build_chain()
        dfa = LazyDFA(nfa, transition_budget=1)
        dfa.expand()
        self.assertTrue(dfa.budget_exhausted)
        self.assertEqual(dfa.num_transitions, 1)
        self.assertEqual(dfa.match([97, 97]), UNKNOWN)

    def test_zero_budget_start_state_unknown(self):
        nfa = self.build_chain()
        dfa = LazyDFA(nfa, state_budget=1)
        dfa.expand()
        self.assertEqual(dfa.match([97]), UNKNOWN)
        self.assertEqual(dfa.match([]), REJECT)  # start subset not accepting


class CrossCheckTest(unittest.TestCase):
    def test_random_nfas_against_interpreter(self):
        rng = random.Random(20261003)
        alphabet = [0, 1, 2, 3]
        for trial in range(30):
            n = rng.randint(1, 6)
            accepting = [s for s in range(n) if rng.random() < 0.4]
            nfa = NFA(n, 0, accepting)
            for _ in range(rng.randint(0, 2 * n)):
                src, dst = rng.randrange(n), rng.randrange(n)
                if rng.random() < 0.3:
                    nfa.add_epsilon(src, dst)
                else:
                    lo = rng.randrange(4)
                    hi = min(3, lo + rng.randrange(3))
                    nfa.add_symbol_edge(src, dst, lo, hi)
            dfa = LazyDFA(nfa)
            dfa.expand()
            self.assertFalse(dfa.budget_exhausted)
            for string in all_strings(alphabet, 4):
                expected = ACCEPT if interpreter.accepts(nfa, string) else REJECT
                got = dfa.match(string)
                self.assertEqual(got, expected,
                                 f"trial={trial} string={string}")


class WitnessTest(unittest.TestCase):
    def test_witness_edges_recorded(self):
        nfa = NFA(3, 0, accepting=[1, 2])
        e0 = nfa.add_symbol_edge(0, 1, 0, 5)
        e1 = nfa.add_symbol_edge(0, 2, 3, 10)
        dfa = LazyDFA(nfa)
        dfa.expand()
        wit = dfa.witness(0)
        by_range = {(lo, hi): w for lo, hi, dst, w in wit}
        self.assertEqual(by_range[(0, 2)], (e0,))
        self.assertEqual(set(by_range[(3, 5)]), {e0, e1})
        self.assertEqual(by_range[(6, 10)], (e1,))
        # JSON output carries resolvable NFA edges for independent checks.
        out = dfa.to_json()
        for t in out["transitions"]:
            for w in t["witness"]:
                self.assertIn("from", w)
                self.assertLessEqual(w["lo"], t["hi"])
                self.assertGreaterEqual(w["hi"], t["lo"])


if __name__ == "__main__":
    unittest.main()
