import unittest

from pathpolicy.chars import CharClass
from pathpolicy.pattern import STAR, STARSTAR, PatternError, parse_pattern


class PatternParseTests(unittest.TestCase):
    def test_empty_pattern_is_root(self):
        self.assertEqual(parse_pattern(""), [])

    def test_literal_segments(self):
        segs = parse_pattern("a/bc/d")
        self.assertEqual(len(segs), 3)
        self.assertEqual(segs[1], (("lit", "b"), ("lit", "c")))

    def test_star_and_starstar_whole_segments(self):
        self.assertEqual(parse_pattern("a/*/**"), [(("lit", "a"),), STAR, STARSTAR])

    def test_question_mark(self):
        self.assertEqual(parse_pattern("a/?c")[1], (("any",), ("lit", "c")))

    def test_char_class(self):
        tokens = parse_pattern("[abc]")[0]
        self.assertEqual(tokens, (("class", CharClass("abc")),))

    def test_char_class_range(self):
        tokens = parse_pattern("[0-9]")[0]
        self.assertEqual(tokens, (("class", CharClass("0123456789")),))

    def test_char_class_complement(self):
        tokens = parse_pattern("[^ab]")[0]
        self.assertEqual(tokens, (("class", CharClass("ab", negated=True)),))
        tokens = parse_pattern("[!ab]")[0]
        self.assertEqual(tokens, (("class", CharClass("ab", negated=True)),))

    def test_escapes(self):
        tokens = parse_pattern(r"a/\*\?\[")[1]
        self.assertEqual(tokens, (("lit", "*"), ("lit", "?"), ("lit", "[")))

    def test_rejects_embedded_star(self):
        with self.assertRaises(PatternError):
            parse_pattern("a*.txt")

    def test_rejects_bad_separators(self):
        for bad in ("/a", "a/", "a//b"):
            with self.assertRaises(PatternError, msg=bad):
                parse_pattern(bad)

    def test_rejects_separator_in_class(self):
        with self.assertRaises(PatternError):
            parse_pattern("[a/b]")

    def test_rejects_unterminated_class(self):
        with self.assertRaises(PatternError):
            parse_pattern("a/[bc")

    def test_rejects_empty_class(self):
        with self.assertRaises(PatternError):
            parse_pattern("[]")

    def test_rejects_unmatched_bracket(self):
        with self.assertRaises(PatternError):
            parse_pattern("a]b")


if __name__ == "__main__":
    unittest.main()
