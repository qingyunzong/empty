"""Cross-check the analyser against independent bounded parse-tree
enumeration for all words of length <= 6."""
import itertools
import unittest

from regex_ambiguity import (Builder, analyze, verify_parse, alphabet,
                             enumerate_parses, nullable_star_ids,
                             tree_contains_any)
from regex_ambiguity.parses import from_json as parse_from_json

MAX_LEN = 6


def expected_verdict(root, max_len=MAX_LEN):
    """Independent oracle: first ambiguous word in (length, lex) order."""
    alpha = alphabet(root)
    pump_ids = nullable_star_ids(root)
    for length in range(max_len + 1):
        for tup in itertools.product(alpha, repeat=length):
            word = "".join(tup)
            trees = enumerate_parses(root, word)
            infinite = any(tree_contains_any(t, pump_ids) for t in trees)
            if infinite or len(trees) >= 2:
                return ("ambiguous", word, infinite)
    return ("unambiguous", None, False)


def battery():
    """Small ASTs covering the required scenarios."""
    cases = []

    def add(name, fn):
        b = Builder()
        cases.append((name, fn(b)))

    add("a|a", lambda b: b.union(b.lit("a"), b.lit("a")))
    add("(a*)*", lambda b: b.star(b.star(b.lit("a"))))
    add("(a*)(a*)", lambda b: b.cat(b.star(b.lit("a")), b.star(b.lit("a"))))
    add("eps|a*", lambda b: b.union(b.eps(), b.star(b.lit("a"))))
    add("(ba|ba)|(aa|aa)", lambda b: b.union(
        b.union(b.cat(b.lit("b"), b.lit("a")), b.cat(b.lit("b"), b.lit("a"))),
        b.union(b.cat(b.lit("a"), b.lit("a")), b.cat(b.lit("a"), b.lit("a")))))
    add("aaaa(b|c)", lambda b: b.union(
        b.cat(b.lit("a"), b.lit("a"), b.lit("a"), b.lit("a"), b.lit("b")),
        b.cat(b.lit("a"), b.lit("a"), b.lit("a"), b.lit("a"), b.lit("c"))))
    add("a*b", lambda b: b.cat(b.star(b.lit("a")), b.lit("b")))
    add("a", lambda b: b.lit("a"))
    add("(eps|b)*", lambda b: b.star(b.union(b.eps(), b.lit("b"))))
    add("(a|eps)(a|eps)", lambda b: b.cat(
        b.union(b.lit("a"), b.eps()), b.union(b.lit("a"), b.eps())))
    add("a|eps.a", lambda b: b.union(b.lit("a"), b.cat(b.eps(), b.lit("a"))))
    add("aaaaa(b|b)", lambda b: b.cat(
        b.lit("a"), b.lit("a"), b.lit("a"), b.lit("a"), b.lit("a"),
        b.union(b.lit("b"), b.lit("b"))))
    add("(eps)*", lambda b: b.star(b.eps()))
    add("a*|eps", lambda b: b.union(b.star(b.lit("a")), b.eps()))
    add("a*a", lambda b: b.cat(b.star(b.lit("a")), b.lit("a")))
    add("(ab)*", lambda b: b.star(b.cat(b.lit("a"), b.lit("b"))))
    add("(a|b)*c", lambda b: b.cat(
        b.star(b.union(b.lit("a"), b.lit("b"))), b.lit("c")))
    add("eps", lambda b: b.eps())
    add("a*(b|b)", lambda b: b.cat(
        b.star(b.lit("a")), b.union(b.lit("b"), b.lit("b"))))
    return cases


class CrossCheckTest(unittest.TestCase):
    def test_analyser_matches_bounded_enumeration(self):
        for name, root in battery():
            with self.subTest(case=name):
                exp_status, exp_word, exp_inf = expected_verdict(root)
                res = analyze(root, max_steps=2000000)
                self.assertEqual(res["status"], exp_status,
                                 f"{name}: {res} vs expected {exp_status} {exp_word}")
                if exp_status == "unambiguous":
                    self.assertIn("certificate", res)
                    continue
                self.assertEqual(res["word"], exp_word,
                                 f"{name}: witness mismatch")
                self.assertEqual(res["infinite"], exp_inf,
                                 f"{name}: infinite flag mismatch")
                for p in res["parses"]:
                    ok, err = verify_parse(root, res["word"], parse_from_json(p))
                    self.assertTrue(ok, err)
                if exp_inf:
                    self.assertIsNotNone(res["pump"])

    def test_enumerator_itself(self):
        # sanity of the independent oracle on known cases
        b = Builder()
        root = b.cat(b.star(b.lit("a")), b.star(b.lit("a")))
        self.assertEqual(len(enumerate_parses(root, "")), 1)
        self.assertEqual(len(enumerate_parses(root, "a")), 2)
        self.assertEqual(len(enumerate_parses(root, "aa")), 3)
        b2 = Builder()
        root2 = b2.cat(b2.star(b2.lit("a")), b2.lit("b"))
        for n in range(5):
            self.assertEqual(len(enumerate_parses(root2, "a" * n + "b")), 1)


if __name__ == "__main__":
    unittest.main()
