import json
import unittest

from symdfa import Minimizer, SymbolicDFA, minimize, verify_certificate
from symdfa.naive import naive_partition


def blocks_of(result):
    groups = {}
    for s, b in result["block_map"].items():
        groups.setdefault(b, []).append(int(s))
    return tuple(sorted(tuple(sorted(v)) for v in groups.values()))


class TestUnreachableAndEmpty(unittest.TestCase):
    def test_unreachable_final_state_is_trimmed(self):
        # state 2 is an unreachable final; reachable language is empty
        dfa = SymbolicDFA(2, 3, 0, [2], [
            [([(0, 1)], 1)],
            [([(0, 1)], 1)],
            [([(0, 1)], 2)],
        ])
        result = minimize(dfa)
        # one non-final quotient state, empty language
        self.assertEqual(result["quotient"]["num_states"], 1)
        self.assertEqual(result["quotient"]["finals"], [])
        self.assertEqual(result["block_map"], {"0": 0, "1": 0})
        self.assertNotIn("2", result["block_map"])
        self.assertEqual(verify_certificate(dfa, result), [])

    def test_empty_language_no_finals(self):
        dfa = SymbolicDFA(3, 3, 0, [], [
            [([(0, 0)], 1), ([(1, 2)], 2)],
            [([(0, 2)], 2)],
            [([(0, 2)], 2)],
        ])
        result = minimize(dfa)
        self.assertEqual(result["quotient"]["num_states"], 1)
        self.assertEqual(result["quotient"]["finals"], [])
        self.assertEqual(verify_certificate(dfa, result), [])

    def test_empty_language_partial_coverage(self):
        # dead-equivalent states with different coverage merge
        dfa = SymbolicDFA(2, 3, 0, [], [
            [([(0, 0)], 1)],          # 0: only 'a'
            [([(0, 0)], 2)],          # 1: only 'a'
            [([(0, 1)], 2)],          # 2: 'a' and 'b'
        ])
        result = minimize(dfa)
        self.assertEqual(result["quotient"]["num_states"], 1)
        self.assertEqual(verify_certificate(dfa, result), [])

    def test_single_state_universal(self):
        dfa = SymbolicDFA(4, 1, 0, [0], [[([(0, 3)], 0)]])
        result = minimize(dfa)
        self.assertEqual(result["quotient"]["num_states"], 1)
        self.assertEqual(result["quotient"]["finals"], [0])
        self.assertEqual(verify_certificate(dfa, result), [])


class TestCanonicalNumbering(unittest.TestCase):
    def test_numbering_follows_lexicographic_shortest_words(self):
        # start 0; 'b' reaches final directly, 'a' reaches it in two steps
        dfa = SymbolicDFA(2, 4, 0, [3], [
            [([(0, 0)], 1), ([(1, 1)], 2)],
            [([(0, 1)], 3)],
            [],
            [([(0, 1)], 3)],
        ])
        result = minimize(dfa)
        q = result["quotient"]
        # BFS from start over sorted intervals: 0 ->(a) 1 ->(b) 2 -> 3
        self.assertEqual(q["start"], 0)
        self.assertEqual(result["block_map"], {"0": 0, "1": 1, "2": 2, "3": 3})
        # reaching words: [] < [a] < [b] < [a,a] lexicographic+length order
        self.assertEqual(q["finals"], [3])
        self.assertEqual(verify_certificate(dfa, result), [])

    def test_isomorphic_inputs_serialize_identically(self):
        dfa = SymbolicDFA(3, 5, 0, [3, 4], [
            [([(0, 0)], 1), ([(1, 2)], 2)],
            [([(0, 2)], 3)],
            [([(0, 1)], 4), ([(2, 2)], 2)],
            [([(0, 2)], 3)],
            [([(0, 2)], 4)],
        ])
        # isomorphic relabelling: new_id = perm[old_id]
        perm = [3, 4, 0, 2, 1]
        inv = [0] * 5
        for new, old in enumerate(perm):
            inv[old] = new
        trans = [None] * 5
        for old in range(5):
            trans[inv[old]] = [(ivs, inv[t]) for ivs, t in dfa.transitions[old]]
        dfa2 = SymbolicDFA(3, 5, inv[dfa.start],
                           [inv[f] for f in dfa.finals], trans)
        r1, r2 = minimize(dfa), minimize(dfa2)
        self.assertEqual(
            json.dumps(r1["quotient"], sort_keys=True),
            json.dumps(r2["quotient"], sort_keys=True),
        )
        self.assertEqual(
            json.dumps(r1["proof_dag"]["nodes"], sort_keys=True),
            json.dumps(r2["proof_dag"]["nodes"], sort_keys=True),
        )
        # block maps compose with the permutation
        for s, b in r1["block_map"].items():
            self.assertEqual(b, r2["block_map"][str(inv[int(s)])])


class TestProofDag(unittest.TestCase):
    def test_dag_covers_exactly_unmerged_pairs(self):
        dfa = SymbolicDFA(2, 4, 0, [3], [
            [([(0, 0)], 1), ([(1, 1)], 2)],
            [([(0, 1)], 3)],
            [([(0, 1)], 2)],
            [([(0, 1)], 3)],
        ])
        result = minimize(dfa)
        dag = result["proof_dag"]
        bm = result["block_map"]
        states = sorted(int(s) for s in bm)
        expected = set()
        for i, x in enumerate(states):
            for y in states[i + 1:]:
                if bm[str(x)] != bm[str(y)]:
                    expected.add(f"{x},{y}")
        self.assertEqual(set(dag["pairs"]), expected)
        self.assertEqual(verify_certificate(dfa, result), [])

    def test_dag_chains_are_shared(self):
        # many pairs, few distinct configs -> nodes < pairs
        dfa = SymbolicDFA(2, 6, 0, [5], [
            [([(0, 0)], 1), ([(1, 1)], 2)],
            [([(0, 1)], 3)],
            [([(0, 1)], 4)],
            [([(0, 1)], 5)],
            [([(0, 1)], 5)],
            [([(0, 1)], 5)],
        ])
        result = minimize(dfa)
        dag = result["proof_dag"]
        self.assertLess(len(dag["nodes"]), len(dag["pairs"]))
        self.assertEqual(verify_certificate(dfa, result), [])


class TestNaiveCrossCheck(unittest.TestCase):
    """Small machines: independent pairwise-equivalence fixpoint oracle."""

    def test_pairwise_fixpoint_and_rebuild(self):
        import random

        from tests.util import random_dfa

        rng = random.Random(2024)
        for _ in range(60):
            dfa = random_dfa(rng, rng.randint(1, 4), rng.randint(1, 7))
            result = minimize(dfa)
            self.assertEqual(blocks_of(result), naive_partition(dfa))
            self.assertEqual(verify_certificate(dfa, result), [])


if __name__ == "__main__":
    unittest.main()
