import unittest

from pathpolicy.proof import (
    check_equivalence,
    check_inclusion,
    find_difference,
    verify_witness,
)
from pathpolicy.ruleset import Minus, Pattern, Union


class DifferenceTests(unittest.TestCase):
    def test_shortest_witness_uses_starstar_zero_segments(self):
        # "a" is in "a/**" (zero segments) but not in "a/*/c".
        diff = find_difference(Pattern("a/**"), Pattern("a/*/c"))
        self.assertEqual(diff["status"], "nonempty")
        self.assertEqual(diff["witnesses"], ["a"])
        self.assertTrue(diff["witness_verified"])

    def test_empty_root_path_as_witness(self):
        # The root "" is legal, matched by "**" but not by "a".
        diff = find_difference(Pattern("**"), Pattern("a"))
        self.assertEqual(diff["status"], "nonempty")
        self.assertEqual(diff["witnesses"], [""])
        self.assertTrue(verify_witness("", Pattern("**"), Pattern("a")))

    def test_multiple_same_length_counterexamples(self):
        expr = Union((Pattern("a/x"), Pattern("a/y")))
        diff = find_difference(expr, Pattern("a/z"), all_shortest=True)
        self.assertEqual(diff["status"], "nonempty")
        self.assertEqual(sorted(diff["witnesses"]), ["a/x", "a/y"])

    def test_witness_instantiates_unmentioned_characters(self):
        diff = find_difference(Pattern("a/?"), Pattern("a/x"))
        self.assertEqual(diff["status"], "nonempty")
        (witness,) = diff["witnesses"]
        self.assertEqual(len(witness), 3)
        self.assertTrue(witness.startswith("a/"))
        self.assertNotEqual(witness, "a/x")
        self.assertTrue(diff["witness_verified"])

    def test_witnesses_are_always_legal_normalized_paths(self):
        cases = [
            (Pattern("**"), Pattern("a")),
            (Pattern("a/**"), Pattern("a/b")),
            (Minus(Pattern("**"), Pattern("x/**")), Pattern("y")),
            (Pattern("[^a]/*"), Pattern("b/c")),
        ]
        for a, b in cases:
            diff = find_difference(a, b, all_shortest=True)
            self.assertEqual(diff["status"], "nonempty", (a, b))
            for witness in diff["witnesses"]:
                self.assertTrue(
                    verify_witness(witness, a, b),
                    "witness %r failed normalization/interpreter re-check" % witness,
                )

    def test_empty_difference_yields_proof_not_sample(self):
        diff = find_difference(Pattern("a/b"), Pattern("a/**"))
        self.assertEqual(diff["status"], "empty")
        proof = diff["proof"]
        self.assertEqual(proof["type"], "inclusion-proof")
        self.assertTrue(proof["states"])
        self.assertTrue(proof["transitions"])
        self.assertEqual(proof["bad_states"], [])

    def test_self_difference_is_empty(self):
        diff = find_difference(Pattern("a/**/[bc]"), Pattern("a/**/[bc]"))
        self.assertEqual(diff["status"], "empty")


class InclusionEquivalenceTests(unittest.TestCase):
    def test_strict_inclusion(self):
        ab = check_inclusion(Pattern("a/b"), Pattern("a/**"))
        self.assertEqual(ab["status"], "included")
        ba = check_inclusion(Pattern("a/**"), Pattern("a/b"))
        self.assertEqual(ba["status"], "not_included")
        self.assertEqual(ba["witness"], "a")

    def test_equivalent_formulations(self):
        result = check_equivalence(
            Pattern("a/[bc]"), Union((Pattern("a/b"), Pattern("a/c")))
        )
        self.assertIs(result["equivalent"], True)
        self.assertEqual(result["a_subset_b"]["status"], "included")
        self.assertEqual(result["b_subset_a"]["status"], "included")

    def test_not_equivalent(self):
        result = check_equivalence(Pattern("a/**"), Pattern("a/*"))
        self.assertIs(result["equivalent"], False)

    def test_policy_upgrade_check(self):
        old = {"allow": ["src/**", "docs/**"], "deny": ["src/secret/**"]}
        new = {"allow": ["src/**", "docs/**", "tests/**"], "deny": ["src/secret/**"]}
        from pathpolicy.ruleset import expr_from_json

        old_expr = expr_from_json(old)
        new_expr = expr_from_json(new)
        # The upgrade must not shrink the allowed set...
        self.assertEqual(check_inclusion(old_expr, new_expr)["status"], "included")
        # ...and any growth must be exactly the intended new paths.
        growth = check_inclusion(new_expr, old_expr)
        self.assertEqual(growth["status"], "not_included")
        self.assertTrue(growth["witness"].startswith("tests"))
        # The deny rule still wins inside the grown set.
        leak = check_inclusion(
            expr_from_json({"allow": ["src/secret/**"]}), new_expr
        )
        self.assertEqual(leak["status"], "not_included")


if __name__ == "__main__":
    unittest.main()
