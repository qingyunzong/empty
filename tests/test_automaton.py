import unittest

from regex_deriv.alphabet import Alphabet
from regex_deriv.automaton import BudgetExceeded, build_dfa, minimize
from regex_deriv.parser import parse
from regex_deriv.syntax import from_raw

AB = Alphabet.from_string("ab")


def rx(pattern, alphabet=AB):
    return from_raw(parse(pattern, alphabet))


def covers_alphabet(dfa, alphabet):
    for st in dfa.transitions:
        merged = []
        for lo, hi, _ in st:
            if merged and lo == merged[-1][1] + 1:
                merged[-1] = (merged[-1][0], hi)
            else:
                merged.append((lo, hi))
        self_lo = list(alphabet.intervals())
        if merged != self_lo:
            return False
        for k in range(1, len(st)):
            if st[k][0] <= st[k - 1][1]:
                return False
    return True


class TestBuildDFA(unittest.TestCase):
    def test_state_count(self):
        d = build_dfa(rx("a*b"), AB)
        self.assertEqual(len(d.states), 3)  # a*b, eps, empty

    def test_transitions_partition_alphabet(self):
        for pat in ("a*b", "(a|b)*ab", "~(a&b)", "a|(b&~a)", "(a*)*"):
            d = build_dfa(rx(pat), AB)
            self.assertTrue(covers_alphabet(d, AB), pat)

    def test_interval_transitions(self):
        alpha = Alphabet([(97, 122)])
        d = build_dfa(rx("[a-c]x", alpha), alpha)
        # start state must have a single [a-c] interval transition
        self.assertEqual(d.transitions[0][0][:2], (97, 99))
        self.assertEqual(d.transitions[0][1][:2], (100, 122))

    def test_budget_exceeded(self):
        with self.assertRaises(BudgetExceeded):
            build_dfa(rx("(a|b)*ab"), AB, max_states=1)

    def test_matches(self):
        d = build_dfa(rx("(a|b)*ab"), AB)
        for s, want in [("", False), ("ab", True), ("aab", True),
                        ("ba", False), ("abab", True), ("aba", False)]:
            self.assertEqual(d.matches(s), want)


class TestMinimize(unittest.TestCase):
    def test_minimized_sizes(self):
        cases = {
            "a*b": 3,
            "(a|b)*ab": 3,
            "(a|b)*": 1,
            "~∅": 1,
            "∅": 1,
            "ε": 2,
        }
        for pat, size in cases.items():
            m = minimize(build_dfa(rx(pat), AB), AB)
            self.assertEqual(len(m.states), size, pat)

    def test_minimized_equivalent_language(self):
        for pat in ("(a|b)*ab", "a(ba)*|(ab)+", "~(a&b)", "(a*b*)*"):
            d = build_dfa(rx(pat), AB)
            m = minimize(d, AB)
            for s in ("", "a", "b", "ab", "ba", "aab", "abab", "bba", "abba"):
                self.assertEqual(m.matches(s), d.matches(s), (pat, s))

    def test_minimized_transitions_partition_alphabet(self):
        for pat in ("(a|b)*ab", "~(a&b)", "a|(b&~a)"):
            m = minimize(build_dfa(rx(pat), AB), AB)
            self.assertTrue(covers_alphabet(m, AB), pat)

    def test_idempotent(self):
        m1 = minimize(build_dfa(rx("(a|b)*ab"), AB), AB)
        m2 = minimize(m1, AB)
        self.assertEqual(len(m1.states), len(m2.states))


if __name__ == "__main__":
    unittest.main()
