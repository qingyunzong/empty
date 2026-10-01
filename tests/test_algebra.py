import json
import unittest

from regex_deriv.algebra import (
    equivalent, included, match, shortest_difference, verify_proof,
)
from regex_deriv.alphabet import Alphabet
from regex_deriv.parser import parse
from regex_deriv.syntax import from_raw

AB = Alphabet.from_string("ab")
ABC = Alphabet.from_string("abc")


def rx(pattern, alphabet=AB):
    return from_raw(parse(pattern, alphabet))


class TestMatch(unittest.TestCase):
    def test_basic(self):
        r = rx("a*b")
        self.assertTrue(match(r, "b", AB))
        self.assertTrue(match(r, "aaab", AB))
        self.assertFalse(match(r, "aba", AB))
        self.assertFalse(match(r, "", AB))

    def test_empty_string(self):
        self.assertTrue(match(rx("ε"), "", AB))
        self.assertFalse(match(rx("ε"), "a", AB))
        self.assertFalse(match(rx("∅"), "", AB))

    def test_out_of_alphabet_char_never_matches(self):
        self.assertFalse(match(rx("~∅"), "x", AB))  # universal over {a,b} only
        self.assertFalse(match(rx("a*"), "ax", AB))


class TestEquivalent(unittest.TestCase):
    def test_equivalent(self):
        cases = [
            ("a(ba)*", "(ab)*a"),
            ("(a|b)*", "~∅"),
            ("a*", "ε|aa*"),
            ("(a|b)*ab", "~(~((a|b)*ab))"),
            ("a*&a*", "a*"),
        ]
        for p, q in cases:
            r = equivalent(rx(p), rx(q), AB)
            self.assertEqual(r["status"], "equivalent", (p, q))
            self.assertTrue(verify_proof(rx(p), rx(q), AB, r["proof"]))

    def test_not_equivalent_witness(self):
        r = equivalent(rx("a*"), rx("a*b"), AB)
        self.assertEqual(r["status"], "not_equivalent")
        self.assertEqual(r["witness"], "")  # a* accepts "", a*b does not
        r = equivalent(rx("a*"), rx("a*|b"), AB)
        self.assertEqual(r["status"], "not_equivalent")
        self.assertEqual(r["witness"], "b")

    def test_self_equivalent(self):
        r = equivalent(rx("(a|b)*ab"), rx("(a|b)*ab"), AB)
        self.assertEqual(r["status"], "equivalent")


class TestIncluded(unittest.TestCase):
    def test_included(self):
        r = included(rx("a*"), rx("(a|b)*"), AB)
        self.assertEqual(r["status"], "included")
        self.assertTrue(verify_proof(rx("a*"), rx("(a|b)*"), AB, r["proof"]))

    def test_not_included_witness(self):
        r = included(rx("(a|b)*"), rx("a*"), AB)
        self.assertEqual(r["status"], "not_included")
        self.assertEqual(r["witness"], "b")

    def test_included_reflexive_and_empty(self):
        self.assertEqual(included(rx("∅"), rx("a*"), AB)["status"], "included")
        r = included(rx("a*"), rx("∅"), AB)
        self.assertEqual(r["status"], "not_included")
        self.assertEqual(r["witness"], "")


class TestShortestDifference(unittest.TestCase):
    def test_shortest_then_lexicographic(self):
        # candidates of length 1: "a" (r1 only), "b" (r2 only), "c" (r1 only)
        r = shortest_difference(rx("a|c", ABC), rx("b", ABC), ABC)
        self.assertEqual(r["status"], "different")
        self.assertEqual(r["witness"], "a")

    def test_tie_broken_by_lex_order(self):
        r = shortest_difference(rx("b", ABC), rx("c", ABC), ABC)
        self.assertEqual(r["witness"], "b")

    def test_shorter_beats_lexicographically_smaller(self):
        # "zz..." not in alphabet; shortest diff of a|ab vs a is "ab"
        r = shortest_difference(rx("a|ab"), rx("a"), AB)
        self.assertEqual(r["witness"], "ab")

    def test_empty_string_difference(self):
        r = shortest_difference(rx("a*"), rx("a+"), AB)
        self.assertEqual(r["witness"], "")

    def test_equivalent_returns_proof(self):
        r = shortest_difference(rx("a(ba)*"), rx("(ab)*a"), AB)
        self.assertEqual(r["status"], "equivalent")
        self.assertTrue(verify_proof(rx("a(ba)*"), rx("(ab)*a"), AB,
                                     r["proof"]))


class TestBudgetResume(unittest.TestCase):
    def test_one_step_budget_then_resume(self):
        r1, r2 = rx("a(ba)*"), rx("(ab)*a")
        u = equivalent(r1, r2, AB, max_states=1)
        self.assertEqual(u["status"], "unknown")
        self.assertEqual(u["explored"], 1)
        json.dumps(u)  # frontier must be JSON-serializable
        r = equivalent(r1, r2, AB, frontier=u["frontier"])
        self.assertEqual(r["status"], "equivalent")
        self.assertTrue(verify_proof(r1, r2, AB, r["proof"]))

    def test_zero_budget(self):
        r1, r2 = rx("a(ba)*"), rx("(ab)*a")
        u = equivalent(r1, r2, AB, max_states=0)
        self.assertEqual(u["status"], "unknown")
        r = equivalent(r1, r2, AB, frontier=u["frontier"])
        self.assertEqual(r["status"], "equivalent")

    def test_resume_step_by_step(self):
        r1, r2 = rx("(a|b)*ab"), rx("~(ε|a|b|(a|b)*a|(a|b)*bb)")
        u = equivalent(r1, r2, AB, max_states=1)
        steps = 0
        while u["status"] == "unknown":
            u = equivalent(r1, r2, AB, max_states=u["explored"] + 1,
                           frontier=u["frontier"])
            steps += 1
            self.assertLess(steps, 20)
        self.assertEqual(u["status"], "equivalent")
        self.assertTrue(verify_proof(r1, r2, AB, u["proof"]))

    def test_resume_finds_witness(self):
        r1, r2 = rx("a*"), rx("a*|b")
        u = shortest_difference(r1, r2, AB, max_states=1)
        self.assertEqual(u["status"], "unknown")
        r = shortest_difference(r1, r2, AB, frontier=u["frontier"])
        self.assertEqual(r["status"], "different")
        self.assertEqual(r["witness"], "b")

    def test_resume_binding_mismatch_rejected(self):
        r1, r2 = rx("a(ba)*"), rx("(ab)*a")
        u = equivalent(r1, r2, AB, max_states=1)
        # different second expression
        with self.assertRaises(ValueError):
            equivalent(r1, rx("(ab)*b"), AB, frontier=u["frontier"])
        # different alphabet
        with self.assertRaises(ValueError):
            equivalent(r1, r2, ABC, frontier=u["frontier"])
        # different operation
        with self.assertRaises(ValueError):
            included(r1, r2, AB, frontier=u["frontier"])

    def test_unknown_is_not_a_verdict(self):
        # budget too small to see the counterexample: must stay "unknown",
        # never "equivalent"/"not_equivalent" without exploring everything
        r1, r2 = rx("a*b"), rx("a*b|b")  # agree on "" ; differ on "b"
        u = equivalent(r1, r2, AB, max_states=1)
        self.assertEqual(u["status"], "unknown")
        self.assertNotIn("proof", u)
        self.assertNotIn("witness", u)


class TestProofTampering(unittest.TestCase):
    def setUp(self):
        self.r1 = rx("a(ba)*")
        self.r2 = rx("(ab)*a")
        self.proof = equivalent(self.r1, self.r2, AB)["proof"]

    def test_genuine_proof_verifies(self):
        self.assertTrue(verify_proof(self.r1, self.r2, AB, self.proof))

    def test_migrated_proof_rejected(self):
        # proof of (r1, r2) reused for a different pair
        self.assertFalse(verify_proof(self.r1, rx("(ab)*b"), AB, self.proof))
        self.assertFalse(verify_proof(rx("b(ab)*"), self.r2, AB, self.proof))

    def test_tampered_transition_target(self):
        bad = json.loads(json.dumps(self.proof))
        bad["transitions"][0][3] ^= 1
        self.assertFalse(verify_proof(self.r1, self.r2, AB, bad))

    def test_tampered_state(self):
        bad = json.loads(json.dumps(self.proof))
        bad["states"][1][0] = "eps"
        self.assertFalse(verify_proof(self.r1, self.r2, AB, bad))

    def test_dropped_transition(self):
        bad = json.loads(json.dumps(self.proof))
        bad["transitions"] = bad["transitions"][1:]
        self.assertFalse(verify_proof(self.r1, self.r2, AB, bad))

    def test_wrong_alphabet_rejected(self):
        self.assertFalse(verify_proof(self.r1, self.r2, ABC, self.proof))

    def test_malformed_proof(self):
        self.assertFalse(verify_proof(self.r1, self.r2, AB, {}))
        self.assertFalse(verify_proof(self.r1, self.r2, AB,
                                      {"states": [], "transitions": [],
                                       "start": 0}))


if __name__ == "__main__":
    unittest.main()
