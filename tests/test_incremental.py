import random
import unittest

from symdfa import (
    DFA, check_equivalence, build_proof, revalidate, verify_proof,
    EQUIVALENT, NOT_EQUIVALENT,
)
from tests._reference import random_dfa, reference_witness


def make_pair():
    """Two machines equivalent until state 1's [10,19] transition differs."""
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
    return dfa1, dfa2


class TestIncremental(unittest.TestCase):
    def test_proof_bound_to_version(self):
        dfa1, dfa2 = make_pair()
        proof = build_proof(check_equivalence(dfa1, dfa2), dfa1, dfa2)
        ok, _ = verify_proof(proof, dfa1, dfa2)
        self.assertTrue(ok)
        # correcting one transition bumps the version: old proof no longer
        # verifies directly against the changed machine
        dfa2.set_transition(1, 10, 19, 1)
        ok, reason = verify_proof(proof, dfa1, dfa2)
        self.assertFalse(ok)
        self.assertIn("version", reason)

    def test_update_invalidates_dependent_items_reuses_rest(self):
        dfa1, dfa2 = make_pair()
        proof = build_proof(check_equivalence(dfa1, dfa2), dfa1, dfa2)
        full_cache = revalidate(proof, dfa1, dfa2)
        self.assertEqual(len(full_cache), len(proof.items))

        # correct a transition on state 1 (a previously visited state)
        dfa2.set_transition(1, 10, 19, 0)
        cache = revalidate(proof, dfa1, dfa2)
        # items not depending on state 1 of machine 2 survive
        self.assertIn((0, 0), cache)
        self.assertIn((2, 2), cache)
        # the item for pair (1, 1) depended on the changed transition
        self.assertNotIn((1, 1), cache)

        # re-check reusing the cache: only invalidated pairs are re-expanded
        res = check_equivalence(dfa1, dfa2, cache=cache)
        self.assertEqual(res.status, NOT_EQUIVALENT)
        self.assertEqual(res.witness, (0, 10))
        ok, _ = verify_witness_ok(res.witness, dfa1, dfa2)
        self.assertTrue(ok)

    def test_update_preserving_equivalence_reuses_proof(self):
        dfa1, dfa2 = make_pair()
        proof = build_proof(check_equivalence(dfa1, dfa2), dfa1, dfa2)
        # change an unreachable part of machine 2: state 1's interval is
        # replaced by an equivalent disjoint split elsewhere?  Instead add a
        # self-loop on the sink-like region of state 2 (already loops) ->
        # modify machine 2 state 0 by adding a disjoint interval to state 1
        # that machine 1 lacks would break equivalence, so instead correct
        # state 2's loop endpoints identically in both machines.
        dfa1.set_transition(2, 0, 65535, 2)  # exact replacement, same dst
        dfa2.set_transition(2, 0, 65535, 2)
        cache = revalidate(proof, dfa1, dfa2)
        self.assertEqual(len(cache), len(proof.items))  # everything reusable
        res = check_equivalence(dfa1, dfa2, cache=cache)
        self.assertEqual(res.status, EQUIVALENT)
        self.assertEqual(res.edges_used, 0)  # no new product edges needed
        new_proof = build_proof(res_with_items(res, cache), dfa1, dfa2)
        ok, _ = verify_proof(new_proof, dfa1, dfa2)
        self.assertTrue(ok)

    def test_random_updates_against_reference(self):
        rng = random.Random(4242)
        for trial in range(80):
            dfa1 = random_dfa(rng, rng.randint(1, 4))
            dfa2 = random_dfa(rng, rng.randint(1, 4))
            first = check_equivalence(dfa1, dfa2)
            if first.status != EQUIVALENT:
                continue
            proof = build_proof(first, dfa1, dfa2)
            # single-transition correction on a random state of machine 2
            state = rng.randrange(dfa2.num_states)
            lo = rng.randint(0, 3)
            hi = rng.randint(lo, 3)
            dst = rng.randrange(dfa2.num_states)
            dfa2.transitions[state] = [
                iv for iv in dfa2.transitions.get(state, [])
                if iv[0] > hi or iv[1] < lo
            ]
            dfa2.set_transition(state, lo, hi, dst)
            cache = revalidate(proof, dfa1, dfa2)
            res = check_equivalence(dfa1, dfa2, cache=cache)
            expected = reference_witness(dfa1, dfa2)
            if expected is None:
                self.assertEqual(res.status, EQUIVALENT, f"trial {trial}")
            else:
                self.assertEqual(res.status, NOT_EQUIVALENT, f"trial {trial}")
                self.assertEqual(tuple(res.witness), tuple(expected),
                                 f"trial {trial}")


def verify_witness_ok(witness, dfa1, dfa2):
    from symdfa import verify_witness
    return verify_witness(witness, dfa1, dfa2)


def res_with_items(res, cache):
    """Attach cached items to a cache-only positive result for proof rebuild."""
    if res.items is None:
        res.items = dict(cache)
    else:
        merged = dict(cache)
        merged.update(res.items)
        res.items = merged
    return res


if __name__ == "__main__":
    unittest.main()
