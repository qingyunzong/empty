import copy
import unittest

from pathpolicy.proof import (
    check_equivalence,
    check_inclusion,
    verify_inclusion_proof,
)
from pathpolicy.ruleset import Pattern, Union


def make_proof(a, b):
    result = check_inclusion(a, b)
    assert result["status"] == "included"
    return result["proof"]


class ProofTests(unittest.TestCase):
    def test_valid_proof_verifies(self):
        a, b = Pattern("a/b"), Pattern("a/**")
        proof = make_proof(a, b)
        verdict = verify_inclusion_proof(a, b, proof)
        self.assertIs(verdict["valid"], True, verdict)

    def test_proof_is_structural_not_sampled(self):
        # The certificate is the full reachable product graph: states,
        # transitions and an explicit alphabet -- not a list of test paths.
        proof = make_proof(Pattern("a/b"), Pattern("a/**"))
        self.assertEqual(proof["method"], "dfa-product-emptiness")
        self.assertIn("legal_language", proof)
        self.assertGreater(len(proof["states"]), 0)
        self.assertGreater(len(proof["transitions"]), 0)
        self.assertEqual(proof["alphabet"]["separator"], "/")
        self.assertTrue(proof["alphabet"]["other"])

    def test_both_directions_of_equivalence_verify(self):
        a = Pattern("a/[bc]")
        b = Union((Pattern("a/b"), Pattern("a/c")))
        result = check_equivalence(a, b)
        self.assertIs(result["equivalent"], True)
        self.assertIs(
            verify_inclusion_proof(a, b, result["a_subset_b"]["proof"])["valid"],
            True,
        )
        self.assertIs(
            verify_inclusion_proof(b, a, result["b_subset_a"]["proof"])["valid"],
            True,
        )

    def test_tampered_accept_flags_rejected(self):
        a, b = Pattern("a/b"), Pattern("a/**")
        proof = make_proof(a, b)
        tampered = copy.deepcopy(proof)
        tampered["states"][0]["accepts"][0] = not tampered["states"][0]["accepts"][0]
        self.assertIs(verify_inclusion_proof(a, b, tampered)["valid"], False)

    def test_tampered_transition_rejected(self):
        a, b = Pattern("a/b"), Pattern("a/**")
        proof = make_proof(a, b)
        tampered = copy.deepcopy(proof)
        tr = tampered["transitions"][0]
        tr["to"] = (tr["to"] + 1) % len(tampered["states"])
        self.assertIs(verify_inclusion_proof(a, b, tampered)["valid"], False)

    def test_missing_transition_rejected(self):
        a, b = Pattern("a/b"), Pattern("a/**")
        proof = make_proof(a, b)
        tampered = copy.deepcopy(proof)
        tampered["transitions"] = tampered["transitions"][1:]
        self.assertIs(verify_inclusion_proof(a, b, tampered)["valid"], False)

    def test_proof_for_different_rules_rejected(self):
        a, b = Pattern("a/b"), Pattern("a/**")
        proof = make_proof(a, b)
        verdict = verify_inclusion_proof(a, Pattern("**"), proof)
        self.assertIs(verdict["valid"], False)

    def test_forged_bad_state_rejected(self):
        a, b = Pattern("a/b"), Pattern("a/**")
        proof = make_proof(a, b)
        forged = copy.deepcopy(proof)
        victim = forged["states"][0]
        victim["accepts"] = [True, True, True]
        self.assertIs(verify_inclusion_proof(a, b, forged)["valid"], False)


if __name__ == "__main__":
    unittest.main()
