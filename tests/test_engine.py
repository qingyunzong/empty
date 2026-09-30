import random
import unittest

import _path  # noqa: F401

from rule_engine import DerivedFactError, Engine, NotBaseFactError, RuleSyntaxError


def naive_closure(base, rules):
    """Independent reference implementation: plain saturation in rule-id order."""
    facts = set(base)
    changed = True
    while changed:
        changed = False
        for rule in sorted(rules, key=lambda r: r.id):
            if all(p in facts for p in rule.pos) and all(
                n not in facts for n in rule.neg
            ):
                if rule.head not in facts:
                    facts.add(rule.head)
                    changed = True
    return facts


class DoubleProofTests(unittest.TestCase):
    """Acceptance A: retracting one of two proofs keeps the fact."""

    def setUp(self):
        self.engine = Engine()
        self.engine.assert_fact("a")
        self.engine.assert_fact("b")
        self.engine.add_rule("d:-a")
        self.engine.add_rule("d:-b")

    def test_two_proofs(self):
        self.assertTrue(self.engine.derives("d"))
        self.assertEqual(len(self.engine.proofs("d")), 2)

    def test_retract_one_proof_fact_survives(self):
        self.engine.retract_fact("a")
        self.assertTrue(self.engine.derives("d"))
        self.assertEqual(len(self.engine.proofs("d")), 1)

    def test_retract_both_proofs_fact_gone(self):
        self.engine.retract_fact("a")
        self.engine.retract_fact("b")
        self.assertFalse(self.engine.derives("d"))


class CascadeTests(unittest.TestCase):
    """Acceptance B: retracting a base fact cascades and can be reactivated."""

    def setUp(self):
        self.engine = Engine()
        self.engine.assert_fact("a")
        self.engine.add_rule("b:-a")
        self.engine.add_rule("c:-b")
        self.engine.add_rule("d:-c")

    def test_chain_derived(self):
        self.assertEqual(self.engine.derived, {"b", "c", "d"})

    def test_retract_cascades(self):
        self.engine.retract_fact("a")
        self.assertEqual(self.engine.derived, set())
        self.assertFalse(self.engine.derives("d"))

    def test_reassert_reactivates(self):
        self.engine.retract_fact("a")
        self.engine.assert_fact("a")
        self.assertEqual(self.engine.derived, {"b", "c", "d"})


class NegationTests(unittest.TestCase):
    """Acceptance C: asserting the negated atom withdraws the derivation."""

    def setUp(self):
        self.engine = Engine()
        self.engine.add_rule("d:-a,not c")
        self.engine.assert_fact("a")

    def test_derives_while_negated_atom_absent(self):
        self.assertTrue(self.engine.derives("d"))

    def test_assert_negated_atom_withdraws(self):
        self.engine.assert_fact("c")
        self.assertFalse(self.engine.derives("d"))

    def test_retract_negated_atom_restores(self):
        self.engine.assert_fact("c")
        self.engine.retract_fact("c")
        self.assertTrue(self.engine.derives("d"))

    def test_retraction_enables_new_derivation(self):
        engine = Engine()
        engine.add_rule("e:-not x")
        self.assertTrue(engine.derives("e"))
        engine.assert_fact("x")
        self.assertFalse(engine.derives("e"))


class SemanticsTests(unittest.TestCase):
    def test_assert_derived_rejected(self):
        engine = Engine()
        engine.assert_fact("a")
        engine.add_rule("d:-a")
        with self.assertRaises(DerivedFactError):
            engine.assert_fact("d")

    def test_retract_non_base_rejected(self):
        engine = Engine()
        engine.assert_fact("a")
        engine.add_rule("d:-a")
        with self.assertRaises(NotBaseFactError):
            engine.retract_fact("d")
        with self.assertRaises(NotBaseFactError):
            engine.retract_fact("never_seen")

    def test_unknown_predicates_allowed(self):
        engine = Engine()
        engine.assert_fact("totally_unknown_predicate")
        self.assertTrue(engine.derives("totally_unknown_predicate"))
        self.assertFalse(engine.derives("other_unknown"))

    def test_rule_syntax_errors(self):
        engine = Engine()
        for bad in (":-a", "d:-a,,b", "d:-not", "d:-a,", "d:-", ":-", "", "d:-1a"):
            with self.assertRaises(RuleSyntaxError, msg=bad):
                engine.add_rule(bad)

    def test_cycles_converge(self):
        engine = Engine()
        engine.add_rule("p:-q")
        engine.add_rule("q:-p")
        engine.add_rule("r:-r")
        self.assertEqual(engine.derived, set())
        engine.assert_fact("p")
        self.assertEqual(engine.derived, {"q"})

    def test_deterministic_regardless_of_command_interleaving(self):
        # Same final program (same rule ids, same base facts) reached via
        # different command orders must yield the same fact set.
        first = Engine()
        first.add_rule("m:-x")
        first.add_rule("z:-m,not y")
        first.add_rule("y:-x")
        first.assert_fact("x")
        second = Engine()
        second.assert_fact("x")
        second.add_rule("m:-x")
        second.add_rule("z:-m,not y")
        second.add_rule("y:-x")
        self.assertEqual(first.facts, second.facts)
        # Rule id order decides `not`: z fires (id 1) before y exists (id 2).
        self.assertEqual(first.facts, {"x", "m", "y", "z"})

    def test_reverse_dependency_index(self):
        engine = Engine()
        engine.assert_fact("a")
        r1 = engine.add_rule("b:-a")
        r2 = engine.add_rule("c:-a,b")
        engine.add_rule("d:-not a")
        self.assertEqual(engine.dependents_of("a"), {r1.id, r2.id})
        self.assertEqual(engine.dependents_of("b"), {r2.id})


class RandomizedDifferentialTests(unittest.TestCase):
    """Acceptance D: random programs with 30 facts vs naive saturation."""

    def random_program(self, rng):
        universe = [f"p{i}" for i in range(12)] + [
            f"q{i}(a)" for i in range(6)
        ]
        base = rng.sample(universe, 30 if len(universe) >= 30 else len(universe))
        while len(base) < 30:
            fact = f"extra{rng.randrange(1000)}"
            if fact not in base:
                base.append(fact)
        rules = []
        for _ in range(rng.randrange(8, 20)):
            head = rng.choice(universe)
            pos = rng.sample(universe, rng.randrange(1, 4))
            neg = rng.sample(universe, rng.randrange(0, 3))
            rules.append((head, tuple(pos), tuple(neg)))
        return base, rules

    def run_engine(self, base, rules):
        engine = Engine()
        for fact in base:
            engine.assert_fact(fact)
        for head, pos, neg in rules:
            body = ",".join([*pos, *(f"not {n}" for n in neg)])
            engine.add_rule(f"{head}:-{body}")
        return engine

    def test_random_programs_match_naive(self):
        for seed in range(25):
            rng = random.Random(seed)
            base, rule_specs = self.random_program(rng)
            engine = self.run_engine(base, rule_specs)
            reference_rules = [
                engine.rules[i] for i in range(len(rule_specs))
            ]
            expected = naive_closure(base, reference_rules)
            with self.subTest(seed=seed):
                self.assertEqual(engine.facts, expected)
                for fact in sorted(expected):
                    self.assertTrue(engine.derives(fact))

    def test_random_retraction_matches_naive(self):
        for seed in range(25, 45):
            rng = random.Random(seed)
            base, rule_specs = self.random_program(rng)
            engine = self.run_engine(base, rule_specs)
            victim = rng.choice(sorted(engine.base))
            engine.retract_fact(victim)
            remaining = sorted(set(base) - {victim})
            expected = naive_closure(remaining, engine.rules)
            with self.subTest(seed=seed, victim=victim):
                self.assertEqual(engine.facts, expected)


if __name__ == "__main__":
    unittest.main()
