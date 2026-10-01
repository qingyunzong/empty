import itertools
import random
import unittest

from lazydfa import ACCEPT, REJECT, LazyDFA, NFA, interp_accepts


def random_nfa(rng):
    n = rng.randint(2, 5)
    finals = [s for s in range(n) if rng.random() < 0.35]
    nfa = NFA(n, start=0, finals=finals)
    for src in range(n):
        for _ in range(rng.randint(0, 2)):
            dst = rng.randrange(n)
            if rng.random() < 0.4:
                nfa.add_edge(src, dst)  # epsilon (may create cycles)
            else:
                lo = rng.randint(0, 2)
                hi = rng.randint(lo, 3)
                nfa.add_edge(src, dst, lo=lo, hi=hi)
    return nfa


class CrossCheckTest(unittest.TestCase):
    def test_random_small_nfas_match_interpreter_on_short_strings(self):
        rng = random.Random(20261001)
        alphabet = (0, 1, 2, 3)
        for trial in range(40):
            nfa = random_nfa(rng)
            dfa = LazyDFA(nfa)
            dfa.expand_all()
            self.assertTrue(dfa.is_complete(),
                            msg=f"trial {trial} did not complete")
            for length in range(5):
                for tup in itertools.product(alphabet, repeat=length):
                    want = ACCEPT if interp_accepts(nfa, tup) else REJECT
                    self.assertEqual(dfa.query(tup), want,
                                     msg=f"trial {trial} string {tup}")

    def test_random_nfas_with_budgets_never_misclassify(self):
        # With tight budgets the machine may answer UNKNOWN, but it
        # must never contradict the reference interpreter.
        rng = random.Random(7)
        alphabet = (0, 1, 2, 3)
        for trial in range(30):
            nfa = random_nfa(rng)
            dfa = LazyDFA(nfa, state_budget=rng.randint(1, 4),
                          transition_budget=rng.randint(0, 5))
            dfa.expand_all()
            for length in range(4):
                for tup in itertools.product(alphabet, repeat=length):
                    got = dfa.query(tup)
                    want = ACCEPT if interp_accepts(nfa, tup) else REJECT
                    self.assertIn(got, (want, "unknown"),
                                  msg=f"trial {trial} string {tup}")


if __name__ == "__main__":
    unittest.main()
