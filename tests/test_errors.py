import unittest

from prattx import ParseError, parse


class TestStableErrors(unittest.TestCase):
    def assert_error(self, source, got, expected, span):
        with self.assertRaises(ParseError) as ctx:
            parse(source)
        err = ctx.exception
        self.assertEqual(err.got, got)
        self.assertEqual(err.expected, expected)
        self.assertEqual(err.span, tuple(span))
        # Message is deterministic and carries all three fields.
        again = str(ParseError(err.got, err.expected, err.span))
        self.assertEqual(str(err), again)
        self.assertIn(got, str(err))
        return err

    def test_call_with_bad_separator(self):
        # Acceptance D: a(1,2][3]
        self.assert_error("a(1,2][3]", "]", "')'", (5, 6))

    def test_trailing_operator(self):
        # Acceptance D: 1+
        self.assert_error("1+", "EOF", "expression", (2, 2))

    def test_ternary_missing_colon(self):
        # Acceptance D: ? without then-part terminator
        self.assert_error("a?b", "EOF", "':'", (3, 3))

    def test_empty_source(self):
        self.assert_error("", "EOF", "expression", (0, 0))

    def test_lone_question_mark(self):
        self.assert_error("?", "?", "expression", (0, 1))

    def test_unclosed_paren(self):
        self.assert_error("(1+2", "EOF", "')'", (4, 4))

    def test_unclosed_index(self):
        self.assert_error("a[1", "EOF", "']'", (3, 3))

    def test_trailing_garbage(self):
        self.assert_error("1 2", "2", "end of input", (2, 3))

    def test_bad_character(self):
        self.assert_error("1 @ 2", "@", "token", (2, 3))

    def test_error_dict_shape(self):
        try:
            parse("1+")
        except ParseError as err:
            d = err.to_dict()
            self.assertEqual(d["got"], "EOF")
            self.assertEqual(d["expected"], "expression")
            self.assertEqual(d["span"], [2, 2])
            self.assertIn("message", d)
        else:
            self.fail("expected ParseError")


if __name__ == "__main__":
    unittest.main()
