"""Acceptance D: stable, structured parse errors."""

import unittest

from prattx import ParseError, parse


def error_of(src):
    try:
        parse(src)
    except ParseError as exc:
        return exc
    raise AssertionError("expected ParseError for %r" % src)


class ErrorTest(unittest.TestCase):
    def test_call_closed_by_bracket(self):
        # a(1,2][3] -> ']' where ')' was expected
        exc = error_of("a(1,2][3]")
        self.assertEqual(exc.got, "]")
        self.assertEqual(exc.expected, ")")
        self.assertEqual(exc.span, (5, 6))
        self.assertEqual(
            str(exc), "parse error: expected ), got ] at 5:6"
        )

    def test_missing_operand_after_plus(self):
        exc = error_of("1+")
        self.assertEqual(exc.got, "<eof>")
        self.assertEqual(exc.expected, "expression")
        self.assertEqual(exc.span, (2, 2))

    def test_ternary_missing_then(self):
        exc = error_of("a?:b")
        self.assertEqual(exc.got, ":")
        self.assertEqual(exc.expected, "expression")
        self.assertEqual(exc.span, (2, 3))

    def test_ternary_missing_colon(self):
        exc = error_of("a?b")
        self.assertEqual(exc.got, "<eof>")
        self.assertEqual(exc.expected, ":")
        self.assertEqual(exc.span, (3, 3))

    def test_lone_question_mark(self):
        exc = error_of("?")
        self.assertEqual(exc.got, "?")
        self.assertEqual(exc.expected, "expression")
        self.assertEqual(exc.span, (0, 1))

    def test_trailing_tokens(self):
        exc = error_of("1 2")
        self.assertEqual(exc.got, "2")
        self.assertEqual(exc.expected, "end of input")
        self.assertEqual(exc.span, (2, 3))

    def test_unclosed_subscript(self):
        exc = error_of("a[1")
        self.assertEqual(exc.got, "<eof>")
        self.assertEqual(exc.expected, "]")
        self.assertEqual(exc.span, (3, 3))

    def test_bad_character(self):
        exc = error_of("1 @ 2")
        self.assertEqual(exc.got, "@")
        self.assertEqual(exc.expected, "token")
        self.assertEqual(exc.span, (2, 3))

    def test_error_attributes_and_dict(self):
        exc = error_of("1+")
        data = exc.to_dict()
        self.assertEqual(data["got"], "<eof>")
        self.assertEqual(data["expected"], "expression")
        self.assertEqual(data["span"], [2, 2])
        self.assertIn("message", data)


if __name__ == "__main__":
    unittest.main()
