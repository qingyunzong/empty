import unittest

from rule_engine import AssertDerivedError, Engine, RuleSyntaxError


class TestProofSemantics(unittest.TestCase):
    def test_a_double_proof_survives_single_retraction(self):
        # Acceptance A: two proofs for p; removing one keeps p.
        eng = Engine()
        eng.add_rule("p:-a")
        eng.add_rule("p:-b")
        eng.assert_fact("a")
        eng.assert_fact("b")
        self.assertTrue(eng.holds("p"))
        self.assertTrue(eng.is_derived("p"))
        eng.retract_fact("a")
        self.assertTrue(eng.holds("p"))  # second proof still valid
        eng.retract_fact("b")
        self.assertFalse(eng.holds("p"))  # all proofs gone

    def test_b_retract_cascades_and_reactivates(self):
        # Acceptance B: cascade invalidation, then re-derivation.
        eng = Engine()
        eng.add_rule("q:-p")
        eng.add_rule("r:-q")
        eng.assert_fact("p")
        self.assertTrue(eng.holds("q"))
        self.assertTrue(eng.holds("r"))
        eng.retract_fact("p")
        self.assertFalse(eng.holds("p"))
        self.assertFalse(eng.holds("q"))
        self.assertFalse(eng.holds("r"))
        eng.assert_fact("p")
        self.assertTrue(eng.holds("q"))
        self.assertTrue(eng.holds("r"))

    def test_c_negative_condition_revokes_on_assert(self):
        # Acceptance C: 'not b' checked against current facts.
        eng = Engine()
        eng.add_rule("p:-a,not b")
        eng.assert_fact("a")
        self.assertTrue(eng.holds("p"))
        eng.assert_fact("b")  # now 'not b' fails
        self.assertFalse(eng.holds("p"))
        eng.retract_fact("b")  # retraction triggers new derivation
        self.assertTrue(eng.holds("p"))

    def test_negative_condition_on_derived_fact(self):
        eng = Engine()
        eng.add_rule("b:-c")
        eng.add_rule("p:-a,not b")
        eng.assert_fact("a")
        self.assertTrue(eng.holds("p"))
        eng.assert_fact("c")  # derives b, which kills p
        self.assertTrue(eng.holds("b"))
        self.assertFalse(eng.holds("p"))
        eng.retract_fact("c")  # b disappears, p comes back
        self.assertFalse(eng.holds("b"))
        self.assertTrue(eng.holds("p"))

    def test_assert_derived_fact_rejected(self):
        eng = Engine()
        eng.add_rule("p:-a")
        eng.assert_fact("a")
        with self.assertRaises(AssertDerivedError):
            eng.assert_fact("p")

    def test_assert_base_fact_allowed_even_if_derivable(self):
        eng = Engine()
        eng.assert_fact("p")  # p is base first
        eng.add_rule("p:-a")
        eng.assert_fact("a")  # now p also has a proof; still base
        self.assertFalse(eng.is_derived("p"))
        eng.retract_fact("p")  # base removed, proof keeps p alive
        self.assertTrue(eng.holds("p"))
        self.assertTrue(eng.is_derived("p"))
        eng.retract_fact("a")
        self.assertFalse(eng.holds("p"))

    def test_cycles_converge(self):
        # Acceptance: rule cycles allowed, must terminate.
        eng = Engine()
        eng.add_rule("p:-q")
        eng.add_rule("q:-p")
        eng.add_rule("q:-a")
        eng.assert_fact("a")
        self.assertTrue(eng.holds("p"))
        self.assertTrue(eng.holds("q"))
        eng.retract_fact("a")
        self.assertFalse(eng.holds("p"))
        self.assertFalse(eng.holds("q"))

    def test_self_negation_terminates(self):
        eng = Engine()
        eng.add_rule("p:-not p")  # no stable model; must not hang
        eng.assert_fact("a")  # trigger a repair cycle
        self.assertIsInstance(eng.holds("p"), bool)

    def test_retract_unknown_or_derived_is_noop(self):
        eng = Engine()
        eng.add_rule("p:-a")
        eng.assert_fact("a")
        eng.retract_fact("zzz")  # unknown predicate: allowed
        eng.retract_fact("p")  # derived fact: no-op, stays derived
        self.assertTrue(eng.holds("p"))

    def test_unrelated_derivations_untouched_by_retract(self):
        eng = Engine()
        eng.add_rule("p:-a")
        eng.add_rule("q:-b")
        eng.assert_fact("a")
        eng.assert_fact("b")
        proofs_q_before = set(eng.proofs["q"])
        eng.retract_fact("a")
        self.assertFalse(eng.holds("p"))
        self.assertTrue(eng.holds("q"))
        self.assertEqual(eng.proofs["q"], proofs_q_before)


class TestRuleParsing(unittest.TestCase):
    def test_valid_rules(self):
        eng = Engine()
        self.assertEqual(eng.add_rule("p:-a,b,not c"), 0)
        self.assertEqual(eng.add_rule("p :- a , b , not c"), 1)
        self.assertEqual(eng.add_rule("p:-"), 2)  # empty body: always fires
        self.assertTrue(eng.holds("p"))
        rule = eng.rules[0]
        self.assertEqual(rule.head, "p")
        self.assertEqual(rule.pos, ("a", "b"))
        self.assertEqual(rule.neg, ("c",))

    def test_syntax_errors(self):
        eng = Engine()
        for bad in ["p", ":-a", "p:-a,,b", "p:-a,", "p:-not", "1p:-a",
                    "p:-a b", "not p:-a", "p:a"]:
            with self.assertRaises(RuleSyntaxError, msg=bad):
                eng.add_rule(bad)

    def test_not_prefix_requires_space(self):
        eng = Engine()
        eng.add_rule("p:-notx")  # 'notx' is an ordinary atom
        eng.assert_fact("notx")
        self.assertTrue(eng.holds("p"))


if __name__ == "__main__":
    unittest.main()
