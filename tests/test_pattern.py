import unittest

from logfilter import PatternError, parse_pattern
from logfilter.pattern import CLASS, LITERAL, STAR, ANY


class TestPatternParsing(unittest.TestCase):
    def test_plain_literals(self):
        p = parse_pattern("abc")
        self.assertEqual([t.kind for t in p.tokens], [LITERAL] * 3)
        self.assertEqual(p.edits, 0)

    def test_edit_suffix(self):
        self.assertEqual(parse_pattern("abc~").edits, 1)
        self.assertEqual(parse_pattern("abc~0").edits, 0)
        self.assertEqual(parse_pattern("abc~2").edits, 2)

    def test_edit_distance_limited_to_two(self):
        with self.assertRaises(PatternError):
            parse_pattern("abc~3")
        with self.assertRaises(PatternError):
            parse_pattern("abc~9")

    def test_wildcards(self):
        p = parse_pattern("a?b*")
        self.assertEqual(
            [t.kind for t in p.tokens], [LITERAL, ANY, LITERAL, STAR]
        )

    def test_class_endpoints(self):
        p = parse_pattern("[a-c]")
        (tok,) = p.tokens
        self.assertEqual(tok.kind, CLASS)
        self.assertTrue(tok.matches("a"))  # low endpoint
        self.assertTrue(tok.matches("b"))
        self.assertTrue(tok.matches("c"))  # high endpoint
        self.assertFalse(tok.matches("d"))
        self.assertFalse(tok.matches("`"))  # just below 'a'

    def test_class_negation_and_singles(self):
        p = parse_pattern("[!xy]")
        (tok,) = p.tokens
        self.assertFalse(tok.matches("x"))
        self.assertFalse(tok.matches("y"))
        self.assertTrue(tok.matches("z"))
        p2 = parse_pattern("[^a-c]")
        self.assertFalse(p2.tokens[0].matches("b"))
        self.assertTrue(p2.tokens[0].matches("d"))

    def test_class_literal_hyphen_at_ends(self):
        p = parse_pattern("[-a]")
        self.assertTrue(p.tokens[0].matches("-"))
        p = parse_pattern("[a-]")
        self.assertTrue(p.tokens[0].matches("-"))

    def test_escapes(self):
        p = parse_pattern(r"a\*b\?\[x\]\~")
        self.assertTrue(all(t.kind == LITERAL for t in p.tokens))
        self.assertEqual("".join(t.char for t in p.tokens), "a*b?[x]~")

    def test_illegal_patterns_rejected(self):
        for bad in (
            "abc~3",      # edit distance above the limit
            "abc~x",      # non-numeric edit suffix
            "a[b",        # unterminated class
            "a[]",        # empty class
            "a[z-a]",     # reversed range
            "a]b",        # unmatched close bracket
            "abc\\",      # dangling escape
            "a~1~2",      # two tildes
            "a[b~1",      # unterminated class with suffix
        ):
            with self.assertRaises(PatternError, msg=bad):
                parse_pattern(bad)

    def test_literal_normalization(self):
        # default rules casefold literals
        p = parse_pattern("ABC")
        self.assertEqual([t.char for t in p.tokens], ["a", "b", "c"])


if __name__ == "__main__":
    unittest.main()
