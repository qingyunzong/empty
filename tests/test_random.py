"""Acceptance D: randomized differential test.

Runs random assert/retract/rule sequences against the incremental engine
and compares the full fact set with a naive from-scratch saturation
(`naive_closure`) after every single operation.

Rules are generated stratified (negative atoms only reference strictly
lower levels) so a unique fixpoint exists and both implementations must
agree; positive cycles across the same level are allowed and exercised.
"""

import random
import unittest

from rule_engine import Engine, naive_closure

PREDICATES = [f"p{i}" for i in range(12)]


def make_random_rule(rng, levels):
    head = rng.choice(PREDICATES)
    head_level = levels[head]
    pos_pool = [p for p in PREDICATES if levels[p] <= head_level]
    neg_pool = [p for p in PREDICATES if levels[p] < head_level]
    pos = rng.sample(pos_pool, k=min(len(pos_pool), rng.randint(0, 3)))
    neg = rng.sample(neg_pool, k=min(len(neg_pool), rng.randint(0, 2)))
    body = list(pos) + [f"not {n}" for n in neg]
    rng.shuffle(body)
    return f"{head}:-{','.join(body)}" if body else f"{head}:-a_never"


class TestRandomizedDifferential(unittest.TestCase):
    def run_scenario(self, seed, initial_facts=30, ops=200):
        rng = random.Random(seed)
        levels = {p: rng.randint(0, 2) for p in PREDICATES}
        eng = Engine()
        for _ in range(rng.randint(5, 15)):
            eng.add_rule(make_random_rule(rng, levels))

        def check(step):
            expected = naive_closure(set(eng.base), eng.rules)
            self.assertEqual(
                eng.facts,
                expected,
                msg=f"seed={seed} step={step}\n"
                f"incremental={sorted(eng.facts)}\nnaive={sorted(expected)}",
            )

        check("initial")
        step = 0
        # 30 random base facts interleaved with other operations.
        facts_to_assert = [rng.choice(PREDICATES) for _ in range(initial_facts)]
        while facts_to_assert or step < ops:
            roll = rng.random()
            if facts_to_assert and (roll < 0.4 or step >= ops):
                fact = facts_to_assert.pop()
                if not eng.is_derived(fact):  # assert of derived -> exit 6
                    eng.assert_fact(fact)
            elif roll < 0.65:
                eng.retract_fact(rng.choice(PREDICATES))
            elif roll < 0.8:
                eng.add_rule(make_random_rule(rng, levels))
            else:
                fact = rng.choice(PREDICATES)
                if not eng.is_derived(fact):
                    eng.assert_fact(fact)
            step += 1
            check(step)

    def test_random_scenarios(self):
        for seed in (1, 2, 3, 42, 2026):
            with self.subTest(seed=seed):
                self.run_scenario(seed)


if __name__ == "__main__":
    unittest.main()
