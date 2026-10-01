import random
import unittest

from symdfa import (
    DFA, check_equivalence, check_inclusion,
    EQUIVALENT, NOT_EQUIVALENT, INCLUDED, NOT_INCLUDED,
)
from tests._reference import (
    ALPHABET, random_dfa, reference_witness, brute_force_witness,
)


class TestFixedCases(unittest.TestCase):
    def test_empty_string_difference(self):
        dfa1 = DFA(1, 0, {0})
        dfa2 = DFA(1, 0, set())
        res = check_equivalence(dfa1, dfa2)
        self.assertEqual(res.status, NOT_EQUIVALENT)
        self.assertEqual(res.witness, ())
        self.assertEqual(res.edges_used, 0)

    def test_implicit_sink_equals_explicit_dead_state(self):
        # dfa1: missing transitions (implicit sink)
        dfa1 = DFA(2, 0, {1}, {0: [(0, 9, 1)]})
        # dfa2: explicit non-accepting dead state 2 with full self-loop
        dfa2 = DFA(3, 0, {1}, {
            0: [(0, 9, 1), (10, 65535, 2)],
            1: [(0, 65535, 2)],
            2: [(0, 65535, 2)],
        })
        res = check_equivalence(dfa1, dfa2)
        self.assertEqual(res.status, EQUIVALENT)

    def test_interval_endpoint_splitting(self):
        dfa1 = DFA(3, 0, {2}, {0: [(0, 5, 1), (6, 65535, 2)]})
        dfa2 = DFA(3, 0, {2}, {0: [(0, 3, 1), (4, 65535, 2)]})
        res = check_equivalence(dfa1, dfa2)
        self.assertEqual(res.status, NOT_EQUIVALENT)
        # split happens at endpoint 3/4: chars 4 and 5 distinguish
        self.assertEqual(res.witness, (4,))

    def test_lexicographically_smallest_among_same_length(self):
        # chars 3 and 5 both distinguish at length 1; 3 must be reported
        dfa1 = DFA(2, 0, {1}, {0: [(3, 3, 1), (5, 5, 1)]})
        dfa2 = DFA(1, 0, set(), {})
        res = check_equivalence(dfa1, dfa2)
        self.assertEqual(res.status, NOT_EQUIVALENT)
        self.assertEqual(res.witness, (3,))

    def test_same_length_witnesses_at_depth_two(self):
        # words (0,2) and (1,0) distinguish; (0,2) is lexicographically first
        dfa1 = DFA(4, 0, {3}, {0: [(0, 0, 1), (1, 1, 2)],
                               1: [(2, 2, 3)], 2: [(0, 0, 3)]})
        dfa2 = DFA(1, 0, set(), {})
        res = check_equivalence(dfa1, dfa2)
        self.assertEqual(res.witness, (0, 2))

    def test_inclusion(self):
        # dfa1 accepts single-char words in [0,9]; dfa2 accepts [0,19]
        dfa1 = DFA(2, 0, {1}, {0: [(0, 9, 1)]})
        dfa2 = DFA(2, 0, {1}, {0: [(0, 19, 1)]})
        self.assertEqual(check_inclusion(dfa1, dfa2).status, INCLUDED)
        res = check_inclusion(dfa2, dfa1)
        self.assertEqual(res.status, NOT_INCLUDED)
        self.assertEqual(res.witness, (10,))

    def test_inclusion_with_sink(self):
        # empty language is included in everything
        empty = DFA(1, 0, set(), {})
        any_dfa = DFA(1, 0, {0}, {0: [(0, 65535, 0)]})
        self.assertEqual(check_inclusion(empty, any_dfa).status, INCLUDED)
        self.assertEqual(check_inclusion(any_dfa, empty).status, NOT_INCLUDED)


class TestAgainstReference(unittest.TestCase):
    def test_random_machines_match_full_product_reference(self):
        rng = random.Random(20261001)
        for trial in range(300):
            dfa1 = random_dfa(rng, rng.randint(1, 4))
            dfa2 = random_dfa(rng, rng.randint(1, 4))
            expected = reference_witness(dfa1, dfa2)
            res = check_equivalence(dfa1, dfa2)
            if expected is None:
                self.assertEqual(res.status, EQUIVALENT, f"trial {trial}")
            else:
                self.assertEqual(res.status, NOT_EQUIVALENT, f"trial {trial}")
                self.assertEqual(tuple(res.witness), tuple(expected),
                                 f"trial {trial}")

    def test_exhaustive_words_over_small_alphabet(self):
        rng = random.Random(7)
        checked = 0
        for _ in range(60):
            dfa1 = random_dfa(rng, rng.randint(1, 3), alphabet=(0, 1))
            dfa2 = random_dfa(rng, rng.randint(1, 3), alphabet=(0, 1))
            expected = brute_force_witness(dfa1, dfa2, max_len=6,
                                           alphabet=(0, 1))
            res = check_equivalence(dfa1, dfa2)
            if expected is None:
                # no witness up to length 6 over {0,1}: reference BFS decides
                if reference_witness(dfa1, dfa2, alphabet=(0, 1)) is None:
                    self.assertEqual(res.status, EQUIVALENT)
                    checked += 1
            else:
                self.assertEqual(res.status, NOT_EQUIVALENT)
                self.assertEqual(tuple(res.witness), tuple(expected))
                checked += 1
        self.assertGreater(checked, 0)


if __name__ == "__main__":
    unittest.main()
