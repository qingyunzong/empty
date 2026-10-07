import unittest

from pathpolicy.pattern import (parse_pattern, PatternError, DOUBLESTAR,
                                Lit, AnyChar, Star, CharClass,
                                pattern_to_string)


class PatternParseTest(unittest.TestCase):
    def test_literal(self):
        p = parse_pattern("a/bc")
        self.assertEqual(p.segments, ((Lit("a"),), (Lit("b"), Lit("c"))))

    def test_star_question(self):
        p = parse_pattern("a*/b?")
        self.assertEqual(p.segments[0], (Lit("a"), Star()))
        self.assertEqual(p.segments[1], (Lit("b"), AnyChar()))

    def test_doublestar_whole_segment(self):
        p = parse_pattern("a/**/b")
        self.assertIs(p.segments[1], DOUBLESTAR)
        p = parse_pattern("**")
        self.assertIs(p.segments[0], DOUBLESTAR)

    def test_doublestar_inside_segment_rejected(self):
        for bad in ("a**", "**a", "a**b", "***", "a/***"):
            with self.assertRaises(PatternError, msg=bad):
                parse_pattern(bad)

    def test_char_class(self):
        p = parse_pattern("[abc]")
        self.assertEqual(p.segments[0], (CharClass(frozenset("abc")),))
        p = parse_pattern("[a-c]")
        self.assertEqual(p.segments[0], (CharClass(frozenset("abc")),))

    def test_char_class_negation(self):
        for text in ("[^a]", "[!a]"):
            p = parse_pattern(text)
            (cls,) = p.segments[0]
            self.assertTrue(cls.negated)
            self.assertEqual(cls.chars, frozenset("a"))

    def test_class_errors(self):
        for bad in ("[", "[a", "[]", "[/]", "[a/]", "[z-a]", "[.-0]", "x["):
            with self.assertRaises(PatternError, msg=bad):
                parse_pattern(bad)

    def test_escapes(self):
        p = parse_pattern(r"a\*b\?\[\\")
        self.assertEqual(p.segments[0],
                         (Lit("a"), Lit("*"), Lit("b"), Lit("?"),
                          Lit("["), Lit("\\")))
        with self.assertRaises(PatternError):
            parse_pattern("a\\")

    def test_normalization_in_patterns(self):
        self.assertEqual(parse_pattern("a//b"), parse_pattern("a/b"))
        self.assertEqual(parse_pattern("a/./b"), parse_pattern("a/b"))
        self.assertEqual(parse_pattern(""), parse_pattern("/"))
        self.assertEqual(parse_pattern("").segments, ())

    def test_dotdot_rejected(self):
        for bad in ("..", "a/../b", "../**"):
            with self.assertRaises(PatternError, msg=bad):
                parse_pattern(bad)

    def test_roundtrip_string(self):
        for text in ("a/b", "a/**/b", "**", "a*", "[^a]x", "a?", ""):
            p = parse_pattern(text)
            self.assertEqual(parse_pattern(pattern_to_string(p)), p)


if __name__ == "__main__":
    unittest.main()
