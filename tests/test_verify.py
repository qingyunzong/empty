import unittest
from dataclasses import replace

from symdfa import (
    DFA, check_equivalence, check_inclusion, build_proof,
    verify_proof, verify_witness, RelationItem, Proof,
)


def proved_pair():
    dfa1 = DFA(3, 0, {2}, {
        0: [(0, 9, 1)],
        1: [(10, 19, 2)],
        2: [(0, 65535, 2)],
    })
    dfa2 = DFA(3, 0, {2}, {
        0: [(0, 9, 1)],
        1: [(10, 19, 2)],
        2: [(0, 65535, 2)],
    })
    proof = build_proof(check_equivalence(dfa1, dfa2), dfa1, dfa2)
    return dfa1, dfa2, proof


class TestVerifyProof(unittest.TestCase):
    def test_valid_proof_accepted(self):
        dfa1, dfa2, proof = proved_pair()
        ok, reason = verify_proof(proof, dfa1, dfa2)
        self.assertTrue(ok, reason)

    def test_tampered_missing_item(self):
        dfa1, dfa2, proof = proved_pair()
        dropped = proof.items[1]
        bad = Proof(proof.mode, proof.version1, proof.version2,
                    tuple(it for it in proof.items if it != dropped))
        ok, reason = verify_proof(bad, dfa1, dfa2)
        self.assertFalse(ok)
        self.assertTrue("coverage" in reason or "start" in reason, reason)

    def test_tampered_missing_start_pair(self):
        dfa1, dfa2, proof = proved_pair()
        start = (dfa1.start, dfa2.start)
        bad = Proof(proof.mode, proof.version1, proof.version2,
                    tuple(it for it in proof.items if it.pair != start))
        ok, reason = verify_proof(bad, dfa1, dfa2)
        self.assertFalse(ok)
        self.assertIn("start", reason)

    def test_tampered_segment_endpoints(self):
        dfa1, dfa2, proof = proved_pair()
        item = proof.items[0]
        segs = list(item.segments)
        lo, hi, d1, d2 = segs[0]
        segs[0] = (lo, hi + 1, d1, d2)  # corrupt the endpoint split
        bad_item = RelationItem(pair=item.pair, segments=tuple(segs))
        bad = Proof(proof.mode, proof.version1, proof.version2,
                    (bad_item,) + proof.items[1:])
        ok, reason = verify_proof(bad, dfa1, dfa2)
        self.assertFalse(ok)
        self.assertIn("segment", reason)

    def test_tampered_successor_not_in_relation(self):
        dfa1, dfa2, proof = proved_pair()
        # point a segment at a pair that is not covered
        item = next(it for it in proof.items if it.pair == (0, 0))
        segs = [(lo, hi, 0 if d1 != 0 else 1, d2) for lo, hi, d1, d2 in item.segments]
        bad_item = RelationItem(pair=item.pair, segments=tuple(segs))
        bad = Proof(proof.mode, proof.version1, proof.version2,
                    tuple(bad_item if it.pair == (0, 0) else it
                          for it in proof.items))
        ok, reason = verify_proof(bad, dfa1, dfa2)
        self.assertFalse(ok)

    def test_tampered_version_binding(self):
        dfa1, dfa2, proof = proved_pair()
        bad = Proof(proof.mode, proof.version1 + 1, proof.version2, proof.items)
        ok, reason = verify_proof(bad, dfa1, dfa2)
        self.assertFalse(ok)
        self.assertIn("version", reason)

    def test_duplicate_items_rejected(self):
        dfa1, dfa2, proof = proved_pair()
        bad = Proof(proof.mode, proof.version1, proof.version2,
                    proof.items + proof.items[:1])
        ok, reason = verify_proof(bad, dfa1, dfa2)
        self.assertFalse(ok)
        self.assertIn("duplicate", reason)

    def test_inclusion_proof_verifies(self):
        dfa1 = DFA(2, 0, {1}, {0: [(0, 9, 1)]})
        dfa2 = DFA(2, 0, {1}, {0: [(0, 19, 1)]})
        proof = build_proof(check_inclusion(dfa1, dfa2), dfa1, dfa2)
        ok, reason = verify_proof(proof, dfa1, dfa2)
        self.assertTrue(ok, reason)


class TestVerifyWitness(unittest.TestCase):
    def test_replay_real_counterexample(self):
        dfa1 = DFA(2, 0, {1}, {0: [(5, 5, 1)]})
        dfa2 = DFA(1, 0, set(), {})
        res = check_equivalence(dfa1, dfa2)
        ok, reason = verify_witness(res.witness, dfa1, dfa2)
        self.assertTrue(ok, reason)

    def test_replay_through_implicit_sink(self):
        # witness enters the implicit sink of machine 2 mid-word
        dfa1 = DFA(3, 0, {2}, {0: [(0, 65535, 1)], 1: [(0, 65535, 2)]})
        dfa2 = DFA(3, 0, {2}, {0: [(0, 9, 1)], 1: [(0, 9, 2)]})
        res = check_equivalence(dfa1, dfa2)
        self.assertEqual(res.witness, (0, 10))
        ok, reason = verify_witness(res.witness, dfa1, dfa2)
        self.assertTrue(ok, reason)

    def test_tampered_witness_rejected(self):
        dfa1 = DFA(2, 0, {1}, {0: [(5, 5, 1)]})
        dfa2 = DFA(1, 0, set(), {})
        res = check_equivalence(dfa1, dfa2)
        self.assertEqual(res.witness, (5,))
        ok, _ = verify_witness((4,), dfa1, dfa2)      # wrong char
        self.assertFalse(ok)
        ok, _ = verify_witness((5, 5), dfa1, dfa2)    # extra char
        self.assertFalse(ok)
        ok, _ = verify_witness((), dfa1, dfa2)        # truncated
        self.assertFalse(ok)

    def test_witness_mode_mismatch_rejected(self):
        dfa1 = DFA(2, 0, {1}, {0: [(0, 9, 1)]})
        dfa2 = DFA(2, 0, {1}, {0: [(0, 19, 1)]})
        res = check_inclusion(dfa2, dfa1)
        self.assertEqual(res.witness, (10,))
        ok, _ = verify_witness(res.witness, dfa2, dfa1, mode="inclusion")
        self.assertTrue(ok)
        # same word is not an equivalence-direction mismatch for inclusion
        # of dfa1 in dfa2 (dfa1 does not accept it either)
        ok, _ = verify_witness(res.witness, dfa1, dfa2, mode="inclusion")
        self.assertFalse(ok)


if __name__ == "__main__":
    unittest.main()
