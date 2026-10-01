"""Cross-validation of the derivative engine against the independent
Thompson-construction / set-operation checker by exhaustive enumeration."""
import random
import unittest

from regex_deriv import checker
from regex_deriv.algebra import equivalent, match, shortest_difference
from regex_deriv.alphabet import Alphabet
from regex_deriv.parser import parse
from regex_deriv.syntax import from_raw

AB = Alphabet.from_string("ab")
ABC = Alphabet.from_string("abc")


def cross_check(pattern, alphabet, max_len):
    """Assert derivative match == Thompson match on all short strings."""
    raw = parse(pattern, alphabet)
    node = from_raw(raw)
    for s in checker.strings_upto(alphabet, max_len):
        got = match(node, s, alphabet)
        want = checker.raw_match(raw, s, alphabet)
        if got != want:
            raise AssertionError(f"{pattern!r} on {s!r}: "
                                 f"derivative={got} thompson={want}")


class TestCrossCheckBasic(unittest.TestCase):
    def test_simple_patterns(self):
        for pat in ("a", "ab", "a|b", "a*", "(a|b)*", "a*b*", "(ab)*",
                    "a+", "a?", "(a|b)*ab", "a(ba)*"):
            cross_check(pat, AB, 5)

    def test_complement_and_empty_string(self):
        # ~ε accepts everything except the empty string
        cross_check("~ε", AB, 4)
        node = from_raw(parse("~ε", AB))
        self.assertFalse(match(node, "", AB))
        self.assertTrue(match(node, "a", AB))
        self.assertTrue(match(node, "ab", AB))
        # ~∅ is the universal language (includes ε)
        cross_check("~∅", AB, 4)
        self.assertTrue(match(from_raw(parse("~∅", AB)), "", AB))
        # ~~a == a
        cross_check("~~a", AB, 3)
        # complement of a range accepts ε
        cross_check("~[a-b]", AB, 3)
        self.assertTrue(match(from_raw(parse("~[a-b]", AB)), "", AB))

    def test_empty_language_intersection(self):
        # disjoint ranges: intersection is the empty language
        cross_check("[a-b]&[c-d]", Alphabet.from_string("abcd"), 3)
        r = equivalent(from_raw(parse("[a-b]&[c-d]", AB)),
                       from_raw(parse("∅", AB)), AB)
        self.assertEqual(r["status"], "equivalent")
        # a & ~a is empty
        cross_check("a&~a", AB, 2)
        self.assertEqual(
            equivalent(from_raw(parse("a&~a", AB)),
                       from_raw(parse("∅", AB)), AB)["status"], "equivalent")
        # intersection emptiness vs inclusion
        self.assertEqual(
            equivalent(from_raw(parse("a*&b*", AB)),
                       from_raw(parse("ε", AB)), AB)["status"], "equivalent")

    def test_deep_nested_stars(self):
        depth = 60
        pat = "a"
        for _ in range(depth):
            pat = "(" + pat + ")*"
        cross_check(pat, AB, 3)
        node = from_raw(parse(pat, AB))
        self.assertTrue(match(node, "", AB))
        self.assertTrue(match(node, "aaa", AB))
        self.assertFalse(match(node, "b", AB))

    def test_very_deep_nesting_recursion(self):
        depth = 300
        pat = "a"
        for _ in range(depth):
            pat = "(" + pat + ")*"
        node = from_raw(parse(pat, AB))
        self.assertTrue(match(node, "aaaa", AB))

    def test_interval_endpoints(self):
        alpha = Alphabet.from_string("`abcde")  # ` a b c d e
        cross_check("[a-c]", alpha, 2)
        node = from_raw(parse("[a-c]", alpha))
        self.assertTrue(match(node, "a", alpha))
        self.assertTrue(match(node, "c", alpha))
        self.assertFalse(match(node, "`", alpha))   # lo - 1
        self.assertFalse(match(node, "d", alpha))   # hi + 1
        self.assertFalse(match(node, "", alpha))
        # multi-range alphabet
        alpha2 = Alphabet([(97, 99), (101, 103)])  # a-c, e-g
        cross_check("[b-f]", alpha2, 2)
        node2 = from_raw(parse("[b-f]", alpha2))
        self.assertTrue(match(node2, "b", alpha2))
        self.assertTrue(match(node2, "f", alpha2))
        self.assertFalse(match(node2, "a", alpha2))
        self.assertFalse(match(node2, "g", alpha2))
        self.assertFalse(match(node2, "d", alpha2))  # outside alphabet

    def test_intersection_semantics(self):
        for pat in ("(a|b)*ab & ~(a*)", "a* & (a|b)*", "(a|b)* & ~(ab)",
                    "(a|b)*a & (a|b)*b"):
            cross_check(pat, AB, 4)


class TestCrossCheckEquivalence(unittest.TestCase):
    def assert_consistent(self, p, q, alphabet=AB, max_len=5):
        raw_p, raw_q = parse(p, alphabet), parse(q, alphabet)
        r = shortest_difference(from_raw(raw_p), from_raw(raw_q), alphabet)
        brute = checker.brute_force_difference(raw_p, raw_q, alphabet, max_len)
        if r["status"] == "equivalent":
            self.assertIsNone(brute, (p, q))
        else:
            self.assertEqual(r["status"], "different")
            self.assertEqual(r["witness"], brute, (p, q))

    def test_pairs(self):
        pairs = [
            ("a(ba)*", "(ab)*a"),
            ("a*", "a+"),
            ("(a|b)*", "~∅"),
            ("a*", "a*|b"),
            ("(a|b)*ab", "a*ab"),
            ("~(a&b)", "~a|~b"),          # De Morgan
            ("~(a|b)", "~a&~b"),          # De Morgan
            ("(a*b*)*", "(a|b)*"),
            ("a&b", "∅"),
            ("a|b&c", "(a|b)&(a|c)"),     # over abc below
        ]
        for p, q in pairs[:9]:
            self.assert_consistent(p, q)
        self.assert_consistent("a|b&c", "(a|b)&(a|c)", ABC, 4)

    def test_shortest_difference_tie(self):
        # brute force enumerates in (length, lex) order, so it agrees with
        # the engine on tie-breaking by construction of the check
        self.assert_consistent("a|c", "b", ABC, 3)
        self.assert_consistent("b", "c", ABC, 3)
        self.assert_consistent("ε|ab", "a|ab", AB, 4)


class TestFuzz(unittest.TestCase):
    def rand_raw(self, rng, depth):
        if depth == 0 or rng.random() < 0.35:
            c = rng.choice("ab")
            if rng.random() < 0.2:
                return ("eps",)
            return ("char", ord(c), ord(c))
        op = rng.choice(["union", "inter", "compl", "star", "concat"])
        if op in ("compl", "star"):
            return (op, self.rand_raw(rng, depth - 1))
        return (op, self.rand_raw(rng, depth - 1),
                self.rand_raw(rng, depth - 1))

    def test_fuzz_match_and_equivalence(self):
        rng = random.Random(20261001)
        for i in range(40):
            raw1 = self.rand_raw(rng, 3)
            raw2 = self.rand_raw(rng, 3)
            n1, n2 = from_raw(raw1), from_raw(raw2)
            # match agreement on all strings up to length 4
            for s in checker.strings_upto(AB, 4):
                self.assertEqual(match(n1, s, AB),
                                 checker.raw_match(raw1, s, AB), (raw1, s))
            # equivalence verdict agreement with brute force
            r = shortest_difference(n1, n2, AB)
            brute = checker.brute_force_difference(raw1, raw2, AB, 4)
            if r["status"] == "equivalent":
                self.assertIsNone(brute, (raw1, raw2))
            elif r["witness"] is not None and len(r["witness"]) <= 4:
                self.assertEqual(r["witness"], brute, (raw1, raw2))


if __name__ == "__main__":
    unittest.main()
