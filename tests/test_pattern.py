import unittest

from logfilter import Index, PatternError, parse_pattern, search
from logfilter.pattern import AnyChar, CharClass, Lit, Star


class TestParsing(unittest.TestCase):
    def test_literals_and_wildcards(self):
        compiled = parse_pattern("ab?c*")
        kinds = [type(e) for e in compiled.elements]
        self.assertEqual(kinds, [Lit, Lit, AnyChar, Lit, Star])
        self.assertEqual(compiled.d, 0)

    def test_char_class_and_range(self):
        compiled = parse_pattern("[a-c]")
        (cls,) = compiled.elements
        self.assertIsInstance(cls, CharClass)
        self.assertFalse(cls.negated)
        self.assertTrue(cls.matches("a"))  # low endpoint included
        self.assertTrue(cls.matches("b"))
        self.assertTrue(cls.matches("c"))  # high endpoint included
        self.assertFalse(cls.matches("d"))

    def test_negated_class(self):
        (cls,) = parse_pattern("[^a-c]").elements
        self.assertTrue(cls.negated)
        self.assertFalse(cls.matches("a"))
        self.assertFalse(cls.matches("c"))
        self.assertTrue(cls.matches("z"))

    def test_class_trailing_dash_is_literal(self):
        (cls,) = parse_pattern("[a-]").elements
        self.assertTrue(cls.matches("-"))
        self.assertTrue(cls.matches("a"))

    def test_escapes(self):
        compiled = parse_pattern(r"\*\?\[\\")
        self.assertEqual([e.describe() for e in compiled.elements], ["*", "?", "[", "\\"])
        self.assertTrue(all(isinstance(e, Lit) for e in compiled.elements))

    def test_edit_marker(self):
        self.assertEqual(parse_pattern("ab{~}").d, 1)
        self.assertEqual(parse_pattern("ab{~0}").d, 0)
        self.assertEqual(parse_pattern("ab{~2}").d, 2)
        self.assertEqual(parse_pattern("ab{~2}").elements, parse_pattern("ab").elements)

    def test_literal_brace(self):
        compiled = parse_pattern("a{b")
        self.assertEqual([e.describe() for e in compiled.elements], ["a", "{", "b"])

    def test_empty_pattern(self):
        self.assertEqual(parse_pattern("").elements, ())


class TestInvalidPatternsRejectedAtomically(unittest.TestCase):
    BAD = [
        "[ab",        # unterminated class
        "[c-a]",      # range endpoints out of order
        "[]",         # empty class
        "[^]",        # empty negated class
        "ab\\",       # dangling escape
        "[a\\",       # dangling escape in class
        "ab{~3}",     # edit distance above maximum
        "a{~1}b",     # edit marker not at end
        "ab{~",       # unterminated marker-ish brace
    ]

    def test_parse_errors(self):
        for bad in self.BAD:
            with self.subTest(pattern=bad):
                with self.assertRaises(PatternError):
                    parse_pattern(bad)

    def test_rejection_is_atomic_for_search(self):
        index = Index()
        index.add_document("d1", ["abc", "abd"])
        generation = index.generation
        for bad in self.BAD:
            with self.subTest(pattern=bad):
                with self.assertRaises(PatternError):
                    search(index, pattern=bad)
        self.assertEqual(index.generation, generation)
        self.assertEqual(index.num_docs, 1)
        self.assertEqual(index.num_terms, 2)

    def test_edit_distance_out_of_range_via_argument(self):
        index = Index()
        index.add_document("d1", ["abc"])
        with self.assertRaises(PatternError):
            search(index, pattern="abc", d=3)
        with self.assertRaises(PatternError):
            search(index, pattern="abc", d=-1)


if __name__ == "__main__":
    unittest.main()
