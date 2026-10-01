"""Acceptance test A: 300 randomly generated closed terms of depth <= 4,
cross-validated between the main inferencer (hmtype.infer) and an
independent reference implementation (hmtype.check, textbook Algorithm W
with explicit substitutions)."""
import random
import unittest

from hmtype import ast, check
from hmtype.infer import infer_program

SEED = 20261001
NUM_TERMS = 300
MAX_DEPTH = 4


class TermGen:
    def __init__(self, rng: random.Random) -> None:
        self.rng = rng
        self.counter = 0

    def fresh_name(self) -> str:
        self.counter += 1
        return f"v{self.counter}"

    def span(self) -> ast.Span:
        return ast.Span(1, 1, 1, 1)

    def gen(self, env, depth) -> ast.Node:
        rng = self.rng
        if depth <= 0:
            choices = ["int", "bool"] + (["var", "var"] if env else [])
        else:
            choices = [
                "int", "bool", "var", "lam", "app", "let",
                "if", "fix", "binop", "tuple",
            ]
        kind = rng.choice(choices)
        if kind == "var" and not env:
            kind = "int"
        span = self.span()
        if kind == "int":
            return ast.IntLit(rng.randint(0, 9), span)
        if kind == "bool":
            return ast.BoolLit(rng.random() < 0.5, span)
        if kind == "var":
            return ast.Var(rng.choice(env), span)
        if kind == "lam":
            name = self.fresh_name()
            return ast.Lam(name, self.gen(env + [name], depth - 1), span)
        if kind == "app":
            return ast.App(
                self.gen(env, depth - 1), self.gen(env, depth - 1), span
            )
        if kind == "let":
            name = self.fresh_name()
            value = self.gen(env, depth - 1)
            body = self.gen(env + [name], depth - 1)
            return ast.Let(name, value, body, span)
        if kind == "if":
            return ast.If(
                self.gen(env, depth - 1),
                self.gen(env, depth - 1),
                self.gen(env, depth - 1),
                span,
            )
        if kind == "fix":
            name = self.fresh_name()
            return ast.Fix(name, self.gen(env + [name], depth - 1), span)
        if kind == "binop":
            op = rng.choice(["+", "-", "*", "<", ">", "<=", ">=", "=", "<>"])
            return ast.BinOp(
                op, self.gen(env, depth - 1), self.gen(env, depth - 1), span
            )
        if kind == "tuple":
            n = rng.randint(2, 3)
            return ast.TupleLit(
                tuple(self.gen(env, depth - 1) for _ in range(n)), span
            )
        raise AssertionError(kind)  # pragma: no cover


class TestRandomCrossValidation(unittest.TestCase):
    def test_300_random_closed_terms_agree_with_reference(self):
        rng = random.Random(SEED)
        gen = TermGen(rng)
        well_typed = 0
        ill_typed = 0
        for i in range(NUM_TERMS):
            term = gen.gen([], MAX_DEPTH)
            results, errors = infer_program([("it", term)])
            main_ok = not errors
            try:
                ref_type = check.infer_closed(term)
                ref_ok = True
            except check.IllTyped:
                ref_ok = False
            with self.subTest(term_index=i):
                self.assertEqual(
                    main_ok, ref_ok,
                    f"term {i}: main={main_ok} reference={ref_ok} "
                    f"ast={term!r}",
                )
                if main_ok and ref_ok:
                    main_type = dict(results)["it"]
                    self.assertEqual(
                        main_type, ref_type,
                        f"term {i}: main type {main_type} != reference "
                        f"{ref_type}",
                    )
            if main_ok:
                well_typed += 1
            else:
                ill_typed += 1
        # sanity: the sample must exercise both outcomes meaningfully
        self.assertGreater(well_typed, 50)
        self.assertGreater(ill_typed, 50)
        print(f"\nacceptance A: {well_typed} well-typed, "
              f"{ill_typed} ill-typed out of {NUM_TERMS} terms "
              f"(seed={SEED}, depth<={MAX_DEPTH})")


if __name__ == "__main__":
    unittest.main()
