import random
import unittest

from symdfa import SymbolicDFA, minimize
from symdfa.baseline import pairwise_equivalence_classes
from symdfa.serialize import dfa_to_json


def chain_dfa(length, finals=()):
    transitions = {}
    for s in range(length):
        transitions[s] = [(0, 0, min(s + 1, length - 1)), (1, 1, s)]
    return SymbolicDFA(2, 0, set(finals), transitions)


def random_dfa(rng, n, alpha):
    transitions = {}
    for s in range(n):
        cuts = sorted(rng.sample(range(1, alpha), rng.randint(0, alpha - 1)))
        bounds = [0] + cuts + [alpha]
        transitions[s] = [
            (a, b - 1, rng.randrange(n)) for a, b in zip(bounds, bounds[1:])
        ]
    finals = {s for s in range(n) if rng.random() < 0.4}
    return SymbolicDFA(alpha, 0, finals, transitions)


class TestMinimize(unittest.TestCase):
    def test_unreachable_final_state_trimmed(self):
        dfa = SymbolicDFA(2, 0, {1}, {
            0: [(0, 1, 0)],
            1: [(0, 1, 1)],
        })
        result = minimize(dfa)
        self.assertIsNone(result.state_to_block[1])
        self.assertEqual(result.state_to_block[0], 0)
        self.assertEqual(len(result.blocks), 1)
        self.assertEqual(result.automaton.finals, frozenset())

    def test_empty_language_single_block(self):
        dfa = chain_dfa(4)  # no finals at all
        result = minimize(dfa)
        self.assertEqual(len(result.blocks), 1)
        self.assertEqual(result.blocks[0], [0, 1, 2, 3])
        self.assertEqual(len(result.automaton.states), 1)
        self.assertEqual(result.proof.nodes, [])

    def test_chain_splits_by_distance_to_final(self):
        dfa = chain_dfa(4, finals={3})
        result = minimize(dfa)
        self.assertEqual(len(result.blocks), 4)
        for s in range(4):
            self.assertEqual(result.state_to_block[s], s)

    def test_equivalent_duplicates_merge(self):
        # States 1 and 2 are equivalent final sinks; 3 mirrors 0.
        dfa = SymbolicDFA(2, 0, {1, 2}, {
            0: [(0, 0, 1), (1, 1, 3)],
            1: [(0, 1, 1)],
            2: [(0, 1, 2)],
            3: [(0, 0, 2), (1, 1, 3)],
        })
        result = minimize(dfa)
        self.assertEqual(result.state_to_block[1], result.state_to_block[2])
        self.assertEqual(result.state_to_block[0], result.state_to_block[3])
        self.assertEqual(len(result.blocks), 2)

    def test_canonical_numbering_follows_lexicographic_words(self):
        # Numeric ids deliberately disagree with BFS/lexicographic order.
        dfa = SymbolicDFA(2, 5, {2}, {
            5: [(0, 0, 3), (1, 1, 1)],
            3: [(0, 1, 2)],
            1: [(0, 1, 1)],
            2: [(0, 1, 2)],
        })
        result = minimize(dfa)
        self.assertEqual(result.state_to_block[5], 0)
        self.assertEqual(result.state_to_block[3], 1)  # word [0]
        self.assertEqual(result.state_to_block[1], 2)  # word [1]
        self.assertEqual(result.state_to_block[2], 3)  # word [0, 0]

    def test_isomorphic_inputs_serialize_identically(self):
        dfa_a = SymbolicDFA(3, 0, {3}, {
            0: [(0, 0, 1), (1, 2, 0)],
            1: [(0, 1, 2), (2, 2, 0)],
            2: [(0, 2, 3)],
            3: [(0, 2, 3)],
        })
        perm = {0: 7, 1: 2, 2: 9, 3: 4}
        dfa_b = SymbolicDFA(3, 7, {4}, {
            perm[s]: [(lo, hi, perm[t]) for lo, hi, t in rows]
            for s, rows in dfa_a.transitions.items()
        })
        res_a = minimize(dfa_a)
        res_b = minimize(dfa_b)
        self.assertEqual(dfa_to_json(res_a.automaton), dfa_to_json(res_b.automaton))
        self.assertEqual(res_a.proof.to_dict(), res_b.proof.to_dict())

    def test_cross_check_pairwise_fixpoint(self):
        rng = random.Random(20261001)
        for _ in range(200):
            dfa = random_dfa(rng, rng.randint(1, 6), rng.randint(1, 4))
            result = minimize(dfa)
            expected = {frozenset(c) for c in pairwise_equivalence_classes(dfa)}
            actual = {frozenset(b) for b in result.blocks}
            self.assertEqual(actual, expected)


if __name__ == "__main__":
    unittest.main()
