"""Seeded fuzz cross-checks between the automaton engine and the
independent interpreter, plus proof/witness validation on random rules."""

import random
import unittest

from pathpolicy.enumerate import legal_paths
from pathpolicy.interpreter import interp_match_normalized
from pathpolicy.normalize import normalize_path
from pathpolicy.proof import check_inclusion, verify_inclusion_proof
from pathpolicy.ruleset import expr_dfa, expr_from_json, run_dfa

NAMES = ["a", "b", "c"]


def _rand_seg(rng):
    r = rng.random()
    if r < 0.18:
        return "*"
    if r < 0.36:
        return "**"
    if r < 0.44:
        return rng.choice(["?", "[ab]", "[^ab]", "[a-c]", "[^a-c]", "a?", "?b", "[^b]c"])
    return "".join(rng.choice("aabbcc") for _ in range(rng.randint(1, 3)))


def _rand_pattern(rng):
    return "/".join(_rand_seg(rng) for _ in range(rng.randint(0, 4)))


def _rand_expr(rng, depth=0):
    r = rng.random()
    if depth > 1 or r < 0.5:
        return _rand_pattern(rng)
    if r < 0.7:
        return {"union": [_rand_expr(rng, depth + 1) for _ in range(rng.randint(1, 3))]}
    if r < 0.85:
        return {"minus": [_rand_expr(rng, depth + 1), _rand_expr(rng, depth + 1)]}
    return {
        "allow": [_rand_expr(rng, depth + 1) for _ in range(rng.randint(1, 2))],
        "deny": [_rand_expr(rng, depth + 1) for _ in range(rng.randint(0, 2))],
    }


class FuzzTests(unittest.TestCase):
    def test_automaton_interpreter_agree(self):
        rng = random.Random(20261004)
        paths = list(legal_paths(NAMES, 3))
        for _ in range(400):
            expr = expr_from_json(_rand_expr(rng))
            dfa = expr_dfa(expr)
            for path in rng.sample(paths, 15):
                self.assertEqual(
                    run_dfa(dfa, path),
                    interp_match_normalized(expr, path),
                    msg="expr=%r path=%r" % (expr, path),
                )

    def test_inclusion_outcomes_are_consistent(self):
        rng = random.Random(20261004)
        paths = list(legal_paths(NAMES, 3))
        for _ in range(120):
            a = expr_from_json(_rand_expr(rng))
            b = expr_from_json(_rand_expr(rng))
            result = check_inclusion(a, b)
            if result["status"] == "included":
                verdict = verify_inclusion_proof(a, b, result["proof"])
                self.assertIs(verdict["valid"], True, verdict)
                for path in rng.sample(paths, 15):
                    self.assertFalse(
                        interp_match_normalized(a, path)
                        and not interp_match_normalized(b, path),
                        msg="a=%r b=%r path=%r" % (a, b, path),
                    )
            elif result["status"] == "not_included":
                witness = result["witness"]
                self.assertEqual(normalize_path(witness), witness)
                self.assertTrue(interp_match_normalized(a, witness))
                self.assertFalse(interp_match_normalized(b, witness))
            else:
                self.fail("unexpected unknown with default budget")


if __name__ == "__main__":
    unittest.main()
